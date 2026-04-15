export type LiveDeliveryMode = 'delta' | 'replace' | 'snapshot-only' | 'none';

export type PublicSourceLiveContract = {
    source_id: string;
    delivery_mode: LiveDeliveryMode;
    stale_after_sec: number | null;
    remove_after_sec: number | null;
    notes?: string;
};

const PUBLIC_SOURCE_LIVE_CONTRACTS: PublicSourceLiveContract[] = [
    {
        source_id: 'opensky',
        delivery_mode: 'delta',
        stale_after_sec: 300,
        remove_after_sec: 300,
    },
    {
        source_id: 'aisstream',
        delivery_mode: 'delta',
        stale_after_sec: 3600,
        remove_after_sec: 21600,
    },
    {
        source_id: 'celestrak',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'gdacs',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'usgs',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'eonet',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'firms',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'gpsjam',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'ioda',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'cloudflare_radar',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'acled',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'gdelt',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'gfw',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'openaip',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'osm_pipelines',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
    {
        source_id: 'telegeography',
        delivery_mode: 'replace',
        stale_after_sec: null,
        remove_after_sec: null,
    },
];

export function getPublicSourceLiveContract(sourceId: string | null | undefined): PublicSourceLiveContract | null {
    if (!sourceId) return null;
    return PUBLIC_SOURCE_LIVE_CONTRACTS.find((item) => item.source_id === sourceId) || null;
}
