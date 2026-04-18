import * as satelliteJs from 'satellite.js';
import { DatabaseService } from '../db/database.service';

export type ReplayStateFilters = {
    at: string;
    layerId?: string;
    sourceId?: string;
    entityId?: string;
    entityKind?: string;
    eventId?: string;
    eventKind?: string;
    assetId?: string;
    assetKind?: string;
    subtype?: string;
    bbox?: [number, number, number, number];
    limit?: number;
};

export type ReplayWindowFilters = {
    from: string;
    to: string;
    layerId?: string;
    sourceId?: string;
    entityId?: string;
    entityKind?: string;
    eventId?: string;
    eventKind?: string;
    assetId?: string;
    assetKind?: string;
    subtype?: string;
    bbox?: [number, number, number, number];
    limit?: number;
    stepSeconds?: number;
};

type ReplayEntityRow = {
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    entity_kind: string;
    subtype: string | null;
    display_name: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    updated_at: string;
    entity_observed_at: string | null;
    entity_properties: any;
    position_observed_at: string | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    altitude_m: number | null;
    heading_deg: number | null;
    speed_mps: number | null;
    position_properties: any;
};

type ReplayEventRow = {
    event_id: string;
    layer_id: string;
    source_id: string | null;
    event_kind: string;
    subtype: string | null;
    observed_at: string | null;
    valid_from: string | null;
    valid_to: string | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: any;
};

type ReplayAssetRow = {
    asset_id: string;
    layer_id: string;
    source_id: string | null;
    asset_kind: string;
    subtype: string | null;
    display_name: string | null;
    observed_at: string | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: any;
};

type ReplaySatelliteRow = {
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    entity_kind: string;
    subtype: string | null;
    display_name: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    updated_at: string;
    entity_observed_at: string | null;
    entity_properties: any;
    orbital_observed_at: string | null;
    tle_line1: string | null;
    tle_line2: string | null;
    orbital_properties: any;
};

