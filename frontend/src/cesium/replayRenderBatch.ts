import * as Cesium from 'cesium';
import axios from 'axios';
import { getAviIcon, getConflictIcon, getDisasterIcon, getMapIcon, getOutageIcon, getSatIcon, getShipIcon, svgUri } from '../icons/map-icons';
import { applyFastBillboardPosition, type SatelliteApplySlot } from './satelliteApplyManager';

export const REPLAY_RENDER_BATCH_ID_PREFIX = 'rb:';

type RenderStyle = {
    styleId: number;
    layerId: string;
    subtype: string | null;
    sourceId: string | null;
    variant?: string | null;
    kindMask: number;
};

type RenderSection = {
    type: 'uint32' | 'float32' | 'float64';
    itemSize: number;
    byteOffset: number;
    byteLength: number;
    length: number;
};

type RenderChunkManifest = {
    format: 'AWVBIN1';
    version: 1;
    mode: 'replay';
    chunkId: string;
    layerId: string;
    at: string;
    from: string;
    to: string;
    tBucket: string;
    bbox: [number, number, number, number];
    dataUrl: string;
    detailsUrl: string;
    counts: {
        features: number;
        pointVertices: number;
        lineVertices: number;
        fillVertices: number;
        fillIndices: number;
        tracks?: number;
        trackSamples?: number;
        footprints?: number;
    };
    bytes: {
        binary: number;
        source: number;
    };
    sections: Record<string, RenderSection>;
    styles: Record<string, RenderStyle>;
    footprints?: RenderBatchFootprintManifest[];
    timingsMs?: Record<string, number>;
};

type RenderChunksResponse = {
    format: 'AWVBIN1';
    version: 1;
    mode: 'replay';
    at: string;
    from: string;
    to: string;
    layers: Record<string, RenderChunkManifest[]>;
};

type RenderFeatureMetadata = {
    featureIndex: number;
    id: string;
    layerId: string;
    family: 'entity' | 'event' | 'asset';
    sourceId: string | null;
    subtype: string | null;
    name: string;
    displayLat: number | null;
    displayLng: number | null;
    displayAlt: number;
    speedMps?: number | null;
    headingDeg?: number | null;
    description?: string | null;
    extra?: Record<string, any>;
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

type RenderFeatureRefsResponse = {
    chunkId: string;
    at: string;
    layerId: string;
    features: RenderFeatureRef[];
};

type NumericVector = number[] | Float32Array | Uint32Array;

type PointDeltaLayer = {
    layerId: string;
    at: string;
    count: number;
    ids: string[];
    hashes: number[] | Uint32Array;
    styleIds: number[] | Uint32Array;
    familyCodes: number[] | Uint32Array;
    styles: Record<string, RenderStyle>;
    sourceIds: Array<string | null>;
    subtypes: Array<string | null>;
    positions: NumericVector;
    cartographic: NumericVector;
    properties: NumericVector;
    timingsMs?: Record<string, number>;
};

type PointDeltaResponse = {
    format: 'AWVPOINTDELTA1';
    version: 1;
    mode: 'replay';
    at: string;
    layers: Record<string, PointDeltaLayer>;
};

type RenderBatchFootprintManifest = {
    featureIndex: number;
    radiusMeters: number;
    sensorName: string;
    sensorType: 'OPTICAL' | 'SAR' | 'OTHER';
    source: string;
};

export type ReplayRenderBatchMotionTrack = {
    targetId: string;
    sampleAtMs: Float64Array;
    samplePositions: Float32Array;
};

export type ReplayRenderBatchFootprint = {
    satId: string;
    footprintId: string;
    radiusMeters: number;
    baseColor: Cesium.Color;
    meta: {
        parentSatId: string;
        satName: string;
        subtype: string;
        sensorName: string;
        sensorType: 'OPTICAL' | 'SAR' | 'OTHER';
        swathMeters: number;
        source: string;
    };
};

export type RenderBatchReplayMeta = {
    id: string;
    name: string;
    layer: string;
    layerId: string;
    subtype?: string | null;
    source?: string | null;
    lat: number;
    lng: number;
    alt: number;
    speed?: number | null;
    heading?: number | null;
    description?: string;
    extra?: Record<string, any>;
    renderBatch?: {
        chunkId: string;
        featureIndex: number;
        detailsLoaded: boolean;
        atIso?: string;
    };
};

type ParsedRenderId = {
    chunkId: string;
    featureIndex: number;
    deltaLayerId?: string;
    featureHash?: number;
};

type DecodedChunk = {
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
};

type LayerRenderState = {
    pointCollections: Cesium.BillboardCollection[];
    primitives: Array<Cesium.Primitive>;
    pointSlotsByFeatureId: Map<string, SatelliteApplySlot>;
    pickIdByFeatureId: Map<string, string>;
    featureIdByPickId: Map<string, string>;
    pointSlotsByFeatureHash: Map<number, SatelliteApplySlot>;
    pickIdByFeatureHash: Map<number, string>;
    pointSlotsByFeatureIndex: Map<number, SatelliteApplySlot>;
    pickIdByFeatureIndex: Map<number, string>;
    pointCount: number;
    shapeCount: number;
    featureCount: number;
    motionTrackCount: number;
    footprintCount: number;
};

export type ReplayRenderBatchDeltaResult = {
    applied: boolean;
    layerId: string;
    atIso: string;
    count: number;
    updated: number;
    added: number;
    missing: number;
    stale: number;
    needsFullSync: boolean;
    ms: number;
};

type ApplyLayerOptions = {
    layerId: string;
    atIso: string;
    fromIso?: string;
    toIso?: string;
    aggregateFires?: boolean;
    isCancelled?: () => boolean;
    beforeCommit?: () => void;
};

export type ReplayRenderBatchApplyResult = {
    applied: boolean;
    layerId: string;
    featureCount: number;
    pointCount: number;
    shapeCount: number;
    bytes: number;
    motionTracks: ReplayRenderBatchMotionTrack[];
    footprints: ReplayRenderBatchFootprint[];
};

export type RenderBatchVisibilityResolver = (
    targetId: string,
    layerId: string,
    subtype: string | null | undefined,
    sourceId: string | null | undefined,
) => boolean;

export const replayRenderBatchMetaMap = new Map<string, RenderBatchReplayMeta>();

function makeRenderId(chunkId: string, featureIndex: number): string {
    return `${REPLAY_RENDER_BATCH_ID_PREFIX}${chunkId}:${featureIndex}`;
}

function makeDeltaRenderId(layerId: string, featureHash: number): string {
    return `${REPLAY_RENDER_BATCH_ID_PREFIX}delta:${layerId}:${featureHash}`;
}

export function isReplayRenderBatchId(id: unknown): id is string {
    return typeof id === 'string' && id.startsWith(REPLAY_RENDER_BATCH_ID_PREFIX);
}

function parseRenderBatchId(id: string): ParsedRenderId | null {
    if (!isReplayRenderBatchId(id)) return null;
    const body = id.slice(REPLAY_RENDER_BATCH_ID_PREFIX.length);
    if (body.startsWith('delta:')) {
        const [, layerId, hashRaw] = body.split(':');
        const featureHash = Number(hashRaw);
        if (!layerId || !Number.isFinite(featureHash)) return null;
        return {
            chunkId: `delta:${layerId}`,
            featureIndex: -1,
            deltaLayerId: layerId,
            featureHash,
        };
    }
    const splitAt = body.lastIndexOf(':');
    if (splitAt <= 0) return null;
    const chunkId = body.slice(0, splitAt);
    const featureIndex = Number(body.slice(splitAt + 1));
    if (!chunkId || !Number.isInteger(featureIndex) || featureIndex < 0) return null;
    return { chunkId, featureIndex };
}

function absoluteApiUrl(apiUrl: string, pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${apiUrl.replace(/\/$/, '')}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
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

function familyFromCode(code: number | undefined, layerId: string): RenderFeatureRef['family'] {
    if (code === 1) return 'entity';
    if (code === 2) return 'event';
    if (code === 3) return 'asset';
    return layerId === 'aircraft' || layerId === 'vessel' || layerId === 'satellite' ? 'entity' : 'event';
}

function decodePointDeltaBinary(buffer: ArrayBuffer, layerId: string, atIso: string): PointDeltaLayer {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 32) throw new Error('Point delta binary payload is too small');
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'AWPD') throw new Error(`Invalid point delta magic: ${magic}`);
    const view = new DataView(buffer);
    const version = view.getUint32(4, true);
    if (version !== 2) throw new Error(`Unsupported point delta version: ${version}`);
    const count = view.getUint32(8, true);
    const hashCount = view.getUint32(12, true);
    const styleIdCount = view.getUint32(16, true);
    const familyCodeCount = view.getUint32(20, true);
    const positionCount = view.getUint32(24, true);
    const propertyCount = view.getUint32(28, true);
    const stylesBytes = view.getUint32(32, true);
    let offset = 36;
    const hashes = hashCount > 0 ? new Uint32Array(buffer, offset, hashCount) : new Uint32Array(0);
    offset += hashCount * 4;
    const styleIds = styleIdCount > 0 ? new Uint32Array(buffer, offset, styleIdCount) : new Uint32Array(0);
    offset += styleIdCount * 4;
    const familyCodes = familyCodeCount > 0 ? new Uint32Array(buffer, offset, familyCodeCount) : new Uint32Array(0);
    offset += familyCodeCount * 4;
    const positions = positionCount > 0 ? new Float32Array(buffer, offset, positionCount) : new Float32Array(0);
    offset += positionCount * 4;
    const properties = propertyCount > 0 ? new Float32Array(buffer, offset, propertyCount) : new Float32Array(0);
    offset += propertyCount * 4;
    if (offset + stylesBytes > bytes.length) throw new Error('Point delta styles section exceeds payload length');
    const stylesJson = stylesBytes > 0 ? new TextDecoder().decode(bytes.subarray(offset, offset + stylesBytes)) : '{}';
    let styles: Record<string, RenderStyle> = {};
    try {
        styles = JSON.parse(stylesJson) as Record<string, RenderStyle>;
    } catch {
        styles = {};
    }
    return {
        layerId,
        at: atIso,
        count,
        ids: [],
        hashes,
        styleIds,
        familyCodes,
        styles,
        sourceIds: [],
        subtypes: [],
        positions,
        cartographic: [],
        properties,
    };
}

