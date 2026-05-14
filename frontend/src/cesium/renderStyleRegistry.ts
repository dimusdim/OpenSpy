import * as Cesium from 'cesium';
import {
    getAviIcon,
    getConflictIcon,
    getDisasterIcon,
    getIconOpacity,
    getIconScale,
    getMapIcon,
    getOutageIcon,
    getSatIcon,
    getShipIcon,
    svgUri,
} from '../icons/map-icons';
import layerContractsDoc from '../../../config/layer-contracts.json';

export type RenderStyleLike = {
    subtype?: string | null;
    variant?: string | null;
};

export type RenderFeatureFamily = 'entity' | 'event' | 'asset';
export type RenderMotionModel = 'observed_fixes' | 'tle_sgp4' | 'none';
export type ReplayHydrationStage = 'primary' | 'eager' | 'background';
export type ReplayPointDeltaMode = 'entity' | 'satellite' | 'db-point' | false;
export type ReplayScope = 'live_only_context';
export type GeometryComplexity = 'point' | 'bounded_geometry' | 'polygon_heavy';
export type RenderGeometryPolicy = 'none' | 'materialized_lod';

type LayerStyleContract = {
    hudName: string;
    color: string;
    pointIcon?: string;
    pointScale?: number;
    reconPointScale?: number;
    fillColor?: string;
    fillAlpha?: number;
    strokeColor?: string;
    strokeAlpha?: number;
    subtypeColors?: Record<string, string>;
};

type LayerContractEntry = {
    layerId: string;
    render: {
        family: RenderFeatureFamily;
        frontendStoreKey?: string;
        replayScope?: ReplayScope;
        motionModel: RenderMotionModel;
        historyMode: string;
        coverageScope: string;
        bucketSeconds: number;
        replayBlocking: boolean;
        detailsOnDemand: boolean;
        minimalRenderProperties: boolean;
        simplifiedRenderGeometry: boolean;
        simplifyTolerance?: number | null;
        geometryComplexity?: GeometryComplexity;
        renderGeometryPolicy?: RenderGeometryPolicy;
        renderGeometryColumn?: 'geom_render_low';
        staticAsset: boolean;
        renderBatch: boolean;
        motionSourceId?: string;
        motionMaxGapFallbackSec?: number;
        maxSpeedMps?: number;
        pointDeltaMode: ReplayPointDeltaMode;
        replayHydrationStage?: ReplayHydrationStage;
        replayHydrationParallel?: boolean;
        seekPriority?: number;
        playbackPriority?: number;
        playbackRefreshSeconds?: number;
        hotBucketTtlSeconds?: number | null;
        applyChunkSize?: number;
        motionTrackRefreshSeconds?: number;
    };
    style?: LayerStyleContract;
};

const LAYER_ALIASES: Record<string, string> = (layerContractsDoc.aliases || {}) as Record<string, string>;
const LAYERS_BY_ID = new Map<string, LayerContractEntry>(
    ((layerContractsDoc.layers || []) as LayerContractEntry[]).map((entry) => [entry.layerId, entry]),
);

function normalizeLayerId(layerId: string): string {
    return LAYER_ALIASES[layerId] || layerId;
}

function getLayerContract(layerId: string): LayerContractEntry {
    const normalized = normalizeLayerId(layerId);
    const contract = LAYERS_BY_ID.get(normalized);
    if (!contract) throw new Error(`Missing replay layer contract for layer_id=${normalized}`);
    return contract;
}

function getStyleContract(layerId: string): LayerStyleContract {
    const contract = getLayerContract(layerId);
    if (!contract.style) throw new Error(`Missing replay render style contract for layer_id=${contract.layerId}`);
    return contract.style;
}

function getReplayRenderContract(layerId: string): LayerContractEntry {
    const contract = getLayerContract(layerId);
    if (!contract.render.renderBatch) {
        throw new Error(`Layer is not registered for replay render batches: layer_id=${contract.layerId}`);
    }
    return contract;
}

function requireNumberField(contract: LayerContractEntry, field: keyof LayerContractEntry['render']): number {
    const value = contract.render[field];
    if (!Number.isFinite(value)) {
        throw new Error(`Missing numeric replay render contract field ${String(field)} for layer_id=${contract.layerId}`);
    }
    return Number(value);
}

