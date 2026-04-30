import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../db/database.service';
import { SOURCE_BINDINGS } from './source-bindings.service';
import { getLayerRenderContract } from './render-contracts';

type SourceRecord = {
    id: string;
    name: string;
    provider?: string;
    category?: string;
    layer?: string;
    status?: string;
    type?: string;
    refresh?: string;
    auth?: unknown;
    [key: string]: any;
};

type LayerTreeNode = {
    id: string;
    title: string;
    icon?: string;
    catalog_layer?: string;
    enabled_by_default?: boolean;
    sources?: Array<Record<string, any>>;
    subtypes?: Array<Record<string, any>>;
    children?: LayerTreeNode[];
    [key: string]: any;
};

const SOURCES_CATALOG_FILE = path.resolve(__dirname, '../../..', 'sources-catalog.json');
const LAYER_SETTINGS_FILE = path.resolve(__dirname, '../../..', 'layer-settings-schema.json');

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function inferLayerType(category: string | undefined, layerName: string): string {
    const haystack = `${category || ''} ${layerName}`.toLowerCase();
    if (haystack.includes('aircraft') || haystack.includes('vessel') || haystack.includes('satellite') || haystack.includes('webcam')) {
        return 'moving_entity';
    }
    if (
        haystack.includes('conflict') ||
        haystack.includes('fire') ||
        haystack.includes('jamming') ||
        haystack.includes('outage') ||
        haystack.includes('event') ||
        haystack.includes('disaster')
    ) {
        return 'event';
    }
    if (haystack.includes('traffic') || haystack.includes('oil') || haystack.includes('energy') || haystack.includes('weather')) {
        return 'observation';
    }
    if (haystack.includes('border') || haystack.includes('region') || haystack.includes('country')) {
        return 'region';
    }
    return 'asset';
}

function flattenFieldGroups(source: SourceRecord): Map<string, { tags: Set<string>; descriptions: Record<string, string> }> {
    const fieldMap = new Map<string, { tags: Set<string>; descriptions: Record<string, string> }>();

    const addField = (fieldKey: string, description: string, tags: string[]) => {
        const existing = fieldMap.get(fieldKey) || { tags: new Set<string>(), descriptions: {} };
        for (const tag of tags) existing.tags.add(tag);
        existing.descriptions[source.id] = description;
        fieldMap.set(fieldKey, existing);
    };

    const displayed = source.fields_displayed;
    if (displayed && typeof displayed === 'object') {
        for (const [groupName, groupFields] of Object.entries(displayed)) {
            if (!groupFields || typeof groupFields !== 'object') continue;
            for (const [fieldKey, description] of Object.entries(groupFields)) {
                addField(fieldKey, String(description), ['fields_displayed', groupName]);
            }
        }
    }

    for (const sectionName of ['fields_loaded_not_displayed', 'fields_available_not_loaded']) {
        const section = source[sectionName];
        if (!section || typeof section !== 'object') continue;
        for (const [fieldKey, description] of Object.entries(section)) {
            addField(fieldKey, String(description), [sectionName]);
        }
    }

    return fieldMap;
}

export class CatalogBootstrapService {
    constructor(private readonly database: DatabaseService) {}

    async seed(): Promise<void> {
        if (!this.database.isReady()) return;

        const sourcesDoc = JSON.parse(fs.readFileSync(SOURCES_CATALOG_FILE, 'utf-8'));
        const settingsDoc = JSON.parse(fs.readFileSync(LAYER_SETTINGS_FILE, 'utf-8'));

        const catalogSources: SourceRecord[] = Array.isArray(sourcesDoc.sources) ? sourcesDoc.sources : [];
        const tree: LayerTreeNode[] = Array.isArray(settingsDoc.tree) ? settingsDoc.tree : [];
        const knownSourceIds = new Set(catalogSources.map(source => source.id));
        const syntheticSources = this.collectSyntheticSources(tree, knownSourceIds);
        const bindingSources = this.collectBindingSyntheticSources(new Set([...knownSourceIds, ...syntheticSources.map(source => source.id)]));
        const sources = [...catalogSources, ...syntheticSources, ...bindingSources];
        const sourceLayerOverrides = this.buildSourceLayerOverrides(tree);

        await this.upsertSources(sources, sourceLayerOverrides);

        const layers = this.collectLayers(sources, tree, sourceLayerOverrides);
        await this.upsertLayers(layers);
        await this.upsertLayerSources(sources, sourceLayerOverrides);
        await this.upsertLayerFields(sources, sourceLayerOverrides);
        await this.upsertUiTaxonomy(tree);
    }