function toHudLayerName(layerId: string): string {
    switch (layerId) {
        case 'aircraft': return 'Aircraft';
        case 'vessel': return 'Vessel';
        case 'satellite': return 'Satellite';
        case 'disasters': return 'Disaster';
        case 'fire': return 'Fire';
        case 'jamming': return 'Jamming';
        case 'cable': return 'Cable';
        case 'pipeline': return 'Pipeline';
        case 'outage': return 'Outage';
        case 'conflict': return 'Conflict';
        case 'airspace': return 'Airspace';
        case 'gfw': return 'GFW';
        default: return layerId;
    }
}

const REPLAY_POINT_ICON_DEFAULT = svgUri('<circle cx="12" cy="12" r="7" fill="#38bdf8"/>');
const REPLAY_JAM_HIGH = svgUri('<circle cx="12" cy="12" r="7" fill="#ef4444"/>');
const REPLAY_JAM_MEDIUM = svgUri('<circle cx="12" cy="12" r="7" fill="#f97316"/>');
const REPLAY_JAM_LOW = svgUri('<circle cx="12" cy="12" r="7" fill="#eab308"/>');
const POINT_DELTA_LAYER_IDS = new Set(['aircraft', 'vessel', 'satellite', 'disasters', 'fire', 'outage', 'conflict']);

const LAYER_COLORS: Record<string, Cesium.Color> = {
    aircraft: Cesium.Color.fromCssColorString('#38bdf8'),
    vessel: Cesium.Color.fromCssColorString('#22d3ee'),
    satellite: Cesium.Color.fromCssColorString('#a3e635'),
    disasters: Cesium.Color.fromCssColorString('#facc15'),
    fire: Cesium.Color.fromCssColorString('#f97316'),
    outage: Cesium.Color.fromCssColorString('#a855f7'),
    jamming: Cesium.Color.fromCssColorString('#fb7185'),
    gfw: Cesium.Color.fromCssColorString('#34d399'),
    conflict: Cesium.Color.fromCssColorString('#ef4444'),
    cable: Cesium.Color.fromCssColorString('#38bdf8'),
    pipeline: Cesium.Color.fromCssColorString('#f59e0b'),
    airspace: Cesium.Color.fromCssColorString('#60a5fa'),
};

function colorForLayer(layerId: string, alpha: number): Cesium.Color {
    const base = LAYER_COLORS[layerId] || Cesium.Color.CYAN;
    return Cesium.Color.fromAlpha(base, alpha);
}

function jammingColor(subtype: string | null | undefined, alpha: number): Cesium.Color {
    if (subtype === 'high') return Cesium.Color.fromAlpha(Cesium.Color.fromCssColorString('#ef4444'), alpha);
    if (subtype === 'low') return Cesium.Color.fromAlpha(Cesium.Color.fromCssColorString('#eab308'), alpha);
    return Cesium.Color.fromAlpha(Cesium.Color.fromCssColorString('#f97316'), alpha);
}

function colorForStyle(layerId: string, subtype: string | null | undefined, alpha: number): Cesium.Color {
    if (layerId === 'jamming') return jammingColor(subtype, alpha);
    return colorForLayer(layerId, alpha);
}

