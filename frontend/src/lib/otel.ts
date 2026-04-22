// Browser OpenTelemetry bootstrap.
//
// Replaces the bespoke perfLog → /api/perf-event → JSONL pipeline for the
// rendering hot path. We send OTLP/HTTP straight to the local collector
// (configured in ops/telemetry/otel-collector.yaml) so traces show up in
// Jaeger and metrics in Prometheus alongside backend spans.
//
// Designed to fail closed: if the collector is unreachable or the SDK
// fails to spawn, helper functions become no-ops. perfLog still works
// in parallel as a JSONL fallback.

import { context, trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { metrics, type Histogram, type Counter } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { WebTracerProvider, StackContextManager } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

import { OTEL_ENABLED, OTEL_ENDPOINT, API_URL } from './config';

const SERVICE_NAME = 'openspy-frontend';
const SERVICE_VERSION = '1.0.0';

let initialized = false;
let tracer: Tracer | null = null;

// Histograms / counters created once on first init. We store them so
// helper APIs below stay synchronous.
let frameRenderMs: Histogram | null = null;
let suspectBlockMs: Histogram | null = null;
let bundleDoneMs: Histogram | null = null;
let bundleBytes: Histogram | null = null;
let primitiveUpdateMs: Histogram | null = null;
let workerAckTransitMs: Histogram | null = null;
let workerCpuMs: Histogram | null = null;
let payloadCloneMs: Histogram | null = null;
let putDoneMs: Histogram | null = null;
let manifestTilesCount: Histogram | null = null;
let manifestBytes: Histogram | null = null;
let longtaskMs: Histogram | null = null;
let hydrationTaskMs: Histogram | null = null;
let suspectBlockCount: Counter | null = null;
let longtaskCount: Counter | null = null;

function safeInit(): void {
    if (initialized || typeof window === 'undefined') return;
    initialized = true;
    if (!OTEL_ENABLED) {
        console.log('[otel] disabled via NEXT_PUBLIC_OTEL_ENABLED=0');
        return;
    }
    try {
        const resource = resourceFromAttributes({
            [ATTR_SERVICE_NAME]: SERVICE_NAME,
            [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
            'deployment.environment': process.env.NODE_ENV || 'development',
        });

        const traceExporter = new OTLPTraceExporter({
            url: `${OTEL_ENDPOINT}/v1/traces`,
        });
        const tracerProvider = new WebTracerProvider({
            resource,
            spanProcessors: [
                new BatchSpanProcessor(traceExporter, {
                    maxExportBatchSize: 64,
                    scheduledDelayMillis: 1500,
                }),
            ],
        });
        tracerProvider.register({
            contextManager: new StackContextManager(),
        });

        const metricExporter = new OTLPMetricExporter({
            url: `${OTEL_ENDPOINT}/v1/metrics`,
        });
        const meterProvider = new MeterProvider({
            resource,
            readers: [
                new PeriodicExportingMetricReader({
                    exporter: metricExporter,
                    exportIntervalMillis: 5000,
                }),
            ],
        });
        metrics.setGlobalMeterProvider(meterProvider);

        tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
        const meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION);

        frameRenderMs = meter.createHistogram('openspy.frontend.frame_render_ms', {
            description: 'Cesium scene preRender→postRender wall time',
            unit: 'ms',
        });
        suspectBlockMs = meter.createHistogram('openspy.frontend.suspect_block_ms', {
            description: 'Suspect main-thread block duration above threshold',
            unit: 'ms',
        });
        bundleDoneMs = meter.createHistogram('openspy.frontend.tile_bundle_done_ms', {
            description: 'Total wall time of fetchTilesBundle from entry to bundle-done',
            unit: 'ms',
        });
        bundleBytes = meter.createHistogram('openspy.frontend.tile_bundle_bytes', {
            description: 'Bytes received for a tile bundle from /api/replay/tile-bundle',
            unit: 'By',
        });
        primitiveUpdateMs = meter.createHistogram('openspy.frontend.primitive_update_ms', {
            description: 'Cesium Primitive.update() main-thread duration (synchronous geometry compile)',
            unit: 'ms',
        });
        workerAckTransitMs = meter.createHistogram('openspy.frontend.worker_ack_transit_ms', {
            description: 'Time between postMessage send and decoded-ready ack receive minus worker CPU',
            unit: 'ms',
        });
        workerCpuMs = meter.createHistogram('openspy.frontend.worker_cpu_ms', {
            description: 'CPU time inside decode worker (msgpack decode + framing parse)',
            unit: 'ms',
        });
        payloadCloneMs = meter.createHistogram('openspy.frontend.payload_clone_ms', {
            description: 'Structured-clone deserialise cost of decoded payload',
            unit: 'ms',
        });
        putDoneMs = meter.createHistogram('openspy.frontend.idb_put_ms', {
            description: 'IndexedDB readwrite put duration',
            unit: 'ms',
        });
        manifestTilesCount = meter.createHistogram('openspy.frontend.manifest_tiles_count', {
            description: 'Number of tiles requested for a layer in a manifest',
        });
        manifestBytes = meter.createHistogram('openspy.frontend.manifest_bytes', {
            description: 'Total bytes for a layer in a manifest',
            unit: 'By',
        });
        longtaskMs = meter.createHistogram('openspy.frontend.longtask_ms', {
            description: 'Browser longtask duration > 100ms',
            unit: 'ms',
        });
        hydrationTaskMs = meter.createHistogram('openspy.frontend.hydration_task_ms', {
            description: 'Detached hydration (warm-prime / deferred) task duration',
            unit: 'ms',
        });
        suspectBlockCount = meter.createCounter('openspy.frontend.suspect_block_total', {
            description: 'Suspect main-thread blocks observed above threshold',
        });
        longtaskCount = meter.createCounter('openspy.frontend.longtask_total', {
            description: 'Browser longtasks > 100ms',
        });

        console.log(`[otel] enabled, exporting traces+metrics → ${OTEL_ENDPOINT}`);
    } catch (err) {
        console.warn('[otel] init failed; helpers become no-ops:', err);
        tracer = null;
    }
}

if (typeof window !== 'undefined') {
    // Global safety net for unhandled promise rejections. Added 2026-04-22
    // after a `Promise.reject(undefined)` somewhere in the render path
    // hit zone.js's rejection reporter on every requestAnimationFrame,
    // producing reentrant CesiumWidget.render crashes and frozen scenes.
    //
    // We register in the capture phase so zone.js' own listener sees a
    // pre-handled event and stops the reentrant loop. When the reason
    // is something truthy we still emit a loud console.error with a
    // stable prefix so the real source shows up in browser-monitor logs.
    // Best-effort ship of error events to /api/perf-event so the backend
    // writes them to var/perf-events.jsonl — lets the agent read what the
    // user's browser saw without keeping a headful monitor alive.
    const shipUiError = (kind: string, data: Record<string, any>) => {
        try {
            const body = JSON.stringify({
                event: kind,
                source: 'frontend',
                ts: new Date().toISOString(),
                ...data,
            });
            // sendBeacon never blocks, never throws, never races a page unload.
            if (navigator.sendBeacon) {
                const blob = new Blob([body], { type: 'application/json' });
                navigator.sendBeacon(`${API_URL}/api/perf-event`, blob);
                return;
            }
            void fetch(`${API_URL}/api/perf-event`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            }).catch(() => undefined);
        } catch { /* never let telemetry break rendering */ }
    };

    window.addEventListener('unhandledrejection', (event) => {
        const reason = (event as PromiseRejectionEvent).reason;
        if (reason === undefined || reason === null) {
            // Silent swallow for the pathological throw-undefined case.
            // Also suppresses the zone.js reentrant path that was producing
            // per-frame CesiumWidget.render crashes (2026-04-22 regression).
            shipUiError('ui.unhandled_rejection', {
                reason: String(reason),
                swallowed: true,
            });
            event.preventDefault();
            return;
        }
        const msg = reason?.message ?? String(reason);
        const stack = reason?.stack ?? '(no stack)';
        console.error('[unhandled-rejection]', msg, '\n', stack);
        shipUiError('ui.unhandled_rejection', {
            message: String(msg).slice(0, 500),
            stack: String(stack).slice(0, 2000),
        });
        event.preventDefault();
    }, true);

    window.addEventListener('error', (event) => {
        const err = event.error;
        shipUiError('ui.error', {
            message: event.message?.slice(0, 500),
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            stack: err?.stack?.slice(0, 2000),
        });
    }, true);

    safeInit();
}