    private collectSyntheticSources(tree: LayerTreeNode[], knownSourceIds: Set<string>): SourceRecord[] {
        const synthetic = new Map<string, SourceRecord>();

        const walk = (nodes: LayerTreeNode[], domainId: string | null) => {
            for (const node of nodes) {
                const nextDomainId = domainId || (node.id ? slugify(node.id) : null);

                if (node.catalog_layer && Array.isArray(node.sources)) {
                    for (const source of node.sources) {
                        const sourceId = String(source.source_id || source.id || '');
                        if (!sourceId || knownSourceIds.has(sourceId) || synthetic.has(sourceId)) continue;

                        synthetic.set(sourceId, {
                            id: sourceId,
                            name: String(source.title || source.provider || sourceId),
                            provider: String(source.title || source.provider || sourceId),
                            category: nextDomainId || 'unknown',
                            layer: String(node.catalog_layer),
                            status: 'DEFINED',
                            type: String(source.data_type || 'defined'),
                            refresh: source.refresh || null,
                            auth: source.auth || [],
                            manifest_origin: 'layer-settings-schema',
                            taxonomy_only: true,
                            note: source.note || null,
                        });
                    }
                }

                if (Array.isArray(node.children) && node.children.length > 0) {
                    walk(node.children, nextDomainId);
                }
            }
        };

        walk(tree, null);
        return [...synthetic.values()];
    }

    private collectBindingSyntheticSources(knownSourceIds: Set<string>): SourceRecord[] {
        const synthetic = new Map<string, SourceRecord>();

        for (const binding of Object.values(SOURCE_BINDINGS)) {
            if (knownSourceIds.has(binding.sourceId) || synthetic.has(binding.sourceId)) continue;

            synthetic.set(binding.sourceId, {
                id: binding.sourceId,
                name: binding.sourceId,
                provider: binding.sourceId,
                category: binding.canonicalTarget,
                layer: binding.layerId,
                status: 'DEFINED',
                type: 'defined',
                manifest_origin: 'source-bindings',
                note: binding.notes || null,
            });
        }

        return [...synthetic.values()];
    }

    private buildSourceLayerOverrides(tree: LayerTreeNode[]): Map<string, string> {
        const overrides = new Map<string, string>();

        const walk = (nodes: LayerTreeNode[]) => {
            for (const node of nodes) {
                if (node.catalog_layer && Array.isArray(node.sources)) {
                    for (const source of node.sources) {
                        const sourceId = String(source.source_id || source.id || '');
                        if (sourceId) overrides.set(sourceId, node.catalog_layer);
                    }
                }
                if (Array.isArray(node.children) && node.children.length > 0) walk(node.children);
            }
        };

        walk(tree);
        return overrides;
    }

    private collectLayers(sources: SourceRecord[], tree: LayerTreeNode[], sourceLayerOverrides: Map<string, string>) {
        const layers = new Map<string, { layerId: string; slug: string; displayName: string; layerType: string; metadata: Record<string, any> }>();

        const ensureLayer = (displayName: string, category?: string, metadata: Record<string, any> = {}) => {
            if (!displayName) return;
            const slug = slugify(displayName);
            if (!slug) return;
            if (!layers.has(slug)) {
                layers.set(slug, {
                    layerId: slug,
                    slug,
                    displayName,
                    layerType: inferLayerType(category, displayName),
                    metadata,
                });
            }
        };

        for (const source of sources) {
            ensureLayer(sourceLayerOverrides.get(source.id) || source.layer || source.name, source.category, { category: source.category });
        }

        const walk = (nodes: LayerTreeNode[]) => {
            for (const node of nodes) {
                if (node.catalog_layer) {
                    ensureLayer(node.catalog_layer, undefined, { treeNodeId: node.id });
                }
                if (Array.isArray(node.children)) walk(node.children);
            }
        };
        walk(tree);

        return [...layers.values()];
    }

