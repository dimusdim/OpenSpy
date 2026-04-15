import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../db/database.service';
import { getPublicSourceLiveContract } from './live-contracts';

const SOURCES_CATALOG_FILE = path.resolve(__dirname, '../../..', 'sources-catalog.json');
const LAYER_SETTINGS_FILE = path.resolve(__dirname, '../../..', 'layer-settings-schema.json');

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

export class CatalogReadService {
    constructor(private readonly database: DatabaseService) {}

    private attachSourceContract<T extends { source_id?: string | null; id?: string | null; manifest?: any }>(source: T | null): (T & { live_contract?: any }) | null {
        if (!source) return null;
        const liveContract = getPublicSourceLiveContract(source.source_id || source.id || null);
        return {
            ...source,
            ...(liveContract ? { live_contract: liveContract } : {}),
        };
    }

    async getSource(sourceId: string) {
        if (this.database.isReady()) {
            const result = await this.database.query<{
                source_id: string;
                slug: string;
                display_name: string;
                provider_kind: string;
                status: string;
                manifest: any;
            }>(
                `
                    SELECT source_id, slug, display_name, provider_kind, status, manifest
                    FROM catalog.sources
                    WHERE source_id = $1
                    LIMIT 1
                `,
                [sourceId],
            );
            return this.attachSourceContract(result?.rows[0] || null);
        }

        const doc = readJson<{ sources?: any[] }>(SOURCES_CATALOG_FILE);
        const source = (doc.sources || []).find((row) => row.id === sourceId) || null;
        return this.attachSourceContract(source);
    }

    async listSources() {
        if (this.database.isReady()) {
            const result = await this.database.query<{
                source_id: string;
                slug: string;
                display_name: string;
                provider_kind: string;
                status: string;
                manifest: any;
            }>(
                `
                    SELECT source_id, slug, display_name, provider_kind, status, manifest
                    FROM catalog.sources
                    ORDER BY slug
                `,
            );
            if (result) {
                return result.rows
                    .map((row) => this.attachSourceContract(row))
                    .filter((row): row is NonNullable<typeof row> => Boolean(row));
            }
        }

        const doc = readJson<{ sources?: any[] }>(SOURCES_CATALOG_FILE);
        return Array.isArray(doc.sources)
            ? doc.sources
                .map((row) => this.attachSourceContract(row))
                .filter((row): row is NonNullable<typeof row> => Boolean(row))
            : [];
    }

    async listLayers() {
        if (this.database.isReady()) {
            const result = await this.database.query<{
                layer_id: string;
                slug: string;
                display_name: string;
                layer_type: string;
                history_mode: string;
                coverage_scope: string;
                capabilities: any;
                metadata: any;
            }>(
                `
                    SELECT layer_id, slug, display_name, layer_type, history_mode, coverage_scope, capabilities, metadata
                    FROM catalog.layers
                    ORDER BY slug
                `,
            );
            if (result) {
                return result.rows
                    .filter((row): row is NonNullable<typeof row> => Boolean(row));
            }
        }

        const sourcesDoc = readJson<{ sources?: any[] }>(SOURCES_CATALOG_FILE);
        const settingsDoc = readJson<{ tree?: any[] }>(LAYER_SETTINGS_FILE);
        const layers = new Map<string, { layer_id: string; slug: string; display_name: string }>();

        for (const source of sourcesDoc.sources || []) {
            const displayName = String(source.layer || source.name || '').trim();
            if (!displayName) continue;
            const slug = slugify(displayName);
            layers.set(slug, { layer_id: slug, slug, display_name: displayName });
        }

        const walk = (nodes: any[]) => {
            for (const node of nodes) {
                if (node.catalog_layer) {
                    const displayName = String(node.catalog_layer).trim();
                    const slug = slugify(displayName);
                    layers.set(slug, { layer_id: slug, slug, display_name: displayName });
                }
                if (Array.isArray(node.children)) walk(node.children);
            }
        };
        if (Array.isArray(settingsDoc.tree)) walk(settingsDoc.tree);

        return [...layers.values()]
            .sort((a, b) => a.slug.localeCompare(b.slug))
            .filter((layer): layer is NonNullable<typeof layer> => Boolean(layer));
    }

    async getLayer(layerId: string) {
        if (this.database.isReady()) {
            const result = await this.database.query<{
                layer_id: string;
                slug: string;
                display_name: string;
                layer_type: string;
                history_mode: string;
                coverage_scope: string;
                capabilities: any;
                metadata: any;
            }>(
                `
                    SELECT layer_id, slug, display_name, layer_type, history_mode, coverage_scope, capabilities, metadata
                    FROM catalog.layers
                    WHERE layer_id = $1 OR slug = $1
                    LIMIT 1
                `,
                [layerId],
            );
            return result?.rows[0] || null;
        }

        const layers = await this.listLayers();
        return layers.find((layer) => layer.layer_id === layerId || layer.slug === layerId) || null;
    }

    async getUiTaxonomy() {
        if (this.database.isReady()) {
            const result = await this.database.query<{
                node_id: string;
                parent_node_id: string | null;
                node_kind: string;
                slug: string;
                label: string;
                layer_id: string | null;
                source_id: string | null;
                icon_key: string | null;
                sort_order: number;
                metadata: any;
            }>(
                `
                    SELECT node_id, parent_node_id, node_kind, slug, label, layer_id, source_id, icon_key, sort_order, metadata
                    FROM catalog.ui_taxonomy_nodes
                    ORDER BY node_id
                `,
            );
            if (result) return result.rows;
        }

        const settingsDoc = readJson<{ tree?: any[]; ui_behavior?: any }>(LAYER_SETTINGS_FILE);
        return {
            tree: settingsDoc.tree || [],
            ui_behavior: settingsDoc.ui_behavior || {},
        };
    }

    async getUiTaxonomyNode(nodeId: string) {
        if (this.database.isReady()) {
            const result = await this.database.query<{
                node_id: string;
                parent_node_id: string | null;
                node_kind: string;
                slug: string;
                label: string;
                layer_id: string | null;
                source_id: string | null;
                icon_key: string | null;
                sort_order: number;
                metadata: any;
            }>(
                `
                    SELECT node_id, parent_node_id, node_kind, slug, label, layer_id, source_id, icon_key, sort_order, metadata
                    FROM catalog.ui_taxonomy_nodes
                    WHERE node_id = $1 OR slug = $1
                    LIMIT 1
                `,
                [nodeId],
            );
            return result?.rows[0] || null;
        }

        const taxonomy = await this.getUiTaxonomy() as { tree?: any[] };
        const stack = Array.isArray(taxonomy.tree) ? [...taxonomy.tree] : [];
        while (stack.length > 0) {
            const node = stack.shift();
            if (!node) continue;
            if (node.id === nodeId) return node;
            if (Array.isArray(node.children)) stack.push(...node.children);
        }
        return null;
    }
}
