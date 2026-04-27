import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { getTelemetryMeter, getTelemetryTracer, isTelemetryEnabled } from './bootstrap';

const tracer = getTelemetryTracer();
const meter = getTelemetryMeter();

const dbQueryDurationMs = meter.createHistogram('openspy.db.query.duration_ms', {
    description: 'Database query duration',
    unit: 'ms',
});

const dbQueryTotal = meter.createCounter('openspy.db.query.total', {
    description: 'Database query executions',
});

const replayRequestDurationMs = meter.createHistogram('openspy.replay.request.duration_ms', {
    description: 'Replay request duration',
    unit: 'ms',
});

const replayResultItems = meter.createHistogram('openspy.replay.result_items', {
    description: 'Replay result items returned by request',
});

const rateLimitRejectedTotal = meter.createCounter('openspy.rate_limit.rejected_total', {
    description: 'Rate-limited HTTP requests',
});

const infraFetchDurationMs = meter.createHistogram('openspy.infra.fetch.duration_ms', {
    description: 'Infrastructure source fetch duration (Overture DuckDB or Overpass HTTP)',
    unit: 'ms',
});

const infraFetchRecords = meter.createHistogram('openspy.infra.fetch.records', {
    description: 'Records returned by infrastructure source fetch',
});

const replayTileBundleDurationMs = meter.createHistogram('openspy.replay.tile_bundle.duration_ms', {
    description: 'Replay tile-bundle endpoint duration',
    unit: 'ms',
});

const replayTileBundleBytes = meter.createHistogram('openspy.replay.tile_bundle.bytes', {
    description: 'Replay tile-bundle response size',
    unit: 'By',
});

const replayTileBundlePhaseDurationMs = meter.createHistogram('openspy.replay.tile_bundle.phase.duration_ms', {
    description: 'Replay tile-bundle internal phase duration',
    unit: 'ms',
});

const replayTileBundlePhaseBytes = meter.createHistogram('openspy.replay.tile_bundle.phase.bytes', {
    description: 'Replay tile-bundle internal phase bytes',
    unit: 'By',
});

export function telemetryEnabled(): boolean {
    return isTelemetryEnabled();
}

export async function withSpan<T>(
    spanName: string,
    attributes: Record<string, string | number | boolean | undefined>,
    fn: () => Promise<T>,
): Promise<T> {
    if (!telemetryEnabled()) return fn();

    return tracer.startActiveSpan(spanName, (span) => {
        for (const [key, value] of Object.entries(attributes)) {
            if (value !== undefined) span.setAttribute(key, value);
        }

        return Promise.resolve()
            .then(fn)
            .then((result) => {
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return result;
            })
            .catch((error: any) => {
                span.recordException(error);
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: error?.message || 'operation failed',
                });
                span.end();
                throw error;
            });
    });
}

export function recordDbQuery(sqlText: string, durationMs: number, ok: boolean, rowCount?: number | null) {
    if (!telemetryEnabled()) return;
    const attributes = summarizeSql(sqlText);
    dbQueryDurationMs.record(durationMs, {
        ...attributes,
        'db.query.ok': ok,
    });
    dbQueryTotal.add(1, {
        ...attributes,
        'db.query.ok': ok,
        'db.query.has_rows': typeof rowCount === 'number' && rowCount > 0,
    });
}

export function recordReplayRequest(
    kind: 'state' | 'window' | 'track',
    durationMs: number,
    itemCount: number,
    layerScope: string,
) {
    if (!telemetryEnabled()) return;
    replayRequestDurationMs.record(durationMs, {
        'replay.kind': kind,
        'replay.layer_scope': layerScope,
    });
    replayResultItems.record(itemCount, {
        'replay.kind': kind,
        'replay.layer_scope': layerScope,
    });
}

export function recordRateLimitReject(bucketName: string, reqPath: string) {
    if (!telemetryEnabled()) return;
    rateLimitRejectedTotal.add(1, {
        'http.route': reqPath,
        'rate_limit.bucket': bucketName,
    });
}

export function recordInfraFetch(
    endpoint: 'infrastructure' | 'power-infra',
    source: 'overture' | 'overpass',
    durationMs: number,
    recordCount: number,
    timedOut: boolean,
) {
    if (!telemetryEnabled()) return;
    const attrs = {
        'infra.endpoint': endpoint,
        'infra.source': source,
        'infra.timed_out': timedOut,
    };
    infraFetchDurationMs.record(durationMs, attrs);
    infraFetchRecords.record(recordCount, attrs);
}

export function recordReplayTileBundle(tileCount: number, bytes: number, durationMs: number) {
    if (!telemetryEnabled()) return;
    replayTileBundleDurationMs.record(durationMs, { 'replay.tile_count_bin': tileBin(tileCount) });
    replayTileBundleBytes.record(bytes, { 'replay.tile_count_bin': tileBin(tileCount) });
}

export function recordReplayTileBundlePhase(
    phase: 'read' | 'encode' | 'send',
    tileCount: number,
    bytes: number,
    durationMs: number,
) {
    if (!telemetryEnabled()) return;
    const attrs = {
        'replay.tile_count_bin': tileBin(tileCount),
        'replay.phase': phase,
    };
    replayTileBundlePhaseDurationMs.record(durationMs, attrs);
    replayTileBundlePhaseBytes.record(bytes, attrs);
}

function tileBin(n: number): string {
    if (n <= 5) return '<=5';
    if (n <= 20) return '<=20';
    if (n <= 100) return '<=100';
    if (n <= 500) return '<=500';
    return '>500';
}

function summarizeSql(sqlText: string) {
    const compact = sqlText.replace(/\s+/g, ' ').trim();
    const operation = (compact.match(/^(select|insert|update|delete|with)\b/i)?.[1] || 'unknown').toUpperCase();
    const table =
        compact.match(/\bfrom\s+([a-zA-Z0-9_."]+)/i)?.[1] ||
        compact.match(/\binto\s+([a-zA-Z0-9_."]+)/i)?.[1] ||
        compact.match(/\bupdate\s+([a-zA-Z0-9_."]+)/i)?.[1] ||
        'unknown';

    return {
        'db.system': 'postgresql',
        'db.operation': operation,
        'db.collection.name': table.replace(/"/g, ''),
    };
}

export function currentTraceId(): string | null {
    const span = trace.getSpan(context.active());
    return span?.spanContext().traceId || null;
}
