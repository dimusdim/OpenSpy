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
    created_at?: string;
    updated_at?: string;
};

type SaveSelectionInput = {
    selectionId?: string;
    workspaceId?: string;
    layerId?: string | null;
    selectionMode?: string;
    predicate?: Record<string, any>;
    geometryJson?: Record<string, any> | null;
    metadata?: Record<string, any>;
};

function buildSelectionId(layerId: string | null | undefined, predicate: Record<string, any> | undefined, metadata: Record<string, any> | undefined) {
    const suffix = crypto
        .createHash('sha1')
        .update(JSON.stringify({ layerId: layerId || null, predicate: predicate || {}, metadata: metadata || {} }))
        .digest('hex')
        .slice(0, 12);
    return `sel:${layerId || 'global'}:${suffix}`;
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
                    created_at,
                    updated_at
                FROM app.selections
                WHERE selection_id = $1 AND workspace_id = $2
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

        const selectionId = input.selectionId || buildSelectionId(input.layerId || null, input.predicate, input.metadata);
        const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
        const selectionMode = input.selectionMode || 'filter';
        const predicate = input.predicate || {};
        const geometryJson = input.geometryJson || null;
        const metadata = input.metadata || {};

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
            ],
        );

        const saved = await this.getSelection(selectionId, workspaceId);
        if (!saved) {
            throw new Error('Failed to load saved selection');
        }
        return saved;
    }
}
