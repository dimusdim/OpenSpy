import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as satelliteJs from 'satellite.js';
import { decode } from '@msgpack/msgpack';
import { ReplayQueryService, type ReplaySatelliteTleRow, type ReplayStateFilters } from './replay-query.service';
import { ReplayTileBuilderService, type ReplayTilePayload } from './replay-tile-builder.service';

type RenderLayer = 'aircraft' | 'vessel' | 'satellite' | 'disasters' | 'fire' | 'outage' | 'jamming' | 'gfw' | 'conflict' | 'airspace' | 'pipeline' | 'cable' | string;

type BuildReplayRenderChunksParams = {
    at: string;
    from?: string;
    to?: string;
    layers: string[];
    z?: number;
    bbox?: [number, number, number, number];
    aggregateFires?: boolean;
};

type BuildReplayPointDeltasParams = {
    at: string;
    layers: string[];
    bbox?: [number, number, number, number];
    aggregateFires?: boolean;
};

type RenderFeatureRef = {
    featureIndex: number;
    id: string;
    layerId: string;
    family: 'entity' | 'event' | 'asset';
    sourceId: string | null;
    subtype: string | null;
    displayLat: number | null;
    displayLng: number | null;
    displayAlt: number;
    speedMps?: number | null;
    headingDeg?: number | null;
};

type RenderFeature = RenderFeatureRef & {
    name: string;
    description?: string | null;
    extra: Record<string, unknown>;
};

type RenderStyle = {
    styleId: number;
    layerId: string;
    subtype: string | null;
    sourceId: string | null;
    variant: string | null;
    kindMask: number;
};

type MotionSample = {
    atMs: number;
    lng: number;
    lat: number;
    alt: number;
};

type SatelliteReplayItem = {
    row: ReplaySatelliteTleRow;
    satrec: any;
};

type ReplayPointDeltaLayer = {
    layerId: string;
    at: string;
    count: number;
    ids: string[];
    hashes: number[];
    styleIds: number[];
    familyCodes: number[];
    styles: Record<string, RenderStyle>;
    sourceIds: Array<string | null>;
    subtypes: Array<string | null>;
    positions: number[];
    cartographic: number[];
    properties: number[];
    timingsMs: Record<string, number>;
};

export type ReplayPointDeltasResponse = {
    format: 'AWVPOINTDELTA1';
    version: 1;
    mode: 'replay';
    at: string;
    layers: Record<string, ReplayPointDeltaLayer>;
};

export type ReplayPointDeltaBinary = {
    at: string;
    layerId: string;
    count: number;
    buffer: Buffer;
};

type RenderFootprint = {
    featureIndex: number;
    radiusMeters: number;
    sensorName: string;
    sensorType: 'OPTICAL' | 'SAR' | 'OTHER';
    source: string;
};

type PackedRenderGeometry = {
    featureTable: Uint32Array;
    featureBboxes: Float32Array;
    featureProperties: Float32Array;
    pointPositions: Float32Array;
    pointFeatureIndices: Uint32Array;
    linePositions: Float32Array;
    lineFeatureIndices: Uint32Array;
    fillPositions: Float32Array;
    fillIndices: Uint32Array;
    fillFeatureIndices: Uint32Array;
    trackRows: Uint32Array;
    trackSampleTimes: Float64Array;
    trackSamplePositions: Float32Array;
    styles: Record<string, RenderStyle>;
    details: RenderFeatureRef[];
    footprints: RenderFootprint[];
    inputFeatureCount: number;
    skippedNoGeometry: number;
    skippedUnsupported: number;
};

type RenderChunkFiles = {
    manifestPath: string;
    dataPath: string;
    detailsPath: string;
};

export type ReplayRenderChunkManifest = {
    format: 'AWVBIN1';
    version: 1;
    mode: 'replay';
    chunkId: string;
    layerId: string;
    at: string;
    from: string;
    to: string;
    z: number;
    x: number;
    y: number;
    tBucket: string;
    bbox: [number, number, number, number];
    dataUrl: string;
    detailsUrl: string;
    counts: {
        inputFeatures: number;
        features: number;
        skippedNoGeometry: number;
        skippedUnsupported: number;
        pointVertices: number;
        lineVertices: number;
        lineSegments: number;
        fillVertices: number;
        fillTriangles: number;
        fillIndices: number;
        tracks: number;
        trackSamples: number;
        footprints: number;
    };
    bytes: {
        binary: number;
        source: number;
    };
    sections: Record<string, {
        type: 'uint32' | 'float32' | 'float64';
        itemSize: number;
        byteOffset: number;
        byteLength: number;
        length: number;
    }>;
    styles: Record<string, RenderStyle>;
    footprints: RenderFootprint[];
    timingsMs: Record<string, number>;
};

export type ReplayRenderChunksResponse = {
    format: 'AWVBIN1';
    version: 1;
    mode: 'replay';
    at: string;
    from: string;
    to: string;
    layers: Record<string, ReplayRenderChunkManifest[]>;
};

const RENDER_ROOT = path.resolve(__dirname, '../../var/render-chunks');
const MAGIC = 'AWVBIN1\0';
const HEADER_BYTES = 64;
const FEATURE_ROW_UINTS = 12;
const DAY_SECONDS = 24 * 60 * 60;
const WGS84_A = 6378137;
const WGS84_E2 = 6.69437999014e-3;
const DEG = 180 / Math.PI;

function normalizeLayerId(layerId: string): string {
    return layerId === 'satellites' ? 'satellite' : layerId;
}

function getBucketSeconds(layerId: string): number {
    switch (normalizeLayerId(layerId)) {
        case 'aircraft':
        case 'vessel':
            return 10 * 60;
        case 'conflict':
        case 'disasters':
        case 'outage':
        case 'jamming':
        case 'fire':
        case 'gfw':
            return 60 * 60;
        case 'airspace':
        case 'pipeline':
        case 'cable':
            return DAY_SECONDS;
        case 'satellite':
            return 5 * 60;
        default:
            return 60 * 60;
    }
}

function floorIsoToBucket(atIso: string, bucketSeconds: number): string {
    const bucketMs = bucketSeconds * 1000;
    const atMs = new Date(atIso).getTime();
    return new Date(Math.floor(atMs / bucketMs) * bucketMs).toISOString();
}

