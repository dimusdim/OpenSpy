import { CatalogReadService } from './catalog-read.service';
import { ViewStateRepository, type ViewStatePayload } from '../repositories/view-state.repository';

type LegendTarget = 'sources' | 'visibility';

const LAYER_KEY_BY_LAYER_ID: Record<string, string> = {
    aircraft: 'aviation',
    vessel: 'maritime',
    satellite: 'satellites',
    gfw: 'gfw',
    outage: 'outages',
    fire: 'fires',
    airspace: 'airspace',
    pipeline: 'pipelines',
    cable: 'cables',
    webcam: 'webcams',
    traffic: 'traffic',
    conflict: 'conflicts',
    disasters: 'disasters',
    jamming: 'jamming',
    border: 'labels',
    'imagery-overlay': 'satellite_imagery',
    infrastructure: 'infrastructure',
    'dark-vessel': 'maritime',
};

const LAYER_KEY_BY_RAW_ID: Record<string, string> = {
    aircraft: 'aviation',
    vessels: 'maritime',
    satellites: 'satellites',
    gfw_events: 'gfw',
    outages: 'outages',
    fires: 'fires',
    airspace: 'airspace',
    pipelines: 'pipelines',
    cables: 'cables',
    webcams: 'webcams',
    traffic: 'traffic',
    conflicts: 'conflicts',
    disasters: 'disasters',
    jamming: 'jamming',
    borders: 'labels',
    imagery: 'satellite_imagery',
    power_generation: 'infrastructure',
    power_transmission: 'infrastructure',
    military_sites: 'infrastructure',
    refineries: 'infrastructure',
    comm_towers: 'infrastructure',
    water_infra: 'infrastructure',
    dark_vessels: 'maritime',
};

type TaxonomyNode = {
    node_id: string;
    parent_node_id?: string | null;
    node_kind?: string;
    slug?: string;
    label?: string;
    layer_id?: string | null;
    source_id?: string | null;
    icon_key?: string | null;
    metadata?: Record<string, any>;
};

const LEGEND_NODE_ALIASES: Record<string, string> = {
    air: 'air',
    aviation: 'air/aircraft',
    aircraft: 'air/aircraft',
    airspace: 'air/airspace',
    jamming: 'air/jamming',
    gnss_jamming: 'air/jamming',
    sea: 'maritime',
    maritime: 'maritime',
    vessel: 'maritime/vessels',
    vessels: 'maritime/vessels',
    satellite: 'space/satellites',
    satellites: 'space/satellites',
    fires: 'ground-events/fires',
    fire: 'ground-events/fires',
    conflict: 'ground-events/conflicts',
    conflicts: 'ground-events/conflicts',
    disasters: 'ground-events/disasters',
    infrastructure: 'infrastructure',
    pipelines: 'infrastructure/oil-gas/pipelines',
    pipeline: 'infrastructure/oil-gas/pipelines',
    infrastructure_cables: 'infrastructure/telecom-infra/cables',
    infrastructure_telecom: 'infrastructure/telecom-infra',
    telecom_cables: 'infrastructure/telecom-infra/cables',
    cables: 'infrastructure/telecom-infra/cables',
    cable: 'infrastructure/telecom-infra/cables',
    wifi: 'connectivity/wifi',
    outages: 'connectivity/outages',
    outage: 'connectivity/outages',
};

function cloneObject(value: any): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeLegendNodeId(nodeId: string): string {
    const raw = String(nodeId || '').trim();
    if (!raw) return '';
    const key = raw.replace(/-/g, '_').replace(/\//g, '_').toLowerCase();
    return LEGEND_NODE_ALIASES[key] || raw;
}

function mergeViewState(current: ViewStatePayload, patch: Record<string, any>): ViewStatePayload {
    const next: ViewStatePayload = { ...current };

    for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            next[key] = {
                ...cloneObject(current[key]),
                ...value,
            };
        } else {
            next[key] = value;
        }
    }

    return next;
}

export class ViewControlService {
    constructor(
        private readonly viewStateRepository: ViewStateRepository,
        private readonly catalogReadService: CatalogReadService,
    ) {}

