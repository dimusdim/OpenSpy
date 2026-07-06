const DEFAULT_API_URL =
    typeof window === 'undefined'
        ? 'http://localhost:3055'
        : `${window.location.protocol}//${window.location.hostname}:3055`;

export const API_URL = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;

// Cesium ion access token. Without it the bundled Cesium demo token would be
// used for ion assets (world imagery/terrain, OSM buildings) and those
// requests now fail with 401 INVALID_TOKEN. When unset, the globe falls back
// to keyless providers and skips ion-only features instead of erroring.
export const CESIUM_ION_TOKEN = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN || '';
export const CESIUM_ION_ENABLED = CESIUM_ION_TOKEN.length > 0;

// Mapbox access token for the token-gated "Mapbox Satellite" base mode.
// Mapbox Satellite (mapbox.satellite) is high-resolution Maxar imagery served
// as raster tiles. When this is empty the Mapbox base-map option is hidden in
// the UI and the base-map effect falls back to the keyless Esri layer.
export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';
export const MAPBOX_ENABLED = MAPBOX_TOKEN.length > 0;

// OTLP HTTP collector endpoint. The collector (ops/telemetry/otel-collector.yaml)
// listens on :4318 by default. Frontend OTEL exports go straight here so we
// can correlate frontend rendering spans with backend tile-builder spans.
const DEFAULT_OTEL_ENDPOINT =
    typeof window === 'undefined'
        ? 'http://127.0.0.1:4318'
        : `${window.location.protocol}//${window.location.hostname}:4318`;
export const OTEL_ENDPOINT = process.env.NEXT_PUBLIC_OTEL_ENDPOINT || DEFAULT_OTEL_ENDPOINT;
const RAW_OTEL_ENABLED = process.env.NEXT_PUBLIC_OTEL_ENABLED;
export const OTEL_ENABLED = RAW_OTEL_ENABLED === '1' || RAW_OTEL_ENABLED === 'true';

const RAW_PERF_CONSOLE_ENABLED = process.env.NEXT_PUBLIC_PERF_CONSOLE_ENABLED;
export const PERF_CONSOLE_ENABLED =
    RAW_PERF_CONSOLE_ENABLED === '1' || RAW_PERF_CONSOLE_ENABLED === 'true';
