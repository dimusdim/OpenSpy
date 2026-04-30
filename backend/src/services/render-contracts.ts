import fs from 'fs';
import path from 'path';

export type RenderFeatureFamily = 'entity' | 'event' | 'asset';
export type RenderMotionModel = 'observed_fixes' | 'tle_sgp4' | 'none';
export type PointDeltaMode = 'entity' | 'satellite' | 'db-point' | false;
export type ReplayHydrationStage = 'primary' | 'eager' | 'background';
export type ReplayScope = 'live_only_context';
export type GeometryComplexity = 'point' | 'bounded_geometry' | 'polygon_heavy';
export type RenderGeometryPolicy = 'none' | 'materialized_lod';

export interface LayerRenderContract {
    layerId: string;
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
    pointDeltaMode: PointDeltaMode;
    replayHydrationStage?: ReplayHydrationStage;
    replayHydrationParallel?: boolean;
    seekPriority?: number;
    playbackPriority?: number;
    playbackRefreshSeconds?: number;
    hotBucketTtlSeconds?: number | null;
    applyChunkSize?: number;
    motionTrackRefreshSeconds?: number;
}

type LayerContractsDoc = {
    version: number;
    contractSourceOfTruth?: 'json';
    versioningPolicy?: {
        mode?: 'git_reviewed_json';
        runtimeDbOverrides?: boolean;
        adminEditing?: 'separate_product_requirement';
    };
    aliases?: Record<string, string>;
    layers?: Array<{
        layerId?: string;
        displayName?: string;
        render?: Omit<LayerRenderContract, 'layerId'>;
        style?: Record<string, unknown>;
    }>;
};

const LAYER_CONTRACTS_FILE = path.resolve(__dirname, '../../..', 'config/layer-contracts.json');

export class UnknownLayerRenderContractError extends Error {
    constructor(layerId: string) {
        super(`Missing render contract for layer_id=${layerId}`);
        this.name = 'UnknownLayerRenderContractError';
    }
}

function readContractsDoc(): LayerContractsDoc {
    return JSON.parse(fs.readFileSync(LAYER_CONTRACTS_FILE, 'utf8')) as LayerContractsDoc;
}

const CONTRACT_DOC = readContractsDoc();
if (CONTRACT_DOC.contractSourceOfTruth !== 'json') {
    throw new Error(`${LAYER_CONTRACTS_FILE} must declare contractSourceOfTruth=json`);
}
if (CONTRACT_DOC.versioningPolicy?.mode !== 'git_reviewed_json' || CONTRACT_DOC.versioningPolicy?.runtimeDbOverrides !== false) {
    throw new Error(`${LAYER_CONTRACTS_FILE} must use git_reviewed_json with runtimeDbOverrides=false`);
}
const LAYER_ALIASES = CONTRACT_DOC.aliases || {};
const CONTRACTS: Record<string, LayerRenderContract> = {};

for (const entry of CONTRACT_DOC.layers || []) {
    if (!entry.layerId || !entry.render) {
        throw new Error(`Invalid layer contract entry in ${LAYER_CONTRACTS_FILE}`);
    }
    CONTRACTS[entry.layerId] = {
        layerId: entry.layerId,
        ...entry.render,
    };
}

export function normalizeLayerId(layerId: string): string {
    return LAYER_ALIASES[layerId] || layerId;
}

export function hasLayerRenderContract(layerId: string): boolean {
    return Boolean(CONTRACTS[normalizeLayerId(layerId)]);
}

export function tryGetLayerRenderContract(layerId: string): LayerRenderContract | null {
    const normalized = normalizeLayerId(layerId);
    const contract = CONTRACTS[normalized];
    return contract ? { ...contract } : null;
}

export function getLayerRenderContract(layerId: string): LayerRenderContract {
    const normalized = normalizeLayerId(layerId);
    const contract = CONTRACTS[normalized];
    if (!contract) throw new UnknownLayerRenderContractError(normalized);
    return { ...contract };
}

export function listLayerRenderContracts(): LayerRenderContract[] {
    return Object.values(CONTRACTS).map((contract) => ({ ...contract }));
}
