import * as Cesium from 'cesium';
import { getSatBillboardImage } from '../icons/map-icons';
import { applyFastBillboardPosition, type SatelliteApplySlot } from './satelliteApplyManager';
import { ReplayDenseGeometryPrimitive, writeDenseColor } from './replayDenseGeometryPrimitive';
import { baseColorForSatellite, colorForStyle, featureFamilyForLayer, getReplayApplyChunkSize, getReplayHydrationStage, pointIconForStyle, pointScaleForStyle, toHudLayerName } from './renderStyleRegistry';
import { replayHttpGet } from './replayHttp';

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
    cacheKeyVersion?: string;
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
    degraded?: Record<string, number | string | boolean>;
};

type RenderChunksResponse = {
    format: 'AWVBIN1';
    version: 1;
    cacheKeyVersion?: string;
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
    extra?: Record<string, any>;
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
    linePositions: Float64Array;
    lineFeatureIndices: Uint32Array;
    fillPositions: Float64Array;
    fillIndices: Uint32Array;
    fillFeatureIndices: Uint32Array;
    trackRows: Uint32Array;
    trackSampleTimes: Float64Array;
    trackSamplePositions: Float32Array;
};

type LayerRenderState = {
    pointCollections: Cesium.BillboardCollection[];
    primitives: Array<Cesium.Primitive | ReplayDenseGeometryPrimitive>;
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

const REPLAY_POINT_WORK_BUDGET_MS = 8;
const REPLAY_POINT_WORK_CHECK_INTERVAL = 250;
const REPLAY_POINT_UPLOAD_CHUNK_MIN = 3000;
const REPLAY_SHAPE_WORK_BUDGET_MS = 8;

type ReplayPointImage = string | HTMLCanvasElement | HTMLImageElement;

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
    bbox?: [number, number, number, number];
    aggregateFires?: boolean;
    fetchFeatureRefs?: boolean;
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
    degraded?: Record<string, number | string | boolean>;
};

export type RenderBatchVisibilityResolver = (
    targetId: string,
    layerId: string,
    subtype: string | null | undefined,
    sourceId: string | null | undefined,
) => boolean;

export const replayRenderBatchMetaMap = new Map<string, RenderBatchReplayMeta>();
const replayRenderBatchMetadataInFlight = new Map<string, Promise<RenderBatchReplayMeta | null>>();

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
    return featureFamilyForLayer(layerId);
}

function cartographicFromEcefPositions(positions: Float32Array): Float32Array {
    const cartographic = new Float32Array(positions.length);
    const scratchCartesian = new Cesium.Cartesian3();
    const scratchCartographic = new Cesium.Cartographic();
    for (let offset = 0; offset < positions.length; offset += 3) {
        const x = positions[offset];
        const y = positions[offset + 1];
        const z = positions[offset + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            cartographic[offset] = Number.NaN;
            cartographic[offset + 1] = Number.NaN;
            cartographic[offset + 2] = Number.NaN;
            continue;
        }
        scratchCartesian.x = x;
        scratchCartesian.y = y;
        scratchCartesian.z = z;
        const converted = Cesium.Cartographic.fromCartesian(
            scratchCartesian,
            Cesium.Ellipsoid.WGS84,
            scratchCartographic,
        );
        if (!converted) {
            cartographic[offset] = Number.NaN;
            cartographic[offset + 1] = Number.NaN;
            cartographic[offset + 2] = Number.NaN;
            continue;
        }
        cartographic[offset] = Cesium.Math.toDegrees(converted.longitude);
        cartographic[offset + 1] = Cesium.Math.toDegrees(converted.latitude);
        cartographic[offset + 2] = converted.height;
    }
    return cartographic;
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
    if (positionCount !== 0 && positionCount !== hashCount * 3) {
        throw new Error(`Point delta position count mismatch: rows=${hashCount} positions=${positionCount}`);
    }
    if (propertyCount !== 0 && propertyCount !== hashCount * 4) {
        throw new Error(`Point delta property count mismatch: rows=${hashCount} properties=${propertyCount}`);
    }
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
        cartographic: cartographicFromEcefPositions(positions),
        properties,
    };
}