function requireNullableNumberField(contract: LayerContractEntry, field: keyof LayerContractEntry['render']): number | null {
    if (!Object.prototype.hasOwnProperty.call(contract.render, field)) {
        throw new Error(`Missing replay render contract field ${String(field)} for layer_id=${contract.layerId}`);
    }
    const value = contract.render[field];
    if (value === null) return null;
    if (!Number.isFinite(value)) {
        throw new Error(`Invalid replay render contract field ${String(field)} for layer_id=${contract.layerId}`);
    }
    return Number(value);
}

function requireBooleanField(contract: LayerContractEntry, field: keyof LayerContractEntry['render']): boolean {
    const value = contract.render[field];
    if (typeof value !== 'boolean') {
        throw new Error(`Missing boolean replay render contract field ${String(field)} for layer_id=${contract.layerId}`);
    }
    return value;
}

function requireHydrationStage(contract: LayerContractEntry): ReplayHydrationStage {
    const value = contract.render.replayHydrationStage;
    if (value !== 'primary' && value !== 'eager' && value !== 'background') {
        throw new Error(`Missing replayHydrationStage contract for layer_id=${contract.layerId}`);
    }
    return value;
}

export function assertReplayStyleLayer(layerId: string): void {
    getStyleContract(layerId);
}

export function toHudLayerName(layerId: string): string {
    return getStyleContract(layerId).hudName;
}

export function featureFamilyForLayer(layerId: string): RenderFeatureFamily {
    const contract = getReplayRenderContract(layerId);
    if (!contract.style) {
        throw new Error(`Layer is not registered for replay render batches: layer_id=${contract.layerId}`);
    }
    return contract.render.family;
}

export function isReplayRenderBatchLayer(layerId: string): boolean {
    return getLayerContract(layerId).render.renderBatch;
}

export function listReplayStoreLayerBindings(): Array<{ storeKey: string; layerId: string }> {
    return ((layerContractsDoc.layers || []) as LayerContractEntry[])
        .filter((entry) =>
            Boolean(entry.render.frontendStoreKey)
            && entry.render.renderBatch
            && entry.render.historyMode !== 'none',
        )
        .map((entry) => ({
            storeKey: String(entry.render.frontendStoreKey),
            layerId: entry.layerId,
        }));
}

export function getReplayScope(layerId: string): ReplayScope | null {
    return getLayerContract(layerId).render.replayScope || null;
}

export function getReplayMotionModel(layerId: string): RenderMotionModel {
    return getReplayRenderContract(layerId).render.motionModel;
}

export function isReplayMotionLayer(layerId: string): boolean {
    return getReplayMotionModel(layerId) !== 'none';
}

export function isReplayMovingFixLayer(layerId: string): boolean {
    return getReplayMotionModel(layerId) === 'observed_fixes';
}

export function getReplayPointDeltaMode(layerId: string): ReplayPointDeltaMode {
    return getReplayRenderContract(layerId).render.pointDeltaMode;
}

export function canReplayPointDelta(layerId: string): boolean {
    return getReplayPointDeltaMode(layerId) !== false;
}

export function canReplayPointDeltaBeforeFullSync(layerId: string): boolean {
    return canReplayPointDelta(layerId) && isReplayMotionLayer(layerId);
}

export function isReplayCriticalDeltaLayer(layerId: string): boolean {
    return canReplayPointDelta(layerId) && isReplayMotionLayer(layerId);
}

export function canReuseStaticReplayBucket(layerId: string): boolean {
    const contract = getReplayRenderContract(layerId);
    return contract.render.staticAsset === true && contract.render.historyMode === 'versioned_assets';
}

export function getReplayHydrationStage(layerId: string): ReplayHydrationStage {
    return requireHydrationStage(getReplayRenderContract(layerId));
}

export function shouldRunReplayHydrationInParallel(layerId: string): boolean {
    return requireBooleanField(getReplayRenderContract(layerId), 'replayHydrationParallel');
}

export function getReplaySeekPriority(layerId: string): number {
    return requireNumberField(getReplayRenderContract(layerId), 'seekPriority');
}

