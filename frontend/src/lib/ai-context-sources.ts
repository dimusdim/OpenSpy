import type { AIContextObject, AIContextSourceId } from '../store/useAIImageStore';
import { aircraftMetaMap, vesselMetaMap } from '../cesium/useDynamicLayers';
import { infraMetaMap } from '../cesium/useInfrastructureLayer';
import { pipelineMetaMap } from '../cesium/usePipelinesLayer';
import { fireMetaMap } from '../cesium/useFiresLayer';
import { cableMetaMap } from '../cesium/useCablesLayer';
import { airspaceMetaMap } from '../cesium/useAirspaceLayer';
import { webcamMetaMap } from '../cesium/useWebcamsLayer';
import { wifiMetaMap } from '../cesium/useWifiLayer';
import { satelliteMetaMap } from '../cesium/useSatellitesLayer';
import { replayMetaMap } from '../cesium/useReplayOverlay';

export interface AIContextCandidate extends Omit<AIContextObject, 'distanceM'> {
    distanceM?: number;
}

type MetaRecord = Record<string, unknown>;

export const AI_CONTEXT_SOURCE_LABEL: Record<AIContextSourceId, string> = {
    infrastructure: 'Infrastructure',
    aircraft: 'Aircraft',
    vessels: 'Vessels',
    pipelines: 'Pipelines',
    fires: 'Fires',
    cables: 'Cables',
    airspace: 'Airspace',
    webcams: 'Webcams',
    wifi: 'Wi-Fi',
    satellites: 'Satellites',
    replay: 'Replay objects',
};

const EARTH_RADIUS_M = 6371008.8;

export function haversineMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function formatDistance(distanceM: number): string {
    if (!Number.isFinite(distanceM)) return '?';
    if (distanceM < 1000) return `${Math.round(distanceM)}m`;
    return `${(distanceM / 1000).toFixed(distanceM < 10_000 ? 2 : 1)}km`;
}

export function getAIContextCandidates(sourceId: AIContextSourceId): AIContextCandidate[] {
    switch (sourceId) {
        case 'infrastructure':
            return mapMeta(infraMetaMap, sourceId, normalizeInfrastructure);
        case 'aircraft':
            return mapMeta(aircraftMetaMap, sourceId, normalizeAircraft);
        case 'vessels':
            return mapMeta(vesselMetaMap, sourceId, normalizeVessel);
        case 'pipelines':
            return mapMeta(pipelineMetaMap, sourceId, normalizePipeline);
        case 'fires':
            return mapMeta(fireMetaMap, sourceId, normalizeFire);
        case 'cables':
            return mapMeta(cableMetaMap, sourceId, normalizeGeneric);
        case 'airspace':
            return mapMeta(airspaceMetaMap, sourceId, normalizeAirspace);
        case 'webcams':
            return mapMeta(webcamMetaMap, sourceId, normalizeGeneric);
        case 'wifi':
            return mapMeta(wifiMetaMap, sourceId, normalizeWifi);
        case 'satellites':
            return mapMeta(satelliteMetaMap, sourceId, normalizeSatellite);
        case 'replay':
            return mapMeta(replayMetaMap, sourceId, normalizeReplay);
    }
}

function mapMeta<T extends { lat?: number; lng?: number }>(
    metaMap: Map<string, T>,
    sourceId: AIContextSourceId,
    normalize: (id: string, sourceId: AIContextSourceId, meta: T & MetaRecord) => AIContextCandidate | null,
): AIContextCandidate[] {
    const out: AIContextCandidate[] = [];
    metaMap.forEach((raw, id) => {
        const meta = raw as T & MetaRecord;
        if (!Number.isFinite(meta.lat) || !Number.isFinite(meta.lng)) return;
        const normalized = normalize(id, sourceId, meta);
        if (normalized) out.push(normalized);
    });
    return out;
}

function baseCandidate(
    id: string,
    sourceId: AIContextSourceId,
    meta: { lat?: number; lng?: number; alt?: number | null } & MetaRecord,
    fallbackName: string,
): AIContextCandidate | null {
    if (!Number.isFinite(meta.lat) || !Number.isFinite(meta.lng)) return null;
    const sourceLabel = AI_CONTEXT_SOURCE_LABEL[sourceId];
    return {
        id: `${sourceId}:${id}`,
        sourceId,
        sourceLabel,
        name: text(meta.name ?? fallbackName),
        type: text(meta.layer ?? sourceLabel),
        subtype: nullableText(meta.subtype ?? meta.type ?? meta.typeName),
        lat: Number(meta.lat),
        lng: Number(meta.lng),
        alt: numericOrNull(meta.alt),
        description: nullableText(meta.description),
    };
}