function stableHash32(input: unknown): number {
    const str = String(input || '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function contentHash(input: Buffer | string): string {
    return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function toEcef(lng: number, lat: number, alt = 0): [number, number, number] {
    const lonRad = (lng * Math.PI) / 180;
    const latRad = (lat * Math.PI) / 180;
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const radius = n + alt;
    return [
        radius * cosLat * Math.cos(lonRad),
        radius * cosLat * Math.sin(lonRad),
        (n * (1 - WGS84_E2) + alt) * sinLat,
    ];
}

function propagateTleEcef(tleLine1: string, tleLine2: string, atIso: string): { lng: number; lat: number; alt: number; position: [number, number, number] } | null {
    try {
        const satrec = satelliteJs.twoline2satrec(tleLine1, tleLine2);
        return propagateSatrecEcef(satrec, atIso);
    } catch {
        return null;
    }
}

function propagateSatrecEcef(satrec: any, atIso: string): { lng: number; lat: number; alt: number; position: [number, number, number] } | null {
    try {
        const date = new Date(atIso);
        const pv = satelliteJs.propagate(satrec, date);
        if (!pv.position || typeof pv.position === 'boolean') return null;
        const gmst = satelliteJs.gstime(date);
        const geo = satelliteJs.eciToGeodetic(pv.position as satelliteJs.EciVec3<number>, gmst);
        const ecf = satelliteJs.geodeticToEcf(geo);
        if (!Number.isFinite(ecf.x) || !Number.isFinite(ecf.y) || !Number.isFinite(ecf.z)) return null;
        return {
            lng: geo.longitude * DEG,
            lat: geo.latitude * DEG,
            alt: geo.height * 1000,
            position: [ecf.x * 1000, ecf.y * 1000, ecf.z * 1000],
        };
    } catch {
        return null;
    }
}

function propagateTleSamples(tleLine1: string, tleLine2: string, fromIso: string, toIso: string, stepSeconds: number): MotionSample[] {
    const fromMs = new Date(fromIso).getTime();
    const toMs = new Date(toIso).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
    const out: MotionSample[] = [];
    for (let sampleMs = fromMs; sampleMs <= toMs; sampleMs += stepSeconds * 1000) {
        const position = propagateTleEcef(tleLine1, tleLine2, new Date(sampleMs).toISOString());
        if (!position) continue;
        out.push({ atMs: sampleMs, lng: position.lng, lat: position.lat, alt: position.alt });
    }
    if (out.length === 0 || out[out.length - 1].atMs !== toMs) {
        const position = propagateTleEcef(tleLine1, tleLine2, new Date(toMs).toISOString());
        if (position) out.push({ atMs: toMs, lng: position.lng, lat: position.lat, alt: position.alt });
    }
    return out;
}

function isValidLonLat(point: unknown): point is [number, number] {
    if (!Array.isArray(point) || point.length < 2) return false;
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    return Number.isFinite(lng)
        && Number.isFinite(lat)
        && lng >= -180
        && lng <= 180
        && lat >= -90
        && lat <= 90;
}

function samePoint(a: number[] | undefined, b: number[] | undefined): boolean {
    return Boolean(a && b && Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1]));
}

function cleanLine(coords: unknown): Array<[number, number]> {
    if (!Array.isArray(coords)) return [];
    const line: Array<[number, number]> = [];
    for (const point of coords) {
        if (!isValidLonLat(point)) continue;
        const lng = Number(point[0]);
        const lat = Number(point[1]);
        const prev = line[line.length - 1];
        if (prev && prev[0] === lng && prev[1] === lat) continue;
        line.push([lng, lat]);
    }
    return line;
}

function cleanRing(coords: unknown): Array<[number, number]> {
    const ring = cleanLine(coords);
    if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) ring.pop();
    return ring;
}

function updateBbox(bbox: [number, number, number, number], lng: number, lat: number): void {
    if (lng < bbox[0]) bbox[0] = lng;
    if (lat < bbox[1]) bbox[1] = lat;
    if (lng > bbox[2]) bbox[2] = lng;
    if (lat > bbox[3]) bbox[3] = lat;
}

function geometryForFeature(feature: any): any | null {
    if (feature?.geometry?.type) return feature.geometry;
    const lng = Number(feature?.display_lng ?? feature?.lng ?? feature?.lon ?? feature?.longitude);
    const lat = Number(feature?.display_lat ?? feature?.lat ?? feature?.latitude);
    if (Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
        return { type: 'Point', coordinates: [lng, lat] };
    }
    return null;
}

function featureFamily(feature: any): RenderFeatureRef['family'] {
    if (feature?.entity_id) return 'entity';
    if (feature?.event_id) return 'event';
    return 'asset';
}

function featureFamilyCode(family: RenderFeatureRef['family']): number {
    if (family === 'entity') return 1;
    if (family === 'event') return 2;
    return 3;
}

function featureId(feature: any, index: number): string {
    return String(feature?.entity_id || feature?.event_id || feature?.asset_id || feature?.id || `${feature?.layer_id || 'feature'}:${index}`);
}

function featureName(feature: any, fallbackId: string): string {
    const props = feature?.properties || feature?.entity_properties || feature?.position_properties || {};
    if (feature?.layer_id === 'fire' && props?.aggregated) {
        const count = Number(props?.count || 0);
        return count > 0 ? `Fire Cluster (${count})` : 'Fire Cluster';
    }
    return String(feature?.display_name || feature?.name || props?.name || props?.title || props?.summary || props?.location || fallbackId);
}

function featureDescription(feature: any): string | null {
    const props = feature?.properties || feature?.entity_properties || {};
    return props?.description || props?.notes || props?.summary || props?.event_type || null;
}

function featureExtra(feature: any): Record<string, unknown> {
    const props = feature?.properties || feature?.entity_properties || feature?.position_properties || {};
    const extra: Record<string, unknown> = { ...(props && typeof props === 'object' ? props : {}) };
    if (feature?.entity_kind) extra.entityKind = feature.entity_kind;
    if (feature?.event_kind) extra.eventKind = feature.event_kind;
    if (feature?.asset_kind) extra.assetKind = feature.asset_kind;
    if (feature?.position_observed_at) extra.positionObservedAt = feature.position_observed_at;
    if (feature?.observed_at) extra.observedAt = feature.observed_at;
    if (feature?.updated_at) extra.updatedAt = feature.updated_at;
    return extra;
}

function makeRenderFeatureRef(feature: any, index: number, bbox: [number, number, number, number]): RenderFeatureRef {
    const id = featureId(feature, index);
    const lng = Number(feature?.display_lng);
    const lat = Number(feature?.display_lat);
    const alt = Number(feature?.altitude_m ?? 0) || 0;
    const bboxLng = Number.isFinite(lng) ? lng : (bbox[0] + bbox[2]) / 2;
    const bboxLat = Number.isFinite(lat) ? lat : (bbox[1] + bbox[3]) / 2;
    return {
        featureIndex: index,
        id,
        layerId: normalizeLayerId(String(feature?.layer_id || 'unknown')),
        family: featureFamily(feature),
        sourceId: feature?.source_id || null,
        subtype: feature?.subtype || null,
        displayLat: Number.isFinite(bboxLat) ? bboxLat : null,
        displayLng: Number.isFinite(bboxLng) ? bboxLng : null,
        displayAlt: alt,
        speedMps: Number.isFinite(Number(feature?.speed_mps)) ? Number(feature.speed_mps) : null,
        headingDeg: Number.isFinite(Number(feature?.heading_deg)) ? Number(feature.heading_deg) : null,
    };
}

function makeRenderFeature(feature: any, index: number, bbox: [number, number, number, number]): RenderFeature {
    const ref = makeRenderFeatureRef(feature, index, bbox);
    return {
        ...ref,
        name: featureName(feature, ref.id),
        description: featureDescription(feature),
        extra: featureExtra(feature),
    };
}

function styleVariant(feature: any): string | null {
    const layerId = normalizeLayerId(String(feature?.layer_id || ''));
    const props = feature?.properties || feature?.entity_properties || feature?.position_properties || {};
    if (layerId === 'satellite') {
        if (feature?.subtype === 'recon' || props?.recon || props?.reconMeta) return 'recon';
        return null;
    }
    if (layerId === 'disasters') {
        return String(props?.alertLevel || props?.alert_level || 'Green');
    }
    if (layerId === 'conflict') {
        return String(props?.event_type || props?.eventType || feature?.subtype || 'violence');
    }
    if (layerId === 'jamming') {
        return String(feature?.subtype || props?.intensity || 'medium').toLowerCase();
    }
    return null;
}

function styleKey(feature: any): string {
    return [
        normalizeLayerId(String(feature?.layer_id || 'unknown')),
        feature?.subtype || '',
        feature?.source_id || '',
        styleVariant(feature) || '',
    ].join('|');
}

function styleIdFor(key: string): number {
    return stableHash32(key);
}

function pushEcef(target: number[], lng: number, lat: number, alt = 0): void {
    const [x, y, z] = toEcef(lng, lat, alt);
    target.push(x, y, z);
}