export function getReplayPlaybackPriority(layerId: string): number {
    return requireNumberField(getReplayRenderContract(layerId), 'playbackPriority');
}

export function getReplayPlaybackRefreshSeconds(layerId: string): number {
    return requireNumberField(getReplayRenderContract(layerId), 'playbackRefreshSeconds');
}

export function getReplayApplyChunkSize(layerId: string): number {
    return requireNumberField(getReplayRenderContract(layerId), 'applyChunkSize');
}

export function getReplayLayerBucketSeconds(layerId: string): number {
    return requireNumberField(getReplayRenderContract(layerId), 'bucketSeconds');
}

export function getReplayLayerHotTtlMs(layerId: string): number | null {
    const seconds = requireNullableNumberField(getReplayRenderContract(layerId), 'hotBucketTtlSeconds');
    return seconds === null ? null : seconds * 1000;
}

export function getReplayMotionTrackRefreshSeconds(layerId: string): number {
    const contract = getReplayRenderContract(layerId);
    if (contract.render.motionModel === 'none') {
        throw new Error(`Layer has no replay motion track contract: layer_id=${contract.layerId}`);
    }
    return requireNumberField(contract, 'motionTrackRefreshSeconds');
}

function colorForLayer(layerId: string, alpha: number): Cesium.Color {
    const base = Cesium.Color.fromCssColorString(getStyleContract(layerId).color);
    return Cesium.Color.fromAlpha(base, alpha);
}

function jammingColor(subtype: string | null | undefined, alpha: number): Cesium.Color {
    if (subtype === 'high') return Cesium.Color.fromAlpha(Cesium.Color.fromCssColorString('#ef4444'), alpha);
    if (subtype === 'low') return Cesium.Color.fromAlpha(Cesium.Color.fromCssColorString('#eab308'), alpha);
    return Cesium.Color.fromAlpha(Cesium.Color.fromCssColorString('#f97316'), alpha);
}

export function colorForStyle(layerId: string, subtype: string | null | undefined, alpha: number): Cesium.Color {
    assertReplayStyleLayer(layerId);
    if (layerId === 'jamming') return jammingColor(subtype, alpha);
    return colorForLayer(layerId, alpha);
}

export function pointIconForStyle(layerId: string, style: RenderStyleLike | undefined): string {
    const contract = getStyleContract(layerId);
    const subtype = style?.subtype || undefined;
    const variant = style?.variant || undefined;
    switch (contract.pointIcon) {
        case 'aircraft':
            return getAviIcon(subtype || 'general');
        case 'vessel':
            return getShipIcon(subtype || 'unknown');
        case 'satellite':
            return getSatIcon(subtype || 'civilian', variant === 'recon' || subtype === 'recon');
        case 'disaster':
            return getDisasterIcon(subtype || 'XX', variant || 'Green');
        case 'conflict':
            return getConflictIcon(variant || subtype || 'violence');
        case 'outage':
            return getOutageIcon(subtype || 'warning');
        case 'fire':
            return getMapIcon('fires', subtype || 'high') || svgUri('<circle cx="12" cy="12" r="7" fill="#ef4444"/>');
        case 'gfw':
            return getMapIcon('gfw', 'default') || svgUri('<circle cx="12" cy="12" r="7" fill="#22c55e"/>');
        case 'asset':
            return getMapIcon('asset', 'default') || svgUri('<circle cx="12" cy="12" r="7" fill="#38bdf8"/>');
        case 'jamming':
            return getMapIcon('jamming', subtype || 'medium') || svgUri('<circle cx="12" cy="12" r="7" fill="#f97316"/>');
        default:
            throw new Error(`Missing replay point-icon contract for layer_id=${normalizeLayerId(layerId)}`);
    }
}