export function getTracer(): Tracer | null {
    return tracer;
}

export function withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean | undefined>,
    fn: (span: Span | null) => T | Promise<T>,
): T | Promise<T> {
    if (!tracer) return fn(null);
    return tracer.startActiveSpan(name, (span) => {
        for (const [k, v] of Object.entries(attributes)) {
            if (v !== undefined) span.setAttribute(k, v as any);
        }
        try {
            const result = fn(span);
            if (result && typeof (result as any).then === 'function') {
                return (result as Promise<T>)
                    .then((r) => {
                        span.setStatus({ code: SpanStatusCode.OK });
                        span.end();
                        return r;
                    })
                    .catch((err) => {
                        span.recordException(err);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
                        span.end();
                        throw err;
                    });
            }
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return result;
        } catch (err: any) {
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
            span.end();
            throw err;
        }
    });
}

export function recordFrameRender(ms: number): void {
    frameRenderMs?.record(ms);
}

export function recordSuspectBlock(name: string, ms: number, attrs: Record<string, any> = {}): void {
    if (!suspectBlockMs) return;
    const stringAttrs: Record<string, string | number | boolean> = { 'suspect.name': name };
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (typeof v === 'object') continue;
        stringAttrs[k] = v;
    }
    suspectBlockMs.record(ms, stringAttrs);
    suspectBlockCount?.add(1, { 'suspect.name': name });
}