function pointIconForStyle(layerId: string, style: RenderStyle | undefined): string {
    const subtype = style?.subtype || undefined;
    const variant = style?.variant || undefined;
    if (layerId === 'aircraft') return getAviIcon(subtype || 'general');
    if (layerId === 'vessel') return getShipIcon(subtype || 'unknown');
    if (layerId === 'satellite') return getSatIcon(subtype || 'civilian', variant === 'recon' || subtype === 'recon');
    if (layerId === 'disasters') return getDisasterIcon(subtype || 'XX', variant || 'Green');
    if (layerId === 'conflict') return getConflictIcon(variant || subtype || 'violence');
    if (layerId === 'outage') return getOutageIcon(subtype || 'warning');
    if (layerId === 'fire') return getMapIcon('fires', subtype || 'high') || REPLAY_POINT_ICON_DEFAULT;
    if (layerId === 'gfw') return getMapIcon('gfw', 'default') || REPLAY_POINT_ICON_DEFAULT;
    if (layerId === 'jamming') {
        if (subtype === 'high') return REPLAY_JAM_HIGH;
        if (subtype === 'low') return REPLAY_JAM_LOW;
        return REPLAY_JAM_MEDIUM;
    }
    return REPLAY_POINT_ICON_DEFAULT;
}

function baseColorForSatellite(subtype: string | null | undefined): Cesium.Color {
    if (subtype === 'military' || subtype === 'recon') return Cesium.Color.RED;
    if (subtype === 'commercial') return Cesium.Color.CYAN;
    return Cesium.Color.LIME;
}

function pointScaleForLayer(layerId: string): number {
    if (layerId === 'satellite') return 1.35;
    if (layerId === 'aircraft') return 1.0;
    if (layerId === 'vessel') return 1.05;
    return 1.1;
}

function pointScaleForStyle(layerId: string, style: RenderStyle | undefined): number {
    if (layerId === 'satellite' && (style?.variant === 'recon' || style?.subtype === 'recon')) return 1.8;
    return pointScaleForLayer(layerId);
}

function getSection<T extends Uint32Array | Float32Array>(
    buffer: ArrayBuffer,
    sections: Record<string, RenderSection>,
    name: string,
    expectedType: 'uint32' | 'float32',
): T {
    const section = sections[name];
    if (!section || section.type !== expectedType) {
        throw new Error(`Render chunk missing ${name}`);
    }
    if (expectedType === 'uint32') {
        return new Uint32Array(buffer, section.byteOffset, section.length) as T;
    }
    return new Float32Array(buffer, section.byteOffset, section.length) as T;
}

function getOptionalSection<T extends Uint32Array | Float32Array | Float64Array>(
    buffer: ArrayBuffer,
    sections: Record<string, RenderSection>,
    name: string,
    expectedType: 'uint32' | 'float32' | 'float64',
): T {
    const section = sections[name];
    if (!section || section.length === 0) {
        if (expectedType === 'uint32') return new Uint32Array(0) as T;
        if (expectedType === 'float64') return new Float64Array(0) as T;
        return new Float32Array(0) as T;
    }
    if (section.type !== expectedType) throw new Error(`Render chunk section ${name} has invalid type`);
    if (expectedType === 'uint32') return new Uint32Array(buffer, section.byteOffset, section.length) as T;
    if (expectedType === 'float64') return new Float64Array(buffer, section.byteOffset, section.length) as T;
    return new Float32Array(buffer, section.byteOffset, section.length) as T;
}

function validateMagic(buffer: ArrayBuffer): void {
    const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
    const magic = Array.from(bytes).map((value) => String.fromCharCode(value)).join('');
    if (magic !== 'AWVBIN1\0') throw new Error('Invalid render chunk magic');
}

function decodeChunk(buffer: ArrayBuffer, manifest: RenderChunkManifest): DecodedChunk {
    validateMagic(buffer);
    return {
        featureTable: getSection<Uint32Array>(buffer, manifest.sections, 'featureTable', 'uint32'),
        featureBboxes: getSection<Float32Array>(buffer, manifest.sections, 'featureBboxes', 'float32'),
        featureProperties: getOptionalSection<Float32Array>(buffer, manifest.sections, 'featureProperties', 'float32'),
        pointPositions: getSection<Float32Array>(buffer, manifest.sections, 'pointPositions', 'float32'),
        pointFeatureIndices: getSection<Uint32Array>(buffer, manifest.sections, 'pointFeatureIndices', 'uint32'),
        linePositions: getSection<Float32Array>(buffer, manifest.sections, 'linePositions', 'float32'),
        lineFeatureIndices: getSection<Uint32Array>(buffer, manifest.sections, 'lineFeatureIndices', 'uint32'),
        fillPositions: getSection<Float32Array>(buffer, manifest.sections, 'fillPositions', 'float32'),
        fillIndices: getSection<Uint32Array>(buffer, manifest.sections, 'fillIndices', 'uint32'),
        fillFeatureIndices: getSection<Uint32Array>(buffer, manifest.sections, 'fillFeatureIndices', 'uint32'),
        trackRows: getOptionalSection<Uint32Array>(buffer, manifest.sections, 'trackRows', 'uint32'),
        trackSampleTimes: getOptionalSection<Float64Array>(buffer, manifest.sections, 'trackSampleTimes', 'float64'),
        trackSamplePositions: getOptionalSection<Float32Array>(buffer, manifest.sections, 'trackSamplePositions', 'float32'),
    };
}

function getFeatureProperties(decoded: DecodedChunk, featureIndex: number): {
    headingDeg: number | null;
    speedMps: number | null;
    altitude: number;
    extrusionHeight: number;
} {
    const offset = featureIndex * 4;
    if (decoded.featureProperties.length < offset + 4) {
        return { headingDeg: null, speedMps: null, altitude: 0, extrusionHeight: 0 };
    }
    const headingDeg = decoded.featureProperties[offset];
    const speedMps = decoded.featureProperties[offset + 1];
    const altitude = decoded.featureProperties[offset + 2];
    const extrusionHeight = decoded.featureProperties[offset + 3];
    return {
        headingDeg: Number.isFinite(headingDeg) ? headingDeg : null,
        speedMps: Number.isFinite(speedMps) ? speedMps : null,
        altitude: Number.isFinite(altitude) ? altitude : 0,
        extrusionHeight: Number.isFinite(extrusionHeight) ? extrusionHeight : 0,
    };
}

function getFeatureRow(table: Uint32Array, rowIndex: number): {
    featureIndex: number;
    kind: number;
    pointStart: number;
    pointCount: number;
    lineStart: number;
    lineVertexCount: number;
    fillStart: number;
    fillVertexCount: number;
    indexStart: number;
    indexCount: number;
    styleId: number;
} {
    const offset = rowIndex * 12;
    return {
        featureIndex: table[offset],
        kind: table[offset + 1],
        pointStart: table[offset + 2],
        pointCount: table[offset + 3],
        lineStart: table[offset + 4],
        lineVertexCount: table[offset + 5],
        fillStart: table[offset + 6],
        fillVertexCount: table[offset + 7],
        indexStart: table[offset + 8],
        indexCount: table[offset + 9],
        styleId: table[offset + 10],
    };
}