    private async upsertSources(sources: SourceRecord[], sourceLayerOverrides: Map<string, string>) {
        for (const source of sources) {
            const logicalLayer = sourceLayerOverrides.get(source.id) || source.layer || source.name;
            const manifest = {
                ...source,
                ...(logicalLayer ? { layer: logicalLayer } : {}),
            };
            await this.database.query(
                `
                    INSERT INTO catalog.sources (
                        source_id,
                        slug,
                        display_name,
                        provider_kind,
                        status,
                        manifest,
                        updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
                    ON CONFLICT (source_id)
                    DO UPDATE SET
                        slug = EXCLUDED.slug,
                        display_name = EXCLUDED.display_name,
                        provider_kind = EXCLUDED.provider_kind,
                        status = EXCLUDED.status,
                        manifest = EXCLUDED.manifest,
                        updated_at = now()
                `,
                [
                    source.id,
                    slugify(source.id),
                    source.name,
                    source.category || 'unknown',
                    String(source.status || 'defined').toLowerCase(),
                    JSON.stringify(manifest),
                ],
            );
        }
    }

    private async upsertLayers(layers: Array<{ layerId: string; slug: string; displayName: string; layerType: string; metadata: Record<string, any> }>) {
        for (const layer of layers) {
            const renderContract = getLayerRenderContract(layer.layerId);
            const capabilities = {
                replay: renderContract.historyMode !== 'none',
                frontendStoreKey: renderContract.frontendStoreKey || null,
                replayScope: renderContract.replayScope || null,
                replayBlocking: renderContract.replayBlocking,
                renderBatch: renderContract.renderBatch,
                detailsOnDemand: renderContract.detailsOnDemand,
                motionModel: renderContract.motionModel,
                minimalRenderProperties: renderContract.minimalRenderProperties,
                simplifiedRenderGeometry: renderContract.simplifiedRenderGeometry,
                simplifyTolerance: renderContract.simplifyTolerance ?? null,
                geometryComplexity: renderContract.geometryComplexity || null,
                renderGeometryPolicy: renderContract.renderGeometryPolicy || null,
                renderGeometryColumn: renderContract.renderGeometryColumn || null,
                staticAsset: renderContract.staticAsset,
                pointDeltaMode: renderContract.pointDeltaMode,
                bucketSeconds: renderContract.bucketSeconds,
                motionSourceId: renderContract.motionSourceId || null,
                motionMaxGapFallbackSec: renderContract.motionMaxGapFallbackSec || null,
                maxSpeedMps: renderContract.maxSpeedMps || null,
                ...(renderContract.historyMode === 'none' ? { liveOnly: true } : {}),
            };
            await this.database.query(
                `
                    INSERT INTO catalog.layers (
                        layer_id,
                        slug,
                        display_name,
                        layer_type,
                        history_mode,
                        coverage_scope,
                        completeness_flags,
                        capabilities,
                        metadata,
                        updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7::jsonb, $8::jsonb, now())
                    ON CONFLICT (layer_id)
                    DO UPDATE SET
                        slug = EXCLUDED.slug,
                        display_name = EXCLUDED.display_name,
                        layer_type = EXCLUDED.layer_type,
                        history_mode = EXCLUDED.history_mode,
                        coverage_scope = EXCLUDED.coverage_scope,
                        capabilities = catalog.layers.capabilities || EXCLUDED.capabilities,
                        metadata = EXCLUDED.metadata,
                        updated_at = now()
                `,
                [
                    layer.layerId,
                    layer.slug,
                    layer.displayName,
                    layer.layerType,
                    renderContract.historyMode,
                    renderContract.coverageScope,
                    JSON.stringify(capabilities),
                    JSON.stringify(layer.metadata),
                ],
            );
        }
    }