    async getState(): Promise<ViewStatePayload> {
        return this.viewStateRepository.loadDefaultViewState();
    }

    async patchState(patch: Record<string, any>): Promise<ViewStatePayload> {
        const current = await this.viewStateRepository.loadDefaultViewState();
        const next = mergeViewState(current, patch);
        await this.viewStateRepository.saveDefaultViewState(next);
        return next;
    }

    async applySelection(layer: string, selectionId: string, mode: 'replace' | 'append' | 'exclude' | 'only'): Promise<ViewStatePayload> {
        const current = await this.viewStateRepository.loadDefaultViewState();
        const appliedSelections = cloneObject(current.appliedSelections);
        appliedSelections[layer] = {
            selectionId,
            mode,
            updatedAt: new Date().toISOString(),
        };
        const next = {
            ...current,
            appliedSelections,
        };
        await this.viewStateRepository.saveDefaultViewState(next);
        return next;
    }

    async clearSelection(layer: string): Promise<ViewStatePayload> {
        const current = await this.viewStateRepository.loadDefaultViewState();
        const appliedSelections = cloneObject(current.appliedSelections);
        delete appliedSelections[layer];
        const next = {
            ...current,
            appliedSelections,
        };
        await this.viewStateRepository.saveDefaultViewState(next);
        return next;
    }

    async setLegendNodeState(nodeId: string, enabled: boolean, target: LegendTarget): Promise<ViewStatePayload> {
        const normalizedNodeId = normalizeLegendNodeId(nodeId);
        const taxonomy = await this.catalogReadService.getUiTaxonomy();
        const nodes = this.flattenNodes(Array.isArray(taxonomy) ? taxonomy : (taxonomy as any)?.tree || []);
        const targetNode = nodes.find((node) => node.node_id === normalizedNodeId || node.slug === normalizedNodeId);
        if (!targetNode) {
            throw new Error(`Legend node not found: ${nodeId}`);
        }

        const affectedNodes = nodes.filter((node) => node.node_id === targetNode.node_id || node.node_id.startsWith(`${targetNode.node_id}/`));
        const sourcePatch: Record<string, boolean> = {};
        const visibilityPatch: Record<string, boolean> = {};
        const subtypePatch: Record<string, boolean> = {};

        for (const node of affectedNodes) {
            const layerKey = this.resolveLayerKey(node);
            if (node.node_kind === 'subtype' && layerKey) {
                const subtypeId = String(node.metadata?.id || '').trim();
                if (subtypeId) subtypePatch[`${layerKey}:${subtypeId}`] = enabled;
                continue;
            }
            if (!layerKey) continue;

            if (target === 'sources') sourcePatch[layerKey] = enabled;
            if (target === 'visibility') visibilityPatch[layerKey] = enabled;
        }

        return this.patchState({
            ...(Object.keys(sourcePatch).length > 0 ? { sources: sourcePatch } : {}),
            ...(Object.keys(visibilityPatch).length > 0 ? { visibility: visibilityPatch } : {}),
            ...(Object.keys(subtypePatch).length > 0 ? { subtypeVisibility: subtypePatch } : {}),
        });
    }

    private flattenNodes(tree: any[]): TaxonomyNode[] {
        const result: TaxonomyNode[] = [];
        const stack = [...tree];
        while (stack.length > 0) {
            const node = stack.shift();
            if (!node) continue;
            if (typeof node === 'object') result.push(node as TaxonomyNode);
            if (Array.isArray((node as any).children)) stack.push(...(node as any).children);
        }
        return result;
    }

    private resolveLayerKey(node: TaxonomyNode): string | null {
        const rawId = String(node.metadata?.id || '').trim();
        if (rawId && LAYER_KEY_BY_RAW_ID[rawId]) return LAYER_KEY_BY_RAW_ID[rawId];
        if (node.layer_id && LAYER_KEY_BY_LAYER_ID[node.layer_id]) return LAYER_KEY_BY_LAYER_ID[node.layer_id];
        return null;
    }
}
