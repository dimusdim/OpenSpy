import crypto from 'crypto';
import { DatabaseService } from '../db/database.service';

const DEFAULT_WORKSPACE_ID = 'default';

export type SelectionPayload = {
    selection_id: string;
    workspace_id: string;
    layer_id: string | null;
    selection_mode: string;
    predicate: Record<string, any>;
    geometry_json: Record<string, any> | null;
    metadata: Record<string, any>;
    expires_at?: string | null;
    materialized_at?: string | null;
    materialized_count?: number;
    materialization_status?: string;
    materialization_error?: string | null;
    created_at?: string;
    updated_at?: string;
};

export type SelectionItemPayload = {
    selection_id: string;
    workspace_id?: string;
    layer_id?: string | null;
    object_kind: 'entity' | 'event' | 'asset';
    object_id: string;
    observed_at?: string | null;
    display_lat?: number | null;
    display_lng?: number | null;
    properties?: Record<string, any>;
};

type SaveSelectionInput = {
    selectionId?: string;
    workspaceId?: string;
    layerId?: string | null;
    selectionMode?: string;
    predicate?: Record<string, any>;
    geometryJson?: Record<string, any> | null;
    metadata?: Record<string, any>;
    expiresAt?: string | Date | null;
};

function buildSelectionId(layerId: string | null | undefined, predicate: Record<string, any> | undefined, metadata: Record<string, any> | undefined) {
    const suffix = crypto
        .createHash('sha1')
        .update(JSON.stringify({ layerId: layerId || null, predicate: predicate || {}, metadata: metadata || {} }))
        .digest('hex')
        .slice(0, 12);
    return `sel:${layerId || 'global'}:${suffix}`;
}

function normalizeExpiresAt(value: unknown): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeBboxOrder(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!normalized) return null;
    if (normalized === 'wsen' || normalized === 'west,south,east,north') return 'west,south,east,north';
    if (normalized === 'swne' || normalized === 'south,west,north,east') return 'south,west,north,east';
    throw new Error(`Invalid selection bbox_order: ${String(value)}. Expected west,south,east,north or south,west,north,east.`);
}

function normalizeSelectionPredicate(value: Record<string, any> | undefined): Record<string, any> {
    const predicate = { ...(value || {}) };
    if (predicate.bbox !== undefined) {
        const normalizedOrder = normalizeBboxOrder(predicate.bbox_order ?? predicate.bboxOrder);
        predicate.bbox_order = normalizedOrder || 'west,south,east,north';
        delete predicate.bboxOrder;
    }
    if (predicate.observedFrom !== undefined && predicate.observed_from === undefined) {
        predicate.observed_from = predicate.observedFrom;
        delete predicate.observedFrom;
    }
    if (predicate.observedTo !== undefined && predicate.observed_to === undefined) {
        predicate.observed_to = predicate.observedTo;
        delete predicate.observedTo;
    }
    if (predicate.observedAt !== undefined && predicate.at === undefined && predicate.observed_at === undefined) {
        predicate.at = predicate.observedAt;
        delete predicate.observedAt;
    }
    if (predicate.layerId !== undefined && predicate.layer_id === undefined) {
        predicate.layer_id = predicate.layerId;
        delete predicate.layerId;
    }
    return predicate;
}

export class SelectionRepository {
    constructor(private readonly database: DatabaseService) {}