    private async upsertLayerSources(sources: SourceRecord[], sourceLayerOverrides: Map<string, string>) {
        for (const [index, source] of sources.entries()) {
            const layerSlug = slugify(sourceLayerOverrides.get(source.id) || source.layer || source.name);
            await this.database.query(
                `
                    INSERT INTO catalog.layer_sources (
                        layer_source_id,
                        layer_id,
                        source_id,
                        binding_kind,
                        priority,
                        config
                    )
                    VALUES ($1, $2, $3, 'primary', $4, $5::jsonb)
                    ON CONFLICT (layer_id, source_id, binding_kind)
                    DO UPDATE SET
                        priority = EXCLUDED.priority,
                        config = EXCLUDED.config
                `,
                [
                    `${layerSlug}:${source.id}:primary`,
                    layerSlug,
                    source.id,
                    index,
                    JSON.stringify({
                        refresh: source.refresh || null,
                        status: source.status || null,
                        type: source.type || null,
                        auth: source.auth || null,
                    }),
                ],
            );
        }
    }

    private async upsertLayerFields(sources: SourceRecord[], sourceLayerOverrides: Map<string, string>) {
        const perLayer = new Map<string, Map<string, { tags: Set<string>; descriptions: Record<string, string> }>>();

        for (const source of sources) {
            const layerSlug = slugify(sourceLayerOverrides.get(source.id) || source.layer || source.name);
            const sourceFields = flattenFieldGroups(source);
            if (!perLayer.has(layerSlug)) perLayer.set(layerSlug, new Map());
            const targetLayerMap = perLayer.get(layerSlug)!;

            for (const [fieldKey, fieldMeta] of sourceFields.entries()) {
                const existing = targetLayerMap.get(fieldKey) || { tags: new Set<string>(), descriptions: {} };
                for (const tag of fieldMeta.tags) existing.tags.add(tag);
                existing.descriptions = { ...existing.descriptions, ...fieldMeta.descriptions };
                targetLayerMap.set(fieldKey, existing);
            }
        }

        for (const [layerId, fields] of perLayer.entries()) {
            for (const [fieldKey, fieldMeta] of fields.entries()) {
                await this.database.query(
                    `
                        INSERT INTO catalog.layer_fields (
                            layer_field_id,
                            layer_id,
                            field_key,
                            field_type,
                            semantic_tags,
                            filterable,
                            aggregatable,
                            nullable,
                            metadata
                        )
                        VALUES ($1, $2, $3, 'unknown', $4::jsonb, false, false, true, $5::jsonb)
                        ON CONFLICT (layer_id, field_key)
                        DO UPDATE SET
                            semantic_tags = EXCLUDED.semantic_tags,
                            metadata = EXCLUDED.metadata
                    `,
                    [
                        `${layerId}:${fieldKey}`,
                        layerId,
                        fieldKey,
                        JSON.stringify([...fieldMeta.tags].sort()),
                        JSON.stringify({ descriptions: fieldMeta.descriptions }),
                    ],
                );
            }
        }
    }