function getSection<T extends Uint32Array | Float32Array | Float64Array>(
    buffer: ArrayBuffer,
    sections: Record<string, RenderSection>,
    name: string,
    expectedType: 'uint32' | 'float32' | 'float64',
): T {
    const section = sections[name];
    if (!section || section.type !== expectedType) {
        throw new Error(`Render chunk missing ${name}`);
    }
    validateSectionAlignment(name, section, expectedType);
    if (expectedType === 'uint32') {
        return new Uint32Array(buffer, section.byteOffset, section.length) as T;
    }
    if (expectedType === 'float64') {
        return new Float64Array(buffer, section.byteOffset, section.length) as T;
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
    validateSectionAlignment(name, section, expectedType);
    if (expectedType === 'uint32') return new Uint32Array(buffer, section.byteOffset, section.length) as T;
    if (expectedType === 'float64') return new Float64Array(buffer, section.byteOffset, section.length) as T;
    return new Float32Array(buffer, section.byteOffset, section.length) as T;
}

function validateSectionAlignment(name: string, section: RenderSection, expectedType: 'uint32' | 'float32' | 'float64'): void {
    const alignment = expectedType === 'float64' ? 8 : 4;
    if (section.byteOffset % alignment !== 0) {
        throw new Error(`Render chunk section ${name} is not ${alignment}-byte aligned`);
    }
}

function validateMagic(buffer: ArrayBuffer): void {
    const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
    const magic = Array.from(bytes).map((value) => String.fromCharCode(value)).join('');
    if (magic !== 'AWVBIN1\x00') throw new Error('Invalid render chunk magic');
}

function decodeChunk(buffer: ArrayBuffer, manifest: RenderChunkManifest): DecodedChunk {
    validateMagic(buffer);
    return {
        featureTable: getSection<Uint32Array>(buffer, manifest.sections, 'featureTable', 'uint32'),
        featureBboxes: getSection<Float32Array>(buffer, manifest.sections, 'featureBboxes', 'float32'),
        featureProperties: getOptionalSection<Float32Array>(buffer, manifest.sections, 'featureProperties', 'float32'),
        pointPositions: getSection<Float32Array>(buffer, manifest.sections, 'pointPositions', 'float32'),
        pointFeatureIndices: getSection<Uint32Array>(buffer, manifest.sections, 'pointFeatureIndices', 'uint32'),
        linePositions: getSection<Float64Array>(buffer, manifest.sections, 'linePositions', 'float64'),
        lineFeatureIndices: getSection<Uint32Array>(buffer, manifest.sections, 'lineFeatureIndices', 'uint32'),
        fillPositions: getSection<Float64Array>(buffer, manifest.sections, 'fillPositions', 'float64'),
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
    featureHash: number;
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
        featureHash: table[offset + 11] >>> 0,
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

function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => resolve());
            return;
        }
        setTimeout(resolve, 0);
    });
}

async function yieldForPrimitiveUpload(scene: Cesium.Scene): Promise<void> {
    scene.requestRender();
    await nextFrame();
}

async function pointImageForReplayStyle(layerId: string, style: RenderStyle | undefined): Promise<ReplayPointImage> {
    if (layerId === 'satellite') {
        const subtype = style?.subtype || 'civilian';
        const isRecon = style?.variant === 'recon' || style?.subtype === 'recon';
        return getSatBillboardImage(subtype, isRecon);
    }
    return pointIconForStyle(layerId, style);
}