function metaFromFeature(feature: RenderFeatureMetadata, pickId: string, parsed: ParsedRenderId): RenderBatchReplayMeta {
    return {
        id: pickId,
        name: feature.name || feature.id || pickId,
        layer: toHudLayerName(feature.layerId),
        layerId: feature.layerId,
        subtype: feature.subtype,
        source: feature.sourceId,
        lat: Number(feature.displayLat ?? 0),
        lng: Number(feature.displayLng ?? 0),
        alt: Number(feature.displayAlt ?? 0) || 0,
        speed: feature.speedMps ?? null,
        heading: feature.headingDeg ?? null,
        description: feature.description || undefined,
        extra: {
            ...(feature.extra || {}),
            featureId: feature.id,
            featureFamily: feature.family,
        },
        renderBatch: {
            chunkId: parsed.chunkId,
            featureIndex: parsed.featureIndex,
            detailsLoaded: true,
            atIso: feature.extra?.renderAtIso,
        },
    };
}

export async function fetchReplayRenderBatchMetadata(apiUrl: string, pickId: string): Promise<RenderBatchReplayMeta | null> {
    const parsed = parseRenderBatchId(pickId);
    if (!parsed) return null;
    const existing = replayRenderBatchMetaMap.get(pickId);
    if (existing?.renderBatch?.detailsLoaded) return existing;
    const featureId = existing?.extra?.featureId;
    const featureFamily = existing?.extra?.featureFamily;
    const featureHash = existing?.extra?.featureHash ?? parsed.featureHash;
    const atIso = existing?.renderBatch?.atIso;
    const response = (featureId || Number.isFinite(Number(featureHash))) && featureFamily && atIso
        ? await axios.get<RenderFeatureMetadata>(
            absoluteApiUrl(
                apiUrl,
                `/api/replay/render-feature?${new URLSearchParams({
                    at: atIso,
                    layerId: existing.layerId,
                    family: String(featureFamily),
                    ...(featureId ? { id: String(featureId) } : { hash: String(featureHash) }),
                    ...(existing.source ? { sourceId: existing.source } : {}),
                }).toString()}`,
            ),
        )
        : await axios.get<RenderFeatureMetadata>(
            absoluteApiUrl(apiUrl, `/api/replay/render-chunks/${parsed.chunkId}/features/${parsed.featureIndex}`),
        );
    const meta = metaFromFeature(response.data, pickId, parsed);
    if (atIso && meta.renderBatch) meta.renderBatch.atIso = atIso;
    replayRenderBatchMetaMap.set(pickId, meta);
    return meta;
}

export function clearReplayRenderBatchMetadata(): void {
    replayRenderBatchMetaMap.clear();
}

export class ReplayRenderBatchManager {
    private readonly scene: Cesium.Scene;
    private readonly apiUrl: string;
    private resolveVisible: RenderBatchVisibilityResolver;
    private readonly onPointAdd?: (id: string, billboard: Cesium.Billboard) => void;
    private readonly onPointRemove?: (id: string) => void;
    private readonly layerStates = new Map<string, LayerRenderState>();

    constructor(options: {
        scene: Cesium.Scene;
        apiUrl: string;
        resolveVisible: RenderBatchVisibilityResolver;
        onPointAdd?: (id: string, billboard: Cesium.Billboard) => void;
        onPointRemove?: (id: string) => void;
    }) {
        this.scene = options.scene;
        this.apiUrl = options.apiUrl;
        this.resolveVisible = options.resolveVisible;
        this.onPointAdd = options.onPointAdd;
        this.onPointRemove = options.onPointRemove;
    }

    setVisibilityResolver(resolveVisible: RenderBatchVisibilityResolver): void {
        this.resolveVisible = resolveVisible;
    }

    clearAll(): void {
        for (const layerId of Array.from(this.layerStates.keys())) {
            this.clearLayer(layerId);
        }
        clearReplayRenderBatchMetadata();
    }

    clearLayer(layerId: string): void {
        const state = this.layerStates.get(layerId);
        if (!state) return;
        for (const collection of state.pointCollections) {
            try { this.scene.primitives.remove(collection); } catch {}
        }
        for (const primitive of state.primitives) {
            try { this.scene.primitives.remove(primitive); } catch {}
        }
        this.layerStates.delete(layerId);
        for (const id of Array.from(replayRenderBatchMetaMap.keys())) {
            const meta = replayRenderBatchMetaMap.get(id);
            if (meta?.layerId === layerId) {
                replayRenderBatchMetaMap.delete(id);
                this.onPointRemove?.(id);
            }
        }
        this.scene.requestRender();
    }

    destroy(): void {
        this.clearAll();
    }

    getLayerCounts(layerId: string): { features: number; points: number; shapes: number } {
        const state = this.layerStates.get(layerId);
        return {
            features: state?.featureCount || 0,
            points: state?.pointCount || 0,
            shapes: state?.shapeCount || 0,
        };
    }

    getTotals(): { features: number; points: number; shapes: number; layerCounts: Record<string, number> } {
        let features = 0;
        let points = 0;
        let shapes = 0;
        const layerCounts: Record<string, number> = {};
        this.layerStates.forEach((state, layerId) => {
            features += state.featureCount;
            points += state.pointCount;
            shapes += state.shapeCount;
            layerCounts[layerId] = state.featureCount;
        });
        return { features, points, shapes, layerCounts };
    }