    async getSelection(selectionId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<SelectionPayload | null> {
        if (!this.database.isReady()) return null;

        const result = await this.database.query<{
            selection_id: string;
            workspace_id: string;
            layer_id: string | null;
            selection_mode: string;
            predicate: Record<string, any>;
            geometry_json: Record<string, any> | null;
            metadata: Record<string, any>;
            expires_at: string | null;
            materialized_at: string | null;
            materialized_count: number;
            materialization_status: string;
            materialization_error: string | null;
            created_at: string;
            updated_at: string;
        }>(
            `
                SELECT
                    selection_id,
                    workspace_id,
                    layer_id,
                    selection_mode,
                    predicate,
                    CASE WHEN geometry IS NOT NULL THEN ST_AsGeoJSON(geometry)::jsonb ELSE NULL END AS geometry_json,
                    metadata,
                    expires_at,
                    materialized_at,
                    materialized_count,
                    materialization_status,
                    materialization_error,
                    created_at,
                    updated_at
                FROM app.selections
                WHERE selection_id = $1 AND workspace_id = $2
                  AND (expires_at IS NULL OR expires_at > now())
                LIMIT 1
            `,
            [selectionId, workspaceId],
        );

        return result?.rows[0] || null;
    }

    async saveSelection(input: SaveSelectionInput): Promise<SelectionPayload> {
        if (!this.database.isReady()) {
            throw new Error('Database is not ready');
        }

        const predicate = normalizeSelectionPredicate(input.predicate);
        const selectionId = input.selectionId || buildSelectionId(input.layerId || null, predicate, input.metadata);
        const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
        const selectionMode = input.selectionMode || 'filter';
        const geometryJson = input.geometryJson || null;
        const metadata = input.metadata || {};
        const expiresAt = normalizeExpiresAt(input.expiresAt ?? metadata.expiresAt ?? metadata.expires_at);

        await this.database.query(
            `
                INSERT INTO app.selections (
                    selection_id,
                    workspace_id,
                    layer_id,
                    selection_mode,
                    predicate,
                    geometry,
                    metadata,
                    expires_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5::jsonb,
                    CASE WHEN $6::jsonb IS NOT NULL THEN ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($6::text)), 4326) ELSE NULL END,
                    $7::jsonb,
                    $8::timestamptz,
                    now(),
                    now()
                )
                ON CONFLICT (selection_id)
                DO UPDATE SET
                    layer_id = EXCLUDED.layer_id,
                    selection_mode = EXCLUDED.selection_mode,
                    predicate = EXCLUDED.predicate,
                    geometry = EXCLUDED.geometry,
                    metadata = EXCLUDED.metadata,
                    expires_at = EXCLUDED.expires_at,
                    updated_at = now()
            `,
            [
                selectionId,
                workspaceId,
                input.layerId || null,
                selectionMode,
                JSON.stringify(predicate),
                geometryJson ? JSON.stringify(geometryJson) : null,
                JSON.stringify(metadata),
                expiresAt,
            ],
        );

        const saved = await this.getSelection(selectionId, workspaceId);
        if (!saved) {
            throw new Error('Failed to load saved selection');
        }
        return saved;
    }

    async cleanupExpiredSelections(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<number> {
        if (!this.database.isReady()) return 0;
        const result = await this.database.query(
            `
                DELETE FROM app.selections
                WHERE workspace_id = $1
                  AND expires_at IS NOT NULL
                  AND expires_at <= now()
            `,
            [workspaceId],
        );
        return result?.rowCount || 0;
    }

    async replaceSelectionItems(
        selectionId: string,
        items: SelectionItemPayload[],
        workspaceId: string = DEFAULT_WORKSPACE_ID,
        status: 'none' | 'materialized' | 'partial' | 'empty' | 'error' = 'materialized',
        error: string | null = null,
    ): Promise<{ count: number; status: string }> {
        if (!this.database.isReady()) return { count: 0, status: 'none' };
        const normalized = items
            .map((item) => ({
                layer_id: item.layer_id || null,
                object_kind: item.object_kind,
                object_id: String(item.object_id || '').trim(),
                observed_at: item.observed_at || null,
                display_lat: Number.isFinite(Number(item.display_lat)) ? Number(item.display_lat) : null,
                display_lng: Number.isFinite(Number(item.display_lng)) ? Number(item.display_lng) : null,
                properties: item.properties || {},
            }))
            .filter((item) => item.object_id && ['entity', 'event', 'asset'].includes(item.object_kind));

        await this.database.withTransaction(async () => {
            await this.database.query(
                'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
                [workspaceId, selectionId],
            );
            await this.database.query(
                'DELETE FROM app.selection_items WHERE selection_id = $1 AND workspace_id = $2',
                [selectionId, workspaceId],
            );
            if (normalized.length > 0) {
                await this.database.query(
                    `
                        INSERT INTO app.selection_items (
                            selection_id,
                            workspace_id,
                            layer_id,
                            object_kind,
                            object_id,
                            observed_at,
                            display_lat,
                            display_lng,
                            properties
                        )
                        SELECT
                            $1,
                            $2,
                            item.layer_id,
                            item.object_kind,
                            item.object_id,
                            item.observed_at,
                            item.display_lat,
                            item.display_lng,
                            COALESCE(item.properties, '{}'::jsonb)
                        FROM jsonb_to_recordset($3::jsonb) AS item(
                            layer_id text,
                            object_kind text,
                            object_id text,
                            observed_at timestamptz,
                            display_lat double precision,
                            display_lng double precision,
                            properties jsonb
                        )
                        ON CONFLICT (selection_id, object_kind, object_id)
                        DO UPDATE SET
                            layer_id = EXCLUDED.layer_id,
                            observed_at = EXCLUDED.observed_at,
                            display_lat = EXCLUDED.display_lat,
                            display_lng = EXCLUDED.display_lng,
                            properties = EXCLUDED.properties
                    `,
                    [selectionId, workspaceId, JSON.stringify(normalized)],
                );
            }
            await this.database.query(
                `
                    UPDATE app.selections
                    SET materialized_at = now(),
                        materialized_count = $3,
                        materialization_status = $4,
                        materialization_error = $5,
                        updated_at = now()
                    WHERE selection_id = $1 AND workspace_id = $2
                `,
                [selectionId, workspaceId, normalized.length, status, error],
            );
        });

        return { count: normalized.length, status };
    }

    async listSelectionItems(
        selectionId: string,
        workspaceId: string = DEFAULT_WORKSPACE_ID,
        limit: number | null = 500,
        offset = 0,
    ): Promise<{ items: SelectionItemPayload[]; has_more: boolean; next_offset: number | null }> {
        if (!this.database.isReady()) return { items: [], has_more: false, next_offset: null };
        const cappedOffset = Math.max(0, Math.trunc(offset));
        if (limit === null) {
            const result = await this.database.query<SelectionItemPayload>(
                `
                    SELECT selection_id, workspace_id, layer_id, object_kind, object_id,
                           observed_at, display_lat, display_lng, properties
                    FROM app.selection_items
                    WHERE selection_id = $1 AND workspace_id = $2
                    ORDER BY observed_at DESC NULLS LAST, object_kind, object_id
                    OFFSET $3
                `,
                [selectionId, workspaceId, cappedOffset],
            );
            return {
                items: result?.rows || [],
                has_more: false,
                next_offset: null,
            };
        }
        const pageLimit = Math.max(1, Math.trunc(limit));
        const result = await this.database.query<SelectionItemPayload>(
            `
                SELECT selection_id, workspace_id, layer_id, object_kind, object_id,
                       observed_at, display_lat, display_lng, properties
                FROM app.selection_items
                WHERE selection_id = $1 AND workspace_id = $2
                ORDER BY observed_at DESC NULLS LAST, object_kind, object_id
                LIMIT $3 OFFSET $4
            `,
            [selectionId, workspaceId, pageLimit + 1, cappedOffset],
        );
        const rows = result?.rows || [];
        const items = rows.slice(0, pageLimit);
        const hasMore = rows.length > pageLimit;
        return {
            items,
            has_more: hasMore,
            next_offset: hasMore ? cappedOffset + pageLimit : null,
        };
    }
}