export function recordTileBundleDone(ms: number, bytesValue: number, layerScope: string): void {
    bundleDoneMs?.record(ms, { 'replay.layer_scope': layerScope });
    bundleBytes?.record(bytesValue, { 'replay.layer_scope': layerScope });
}

export function recordPrimitiveUpdate(kind: string, layerKey: string, ms: number): void {
    primitiveUpdateMs?.record(ms, { 'primitive.kind': kind, 'replay.layer': layerKey });
}

export function recordWorkerAck(layerScope: string, transitMs: number, cpuMs: number, estItems: number): void {
    workerAckTransitMs?.record(transitMs, { 'replay.layer_scope': layerScope });
    workerCpuMs?.record(cpuMs, { 'replay.layer_scope': layerScope, 'est.items': estItems });
}

export function recordPayloadClone(layerScope: string, ms: number): void {
    payloadCloneMs?.record(ms, { 'replay.layer_scope': layerScope });
}

export function recordIdbPut(ms: number, layerScope: string): void {
    putDoneMs?.record(ms, { 'replay.layer_scope': layerScope });
}

export function recordManifest(layerId: string, tiles: number, bytesValue: number): void {
    manifestTilesCount?.record(tiles, { 'replay.layer': layerId });
    manifestBytes?.record(bytesValue, { 'replay.layer': layerId });
}

export function recordLongtask(durationMs: number): void {
    longtaskMs?.record(durationMs);
    longtaskCount?.add(1);
}

export function recordHydrationTask(kind: string, ms: number, phase: string): void {
    hydrationTaskMs?.record(ms, { 'hydration.kind': kind, 'hydration.phase': phase });
}

// Re-export contextual API so callers can attach manual child spans.
export { context, trace };
