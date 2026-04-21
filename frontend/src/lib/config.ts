const DEFAULT_API_URL =
    typeof window === 'undefined'
        ? 'http://localhost:3055'
        : `${window.location.protocol}//${window.location.hostname}:3055`;

export const API_URL = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;

// OTLP HTTP collector endpoint. The collector (ops/telemetry/otel-collector.yaml)
// listens on :4318 by default. Frontend OTEL exports go straight here so we
// can correlate frontend rendering spans with backend tile-builder spans.
const DEFAULT_OTEL_ENDPOINT =
    typeof window === 'undefined'
        ? 'http://127.0.0.1:4318'
        : `${window.location.protocol}//${window.location.hostname}:4318`;
export const OTEL_ENDPOINT = process.env.NEXT_PUBLIC_OTEL_ENDPOINT || DEFAULT_OTEL_ENDPOINT;
export const OTEL_ENABLED = process.env.NEXT_PUBLIC_OTEL_ENABLED !== '0';
