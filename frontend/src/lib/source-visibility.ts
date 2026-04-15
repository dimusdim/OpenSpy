export type CompositeLayerCode = 'disasters' | 'conflicts' | 'outages';

export type CompositeSourceNode = {
    sourceId: string;
    label: string;
};

export const COMPOSITE_LAYER_SOURCES: Record<CompositeLayerCode, CompositeSourceNode[]> = {
    disasters: [
        { sourceId: 'gdacs', label: 'GDACS' },
        { sourceId: 'usgs', label: 'USGS' },
        { sourceId: 'eonet', label: 'NASA EONET' },
    ],
    conflicts: [
        { sourceId: 'acled', label: 'ACLED' },
        { sourceId: 'gdelt', label: 'GDELT' },
    ],
    outages: [
        { sourceId: 'ioda', label: 'IODA' },
        { sourceId: 'cloudflare_radar', label: 'Cloudflare Radar' },
    ],
};

export function getLayerSourceVisibilityKey(layer: CompositeLayerCode, sourceId: string): string {
    return `${layer}:${sourceId}`;
}

export function normalizeLayerSourceId(layer: CompositeLayerCode, rawSource: unknown): string | null {
    if (typeof rawSource !== 'string') return null;
    const value = rawSource.trim().toLowerCase();
    if (!value) return null;

    switch (layer) {
        case 'disasters':
            if (value === 'gdacs') return 'gdacs';
            if (value === 'usgs') return 'usgs';
            if (value === 'nasa eonet' || value === 'eonet') return 'eonet';
            return null;
        case 'conflicts':
            if (value === 'acled') return 'acled';
            if (value === 'gdelt') return 'gdelt';
            return null;
        case 'outages':
            if (value === 'ioda') return 'ioda';
            if (value === 'cloudflare' || value === 'cloudflare radar' || value === 'cloudflare-radar' || value === 'cloudflare_radar') {
                return 'cloudflare_radar';
            }
            return null;
        default:
            return null;
    }
}
