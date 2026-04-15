export type CanonicalTarget = 'events' | 'assets' | 'entities' | 'observations' | 'orbital_elements';

export type RawCaptureMode = 'none' | 'snapshot';

export interface SourceBindingDefinition {
    sourceId: string;
    layerId: string;
    canonicalTarget: CanonicalTarget;
    recordKind: string;
    rawCaptureMode: RawCaptureMode;
    rawFormat: 'json' | 'geojson' | 'csv' | 'jsonl';
    notes?: string;
}

export const SOURCE_BINDINGS: Record<string, SourceBindingDefinition> = {
    opensky: {
        sourceId: 'opensky',
        layerId: 'aircraft',
        canonicalTarget: 'entities',
        recordKind: 'aircraft',
        rawCaptureMode: 'none',
        rawFormat: 'json',
        notes: 'OpenSky state vector polling feed.',
    },
    aisstream: {
        sourceId: 'aisstream',
        layerId: 'vessel',
        canonicalTarget: 'entities',
        recordKind: 'vessel',
        rawCaptureMode: 'none',
        rawFormat: 'json',
        notes: 'AISStream websocket position feed with static-data enrichment.',
    },
    ioda: {
        sourceId: 'ioda',
        layerId: 'outage',
        canonicalTarget: 'events',
        recordKind: 'network_outage',
        rawCaptureMode: 'snapshot',
        rawFormat: 'json',
        notes: 'IODA country-scoped outage alerts.',
    },
    acled: {
        sourceId: 'acled',
        layerId: 'conflict',
        canonicalTarget: 'events',
        recordKind: 'conflict_event',
        rawCaptureMode: 'snapshot',
        rawFormat: 'json',
        notes: 'ACLED conflict event feed.',
    },
    gdelt: {
        sourceId: 'gdelt',
        layerId: 'conflict',
        canonicalTarget: 'events',
        recordKind: 'conflict_event',
        rawCaptureMode: 'none',
        rawFormat: 'json',
        notes: 'GDELT near-real-time conflict event feed.',
    },
    celestrak: {
        sourceId: 'celestrak',
        layerId: 'satellite',
        canonicalTarget: 'orbital_elements',
        recordKind: 'satellite',
        rawCaptureMode: 'none',
        rawFormat: 'json',
        notes: 'Logical TLE provider chain persisted as orbital elements and satellite entities.',
    },
    cloudflare_radar: {
        sourceId: 'cloudflare_radar',
        layerId: 'outage',
        canonicalTarget: 'events',
        recordKind: 'network_outage',
        rawCaptureMode: 'snapshot',
        rawFormat: 'json',
        notes: 'Cloudflare Radar outage annotations.',
    },
    gfw: {
        sourceId: 'gfw',
        layerId: 'gfw',
        canonicalTarget: 'events',
        recordKind: 'dark_vessel_event',
        rawCaptureMode: 'snapshot',
        rawFormat: 'json',
        notes: 'Global Fishing Watch dark-vessel / AIS gap events.',
    },
    openaip: {
        sourceId: 'openaip',
        layerId: 'airspace',
        canonicalTarget: 'assets',
        recordKind: 'airspace_zone',
        rawCaptureMode: 'snapshot',
        rawFormat: 'json',
        notes: 'OpenAIP restricted/danger/prohibited airspace polygons.',
    },
    osm_pipelines: {
        sourceId: 'osm_pipelines',
        layerId: 'pipeline',
        canonicalTarget: 'assets',
        recordKind: 'pipeline',
        rawCaptureMode: 'snapshot',
        rawFormat: 'json',
        notes: 'Overpass-derived global oil and gas pipeline polylines.',
    },
    telegeography: {
        sourceId: 'telegeography',
        layerId: 'cable',
        canonicalTarget: 'assets',
        recordKind: 'submarine_cable',
        rawCaptureMode: 'snapshot',
        rawFormat: 'geojson',
        notes: 'Static GeoJSON snapshot from TeleGeography cable map API.',
    },
    gpsjam: {
        sourceId: 'gpsjam',
        layerId: 'jamming',
        canonicalTarget: 'events',
        recordKind: 'gnss_jamming',
        rawCaptureMode: 'snapshot',
        rawFormat: 'csv',
        notes: 'Daily H3 CSV snapshot from gpsjam.org.',
    },
    firms: {
        sourceId: 'firms',
        layerId: 'fire',
        canonicalTarget: 'events',
        recordKind: 'active_fire',
        rawCaptureMode: 'none',
        rawFormat: 'csv',
        notes: 'High-volume global FIRMS CSV. Persist normalized records first; raw retention policy can be enabled later.',
    },
    gdacs: {
        sourceId: 'gdacs',
        layerId: 'disasters',
        canonicalTarget: 'events',
        recordKind: 'disaster_event',
        rawCaptureMode: 'snapshot',
        rawFormat: 'json',
        notes: 'GeoJSON-ish disaster bulletin feed with non-point geometry.',
    },
    usgs: {
        sourceId: 'usgs',
        layerId: 'disasters',
        canonicalTarget: 'events',
        recordKind: 'disaster_event',
        rawCaptureMode: 'snapshot',
        rawFormat: 'json',
        notes: 'USGS GeoJSON earthquake feed.',
    },
    eonet: {
        sourceId: 'eonet',
        layerId: 'disasters',
        canonicalTarget: 'events',
        recordKind: 'disaster_event',
        rawCaptureMode: 'snapshot',
        rawFormat: 'json',
        notes: 'NASA EONET event feed.',
    },
} as const;

export function getSourceBinding(sourceId: string | null | undefined): SourceBindingDefinition | null {
    if (!sourceId) return null;
    return SOURCE_BINDINGS[sourceId] || null;
}
