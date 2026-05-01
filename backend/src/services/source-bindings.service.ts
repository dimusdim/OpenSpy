import fs from 'fs';
import path from 'path';

export type CanonicalTarget = 'events' | 'assets' | 'entities' | 'observations' | 'orbital_elements';

export type RawCaptureMode = 'none' | 'snapshot';
export type IngestDurabilityMode = 'none' | 'persisted_buffer' | 'accepted_loss';

export interface IngestDurabilityContract {
    mode: IngestDurabilityMode;
    scope: string;
    bufferId?: string;
    lossModel?: string;
}

export interface SourceBindingDefinition {
    sourceId: string;
    layerId: string;
    canonicalTarget: CanonicalTarget;
    recordKind: string;
    transformerId: string;
    writerId: string;
    storagePolicyId: string;
    ingestDurability?: IngestDurabilityContract;
    rawCaptureMode: RawCaptureMode;
    rawFormat: 'json' | 'geojson' | 'csv' | 'jsonl';
    coverageScope?: 'global' | 'regional' | 'viewport' | 'derived';
    coverageBbox?: [number, number, number, number];
    notes?: string;
}

export interface SourceTransformerDefinition {
    transformerId: string;
    outputKind: CanonicalTarget;
}

export interface SourceWriterDefinition {
    writerId: string;
    canonicalTarget: CanonicalTarget;
}

export interface SourceStoragePolicyDefinition {
    storagePolicyId: string;
    canonicalTarget: CanonicalTarget;
}

export interface SourceExecutionPlan {
    binding: SourceBindingDefinition;
    transformer: SourceTransformerDefinition;
    writer: SourceWriterDefinition;
    storagePolicy: SourceStoragePolicyDefinition;
}

type SourceBindingsDoc = {
    version: number;
    contractSourceOfTruth?: 'json';
    versioningPolicy?: {
        mode?: 'git_reviewed_json';
        runtimeDbOverrides?: boolean;
        adminEditing?: 'separate_product_requirement';
    };
    sources?: SourceBindingDefinition[];
};

const SOURCE_BINDINGS_FILE = path.resolve(__dirname, '../../..', 'config/source-bindings.json');

export const TRANSFORMER_REGISTRY: Record<string, SourceTransformerDefinition> = {
    'opensky-state-vector': { transformerId: 'opensky-state-vector', outputKind: 'entities' },
    'aisstream-position-and-static': { transformerId: 'aisstream-position-and-static', outputKind: 'entities' },
    'ioda-outage-alert': { transformerId: 'ioda-outage-alert', outputKind: 'events' },
    'acled-conflict-event': { transformerId: 'acled-conflict-event', outputKind: 'events' },
    'gdelt-conflict-event': { transformerId: 'gdelt-conflict-event', outputKind: 'events' },
    'tle-catalog': { transformerId: 'tle-catalog', outputKind: 'orbital_elements' },
    'cloudflare-radar-outage': { transformerId: 'cloudflare-radar-outage', outputKind: 'events' },
    'gfw-event': { transformerId: 'gfw-event', outputKind: 'events' },
    'openaip-airspace-zone': { transformerId: 'openaip-airspace-zone', outputKind: 'assets' },
    'overture-pipeline-centroid': { transformerId: 'overture-pipeline-centroid', outputKind: 'assets' },
    'overture-pipeline-geometry': { transformerId: 'overture-pipeline-geometry', outputKind: 'assets' },
    'telegeography-cable-geojson': { transformerId: 'telegeography-cable-geojson', outputKind: 'assets' },
    'gpsjam-h3-zone': { transformerId: 'gpsjam-h3-zone', outputKind: 'events' },
    'firms-active-fire-csv': { transformerId: 'firms-active-fire-csv', outputKind: 'events' },
    'gdacs-disaster-event': { transformerId: 'gdacs-disaster-event', outputKind: 'events' },
    'usgs-earthquake-event': { transformerId: 'usgs-earthquake-event', outputKind: 'events' },
    'eonet-natural-event': { transformerId: 'eonet-natural-event', outputKind: 'events' },
    'wigle-wifi-observation': { transformerId: 'wigle-wifi-observation', outputKind: 'observations' },
};

export const WRITER_REGISTRY: Record<string, SourceWriterDefinition> = {
    'position-fix-entity': { writerId: 'position-fix-entity', canonicalTarget: 'entities' },
    'event-snapshot': { writerId: 'event-snapshot', canonicalTarget: 'events' },
    'orbital-elements-entity': { writerId: 'orbital-elements-entity', canonicalTarget: 'orbital_elements' },
    'asset-snapshot': { writerId: 'asset-snapshot', canonicalTarget: 'assets' },
    'observation-state': { writerId: 'observation-state', canonicalTarget: 'observations' },
};