type ReplayTrackRow = {
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

type ReplayWindowItem =
    | {
        at: string;
        family: 'entity';
        op: 'upsert';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        item: ReplayEntityRow;
    }
    | {
        at: string;
        family: 'entity';
        op: 'remove';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        entity_id: string;
        reason: string;
    }
    | {
        at: string;
        family: 'event';
        op: 'upsert';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        item: ReplayEventRow;
    }
    | {
        at: string;
        family: 'event';
        op: 'remove';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        event_id: string;
        reason: string;
    }
    | {
        at: string;
        family: 'asset';
        op: 'upsert';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        item: ReplayAssetRow;
    };

type SatelliteTrackFilters = {
    entityId: string;
    from?: string;
    to?: string;
    limit?: number;
    order?: 'asc' | 'desc';
    stepSeconds?: number;
};

type ReplayWindowEntitySqlRow = {
    op_kind: 'upsert' | 'remove';
    effective_at: string;
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    entity_kind: string | null;
    subtype: string | null;
    display_name: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    updated_at: string | null;
    entity_observed_at: string | null;
    entity_properties: any;
    position_observed_at: string | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    altitude_m: number | null;
    heading_deg: number | null;
    speed_mps: number | null;
    position_properties: any;
    remove_reason: string | null;
};

type ReplayWindowEventSqlRow = {
    op_kind: 'upsert' | 'remove';
    effective_at: string;
    event_id: string;
    layer_id: string;
    source_id: string | null;
    event_kind: string | null;
    subtype: string | null;
    observed_at: string | null;
    valid_from: string | null;
    valid_to: string | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: any;
    remove_reason: string | null;
};

function normalizeLimit(limit: number | undefined): number | null {
    if (!Number.isFinite(limit)) return null;
    return Math.max(1, Math.trunc(limit as number));
}

const DEG = 180 / Math.PI;

type ReplayFireClusterRow = {
    source_id: string | null;
    subtype: string | null;
    event_kind: string;
    observed_at: string | null;
    valid_from: string | null;
    valid_to: string | null;
    display_lat: number;
    display_lng: number;
    geometry: {
        type: 'Point';
        coordinates: [number, number];
    };
    properties: Record<string, any>;
    count: number;
    max_frp: number;
    max_brightness: number;
};

export class ReplayQueryService {
    private readonly satelliteSatrecCache = new Map<string, satelliteJs.SatRec>();

    constructor(private readonly database: DatabaseService) {}

    isReady(): boolean {
        return this.database.isReady();
    }

    private async getSourceLiveContractSeconds(
        sourceId: string,
        contractField: 'stale_after_sec' | 'remove_after_sec',
        fallbackSeconds: number,
    ): Promise<number> {
        if (!this.database.isReady()) return fallbackSeconds;

        const result = await this.database.query<{ manifest: Record<string, any> | null }>(
            `
                SELECT manifest
                FROM catalog.sources
                WHERE source_id = $1
                LIMIT 1
            `,
            [sourceId],
        );

        const liveContract = result?.rows?.[0]?.manifest?.live_contract;
        const value = liveContract?.[contractField];
        return Number.isFinite(value) && value > 0 ? Number(value) : fallbackSeconds;
    }

    private isMovingEntityReplay(filters: { layerId?: string; entityId?: string }): boolean {
        if (filters.layerId === 'aircraft' || filters.layerId === 'vessel') return true;
        if (filters.entityId?.startsWith('aircraft:') || filters.entityId?.startsWith('vessel:')) return true;
        return false;
    }

    private isSatelliteReplay(filters: { layerId?: string; entityId?: string }): boolean {
        if (filters.layerId === 'satellite' || filters.layerId === 'satellites') return true;
        if (filters.entityId?.startsWith('satellite:')) return true;
        return false;
    }

    private normalizeTrackWindow(filters: SatelliteTrackFilters): { from: string; to: string } {
        const to = filters.to || new Date().toISOString();
        const from = filters.from || new Date(new Date(to).getTime() - 24 * 60 * 60 * 1000).toISOString();
        return new Date(from) <= new Date(to) ? { from, to } : { from: to, to: from };
    }

    private normalizeReplayWindow(filters: ReplayWindowFilters): { from: string; to: string } {
        return new Date(filters.from) <= new Date(filters.to)
            ? { from: filters.from, to: filters.to }
            : { from: filters.to, to: filters.from };
    }

    private bboxContains(bbox: [number, number, number, number], lat: number, lng: number): boolean {
        const [south, west, north, east] = bbox;
        return lat >= south && lat <= north && lng >= west && lng <= east;
    }

    private getSatelliteSatrec(tleLine1: string, tleLine2: string): satelliteJs.SatRec | null {
        const key = `${tleLine1}\n${tleLine2}`;
        const cached = this.satelliteSatrecCache.get(key);
        if (cached) return cached;
        try {
            const satrec = satelliteJs.twoline2satrec(tleLine1, tleLine2);
            if (this.satelliteSatrecCache.size > 50000) this.satelliteSatrecCache.clear();
            this.satelliteSatrecCache.set(key, satrec);
            return satrec;
        } catch {
            return null;
        }
    }

    private propagateSatellitePosition(
        tleLine1: string,
        tleLine2: string,
        at: string,
    ): { lat: number; lng: number; altitudeM: number } | null {
        const satrec = this.getSatelliteSatrec(tleLine1, tleLine2);
        if (!satrec) return null;
        const date = new Date(at);
        const pv = satelliteJs.propagate(satrec, date);
        if (!pv.position || typeof pv.position === 'boolean') return null;
        const gmst = satelliteJs.gstime(date);
        const geo = satelliteJs.eciToGeodetic(pv.position as satelliteJs.EciVec3<number>, gmst);
        const lng = geo.longitude * DEG;
        const lat = geo.latitude * DEG;
        const altitudeM = geo.height * 1000;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(altitudeM)) return null;
        return { lat, lng, altitudeM };
    }

    private clampStepSeconds(stepSeconds: number | undefined): number {
        if (!Number.isFinite(stepSeconds)) return 60;
        return Math.max(1, Math.min(3600, Math.trunc(stepSeconds as number)));
    }

    private getReplayFireGridDegrees(
        filters: Pick<ReplayStateFilters, 'bbox' | 'eventId'> | Pick<ReplayWindowFilters, 'bbox' | 'eventId'>,
    ): number | null {
        if (filters.eventId) return null;
        if (!filters.bbox) return 4.0;
        const [south, west, north, east] = filters.bbox;
        const latSpan = Math.max(0, north - south);
        const lngSpan = Math.max(0, east - west);
        const maxSpan = Math.max(latSpan, lngSpan);
        if (maxSpan >= 120) return 4.0;
        if (maxSpan >= 60) return 2.0;
        if (maxSpan >= 20) return 1.0;
        return null;
    }

    private toReplayFireClusterRows(
        rows: ReplayEventRow[],
        gridDegrees: number,
    ): ReplayEventRow[] {
        const buckets = new Map<string, ReplayFireClusterRow>();
        const passthrough: ReplayEventRow[] = [];

        for (const row of rows) {
            if (row.layer_id !== 'fire') {
                passthrough.push(row);
                continue;
            }
            if (!Number.isFinite(row.display_lat) || !Number.isFinite(row.display_lng)) {
                passthrough.push(row);
                continue;
            }

            const latBin = Math.floor((row.display_lat as number) / gridDegrees);
            const lngBin = Math.floor((row.display_lng as number) / gridDegrees);
            const key = [
                gridDegrees,
                row.source_id || 'all',
                row.subtype || 'unknown',
                latBin,
                lngBin,
            ].join(':');
            const props = row.properties && typeof row.properties === 'object' ? row.properties : {};
            const frp = Number.isFinite(props.frp) ? Number(props.frp) : 0;
            const brightness = Number.isFinite(props.brightness) ? Number(props.brightness) : 0;
            const logicalCount = Number.isFinite(props.count) && Number(props.count) > 0 ? Number(props.count) : 1;
            const current = buckets.get(key);

            if (!current) {
                buckets.set(key, {
                    source_id: row.source_id,
                    subtype: row.subtype,
                    event_kind: row.event_kind || 'fire_cluster',
                    observed_at: row.observed_at,
                    valid_from: row.valid_from,
                    valid_to: row.valid_to,
                    display_lat: (row.display_lat as number) * logicalCount,
                    display_lng: (row.display_lng as number) * logicalCount,
                    geometry: {
                        type: 'Point',
                        coordinates: [row.display_lng as number, row.display_lat as number],
                    },
                    properties: { ...props },
                    count: logicalCount,
                    max_frp: frp,
                    max_brightness: brightness,
                });
                continue;
            }

            current.display_lat += (row.display_lat as number) * logicalCount;
            current.display_lng += (row.display_lng as number) * logicalCount;
            current.count += logicalCount;
            if ((row.observed_at || '') > (current.observed_at || '')) current.observed_at = row.observed_at;
            if ((row.valid_from || '') > (current.valid_from || '')) current.valid_from = row.valid_from;
            if ((row.valid_to || '') > (current.valid_to || '')) current.valid_to = row.valid_to;
            current.max_frp = Math.max(current.max_frp, frp);
            current.max_brightness = Math.max(current.max_brightness, brightness);
        }

        const clustered = Array.from(buckets.entries()).map(([key, bucket]) => {
            const avgLat = bucket.display_lat / bucket.count;
            const avgLng = bucket.display_lng / bucket.count;
            return {
                event_id: `fire-cluster:${key}`,
                layer_id: 'fire',
                source_id: bucket.source_id,
                event_kind: bucket.event_kind,
                subtype: bucket.subtype,
                observed_at: bucket.observed_at,
                valid_from: bucket.valid_from,
                valid_to: bucket.valid_to,
                geometry: {
                    type: 'Point',
                    coordinates: [avgLng, avgLat],
                },
                display_lat: avgLat,
                display_lng: avgLng,
                properties: {
                    ...bucket.properties,
                    aggregated: true,
                    count: bucket.count,
                    frp: bucket.max_frp,
                    brightness: bucket.max_brightness,
                },
            } satisfies ReplayEventRow;
        });

        return [...passthrough, ...clustered];
    }

    private aggregateReplayFireState(
        rows: ReplayEventRow[],
        filters: ReplayStateFilters,
    ): ReplayEventRow[] {
        const gridDegrees = this.getReplayFireGridDegrees(filters);
        if (!gridDegrees) return rows;
        return this.toReplayFireClusterRows(rows, gridDegrees);
    }

    private aggregateReplayFireWindow(
        items: ReplayWindowItem[],
        filters: ReplayWindowFilters,
    ): ReplayWindowItem[] {
        const gridDegrees = this.getReplayFireGridDegrees(filters);
        if (!gridDegrees) return items;

        const bucketSeconds = Math.max(60, this.clampStepSeconds(filters.stepSeconds ?? 300));
        const fireBuckets = new Map<string, {
            at: string;
            target_id: string;
            layer_id: string;
            source_id: string | null;
            row: ReplayEventRow;
            count: number;
            weightedLat: number;
            weightedLng: number;
            maxFrp: number;
            maxBrightness: number;
        }>();
        const passthrough: ReplayWindowItem[] = [];

        for (const item of items) {
            if (item.family !== 'event' || item.layer_id !== 'fire' || item.op !== 'upsert') {
                passthrough.push(item);
                continue;
            }
            const lat = Number(item.item.display_lat);
            const lng = Number(item.item.display_lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                passthrough.push(item);
                continue;
            }
            const props = item.item.properties && typeof item.item.properties === 'object' ? item.item.properties : {};
            const logicalCount = Number.isFinite(props.count) && Number(props.count) > 0 ? Number(props.count) : 1;
            const frp = Number.isFinite(props.frp) ? Number(props.frp) : 0;
            const brightness = Number.isFinite(props.brightness) ? Number(props.brightness) : 0;
            const latBin = Math.floor(lat / gridDegrees);
            const lngBin = Math.floor(lng / gridDegrees);
            const bucketMs = Math.floor(new Date(item.at).getTime() / (bucketSeconds * 1000));
            const clusterId = [
                gridDegrees,
                item.source_id || 'all',
                item.item.subtype || 'unknown',
                latBin,
                lngBin,
            ].join(':');
            const key = `${bucketMs}:${clusterId}`;
            const current = fireBuckets.get(key);
            if (!current) {
                fireBuckets.set(key, {
                    at: item.at,
                    target_id: `fire-cluster:${clusterId}`,
                    layer_id: item.layer_id,
                    source_id: item.source_id,
                    row: {
                        ...item.item,
                        event_id: `fire-cluster:${clusterId}`,
                    },
                    count: logicalCount,
                    weightedLat: lat * logicalCount,
                    weightedLng: lng * logicalCount,
                    maxFrp: frp,
                    maxBrightness: brightness,
                });
                continue;
            }
            current.count += logicalCount;
            current.weightedLat += lat * logicalCount;
            current.weightedLng += lng * logicalCount;
            current.maxFrp = Math.max(current.maxFrp, frp);
            current.maxBrightness = Math.max(current.maxBrightness, brightness);
            if (item.at > current.at) {
                current.at = item.at;
                current.row = {
                    ...item.item,
                    event_id: `fire-cluster:${clusterId}`,
                };
            }
        }

        const clustered = Array.from(fireBuckets.values()).map((bucket) => {
            const avgLat = bucket.weightedLat / bucket.count;
            const avgLng = bucket.weightedLng / bucket.count;
            return {
                at: bucket.at,
                family: 'event',
                op: 'upsert',
                target_id: bucket.target_id,
                layer_id: bucket.layer_id,
                source_id: bucket.source_id,
                item: {
                    ...bucket.row,
                    geometry: {
                        type: 'Point',
                        coordinates: [avgLng, avgLat],
                    },
                    display_lat: avgLat,
                    display_lng: avgLng,
                    properties: {
                        ...(bucket.row.properties && typeof bucket.row.properties === 'object' ? bucket.row.properties : {}),
                        aggregated: true,
                        count: bucket.count,
                        frp: bucket.maxFrp,
                        brightness: bucket.maxBrightness,
                    },
                },
            } satisfies ReplayWindowItem;
        });

        return [...passthrough, ...clustered].sort((left, right) => {
            const dt = new Date(left.at).getTime() - new Date(right.at).getTime();
            if (dt !== 0) return dt;
            return left.target_id.localeCompare(right.target_id);
        });
    }

    private async listMovingEntityStateAt(filters: ReplayStateFilters): Promise<ReplayEntityRow[]> {
        const sourceId = filters.sourceId
            || (filters.layerId === 'vessel' || filters.entityId?.startsWith('vessel:') ? 'aisstream' : 'opensky');
        const fallbackStaleAfterSeconds = sourceId === 'aisstream' ? 3600 : 300;
        const staleAfterSeconds = await this.getSourceLiveContractSeconds(sourceId, 'stale_after_sec', fallbackStaleAfterSeconds);

        const params: unknown[] = [filters.at, staleAfterSeconds];
        const fixClauses = [
            'pf.observed_at <= $1::timestamptz',
            "pf.observed_at >= ($1::timestamptz - ($2::text || ' seconds')::interval)",
        ];
        const outerClauses: string[] = [];

        const addFix = (sql: string, value?: unknown) => {
            params.push(value);
            fixClauses.push(sql.replace('?', `$${params.length}`));
        };

        const addOuter = (sql: string, value?: unknown) => {
            params.push(value);
            outerClauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) addFix('pf.layer_id = ?', filters.layerId);
        if (filters.sourceId) addFix('pf.source_id = ?', filters.sourceId);
        if (filters.entityId) addFix('pf.entity_id = ?', filters.entityId);
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            fixClauses.push(
                `pf.geom IS NOT NULL AND ST_Intersects(pf.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`,
            );
        }

        if (filters.entityKind) addOuter('e.entity_kind = ?', filters.entityKind);
        if (filters.subtype) addOuter('COALESCE(es.subtype, e.subtype) = ?', filters.subtype);

        const normalizedLimit = normalizeLimit(filters.limit);
        const limitSql = normalizedLimit ? `LIMIT $${params.push(normalizedLimit)}` : '';
        const outerWhereSql = outerClauses.length ? `WHERE ${outerClauses.join(' AND ')}` : '';

        const result = await this.database.query<ReplayEntityRow>(
            `
                WITH latest_fix AS (
                    SELECT DISTINCT ON (pf.entity_id)
                        pf.entity_id,
                        pf.layer_id,
                        pf.source_id,
                        pf.observed_at AS position_observed_at,
                        NULL::jsonb AS geometry,
                        ST_Y(pf.geom) AS display_lat,
                        ST_X(pf.geom) AS display_lng,
                        pf.altitude_m,
                        pf.heading_deg,
                        pf.speed_mps,
                        pf.properties AS position_properties
                    FROM core.position_fixes pf
                    WHERE ${fixClauses.join(' AND ')}
                    ORDER BY pf.entity_id, pf.observed_at DESC, pf.created_at DESC
                )
                SELECT
                    e.entity_id,
                    e.layer_id,
                    e.source_id,
                    e.entity_kind,
                    COALESCE(es.subtype, e.subtype) AS subtype,
                    COALESCE(es.display_name, e.display_name) AS display_name,
                    e.first_observed_at,
                    e.last_observed_at,
                    e.updated_at,
                    es.observed_at AS entity_observed_at,
                    COALESCE(es.properties, e.properties) AS entity_properties,
                    lf.position_observed_at,
                    lf.geometry,
                    lf.display_lat,
                    lf.display_lng,
                    lf.altitude_m,
                    lf.heading_deg,
                    lf.speed_mps,
                    lf.position_properties
                FROM latest_fix lf
                JOIN core.entities e ON e.entity_id = lf.entity_id
                LEFT JOIN LATERAL (
                    SELECT
                        snap.observed_at,
                        snap.subtype,
                        snap.display_name,
                        snap.properties
                    FROM core.entity_snapshots snap
                    WHERE snap.entity_id = lf.entity_id
                      AND COALESCE(snap.observed_at, snap.created_at) <= $1::timestamptz
                    ORDER BY COALESCE(snap.observed_at, snap.created_at) DESC, snap.created_at DESC
                    LIMIT 1
                ) es ON true
                ${outerWhereSql}
                ORDER BY lf.position_observed_at DESC, e.updated_at DESC
                ${limitSql}
            `,
            params,
        );

        return result?.rows || [];
    }

    private async listSnapshotOnlyEntityStateAt(filters: ReplayStateFilters): Promise<ReplayEntityRow[]> {
        const params: unknown[] = [filters.at];
        const clauses = ['COALESCE(es.observed_at, es.created_at) <= $1::timestamptz'];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add('es.layer_id = ?', filters.layerId);
        if (filters.sourceId) add('es.source_id = ?', filters.sourceId);
        if (filters.entityId) add('es.entity_id = ?', filters.entityId);
        if (filters.entityKind) add('es.entity_kind = ?', filters.entityKind);
        if (filters.subtype) add('es.subtype = ?', filters.subtype);

        const normalizedLimit = normalizeLimit(filters.limit);
        const limitSql = normalizedLimit ? `LIMIT $${params.push(normalizedLimit)}` : '';

        const result = await this.database.query<ReplayEntityRow>(
            `
                WITH entity_state AS (
                    SELECT DISTINCT ON (es.entity_id)
                        es.entity_id,
                        es.layer_id,
                        es.source_id,
                        es.entity_kind,
                        es.subtype,
                        es.display_name,
                        es.observed_at AS entity_observed_at,
                        es.properties AS entity_properties
                    FROM core.entity_snapshots es
                    WHERE ${clauses.join(' AND ')}
                    ORDER BY es.entity_id, COALESCE(es.observed_at, es.created_at) DESC, es.created_at DESC
                )
                SELECT
                    es.entity_id,
                    es.layer_id,
                    es.source_id,
                    es.entity_kind,
                    es.subtype,
                    es.display_name,
                    e.first_observed_at,
                    e.last_observed_at,
                    e.updated_at,
                    es.entity_observed_at,
                    es.entity_properties,
                    NULL::timestamptz AS position_observed_at,
                    NULL::jsonb AS geometry,
                    NULL::double precision AS display_lat,
                    NULL::double precision AS display_lng,
                    NULL::double precision AS altitude_m,
                    NULL::double precision AS heading_deg,
                    NULL::double precision AS speed_mps,
                    NULL::jsonb AS position_properties
                FROM entity_state es
                JOIN core.entities e ON e.entity_id = es.entity_id
                ORDER BY COALESCE(es.entity_observed_at, e.updated_at) DESC NULLS LAST, e.updated_at DESC
                ${limitSql}
            `,
            params,
        );

        return result?.rows || [];
    }

    private async listSatelliteStateAt(filters: ReplayStateFilters): Promise<ReplayEntityRow[]> {
        const params: unknown[] = [filters.at];
        const orbitalClauses = ['oe.layer_id = $2', 'oe.observed_at <= $1::timestamptz'];
        const outerClauses: string[] = [];

        params.push('satellite');

        const addOrbital = (sql: string, value?: unknown) => {
            params.push(value);
            orbitalClauses.push(sql.replace('?', `$${params.length}`));
        };

        const addOuter = (sql: string, value?: unknown) => {
            params.push(value);
            outerClauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.sourceId) addOrbital('oe.source_id = ?', filters.sourceId);
        if (filters.entityId) addOrbital('oe.entity_id = ?', filters.entityId);
        if (filters.entityKind) addOuter('e.entity_kind = ?', filters.entityKind);
        if (filters.subtype) addOuter('COALESCE(es.subtype, e.subtype) = ?', filters.subtype);

        const result = await this.database.query<ReplaySatelliteRow>(
            `
                WITH latest_orbital AS (
                    SELECT DISTINCT ON (oe.entity_id)
                        oe.orbital_element_id,
                        oe.entity_id,
                        oe.layer_id,
                        oe.source_id,
                        oe.observed_at AS orbital_observed_at,
                        oe.tle_line1,
                        oe.tle_line2,
                        oe.properties AS orbital_properties
                    FROM core.orbital_elements oe
                    WHERE ${orbitalClauses.join(' AND ')}
                    ORDER BY oe.entity_id, oe.observed_at DESC, oe.created_at DESC
                )
                SELECT
                    e.entity_id,
                    e.layer_id,
                    e.source_id,
                    e.entity_kind,
                    COALESCE(es.subtype, e.subtype) AS subtype,
                    COALESCE(es.display_name, e.display_name) AS display_name,
                    e.first_observed_at,
                    e.last_observed_at,
                    e.updated_at,
                    es.observed_at AS entity_observed_at,
                    COALESCE(es.properties, e.properties) AS entity_properties,
                    lo.orbital_observed_at,
                    lo.tle_line1,
                    lo.tle_line2,
                    lo.orbital_properties
                FROM latest_orbital lo
                JOIN core.entities e ON e.entity_id = lo.entity_id
                LEFT JOIN LATERAL (
                    SELECT
                        snap.observed_at,
                        snap.subtype,
                        snap.display_name,
                        snap.properties
                    FROM core.entity_snapshots snap
                    WHERE snap.entity_id = lo.entity_id
                      AND COALESCE(snap.observed_at, snap.created_at) <= $1::timestamptz
                    ORDER BY COALESCE(snap.observed_at, snap.created_at) DESC, snap.created_at DESC
                    LIMIT 1
                ) es ON true
                ${outerClauses.length ? `WHERE ${outerClauses.join(' AND ')}` : ''}
                ORDER BY COALESCE(es.observed_at, lo.orbital_observed_at, e.updated_at) DESC NULLS LAST, e.updated_at DESC
            `,
            params,
        );

        const selectedRows = [...(result?.rows || [])]
            .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
        const normalizedLimit = normalizeLimit(filters.limit);
        const limitedRows = normalizedLimit
            ? selectedRows.slice(0, normalizedLimit)
            : selectedRows;

        const items: ReplayEntityRow[] = [];
        for (const row of limitedRows) {
            if (!row.tle_line1 || !row.tle_line2) continue;
            const position = this.propagateSatellitePosition(row.tle_line1, row.tle_line2, filters.at);
            if (!position) continue;
            if (filters.bbox && !this.bboxContains(filters.bbox, position.lat, position.lng)) continue;
            items.push({
                entity_id: row.entity_id,
                layer_id: row.layer_id,
                source_id: row.source_id,
                entity_kind: row.entity_kind,
                subtype: row.subtype,
                display_name: row.display_name,
                first_observed_at: row.first_observed_at,
                last_observed_at: row.last_observed_at,
                updated_at: row.updated_at,
                entity_observed_at: row.entity_observed_at,
                entity_properties: row.entity_properties,
                position_observed_at: filters.at,
                geometry: null,
                display_lat: position.lat,
                display_lng: position.lng,
                altitude_m: position.altitudeM,
                heading_deg: null,
                speed_mps: null,
                position_properties: {
                    replay_basis: 'propagated_from_tle',
                    orbital_observed_at: row.orbital_observed_at,
                    ...(row.orbital_properties || {}),
                },
            });
        }

        return items;
    }

    async listSatelliteTrack(filters: SatelliteTrackFilters): Promise<ReplayTrackRow[]> {
        if (!this.database.isReady()) return [];

        const { from, to } = this.normalizeTrackWindow(filters);
        const stepSeconds = this.clampStepSeconds(filters.stepSeconds);
        const normalizedLimit = normalizeLimit(filters.limit) || 1000;

        const result = await this.database.query<{
            entity_id: string;
            layer_id: string;
            source_id: string | null;
            observed_at: string;
            tle_line1: string | null;
            tle_line2: string | null;
            properties: any;
        }>(
            `
                WITH seed AS (
                    SELECT
                        oe.entity_id,
                        oe.layer_id,
                        oe.source_id,
                        oe.observed_at,
                        oe.tle_line1,
                        oe.tle_line2,
                        oe.properties,
                        oe.created_at
                    FROM core.orbital_elements oe
                    WHERE oe.entity_id = $1
                      AND oe.observed_at <= $3::timestamptz
                    ORDER BY oe.observed_at DESC, oe.created_at DESC
                    LIMIT 1
                ),
                in_range AS (
                    SELECT
                        oe.entity_id,
                        oe.layer_id,
                        oe.source_id,
                        oe.observed_at,
                        oe.tle_line1,
                        oe.tle_line2,
                        oe.properties,
                        oe.created_at
                    FROM core.orbital_elements oe
                    WHERE oe.entity_id = $1
                      AND oe.observed_at >= $2::timestamptz
                      AND oe.observed_at <= $3::timestamptz
                )
                SELECT DISTINCT ON (observed_at, COALESCE(tle_line1, ''), COALESCE(tle_line2, ''))
                    entity_id,
                    layer_id,
                    source_id,
                    observed_at,
                    tle_line1,
                    tle_line2,
                    properties
                FROM (
                    SELECT * FROM seed
                    UNION ALL
                    SELECT * FROM in_range
                ) snapshots
                ORDER BY observed_at ASC
            `,
            [filters.entityId, from, to],
        );

        const snapshots = (result?.rows || []).filter((row) => row.tle_line1 && row.tle_line2);
        if (snapshots.length === 0) return [];

        const points: ReplayTrackRow[] = [];
        const windowEndMs = new Date(to).getTime();
        const windowStartMs = new Date(from).getTime();

        for (let i = 0; i < snapshots.length; i++) {
            const current = snapshots[i];
            const next = snapshots[i + 1];
            const segmentStartMs = Math.max(windowStartMs, new Date(current.observed_at).getTime());
            const segmentEndMs = Math.min(windowEndMs, next ? new Date(next.observed_at).getTime() : windowEndMs);
            if (segmentStartMs > segmentEndMs) continue;

            for (let sampleMs = segmentStartMs; sampleMs <= segmentEndMs; sampleMs += stepSeconds * 1000) {
                const observedAt = new Date(sampleMs).toISOString();
                const position = this.propagateSatellitePosition(current.tle_line1!, current.tle_line2!, observedAt);
                if (!position) continue;
                points.push({
                    position_fix_id: `sat-track:${filters.entityId}:${observedAt}`,
                    entity_id: filters.entityId,
                    layer_id: current.layer_id,
                    source_id: current.source_id,
                    observed_at: observedAt,
                    geometry: {
                        type: 'Point',
                        coordinates: [position.lng, position.lat, position.altitudeM],
                    },
                    display_lat: position.lat,
                    display_lng: position.lng,
                    altitude_m: position.altitudeM,
                    heading_deg: null,
                    speed_mps: null,
                    properties: {
                        replay_basis: 'propagated_from_tle',
                        orbital_observed_at: current.observed_at,
                        step_seconds: stepSeconds,
                        ...(current.properties || {}),
                    },
                });
                if (points.length >= normalizedLimit) break;
            }

            if (points.length >= normalizedLimit) break;
            if (points.length > 0) {
                const lastAt = points[points.length - 1].observed_at;
                if (lastAt !== new Date(segmentEndMs).toISOString() && segmentEndMs < windowEndMs && points.length < normalizedLimit) {
                    const observedAt = new Date(segmentEndMs).toISOString();
                    const position = this.propagateSatellitePosition(current.tle_line1!, current.tle_line2!, observedAt);
                    if (position) {
                        points.push({
                            position_fix_id: `sat-track:${filters.entityId}:${observedAt}`,
                            entity_id: filters.entityId,
                            layer_id: current.layer_id,
                            source_id: current.source_id,
                            observed_at: observedAt,
                            geometry: {
                                type: 'Point',
                                coordinates: [position.lng, position.lat, position.altitudeM],
                            },
                            display_lat: position.lat,
                            display_lng: position.lng,
                            altitude_m: position.altitudeM,
                            heading_deg: null,
                            speed_mps: null,
                            properties: {
                                replay_basis: 'propagated_from_tle',
                                orbital_observed_at: current.observed_at,
                                step_seconds: stepSeconds,
                                ...(current.properties || {}),
                            },
                        });
                    }
                }
            }
        }

        if (filters.order === 'desc') points.reverse();
        return points;
    }

    private async listMovingEntityWindow(filters: ReplayWindowFilters): Promise<ReplayWindowItem[]> {
        const { from, to } = this.normalizeReplayWindow(filters);
        const params: unknown[] = [from, to];
        const fixClauses = [
            'pf.observed_at <= $2::timestamptz',
            'pf.observed_at > $1::timestamptz',
        ];
        const entityFilters: string[] = [];

        const addFix = (sql: string, value?: unknown) => {
            params.push(value);
            fixClauses.push(sql.replace('?', `$${params.length}`));
        };

        const addEntityFilter = (sql: string, value?: unknown) => {
            params.push(value);
            entityFilters.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) addFix('pf.layer_id = ?', filters.layerId);
        if (filters.sourceId) addFix('pf.source_id = ?', filters.sourceId);
        if (filters.entityId) addFix('pf.entity_id = ?', filters.entityId);
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            fixClauses.push(
                `pf.geom IS NOT NULL AND ST_Intersects(pf.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`,
            );
        }
        if (filters.entityKind) addEntityFilter('e.entity_kind = ?', filters.entityKind);
        if (filters.subtype) addEntityFilter('COALESCE(es.subtype, e.subtype) = ?', filters.subtype);

        const result = await this.database.query<ReplayWindowEntitySqlRow>(
            `
                WITH window_fixes AS (
                    SELECT
                        pf.entity_id,
                        pf.layer_id,
                        pf.source_id,
                        pf.observed_at,
                        pf.created_at,
                        pf.geom,
                        pf.altitude_m,
                        pf.heading_deg,
                        pf.speed_mps,
                        pf.properties
                    FROM core.position_fixes pf
                    WHERE ${fixClauses.join(' AND ')}
                )
                SELECT
                    'upsert'::text AS op_kind,
                    f.observed_at AS effective_at,
                    f.entity_id,
                    e.layer_id,
                    e.source_id,
                    e.entity_kind,
                    COALESCE(es.subtype, e.subtype) AS subtype,
                    COALESCE(es.display_name, e.display_name) AS display_name,
                    e.first_observed_at,
                    e.last_observed_at,
                    e.updated_at,
                    es.observed_at AS entity_observed_at,
                    NULL::jsonb AS entity_properties,
                    f.observed_at AS position_observed_at,
                    NULL::jsonb AS geometry,
                    ST_Y(f.geom) AS display_lat,
                    ST_X(f.geom) AS display_lng,
                    f.altitude_m,
                    f.heading_deg,
                    f.speed_mps,
                    NULL::jsonb AS position_properties,
                    NULL::text AS remove_reason
                FROM window_fixes f
                JOIN core.entities e ON e.entity_id = f.entity_id
                LEFT JOIN LATERAL (
                    SELECT
                        snap.observed_at,
                        snap.subtype,
                        snap.display_name,
                        snap.properties
                    FROM core.entity_snapshots snap
                    WHERE snap.entity_id = f.entity_id
                      AND COALESCE(snap.observed_at, snap.created_at) <= f.observed_at
                    ORDER BY COALESCE(snap.observed_at, snap.created_at) DESC, snap.created_at DESC
                    LIMIT 1
                ) es ON true
                ${entityFilters.length ? `WHERE ${entityFilters.join(' AND ')}` : ''}
                ORDER BY effective_at ASC, entity_id ASC
            `,
            params,
        );

        return (result?.rows || []).map((row) => {
            const item: ReplayEntityRow = {
                entity_id: row.entity_id,
                layer_id: row.layer_id,
                source_id: row.source_id,
                entity_kind: row.entity_kind || 'unknown',
                subtype: row.subtype,
                display_name: row.display_name,
                first_observed_at: row.first_observed_at,
                last_observed_at: row.last_observed_at,
                updated_at: row.updated_at || row.effective_at,
                entity_observed_at: row.entity_observed_at,
                entity_properties: row.entity_properties,
                position_observed_at: row.position_observed_at,
                geometry: null,
                display_lat: row.display_lat,
                display_lng: row.display_lng,
                altitude_m: row.altitude_m,
                heading_deg: row.heading_deg,
                speed_mps: row.speed_mps,
                position_properties: row.position_properties,
            };
            return {
                at: row.effective_at,
                family: 'entity',
                op: 'upsert',
                target_id: row.entity_id,
                layer_id: row.layer_id,
                source_id: row.source_id,
                item,
            } satisfies ReplayWindowItem;
        });
    }

    private async listSnapshotOnlyEntityWindow(filters: ReplayWindowFilters): Promise<ReplayWindowItem[]> {
        const { from, to } = this.normalizeReplayWindow(filters);
        const params: unknown[] = [from, to];
        const clauses = [
            'COALESCE(es.observed_at, es.created_at) > $1::timestamptz',
            'COALESCE(es.observed_at, es.created_at) <= $2::timestamptz',
        ];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add('es.layer_id = ?', filters.layerId);
        if (filters.sourceId) add('es.source_id = ?', filters.sourceId);
        if (filters.entityId) add('es.entity_id = ?', filters.entityId);
        if (filters.entityKind) add('es.entity_kind = ?', filters.entityKind);
        if (filters.subtype) add('es.subtype = ?', filters.subtype);

        const result = await this.database.query<ReplayWindowEntitySqlRow>(
            `
                SELECT
                    'upsert'::text AS op_kind,
                    COALESCE(es.observed_at, es.created_at) AS effective_at,
                    es.entity_id,
                    es.layer_id,
                    es.source_id,
                    es.entity_kind,
                    es.subtype,
                    es.display_name,
                    e.first_observed_at,
                    e.last_observed_at,
                    e.updated_at,
                    es.observed_at AS entity_observed_at,
                    es.properties AS entity_properties,
                    NULL::timestamptz AS position_observed_at,
                    NULL::jsonb AS geometry,
                    NULL::double precision AS display_lat,
                    NULL::double precision AS display_lng,
                    NULL::double precision AS altitude_m,
                    NULL::double precision AS heading_deg,
                    NULL::double precision AS speed_mps,
                    NULL::jsonb AS position_properties,
                    NULL::text AS remove_reason
                FROM core.entity_snapshots es
                JOIN core.entities e ON e.entity_id = es.entity_id
                WHERE ${clauses.join(' AND ')}
                ORDER BY COALESCE(es.observed_at, es.created_at) ASC, es.entity_id ASC
            `,
            params,
        );

        return (result?.rows || []).map((row) => ({
            at: row.effective_at,
            family: 'entity',
            op: 'upsert',
            target_id: row.entity_id,
            layer_id: row.layer_id,
            source_id: row.source_id,
            item: {
                entity_id: row.entity_id,
                layer_id: row.layer_id,
                source_id: row.source_id,
                entity_kind: row.entity_kind || 'unknown',
                subtype: row.subtype,
                display_name: row.display_name,
                first_observed_at: row.first_observed_at,
                last_observed_at: row.last_observed_at,
                updated_at: row.updated_at || row.effective_at,
                entity_observed_at: row.entity_observed_at,
                entity_properties: row.entity_properties,
                position_observed_at: row.position_observed_at,
                geometry: row.geometry,
                display_lat: row.display_lat,
                display_lng: row.display_lng,
                altitude_m: row.altitude_m,
                heading_deg: row.heading_deg,
                speed_mps: row.speed_mps,
                position_properties: row.position_properties,
            },
        }));
    }

    private async listSatelliteWindow(filters: ReplayWindowFilters): Promise<ReplayWindowItem[]> {
        const { from, to } = this.normalizeReplayWindow(filters);
        const params: unknown[] = [from, to, 'satellite'];
        const clauses = ['oe.layer_id = $3', 'oe.observed_at <= $2::timestamptz'];
        const outerClauses: string[] = [];

        const add = (target: 'inner' | 'outer', sql: string, value?: unknown) => {
            params.push(value);
            const rendered = sql.replace('?', `$${params.length}`);
            if (target === 'inner') clauses.push(rendered);
            else outerClauses.push(rendered);
        };

        if (filters.sourceId) add('inner', 'oe.source_id = ?', filters.sourceId);
        if (filters.entityId) add('inner', 'oe.entity_id = ?', filters.entityId);
        if (filters.entityKind) add('outer', 'e.entity_kind = ?', filters.entityKind);
        if (filters.subtype) add('outer', 'COALESCE(es.subtype, e.subtype) = ?', filters.subtype);

        const result = await this.database.query<ReplaySatelliteRow>(
            `
                WITH seed AS (
                    SELECT DISTINCT ON (oe.entity_id)
                        oe.entity_id,
                        oe.layer_id,
                        oe.source_id,
                        oe.observed_at AS orbital_observed_at,
                        oe.tle_line1,
                        oe.tle_line2,
                        oe.properties AS orbital_properties
                    FROM core.orbital_elements oe
                    WHERE ${clauses.join(' AND ')}
                      AND oe.observed_at <= $1::timestamptz
                    ORDER BY oe.entity_id, oe.observed_at DESC, oe.created_at DESC
                ),
                in_range AS (
                    SELECT
                        oe.entity_id,
                        oe.layer_id,
                        oe.source_id,
                        oe.observed_at AS orbital_observed_at,
                        oe.tle_line1,
                        oe.tle_line2,
                        oe.properties AS orbital_properties
                    FROM core.orbital_elements oe
                    WHERE ${clauses.join(' AND ')}
                      AND oe.observed_at > $1::timestamptz
                      AND oe.observed_at <= $2::timestamptz
                ),
                timeline AS (
                    SELECT * FROM seed
                    UNION ALL
                    SELECT * FROM in_range
                )
                SELECT
                    e.entity_id,
                    e.layer_id,
                    e.source_id,
                    e.entity_kind,
                    COALESCE(es.subtype, e.subtype) AS subtype,
                    COALESCE(es.display_name, e.display_name) AS display_name,
                    e.first_observed_at,
                    e.last_observed_at,
                    e.updated_at,
                    es.observed_at AS entity_observed_at,
                    NULL::jsonb AS entity_properties,
                    t.orbital_observed_at,
                    t.tle_line1,
                    t.tle_line2,
                    NULL::jsonb AS orbital_properties
                FROM timeline t
                JOIN core.entities e ON e.entity_id = t.entity_id
                LEFT JOIN LATERAL (
                    SELECT
                        snap.observed_at,
                        snap.subtype,
                        snap.display_name,
                        snap.properties
                    FROM core.entity_snapshots snap
                    WHERE snap.entity_id = t.entity_id
                      AND COALESCE(snap.observed_at, snap.created_at) <= t.orbital_observed_at
                    ORDER BY COALESCE(snap.observed_at, snap.created_at) DESC, snap.created_at DESC
                    LIMIT 1
                ) es ON true
                ${outerClauses.length ? `WHERE ${outerClauses.join(' AND ')}` : ''}
                ORDER BY t.entity_id ASC, t.orbital_observed_at ASC
            `,
            params,
        );

        const stepSeconds = this.clampStepSeconds(filters.stepSeconds);
        const normalizedLimit = normalizeLimit(filters.limit);
        const rows = result?.rows || [];
        const grouped = new Map<string, ReplaySatelliteRow[]>();
        for (const row of rows) {
            if (!row.tle_line1 || !row.tle_line2) continue;
            const bucket = grouped.get(row.entity_id) || [];
            bucket.push(row);
            grouped.set(row.entity_id, bucket);
        }

        const selectedEntityIds = Array.from(grouped.keys())
            .sort((a, b) => a.localeCompare(b));
        const limitedEntityIds = normalizedLimit
            ? selectedEntityIds.slice(0, normalizedLimit)
            : selectedEntityIds;

        const items: ReplayWindowItem[] = [];
        const windowStartMs = new Date(from).getTime();
        const windowEndMs = new Date(to).getTime();

        for (const entityId of limitedEntityIds) {
            const snapshots = grouped.get(entityId);
            if (!snapshots) continue;
            let lastObservedAtForEntity: string | null = null;
            for (let i = 0; i < snapshots.length; i++) {
                const current = snapshots[i];
                const next = snapshots[i + 1];
                const segmentStartMs = Math.max(windowStartMs, new Date(current.orbital_observed_at || from).getTime());
                const segmentEndMs = Math.min(windowEndMs, next ? new Date(next.orbital_observed_at || to).getTime() : windowEndMs);
                if (segmentStartMs > segmentEndMs) continue;

                for (let sampleMs = segmentStartMs; sampleMs <= segmentEndMs; sampleMs += stepSeconds * 1000) {
                    if (sampleMs <= windowStartMs) continue;
                    const observedAt = new Date(sampleMs).toISOString();
                    if (observedAt === lastObservedAtForEntity) continue;
                    const position = this.propagateSatellitePosition(current.tle_line1!, current.tle_line2!, observedAt);
                    if (!position) continue;
                    if (filters.bbox && !this.bboxContains(filters.bbox, position.lat, position.lng)) continue;
                    items.push({
                        at: observedAt,
                        family: 'entity',
                        op: 'upsert',
                        target_id: entityId,
                        layer_id: current.layer_id,
                        source_id: current.source_id,
                        item: {
                            entity_id: entityId,
                            layer_id: current.layer_id,
                            source_id: current.source_id,
                            entity_kind: current.entity_kind,
                            subtype: current.subtype,
                            display_name: current.display_name,
                            first_observed_at: current.first_observed_at,
                            last_observed_at: current.last_observed_at,
                            updated_at: current.updated_at,
                            entity_observed_at: current.entity_observed_at,
                            entity_properties: current.entity_properties,
                            position_observed_at: observedAt,
                            geometry: null,
                            display_lat: position.lat,
                            display_lng: position.lng,
                            altitude_m: position.altitudeM,
                            heading_deg: null,
                            speed_mps: null,
                            position_properties: {
                                replay_basis: 'propagated_from_tle',
                                orbital_observed_at: current.orbital_observed_at,
                                step_seconds: stepSeconds,
                                ...(current.orbital_properties || {}),
                            },
                        },
                    });
                    lastObservedAtForEntity = observedAt;
                }

                if (segmentEndMs > windowStartMs) {
                    const observedAt = new Date(segmentEndMs).toISOString();
                    if (observedAt !== lastObservedAtForEntity) {
                        const position = this.propagateSatellitePosition(current.tle_line1!, current.tle_line2!, observedAt);
                        if (position && (!filters.bbox || this.bboxContains(filters.bbox, position.lat, position.lng))) {
                            items.push({
                                at: observedAt,
                                family: 'entity',
                                op: 'upsert',
                                target_id: entityId,
                                layer_id: current.layer_id,
                                source_id: current.source_id,
                                item: {
                                    entity_id: entityId,
                                    layer_id: current.layer_id,
                                    source_id: current.source_id,
                                    entity_kind: current.entity_kind,
                                    subtype: current.subtype,
                                    display_name: current.display_name,
                                    first_observed_at: current.first_observed_at,
                                    last_observed_at: current.last_observed_at,
                                    updated_at: current.updated_at,
                                    entity_observed_at: current.entity_observed_at,
                                    entity_properties: current.entity_properties,
                                    position_observed_at: observedAt,
                                    geometry: null,
                                    display_lat: position.lat,
                                    display_lng: position.lng,
                                    altitude_m: position.altitudeM,
                                    heading_deg: null,
                                    speed_mps: null,
                                    position_properties: {
                                        replay_basis: 'propagated_from_tle',
                                        orbital_observed_at: current.orbital_observed_at,
                                        step_seconds: stepSeconds,
                                        ...(current.orbital_properties || {}),
                                    },
                                },
                            });
                            lastObservedAtForEntity = observedAt;
                        }
                    }
                }
            }
        }

        return items;
    }

    private async listEntityWindow(filters: ReplayWindowFilters): Promise<ReplayWindowItem[]> {
        if (this.isMovingEntityReplay(filters)) {
            return this.listMovingEntityWindow(filters);
        }
        if (this.isSatelliteReplay(filters)) {
            return this.listSatelliteWindow(filters);
        }
        return this.listSnapshotOnlyEntityWindow(filters);
    }

    private async listEventWindow(filters: ReplayWindowFilters): Promise<ReplayWindowItem[]> {
        const { from, to } = this.normalizeReplayWindow(filters);
        const params: unknown[] = [from, to];
        const timelineClauses = ['COALESCE(s.observed_at, s.valid_from, s.created_at) <= $2::timestamptz'];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            timelineClauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add('s.layer_id = ?', filters.layerId);
        if (filters.sourceId) add('s.source_id = ?', filters.sourceId);
        if (filters.eventId) add('s.event_id = ?', filters.eventId);
        if (filters.eventKind) add('s.event_kind = ?', filters.eventKind);
        if (filters.subtype) add('s.subtype = ?', filters.subtype);
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            timelineClauses.push(
                `s.geom IS NOT NULL AND ST_Intersects(s.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`,
            );
        }

        const result = await this.database.query<ReplayWindowEventSqlRow>(
            `
                WITH seed AS (
                    SELECT DISTINCT ON (s.event_id)
                        s.event_id,
                        s.layer_id,
                        s.source_id,
                        s.event_kind,
                        s.subtype,
                        s.observed_at,
                        s.valid_from,
                        s.valid_to,
                        s.created_at,
                        COALESCE(s.observed_at, s.valid_from, s.created_at) AS effective_at,
                        CASE WHEN s.geom IS NOT NULL THEN ST_AsGeoJSON(s.geom)::jsonb ELSE NULL END AS geometry,
                        CASE WHEN s.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lat,
                        CASE WHEN s.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lng,
                        s.properties
                    FROM core.event_snapshots s
                    WHERE ${timelineClauses.join(' AND ')}
                      AND COALESCE(s.observed_at, s.valid_from, s.created_at) <= $1::timestamptz
                    ORDER BY s.event_id, COALESCE(s.observed_at, s.valid_from, s.created_at) DESC, s.created_at DESC
                ),
                in_range AS (
                    SELECT
                        s.event_id,
                        s.layer_id,
                        s.source_id,
                        s.event_kind,
                        s.subtype,
                        s.observed_at,
                        s.valid_from,
                        s.valid_to,
                        s.created_at,
                        COALESCE(s.observed_at, s.valid_from, s.created_at) AS effective_at,
                        CASE WHEN s.geom IS NOT NULL THEN ST_AsGeoJSON(s.geom)::jsonb ELSE NULL END AS geometry,
                        CASE WHEN s.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lat,
                        CASE WHEN s.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lng,
                        s.properties
                    FROM core.event_snapshots s
                    WHERE ${timelineClauses.join(' AND ')}
                      AND COALESCE(s.observed_at, s.valid_from, s.created_at) > $1::timestamptz
                      AND COALESCE(s.observed_at, s.valid_from, s.created_at) <= $2::timestamptz
                ),
                timeline AS (
                    SELECT * FROM seed
                    UNION ALL
                    SELECT * FROM in_range
                ),
                ordered AS (
                    SELECT
                        timeline.*,
                        LEAD(timeline.effective_at) OVER (
                            PARTITION BY timeline.event_id
                            ORDER BY timeline.effective_at ASC, timeline.created_at ASC
                        ) AS next_effective_at
                    FROM timeline
                ),
                upserts AS (
                    SELECT
                        'upsert'::text AS op_kind,
                        effective_at,
                        event_id,
                        layer_id,
                        source_id,
                        event_kind,
                        subtype,
                        observed_at,
                        valid_from,
                        valid_to,
                        geometry,
                        display_lat,
                        display_lng,
                        properties,
                        NULL::text AS remove_reason
                    FROM ordered
                    WHERE effective_at > $1::timestamptz
                ),
                removals AS (
                    SELECT
                        'remove'::text AS op_kind,
                        valid_to AS effective_at,
                        event_id,
                        layer_id,
                        source_id,
                        event_kind,
                        subtype,
                        observed_at,
                        valid_from,
                        valid_to,
                        NULL::jsonb AS geometry,
                        NULL::double precision AS display_lat,
                        NULL::double precision AS display_lng,
                        NULL::jsonb AS properties,
                        'valid_to_expired'::text AS remove_reason
                    FROM ordered
                    WHERE valid_to IS NOT NULL
                      AND valid_to > $1::timestamptz
                      AND valid_to <= $2::timestamptz
                      AND (next_effective_at IS NULL OR next_effective_at > valid_to)
                )
                SELECT * FROM upserts
                UNION ALL
                SELECT * FROM removals
                ORDER BY effective_at ASC, event_id ASC
            `,
            params,
        );

        const items = (result?.rows || []).map((row) => {
            if (row.op_kind === 'remove') {
                return {
                    at: row.effective_at,
                    family: 'event',
                    op: 'remove',
                    target_id: row.event_id,
                    layer_id: row.layer_id,
                    source_id: row.source_id,
                    event_id: row.event_id,
                    reason: row.remove_reason || 'valid_to_expired',
                } satisfies ReplayWindowItem;
            }

            return {
                at: row.effective_at,
                family: 'event',
                op: 'upsert',
                target_id: row.event_id,
                layer_id: row.layer_id,
                source_id: row.source_id,
                item: {
                    event_id: row.event_id,
                    layer_id: row.layer_id,
                    source_id: row.source_id,
                    event_kind: row.event_kind || 'unknown',
                    subtype: row.subtype,
                    observed_at: row.observed_at,
                    valid_from: row.valid_from,
                    valid_to: row.valid_to,
                    geometry: row.geometry,
                    display_lat: row.display_lat,
                    display_lng: row.display_lng,
                    properties: row.properties,
                },
            } satisfies ReplayWindowItem;
        });

        return this.aggregateReplayFireWindow(items, filters);
    }

    private async listAssetWindow(filters: ReplayWindowFilters): Promise<ReplayWindowItem[]> {
        const { from, to } = this.normalizeReplayWindow(filters);
        const params: unknown[] = [from, to];
        const clauses = [
            'COALESCE(s.observed_at, s.created_at) > $1::timestamptz',
            'COALESCE(s.observed_at, s.created_at) <= $2::timestamptz',
        ];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add('s.layer_id = ?', filters.layerId);
        if (filters.sourceId) add('s.source_id = ?', filters.sourceId);
        if (filters.assetId) add('s.asset_id = ?', filters.assetId);
        if (filters.assetKind) add('s.asset_kind = ?', filters.assetKind);
        if (filters.subtype) add('s.subtype = ?', filters.subtype);
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            clauses.push(
                `s.geom IS NOT NULL AND ST_Intersects(s.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`,
            );
        }

        const result = await this.database.query<ReplayAssetRow>(
            `
                SELECT
                    s.asset_id,
                    s.layer_id,
                    s.source_id,
                    s.asset_kind,
                    s.subtype,
                    s.display_name,
                    s.observed_at,
                    CASE WHEN s.geom IS NOT NULL THEN ST_AsGeoJSON(s.geom)::jsonb ELSE NULL END AS geometry,
                    CASE WHEN s.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lat,
                    CASE WHEN s.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lng,
                    s.properties
                FROM core.asset_snapshots s
                WHERE ${clauses.join(' AND ')}
                ORDER BY COALESCE(s.observed_at, s.created_at) ASC, s.asset_id ASC
            `,
            params,
        );

        return (result?.rows || []).map((row) => ({
            at: row.observed_at || from,
            family: 'asset',
            op: 'upsert',
            target_id: row.asset_id,
            layer_id: row.layer_id,
            source_id: row.source_id,
            item: row,
        }));
    }

    async listWindow(filters: ReplayWindowFilters): Promise<ReplayWindowItem[]> {
        if (!this.database.isReady()) return [];

        const [entities, events, assets] = await Promise.all([
            this.listEntityWindow(filters),
            this.listEventWindow(filters),
            this.listAssetWindow(filters),
        ]);

        const merged = [...entities, ...events, ...assets].sort((left, right) => {
            const dt = new Date(left.at).getTime() - new Date(right.at).getTime();
            if (dt !== 0) return dt;
            return left.target_id.localeCompare(right.target_id);
        });

        return merged;
    }

    async listEntityStateAt(filters: ReplayStateFilters): Promise<ReplayEntityRow[]> {
        if (!this.database.isReady()) return [];
        if (this.isMovingEntityReplay(filters)) {
            return this.listMovingEntityStateAt(filters);
        }
        if (this.isSatelliteReplay(filters)) {
            return this.listSatelliteStateAt(filters);
        }
        return this.listSnapshotOnlyEntityStateAt(filters);
    }

    async listEventStateAt(filters: ReplayStateFilters): Promise<ReplayEventRow[]> {
        if (!this.database.isReady()) return [];

        const aggregateFire = filters.layerId === 'fire' && !filters.eventId;

        const params: unknown[] = [filters.at];
        const clauses = ['COALESCE(s.observed_at, s.valid_from, s.created_at) <= $1::timestamptz'];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add('s.layer_id = ?', filters.layerId);
        if (filters.sourceId) add('s.source_id = ?', filters.sourceId);
        if (filters.eventId) add('s.event_id = ?', filters.eventId);
        if (filters.eventKind) add('s.event_kind = ?', filters.eventKind);
        if (filters.subtype) add('s.subtype = ?', filters.subtype);
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            clauses.push(
                `s.geom IS NOT NULL AND ST_Intersects(s.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`,
            );
        }

        clauses.push('(s.valid_to IS NULL OR s.valid_to >= $1::timestamptz)');
        const normalizedLimit = normalizeLimit(filters.limit);
        const limitSql = normalizedLimit && !aggregateFire ? `LIMIT $${params.push(normalizedLimit)}` : '';

        const result = await this.database.query<ReplayEventRow>(
            `
                WITH latest_event_state AS (
                    SELECT DISTINCT ON (s.event_id)
                        s.event_id,
                        s.layer_id,
                        s.source_id,
                        s.event_kind,
                        s.subtype,
                        s.observed_at,
                        s.valid_from,
                        s.valid_to,
                        CASE WHEN s.geom IS NOT NULL THEN ST_AsGeoJSON(s.geom)::jsonb ELSE NULL END AS geometry,
                        CASE WHEN s.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lat,
                        CASE WHEN s.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lng,
                        s.properties
                    FROM core.event_snapshots s
                    WHERE ${clauses.join(' AND ')}
                    ORDER BY s.event_id, COALESCE(s.observed_at, s.valid_from, s.created_at) DESC, s.created_at DESC
                )
                SELECT *
                FROM latest_event_state
                ORDER BY COALESCE(observed_at, valid_from) DESC NULLS LAST, event_id
                ${limitSql}
            `,
            params,
        );

        let rows = result?.rows || [];
        if (aggregateFire) {
            rows = this.aggregateReplayFireState(rows, filters);
            if (normalizedLimit) rows = rows.slice(0, normalizedLimit);
        }

        return rows;
    }

    async listAssetStateAt(filters: ReplayStateFilters): Promise<ReplayAssetRow[]> {
        if (!this.database.isReady()) return [];

        const params: unknown[] = [filters.at];
        const clauses = ['COALESCE(s.observed_at, s.created_at) <= $1::timestamptz'];

        const add = (sql: string, value?: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };

        if (filters.layerId) add('s.layer_id = ?', filters.layerId);
        if (filters.sourceId) add('s.source_id = ?', filters.sourceId);
        if (filters.assetId) add('s.asset_id = ?', filters.assetId);
        if (filters.assetKind) add('s.asset_kind = ?', filters.assetKind);
        if (filters.subtype) add('s.subtype = ?', filters.subtype);
        if (filters.bbox) {
            const [south, west, north, east] = filters.bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            clauses.push(
                `s.geom IS NOT NULL AND ST_Intersects(s.geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`,
            );
        }

        const normalizedLimit = normalizeLimit(filters.limit);
        const limitSql = normalizedLimit ? `LIMIT $${params.push(normalizedLimit)}` : '';

        const result = await this.database.query<ReplayAssetRow>(
            `
                WITH latest_asset_state AS (
                    SELECT DISTINCT ON (s.asset_id)
                        s.asset_id,
                        s.layer_id,
                        s.source_id,
                        s.asset_kind,
                        s.subtype,
                        s.display_name,
                        s.observed_at,
                        CASE WHEN s.geom IS NOT NULL THEN ST_AsGeoJSON(s.geom)::jsonb ELSE NULL END AS geometry,
                        CASE WHEN s.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lat,
                        CASE WHEN s.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lng,
                        s.properties
                    FROM core.asset_snapshots s
                    WHERE ${clauses.join(' AND ')}
                    ORDER BY s.asset_id, COALESCE(s.observed_at, s.created_at) DESC, s.created_at DESC
                )
                SELECT *
                FROM latest_asset_state
                ORDER BY COALESCE(observed_at, now()::timestamptz) DESC NULLS LAST, asset_id
                ${limitSql}
            `,
            params,
        );

        return result?.rows || [];
    }
}