    async applyLayer(options: ApplyLayerOptions): Promise<ReplayRenderBatchApplyResult> {
        const isCancelled = options.isCancelled || (() => false);
        const params = new URLSearchParams({
            at: options.atIso,
            from: options.fromIso || options.atIso,
            to: options.toIso || options.atIso,
            layers: options.layerId,
            z: '0',
        });
        if (options.layerId === 'fire' && options.aggregateFires === false) params.set('cluster', '0');
        const manifestResponse = await axios.get<RenderChunksResponse>(
            absoluteApiUrl(this.apiUrl, `/api/replay/render-chunks?${params.toString()}`),
        );
        const chunks = manifestResponse.data.layers[options.layerId] || [];
        const decoded: Array<{ manifest: RenderChunkManifest; data: DecodedChunk; refs: RenderFeatureRef[] }> = [];
        let bytes = 0;
        for (const chunk of chunks) {
            if (isCancelled()) {
                return { applied: false, layerId: options.layerId, featureCount: 0, pointCount: 0, shapeCount: 0, bytes, motionTracks: [], footprints: [] };
            }
            const shouldFetchRefs = POINT_DELTA_LAYER_IDS.has(options.layerId);
            const [response, refsResponse] = await Promise.all([
                axios.get<ArrayBuffer>(absoluteApiUrl(this.apiUrl, chunk.dataUrl), {
                    responseType: 'arraybuffer',
                }),
                shouldFetchRefs
                    ? axios.get<RenderFeatureRefsResponse>(absoluteApiUrl(this.apiUrl, chunk.detailsUrl))
                    : Promise.resolve({
                        data: {
                            chunkId: chunk.chunkId,
                            at: chunk.at,
                            layerId: chunk.layerId,
                            features: [],
                        } satisfies RenderFeatureRefsResponse,
                    }),
            ]);
            const buffer = response.data;
            bytes += buffer.byteLength;
            decoded.push({ manifest: chunk, data: decodeChunk(buffer, chunk), refs: refsResponse.data.features || [] });
        }
        if (isCancelled()) {
            return { applied: false, layerId: options.layerId, featureCount: 0, pointCount: 0, shapeCount: 0, bytes, motionTracks: [], footprints: [] };
        }

        options.beforeCommit?.();
        this.clearLayer(options.layerId);
        let pointCount = 0;
        let shapeCount = 0;
        let featureCount = 0;
        let motionTrackCount = 0;
        let footprintCount = 0;
        const pointCollections: Cesium.BillboardCollection[] = [];
        const primitives: Cesium.Primitive[] = [];
        const motionTracks: ReplayRenderBatchMotionTrack[] = [];
        const footprints: ReplayRenderBatchFootprint[] = [];
        const pointSlotsByFeatureId = new Map<string, SatelliteApplySlot>();
        const pickIdByFeatureId = new Map<string, string>();
        const featureIdByPickId = new Map<string, string>();
        const pointSlotsByFeatureHash = new Map<number, SatelliteApplySlot>();
        const pickIdByFeatureHash = new Map<number, string>();
        const pointSlotsByFeatureIndex = new Map<number, SatelliteApplySlot>();
        const pickIdByFeatureIndex = new Map<number, string>();

        for (const item of decoded) {
            const rendered = this.renderChunk(item.manifest, item.data, item.refs);
            pointCollections.push(...rendered.pointCollections);
            primitives.push(...rendered.primitives);
            rendered.pointSlotsByFeatureId.forEach((slot, featureId) => pointSlotsByFeatureId.set(featureId, slot));
            rendered.pickIdByFeatureId.forEach((pickId, featureId) => pickIdByFeatureId.set(featureId, pickId));
            rendered.featureIdByPickId.forEach((featureId, pickId) => featureIdByPickId.set(pickId, featureId));
            rendered.pointSlotsByFeatureHash.forEach((slot, hash) => pointSlotsByFeatureHash.set(hash, slot));
            rendered.pickIdByFeatureHash.forEach((pickId, hash) => pickIdByFeatureHash.set(hash, pickId));
            rendered.pointSlotsByFeatureIndex.forEach((slot, featureIndex) => pointSlotsByFeatureIndex.set(featureIndex, slot));
            rendered.pickIdByFeatureIndex.forEach((pickId, featureIndex) => pickIdByFeatureIndex.set(featureIndex, pickId));
            pointCount += rendered.pointCount;
            shapeCount += rendered.shapeCount;
            featureCount += rendered.featureCount;
            motionTrackCount += rendered.motionTracks.length;
            footprintCount += rendered.footprints.length;
            motionTracks.push(...rendered.motionTracks);
            footprints.push(...rendered.footprints);
        }

        this.layerStates.set(options.layerId, {
            pointCollections,
            primitives,
            pointSlotsByFeatureId,
            pickIdByFeatureId,
            featureIdByPickId,
            pointSlotsByFeatureHash,
            pickIdByFeatureHash,
            pointSlotsByFeatureIndex,
            pickIdByFeatureIndex,
            pointCount,
            shapeCount,
            featureCount,
            motionTrackCount,
            footprintCount,
        });
        this.scene.requestRender();
        return {
            applied: true,
            layerId: options.layerId,
            featureCount,
            pointCount,
            shapeCount,
            bytes,
            motionTracks,
            footprints,
        };
    }

    private removePointSlot(state: LayerRenderState, pickId: string, slot: SatelliteApplySlot): void {
        for (const collection of state.pointCollections) {
            try {
                if (collection.remove(slot.billboard)) break;
            } catch {}
        }
        state.pointSlotsByFeatureId.forEach((candidate, featureId) => {
            if (candidate.targetId === pickId) state.pointSlotsByFeatureId.delete(featureId);
        });
        state.pickIdByFeatureId.forEach((candidatePickId, featureId) => {
            if (candidatePickId === pickId) state.pickIdByFeatureId.delete(featureId);
        });
        state.featureIdByPickId.delete(pickId);
        state.pointSlotsByFeatureHash.forEach((candidate, hash) => {
            if (candidate.targetId === pickId) state.pointSlotsByFeatureHash.delete(hash);
        });
        state.pickIdByFeatureHash.forEach((candidatePickId, hash) => {
            if (candidatePickId === pickId) state.pickIdByFeatureHash.delete(hash);
        });
        state.pointSlotsByFeatureIndex.forEach((candidate, featureIndex) => {
            if (candidate.targetId === pickId) state.pointSlotsByFeatureIndex.delete(featureIndex);
        });
        state.pickIdByFeatureIndex.forEach((candidatePickId, featureIndex) => {
            if (candidatePickId === pickId) state.pickIdByFeatureIndex.delete(featureIndex);
        });
        replayRenderBatchMetaMap.delete(pickId);
        this.onPointRemove?.(pickId);
    }

    private ensurePointCollection(state: LayerRenderState): Cesium.BillboardCollection {
        let collection = state.pointCollections[0];
        if (!collection) {
            collection = new Cesium.BillboardCollection({
                scene: this.scene,
                blendOption: Cesium.BlendOption.TRANSLUCENT,
            });
            this.scene.primitives.add(collection);
            state.pointCollections.push(collection);
        }
        return collection;
    }