function pushPoint(state: any, featureIndex: number, bbox: [number, number, number, number], point: [number, number], alt = 0): void {
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    pushEcef(state.pointPositions, lng, lat, alt);
    state.pointFeatureIndices.push(featureIndex);
    updateBbox(bbox, lng, lat);
}

function pushLine(state: any, featureIndex: number, bbox: [number, number, number, number], coords: unknown, alt = 0): number {
    const line = cleanLine(coords);
    if (line.length < 2) return 0;
    let vertices = 0;
    for (let i = 0; i < line.length - 1; i += 1) {
        const a = line[i];
        const b = line[i + 1];
        pushEcef(state.linePositions, a[0], a[1], alt);
        pushEcef(state.linePositions, b[0], b[1], alt);
        state.lineFeatureIndices.push(featureIndex, featureIndex);
        updateBbox(bbox, a[0], a[1]);
        updateBbox(bbox, b[0], b[1]);
        vertices += 2;
    }
    return vertices;
}

function pushPolygon(state: any, featureIndex: number, bbox: [number, number, number, number], polygon: unknown, extrusionHeight = 0): { fillVertices: number; fillIndices: number; lineVertices: number } {
    if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) {
        return { fillVertices: 0, fillIndices: 0, lineVertices: 0 };
    }

    let lineVertices = 0;
    for (const ringCoords of polygon) {
        const ring = cleanRing(ringCoords);
        if (ring.length < 2) continue;
        lineVertices += pushLine(state, featureIndex, bbox, [...ring, ring[0]], extrusionHeight > 0 ? extrusionHeight : 0);
    }

    // Initial production bridge: outer-ring fan. The detailed geometry remains
    // in metadata/storage for later exact triangulation, but the render batch
    // keeps browser work numeric and compact.
    const outer = cleanRing(polygon[0]);
    if (outer.length < 3) return { fillVertices: 0, fillIndices: 0, lineVertices };
    const baseVertex = state.fillPositions.length / 3;
    for (const point of outer) {
        pushEcef(state.fillPositions, point[0], point[1], extrusionHeight > 0 ? extrusionHeight : 0);
        state.fillFeatureIndices.push(featureIndex);
        updateBbox(bbox, point[0], point[1]);
    }
    const indexStart = state.fillIndices.length;
    for (let i = 1; i < outer.length - 1; i += 1) {
        state.fillIndices.push(baseVertex, baseVertex + i, baseVertex + i + 1);
    }
    if (extrusionHeight > 0) {
        for (let i = 0; i < outer.length; i += 1) {
            const a = outer[i];
            const b = outer[(i + 1) % outer.length];
            const sideBase = state.fillPositions.length / 3;
            pushEcef(state.fillPositions, a[0], a[1], 0);
            pushEcef(state.fillPositions, b[0], b[1], 0);
            pushEcef(state.fillPositions, b[0], b[1], extrusionHeight);
            pushEcef(state.fillPositions, a[0], a[1], extrusionHeight);
            state.fillFeatureIndices.push(featureIndex, featureIndex, featureIndex, featureIndex);
            state.fillIndices.push(sideBase, sideBase + 1, sideBase + 2, sideBase, sideBase + 2, sideBase + 3);
            updateBbox(bbox, a[0], a[1]);
            updateBbox(bbox, b[0], b[1]);
        }
    }
    return {
        fillVertices: state.fillPositions.length / 3 - baseVertex,
        fillIndices: state.fillIndices.length - indexStart,
        lineVertices,
    };
}

function featureExtrusionHeight(feature: any): number {
    if (normalizeLayerId(String(feature?.layer_id || '')) !== 'jamming') return 0;
    const props = feature?.properties || feature?.entity_properties || {};
    const intensity = String(feature?.subtype || props?.intensity || '').toLowerCase();
    if (intensity === 'high') return 80_000;
    if (intensity === 'medium') return 40_000;
    if (intensity === 'low') return 15_000;
    return 40_000;
}

function finiteOrNaN(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : Number.NaN;
}

function asFeatureListFromPayloads(payloads: ReplayTilePayload[], atIso: string): any[] {
    const atMs = new Date(atIso).getTime();
    const entityMap = new Map<string, any>();
    const eventMap = new Map<string, any>();
    const assetMap = new Map<string, any>();

    const validSnapshots = payloads
        .filter((payload) => {
            const snapMs = payload.snapshotAt ? new Date(payload.snapshotAt).getTime() : Number.NaN;
            return Number.isFinite(snapMs) && snapMs <= atMs;
        })
        .sort((a, b) => new Date(a.snapshotAt).getTime() - new Date(b.snapshotAt).getTime());
    for (const payload of validSnapshots) {
        for (const entity of payload.snapshot?.entities || []) entityMap.set((entity as any).entity_id, entity);
        for (const event of payload.snapshot?.events || []) eventMap.set((event as any).event_id, event);
        for (const asset of payload.snapshot?.assets || []) assetMap.set((asset as any).asset_id, asset);
    }

    const items = payloads
        .flatMap((payload) => payload.items || [])
        .sort((left: any, right: any) => {
            const leftAt = new Date(left.at).getTime();
            const rightAt = new Date(right.at).getTime();
            if (leftAt !== rightAt) return leftAt - rightAt;
            return String(left.target_id || '').localeCompare(String(right.target_id || ''));
        });
    for (const item of items as any[]) {
        if (new Date(item.at).getTime() > atMs) continue;
        if (item.family === 'entity') {
            if (item.op === 'remove') entityMap.delete(item.entity_id);
            else entityMap.set(item.item.entity_id, item.item);
            continue;
        }
        if (item.family === 'event') {
            if (item.op === 'remove') eventMap.delete(item.event_id);
            else eventMap.set(item.item.event_id, item.item);
            continue;
        }
        if (item.item?.asset_id) assetMap.set(item.item.asset_id, item.item);
    }

    return [
        ...Array.from(assetMap.values()),
        ...Array.from(eventMap.values()),
        ...Array.from(entityMap.values()),
    ];
}

function motionSamplesFromPayloads(payloads: ReplayTilePayload[], atIso: string): Map<string, MotionSample[]> {
    const atMs = new Date(atIso).getTime();
    const validSnapshots = payloads
        .filter((payload) => {
            const snapMs = payload.snapshotAt ? new Date(payload.snapshotAt).getTime() : Number.NaN;
            return Number.isFinite(snapMs) && snapMs <= atMs;
        })
        .sort((a, b) => new Date(a.snapshotAt).getTime() - new Date(b.snapshotAt).getTime());
    const motionSamples = new Map<string, Map<number, MotionSample>>();
    const tryAdd = (entityId: string, sample: MotionSample) => {
        let slot = motionSamples.get(entityId);
        if (!slot) {
            slot = new Map();
            motionSamples.set(entityId, slot);
        }
        if (!slot.has(sample.atMs)) slot.set(sample.atMs, sample);
    };
    for (const payload of validSnapshots) {
        for (const entity of payload.snapshot?.entities || []) {
            if ((entity as any).layer_id !== 'aircraft' && (entity as any).layer_id !== 'vessel') continue;
            const sampleAtMs = (entity as any).position_observed_at ? new Date((entity as any).position_observed_at).getTime() : Number.NaN;
            const lng = Number((entity as any).display_lng);
            const lat = Number((entity as any).display_lat);
            const alt = Number((entity as any).altitude_m ?? 0) || 0;
            if (Number.isFinite(sampleAtMs) && Number.isFinite(lng) && Number.isFinite(lat)) {
                tryAdd((entity as any).entity_id, { atMs: sampleAtMs, lng, lat, alt });
            }
        }
    }
    for (const payload of payloads) {
        for (const item of payload.items || []) {
            const raw = item as any;
            if (raw.family !== 'entity' || raw.op !== 'upsert') continue;
            if (raw.layer_id !== 'aircraft' && raw.layer_id !== 'vessel') continue;
            const entity = raw.item;
            const sampleAtMs = entity?.position_observed_at ? new Date(entity.position_observed_at).getTime() : new Date(raw.at).getTime();
            const lng = Number(entity?.display_lng);
            const lat = Number(entity?.display_lat);
            const alt = Number(entity?.altitude_m ?? 0) || 0;
            if (Number.isFinite(sampleAtMs) && Number.isFinite(lng) && Number.isFinite(lat)) {
                tryAdd(entity.entity_id, { atMs: sampleAtMs, lng, lat, alt });
            }
        }
    }
    const ordered = new Map<string, MotionSample[]>();
    motionSamples.forEach((slot, entityId) => {
        const samples = Array.from(slot.values()).sort((a, b) => a.atMs - b.atMs);
        if (samples.length > 0) ordered.set(entityId, samples);
    });
    return ordered;
}