export async function fetchReplayRenderBatchMetadata(apiUrl: string, pickId: string): Promise<RenderBatchReplayMeta | null> {
    const parsed = parseRenderBatchId(pickId);
    if (!parsed) return null;
    const existing = replayRenderBatchMetaMap.get(pickId);
    if (existing?.renderBatch?.detailsLoaded) return existing;
    const inFlight = replayRenderBatchMetadataInFlight.get(pickId);
    if (inFlight) return inFlight;
    const request = (async () => {
        const featureId = existing?.extra?.featureId;
        const featureFamily = existing?.extra?.featureFamily;
        const featureHash = existing?.extra?.featureHash ?? parsed.featureHash;
        const atIso = existing?.renderBatch?.atIso;
        const feature = (featureId || Number.isFinite(Number(featureHash))) && featureFamily && atIso
            ? await replayHttpGet<RenderFeatureMetadata>(
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
            : await replayHttpGet<RenderFeatureMetadata>(
                absoluteApiUrl(apiUrl, `/api/replay/render-chunks/${parsed.chunkId}/features/${parsed.featureIndex}`),
            );
        const meta = metaFromFeature(feature, pickId, parsed);
        if (atIso && meta.renderBatch) meta.renderBatch.atIso = atIso;
        replayRenderBatchMetaMap.set(pickId, meta);
        return meta;
    })();
    replayRenderBatchMetadataInFlight.set(pickId, request);
    try {
        return await request;
    } finally {
        if (replayRenderBatchMetadataInFlight.get(pickId) === request) {
            replayRenderBatchMetadataInFlight.delete(pickId);
        }
    }
}

export function clearReplayRenderBatchMetadata(): void {
    replayRenderBatchMetaMap.clear();
    replayRenderBatchMetadataInFlight.clear();
}

export class ReplayRenderBatchManager {
    private readonly scene: Cesium.Scene;
    private readonly apiUrl: string;
    private resolveVisible: RenderBatchVisibilityResolver;
    private readonly onPointAdd?: (id: string, billboard: Cesium.Billboard) => void;
    private readonly onPointRemove?: (id: string) => void;
    private readonly layerStates = new Map<string, LayerRenderState>();
    private readonly renderChunkIndexCache = new Map<string, RenderChunksResponse>();
    private readonly renderChunkIndexInFlight = new Map<string, Promise<RenderChunksResponse>>();
    private readonly chunkDataCache = new Map<string, { layerId: string; buffer: ArrayBuffer }>();
    private readonly chunkDataInFlight = new Map<string, Promise<ArrayBuffer>>();
    private readonly featureRefsCache = new Map<string, { layerId: string; refs: RenderFeatureRefsResponse }>();
    private readonly featureRefsInFlight = new Map<string, Promise<RenderFeatureRefsResponse>>();

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

    private async getRenderChunkIndex(url: string): Promise<RenderChunksResponse> {
        const cached = this.renderChunkIndexCache.get(url);
        if (cached) return cached;
        const inFlight = this.renderChunkIndexInFlight.get(url);
        if (inFlight) return inFlight;
        let request: Promise<RenderChunksResponse>;
        request = replayHttpGet<RenderChunksResponse>(url)
            .then((manifest) => {
                this.renderChunkIndexCache.set(url, manifest);
                return manifest;
            })
            .finally(() => {
                if (this.renderChunkIndexInFlight.get(url) === request) {
                    this.renderChunkIndexInFlight.delete(url);
                }
            });
        this.renderChunkIndexInFlight.set(url, request);
        return request;
    }

    private pruneRenderChunkIndexCache(layerId: string, keepUrl: string): void {
        for (const [url, manifest] of Array.from(this.renderChunkIndexCache.entries())) {
            if (url === keepUrl) continue;
            if (Object.prototype.hasOwnProperty.call(manifest.layers || {}, layerId)) {
                this.renderChunkIndexCache.delete(url);
            }
        }
    }

    private async getChunkData(layerId: string, url: string): Promise<ArrayBuffer> {
        const cached = this.chunkDataCache.get(url);
        if (cached) return cached.buffer;
        const inFlight = this.chunkDataInFlight.get(url);
        if (inFlight) return inFlight;
        let request: Promise<ArrayBuffer>;
        request = replayHttpGet<ArrayBuffer>(url, { responseType: 'arraybuffer' })
            .then((buffer) => {
                this.chunkDataCache.set(url, { layerId, buffer });
                return buffer;
            })
            .finally(() => {
                if (this.chunkDataInFlight.get(url) === request) {
                    this.chunkDataInFlight.delete(url);
                }
            });
        this.chunkDataInFlight.set(url, request);
        return request;
    }

    private async getFeatureRefs(layerId: string, url: string): Promise<RenderFeatureRefsResponse> {
        const cached = this.featureRefsCache.get(url);
        if (cached) return cached.refs;
        const inFlight = this.featureRefsInFlight.get(url);
        if (inFlight) return inFlight;
        let request: Promise<RenderFeatureRefsResponse>;
        request = replayHttpGet<RenderFeatureRefsResponse>(url)
            .then((refs) => {
                this.featureRefsCache.set(url, { layerId, refs });
                return refs;
            })
            .finally(() => {
                if (this.featureRefsInFlight.get(url) === request) {
                    this.featureRefsInFlight.delete(url);
                }
            });
        this.featureRefsInFlight.set(url, request);
        return request;
    }

    private pruneLayerChunkCache(layerId: string, keepDataUrls = new Set<string>(), keepRefsUrls = new Set<string>()): void {
        for (const [url, cached] of Array.from(this.chunkDataCache.entries())) {
            if (cached.layerId === layerId && !keepDataUrls.has(url)) this.chunkDataCache.delete(url);
        }
        for (const [url, cached] of Array.from(this.featureRefsCache.entries())) {
            if (cached.layerId === layerId && !keepRefsUrls.has(url)) this.featureRefsCache.delete(url);
        }
    }

    clearAll(): void {
        for (const layerId of Array.from(this.layerStates.keys())) {
            this.clearLayer(layerId);
        }
        this.renderChunkIndexCache.clear();
        this.renderChunkIndexInFlight.clear();
        this.chunkDataCache.clear();
        this.chunkDataInFlight.clear();
        this.featureRefsCache.clear();
        this.featureRefsInFlight.clear();
        clearReplayRenderBatchMetadata();
    }

    clearLayer(layerId: string): void {
        const state = this.layerStates.get(layerId);
        if (!state) return;
        for (const collection of state.pointCollections) {
            try { this.scene.primitives.remove(collection); } catch {}
        }
        for (const primitive of state.primitives) {
            try { this.scene.primitives.remove(primitive as any); } catch {}
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
        if (options.bbox) {
            params.set('bbox', options.bbox.join(','));
            params.set('bbox_order', 'west,south,east,north');
        }
        if (options.layerId === 'fire' && options.aggregateFires === false) params.set('cluster', '0');
        const manifestUrl = absoluteApiUrl(this.apiUrl, `/api/replay/render-chunks?${params.toString()}`);
        const manifest = await this.getRenderChunkIndex(manifestUrl);
        this.pruneRenderChunkIndexCache(options.layerId, manifestUrl);
        const chunks = manifest.layers[options.layerId] || [];
        const keepDataUrls = new Set(chunks.map((chunk) => absoluteApiUrl(this.apiUrl, chunk.dataUrl)));
        const keepRefsUrls = new Set(chunks.map((chunk) => absoluteApiUrl(this.apiUrl, chunk.detailsUrl)));
        this.pruneLayerChunkCache(options.layerId, keepDataUrls, keepRefsUrls);
        const decoded: Array<{ manifest: RenderChunkManifest; data: DecodedChunk; refs: RenderFeatureRef[] }> = [];
        let bytes = 0;
        const degraded: Record<string, number | string | boolean> = {};
        for (const chunk of chunks) {
            if (isCancelled()) {
                return { applied: false, layerId: options.layerId, featureCount: 0, pointCount: 0, shapeCount: 0, bytes, motionTracks: [], footprints: [] };
            }
            // Full render chunks carry feature hashes in the binary feature
            // table. Card/details metadata is loaded on demand by hash/id, so
            // initial paint does not need to download the per-feature refs JSON.
            const shouldFetchRefs = Boolean(options.fetchFeatureRefs);
            const dataUrl = absoluteApiUrl(this.apiUrl, chunk.dataUrl);
            const detailsUrl = absoluteApiUrl(this.apiUrl, chunk.detailsUrl);
            const [buffer, refs] = await Promise.all([
                this.getChunkData(options.layerId, dataUrl),
                shouldFetchRefs
                    ? this.getFeatureRefs(options.layerId, detailsUrl)
                    : Promise.resolve({
                        chunkId: chunk.chunkId,
                        at: chunk.at,
                        layerId: chunk.layerId,
                        features: [],
                    }),
            ]);
            bytes += buffer.byteLength;
            if (chunk.degraded) {
                for (const [key, value] of Object.entries(chunk.degraded)) {
                    if (typeof value === 'number') degraded[key] = Number(degraded[key] || 0) + value;
                    else degraded[key] = value;
                }
            }
            decoded.push({ manifest: chunk, data: decodeChunk(buffer, chunk), refs: refs.features || [] });
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
        const primitives: Array<Cesium.Primitive | ReplayDenseGeometryPrimitive> = [];
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
            const rendered = await this.renderChunk(item.manifest, item.data, item.refs, isCancelled);
            if (!rendered || isCancelled()) {
                this.clearLayer(options.layerId);
                return { applied: false, layerId: options.layerId, featureCount: 0, pointCount: 0, shapeCount: 0, bytes, motionTracks: [], footprints: [] };
            }
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
            ...(Object.keys(degraded).length > 0 ? { degraded } : {}),
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

    private findPointSlot(state: LayerRenderState, featureId: string, featureHash: number, featureIndex?: number): {
        slot?: SatelliteApplySlot;
        pickId?: string;
    } {
        if (featureId) {
            const slot = state.pointSlotsByFeatureId.get(featureId);
            const pickId = state.pickIdByFeatureId.get(featureId);
            if (slot && pickId) return { slot, pickId };
        }
        if (Number.isFinite(featureHash)) {
            const slot = state.pointSlotsByFeatureHash.get(featureHash);
            const pickId = state.pickIdByFeatureHash.get(featureHash);
            if (slot && pickId) return { slot, pickId };
        }
        if (featureIndex != null && Number.isFinite(featureIndex)) {
            const slot = state.pointSlotsByFeatureIndex.get(featureIndex);
            const pickId = state.pickIdByFeatureIndex.get(featureIndex);
            if (slot && pickId) return { slot, pickId };
        }
        return {};
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
        sinceIso?: string;
        bbox?: [number, number, number, number];
        partial?: boolean;
        aggregateFires?: boolean;
        isCancelled?: () => boolean;
    }): Promise<ReplayRenderBatchDeltaResult> {
        const t0 = performance.now();
        const isCancelled = options.isCancelled || (() => false);
        const cancelledResult = (): ReplayRenderBatchDeltaResult => ({
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
        });
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
        if (options.sinceIso) params.set('since', options.sinceIso);
        if (options.bbox) {
            params.set('bbox', options.bbox.join(','));
            params.set('bbox_order', 'west,south,east,north');
        }
        if (options.layerId === 'fire' && options.aggregateFires === false) params.set('cluster', '0');
        const buffer = await replayHttpGet<ArrayBuffer>(
            absoluteApiUrl(this.apiUrl, `/api/replay/render-point-deltas?${params.toString()}`),
            { responseType: 'arraybuffer' },
        );
        if (isCancelled()) return cancelledResult();
        const layer = decodePointDeltaBinary(buffer, options.layerId, options.atIso);
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
        let stale = 0;
        const rowCount = layer.ids.length > 0 ? layer.ids.length : (layer.hashes.length > 0 ? layer.hashes.length : layer.count);
        let pointWorkStartedAt = performance.now();
        let pointWorkSinceCheck = 0;
        const maybeYieldPointWork = async (): Promise<boolean> => {
            pointWorkSinceCheck += 1;
            if (
                pointWorkSinceCheck >= REPLAY_POINT_WORK_CHECK_INTERVAL
                && performance.now() - pointWorkStartedAt >= REPLAY_POINT_WORK_BUDGET_MS
            ) {
                await nextFrame();
                if (isCancelled()) return false;
                pointWorkStartedAt = performance.now();
                pointWorkSinceCheck = 0;
            }
            return true;
        };
        for (let i = 0; i < rowCount; i += 1) {
            if (isCancelled()) return cancelledResult();
            const featureId = layer.ids[i] || '';
            const featureHash = layer.hashes[i];
            const hasFeatureHash = Number.isFinite(featureHash);
            const byIndex = !featureId && !hasFeatureHash && options.layerId === 'satellite';
            const byHash = !featureId && hasFeatureHash;
            const styleId = layer.styleIds[i];
            const style = Number.isFinite(styleId) ? layer.styles?.[String(styleId)] : undefined;
            const effectiveStyleId = Number.isFinite(styleId) ? styleId : null;
            const featureFamily = familyFromCode(layer.familyCodes[i], options.layerId);
            if (featureId) seen.add(featureId);
            if (byHash) seenHashes.add(featureHash);
            if (byIndex) seenIndexes.add(i);
            const existing = this.findPointSlot(state, featureId, featureHash, byIndex ? i : undefined);
            let slot = existing.slot;
            let pickId = existing.pickId;
            const positionOffset = i * 3;
            const x = layer.positions[positionOffset];
            const y = layer.positions[positionOffset + 1];
            const z = layer.positions[positionOffset + 2];
            const propOffset = i * 4;
            const heading = layer.properties[propOffset];
            const speed = layer.properties[propOffset + 1];
            const altitude = layer.properties[propOffset + 2];
            const removeFlag = layer.properties[propOffset + 3] === 1;
            if (removeFlag) {
                if (slot && pickId) {
                    this.removePointSlot(state, pickId, slot);
                    stale += 1;
                } else {
                    missing += 1;
                }
                if (!(await maybeYieldPointWork())) return cancelledResult();
                continue;
            }
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                if (!(await maybeYieldPointWork())) return cancelledResult();
                continue;
            }
            const subtype = layer.subtypes[i] ?? style?.subtype ?? null;
            const sourceId = layer.sourceIds[i] ?? style?.sourceId ?? null;
            const cartoOffset = i * 3;
            const lng = layer.cartographic[cartoOffset];
            const lat = layer.cartographic[cartoOffset + 1];
            const alt = layer.cartographic[cartoOffset + 2];
            if (!slot || !pickId) {
                if (byIndex || (!featureId && !byHash)) {
                    missing += 1;
                    if (!(await maybeYieldPointWork())) return cancelledResult();
                    continue;
                }
                const hash = byHash ? featureHash : stableHash32(featureId);
                pickId = makeDeltaRenderId(options.layerId, hash);
                const collection = this.ensurePointCollection(state);
                const icon = await pointImageForReplayStyle(options.layerId, style);
                if (isCancelled()) return cancelledResult();
                const scale = pointScaleForStyle(options.layerId, style);
                const rotation = Number.isFinite(heading) ? Cesium.Math.toRadians(-heading) : 0;
                const visibilityId = featureId || pickId;
                const visible = this.resolveVisible(visibilityId, options.layerId, subtype, sourceId);
                if (!visible) {
                    if (!(await maybeYieldPointWork())) return cancelledResult();
                    continue;
                }
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
                    getVisible: () => this.resolveVisible(visibilityId, options.layerId, subtype, sourceId),
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
                        ...(effectiveStyleId != null ? { styleId: effectiveStyleId } : {}),
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
            const previousSubtype = existingMeta?.subtype ?? null;
            const previousSourceId = existingMeta?.source ?? null;
            const previousStyleId = Number(existingMeta?.extra?.styleId);
            const effectiveSubtype = subtype ?? existingMeta?.subtype ?? null;
            const effectiveSourceId = sourceId ?? existingMeta?.source ?? null;
            if (!existingMeta || previousSubtype !== effectiveSubtype || previousSourceId !== effectiveSourceId) {
                const visibilityId = featureId || existingMeta?.extra?.featureId || pickId;
                slot.billboard.show = this.resolveVisible(String(visibilityId), options.layerId, effectiveSubtype, effectiveSourceId);
            }
            const styleChanged = effectiveStyleId != null && (!Number.isFinite(previousStyleId) || previousStyleId !== effectiveStyleId);
            if (styleChanged || previousSubtype !== effectiveSubtype) {
                const refreshedIcon = await pointImageForReplayStyle(options.layerId, style);
                if (isCancelled()) return cancelledResult();
                (slot.billboard as any).image = refreshedIcon;
            }
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
                    ...(hasFeatureHash ? { featureHash } : {}),
                    ...(effectiveStyleId != null ? { styleId: effectiveStyleId } : {}),
                    featureFamily,
                };
                if (meta.renderBatch) {
                    meta.renderBatch.atIso = layer.at;
                    meta.renderBatch.detailsLoaded = false;
                }
            }
            updated += 1;
            if (!(await maybeYieldPointWork())) return cancelledResult();
        }

        const partial = options.partial === true;
        if (partial) {
            stale = 0;
        } else if (options.layerId === 'satellite' && layer.ids.length === 0 && layer.hashes.length === 0) {
            for (const [featureIndex, slot] of Array.from(state.pointSlotsByFeatureIndex.entries())) {
                if (seenIndexes.has(featureIndex)) continue;
                slot.billboard.show = false;
                stale += 1;
                if (!(await maybeYieldPointWork())) return cancelledResult();
            }
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
                if (!(await maybeYieldPointWork())) return cancelledResult();
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
                if (!(await maybeYieldPointWork())) return cancelledResult();
            }
        }
        const indexedCount = Math.max(
            state.pointSlotsByFeatureId.size,
            state.pointSlotsByFeatureHash.size,
            state.pointSlotsByFeatureIndex.size,
        );
        state.featureCount = indexedCount;
        state.pointCount = indexedCount;
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
            needsFullSync: partial ? false : missing > churnThreshold,
            ms: Math.round(performance.now() - t0),
        };
    }

    private async renderChunk(
        manifest: RenderChunkManifest,
        decoded: DecodedChunk,
        refs: RenderFeatureRef[] = [],
        isCancelled: () => boolean = () => false,
    ): Promise<(LayerRenderState & {
        motionTracks: ReplayRenderBatchMotionTrack[];
        footprints: ReplayRenderBatchFootprint[];
    }) | null> {
        const pointCollections: Cesium.BillboardCollection[] = [];
        const primitives: Array<Cesium.Primitive | ReplayDenseGeometryPrimitive> = [];
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
        const addedPickIds = new Set<string>();
        const renderedFeaturePickIds = new Set<string>();

        const cleanupPartialRender = (): null => {
            for (const collection of pointCollections) {
                try { this.scene.primitives.remove(collection); } catch {}
            }
            for (const primitive of primitives) {
                try { this.scene.primitives.remove(primitive as any); } catch {}
            }
            for (const pickId of Array.from(addedPickIds)) {
                replayRenderBatchMetaMap.delete(pickId);
                this.onPointRemove?.(pickId);
            }
            this.scene.requestRender();
            return null;
        };

        if (decoded.pointPositions.length > 0) {
            const shouldChunkPointUpload = getReplayHydrationStage(manifest.layerId) === 'background';
            const pointUploadChunkSize = shouldChunkPointUpload
                ? Math.max(REPLAY_POINT_UPLOAD_CHUNK_MIN, getReplayApplyChunkSize(manifest.layerId))
                : Number.MAX_SAFE_INTEGER;
            const satelliteImageByStyleId = new Map<number, ReplayPointImage>();
            const getSatelliteImage = async (styleId: number, style: RenderStyle | undefined): Promise<ReplayPointImage> => {
                const cached = satelliteImageByStyleId.get(styleId);
                if (cached) return cached;
                const image = await pointImageForReplayStyle(manifest.layerId, style);
                satelliteImageByStyleId.set(styleId, image);
                return image;
            };
            let collection: Cesium.BillboardCollection | null = null;
            let collectionPointCount = 0;
            const createPointCollection = (): Cesium.BillboardCollection => {
                const next = new Cesium.BillboardCollection({
                    scene: this.scene,
                    blendOption: Cesium.BlendOption.TRANSLUCENT,
                });
                this.scene.primitives.add(next);
                pointCollections.push(next);
                collectionPointCount = 0;
                return next;
            };
            const flushPointUploadChunk = async (): Promise<boolean> => {
                if (!collection || collectionPointCount === 0) return true;
                await yieldForPrimitiveUpload(this.scene);
                if (isCancelled()) return false;
                return true;
            };
            let pointWorkStartedAt = performance.now();
            let pointWorkSinceCheck = 0;
            for (let rowIndex = 0; rowIndex < featureCount; rowIndex += 1) {
                if (isCancelled()) return cleanupPartialRender();
                const row = getFeatureRow(table, rowIndex);
                if (row.pointCount === 0) continue;
                const style = manifest.styles[String(row.styleId)];
                const ref = refs[row.featureIndex];
                const featureHash = Number.isFinite(row.featureHash)
                    ? (row.featureHash >>> 0)
                    : (ref?.id ? stableHash32(ref.id) : Number.NaN);
                const featureFamily = ref?.family || featureFamilyForLayer(manifest.layerId);
                const props = getFeatureProperties(decoded, row.featureIndex);
                const icon = manifest.layerId === 'satellite'
                    ? await getSatelliteImage(row.styleId, style)
                    : pointIconForStyle(manifest.layerId, style);
                if (isCancelled()) return cleanupPartialRender();
                const scale = pointScaleForStyle(manifest.layerId, style);
                const rotation = props.headingDeg != null ? Cesium.Math.toRadians(-props.headingDeg) : 0;
                const pickId = makeRenderId(manifest.chunkId, row.featureIndex);
                const visibilityId = ref?.id || pickId;
                const visible = this.resolveVisible(
                    visibilityId,
                    style?.layerId || manifest.layerId,
                    style?.subtype,
                    style?.sourceId,
                );
                if (!visible) continue;
                const bboxOffset = rowIndex * 4;
                const lng = (decoded.featureBboxes[bboxOffset] + decoded.featureBboxes[bboxOffset + 2]) / 2;
                const lat = (decoded.featureBboxes[bboxOffset + 1] + decoded.featureBboxes[bboxOffset + 3]) / 2;
                renderedFeaturePickIds.add(pickId);
                addedPickIds.add(pickId);
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
                    extra: {
                        ...(ref?.extra || {}),
                        ...(ref?.id ? { featureId: ref.id } : {}),
                        ...(Number.isFinite(featureHash) ? { featureHash } : {}),
                        featureFamily,
                    },
                    renderBatch: {
                        chunkId: manifest.chunkId,
                        featureIndex: row.featureIndex,
                        detailsLoaded: false,
                        atIso: manifest.at,
                    },
                });
                for (let i = 0; i < row.pointCount; i += 1) {
                    if (!collection) {
                        collection = createPointCollection();
                    } else if (shouldChunkPointUpload && collectionPointCount >= pointUploadChunkSize) {
                        if (!(await flushPointUploadChunk())) return cleanupPartialRender();
                        collection = createPointCollection();
                    }
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
                    const slot: SatelliteApplySlot = {
                        index: pointCount,
                        targetId: pickId,
                        billboard,
                        scratch: new Cesium.Cartesian3(),
                        getVisible: () => this.resolveVisible(
                            visibilityId,
                            style?.layerId || manifest.layerId,
                            style?.subtype,
                            style?.sourceId,
                        ),
                    };
                    if (ref?.id) {
                        pointSlotsByFeatureId.set(ref.id, slot);
                        pickIdByFeatureId.set(ref.id, pickId);
                        featureIdByPickId.set(pickId, ref.id);
                    }
                    if (Number.isFinite(featureHash)) {
                        pointSlotsByFeatureHash.set(featureHash, slot);
                        pickIdByFeatureHash.set(featureHash, pickId);
                    }
                    pointSlotsByFeatureIndex.set(row.featureIndex, slot);
                    pickIdByFeatureIndex.set(row.featureIndex, pickId);
                    this.onPointAdd?.(pickId, billboard);
                    pointCount += 1;
                    collectionPointCount += 1;
                    pointWorkSinceCheck += 1;
                    if (
                        pointWorkSinceCheck >= REPLAY_POINT_WORK_CHECK_INTERVAL
                        && performance.now() - pointWorkStartedAt >= REPLAY_POINT_WORK_BUDGET_MS
                    ) {
                        await nextFrame();
                        if (isCancelled()) return cleanupPartialRender();
                        pointWorkStartedAt = performance.now();
                        pointWorkSinceCheck = 0;
                    }
                }
            }
            if (shouldChunkPointUpload && !(await flushPointUploadChunk())) return cleanupPartialRender();
        }

        const fillPositions = new Float64Array(decoded.fillPositions.length);
        const fillIndices = new Uint32Array(decoded.fillIndices.length);
        const fillColors = new Uint8Array((decoded.fillPositions.length / 3) * 4);
        const fillFeatureOrdinals = new Uint32Array(decoded.fillPositions.length / 3);
        const fillPickIds: string[] = [];
        let fillVertexCursor = 0;
        let fillIndexCursor = 0;

        const linePositions = new Float64Array(decoded.linePositions.length);
        const lineIndices = new Uint32Array(decoded.linePositions.length / 3);
        const lineColors = new Uint8Array((decoded.linePositions.length / 3) * 4);
        const lineFeatureOrdinals = new Uint32Array(decoded.linePositions.length / 3);
        const linePickIds: string[] = [];
        let lineVertexCursor = 0;
        let lineIndexCursor = 0;

        const shapeWorkChunkSize = Math.max(1, getReplayApplyChunkSize(manifest.layerId));
        let shapeWorkStartedAt = performance.now();
        let shapeRowsSinceCheck = 0;
        for (let rowIndex = 0; rowIndex < featureCount; rowIndex += 1) {
            if (isCancelled()) return cleanupPartialRender();
            const row = getFeatureRow(table, rowIndex);
            const style = manifest.styles[String(row.styleId)];
            const ref = refs[row.featureIndex];
            const featureHash = Number.isFinite(row.featureHash)
                ? (row.featureHash >>> 0)
                : (ref?.id ? stableHash32(ref.id) : Number.NaN);
            const featureFamily = ref?.family || featureFamilyForLayer(manifest.layerId);
            const props = getFeatureProperties(decoded, row.featureIndex);
            const pickId = makeRenderId(manifest.chunkId, row.featureIndex);
            const visibilityId = ref?.id || pickId;
            const visible = this.resolveVisible(
                visibilityId,
                style?.layerId || manifest.layerId,
                style?.subtype,
                style?.sourceId,
            );
            if (!visible) continue;
            const bboxOffset = rowIndex * 4;
            const lng = (decoded.featureBboxes[bboxOffset] + decoded.featureBboxes[bboxOffset + 2]) / 2;
            const lat = (decoded.featureBboxes[bboxOffset + 1] + decoded.featureBboxes[bboxOffset + 3]) / 2;
            renderedFeaturePickIds.add(pickId);
            if (!replayRenderBatchMetaMap.has(pickId)) {
                addedPickIds.add(pickId);
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
                    extra: {
                        ...(ref?.extra || {}),
                        ...(ref?.id ? { featureId: ref.id } : {}),
                        ...(Number.isFinite(featureHash) ? { featureHash } : {}),
                        featureFamily,
                    },
                    renderBatch: {
                        chunkId: manifest.chunkId,
                        featureIndex: row.featureIndex,
                        detailsLoaded: false,
                        atIso: manifest.at,
                    },
                });
            }

            if (row.fillVertexCount > 0 && row.indexCount > 0) {
                const positions = decoded.fillPositions.subarray(row.fillStart * 3, (row.fillStart + row.fillVertexCount) * 3);
                fillPositions.set(positions, fillVertexCursor * 3);
                const color = colorForStyle(manifest.layerId, style?.subtype, visible ? 0.22 : 0);
                const featureOrdinal = fillPickIds.length;
                fillPickIds.push(pickId);
                for (let i = 0; i < row.fillVertexCount; i += 1) {
                    writeDenseColor(color, fillColors, fillVertexCursor + i);
                    fillFeatureOrdinals[fillVertexCursor + i] = featureOrdinal;
                }
                for (let i = 0; i < row.indexCount; i += 1) {
                    fillIndices[fillIndexCursor + i] = fillVertexCursor + (decoded.fillIndices[row.indexStart + i] - row.fillStart);
                }
                fillVertexCursor += row.fillVertexCount;
                fillIndexCursor += row.indexCount;
                shapeCount += 1;
            }

            if (row.lineVertexCount > 0) {
                const positions = decoded.linePositions.subarray(row.lineStart * 3, (row.lineStart + row.lineVertexCount) * 3);
                linePositions.set(positions, lineVertexCursor * 3);
                const color = colorForStyle(manifest.layerId, style?.subtype, visible ? 0.8 : 0);
                const featureOrdinal = linePickIds.length;
                linePickIds.push(pickId);
                for (let i = 0; i < row.lineVertexCount; i += 1) {
                    writeDenseColor(color, lineColors, lineVertexCursor + i);
                    lineFeatureOrdinals[lineVertexCursor + i] = featureOrdinal;
                    lineIndices[lineIndexCursor + i] = lineVertexCursor + i;
                }
                lineVertexCursor += row.lineVertexCount;
                lineIndexCursor += row.lineVertexCount;
                shapeCount += 1;
            }
            shapeRowsSinceCheck += 1;
            if (
                shapeRowsSinceCheck >= shapeWorkChunkSize
                && performance.now() - shapeWorkStartedAt >= REPLAY_SHAPE_WORK_BUDGET_MS
            ) {
                await nextFrame();
                if (isCancelled()) return cleanupPartialRender();
                shapeWorkStartedAt = performance.now();
                shapeRowsSinceCheck = 0;
            }
        }

        if (fillVertexCursor > 0 && fillIndexCursor > 0) {
            const primitive = new ReplayDenseGeometryPrimitive({
                kind: 'fill',
                positions: fillPositions.subarray(0, fillVertexCursor * 3),
                indices: fillIndices.subarray(0, fillIndexCursor),
                colors: fillColors.subarray(0, fillVertexCursor * 4),
                featureOrdinals: fillFeatureOrdinals.subarray(0, fillVertexCursor),
                pickIds: fillPickIds,
                debugLabel: `${manifest.layerId}:${manifest.chunkId}:fill`,
            });
            this.scene.primitives.add(primitive as any);
            primitives.push(primitive);
            await yieldForPrimitiveUpload(this.scene);
        }
        if (isCancelled()) return cleanupPartialRender();
        if (lineVertexCursor > 0 && lineIndexCursor > 0) {
            const primitive = new ReplayDenseGeometryPrimitive({
                kind: 'line',
                positions: linePositions.subarray(0, lineVertexCursor * 3),
                indices: lineIndices.subarray(0, lineIndexCursor),
                colors: lineColors.subarray(0, lineVertexCursor * 4),
                featureOrdinals: lineFeatureOrdinals.subarray(0, lineVertexCursor),
                pickIds: linePickIds,
                debugLabel: `${manifest.layerId}:${manifest.chunkId}:line`,
            });
            this.scene.primitives.add(primitive as any);
            primitives.push(primitive);
            await yieldForPrimitiveUpload(this.scene);
        }
        if (isCancelled()) return cleanupPartialRender();

        for (let i = 0; i < decoded.trackRows.length; i += 4) {
            const featureIndex = decoded.trackRows[i];
            const sampleStart = decoded.trackRows[i + 1];
            const sampleCount = decoded.trackRows[i + 2];
            if (sampleCount === 0) continue;
            const targetId = makeRenderId(manifest.chunkId, featureIndex);
            if (!renderedFeaturePickIds.has(targetId)) continue;
            motionTracks.push({
                targetId,
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
            featureCount: renderedFeaturePickIds.size,
            motionTrackCount: motionTracks.length,
            footprintCount: footprints.length,
            motionTracks,
            footprints,
        };
    }
}
