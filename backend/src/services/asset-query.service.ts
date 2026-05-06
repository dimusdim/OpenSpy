import { DatabaseService } from '../db/database.service';

export type AssetQueryFilters = {
    layerId?: string;
    sourceId?: string;
    assetId?: string;
    assetKind?: string;
    subtype?: string;
    from?: string;
    to?: string;
    bbox?: [number, number, number, number];
    limit?: number;
    offset?: number;
};

type LatestAssetRow = {
    asset_id: string;
    latest_snapshot_id: string | null;
    layer_id: string;
    source_id: string | null;
    asset_kind: string;
    subtype: string | null;
    display_name: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    updated_at: string;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: any;
};

type AssetSnapshotRow = {
    asset_snapshot_id: string;
    asset_id: string;
    ingest_run_id: string | null;
    layer_id: string;
    source_id: string | null;
    asset_kind: string;
    subtype: string | null;
    display_name: string | null;
    observed_at: string | null;
    created_at: string;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: any;
};

function normalizeLimit(limit: number | undefined, fallback = 200): number {
    if (!Number.isFinite(limit)) return fallback;
    return Math.max(1, Math.trunc(limit as number));
}

export class AssetQueryService {
    constructor(private readonly database: DatabaseService) {}

    isReady(): boolean {
        return this.database.isReady();
    }

    private buildLatestWhere(filters: AssetQueryFilters, alias = 'a') {
        const clauses: string[] = [];
        const params: unknown[] = [];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add(`${alias}.layer_id = ?`, filters.layerId);
        if (filters.sourceId) add(`${alias}.source_id = ?`, filters.sourceId);
        if (filters.assetId) add(`${alias}.asset_id = ?`, filters.assetId);
        if (filters.assetKind) add(`${alias}.asset_kind = ?`, filters.assetKind);
        if (filters.subtype) add(`${alias}.subtype = ?`, filters.subtype);
        if (filters.from) add(`COALESCE(${alias}.last_observed_at, ${alias}.updated_at, ${alias}.created_at) >= ?::timestamptz`, filters.from);
        if (filters.to) add(`COALESCE(${alias}.last_observed_at, ${alias}.updated_at, ${alias}.created_at) <= ?::timestamptz`, filters.to);
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            clauses.push(
                `${alias}.geom IS NOT NULL AND ST_Intersects(${alias}.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`,
            );
        }

        return { clauses, params };
    }

    private buildSnapshotWhere(filters: AssetQueryFilters, alias = 's') {
        const clauses: string[] = [];
        const params: unknown[] = [];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add(`${alias}.layer_id = ?`, filters.layerId);
        if (filters.sourceId) add(`${alias}.source_id = ?`, filters.sourceId);
        if (filters.assetId) add(`${alias}.asset_id = ?`, filters.assetId);
        if (filters.assetKind) add(`${alias}.asset_kind = ?`, filters.assetKind);
        if (filters.subtype) add(`${alias}.subtype = ?`, filters.subtype);
        if (filters.from) add(`COALESCE(${alias}.observed_at, ${alias}.created_at) >= ?::timestamptz`, filters.from);
        if (filters.to) add(`COALESCE(${alias}.observed_at, ${alias}.created_at) <= ?::timestamptz`, filters.to);
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            clauses.push(
                `${alias}.geom IS NOT NULL AND ST_Intersects(${alias}.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`,
            );
        }

        return { clauses, params };
    }

    async listLatest(filters: AssetQueryFilters) {
        if (!this.database.isReady()) return [];

        const { clauses, params } = this.buildLatestWhere(filters, 'a');
        const limit = normalizeLimit(filters.limit);
        const offset = Math.max(0, Math.trunc(Number(filters.offset || 0)));
        params.push(limit, offset);
        const limitParam = params.length - 1;
        const offsetParam = params.length;
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

        const result = await this.database.query<LatestAssetRow>(
            `
                SELECT
                    a.asset_id,
                    a.latest_snapshot_id,
                    a.layer_id,
                    a.source_id,
                    a.asset_kind,
                    a.subtype,
                    a.display_name,
                    a.first_observed_at,
                    a.last_observed_at,
                    a.updated_at,
                    CASE WHEN a.geom IS NOT NULL THEN ST_AsGeoJSON(a.geom)::jsonb ELSE NULL END AS geometry,
                    CASE WHEN a.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(a.geom)) ELSE NULL END AS display_lat,
                    CASE WHEN a.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(a.geom)) ELSE NULL END AS display_lng,
                    a.properties
                FROM core.assets a
                ${whereSql}
                ORDER BY COALESCE(a.last_observed_at, a.updated_at, a.created_at) DESC NULLS LAST, a.updated_at DESC
                LIMIT $${limitParam} OFFSET $${offsetParam}
            `,
            params,
        );

        return result?.rows || [];
    }

    async listSnapshots(filters: AssetQueryFilters) {
        if (!this.database.isReady()) return [];

        const { clauses, params } = this.buildSnapshotWhere(filters, 's');
        const limit = normalizeLimit(filters.limit, 500);
        const offset = Math.max(0, Math.trunc(Number(filters.offset || 0)));
        params.push(limit, offset);
        const limitParam = params.length - 1;
        const offsetParam = params.length;
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

        const result = await this.database.query<AssetSnapshotRow>(
            `
                SELECT
                    s.asset_snapshot_id,
                    s.asset_id,
                    s.ingest_run_id,
                    s.layer_id,
                    s.source_id,
                    s.asset_kind,
                    s.subtype,
                    s.display_name,
                    s.observed_at,
                    s.created_at,
                    CASE WHEN s.geom IS NOT NULL THEN ST_AsGeoJSON(s.geom)::jsonb ELSE NULL END AS geometry,
                    CASE WHEN s.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lat,
                    CASE WHEN s.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lng,
                    s.properties
                FROM core.asset_snapshots s
                ${whereSql}
                ORDER BY COALESCE(s.observed_at, s.created_at) DESC NULLS LAST, s.created_at DESC
                LIMIT $${limitParam} OFFSET $${offsetParam}
            `,
            params,
        );

        return result?.rows || [];
    }
}
