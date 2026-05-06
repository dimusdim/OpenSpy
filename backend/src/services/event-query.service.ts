import { DatabaseService } from '../db/database.service';

export type EventQueryFilters = {
    layerId?: string;
    sourceId?: string;
    eventId?: string;
    eventKind?: string;
    subtype?: string;
    from?: string;
    to?: string;
    bbox?: [number, number, number, number]; // south, west, north, east
    limit?: number;
    offset?: number;
};

type EventSnapshotRow = {
    event_snapshot_id: string;
    event_id: string;
    ingest_run_id: string | null;
    layer_id: string;
    source_id: string | null;
    event_kind: string;
    subtype: string | null;
    observed_at: string | null;
    valid_from: string | null;
    valid_to: string | null;
    created_at: string;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: any;
};

type LatestEventRow = {
    event_id: string;
    latest_snapshot_id: string | null;
    layer_id: string;
    source_id: string | null;
    event_kind: string;
    subtype: string | null;
    observed_at: string | null;
    valid_from: string | null;
    valid_to: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    updated_at: string;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: any;
};

function normalizeLimit(limit: number | undefined, fallback = 200): number {
    if (!Number.isFinite(limit)) return fallback;
    return Math.max(1, Math.trunc(limit as number));
}

export class EventQueryService {
    constructor(private readonly database: DatabaseService) {}

    isReady(): boolean {
        return this.database.isReady();
    }

    private buildWhere(filters: EventQueryFilters, alias = 't') {
        const clauses: string[] = [];
        const params: unknown[] = [];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add(`${alias}.layer_id = ?`, filters.layerId);
        if (filters.sourceId) add(`${alias}.source_id = ?`, filters.sourceId);
        if (filters.eventId) add(`${alias}.event_id = ?`, filters.eventId);
        if (filters.eventKind) add(`${alias}.event_kind = ?`, filters.eventKind);
        if (filters.subtype) add(`${alias}.subtype = ?`, filters.subtype);
        if (filters.from) add(`COALESCE(${alias}.observed_at, ${alias}.valid_from, ${alias}.created_at) >= ?::timestamptz`, filters.from);
        if (filters.to) add(`COALESCE(${alias}.observed_at, ${alias}.valid_from, ${alias}.created_at) <= ?::timestamptz`, filters.to);
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

    async listSnapshots(filters: EventQueryFilters) {
        if (!this.database.isReady()) return [];

        const { clauses, params } = this.buildWhere(filters, 's');
        const limit = normalizeLimit(filters.limit);
        const offset = Math.max(0, Math.trunc(Number(filters.offset || 0)));
        params.push(limit, offset);
        const limitParam = params.length - 1;
        const offsetParam = params.length;
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

        const result = await this.database.query<EventSnapshotRow>(
            `
                SELECT
                    s.event_snapshot_id,
                    s.event_id,
                    s.ingest_run_id,
                    s.layer_id,
                    s.source_id,
                    s.event_kind,
                    s.subtype,
                    s.observed_at,
                    s.valid_from,
                    s.valid_to,
                    s.created_at,
                    CASE WHEN s.geom IS NOT NULL THEN ST_AsGeoJSON(s.geom)::jsonb ELSE NULL END AS geometry,
                    CASE WHEN s.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lat,
                    CASE WHEN s.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lng,
                    s.properties
                FROM core.event_snapshots s
                ${whereSql}
                ORDER BY COALESCE(s.observed_at, s.valid_from, s.created_at) DESC NULLS LAST, s.created_at DESC
                LIMIT $${limitParam} OFFSET $${offsetParam}
            `,
            params,
        );

        return result?.rows || [];
    }

    async listLatest(filters: EventQueryFilters) {
        if (!this.database.isReady()) return [];

        const { clauses, params } = this.buildWhere(filters, 'e');
        const limit = normalizeLimit(filters.limit);
        const offset = Math.max(0, Math.trunc(Number(filters.offset || 0)));
        params.push(limit, offset);
        const limitParam = params.length - 1;
        const offsetParam = params.length;
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

        const result = await this.database.query<LatestEventRow>(
            `
                SELECT
                    e.event_id,
                    e.latest_snapshot_id,
                    e.layer_id,
                    e.source_id,
                    e.event_kind,
                    e.subtype,
                    e.observed_at,
                    e.valid_from,
                    e.valid_to,
                    e.first_observed_at,
                    e.last_observed_at,
                    e.updated_at,
                    CASE WHEN e.geom IS NOT NULL THEN ST_AsGeoJSON(e.geom)::jsonb ELSE NULL END AS geometry,
                    CASE WHEN e.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(e.geom)) ELSE NULL END AS display_lat,
                    CASE WHEN e.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(e.geom)) ELSE NULL END AS display_lng,
                    e.properties
                FROM core.events e
                ${whereSql}
                ORDER BY COALESCE(e.observed_at, e.valid_from, e.updated_at) DESC NULLS LAST, e.updated_at DESC
                LIMIT $${limitParam} OFFSET $${offsetParam}
            `,
            params,
        );

        return result?.rows || [];
    }

    async summarizeSnapshots(filters: EventQueryFilters) {
        if (!this.database.isReady()) return null;

        const { clauses, params } = this.buildWhere(filters, 's');
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

        const result = await this.database.query<{
            snapshot_count: string;
            distinct_event_count: string;
            min_time: string | null;
            max_time: string | null;
        }>(
            `
                SELECT
                    COUNT(*)::text AS snapshot_count,
                    COUNT(DISTINCT s.event_id)::text AS distinct_event_count,
                    MIN(COALESCE(s.observed_at, s.valid_from, s.created_at))::text AS min_time,
                    MAX(COALESCE(s.observed_at, s.valid_from, s.created_at))::text AS max_time
                FROM core.event_snapshots s
                ${whereSql}
            `,
            params,
        );

        return result?.rows[0] || null;
    }
}