function sensorForFeature(feature: any): { radiusMeters: number; sensorName: string; sensorType: 'OPTICAL' | 'SAR' | 'OTHER'; source: string } | null {
    const entityProps = feature?.entity_properties && typeof feature.entity_properties === 'object' ? feature.entity_properties : {};
    const positionProps = feature?.position_properties && typeof feature.position_properties === 'object' ? feature.position_properties : {};
    const orbitalProps = feature?.orbital_properties && typeof feature.orbital_properties === 'object' ? feature.orbital_properties : {};
    const sensor = entityProps.sensor || positionProps.sensor || orbitalProps.sensor || entityProps.reconMeta?.sensor || orbitalProps.reconMeta?.sensor;
    if (!sensor || typeof sensor !== 'object') return null;
    const swathMeters = Number(sensor.swathMeters ?? sensor.sensorSwathMeters ?? sensor.swath_meters ?? sensor.swath);
    if (!Number.isFinite(swathMeters) || swathMeters <= 0) return null;
    const rawType = String(sensor.sensorType || sensor.type || '').toUpperCase();
    return {
        radiusMeters: swathMeters / 2,
        sensorName: String(sensor.sensorName || sensor.name || ''),
        sensorType: rawType === 'OPTICAL' || rawType === 'SAR' ? rawType : 'OTHER',
        source: String(sensor.source || 'spectator-earth'),
    };
}

function packGeometry(
    features: any[],
    motionById: Map<string, MotionSample[]> = new Map(),
): PackedRenderGeometry {
    const state: any = {
        pointPositions: [] as number[],
        pointFeatureIndices: [] as number[],
        linePositions: [] as number[],
        lineFeatureIndices: [] as number[],
        fillPositions: [] as number[],
        fillIndices: [] as number[],
        fillFeatureIndices: [] as number[],
        trackRows: [] as number[],
        trackSampleTimes: [] as number[],
        trackSamplePositions: [] as number[],
        featureRows: [] as number[],
        featureBboxes: [] as number[],
        featureProperties: [] as number[],
        styles: {} as Record<string, RenderStyle>,
        details: [] as RenderFeatureRef[],
        footprints: [] as RenderFootprint[],
        skippedNoGeometry: 0,
        skippedUnsupported: 0,
    };

    for (let i = 0; i < features.length; i += 1) {
        const feature = features[i];
        const id = featureId(feature, i);
        const geometry = geometryForFeature(feature);
        if (!geometry?.type) {
            state.skippedNoGeometry += 1;
            continue;
        }
        const pointStart = state.pointPositions.length / 3;
        const lineStart = state.linePositions.length / 3;
        const fillStart = state.fillPositions.length / 3;
        const indexStart = state.fillIndices.length;
        const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
        const featureIndex = state.details.length;
        const altitude = Number(feature?.altitude_m ?? 0) || 0;
        const extrusionHeight = featureExtrusionHeight(feature);
        let kind = 0;

        switch (geometry.type) {
            case 'Point':
                if (isValidLonLat(geometry.coordinates)) {
                    pushPoint(state, featureIndex, bbox, [Number(geometry.coordinates[0]), Number(geometry.coordinates[1])], altitude);
                    kind |= 1;
                }
                break;
            case 'MultiPoint':
                for (const point of geometry.coordinates || []) {
                    if (!isValidLonLat(point)) continue;
                    pushPoint(state, featureIndex, bbox, [Number(point[0]), Number(point[1])], altitude);
                    kind |= 1;
                }
                break;
            case 'LineString':
                if (pushLine(state, featureIndex, bbox, geometry.coordinates) > 0) kind |= 2;
                break;
            case 'MultiLineString':
                for (const line of geometry.coordinates || []) {
                    if (pushLine(state, featureIndex, bbox, line) > 0) kind |= 2;
                }
                break;
            case 'Polygon': {
                const result = pushPolygon(state, featureIndex, bbox, geometry.coordinates, extrusionHeight);
                if (result.lineVertices > 0) kind |= 2;
                if (result.fillVertices > 0 && result.fillIndices > 0) kind |= 4;
                break;
            }
            case 'MultiPolygon':
                for (const polygon of geometry.coordinates || []) {
                    const result = pushPolygon(state, featureIndex, bbox, polygon, extrusionHeight);
                    if (result.lineVertices > 0) kind |= 2;
                    if (result.fillVertices > 0 && result.fillIndices > 0) kind |= 4;
                }
                break;
            default:
                state.skippedUnsupported += 1;
                break;
        }

        const pointCount = state.pointPositions.length / 3 - pointStart;
        const lineVertexCount = state.linePositions.length / 3 - lineStart;
        const fillVertexCount = state.fillPositions.length / 3 - fillStart;
        const indexCount = state.fillIndices.length - indexStart;
        if (!kind || !Number.isFinite(bbox[0])) continue;

        const key = styleKey(feature);
        const styleId = styleIdFor(key);
        if (!state.styles[String(styleId)]) {
            state.styles[String(styleId)] = {
                styleId,
                layerId: normalizeLayerId(String(feature?.layer_id || 'unknown')),
                subtype: feature?.subtype || null,
                sourceId: feature?.source_id || null,
                variant: styleVariant(feature),
                kindMask: 0,
            };
        }
        state.styles[String(styleId)].kindMask |= kind;
        state.featureRows.push(
            featureIndex,
            kind,
            pointStart,
            pointCount,
            lineStart,
            lineVertexCount,
            fillStart,
            fillVertexCount,
            indexStart,
            indexCount,
            styleId,
            0,
        );
        state.featureBboxes.push(bbox[0], bbox[1], bbox[2], bbox[3]);
        state.featureProperties.push(
            finiteOrNaN(feature?.heading_deg),
            finiteOrNaN(feature?.speed_mps),
            altitude,
            extrusionHeight,
        );
        state.details.push(makeRenderFeatureRef(feature, featureIndex, bbox));

        const samples = motionById.get(id);
        if (samples && samples.length > 0) {
            const sampleStart = state.trackSampleTimes.length;
            for (const sample of samples) {
                state.trackSampleTimes.push(sample.atMs);
                pushEcef(state.trackSamplePositions, sample.lng, sample.lat, sample.alt);
            }
            state.trackRows.push(featureIndex, sampleStart, samples.length, 0);
        }

        const sensor = sensorForFeature(feature);
        if (sensor) {
            state.footprints.push({
                featureIndex,
                radiusMeters: sensor.radiusMeters,
                sensorName: sensor.sensorName,
                sensorType: sensor.sensorType,
                source: sensor.source,
            });
        }
    }

    return {
        featureTable: Uint32Array.from(state.featureRows),
        featureBboxes: Float32Array.from(state.featureBboxes),
        featureProperties: Float32Array.from(state.featureProperties),
        pointPositions: Float32Array.from(state.pointPositions),
        pointFeatureIndices: Uint32Array.from(state.pointFeatureIndices),
        linePositions: Float32Array.from(state.linePositions),
        lineFeatureIndices: Uint32Array.from(state.lineFeatureIndices),
        fillPositions: Float32Array.from(state.fillPositions),
        fillIndices: Uint32Array.from(state.fillIndices),
        fillFeatureIndices: Uint32Array.from(state.fillFeatureIndices),
        trackRows: Uint32Array.from(state.trackRows),
        trackSampleTimes: Float64Array.from(state.trackSampleTimes),
        trackSamplePositions: Float32Array.from(state.trackSamplePositions),
        styles: state.styles,
        details: state.details,
        footprints: state.footprints,
        inputFeatureCount: features.length,
        skippedNoGeometry: state.skippedNoGeometry,
        skippedUnsupported: state.skippedUnsupported,
    };
}

