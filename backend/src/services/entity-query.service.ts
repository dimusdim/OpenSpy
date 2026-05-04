import { DatabaseService } from '../db/database.service';

export type EntityQueryFilters = {
    layerId?: string;
    sourceId?: string;
    entityId?: string;
    entityKind?: string;
    subtype?: string;
    from?: string;
    to?: string;
    bbox?: [number, number, number, number];
    limit?: number;
};

export type LiveStatusFilters = {
    layerId?: string;
    bbox?: [number, number, number, number];
    freshnessMinutes?: number;
    limit?: number;
};

export type EntityTrackFilters = {
    entityId: string;
    from?: string;
    to?: string;
    limit?: number;
    order?: 'asc' | 'desc';
};

type LatestEntityRow = {
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    entity_kind: string;
    subtype: string | null;
    display_name: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    updated_at: string;
    properties: any;
    position_observed_at: string | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    altitude_m: number | null;
    heading_deg: number | null;
    speed_mps: number | null;
    position_properties: any;
};

type TrackRow = {
    position_fix_id: string;
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    observed_at: string;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    altitude_m: number | null;
    heading_deg: number | null;
    speed_mps: number | null;
    properties: any;
};

type LiveStatusSampleRow = {
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    subtype: string | null;
    display_name: string | null;
    observed_at: string;
    display_lat: number | null;
    display_lng: number | null;
    altitude_m: number | null;
    heading_deg: number | null;
    speed_mps: number | null;
    properties: any;
};

function clampLimit(limit: number | undefined, fallback = 200, max = 5000): number {
    if (!Number.isFinite(limit)) return fallback;
    return Math.max(1, Math.min(max, Math.trunc(limit as number)));
}

export class EntityQueryService {
    constructor(private readonly database: DatabaseService) {}

    isReady(): boolean {
        return this.database.isReady();
    }

    private buildLatestWhere(filters: EntityQueryFilters) {
        const clauses: string[] = [];
        const params: unknown[] = [];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add('e.layer_id = ?', filters.layerId);
        if (filters.sourceId) add('COALESCE(p.source_id, e.source_id) = ?', filters.sourceId);
        if (filters.entityId) add('e.entity_id = ?', filters.entityId);
        if (filters.entityKind) add('e.entity_kind = ?', filters.entityKind);
        if (filters.subtype) add('e.subtype = ?', filters.subtype);
        if (filters.from) add('COALESCE(p.observed_at, e.last_observed_at, e.updated_at) >= ?::timestamptz', filters.from);
        if (filters.to) add('COALESCE(p.observed_at, e.last_observed_at, e.updated_at) <= ?::timestamptz', filters.to);
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            clauses.push(
                `p.geom IS NOT NULL AND ST_Intersects(p.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`,
            );
        }