export const STORAGE_POLICY_REGISTRY: Record<string, SourceStoragePolicyDefinition> = {
    'time-series-position-fixes': { storagePolicyId: 'time-series-position-fixes', canonicalTarget: 'entities' },
    'event-snapshots': { storagePolicyId: 'event-snapshots', canonicalTarget: 'events' },
    'event-snapshots-incremental': { storagePolicyId: 'event-snapshots-incremental', canonicalTarget: 'events' },
    'event-snapshots-high-volume': { storagePolicyId: 'event-snapshots-high-volume', canonicalTarget: 'events' },
    'orbital-elements-history': { storagePolicyId: 'orbital-elements-history', canonicalTarget: 'orbital_elements' },
    'versioned-assets': { storagePolicyId: 'versioned-assets', canonicalTarget: 'assets' },
    'observation-state-history': { storagePolicyId: 'observation-state-history', canonicalTarget: 'observations' },
};

function readSourceBindingsDoc(): SourceBindingsDoc {
    return JSON.parse(fs.readFileSync(SOURCE_BINDINGS_FILE, 'utf8')) as SourceBindingsDoc;
}

const BINDINGS_DOC = readSourceBindingsDoc();
if (BINDINGS_DOC.contractSourceOfTruth !== 'json') {
    throw new Error(`${SOURCE_BINDINGS_FILE} must declare contractSourceOfTruth=json`);
}
if (BINDINGS_DOC.versioningPolicy?.mode !== 'git_reviewed_json' || BINDINGS_DOC.versioningPolicy?.runtimeDbOverrides !== false) {
    throw new Error(`${SOURCE_BINDINGS_FILE} must use git_reviewed_json with runtimeDbOverrides=false`);
}

export const SOURCE_BINDINGS: Record<string, SourceBindingDefinition> = {};

for (const binding of BINDINGS_DOC.sources || []) {
    if (!binding.sourceId || !binding.layerId || !binding.canonicalTarget || !binding.recordKind || !binding.transformerId || !binding.writerId || !binding.storagePolicyId) {
        throw new Error(`Invalid source binding entry in ${SOURCE_BINDINGS_FILE}`);
    }
    if (binding.coverageBbox && binding.coverageBbox.length !== 4) {
        throw new Error(`Invalid source binding coverage bbox for source_id=${binding.sourceId}`);
    }
    SOURCE_BINDINGS[binding.sourceId] = { ...binding };
}

for (const sourceId of Object.keys(SOURCE_BINDINGS)) {
    getSourceExecutionPlan(sourceId);
}

export function getSourceBinding(sourceId: string | null | undefined): SourceBindingDefinition | null {
    if (!sourceId) return null;
    return SOURCE_BINDINGS[sourceId] || null;
}

export function getSourceExecutionPlan(sourceId: string | null | undefined): SourceExecutionPlan | null {
    const binding = getSourceBinding(sourceId);
    if (!binding) return null;
    const transformer = TRANSFORMER_REGISTRY[binding.transformerId];
    if (!transformer) {
        throw new Error(`Missing source transformer registry entry for transformerId=${binding.transformerId} source_id=${binding.sourceId}`);
    }
    const writer = WRITER_REGISTRY[binding.writerId];
    if (!writer) {
        throw new Error(`Missing source writer registry entry for writerId=${binding.writerId} source_id=${binding.sourceId}`);
    }
    const storagePolicy = STORAGE_POLICY_REGISTRY[binding.storagePolicyId];
    if (!storagePolicy) {
        throw new Error(`Missing source storage policy registry entry for storagePolicyId=${binding.storagePolicyId} source_id=${binding.sourceId}`);
    }
    if (transformer.outputKind !== binding.canonicalTarget) {
        throw new Error(`Source transformer output mismatch for source_id=${binding.sourceId}: transformer=${transformer.outputKind} binding=${binding.canonicalTarget}`);
    }
    if (writer.canonicalTarget !== binding.canonicalTarget) {
        throw new Error(`Source writer target mismatch for source_id=${binding.sourceId}: writer=${writer.canonicalTarget} binding=${binding.canonicalTarget}`);
    }
    if (storagePolicy.canonicalTarget !== binding.canonicalTarget) {
        throw new Error(`Source storage policy target mismatch for source_id=${binding.sourceId}: storage=${storagePolicy.canonicalTarget} binding=${binding.canonicalTarget}`);
    }
    return { binding, transformer, writer, storagePolicy };
}

export function requireSourceExecutionPlan(sourceId: string | null | undefined): SourceExecutionPlan {
    const plan = getSourceExecutionPlan(sourceId);
    if (!plan) {
        throw new Error(`Missing source binding for source_id=${sourceId || '<empty>'}`);
    }
    return plan;
}

export const sourceBindingTestHooks = {
    getSourceExecutionPlan,
    requireSourceExecutionPlan,
    transformerIds: Object.keys(TRANSFORMER_REGISTRY),
    writerIds: Object.keys(WRITER_REGISTRY),
    storagePolicyIds: Object.keys(STORAGE_POLICY_REGISTRY),
};