    async applyPointDelta(options: {
        layerId: string;
        atIso: string;
        aggregateFires?: boolean;
        isCancelled?: () => boolean;
    }): Promise<ReplayRenderBatchDeltaResult> {
        const t0 = performance.now();
        const isCancelled = options.isCancelled || (() => false);
        const state = this.layerStates.get(options.layerId);
        if (!state || (state.pointSlotsByFeatureId.size === 0 && state.pointSlotsByFeatureHash.size === 0 && state.pointSlotsByFeatureIndex.size === 0)) {
            return {
                applied: false,
                layerId: options.layerId,
                atIso: options.atIso,
                count: 0,
                updated: 0,
                added: 0,
                missing: 0,
                stale: 0,
                needsFullSync: true,
                ms: Math.round(performance.now() - t0),
            };
        }

        const params = new URLSearchParams({
            at: options.atIso,
            layers: options.layerId,
            format: 'bin',
        });
        if (options.layerId === 'fire' && options.aggregateFires === false) params.set('cluster', '0');
        const response = await axios.get<ArrayBuffer>(
            absoluteApiUrl(this.apiUrl, `/api/replay/render-point-deltas?${params.toString()}`),
            { responseType: 'arraybuffer' },
        );
        if (isCancelled()) {
            return {
                applied: false,
                layerId: options.layerId,
                atIso: options.atIso,
                count: 0,
                updated: 0,
                added: 0,
                missing: 0,
                stale: 0,
                needsFullSync: false,
                ms: Math.round(performance.now() - t0),
            };
        }
        const layer = decodePointDeltaBinary(response.data, options.layerId, options.atIso);
        if (!layer || layer.layerId !== options.layerId) {
            return {
                applied: false,
                layerId: options.layerId,
                atIso: options.atIso,
                count: 0,
                updated: 0,
                added: 0,
                missing: 0,
                stale: 0,
                needsFullSync: true,
                ms: Math.round(performance.now() - t0),
            };
        }

        const seen = new Set<string>();
        const seenHashes = new Set<number>();
        const seenIndexes = new Set<number>();
        let updated = 0;
        let missing = 0;
        let added = 0;
        const rowCount = layer.ids.length > 0 ? layer.ids.length : (layer.hashes.length > 0 ? layer.hashes.length : layer.count);
        for (let i = 0; i < rowCount; i += 1) {
            const featureId = layer.ids[i] || '';
            const featureHash = layer.hashes[i];
            const byIndex = !featureId && options.layerId === 'satellite';
            const byHash = !featureId && !byIndex && Number.isFinite(featureHash);
            const styleId = layer.styleIds[i];
            const style = Number.isFinite(styleId) ? layer.styles?.[String(styleId)] : undefined;
            const featureFamily = familyFromCode(layer.familyCodes[i], options.layerId);
            if (featureId) seen.add(featureId);
            if (byHash) seenHashes.add(featureHash);
            if (byIndex) seenIndexes.add(i);
            let slot = byIndex
                ? state.pointSlotsByFeatureIndex.get(i)
                : byHash
                    ? state.pointSlotsByFeatureHash.get(featureHash)
                    : state.pointSlotsByFeatureId.get(featureId);
            let pickId = byIndex
                ? state.pickIdByFeatureIndex.get(i)
                : byHash
                    ? state.pickIdByFeatureHash.get(featureHash)
                    : state.pickIdByFeatureId.get(featureId);
            const positionOffset = i * 3;
            const x = layer.positions[positionOffset];
            const y = layer.positions[positionOffset + 1];
            const z = layer.positions[positionOffset + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            const subtype = layer.subtypes[i] ?? style?.subtype ?? null;
            const sourceId = layer.sourceIds[i] ?? style?.sourceId ?? null;
            const propOffset = i * 4;
            const heading = layer.properties[propOffset];
            const speed = layer.properties[propOffset + 1];
            const altitude = layer.properties[propOffset + 2];
            const cartoOffset = i * 3;
            const lng = layer.cartographic[cartoOffset];
            const lat = layer.cartographic[cartoOffset + 1];
            const alt = layer.cartographic[cartoOffset + 2];
            if (!slot || !pickId) {
                if (byIndex || (!featureId && !byHash)) {
                    missing += 1;
                    continue;
                }
                const hash = byHash ? featureHash : stableHash32(featureId);
                pickId = makeDeltaRenderId(options.layerId, hash);
                const collection = this.ensurePointCollection(state);
                const icon = pointIconForStyle(options.layerId, style);
                const scale = pointScaleForStyle(options.layerId, style);
                const rotation = Number.isFinite(heading) ? Cesium.Math.toRadians(-heading) : 0;
                const visible = this.resolveVisible(pickId, options.layerId, subtype, sourceId);
                const billboard = collection.add({
                    id: pickId,
                    position: new Cesium.Cartesian3(x, y, z),
                    image: icon,
                    scale,
                    rotation,
                    ...(options.layerId === 'vessel' ? { alignedAxis: Cesium.Cartesian3.UNIT_Z } : {}),
                    show: visible,
                });
                slot = {
                    index: state.pointCount + added,
                    targetId: pickId,
                    billboard,
                    scratch: new Cesium.Cartesian3(x, y, z),
                    getVisible: () => this.resolveVisible(pickId!, options.layerId, subtype, sourceId),
                };
                if (featureId) {
                    state.pointSlotsByFeatureId.set(featureId, slot);
                    state.pickIdByFeatureId.set(featureId, pickId);
                    state.featureIdByPickId.set(pickId, featureId);
                }
                state.pointSlotsByFeatureHash.set(hash, slot);
                state.pickIdByFeatureHash.set(hash, pickId);
                replayRenderBatchMetaMap.set(pickId, {
                    id: pickId,
                    name: `${toHudLayerName(options.layerId)} ${hash}`,
                    layer: toHudLayerName(options.layerId),
                    layerId: options.layerId,
                    subtype,
                    source: sourceId,
                    lat: Number.isFinite(lat) ? lat : 0,
                    lng: Number.isFinite(lng) ? lng : 0,
                    alt: Number.isFinite(alt) ? alt : (Number.isFinite(altitude) ? altitude : 0),
                    speed: Number.isFinite(speed) ? speed : null,
                    heading: Number.isFinite(heading) ? heading : null,
                    extra: {
                        ...(featureId ? { featureId } : {}),
                        featureHash: hash,
                        featureFamily,
                    },
                    renderBatch: {
                        chunkId: `delta:${options.layerId}`,
                        featureIndex: hash,
                        detailsLoaded: false,
                        atIso: layer.at,
                    },
                });
                this.onPointAdd?.(pickId, billboard);
                added += 1;
            }
            applyFastBillboardPosition(slot, x, y, z);
            const existingMeta = replayRenderBatchMetaMap.get(pickId);
            const effectiveSubtype = subtype ?? existingMeta?.subtype ?? null;
            const effectiveSourceId = sourceId ?? existingMeta?.source ?? null;
            slot.billboard.show = this.resolveVisible(pickId, options.layerId, effectiveSubtype, effectiveSourceId);
            slot.billboard.rotation = Number.isFinite(heading) ? Cesium.Math.toRadians(-heading) : 0;
            const meta = existingMeta;
            if (meta) {
                meta.subtype = effectiveSubtype;
                meta.source = effectiveSourceId;
                meta.lat = Number.isFinite(lat) ? lat : meta.lat;
                meta.lng = Number.isFinite(lng) ? lng : meta.lng;
                meta.alt = Number.isFinite(alt) ? alt : (Number.isFinite(altitude) ? altitude : meta.alt);
                meta.speed = Number.isFinite(speed) ? speed : null;
                meta.heading = Number.isFinite(heading) ? heading : null;
                meta.extra = {
                    ...(meta.extra || {}),
                    ...(featureId ? { featureId } : {}),
                    ...(byHash ? { featureHash } : {}),
                    featureFamily,
                };
                if (meta.renderBatch) {
                    meta.renderBatch.atIso = layer.at;
                    meta.renderBatch.detailsLoaded = false;
                }
            }
            updated += 1;
        }

        let stale = 0;
        if (options.layerId === 'satellite' && layer.ids.length === 0 && layer.hashes.length === 0) {
            state.pointSlotsByFeatureIndex.forEach((slot, featureIndex) => {
                if (seenIndexes.has(featureIndex)) return;
                slot.billboard.show = false;
                stale += 1;
            });
        } else if (layer.hashes.length > 0 && layer.ids.length === 0) {
            const remove: Array<{ pickId: string; slot: SatelliteApplySlot }> = [];
            state.pointSlotsByFeatureHash.forEach((slot, hash) => {
                if (seenHashes.has(hash)) return;
                const stalePickId = state.pickIdByFeatureHash.get(hash);
                if (stalePickId) remove.push({ pickId: stalePickId, slot });
            });
            for (const item of remove) {
                this.removePointSlot(state, item.pickId, item.slot);
                stale += 1;
            }
        } else {
            const remove: Array<{ pickId: string; slot: SatelliteApplySlot }> = [];
            state.pointSlotsByFeatureId.forEach((slot, featureId) => {
                if (seen.has(featureId)) return;
                const stalePickId = state.pickIdByFeatureId.get(featureId);
                if (stalePickId) remove.push({ pickId: stalePickId, slot });
            });
            for (const item of remove) {
                this.removePointSlot(state, item.pickId, item.slot);
                stale += 1;
            }
        }
        state.featureCount = layer.count;
        state.pointCount = layer.count;
        this.scene.requestRender();

        const churnThreshold = Math.max(250, Math.round(Math.max(layer.count, state.pointSlotsByFeatureId.size) * 0.08));
        return {
            applied: true,
            layerId: options.layerId,
            atIso: layer.at,
            count: layer.count,
            updated,
            added,
            missing,
            stale,
            needsFullSync: missing > churnThreshold,
            ms: Math.round(performance.now() - t0),
        };
    }

    private renderChunk(manifest: RenderChunkManifest, decoded: DecodedChunk, refs: RenderFeatureRef[] = []): LayerRenderState & {
        motionTracks: ReplayRenderBatchMotionTrack[];
        footprints: ReplayRenderBatchFootprint[];
    } {
        const pointCollections: Cesium.BillboardCollection[] = [];
        const primitives: Cesium.Primitive[] = [];
        const pointSlotsByFeatureId = new Map<string, SatelliteApplySlot>();
        const pickIdByFeatureId = new Map<string, string>();
        const featureIdByPickId = new Map<string, string>();
        const pointSlotsByFeatureHash = new Map<number, SatelliteApplySlot>();
        const pickIdByFeatureHash = new Map<number, string>();
        const pointSlotsByFeatureIndex = new Map<number, SatelliteApplySlot>();
        const pickIdByFeatureIndex = new Map<number, string>();
        const table = decoded.featureTable;
        const featureCount = table.length / 12;
        let pointCount = 0;
        let shapeCount = 0;
        const motionTracks: ReplayRenderBatchMotionTrack[] = [];
        const footprints: ReplayRenderBatchFootprint[] = [];

        if (decoded.pointPositions.length > 0) {
            const collection = new Cesium.BillboardCollection({
                scene: this.scene,
                blendOption: Cesium.BlendOption.TRANSLUCENT,
            });
            this.scene.primitives.add(collection);
            pointCollections.push(collection);
            for (let rowIndex = 0; rowIndex < featureCount; rowIndex += 1) {
                const row = getFeatureRow(table, rowIndex);
                if (row.pointCount === 0) continue;
                const style = manifest.styles[String(row.styleId)];
                const ref = refs[row.featureIndex];
                const props = getFeatureProperties(decoded, row.featureIndex);
                const icon = pointIconForStyle(manifest.layerId, style);
                const scale = pointScaleForStyle(manifest.layerId, style);
                const rotation = props.headingDeg != null ? Cesium.Math.toRadians(-props.headingDeg) : 0;
                const visible = this.resolveVisible(
                    makeRenderId(manifest.chunkId, row.featureIndex),
                    style?.layerId || manifest.layerId,
                    style?.subtype,
                    style?.sourceId,
                );
                const bboxOffset = rowIndex * 4;
                const lng = (decoded.featureBboxes[bboxOffset] + decoded.featureBboxes[bboxOffset + 2]) / 2;
                const lat = (decoded.featureBboxes[bboxOffset + 1] + decoded.featureBboxes[bboxOffset + 3]) / 2;
                const pickId = makeRenderId(manifest.chunkId, row.featureIndex);
                replayRenderBatchMetaMap.set(pickId, {
                    id: pickId,
                    name: `${toHudLayerName(manifest.layerId)} ${row.featureIndex}`,
                    layer: toHudLayerName(manifest.layerId),
                    layerId: manifest.layerId,
                    subtype: style?.subtype,
                    source: style?.sourceId,
                    lat: Number.isFinite(lat) ? lat : 0,
                    lng: Number.isFinite(lng) ? lng : 0,
                    alt: props.altitude,
                    speed: props.speedMps,
                    heading: props.headingDeg,
                    extra: ref ? {
                        featureId: ref.id,
                        featureFamily: ref.family,
                    } : undefined,
                    renderBatch: {
                        chunkId: manifest.chunkId,
                        featureIndex: row.featureIndex,
                        detailsLoaded: false,
                        atIso: manifest.at,
                    },
                });
                for (let i = 0; i < row.pointCount; i += 1) {
                    const offset = (row.pointStart + i) * 3;
                    const billboard = collection.add({
                        id: pickId,
                        position: new Cesium.Cartesian3(
                            decoded.pointPositions[offset],
                            decoded.pointPositions[offset + 1],
                            decoded.pointPositions[offset + 2],
                        ),
                        image: icon,
                        scale,
                        rotation,
                        ...(manifest.layerId === 'vessel' ? { alignedAxis: Cesium.Cartesian3.UNIT_Z } : {}),
                        show: visible,
                    });
                    if (ref?.id) {
                        const slot: SatelliteApplySlot = {
                            index: pointCount,
                            targetId: pickId,
                            billboard,
                            scratch: new Cesium.Cartesian3(),
                            getVisible: () => this.resolveVisible(
                                pickId,
                                style?.layerId || manifest.layerId,
                                style?.subtype,
                                style?.sourceId,
                            ),
                        };
                        pointSlotsByFeatureId.set(ref.id, slot);
                        pickIdByFeatureId.set(ref.id, pickId);
                        featureIdByPickId.set(pickId, ref.id);
                        const hash = stableHash32(ref.id);
                        pointSlotsByFeatureHash.set(hash, slot);
                        pickIdByFeatureHash.set(hash, pickId);
                    }
                    pointSlotsByFeatureIndex.set(row.featureIndex, {
                        index: pointCount,
                        targetId: pickId,
                        billboard,
                        scratch: new Cesium.Cartesian3(),
                        getVisible: () => this.resolveVisible(
                            pickId,
                            style?.layerId || manifest.layerId,
                            style?.subtype,
                            style?.sourceId,
                        ),
                    });
                    pickIdByFeatureIndex.set(row.featureIndex, pickId);
                    this.onPointAdd?.(pickId, billboard);
                    pointCount += 1;
                }
            }
        }

        const fillInstances: Cesium.GeometryInstance[] = [];
        const lineInstances: Cesium.GeometryInstance[] = [];
        for (let rowIndex = 0; rowIndex < featureCount; rowIndex += 1) {
            const row = getFeatureRow(table, rowIndex);
            const style = manifest.styles[String(row.styleId)];
            const ref = refs[row.featureIndex];
            const props = getFeatureProperties(decoded, row.featureIndex);
            const pickId = makeRenderId(manifest.chunkId, row.featureIndex);
            const visible = this.resolveVisible(
                pickId,
                style?.layerId || manifest.layerId,
                style?.subtype,
                style?.sourceId,
            );
            const bboxOffset = rowIndex * 4;
            const lng = (decoded.featureBboxes[bboxOffset] + decoded.featureBboxes[bboxOffset + 2]) / 2;
            const lat = (decoded.featureBboxes[bboxOffset + 1] + decoded.featureBboxes[bboxOffset + 3]) / 2;
            if (!replayRenderBatchMetaMap.has(pickId)) {
                replayRenderBatchMetaMap.set(pickId, {
                    id: pickId,
                    name: `${toHudLayerName(manifest.layerId)} ${row.featureIndex}`,
                    layer: toHudLayerName(manifest.layerId),
                    layerId: manifest.layerId,
                    subtype: style?.subtype,
                    source: style?.sourceId,
                    lat: Number.isFinite(lat) ? lat : 0,
                    lng: Number.isFinite(lng) ? lng : 0,
                    alt: props.altitude,
                    speed: props.speedMps,
                    heading: props.headingDeg,
                    extra: ref ? {
                        featureId: ref.id,
                        featureFamily: ref.family,
                    } : undefined,
                    renderBatch: {
                        chunkId: manifest.chunkId,
                        featureIndex: row.featureIndex,
                        detailsLoaded: false,
                        atIso: manifest.at,
                    },
                });
            }

            if (row.fillVertexCount > 0 && row.indexCount > 0) {
                const positions = decoded.fillPositions.slice(row.fillStart * 3, (row.fillStart + row.fillVertexCount) * 3);
                const indices = new Uint32Array(row.indexCount);
                for (let i = 0; i < row.indexCount; i += 1) {
                    indices[i] = decoded.fillIndices[row.indexStart + i] - row.fillStart;
                }
                fillInstances.push(new Cesium.GeometryInstance({
                    id: pickId,
                    geometry: new Cesium.Geometry({
                        attributes: {
                            position: new Cesium.GeometryAttribute({
                                // Cesium PrimitivePipeline only encodes world-space
                                // positions into position3DHigh/position3DLow when
                                // the source position attribute is declared DOUBLE.
                                componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                                componentsPerAttribute: 3,
                                values: positions,
                            }),
                        },
                        indices,
                        primitiveType: Cesium.PrimitiveType.TRIANGLES,
                        boundingSphere: Cesium.BoundingSphere.fromVertices(positions as any),
                    } as any),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorForStyle(manifest.layerId, style?.subtype, 0.22)),
                        show: new Cesium.ShowGeometryInstanceAttribute(visible),
                    },
                }));
                shapeCount += 1;
            }

            if (row.lineVertexCount > 0) {
                const positions = decoded.linePositions.slice(row.lineStart * 3, (row.lineStart + row.lineVertexCount) * 3);
                const indices = new Uint32Array(row.lineVertexCount);
                for (let i = 0; i < row.lineVertexCount; i += 1) indices[i] = i;
                lineInstances.push(new Cesium.GeometryInstance({
                    id: pickId,
                    geometry: new Cesium.Geometry({
                        attributes: {
                            position: new Cesium.GeometryAttribute({
                                componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                                componentsPerAttribute: 3,
                                values: positions,
                            }),
                        },
                        indices,
                        primitiveType: Cesium.PrimitiveType.LINES,
                        boundingSphere: Cesium.BoundingSphere.fromVertices(positions as any),
                    } as any),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorForStyle(manifest.layerId, style?.subtype, 0.8)),
                        show: new Cesium.ShowGeometryInstanceAttribute(visible),
                    },
                }));
                shapeCount += 1;
            }
        }

        if (fillInstances.length > 0) {
            const primitive = new Cesium.Primitive({
                geometryInstances: fillInstances,
                appearance: new Cesium.PerInstanceColorAppearance({
                    translucent: true,
                    flat: true,
                    closed: false,
                }),
                // Raw Cesium.Geometry does not have a Cesium workerName/path.
                // `asynchronous: true` is only valid for built-in geometries
                // that Cesium can rebuild in its worker pool.
                asynchronous: false,
                compressVertices: false,
                releaseGeometryInstances: true,
            });
            this.scene.primitives.add(primitive);
            primitives.push(primitive);
        }

        if (lineInstances.length > 0) {
            const primitive = new Cesium.Primitive({
                geometryInstances: lineInstances,
                appearance: new Cesium.PerInstanceColorAppearance({
                    translucent: true,
                    flat: true,
                }),
                // Raw Cesium.Geometry does not have a Cesium workerName/path.
                // `asynchronous: true` throws DeveloperError at render time.
                asynchronous: false,
                compressVertices: false,
                releaseGeometryInstances: true,
            });
            this.scene.primitives.add(primitive);
            primitives.push(primitive);
        }

        for (let i = 0; i < decoded.trackRows.length; i += 4) {
            const featureIndex = decoded.trackRows[i];
            const sampleStart = decoded.trackRows[i + 1];
            const sampleCount = decoded.trackRows[i + 2];
            if (sampleCount === 0) continue;
            motionTracks.push({
                targetId: makeRenderId(manifest.chunkId, featureIndex),
                sampleAtMs: new Float64Array(decoded.trackSampleTimes.slice(sampleStart, sampleStart + sampleCount)),
                samplePositions: new Float32Array(decoded.trackSamplePositions.slice(sampleStart * 3, (sampleStart + sampleCount) * 3)),
            });
        }

        for (const fp of manifest.footprints || []) {
            const targetId = makeRenderId(manifest.chunkId, fp.featureIndex);
            const meta = replayRenderBatchMetaMap.get(targetId);
            footprints.push({
                satId: targetId,
                footprintId: `fp-sat-replay-${manifest.chunkId}-${fp.featureIndex}`,
                radiusMeters: fp.radiusMeters,
                baseColor: baseColorForSatellite(meta?.subtype),
                meta: {
                    parentSatId: targetId,
                    satName: meta?.name || targetId,
                    subtype: meta?.subtype || 'civilian',
                    sensorName: fp.sensorName,
                    sensorType: fp.sensorType,
                    swathMeters: fp.radiusMeters * 2,
                    source: fp.source,
                },
            });
        }

        return {
            pointCollections,
            primitives,
            pointSlotsByFeatureId,
            pickIdByFeatureId,
            featureIdByPickId,
            pointSlotsByFeatureHash,
            pickIdByFeatureHash,
            pointSlotsByFeatureIndex,
            pickIdByFeatureIndex,
            pointCount,
            shapeCount,
            featureCount,
            motionTrackCount: motionTracks.length,
            footprintCount: footprints.length,
            motionTracks,
            footprints,
        };
    }
}