export function styleLikeForReplayFeature(layerId: string, feature: any): RenderStyleLike {
    const contract = getStyleContract(layerId);
    const subtype = feature?.subtype || null;
    const props = feature?.properties || feature?.entity_properties || feature?.position_properties || {};
    switch (contract.pointIcon) {
        case 'satellite': {
            const isRecon = subtype === 'recon' || Boolean(props?.recon) || Boolean(props?.reconMeta);
            return { subtype: isRecon ? 'recon' : subtype || 'civilian', variant: isRecon ? 'recon' : null };
        }
        case 'disaster':
            return { subtype: subtype || 'EQ', variant: props?.alertLevel || props?.alert_level || 'Green' };
        case 'conflict':
            return { subtype, variant: props?.event_type || props?.eventType || subtype || 'violence' };
        default:
            return { subtype };
    }
}

export function baseColorForSatellite(subtype: string | null | undefined): Cesium.Color {
    if (subtype === 'military' || subtype === 'recon') return Cesium.Color.RED;
    if (subtype === 'commercial') return Cesium.Color.CYAN;
    return Cesium.Color.LIME;
}

function pointScaleForLayer(layerId: string): number {
    const scale = getStyleContract(layerId).pointScale;
    return Number.isFinite(scale) ? Number(scale) : 1.1;
}

function iconTargetForStyle(layerId: string, style: RenderStyleLike | undefined): { layer: string; subtype: string } {
    const contract = getStyleContract(layerId);
    const subtype = style?.subtype || undefined;
    const variant = style?.variant || undefined;
    switch (contract.pointIcon) {
        case 'aircraft':
            return { layer: 'aviation', subtype: subtype || 'general' };
        case 'vessel':
            return { layer: 'maritime', subtype: subtype || 'unknown' };
        case 'satellite':
            return { layer: 'satellites', subtype: variant === 'recon' || subtype === 'recon' ? 'recon' : subtype || 'civilian' };
        case 'disaster':
            return { layer: 'disasters', subtype: subtype || 'XX' };
        case 'conflict':
            return { layer: 'conflicts', subtype: variant || subtype || 'violence' };
        case 'outage':
            return { layer: 'outages', subtype: subtype || 'warning' };
        case 'fire':
            return { layer: 'fires', subtype: subtype || 'high' };
        case 'gfw':
            return { layer: 'gfw', subtype: 'default' };
        case 'asset':
            return { layer: 'asset', subtype: 'default' };
        case 'jamming':
            return { layer: 'jamming', subtype: subtype || 'medium' };
        default:
            return { layer: 'asset', subtype: 'default' };
    }
}

export function pointScaleForStyle(layerId: string, style: RenderStyleLike | undefined): number {
    const contract = getStyleContract(layerId);
    const target = iconTargetForStyle(layerId, style);
    if (contract.pointIcon === 'satellite' && (style?.variant === 'recon' || style?.subtype === 'recon')) {
        const scale = Number.isFinite(contract.reconPointScale) ? Number(contract.reconPointScale) : 1.8;
        return getIconScale(target.layer, target.subtype, scale);
    }
    return getIconScale(target.layer, target.subtype, pointScaleForLayer(layerId));
}

export function pointOpacityForStyle(layerId: string, style: RenderStyleLike | undefined): number {
    const target = iconTargetForStyle(layerId, style);
    return getIconOpacity(target.layer, target.subtype);
}

function layerColorWithAlpha(layerId: string, cssColor: string | undefined, alpha: number | undefined, fallbackAlpha: number): Cesium.Color {
    const style = getStyleContract(layerId);
    return Cesium.Color.fromCssColorString(cssColor || style.color).withAlpha(Number.isFinite(alpha) ? Number(alpha) : fallbackAlpha);
}

function subtypeColor(style: LayerStyleContract, subtype: string | null | undefined): string | undefined {
    if (!subtype) return undefined;
    return style.subtypeColors?.[subtype] || style.subtypeColors?.[String(subtype).toLowerCase()];
}

export function fillColorForStyle(layerId: string, subtype: string | null | undefined): Cesium.Color {
    const style = getStyleContract(layerId);
    return layerColorWithAlpha(layerId, subtypeColor(style, subtype) || style.fillColor, style.fillAlpha, 0.15);
}

export function strokeColorForStyle(layerId: string, subtype: string | null | undefined): Cesium.Color {
    const style = getStyleContract(layerId);
    return layerColorWithAlpha(layerId, subtypeColor(style, subtype) || style.strokeColor, style.strokeAlpha, 1.0);
}