        return { clauses, params };
    }

    async listLatest(filters: EntityQueryFilters) {
        if (!this.database.isReady()) return [];

        const { clauses, params } = this.buildLatestWhere(filters);
        params.push(clampLimit(filters.limit));
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

        const result = await this.database.query<LatestEntityRow>(
            `
                SELECT
                    e.entity_id,
                    e.layer_id,
                    e.source_id,
                    e.entity_kind,
                    e.subtype,
                    e.display_name,
                    e.first_observed_at,
                    e.last_observed_at,
                    e.updated_at,
                    e.properties,
                    p.observed_at AS position_observed_at,
                    CASE WHEN p.geom IS NOT NULL THEN ST_AsGeoJSON(p.geom)::jsonb ELSE NULL END AS geometry,
                    CASE WHEN p.geom IS NOT NULL THEN ST_Y(p.geom) ELSE NULL END AS display_lat,
                    CASE WHEN p.geom IS NOT NULL THEN ST_X(p.geom) ELSE NULL END AS display_lng,
                    p.altitude_m,
                    p.heading_deg,
                    p.speed_mps,
                    p.properties AS position_properties
                FROM core.entities e
                LEFT JOIN app.entity_live_states p ON p.entity_id = e.entity_id
                ${whereSql}
                ORDER BY COALESCE(p.observed_at, e.last_observed_at, e.updated_at) DESC NULLS LAST, e.updated_at DESC
                LIMIT $${params.length}
            `,
            params,
        );

        return result?.rows || [];
    }

    async getLiveStatus(filters: LiveStatusFilters) {
        if (!this.database.isReady()) {
            return {
                layer_id: filters.layerId || null,
                max_observed_at: null,
                entities_total: 0,
                entities_fresh: 0,
                freshness_minutes: filters.freshnessMinutes || 30,
                sample: [],
            };
        }

        const params: unknown[] = [];
        const clauses: string[] = [];
        if (filters.layerId) {
            params.push(filters.layerId);
            clauses.push(`ls.layer_id = $${params.length}`);
        }
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            clauses.push(`ls.geom IS NOT NULL AND ST_Intersects(ls.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`);
        }
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const freshnessMinutes = Math.max(1, Math.min(24 * 60, Math.trunc(filters.freshnessMinutes || 30)));
        const limit = clampLimit(filters.limit, 20, 200);

        const summaryParams = [...params, freshnessMinutes];
        const freshnessParam = summaryParams.length;
        const summary = await this.database.query(
            `
                SELECT
                    MAX(ls.observed_at) AS max_observed_at,
                    COUNT(*)::bigint AS entities_total,
                    COUNT(*) FILTER (WHERE ls.observed_at >= now() - ($${freshnessParam}::int * interval '1 minute'))::bigint AS entities_fresh
                FROM app.entity_live_states ls
                ${whereSql}
            `,
            summaryParams,
        );

        const sampleParams = [...params, limit];
        const result = await this.database.query<LiveStatusSampleRow>(
            `
                SELECT
                    ls.entity_id,
                    ls.layer_id,
                    ls.source_id,
                    e.subtype,
                    e.display_name,
                    ls.observed_at,
                    CASE WHEN ls.geom IS NOT NULL THEN ST_Y(ls.geom) ELSE NULL END AS display_lat,
                    CASE WHEN ls.geom IS NOT NULL THEN ST_X(ls.geom) ELSE NULL END AS display_lng,
                    ls.altitude_m,
                    ls.heading_deg,
                    ls.speed_mps,
                    COALESCE(ls.properties, e.properties) AS properties
                FROM app.entity_live_states ls
                LEFT JOIN core.entities e ON e.entity_id = ls.entity_id
                ${whereSql}
                ORDER BY ls.observed_at DESC NULLS LAST
                LIMIT $${sampleParams.length}
            `,
            sampleParams,
        );

        const row = summary?.rows?.[0] || {};
        return {
            layer_id: filters.layerId || null,
            max_observed_at: row.max_observed_at || null,
            entities_total: Number(row.entities_total || 0),
            entities_fresh: Number(row.entities_fresh || 0),
            freshness_minutes: freshnessMinutes,
            sample: result?.rows || [],
        };
    }

    async listTrack(filters: EntityTrackFilters) {
        if (!this.database.isReady()) return [];

        const params: unknown[] = [filters.entityId];
        const clauses = ['pf.entity_id = $1'];

        if (filters.from) {
            params.push(filters.from);
            clauses.push(`pf.observed_at >= $${params.length}::timestamptz`);
        }
        if (filters.to) {
            params.push(filters.to);
            clauses.push(`pf.observed_at <= $${params.length}::timestamptz`);
        }

        params.push(clampLimit(filters.limit, 500, 10000));
        const order = filters.order === 'desc' ? 'DESC' : 'ASC';

        const result = await this.database.query<TrackRow>(
            `
                SELECT
                    pf.position_fix_id,
                    pf.entity_id,
                    pf.layer_id,
                    pf.source_id,
                    pf.observed_at,
                    ST_AsGeoJSON(pf.geom)::jsonb AS geometry,
                    ST_Y(pf.geom) AS display_lat,
                    ST_X(pf.geom) AS display_lng,
                    pf.altitude_m,
                    pf.heading_deg,
                    pf.speed_mps,
                    pf.properties
                FROM core.position_fixes pf
                WHERE ${clauses.join(' AND ')}
                ORDER BY pf.observed_at ${order}, pf.created_at ${order}
                LIMIT $${params.length}
            `,
            params,
        );

        return result?.rows || [];
    }
}