function normalizeInfrastructure(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, id);
    if (!item) return null;
    item.type = 'Infrastructure';
    item.fields = {
        subtype: nullableText(meta.subtype),
        source: nullableText(meta.source),
    };
    return item;
}

function normalizeAircraft(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, text(meta.callsign ?? meta.icao24 ?? id));
    if (!item) return null;
    item.type = 'Aircraft';
    item.subtype = nullableText(meta.type);
    item.fields = compactFields({
        icao24: meta.icao24,
        callsign: meta.callsign,
        speed: roundNumber(meta.speed),
        heading: roundNumber(meta.heading),
        altitude_m: roundNumber(meta.alt),
        vertical_rate: roundNumber(meta.verticalRate),
        squawk: meta.squawk,
        on_ground: meta.onGround,
    });
    return item;
}

function normalizeVessel(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, text(meta.name ?? meta.mmsi ?? id));
    if (!item) return null;
    item.type = 'Vessel';
    item.subtype = nullableText(meta.type);
    item.fields = compactFields({
        mmsi: meta.id ?? id,
        call_sign: meta.callSign,
        imo: meta.imo,
        speed: roundNumber(meta.speed),
        heading: roundNumber(meta.heading),
        status: meta.navigationStatus,
        destination: meta.destination,
        draught: meta.draught,
    });
    return item;
}

function normalizePipeline(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, id);
    if (!item) return null;
    item.type = 'Pipeline';
    item.subtype = nullableText(meta.substance);
    item.fields = compactFields({
        substance: meta.substance,
        raw_substance: meta.rawSubstance,
        source: meta.source,
    });
    return item;
}

function normalizeFire(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, id);
    if (!item) return null;
    item.name = meta.aggregated ? `Fire cluster (${meta.count ?? 0})` : 'Fire hotspot';
    item.type = 'Fire hotspot';
    item.subtype = nullableText(meta.subtype);
    item.fields = compactFields({
        frp: roundNumber(meta.frp),
        count: meta.count,
        aggregated: meta.aggregated,
    });
    return item;
}

function normalizeAirspace(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, id);
    if (!item) return null;
    item.type = 'Airspace';
    item.subtype = nullableText(meta.typeName ?? meta.subtype);
    item.fields = compactFields({
        lower_limit: meta.lowerLimit,
        upper_limit: meta.upperLimit,
        source: meta.source,
    });
    return item;
}

function normalizeWifi(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, 'Wi-Fi Network');
    if (!item) return null;
    item.type = 'Wi-Fi Network';
    item.subtype = nullableText(meta.security);
    item.fields = compactFields({
        security: meta.security,
        last_seen: meta.lastSeen,
        source: meta.source,
    });
    return item;
}

function normalizeSatellite(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, text(meta.name ?? meta.noradId ?? id));
    if (!item) return null;
    item.type = 'Satellite';
    item.subtype = nullableText(meta.subtype ?? meta.type);
    item.fields = compactFields({
        norad_id: meta.noradId,
        category: meta.type,
        provider: meta.provider,
        tle_epoch: meta.tleEpochAt,
        motion_confidence: meta.motionConfidence,
        motion_age_sec: roundNumber(meta.motionAgeSec),
    });
    return item;
}

function normalizeReplay(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, id);
    if (!item) return null;
    item.type = text(meta.layer ?? meta.layerId ?? 'Replay object');
    item.subtype = nullableText(meta.subtype);
    item.fields = compactFields({
        layer_id: meta.layerId,
        source: meta.source,
        speed: roundNumber(meta.speed),
        heading: roundNumber(meta.heading),
        ...(isRecord(meta.extra) ? meta.extra : {}),
    });
    return item;
}

function normalizeGeneric(id: string, sourceId: AIContextSourceId, meta: MetaRecord): AIContextCandidate | null {
    const item = baseCandidate(id, sourceId, meta, id);
    if (!item) return null;
    item.fields = compactFields({
        subtype: meta.subtype,
        source: meta.source,
    });
    return item;
}

function compactFields(input: Record<string, unknown>): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) continue;
            out[key] = trimmed.length > 160 ? `${trimmed.slice(0, 159)}...` : trimmed;
            continue;
        }
        if (typeof value === 'number') {
            if (Number.isFinite(value)) out[key] = value;
            continue;
        }
        if (typeof value === 'boolean' || value === null) {
            out[key] = value;
        }
    }
    return out;
}

function text(value: unknown): string {
    if (value === null || value === undefined) return 'Unknown';
    const s = String(value).trim().replace(/[\r\n\t\u0000-\u001F]+/g, ' ');
    return s || 'Unknown';
}

function nullableText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const s = String(value).trim().replace(/[\r\n\t\u0000-\u001F]+/g, ' ');
    return s || null;
}

function numericOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