function typedBuffer(array: Uint32Array | Float32Array | Float64Array): Buffer {
    return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function buildBinary(packed: PackedRenderGeometry, layerId: string): { buffer: Buffer; sections: ReplayRenderChunkManifest['sections'] } {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write(MAGIC, 0, 'ascii');
    header.writeUInt32LE(1, 8);
    header.writeUInt32LE(HEADER_BYTES, 12);
    header.writeUInt32LE(packed.featureTable.length / FEATURE_ROW_UINTS, 16);
    header.writeUInt32LE(packed.pointPositions.length / 3, 20);
    header.writeUInt32LE(packed.linePositions.length / 3, 24);
    header.writeUInt32LE(packed.fillPositions.length / 3, 28);
    header.writeUInt32LE(packed.fillIndices.length, 32);
    header.writeUInt32LE(stableHash32(layerId), 36);

    const sectionSpecs: Array<[keyof PackedRenderGeometry, 'uint32' | 'float32' | 'float64', number, Uint32Array | Float32Array | Float64Array]> = [
        ['featureTable', 'uint32', FEATURE_ROW_UINTS, packed.featureTable],
        ['featureBboxes', 'float32', 4, packed.featureBboxes],
        ['featureProperties', 'float32', 4, packed.featureProperties],
        ['pointPositions', 'float32', 3, packed.pointPositions],
        ['pointFeatureIndices', 'uint32', 1, packed.pointFeatureIndices],
        ['linePositions', 'float32', 3, packed.linePositions],
        ['lineFeatureIndices', 'uint32', 1, packed.lineFeatureIndices],
        ['fillPositions', 'float32', 3, packed.fillPositions],
        ['fillIndices', 'uint32', 1, packed.fillIndices],
        ['fillFeatureIndices', 'uint32', 1, packed.fillFeatureIndices],
        ['trackRows', 'uint32', 4, packed.trackRows],
        ['trackSampleTimes', 'float64', 1, packed.trackSampleTimes],
        ['trackSamplePositions', 'float32', 3, packed.trackSamplePositions],
    ];
    let byteOffset = HEADER_BYTES;
    const sections: ReplayRenderChunkManifest['sections'] = {};
    const buffers: Uint8Array[] = [header];
    for (const [name, type, itemSize, array] of sectionSpecs) {
        const buffer = typedBuffer(array);
        sections[String(name)] = {
            type,
            itemSize,
            byteOffset,
            byteLength: buffer.byteLength,
            length: array.length,
        };
        buffers.push(buffer);
        byteOffset += buffer.byteLength;
    }
    return {
        buffer: Buffer.concat(buffers),
        sections,
    };
}

function roundMs(value: number): number {
    return Math.round(value * 100) / 100;
}

export class ReplayRenderBatchService {
    private readonly satelliteReplayCache = new Map<string, { builtAt: number; items: SatelliteReplayItem[] }>();

    constructor(
        private readonly replayQueryService: ReplayQueryService,
        private readonly replayTileBuilderService: ReplayTileBuilderService,
    ) {}

    private getFiles(chunkId: string): RenderChunkFiles {
        const dir = path.join(RENDER_ROOT, chunkId.slice(0, 2), chunkId);
        return {
            manifestPath: path.join(dir, 'manifest.json'),
            dataPath: path.join(dir, 'layer.bin'),
            detailsPath: path.join(dir, 'features.json'),
        };
    }

    private getDataUrl(chunkId: string): string {
        return `/api/replay/render-chunks/${chunkId}/data`;
    }

    private getDetailsUrl(chunkId: string): string {
        return `/api/replay/render-chunks/${chunkId}/features`;
    }

    private async readCachedManifest(chunkId: string): Promise<ReplayRenderChunkManifest | null> {
        const files = this.getFiles(chunkId);
        if (!fs.existsSync(files.manifestPath) || !fs.existsSync(files.dataPath) || !fs.existsSync(files.detailsPath)) return null;
        try {
            return JSON.parse(await fs.promises.readFile(files.manifestPath, 'utf8')) as ReplayRenderChunkManifest;
        } catch {
            return null;
        }
    }

    private async writeChunk(chunkId: string, manifest: ReplayRenderChunkManifest, binary: Buffer, details: RenderFeatureRef[]): Promise<void> {
        const files = this.getFiles(chunkId);
        await fs.promises.mkdir(path.dirname(files.manifestPath), { recursive: true });
        await Promise.all([
            fs.promises.writeFile(files.dataPath, binary),
            fs.promises.writeFile(files.detailsPath, `${JSON.stringify({ chunkId, features: details })}\n`),
            fs.promises.writeFile(files.manifestPath, `${JSON.stringify(manifest)}\n`),
        ]);
    }

    private async getSatelliteReplayItems(at: string): Promise<SatelliteReplayItem[]> {
        const cacheKey = floorIsoToBucket(at, getBucketSeconds('satellite'));
        const cached = this.satelliteReplayCache.get(cacheKey);
        if (cached && performance.now() - cached.builtAt < 10 * 60 * 1000) return cached.items;

        const rows = await this.replayQueryService.listSatelliteTleAt({
            at,
            layerId: 'satellite',
        });
        const items: SatelliteReplayItem[] = [];
        for (const row of rows) {
            if (!row.tle_line1 || !row.tle_line2) continue;
            try {
                items.push({
                    row,
                    satrec: satelliteJs.twoline2satrec(row.tle_line1, row.tle_line2),
                });
            } catch {
                // Skip malformed TLEs; they cannot be rendered or delta-updated.
            }
        }
        this.satelliteReplayCache.set(cacheKey, { builtAt: performance.now(), items });
        if (this.satelliteReplayCache.size > 16) {
            const oldest = Array.from(this.satelliteReplayCache.entries())
                .sort((a, b) => a[1].builtAt - b[1].builtAt)[0]?.[0];
            if (oldest) this.satelliteReplayCache.delete(oldest);
        }
        return items;
    }

    private async buildSatelliteFeatures(
        at: string,
        bbox?: [number, number, number, number],
    ): Promise<{ features: any[]; motionById: Map<string, MotionSample[]>; sourceBytes: number; sourceHash: string; tBucket: string }> {
        const rows = await this.getSatelliteReplayItems(at);
        const entities: any[] = [];
        for (const item of rows) {
            const row = item.row as any;
            const position = propagateSatrecEcef(item.satrec, at);
            if (!position) continue;
            if (bbox) {
                const [south, west, north, east] = bbox;
                if (position.lat < south || position.lat > north || position.lng < west || position.lng > east) continue;
            }
            entities.push({
                entity_id: row.entity_id,
                layer_id: row.layer_id,
                source_id: row.source_id,
                entity_kind: row.entity_kind,
                subtype: row.subtype,
                display_name: row.display_name,
                first_observed_at: row.first_observed_at,
                last_observed_at: row.last_observed_at,
                updated_at: row.updated_at,
                entity_observed_at: row.entity_observed_at,
                entity_properties: row.entity_properties,
                position_observed_at: at,
                geometry: {
                    type: 'Point',
                    coordinates: [position.lng, position.lat, position.alt],
                },
                display_lat: position.lat,
                display_lng: position.lng,
                altitude_m: position.alt,
                heading_deg: null,
                speed_mps: null,
                position_properties: {
                    replay_basis: 'propagated_from_tle',
                    orbital_observed_at: row.orbital_observed_at,
                    ...(row.orbital_properties || {}),
                },
                orbital_properties: row.orbital_properties,
            });
        }
        const source = JSON.stringify({
            at,
            layerId: 'satellite',
            count: entities.length,
            ids: entities.map((row: any) => row.entity_id),
        });
        return {
            features: entities,
            motionById: new Map(),
            sourceBytes: Buffer.byteLength(source),
            sourceHash: contentHash(source),
            tBucket: floorIsoToBucket(at, getBucketSeconds('satellite')),
        };
    }

    private async buildDbStateFeatures(layerId: string, at: string, bbox: [number, number, number, number] | undefined, aggregateFires: boolean): Promise<{ features: any[]; motionById: Map<string, MotionSample[]>; sourceBytes: number; sourceHash: string; tBucket: string }> {
        const filters: ReplayStateFilters = {
            at,
            layerId,
            bbox,
            aggregateFires,
        };
        const [entities, events, assets] = await Promise.all([
            this.replayQueryService.listEntityStateAt(filters),
            this.replayQueryService.listEventStateAt(filters),
            this.replayQueryService.listAssetStateAt(filters),
        ]);
        const features = [...assets, ...events, ...entities];
        const source = JSON.stringify({
            at,
            layerId,
            aggregateFires,
            counts: [entities.length, events.length, assets.length],
            ids: features.map((row: any, index) => featureId(row, index)),
        });
        return {
            features,
            motionById: new Map(),
            sourceBytes: Buffer.byteLength(source),
            sourceHash: contentHash(source),
            tBucket: floorIsoToBucket(at, getBucketSeconds(layerId)),
        };
    }

    private async buildTileBackedFeatures(layerId: string, at: string, from: string, to: string, z: number, bbox?: [number, number, number, number]): Promise<{ features: any[]; motionById: Map<string, MotionSample[]>; sourceBytes: number; sourceHash: string; tBucket: string }> {
        const manifest = await this.replayTileBuilderService.buildManifest({
            from,
            to,
            layers: [layerId],
            z,
            bbox,
        });
        const tiles = manifest.layers[layerId]?.tiles || [];
        const payloads: ReplayTilePayload[] = [];
        let sourceBytes = 0;
        const sourceHashes: string[] = [];
        for (const tile of tiles) {
            const read = await this.replayTileBuilderService.readTileBuffer({
                layerId: tile.layerId,
                z: tile.z,
                x: tile.x,
                y: tile.y,
                tBucket: tile.tBucket,
            });
            if (!read) continue;
            sourceBytes += read.buffer.byteLength;
            sourceHashes.push(read.entry.contentHash);
            payloads.push(decode(read.buffer) as ReplayTilePayload);
        }
        return {
            features: asFeatureListFromPayloads(payloads, at),
            motionById: motionSamplesFromPayloads(payloads, at),
            sourceBytes,
            sourceHash: contentHash(sourceHashes.join('|') || `${layerId}:${at}`),
            tBucket: floorIsoToBucket(at, getBucketSeconds(layerId)),
        };
    }

    private async buildLayerChunk(params: BuildReplayRenderChunksParams, rawLayerId: string): Promise<ReplayRenderChunkManifest> {
        const layerId = normalizeLayerId(rawLayerId);
        const at = new Date(params.at).toISOString();
        // Render chunks are exact snapshots. Historical windows/items belong
        // to the legacy replay-tile path, not to the batch that paints the
        // current frame.
        const from = at;
        const to = at;
        const z = Number.isFinite(params.z) ? Math.max(0, Math.min(6, Math.trunc(params.z as number))) : 0;
        const t0 = performance.now();
        const timingsMs: Record<string, number> = {};

        const featuresStart = performance.now();
        const source = layerId === 'satellite'
            ? await this.buildSatelliteFeatures(at, params.bbox)
            : await this.buildDbStateFeatures(layerId, at, params.bbox, params.aggregateFires !== false);
        timingsMs.source = roundMs(performance.now() - featuresStart);

        const chunkHashInput = [
            'v6-render-props',
            layerId,
            at,
            z,
            params.bbox?.join(',') || 'global',
            params.aggregateFires === false ? 'fireRaw' : 'fireCluster',
            source.sourceHash,
        ].join('|');
        const chunkId = contentHash(chunkHashInput);
        const cached = await this.readCachedManifest(chunkId);
        if (cached) return cached;

        const packStart = performance.now();
        const packed = packGeometry(source.features, source.motionById);
        timingsMs.pack = roundMs(performance.now() - packStart);

        const binaryStart = performance.now();
        const binary = buildBinary(packed, layerId);
        timingsMs.binary = roundMs(performance.now() - binaryStart);

        const manifest: ReplayRenderChunkManifest = {
            format: 'AWVBIN1',
            version: 1,
            mode: 'replay',
            chunkId,
            layerId,
            at,
            from,
            to,
            z,
            x: 0,
            y: 0,
            tBucket: source.tBucket,
            bbox: params.bbox || [-90, -180, 90, 180],
            dataUrl: this.getDataUrl(chunkId),
            detailsUrl: this.getDetailsUrl(chunkId),
            counts: {
                inputFeatures: packed.inputFeatureCount,
                features: packed.featureTable.length / FEATURE_ROW_UINTS,
                skippedNoGeometry: packed.skippedNoGeometry,
                skippedUnsupported: packed.skippedUnsupported,
                pointVertices: packed.pointPositions.length / 3,
                lineVertices: packed.linePositions.length / 3,
                lineSegments: packed.linePositions.length / 6,
                fillVertices: packed.fillPositions.length / 3,
                fillTriangles: packed.fillIndices.length / 3,
                fillIndices: packed.fillIndices.length,
                tracks: packed.trackRows.length / 4,
                trackSamples: packed.trackSampleTimes.length,
                footprints: packed.footprints.length,
            },
            bytes: {
                binary: binary.buffer.byteLength,
                source: source.sourceBytes,
            },
            sections: binary.sections,
            styles: packed.styles,
            footprints: packed.footprints,
            timingsMs,
        };
        manifest.timingsMs.total = roundMs(performance.now() - t0);
        await this.writeChunk(chunkId, manifest, binary.buffer, packed.details);
        return manifest;
    }

    async buildReplayChunks(params: BuildReplayRenderChunksParams): Promise<ReplayRenderChunksResponse> {
        const at = new Date(params.at).toISOString();
        const from = at;
        const to = at;
        const normalizedLayers = Array.from(new Set(params.layers.map(normalizeLayerId).filter(Boolean)));
        const entries = await Promise.all(normalizedLayers.map(async (layerId) => {
            const chunk = await this.buildLayerChunk({ ...params, at, from, to }, layerId);
            return [layerId, [chunk] as ReplayRenderChunkManifest[]] as const;
        }));
        const layers: Record<string, ReplayRenderChunkManifest[]> = {};
        for (const [layerId, chunks] of entries) layers[layerId] = chunks;
        return {
            format: 'AWVBIN1',
            version: 1,
            mode: 'replay',
            at,
            from,
            to,
            layers,
        };
    }

    private async buildSatellitePointDelta(layerId: string, at: string, bbox?: [number, number, number, number]): Promise<ReplayPointDeltaLayer> {
        const timingsMs: Record<string, number> = {};
        const sourceStart = performance.now();
        const items = await this.getSatelliteReplayItems(at);
        timingsMs.source = roundMs(performance.now() - sourceStart);

        const packStart = performance.now();
        const ids: string[] = [];
        const hashes: number[] = [];
        const styleIds: number[] = [];
        const familyCodes: number[] = [];
        const styles: Record<string, RenderStyle> = {};
        const sourceIds: Array<string | null> = [];
        const subtypes: Array<string | null> = [];
        const positions: number[] = [];
        const cartographic: number[] = [];
        const properties: number[] = [];

        for (const item of items) {
            const row = item.row as any;
            const position = propagateSatrecEcef(item.satrec, at);
            if (!position) continue;
            if (bbox) {
                const [south, west, north, east] = bbox;
                if (position.lat < south || position.lat > north || position.lng < west || position.lng > east) continue;
            }
            positions.push(position.position[0], position.position[1], position.position[2]);
        }
        timingsMs.pack = roundMs(performance.now() - packStart);

        return {
            layerId,
            at,
            count: positions.length / 3,
            ids,
            hashes,
            styleIds,
            familyCodes,
            styles,
            sourceIds,
            subtypes,
            positions,
            cartographic,
            properties,
            timingsMs,
        };
    }

    private async buildEntityPointDelta(layerId: string, at: string, bbox?: [number, number, number, number]): Promise<ReplayPointDeltaLayer> {
        const timingsMs: Record<string, number> = {};
        const sourceStart = performance.now();
        const rows = await this.replayQueryService.listEntityStateAt({
            at,
            layerId,
            bbox,
        });
        timingsMs.source = roundMs(performance.now() - sourceStart);

        const packStart = performance.now();
        const ids: string[] = [];
        const hashes: number[] = [];
        const styleIds: number[] = [];
        const familyCodes: number[] = [];
        const styles: Record<string, RenderStyle> = {};
        const sourceIds: Array<string | null> = [];
        const subtypes: Array<string | null> = [];
        const positions: number[] = [];
        const cartographic: number[] = [];
        const properties: number[] = [];

        for (const row of rows as any[]) {
            const geometry = geometryForFeature(row);
            if (!geometry || geometry.type !== 'Point' || !isValidLonLat(geometry.coordinates)) continue;
            const lng = Number(geometry.coordinates[0]);
            const lat = Number(geometry.coordinates[1]);
            const alt = Number(row?.altitude_m ?? 0) || 0;
            const position = toEcef(lng, lat, alt);
            const id = featureId(row, ids.length);
            const styleFeature = { ...row, layer_id: row?.layer_id || layerId };
            const styleId = styleIdFor(styleKey(styleFeature));
            if (!styles[String(styleId)]) {
                styles[String(styleId)] = {
                    styleId,
                    layerId,
                    subtype: styleFeature?.subtype || null,
                    sourceId: styleFeature?.source_id || null,
                    variant: styleVariant(styleFeature),
                    kindMask: 1,
                };
            }
            hashes.push(stableHash32(id));
            styleIds.push(styleId);
            familyCodes.push(featureFamilyCode('entity'));
            positions.push(position[0], position[1], position[2]);
            properties.push(
                finiteOrNaN(row?.heading_deg),
                finiteOrNaN(row?.speed_mps),
                alt,
                0,
            );
        }
        timingsMs.pack = roundMs(performance.now() - packStart);

        return {
            layerId,
            at,
            count: positions.length / 3,
            ids,
            hashes,
            styleIds,
            familyCodes,
            styles,
            sourceIds,
            subtypes,
            positions,
            cartographic,
            properties,
            timingsMs,
        };
    }

    private async buildDbPointDelta(layerId: string, at: string, bbox?: [number, number, number, number], aggregateFires = true): Promise<ReplayPointDeltaLayer> {
        const timingsMs: Record<string, number> = {};
        const sourceStart = performance.now();
        const source = await this.buildDbStateFeatures(layerId, at, bbox, aggregateFires);
        timingsMs.source = roundMs(performance.now() - sourceStart);

        const packStart = performance.now();
        const ids: string[] = [];
        const hashes: number[] = [];
        const styleIds: number[] = [];
        const familyCodes: number[] = [];
        const styles: Record<string, RenderStyle> = {};
        const sourceIds: Array<string | null> = [];
        const subtypes: Array<string | null> = [];
        const positions: number[] = [];
        const cartographic: number[] = [];
        const properties: number[] = [];

        for (let i = 0; i < source.features.length; i += 1) {
            const row = source.features[i] as any;
            const geometry = geometryForFeature(row);
            if (!geometry || geometry.type !== 'Point' || !isValidLonLat(geometry.coordinates)) continue;
            const lng = Number(geometry.coordinates[0]);
            const lat = Number(geometry.coordinates[1]);
            const alt = Number(row?.altitude_m ?? 0) || 0;
            const position = toEcef(lng, lat, alt);
            const feature = { ...row, layer_id: row?.layer_id || layerId };
            const id = featureId(feature, i);
            const styleId = styleIdFor(styleKey(feature));
            if (!styles[String(styleId)]) {
                styles[String(styleId)] = {
                    styleId,
                    layerId,
                    subtype: feature?.subtype || null,
                    sourceId: feature?.source_id || null,
                    variant: styleVariant(feature),
                    kindMask: 1,
                };
            }
            hashes.push(stableHash32(id));
            styleIds.push(styleId);
            familyCodes.push(featureFamilyCode(featureFamily(feature)));
            positions.push(position[0], position[1], position[2]);
            properties.push(
                finiteOrNaN(feature?.heading_deg),
                finiteOrNaN(feature?.speed_mps),
                alt,
                0,
            );
        }
        timingsMs.pack = roundMs(performance.now() - packStart);

        return {
            layerId,
            at,
            count: positions.length / 3,
            ids,
            hashes,
            styleIds,
            familyCodes,
            styles,
            sourceIds,
            subtypes,
            positions,
            cartographic,
            properties,
            timingsMs,
        };
    }

    async buildPointDeltas(params: BuildReplayPointDeltasParams): Promise<ReplayPointDeltasResponse> {
        const at = new Date(params.at).toISOString();
        const normalizedLayers = Array.from(new Set(params.layers.map(normalizeLayerId).filter(Boolean)));
        const pointDbLayers = new Set(['disasters', 'fire', 'outage', 'conflict']);
        const supported = normalizedLayers.filter((layerId) => layerId === 'aircraft' || layerId === 'vessel' || layerId === 'satellite' || pointDbLayers.has(layerId));
        const entries = await Promise.all(supported.map(async (layerId) => {
            const layer = layerId === 'satellite'
                ? await this.buildSatellitePointDelta(layerId, at, params.bbox)
                : (layerId === 'aircraft' || layerId === 'vessel')
                    ? await this.buildEntityPointDelta(layerId, at, params.bbox)
                    : await this.buildDbPointDelta(layerId, at, params.bbox, params.aggregateFires !== false);
            return [layerId, layer] as const;
        }));
        return {
            format: 'AWVPOINTDELTA1',
            version: 1,
            mode: 'replay',
            at,
            layers: Object.fromEntries(entries),
        };
    }

    async buildPointDeltaBinary(params: BuildReplayPointDeltasParams): Promise<ReplayPointDeltaBinary | null> {
        const normalizedLayers = Array.from(new Set(params.layers.map(normalizeLayerId).filter(Boolean)));
        if (normalizedLayers.length !== 1) return null;
        const response = await this.buildPointDeltas(params);
        const layerId = normalizedLayers[0];
        const layer = response.layers[layerId];
        if (!layer) return null;

        const stylesJson = Buffer.from(JSON.stringify(layer.styles || {}), 'utf8');
        const hashCount = layer.hashes.length;
        const styleIdCount = layer.styleIds.length;
        const familyCodeCount = layer.familyCodes.length;
        const positionCount = layer.positions.length;
        const propertyCount = layer.properties.length;
        const headerBytes = 36;
        const byteLength = headerBytes
            + hashCount * 4
            + styleIdCount * 4
            + familyCodeCount * 4
            + positionCount * 4
            + propertyCount * 4
            + stylesJson.length;
        const buffer = Buffer.allocUnsafe(byteLength);
        let offset = 0;
        buffer.write('AWPD', offset, 'ascii'); offset += 4;
        buffer.writeUInt32LE(2, offset); offset += 4;
        buffer.writeUInt32LE(layer.count, offset); offset += 4;
        buffer.writeUInt32LE(hashCount, offset); offset += 4;
        buffer.writeUInt32LE(styleIdCount, offset); offset += 4;
        buffer.writeUInt32LE(familyCodeCount, offset); offset += 4;
        buffer.writeUInt32LE(positionCount, offset); offset += 4;
        buffer.writeUInt32LE(propertyCount, offset); offset += 4;
        buffer.writeUInt32LE(stylesJson.length, offset); offset += 4;
        for (const value of layer.hashes) {
            buffer.writeUInt32LE((Number(value) >>> 0), offset);
            offset += 4;
        }
        for (const value of layer.styleIds) {
            buffer.writeUInt32LE((Number(value) >>> 0), offset);
            offset += 4;
        }
        for (const value of layer.familyCodes) {
            buffer.writeUInt32LE((Number(value) >>> 0), offset);
            offset += 4;
        }
        for (const value of layer.positions) {
            buffer.writeFloatLE(Number(value), offset);
            offset += 4;
        }
        for (const value of layer.properties) {
            buffer.writeFloatLE(Number(value), offset);
            offset += 4;
        }
        stylesJson.copy(buffer, offset);
        return {
            at: response.at,
            layerId,
            count: layer.count,
            buffer,
        };
    }

    async readChunkData(chunkId: string): Promise<{ manifest: ReplayRenderChunkManifest; buffer: Buffer } | null> {
        const manifest = await this.readCachedManifest(chunkId);
        if (!manifest) return null;
        const files = this.getFiles(chunkId);
        return {
            manifest,
            buffer: await fs.promises.readFile(files.dataPath),
        };
    }

    async readFeatureRefs(chunkId: string): Promise<{ manifest: ReplayRenderChunkManifest; features: RenderFeatureRef[] } | null> {
        const manifest = await this.readCachedManifest(chunkId);
        if (!manifest) return null;
        const files = this.getFiles(chunkId);
        if (!fs.existsSync(files.detailsPath)) return null;
        const parsed = JSON.parse(await fs.promises.readFile(files.detailsPath, 'utf8')) as { features?: RenderFeatureRef[] };
        return {
            manifest,
            features: parsed.features || [],
        };
    }

    async readFeatureMetadataAt(params: {
        at: string;
        layerId: string;
        family: RenderFeatureRef['family'];
        id?: string;
        hash?: number;
        sourceId?: string | null;
    }): Promise<RenderFeature | null> {
        const at = new Date(params.at).toISOString();
        const layerId = normalizeLayerId(params.layerId);
        if (!params.id && Number.isFinite(params.hash ?? NaN)) {
            const filters: ReplayStateFilters = {
                at,
                layerId,
                sourceId: params.sourceId || undefined,
            };
            let rows: any[] = [];
            if (params.family === 'entity') {
                rows = await this.replayQueryService.listEntityStateAt(filters);
            } else if (params.family === 'asset') {
                rows = await this.replayQueryService.listAssetStateAt(filters);
            } else {
                rows = await this.replayQueryService.listEventStateAt(filters);
            }
            const targetHash = Number(params.hash);
            const matched = rows.find((row, index) => {
                const feature = { ...row, layer_id: row?.layer_id || layerId };
                return stableHash32(featureId(feature, index)) === targetHash;
            });
            if (!matched) return null;
            const geometry = geometryForFeature(matched);
            const lng = Number(matched?.display_lng ?? geometry?.coordinates?.[0]);
            const lat = Number(matched?.display_lat ?? geometry?.coordinates?.[1]);
            const bbox: [number, number, number, number] = [
                Number.isFinite(lng) ? lng : 0,
                Number.isFinite(lat) ? lat : 0,
                Number.isFinite(lng) ? lng : 0,
                Number.isFinite(lat) ? lat : 0,
            ];
            return makeRenderFeature({ ...matched, layer_id: matched?.layer_id || layerId }, 0, bbox);
        }
        if (!params.id) return null;
        const ref: RenderFeatureRef = {
            featureIndex: 0,
            id: params.id,
            layerId,
            family: params.family,
            sourceId: params.sourceId || null,
            subtype: null,
            displayLat: null,
            displayLng: null,
            displayAlt: 0,
        };
        const detail = await this.loadFeatureDetails(ref, at).catch(() => null);
        if (!detail) return null;
        const lng = Number(detail?.display_lng);
        const lat = Number(detail?.display_lat);
        const bbox: [number, number, number, number] = [
            Number.isFinite(lng) ? lng : 0,
            Number.isFinite(lat) ? lat : 0,
            Number.isFinite(lng) ? lng : 0,
            Number.isFinite(lat) ? lat : 0,
        ];
        return makeRenderFeature(detail, 0, bbox);
    }

    private async loadFeatureDetails(ref: RenderFeatureRef, at: string): Promise<any | null> {
        const filters: ReplayStateFilters = {
            at,
            layerId: ref.layerId,
            sourceId: ref.sourceId || undefined,
        };
        if (ref.family === 'entity') {
            const rows = await this.replayQueryService.listEntityStateAt({
                ...filters,
                entityId: ref.id,
            });
            return rows[0] || null;
        }
        if (ref.family === 'asset') {
            const rows = await this.replayQueryService.listAssetStateAt({
                ...filters,
                assetId: ref.id,
            });
            return rows[0] || null;
        }
        if (ref.layerId === 'fire' && ref.id.startsWith('fire-cluster:')) {
            const rows = await this.replayQueryService.listEventStateAt({
                ...filters,
                aggregateFires: true,
            });
            return rows.find((row: any) => row.event_id === ref.id) || null;
        }
        const rows = await this.replayQueryService.listEventStateAt({
            ...filters,
            eventId: ref.id,
        });
        return rows[0] || null;
    }

    async readFeatureMetadata(chunkId: string, featureIndex: number): Promise<RenderFeature | null> {
        const manifest = await this.readCachedManifest(chunkId);
        if (!manifest) return null;
        const files = this.getFiles(chunkId);
        if (!fs.existsSync(files.detailsPath)) return null;
        const parsed = JSON.parse(await fs.promises.readFile(files.detailsPath, 'utf8')) as { features?: RenderFeatureRef[] };
        const ref = parsed.features?.[featureIndex] || null;
        if (!ref) return null;
        const detail = await this.loadFeatureDetails(ref, manifest.at).catch(() => null);
        if (!detail) {
            return {
                ...ref,
                name: ref.id,
                description: null,
                extra: {
                    featureId: ref.id,
                    featureFamily: ref.family,
                    detailsSource: 'render-ref',
                },
            };
        }
        const enrichedBbox: [number, number, number, number] = [
            ref.displayLng ?? 0,
            ref.displayLat ?? 0,
            ref.displayLng ?? 0,
            ref.displayLat ?? 0,
        ];
        return makeRenderFeature(detail, ref.featureIndex, enrichedBbox);
    }
}