    private async upsertUiTaxonomy(tree: LayerTreeNode[]) {
        const walk = async (nodes: LayerTreeNode[], parentNodeId: string | null, parentPath: string[]) => {
            for (const [index, node] of nodes.entries()) {
                const pathParts = [...parentPath, slugify(node.id || node.title)];
                const nodeId = pathParts.join('/');
                const nodeKind = node.catalog_layer ? 'layer' : parentNodeId ? 'group' : 'domain';
                const layerId = node.catalog_layer ? slugify(node.catalog_layer) : null;

                await this.database.query(
                    `
                        INSERT INTO catalog.ui_taxonomy_nodes (
                            node_id,
                            parent_node_id,
                            node_kind,
                            slug,
                            label,
                            layer_id,
                            icon_key,
                            sort_order,
                            metadata,
                            updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
                        ON CONFLICT (node_id)
                        DO UPDATE SET
                            parent_node_id = EXCLUDED.parent_node_id,
                            node_kind = EXCLUDED.node_kind,
                            slug = EXCLUDED.slug,
                            label = EXCLUDED.label,
                            layer_id = EXCLUDED.layer_id,
                            icon_key = EXCLUDED.icon_key,
                            sort_order = EXCLUDED.sort_order,
                            metadata = EXCLUDED.metadata,
                            updated_at = now()
                    `,
                    [
                        nodeId,
                        parentNodeId,
                        nodeKind,
                        nodeId.replace(/\//g, '__'),
                        node.title,
                        layerId,
                        node.icon || null,
                        index,
                        JSON.stringify(node),
                    ],
                );

                if (node.catalog_layer && Array.isArray(node.sources)) {
                    for (const [sourceIndex, source] of node.sources.entries()) {
                        const sourceId = String(source.source_id || source.id || '');
                        if (!sourceId) continue;
                        const sourceNodeId = `${nodeId}/source/${slugify(sourceId)}`;
                        await this.database.query(
                            `
                                INSERT INTO catalog.ui_taxonomy_nodes (
                                    node_id,
                                    parent_node_id,
                                    node_kind,
                                    slug,
                                    label,
                                    layer_id,
                                    source_id,
                                    sort_order,
                                    metadata,
                                    updated_at
                                )
                                VALUES ($1, $2, 'source', $3, $4, $5, $6, $7, $8::jsonb, now())
                                ON CONFLICT (node_id)
                                DO UPDATE SET
                                    parent_node_id = EXCLUDED.parent_node_id,
                                    label = EXCLUDED.label,
                                    layer_id = EXCLUDED.layer_id,
                                    source_id = EXCLUDED.source_id,
                                    sort_order = EXCLUDED.sort_order,
                                    metadata = EXCLUDED.metadata,
                                    updated_at = now()
                            `,
                            [
                                sourceNodeId,
                                nodeId,
                                sourceNodeId.replace(/\//g, '__'),
                                source.title || sourceId,
                                layerId,
                                sourceId,
                                sourceIndex,
                                JSON.stringify(source),
                            ],
                        );
                    }
                }

                if (node.catalog_layer && Array.isArray(node.subtypes)) {
                    for (const [subtypeIndex, subtype] of node.subtypes.entries()) {
                        const subtypeId = String(subtype.id || subtype.title || `subtype-${subtypeIndex}`);
                        const subtypeNodeId = `${nodeId}/subtype/${slugify(subtypeId)}`;
                        await this.database.query(
                            `
                                INSERT INTO catalog.ui_taxonomy_nodes (
                                    node_id,
                                    parent_node_id,
                                    node_kind,
                                    slug,
                                    label,
                                    layer_id,
                                    sort_order,
                                    metadata,
                                    updated_at
                                )
                                VALUES ($1, $2, 'subtype', $3, $4, $5, $6, $7::jsonb, now())
                                ON CONFLICT (node_id)
                                DO UPDATE SET
                                    parent_node_id = EXCLUDED.parent_node_id,
                                    label = EXCLUDED.label,
                                    layer_id = EXCLUDED.layer_id,
                                    sort_order = EXCLUDED.sort_order,
                                    metadata = EXCLUDED.metadata,
                                    updated_at = now()
                            `,
                            [
                                subtypeNodeId,
                                nodeId,
                                subtypeNodeId.replace(/\//g, '__'),
                                subtype.title || subtypeId,
                                layerId,
                                subtypeIndex,
                                JSON.stringify(subtype),
                            ],
                        );
                    }
                }

                if (Array.isArray(node.children) && node.children.length > 0) {
                    await walk(node.children, nodeId, pathParts);
                }
            }
        };

        await walk(tree, null, []);
    }
}
