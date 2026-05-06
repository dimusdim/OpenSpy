import { diag, DiagConsoleLogger, DiagLogLevel, metrics, trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

function envFlag(value: string | undefined): boolean {
    if (!value) return false;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function normalizeOtlpEndpoint(base: string, signalPath: 'traces' | 'metrics'): string {
    const trimmed = base.replace(/\/+$/, '');
    if (/\/v1\/(traces|metrics)$/.test(trimmed)) return trimmed;
    return `${trimmed}/v1/${signalPath}`;
}

const telemetryEnabled = envFlag(process.env.OTEL_ENABLED);
const serviceName = process.env.OTEL_SERVICE_NAME || process.env.DB_APP_NAME || 'openspy-backend';
const serviceVersion = process.env.npm_package_version || '1.0.0';

let sdk: NodeSDK | null = null;
let shutdownStarted = false;

if (telemetryEnabled) {
    if (envFlag(process.env.OTEL_DEBUG)) {
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    }

    const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://127.0.0.1:4318';
    const metricsIntervalMillis = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS || '10000');

    sdk = new NodeSDK({
        serviceName,
        resource: resourceFromAttributes({
            'service.name': serviceName,
            'service.version': serviceVersion,
            'deployment.environment': process.env.NODE_ENV || 'development',
        }),
        traceExporter: new OTLPTraceExporter({
            url: normalizeOtlpEndpoint(baseEndpoint, 'traces'),
        }),
        metricReaders: [
            new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter({
                    url: normalizeOtlpEndpoint(baseEndpoint, 'metrics'),
                }),
                exportIntervalMillis: Number.isFinite(metricsIntervalMillis) ? metricsIntervalMillis : 10000,
            }),
        ],
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-fs': { enabled: false },
            }),
        ],
    });

    sdk.start();
    console.log(`[telemetry] OpenTelemetry enabled -> ${baseEndpoint}`);
}

async function shutdownTelemetry(signal: string) {
    if (!sdk || shutdownStarted) return;
    shutdownStarted = true;
    try {
        await sdk.shutdown();
        console.log(`[telemetry] shutdown complete (${signal})`);
    } catch (error) {
        console.error('[telemetry] shutdown failed:', error);
    }
}

process.once('SIGTERM', () => {
    void shutdownTelemetry('SIGTERM');
});

process.once('SIGINT', () => {
    void shutdownTelemetry('SIGINT');
});

export function isTelemetryEnabled(): boolean {
    return telemetryEnabled;
}

export function getTelemetryTracer() {
    return trace.getTracer(serviceName, serviceVersion);
}

export function getTelemetryMeter() {
    return metrics.getMeter(serviceName, serviceVersion);
}
