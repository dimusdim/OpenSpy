import crypto from 'crypto';
import { DatabaseService } from '../db/database.service';
import type { JammingZone } from './gpsjam.service';
import type { FireRecord } from './extended.service';
import type { DisasterEvent } from './live-stream.service';
import type { OutageRecord } from './ioda.service';
import type { CloudflareOutage } from './cloudflare.service';
import type { ConflictEvent } from './acled.service';
import type { GdeltConflictEvent } from './gdelt.service';
import type { AirspaceZone } from './airspace.service';
import type { PipelineRecord } from './infrastructure.service';
import type { SatelliteRecord } from './satellite.service';
import type { GFWEvent } from './gfw.service';
import { getSourceBinding } from './source-bindings.service';

type CableFeature = {
    properties?: Record<string, any>;
    geometry?: { type: string; coordinates: any };
};

type CableGeoJSON = {
    type: string;
    features?: CableFeature[];
};

type GeoJsonGeometry = {
    type: string;
    coordinates: any;
};

type AssetUpsertRow = {
    asset_id: string;
    asset_snapshot_id: string;
    layer_id: string;
    source_id: string | null;
    asset_kind: string;
    subtype: string | null;
    display_name: string | null;
    observed_at?: string | null;
    geometry_json?: GeoJsonGeometry | null;
    properties: Record<string, any>;
};

type EntityUpsertRow = {
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    entity_kind: string;
    subtype: string | null;
    display_name: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    properties: Record<string, any>;
};

type EntityAliasUpsertRow = {
    entity_alias_id: string;
    entity_id: string;
    alias_type: string;
    alias_value: string;
};

type EventUpsertRow = {
    event_id: string;
    event_snapshot_id: string;
    layer_id: string;
    source_id: string | null;
    event_kind: string;
    subtype: string | null;
    observed_at: string | null;
    valid_from?: string | null;
    valid_to?: string | null;
    lat?: number | null;
    lng?: number | null;
    geometry_json?: GeoJsonGeometry | null;
    properties: Record<string, any>;
};

type RawPayloadInput = {
    source_id?: string | null;
    observed_at?: string | null;
    upstream_id?: string | null;
    payload: unknown;
    metadata?: Record<string, any>;
};

type IngestRunInput = {
    source_id?: string | null;
    layer_id: string;
    record_count: number;
    metadata?: Record<string, any>;
    raw_payloads?: RawPayloadInput[];
};

type PositionFixUpsertRow = {
    position_fix_id: string;
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    observed_at: string;
    lat: number;
    lng: number;
    altitude_m?: number | null;
    heading_deg?: number | null;
    speed_mps?: number | null;
    properties: Record<string, any>;
};

type OrbitalElementUpsertRow = {
    orbital_element_id: string;
    entity_id: string;
    source_id: string | null;
    observed_at: string;
    norad_id: string | null;
    tle_line1: string;
    tle_line2: string;
    properties: Record<string, any>;
};

type AircraftPositionRecord = {
    id: string;
    icao24: string;
    callsign: string;
    origin?: string;
    lat: number;
    lng: number;
    altMeters?: number | null;
    heading?: number | null;
    type: string;
    speedMps?: number | null;
    onGround?: boolean;
    verticalRate?: number | null;
    squawk?: string | null;
    lastContact?: number | null;
};

type VesselPositionRecord = {
    id: string;
    lat: number;
    lng: number;
    heading?: number | null;
    type: string;
    speedKnots?: number | null;
    navigationStatus?: string | null;
    rateOfTurn?: number | null;
    cog?: number | null;
    name?: string | null;
    callSign?: string | null;
    imo?: number | null;
    destination?: string | null;
    eta?: string | null;
    draught?: number | null;
    length?: number | null;
    beam?: number | null;
    observedAt: string;
};

function stableHash(value: unknown): string {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function escapeIdentifier(value: string | null | undefined): string | null {
    if (!value) return null;
    return value.replace(/\s+/g, ' ').trim();
}

function closeGeoJsonRing(points: Array<[number, number]>): Array<[number, number]> {
    if (points.length < 3) return points;
    const [firstLng, firstLat] = points[0];
    const [lastLng, lastLat] = points[points.length - 1];
    if (firstLng === lastLng && firstLat === lastLat) return points;
    return [...points, points[0]];
}

function latLngPathToGeoJsonRing(points: Array<[number, number]>): Array<[number, number]> {
    return closeGeoJsonRing(
        points
            .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
            .map(([lat, lng]) => [lng, lat]),
    );
}

export class SourcePersistenceService {
    private readonly vesselPositionBuffer = new Map<string, VesselPositionRecord>();
    private vesselFlushTimer: NodeJS.Timeout | null = null;
    private vesselFlushInFlight: Promise<void> | null = null;

    constructor(private readonly database: DatabaseService) {}

    private buildIngestRunId(layerId: string, sourceId: string | null | undefined, metadata: Record<string, any> | undefined): string {
        return `ingest:${layerId}:${sourceId || 'mixed'}:${stableHash({
            timestamp: new Date().toISOString(),
            metadata: metadata || null,
        })}`;
    }

    private buildRawPayloadId(ingestRunId: string, sourceId: string | null | undefined, upstreamId: string | null | undefined, index: number): string {
        return `raw:${stableHash({ ingestRunId, sourceId: sourceId || null, upstreamId: upstreamId || null, index })}`;
    }

    private async beginIngestRun(input: IngestRunInput): Promise<string | null> {
        if (!this.database.isReady()) return null;

        const ingestRunId = this.buildIngestRunId(input.layer_id, input.source_id, input.metadata);
        await this.database.query(
            `
                INSERT INTO raw.ingest_runs (
                    ingest_run_id,
                    source_id,
                    layer_id,
                    started_at,
                    status,
                    record_count,
                    metadata
                )
                VALUES ($1, $2, $3, now(), 'started', $4, $5::jsonb)
                ON CONFLICT (ingest_run_id)
                DO NOTHING
            `,
            [
                ingestRunId,
                input.source_id || null,
                input.layer_id,
                input.record_count,
                JSON.stringify(input.metadata || {}),
            ],
        );
        return ingestRunId;
    }

    private async persistRawPayloads(ingestRunId: string | null, layerId: string, payloads: RawPayloadInput[]): Promise<void> {
        if (!this.database.isReady() || !ingestRunId || payloads.length === 0) return;

        for (const [index, payload] of payloads.entries()) {
            await this.database.query(
                `
                    INSERT INTO raw.raw_payloads (
                        raw_payload_id,
                        ingest_run_id,
                        source_id,
                        layer_id,
                        observed_at,
                        upstream_id,
                        payload,
                        metadata,
                        created_at
                    )
                    VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6, $7::jsonb, $8::jsonb, now())
                    ON CONFLICT (raw_payload_id)
                    DO NOTHING
                `,
                [
                    this.buildRawPayloadId(ingestRunId, payload.source_id, payload.upstream_id, index),
                    ingestRunId,
                    payload.source_id || null,
                    layerId,
                    payload.observed_at || null,
                    payload.upstream_id || null,
                    JSON.stringify(payload.payload),
                    JSON.stringify(payload.metadata || {}),
                ],
            );
        }
    }

    private async completeIngestRun(
        ingestRunId: string | null,
        status: 'completed' | 'failed',
        recordCount: number,
        metadata?: Record<string, any>,
        errorMessage?: string,
    ): Promise<void> {
        if (!this.database.isReady() || !ingestRunId) return;

        await this.database.query(
            `
                UPDATE raw.ingest_runs
                SET
                    completed_at = now(),
                    status = $2,
                    record_count = $3,
                    error_message = $4,
                    metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
                WHERE ingest_run_id = $1
            `,
            [
                ingestRunId,
                status,
                recordCount,
                errorMessage || null,
                JSON.stringify(metadata || {}),
            ],
        );
    }

    private async runTrackedIngest<T>(input: IngestRunInput, operation: (ingestRunId: string | null) => Promise<T>): Promise<T> {
        const ingestRunId = await this.beginIngestRun(input);

        try {
            await this.persistRawPayloads(ingestRunId, input.layer_id, input.raw_payloads || []);
            const result = await operation(ingestRunId);
            await this.completeIngestRun(ingestRunId, 'completed', input.record_count, {
                rawPayloadCount: input.raw_payloads?.length || 0,
            });
            return result;
        } catch (error: any) {
            await this.completeIngestRun(
                ingestRunId,
                'failed',
                input.record_count,
                { rawPayloadCount: input.raw_payloads?.length || 0 },
                error?.message || String(error),
            );
            throw error;
        }
    }

    private async persistAssetBatch(rows: AssetUpsertRow[], ingestRunId: string | null = null): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT rowset.*, $2::text AS ingest_run_id
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        asset_id text,
                        asset_snapshot_id text,
                        layer_id text,
                        source_id text,
                        asset_kind text,
                        subtype text,
                        display_name text,
                        observed_at timestamptz,
                        geometry_json jsonb,
                        properties jsonb
                    )
                ),
                latest_incoming AS (
                    SELECT DISTINCT ON (asset_id)
                        asset_id,
                        asset_snapshot_id,
                        ingest_run_id,
                        layer_id,
                        source_id,
                        asset_kind,
                        subtype,
                        display_name,
                        observed_at,
                        geometry_json,
                        properties
                    FROM incoming
                    ORDER BY asset_id, observed_at DESC NULLS LAST, asset_snapshot_id DESC
                )
                INSERT INTO core.assets (
                    asset_id,
                    layer_id,
                    source_id,
                    asset_kind,
                    subtype,
                    display_name,
                    geom,
                    properties,
                    first_observed_at,
                    last_observed_at,
                    latest_snapshot_id,
                    created_at,
                    updated_at
                )
                SELECT
                    asset_id,
                    layer_id,
                    source_id,
                    asset_kind,
                    subtype,
                    display_name,
                    CASE
                        WHEN geometry_json IS NOT NULL THEN ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326)
                        ELSE NULL
                    END,
                    properties,
                    observed_at,
                    observed_at,
                    asset_snapshot_id,
                    now(),
                    now()
                FROM latest_incoming
                ON CONFLICT (asset_id)
                DO UPDATE SET
                    layer_id = EXCLUDED.layer_id,
                    source_id = EXCLUDED.source_id,
                    asset_kind = EXCLUDED.asset_kind,
                    subtype = CASE
                        WHEN EXCLUDED.last_observed_at IS NULL THEN core.assets.subtype
                        WHEN core.assets.last_observed_at IS NULL OR EXCLUDED.last_observed_at >= core.assets.last_observed_at THEN EXCLUDED.subtype
                        ELSE core.assets.subtype
                    END,
                    display_name = CASE
                        WHEN EXCLUDED.last_observed_at IS NULL THEN core.assets.display_name
                        WHEN core.assets.last_observed_at IS NULL OR EXCLUDED.last_observed_at >= core.assets.last_observed_at THEN EXCLUDED.display_name
                        ELSE core.assets.display_name
                    END,
                    geom = CASE
                        WHEN EXCLUDED.last_observed_at IS NULL THEN core.assets.geom
                        WHEN core.assets.last_observed_at IS NULL OR EXCLUDED.last_observed_at >= core.assets.last_observed_at THEN EXCLUDED.geom
                        ELSE core.assets.geom
                    END,
                    properties = CASE
                        WHEN EXCLUDED.last_observed_at IS NULL THEN core.assets.properties
                        WHEN core.assets.last_observed_at IS NULL OR EXCLUDED.last_observed_at >= core.assets.last_observed_at THEN EXCLUDED.properties
                        ELSE core.assets.properties
                    END,
                    first_observed_at = CASE
                        WHEN core.assets.first_observed_at IS NULL THEN EXCLUDED.first_observed_at
                        WHEN EXCLUDED.first_observed_at IS NULL THEN core.assets.first_observed_at
                        ELSE LEAST(core.assets.first_observed_at, EXCLUDED.first_observed_at)
                    END,
                    last_observed_at = CASE
                        WHEN core.assets.last_observed_at IS NULL THEN EXCLUDED.last_observed_at
                        WHEN EXCLUDED.last_observed_at IS NULL THEN core.assets.last_observed_at
                        ELSE GREATEST(core.assets.last_observed_at, EXCLUDED.last_observed_at)
                    END,
                    latest_snapshot_id = CASE
                        WHEN EXCLUDED.last_observed_at IS NULL THEN core.assets.latest_snapshot_id
                        WHEN core.assets.last_observed_at IS NULL OR EXCLUDED.last_observed_at >= core.assets.last_observed_at THEN EXCLUDED.latest_snapshot_id
                        ELSE core.assets.latest_snapshot_id
                    END,
                    updated_at = now()
            `,
            [JSON.stringify(rows), ingestRunId],
        );

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT rowset.*, $2::text AS ingest_run_id
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        asset_id text,
                        asset_snapshot_id text,
                        layer_id text,
                        source_id text,
                        asset_kind text,
                        subtype text,
                        display_name text,
                        observed_at timestamptz,
                        geometry_json jsonb,
                        properties jsonb
                    )
                )
                INSERT INTO core.asset_snapshots (
                    asset_snapshot_id,
                    asset_id,
                    ingest_run_id,
                    layer_id,
                    source_id,
                    asset_kind,
                    subtype,
                    display_name,
                    observed_at,
                    geom,
                    properties,
                    created_at
                )
                SELECT
                    asset_snapshot_id,
                    asset_id,
                    ingest_run_id,
                    layer_id,
                    source_id,
                    asset_kind,
                    subtype,
                    display_name,
                    observed_at,
                    CASE
                        WHEN geometry_json IS NOT NULL THEN ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326)
                        ELSE NULL
                    END,
                    properties,
                    now()
                FROM incoming
                ON CONFLICT (asset_snapshot_id)
                DO NOTHING
            `,
            [JSON.stringify(rows), ingestRunId],
        );
    }

    private async upsertEntities(rows: EntityUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;

        const deduped = new Map<string, EntityUpsertRow>();
        for (const row of rows) {
            const existing = deduped.get(row.entity_id);
            if (!existing) {
                deduped.set(row.entity_id, row);
                continue;
            }

            const existingLast = existing.last_observed_at ? Date.parse(existing.last_observed_at) : Number.NEGATIVE_INFINITY;
            const rowLast = row.last_observed_at ? Date.parse(row.last_observed_at) : Number.NEGATIVE_INFINITY;
            const preferRow = rowLast >= existingLast;

            deduped.set(row.entity_id, {
                ...existing,
                ...(preferRow ? row : {}),
                first_observed_at: existing.first_observed_at && row.first_observed_at
                    ? (Date.parse(existing.first_observed_at) <= Date.parse(row.first_observed_at) ? existing.first_observed_at : row.first_observed_at)
                    : (existing.first_observed_at || row.first_observed_at),
                last_observed_at: existing.last_observed_at && row.last_observed_at
                    ? (Date.parse(existing.last_observed_at) >= Date.parse(row.last_observed_at) ? existing.last_observed_at : row.last_observed_at)
                    : (existing.last_observed_at || row.last_observed_at),
            });
        }

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT *
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        entity_id text,
                        layer_id text,
                        source_id text,
                        entity_kind text,
                        subtype text,
                        display_name text,
                        first_observed_at timestamptz,
                        last_observed_at timestamptz,
                        properties jsonb
                    )
                )
                INSERT INTO core.entities (
                    entity_id,
                    layer_id,
                    source_id,
                    entity_kind,
                    subtype,
                    display_name,
                    first_observed_at,
                    last_observed_at,
                    properties,
                    created_at,
                    updated_at
                )
                SELECT
                    entity_id,
                    layer_id,
                    source_id,
                    entity_kind,
                    subtype,
                    display_name,
                    first_observed_at,
                    last_observed_at,
                    properties,
                    now(),
                    now()
                FROM incoming
                ON CONFLICT (entity_id)
                DO UPDATE SET
                    layer_id = EXCLUDED.layer_id,
                    source_id = EXCLUDED.source_id,
                    entity_kind = EXCLUDED.entity_kind,
                    subtype = EXCLUDED.subtype,
                    display_name = EXCLUDED.display_name,
                    first_observed_at = CASE
                        WHEN core.entities.first_observed_at IS NULL THEN EXCLUDED.first_observed_at
                        WHEN EXCLUDED.first_observed_at IS NULL THEN core.entities.first_observed_at
                        ELSE LEAST(core.entities.first_observed_at, EXCLUDED.first_observed_at)
                    END,
                    last_observed_at = CASE
                        WHEN core.entities.last_observed_at IS NULL THEN EXCLUDED.last_observed_at
                        WHEN EXCLUDED.last_observed_at IS NULL THEN core.entities.last_observed_at
                        ELSE GREATEST(core.entities.last_observed_at, EXCLUDED.last_observed_at)
                    END,
                    properties = EXCLUDED.properties,
                    updated_at = now()
            `,
            [JSON.stringify([...deduped.values()])],
        );
    }

    private async upsertEntityAliases(rows: EntityAliasUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;

        const deduped = new Map<string, EntityAliasUpsertRow>();
        for (const row of rows) {
            deduped.set(`${row.alias_type}:${row.alias_value}`, row);
        }

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT *
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        entity_alias_id text,
                        entity_id text,
                        alias_type text,
                        alias_value text
                    )
                )
                INSERT INTO core.entity_aliases (
                    entity_alias_id,
                    entity_id,
                    alias_type,
                    alias_value,
                    created_at
                )
                SELECT
                    entity_alias_id,
                    entity_id,
                    alias_type,
                    alias_value,
                    now()
                FROM incoming
                ON CONFLICT (alias_type, alias_value)
                DO UPDATE SET
                    entity_id = EXCLUDED.entity_id
            `,
            [JSON.stringify([...deduped.values()])],
        );
    }

    private async loadLatestPositionHashes(entityIds: string[]): Promise<Map<string, string>> {
        const uniqueEntityIds = [...new Set(entityIds)];
        const hashes = new Map<string, string>();
        if (!this.database.isReady() || uniqueEntityIds.length === 0) return hashes;

        const result = await this.database.query<{ entity_id: string; state_hash: string | null }>(
            `
                SELECT DISTINCT ON (entity_id)
                    entity_id,
                    properties->>'_state_hash' AS state_hash
                FROM core.position_fixes
                WHERE entity_id = ANY($1::text[])
                ORDER BY entity_id, observed_at DESC, created_at DESC
            `,
            [uniqueEntityIds],
        );

        for (const row of result?.rows || []) {
            hashes.set(row.entity_id, row.state_hash || '');
        }

        return hashes;
    }

    private async insertPositionFixes(rows: PositionFixUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT *
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        position_fix_id text,
                        entity_id text,
                        layer_id text,
                        source_id text,
                        observed_at timestamptz,
                        lat double precision,
                        lng double precision,
                        altitude_m double precision,
                        heading_deg double precision,
                        speed_mps double precision,
                        properties jsonb
                    )
                )
                INSERT INTO core.position_fixes (
                    position_fix_id,
                    entity_id,
                    layer_id,
                    source_id,
                    observed_at,
                    geom,
                    altitude_m,
                    heading_deg,
                    speed_mps,
                    properties,
                    created_at
                )
                SELECT
                    position_fix_id,
                    entity_id,
                    layer_id,
                    source_id,
                    observed_at,
                    ST_SetSRID(ST_MakePoint(lng, lat), 4326),
                    altitude_m,
                    heading_deg,
                    speed_mps,
                    properties,
                    now()
                FROM incoming
                ON CONFLICT (position_fix_id)
                DO NOTHING
            `,
            [JSON.stringify(rows)],
        );
    }

    private async upsertEntityLiveStates(rows: PositionFixUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT *
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        position_fix_id text,
                        entity_id text,
                        layer_id text,
                        source_id text,
                        observed_at timestamptz,
                        lat double precision,
                        lng double precision,
                        altitude_m double precision,
                        heading_deg double precision,
                        speed_mps double precision,
                        properties jsonb
                    )
                )
                INSERT INTO app.entity_live_states (
                    entity_id,
                    layer_id,
                    source_id,
                    observed_at,
                    geom,
                    altitude_m,
                    heading_deg,
                    speed_mps,
                    properties,
                    created_at,
                    updated_at
                )
                SELECT
                    entity_id,
                    layer_id,
                    source_id,
                    observed_at,
                    ST_SetSRID(ST_MakePoint(lng, lat), 4326),
                    altitude_m,
                    heading_deg,
                    speed_mps,
                    properties,
                    now(),
                    now()
                FROM incoming
                ON CONFLICT (entity_id)
                DO UPDATE SET
                    layer_id = EXCLUDED.layer_id,
                    source_id = EXCLUDED.source_id,
                    observed_at = EXCLUDED.observed_at,
                    geom = EXCLUDED.geom,
                    altitude_m = EXCLUDED.altitude_m,
                    heading_deg = EXCLUDED.heading_deg,
                    speed_mps = EXCLUDED.speed_mps,
                    properties = EXCLUDED.properties,
                    updated_at = now()
            `,
            [JSON.stringify(rows)],
        );
    }

    private async insertOrbitalElements(rows: OrbitalElementUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT *
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        orbital_element_id text,
                        entity_id text,
                        source_id text,
                        observed_at timestamptz,
                        norad_id text,
                        tle_line1 text,
                        tle_line2 text,
                        properties jsonb
                    )
                )
                INSERT INTO core.orbital_elements (
                    orbital_element_id,
                    entity_id,
                    source_id,
                    observed_at,
                    norad_id,
                    tle_line1,
                    tle_line2,
                    properties,
                    created_at
                )
                SELECT
                    orbital_element_id,
                    entity_id,
                    source_id,
                    observed_at,
                    norad_id,
                    tle_line1,
                    tle_line2,
                    properties,
                    now()
                FROM incoming
                ON CONFLICT (orbital_element_id)
                DO NOTHING
            `,
            [JSON.stringify(rows)],
        );
    }

    private async persistEventBatch(rows: EventUpsertRow[], ingestRunId: string | null = null): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT rowset.*, $2::text AS ingest_run_id
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        event_id text,
                        event_snapshot_id text,
                        layer_id text,
                        source_id text,
                        event_kind text,
                        subtype text,
                        observed_at timestamptz,
                        valid_from timestamptz,
                        valid_to timestamptz,
                        lat double precision,
                        lng double precision,
                        geometry_json jsonb,
                        properties jsonb
                    )
                ),
                latest_incoming AS (
                    SELECT DISTINCT ON (event_id)
                        event_id,
                        event_snapshot_id,
                        ingest_run_id,
                        layer_id,
                        source_id,
                        event_kind,
                        subtype,
                        observed_at,
                        valid_from,
                        valid_to,
                        lat,
                        lng,
                        geometry_json,
                        properties
                    FROM incoming
                    ORDER BY event_id, observed_at DESC NULLS LAST, event_snapshot_id DESC
                ),
                upserted_events AS (
                    INSERT INTO core.events (
                        event_id,
                        layer_id,
                        source_id,
                        event_kind,
                        subtype,
                        observed_at,
                        valid_from,
                        valid_to,
                        geom,
                        properties,
                        first_observed_at,
                        last_observed_at,
                        latest_snapshot_id,
                        created_at,
                        updated_at
                    )
                    SELECT
                        event_id,
                        layer_id,
                        source_id,
                        event_kind,
                        subtype,
                        observed_at,
                        valid_from,
                        valid_to,
                        CASE
                            WHEN geometry_json IS NOT NULL THEN ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326)
                            WHEN lat IS NOT NULL AND lng IS NOT NULL THEN ST_SetSRID(ST_MakePoint(lng, lat), 4326)
                            ELSE NULL
                        END,
                        properties,
                        observed_at,
                        observed_at,
                        event_snapshot_id,
                        now(),
                        now()
                    FROM latest_incoming
                    ON CONFLICT (event_id)
                    DO UPDATE SET
                        layer_id = EXCLUDED.layer_id,
                        source_id = EXCLUDED.source_id,
                        event_kind = EXCLUDED.event_kind,
                        subtype = CASE
                            WHEN EXCLUDED.observed_at IS NULL THEN core.events.subtype
                            WHEN core.events.observed_at IS NULL OR EXCLUDED.observed_at >= core.events.observed_at THEN EXCLUDED.subtype
                            ELSE core.events.subtype
                        END,
                        observed_at = CASE
                            WHEN EXCLUDED.observed_at IS NULL THEN core.events.observed_at
                            WHEN core.events.observed_at IS NULL OR EXCLUDED.observed_at >= core.events.observed_at THEN EXCLUDED.observed_at
                            ELSE core.events.observed_at
                        END,
                        valid_from = CASE
                            WHEN EXCLUDED.observed_at IS NULL THEN core.events.valid_from
                            WHEN core.events.observed_at IS NULL OR EXCLUDED.observed_at >= core.events.observed_at THEN EXCLUDED.valid_from
                            ELSE core.events.valid_from
                        END,
                        valid_to = CASE
                            WHEN EXCLUDED.observed_at IS NULL THEN core.events.valid_to
                            WHEN core.events.observed_at IS NULL OR EXCLUDED.observed_at >= core.events.observed_at THEN EXCLUDED.valid_to
                            ELSE core.events.valid_to
                        END,
                        geom = CASE
                            WHEN EXCLUDED.observed_at IS NULL THEN core.events.geom
                            WHEN core.events.observed_at IS NULL OR EXCLUDED.observed_at >= core.events.observed_at THEN EXCLUDED.geom
                            ELSE core.events.geom
                        END,
                        properties = CASE
                            WHEN EXCLUDED.observed_at IS NULL THEN core.events.properties
                            WHEN core.events.observed_at IS NULL OR EXCLUDED.observed_at >= core.events.observed_at THEN EXCLUDED.properties
                            ELSE core.events.properties
                        END,
                        first_observed_at = CASE
                            WHEN core.events.first_observed_at IS NULL THEN EXCLUDED.first_observed_at
                            WHEN EXCLUDED.first_observed_at IS NULL THEN core.events.first_observed_at
                            ELSE LEAST(core.events.first_observed_at, EXCLUDED.first_observed_at)
                        END,
                        last_observed_at = CASE
                            WHEN core.events.last_observed_at IS NULL THEN EXCLUDED.last_observed_at
                            WHEN EXCLUDED.last_observed_at IS NULL THEN core.events.last_observed_at
                            ELSE GREATEST(core.events.last_observed_at, EXCLUDED.last_observed_at)
                        END,
                        latest_snapshot_id = CASE
                            WHEN EXCLUDED.observed_at IS NULL THEN core.events.latest_snapshot_id
                            WHEN core.events.observed_at IS NULL OR EXCLUDED.observed_at >= core.events.observed_at THEN EXCLUDED.latest_snapshot_id
                            ELSE core.events.latest_snapshot_id
                        END,
                        updated_at = now()
                    RETURNING event_id
                )
                INSERT INTO core.event_snapshots (
                    event_snapshot_id,
                    event_id,
                    ingest_run_id,
                    layer_id,
                    source_id,
                    event_kind,
                    subtype,
                    observed_at,
                    valid_from,
                    valid_to,
                    geom,
                    properties,
                    created_at
                )
                SELECT
                    event_snapshot_id,
                    event_id,
                    ingest_run_id,
                    layer_id,
                    source_id,
                    event_kind,
                    subtype,
                    observed_at,
                    valid_from,
                    valid_to,
                    CASE
                        WHEN geometry_json IS NOT NULL THEN ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326)
                        WHEN lat IS NOT NULL AND lng IS NOT NULL THEN ST_SetSRID(ST_MakePoint(lng, lat), 4326)
                        ELSE NULL
                    END,
                    properties,
                    now()
                FROM incoming
                ON CONFLICT (event_snapshot_id)
                DO NOTHING
            `,
            [JSON.stringify(rows), ingestRunId],
        );
    }

    private normalizeDisasterSourceId(source: string): string {
        switch (source) {
            case 'GDACS':
                return 'gdacs';
            case 'USGS':
                return 'usgs';
            case 'NASA EONET':
                return 'eonet';
            default:
                return source.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        }
    }

    async persistAircraftPositions(records: AircraftPositionRecord[]): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = getSourceBinding('opensky');
        const entities: EntityUpsertRow[] = [];
        const aliases: EntityAliasUpsertRow[] = [];
        const fixesSeed: Array<PositionFixUpsertRow & { state_hash: string }> = [];

        for (const record of records) {
            if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng) || !record.icao24) continue;

            const entityId = `aircraft:${record.icao24.toLowerCase()}`;
            const observedAt = record.lastContact
                ? new Date(record.lastContact * 1000).toISOString()
                : new Date().toISOString();
            const stateHash = stableHash({
                lat: Number(record.lat.toFixed(5)),
                lng: Number(record.lng.toFixed(5)),
                altMeters: record.altMeters ?? null,
                heading: record.heading ?? 0,
                type: record.type,
                speedMps: record.speedMps ?? null,
                onGround: record.onGround ?? false,
                verticalRate: record.verticalRate ?? null,
                squawk: record.squawk || null,
            });

            entities.push({
                entity_id: entityId,
                layer_id: binding?.layerId || 'aircraft',
                source_id: binding?.sourceId || 'opensky',
                entity_kind: binding?.recordKind || 'aircraft',
                subtype: record.type || null,
                display_name: escapeIdentifier(record.callsign || record.icao24),
                first_observed_at: observedAt,
                last_observed_at: observedAt,
                properties: {
                    icao24: record.icao24,
                    callsign: record.callsign,
                    origin: record.origin || null,
                    onGround: record.onGround ?? false,
                    verticalRate: record.verticalRate ?? null,
                    squawk: record.squawk || null,
                    _state_hash: stateHash,
                },
            });

            aliases.push({
                entity_alias_id: `alias:${entityId}:icao24:${record.icao24.toLowerCase()}`,
                entity_id: entityId,
                alias_type: 'icao24',
                alias_value: record.icao24.toLowerCase(),
            });

            if (record.callsign?.trim()) {
                aliases.push({
                    entity_alias_id: `alias:${entityId}:callsign:${record.callsign.trim().toUpperCase()}`,
                    entity_id: entityId,
                    alias_type: 'callsign',
                    alias_value: record.callsign.trim().toUpperCase(),
                });
            }

            fixesSeed.push({
                position_fix_id: `fix:${entityId}:${observedAt}:${stateHash}`,
                entity_id: entityId,
                layer_id: binding?.layerId || 'aircraft',
                source_id: binding?.sourceId || 'opensky',
                observed_at: observedAt,
                lat: record.lat,
                lng: record.lng,
                altitude_m: record.altMeters ?? null,
                heading_deg: record.heading ?? null,
                speed_mps: record.speedMps ?? null,
                properties: {
                    icao24: record.icao24,
                    callsign: record.callsign,
                    origin: record.origin || null,
                    onGround: record.onGround ?? false,
                    verticalRate: record.verticalRate ?? null,
                    squawk: record.squawk || null,
                    _state_hash: stateHash,
                },
                state_hash: stateHash,
            });
        }

        const latestHashes = await this.loadLatestPositionHashes(fixesSeed.map((row) => row.entity_id));
        const liveRows = fixesSeed.map(({ state_hash: _stateHash, ...row }) => row);
        const fixes = fixesSeed
            .filter((row) => latestHashes.get(row.entity_id) !== row.state_hash)
            .map(({ state_hash: _stateHash, ...row }) => row);

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'opensky',
                layer_id: binding?.layerId || 'aircraft',
                record_count: records.length,
                metadata: {
                    canonicalTarget: 'entities',
                    changedFixCount: fixes.length,
                    entityCount: entities.length,
                },
            },
            async () => {
                await this.upsertEntities(entities);
                await this.upsertEntityAliases(aliases);
                await this.upsertEntityLiveStates(liveRows);
                await this.insertPositionFixes(fixes);
            },
        );
    }

    queueVesselPosition(record: VesselPositionRecord): void {
        if (!this.database.isReady()) return;
        this.vesselPositionBuffer.set(record.id, record);
        if (this.vesselFlushTimer) return;

        this.vesselFlushTimer = setTimeout(() => {
            this.vesselFlushTimer = null;
            void this.flushPendingVesselPositions();
        }, 2000);
    }

    async flushPendingVesselPositions(): Promise<void> {
        if (!this.database.isReady()) return;
        if (this.vesselFlushTimer) {
            clearTimeout(this.vesselFlushTimer);
            this.vesselFlushTimer = null;
        }
        if (this.vesselFlushInFlight) {
            await this.vesselFlushInFlight;
            return;
        }

        const run = (async () => {
            while (this.vesselPositionBuffer.size > 0) {
                const pending = [...this.vesselPositionBuffer.values()];
                this.vesselPositionBuffer.clear();
                if (pending.length === 0) break;
                await this.persistVesselPositions(pending);
            }
        })();

        this.vesselFlushInFlight = run;
        try {
            await run;
        } finally {
            if (this.vesselFlushInFlight === run) {
                this.vesselFlushInFlight = null;
            }
        }
    }

    private async persistVesselPositions(records: VesselPositionRecord[]): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = getSourceBinding('aisstream');
        const entities: EntityUpsertRow[] = [];
        const aliases: EntityAliasUpsertRow[] = [];
        const fixesSeed: Array<PositionFixUpsertRow & { state_hash: string }> = [];

        for (const record of records) {
            if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng) || !record.id) continue;

            const entityId = `vessel:${record.id}`;
            const observedAt = record.observedAt;
            const stateHash = stableHash({
                lat: Number(record.lat.toFixed(5)),
                lng: Number(record.lng.toFixed(5)),
                heading: record.heading ?? 0,
                type: record.type,
                speedKnots: record.speedKnots ?? null,
                navigationStatus: record.navigationStatus || null,
                cog: record.cog ?? null,
                destination: record.destination || null,
            });

            entities.push({
                entity_id: entityId,
                layer_id: binding?.layerId || 'vessel',
                source_id: binding?.sourceId || 'aisstream',
                entity_kind: binding?.recordKind || 'vessel',
                subtype: record.type || null,
                display_name: escapeIdentifier(record.name || record.callSign || record.id),
                first_observed_at: observedAt,
                last_observed_at: observedAt,
                properties: {
                    mmsi: record.id,
                    name: record.name || null,
                    callSign: record.callSign || null,
                    imo: record.imo || null,
                    destination: record.destination || null,
                    eta: record.eta || null,
                    draught: record.draught ?? null,
                    length: record.length ?? null,
                    beam: record.beam ?? null,
                    navigationStatus: record.navigationStatus || null,
                    rateOfTurn: record.rateOfTurn ?? null,
                    cog: record.cog ?? null,
                    _state_hash: stateHash,
                },
            });

            aliases.push({
                entity_alias_id: `alias:${entityId}:mmsi:${record.id}`,
                entity_id: entityId,
                alias_type: 'mmsi',
                alias_value: record.id,
            });

            if (record.callSign?.trim()) {
                aliases.push({
                    entity_alias_id: `alias:${entityId}:callsign:${record.callSign.trim().toUpperCase()}`,
                    entity_id: entityId,
                    alias_type: 'callsign',
                    alias_value: record.callSign.trim().toUpperCase(),
                });
            }

            if (record.imo) {
                aliases.push({
                    entity_alias_id: `alias:${entityId}:imo:${record.imo}`,
                    entity_id: entityId,
                    alias_type: 'imo',
                    alias_value: String(record.imo),
                });
            }

            fixesSeed.push({
                position_fix_id: `fix:${entityId}:${observedAt}:${stateHash}`,
                entity_id: entityId,
                layer_id: binding?.layerId || 'vessel',
                source_id: binding?.sourceId || 'aisstream',
                observed_at: observedAt,
                lat: record.lat,
                lng: record.lng,
                altitude_m: null,
                heading_deg: record.heading ?? null,
                speed_mps: record.speedKnots != null ? record.speedKnots * 0.514444 : null,
                properties: {
                    mmsi: record.id,
                    name: record.name || null,
                    callSign: record.callSign || null,
                    imo: record.imo || null,
                    destination: record.destination || null,
                    eta: record.eta || null,
                    draught: record.draught ?? null,
                    length: record.length ?? null,
                    beam: record.beam ?? null,
                    navigationStatus: record.navigationStatus || null,
                    rateOfTurn: record.rateOfTurn ?? null,
                    cog: record.cog ?? null,
                    _state_hash: stateHash,
                },
                state_hash: stateHash,
            });
        }

        const latestHashes = await this.loadLatestPositionHashes(fixesSeed.map((row) => row.entity_id));
        const liveRows = fixesSeed.map(({ state_hash: _stateHash, ...row }) => row);
        const fixes = fixesSeed
            .filter((row) => latestHashes.get(row.entity_id) !== row.state_hash)
            .map(({ state_hash: _stateHash, ...row }) => row);

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'aisstream',
                layer_id: binding?.layerId || 'vessel',
                record_count: records.length,
                metadata: {
                    canonicalTarget: 'entities',
                    changedFixCount: fixes.length,
                    entityCount: entities.length,
                },
            },
            async () => {
                await this.upsertEntities(entities);
                await this.upsertEntityAliases(aliases);
                await this.upsertEntityLiveStates(liveRows);
                await this.insertPositionFixes(fixes);
            },
        );
    }

    async persistCables(cables: CableGeoJSON | null): Promise<void> {
        if (!this.database.isReady() || !cables?.features?.length) return;

        const binding = getSourceBinding('telegeography');
        const observedAt = new Date().toISOString();
        const rows: AssetUpsertRow[] = cables.features
            .filter((feature) => Boolean(feature.geometry))
            .map((feature) => {
                const assetId = `cable:${stableHash({
                    name: feature.properties?.name || feature.properties?.id || null,
                    geometry: feature.geometry,
                })}`;
                const stateHash = stableHash({
                    geometry: feature.geometry,
                    properties: feature.properties || {},
                });
                return {
                    asset_id: assetId,
                    asset_snapshot_id: `asset-snap:${assetId}:${stateHash}`,
                    layer_id: binding?.layerId || 'cable',
                    source_id: binding?.sourceId || 'telegeography',
                    asset_kind: binding?.recordKind || 'submarine_cable',
                    subtype: 'submarine_cable',
                    display_name: escapeIdentifier(
                        String(feature.properties?.name || feature.properties?.label || feature.properties?.id || 'Submarine cable'),
                    ),
                    observed_at: observedAt,
                    geometry_json: feature.geometry,
                    properties: {
                        ...(feature.properties || {}),
                        _state_hash: stateHash,
                    },
                };
            });

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'telegeography',
                layer_id: binding?.layerId || 'cable',
                record_count: rows.length,
                metadata: {
                    canonicalTarget: binding?.canonicalTarget || 'assets',
                    rawCaptureMode: binding?.rawCaptureMode || 'snapshot',
                },
                raw_payloads: binding?.rawCaptureMode === 'snapshot'
                    ? [{
                        source_id: binding.sourceId,
                        payload: cables,
                        metadata: {
                            format: binding.rawFormat,
                            payloadKind: 'feature_collection',
                        },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.persistAssetBatch(rows, ingestRunId);
            },
        );
    }

    async persistOutages(records: OutageRecord[], options?: { sourceId?: string | null; rawPayload?: unknown }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const sourceId = options?.sourceId || 'ioda';
        const binding = getSourceBinding(sourceId);
        const rows: EventUpsertRow[] = records
            .filter((record) => Number.isFinite(record.lat) && Number.isFinite(record.lng))
            .map((record) => {
                const eventId = `outage:${sourceId}:${record.id}`;
                const properties = {
                    country: record.country,
                    countryCode: record.countryCode,
                    datasource: record.datasource,
                    level: record.level,
                    scopeType: 'country',
                };
                const stateHash = stableHash({
                    lat: Number(record.lat.toFixed(4)),
                    lng: Number(record.lng.toFixed(4)),
                    startTime: record.startTime,
                    ...properties,
                });
                return {
                    event_id: eventId,
                    event_snapshot_id: `event-snap:${eventId}:${stateHash}`,
                    layer_id: binding?.layerId || 'outage',
                    source_id: binding?.sourceId || sourceId,
                    event_kind: binding?.recordKind || 'network_outage',
                    subtype: record.level,
                    observed_at: record.startTime,
                    lat: record.lat,
                    lng: record.lng,
                    properties: {
                        ...properties,
                        _state_hash: stateHash,
                    },
                };
            });

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || sourceId,
                layer_id: binding?.layerId || 'outage',
                record_count: rows.length,
                metadata: { canonicalTarget: binding?.canonicalTarget || 'events' },
                raw_payloads: options?.rawPayload
                    ? [{
                        source_id: binding?.sourceId || sourceId,
                        payload: options.rawPayload,
                        metadata: { format: 'json', payloadKind: 'upstream_response' },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.persistEventBatch(rows, ingestRunId);
            },
        );
    }

    async persistCloudflareOutages(records: CloudflareOutage[], options?: { rawPayload?: unknown }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = getSourceBinding('cloudflare_radar');
        const rows: EventUpsertRow[] = records.map((record) => {
            const eventId = `outage:cloudflare:${record.id}`;
            const properties = {
                scope: record.scope,
                asn: record.asn,
                asnName: record.asnName,
                locations: record.locations,
                outageType: record.outageType,
                outageCause: record.outageCause,
                endDate: record.endDate || null,
            };
            const stateHash = stableHash({
                startDate: record.startDate,
                ...properties,
            });
            return {
                event_id: eventId,
                event_snapshot_id: `event-snap:${eventId}:${stateHash}`,
                layer_id: binding?.layerId || 'outage',
                source_id: binding?.sourceId || 'cloudflare_radar',
                event_kind: binding?.recordKind || 'network_outage',
                subtype: record.outageType || 'outage',
                observed_at: record.startDate || null,
                properties: {
                    ...properties,
                    _state_hash: stateHash,
                },
            };
        });

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'cloudflare_radar',
                layer_id: binding?.layerId || 'outage',
                record_count: rows.length,
                metadata: { canonicalTarget: binding?.canonicalTarget || 'events' },
                raw_payloads: options?.rawPayload
                    ? [{
                        source_id: binding?.sourceId || 'cloudflare_radar',
                        payload: options.rawPayload,
                        metadata: { format: 'json', payloadKind: 'upstream_response' },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.persistEventBatch(rows, ingestRunId);
            },
        );
    }

    async persistAcledConflicts(records: ConflictEvent[], options?: { rawPayload?: unknown }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = getSourceBinding('acled');
        const rows: EventUpsertRow[] = records
            .filter((record) => Number.isFinite(record.lat) && Number.isFinite(record.lng))
            .map((record) => {
                const eventId = `conflict:acled:${record.id}`;
                const properties = {
                    country: record.country,
                    actor1: record.actor1,
                    actor2: record.actor2,
                    fatalities: record.fatalities,
                    notes: record.notes,
                };
                const stateHash = stableHash({
                    lat: Number(record.lat.toFixed(4)),
                    lng: Number(record.lng.toFixed(4)),
                    eventType: record.event_type,
                    subEventType: record.sub_event_type,
                    eventDate: record.event_date,
                    ...properties,
                });
                return {
                    event_id: eventId,
                    event_snapshot_id: `event-snap:${eventId}:${stateHash}`,
                    layer_id: binding?.layerId || 'conflict',
                    source_id: binding?.sourceId || 'acled',
                    event_kind: binding?.recordKind || 'conflict_event',
                    subtype: record.sub_event_type || record.event_type,
                    observed_at: record.event_date ? new Date(record.event_date).toISOString() : null,
                    lat: record.lat,
                    lng: record.lng,
                    properties: {
                        eventType: record.event_type,
                        subEventType: record.sub_event_type,
                        ...properties,
                        _state_hash: stateHash,
                    },
                };
            });

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'acled',
                layer_id: binding?.layerId || 'conflict',
                record_count: rows.length,
                metadata: { canonicalTarget: binding?.canonicalTarget || 'events' },
                raw_payloads: options?.rawPayload
                    ? [{
                        source_id: binding?.sourceId || 'acled',
                        payload: options.rawPayload,
                        metadata: { format: 'json', payloadKind: 'upstream_response' },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.persistEventBatch(rows, ingestRunId);
            },
        );
    }

    async persistGdeltConflicts(records: GdeltConflictEvent[]): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = getSourceBinding('gdelt');
        const rows: EventUpsertRow[] = records
            .filter((record) => Number.isFinite(record.lat) && Number.isFinite(record.lng))
            .map((record) => {
                const eventId = `conflict:gdelt:${record.id}`;
                const observedAt = record.date && /^\d{8}$/.test(record.date)
                    ? `${record.date.slice(0, 4)}-${record.date.slice(4, 6)}-${record.date.slice(6, 8)}T00:00:00.000Z`
                    : null;
                const properties = {
                    eventCode: record.eventCode,
                    rootCode: record.rootCode,
                    eventType: record.eventType,
                    subEventType: record.subEventType,
                    actor1: record.actor1,
                    actor2: record.actor2,
                    goldstein: record.goldstein,
                    numMentions: record.numMentions,
                    numSources: record.numSources,
                    sourceUrl: record.sourceUrl,
                    country: record.country,
                    location: record.location,
                };
                const stateHash = stableHash({
                    lat: Number(record.lat.toFixed(4)),
                    lng: Number(record.lng.toFixed(4)),
                    observedAt,
                    ...properties,
                });
                return {
                    event_id: eventId,
                    event_snapshot_id: `event-snap:${eventId}:${stateHash}`,
                    layer_id: binding?.layerId || 'conflict',
                    source_id: binding?.sourceId || 'gdelt',
                    event_kind: binding?.recordKind || 'conflict_event',
                    subtype: record.subEventType || record.eventType,
                    observed_at: observedAt,
                    lat: record.lat,
                    lng: record.lng,
                    properties: {
                        ...properties,
                        _state_hash: stateHash,
                    },
                };
            });

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'gdelt',
                layer_id: binding?.layerId || 'conflict',
                record_count: rows.length,
                metadata: { canonicalTarget: binding?.canonicalTarget || 'events' },
            },
            async (ingestRunId) => {
                await this.persistEventBatch(rows, ingestRunId);
            },
        );
    }

    async persistGfwEvents(records: GFWEvent[], options?: { rawPayload?: unknown }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = getSourceBinding('gfw');
        const rows: EventUpsertRow[] = records
            .filter((record) => Number.isFinite(record.lat) && Number.isFinite(record.lng))
            .map((record) => {
                const eventId = `gfw:${record.id}`;
                const properties = {
                    vesselId: record.vesselId,
                    vesselName: record.vesselName,
                    flagState: record.flagState,
                    confidence: record.confidence,
                    duration: record.duration,
                    vesselOwner: record.vesselOwner,
                    vesselMmsi: record.vesselMmsi,
                    vesselType: record.vesselType,
                    end: record.end || null,
                };
                const stateHash = stableHash({
                    lat: Number(record.lat.toFixed(4)),
                    lng: Number(record.lng.toFixed(4)),
                    type: record.type,
                    start: record.start,
                    ...properties,
                });
                return {
                    event_id: eventId,
                    event_snapshot_id: `event-snap:${eventId}:${stateHash}`,
                    layer_id: binding?.layerId || 'gfw',
                    source_id: binding?.sourceId || 'gfw',
                    event_kind: binding?.recordKind || 'dark_vessel_event',
                    subtype: record.type || 'gap',
                    observed_at: record.start || null,
                    lat: record.lat,
                    lng: record.lng,
                    properties: {
                        ...properties,
                        _state_hash: stateHash,
                    },
                };
            });

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'gfw',
                layer_id: binding?.layerId || 'gfw',
                record_count: rows.length,
                metadata: { canonicalTarget: binding?.canonicalTarget || 'events' },
                raw_payloads: options?.rawPayload
                    ? [{
                        source_id: binding?.sourceId || 'gfw',
                        payload: options.rawPayload,
                        metadata: { format: 'json', payloadKind: 'upstream_response' },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.persistEventBatch(rows, ingestRunId);
            },
        );
    }

    async persistSatelliteCatalog(records: SatelliteRecord[], options?: { provider?: string | null; loadedFromCache?: boolean }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = getSourceBinding('celestrak');
        const observedAt = new Date().toISOString();
        const entities: EntityUpsertRow[] = [];
        const aliases: EntityAliasUpsertRow[] = [];
        const orbitalRows: OrbitalElementUpsertRow[] = [];

        for (const record of records) {
            if (!record.tleLine1 || !record.tleLine2) continue;
            const noradId = Number.isFinite(record.noradId) && record.noradId > 0 ? String(record.noradId) : null;
            const entityId = noradId
                ? `satellite:${noradId}`
                : `satellite:${stableHash({ name: record.name, tleLine1: record.tleLine1, tleLine2: record.tleLine2 })}`;
            const stateHash = stableHash({
                tleLine1: record.tleLine1,
                tleLine2: record.tleLine2,
                provider: options?.provider || null,
            });

            entities.push({
                entity_id: entityId,
                layer_id: binding?.layerId || 'satellite',
                source_id: binding?.sourceId || 'celestrak',
                entity_kind: binding?.recordKind || 'satellite',
                subtype: record.type || null,
                display_name: escapeIdentifier(record.name || noradId || entityId),
                first_observed_at: observedAt,
                last_observed_at: observedAt,
                properties: {
                    noradId: record.noradId,
                    type: record.type,
                    classificationSource: record.classificationSource || 'derived_name_heuristic',
                    recon: record.recon || false,
                    reconMeta: record.reconMeta || null,
                    sensor: record.sensor || null,
                    provider: options?.provider || null,
                    loadedFromCache: options?.loadedFromCache || false,
                    _state_hash: stateHash,
                },
            });

            if (noradId) {
                aliases.push({
                    entity_alias_id: `alias:${entityId}:norad:${noradId}`,
                    entity_id: entityId,
                    alias_type: 'norad_id',
                    alias_value: noradId,
                });
            }

            orbitalRows.push({
                orbital_element_id: `orb:${entityId}:${stateHash}`,
                entity_id: entityId,
                source_id: binding?.sourceId || 'celestrak',
                observed_at: observedAt,
                norad_id: noradId,
                tle_line1: record.tleLine1,
                tle_line2: record.tleLine2,
                properties: {
                    name: record.name,
                    type: record.type,
                    classificationSource: record.classificationSource || 'derived_name_heuristic',
                    provider: options?.provider || null,
                    loadedFromCache: options?.loadedFromCache || false,
                    recon: record.recon || false,
                    sensor: record.sensor || null,
                    _state_hash: stateHash,
                },
            });
        }

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'celestrak',
                layer_id: binding?.layerId || 'satellite',
                record_count: records.length,
                metadata: {
                    canonicalTarget: binding?.canonicalTarget || 'orbital_elements',
                    provider: options?.provider || null,
                    loadedFromCache: options?.loadedFromCache || false,
                },
            },
            async () => {
                await this.upsertEntities(entities);
                await this.upsertEntityAliases(aliases);
                await this.insertOrbitalElements(orbitalRows);
            },
        );
    }

    async persistAirspaceZones(zones: AirspaceZone[]): Promise<void> {
        if (!this.database.isReady() || zones.length === 0) return;

        const binding = getSourceBinding('openaip');
        const observedAt = new Date().toISOString();
        const rows = zones
            .map((zone) => {
                const coordinates = zone.geometry
                    .map((polygon) => {
                        const outer = latLngPathToGeoJsonRing(polygon.outer);
                        if (outer.length < 4) return null;
                        const holes = (polygon.holes || [])
                            .map((hole) => latLngPathToGeoJsonRing(hole))
                            .filter((hole) => hole.length >= 4);
                        return [outer, ...holes];
                    })
                    .filter(Boolean) as any[];

                if (coordinates.length === 0) return null;

                const geometryJson: GeoJsonGeometry = {
                    type: 'MultiPolygon',
                    coordinates,
                };
                const assetId = `airspace:${zone.id}`;
                const stateHash = stableHash({
                    geometry: geometryJson,
                    type: zone.type,
                    upperLimit: zone.upperLimit,
                    lowerLimit: zone.lowerLimit,
                    name: zone.name,
                });
                return {
                    asset_id: assetId,
                    asset_snapshot_id: `asset-snap:${assetId}:${stateHash}`,
                    layer_id: binding?.layerId || 'airspace',
                    source_id: binding?.sourceId || 'openaip',
                    asset_kind: binding?.recordKind || 'airspace_zone',
                    subtype: zone.typeName || String(zone.type),
                    display_name: escapeIdentifier(zone.name),
                    observed_at: observedAt,
                    geometry_json: geometryJson,
                    properties: {
                        type: zone.type,
                        typeName: zone.typeName,
                        upperLimit: zone.upperLimit,
                        lowerLimit: zone.lowerLimit,
                        _state_hash: stateHash,
                    },
                };
            })
            .filter((row): row is NonNullable<typeof row> => row !== null);

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'openaip',
                layer_id: binding?.layerId || 'airspace',
                record_count: rows.length,
                metadata: { canonicalTarget: binding?.canonicalTarget || 'assets' },
            },
            async (ingestRunId) => {
                await this.persistAssetBatch(rows, ingestRunId);
            },
        );
    }

    async persistPipelines(records: PipelineRecord[]): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = getSourceBinding('osm_pipelines');
        const observedAt = new Date().toISOString();
        const rows = records
            .map((record) => {
                if (!Array.isArray(record.coordinates) || record.coordinates.length < 2) return null;
                const coordinates = record.coordinates
                    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
                    .map(([lat, lng]) => [lng, lat]);
                if (coordinates.length < 2) return null;

                const geometryJson: GeoJsonGeometry = {
                    type: 'LineString',
                    coordinates,
                };
                const assetId = `pipeline:${record.id}`;
                const stateHash = stableHash({
                    geometry: geometryJson,
                    name: record.name,
                    substance: record.substance,
                });
                return {
                    asset_id: assetId,
                    asset_snapshot_id: `asset-snap:${assetId}:${stateHash}`,
                    layer_id: binding?.layerId || 'pipeline',
                    source_id: binding?.sourceId || 'osm_pipelines',
                    asset_kind: binding?.recordKind || 'pipeline',
                    subtype: record.substance || null,
                    display_name: escapeIdentifier(record.name),
                    observed_at: observedAt,
                    geometry_json: geometryJson,
                    properties: {
                        name: record.name,
                        substance: record.substance,
                        _state_hash: stateHash,
                    },
                };
            })
            .filter((row): row is NonNullable<typeof row> => row !== null);

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'osm_pipelines',
                layer_id: binding?.layerId || 'pipeline',
                record_count: rows.length,
                metadata: { canonicalTarget: binding?.canonicalTarget || 'assets' },
            },
            async (ingestRunId) => {
                await this.persistAssetBatch(rows, ingestRunId);
            },
        );
    }

    async persistJamming(
        zones: JammingZone[],
        snapshotDate: string | null,
        options?: { rawCsv?: string | null },
    ): Promise<void> {
        if (!this.database.isReady() || zones.length === 0) return;

        const observedAt = snapshotDate ? `${snapshotDate}T00:00:00.000Z` : new Date().toISOString();
        const binding = getSourceBinding('gpsjam');
        const rows: EventUpsertRow[] = [];

        for (const zone of zones) {
            const ring = zone.boundary.map(([lat, lng]) => [lng, lat]);
            if (ring.length < 3) continue;
            const closedRing = [...ring, ring[0]];
            rows.push({
                event_id: `jamming:${zone.h3Index}`,
                event_snapshot_id: `jamming:${snapshotDate || 'unknown'}:${zone.h3Index}`,
                layer_id: binding?.layerId || 'jamming',
                source_id: binding?.sourceId || 'gpsjam',
                event_kind: binding?.recordKind || 'gnss_jamming',
                subtype: zone.intensity,
                observed_at: observedAt,
                geometry_json: {
                    type: 'Polygon',
                    coordinates: [closedRing],
                },
                properties: {
                    lat: zone.lat,
                    lng: zone.lng,
                    countGood: zone.countGood,
                    countBad: zone.countBad,
                    ratio: zone.ratio,
                    intensity: zone.intensity,
                    h3Index: zone.h3Index,
                },
            });
        }

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'gpsjam',
                layer_id: binding?.layerId || 'jamming',
                record_count: rows.length,
                metadata: {
                    snapshotDate,
                    canonicalTarget: binding?.canonicalTarget || 'events',
                    rawCaptureMode: binding?.rawCaptureMode || 'snapshot',
                },
                raw_payloads: binding?.rawCaptureMode === 'snapshot' && options?.rawCsv
                    ? [{
                        source_id: binding.sourceId,
                        observed_at: observedAt,
                        upstream_id: snapshotDate || null,
                        payload: { content: options.rawCsv },
                        metadata: {
                            format: binding.rawFormat,
                            payloadKind: 'daily_csv',
                            snapshotDate,
                        },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.persistEventBatch(rows, ingestRunId);
            },
        );
    }

    async persistFires(records: FireRecord[], options?: { rawCsv?: string | null }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;
        const binding = getSourceBinding('firms');

        const payload: EventUpsertRow[] = records.map((record) => {
            const normalizedTime = String(record.acqTime || '0000').padStart(4, '0');
            const observedAt = record.acqDate
                ? `${record.acqDate}T${normalizedTime.slice(0, 2)}:${normalizedTime.slice(2, 4)}:00.000Z`
                : new Date().toISOString();

            return {
                event_id: `fire:${stableHash({
                    date: record.acqDate || null,
                    time: normalizedTime,
                    lat: record.lat,
                    lng: record.lng,
                    fireType: record.fireType,
                })}`,
                event_snapshot_id: `fire:${stableHash({
                    date: record.acqDate || null,
                    time: normalizedTime,
                    lat: record.lat,
                    lng: record.lng,
                    fireType: record.fireType,
                })}`,
                layer_id: binding?.layerId || 'fire',
                source_id: binding?.sourceId || 'firms',
                event_kind: binding?.recordKind || 'active_fire',
                subtype: `firms_type_${record.fireType}`,
                observed_at: observedAt,
                lat: record.lat,
                lng: record.lng,
                geometry_json: null,
                properties: record,
            };
        });

        await this.runTrackedIngest(
            {
                source_id: binding?.sourceId || 'firms',
                layer_id: binding?.layerId || 'fire',
                record_count: payload.length,
                metadata: {
                    canonicalTarget: binding?.canonicalTarget || 'events',
                    rawCaptureMode: binding?.rawCaptureMode || 'none',
                },
                raw_payloads: binding?.rawCaptureMode === 'snapshot' && options?.rawCsv
                    ? [{
                        source_id: binding.sourceId,
                        payload: { content: options.rawCsv },
                        metadata: {
                            format: binding.rawFormat,
                            payloadKind: 'global_csv_snapshot',
                        },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.persistEventBatch(payload, ingestRunId);
            },
        );
    }

    async persistDisasterEvents(
        events: DisasterEvent[],
        options?: { rawPayloads?: RawPayloadInput[] },
    ): Promise<void> {
        if (!this.database.isReady() || events.length === 0) return;

        const deduped = new Map<string, EventUpsertRow>();

        for (const event of events) {
            const normalizedSourceId = this.normalizeDisasterSourceId(event.source);
            const observedAt = event.startTime || new Date().toISOString();
            const lat = Number(event.lat);
            const lng = Number(event.lng);
            const geometryJson = event.geometry && typeof event.geometry.type === 'string'
                ? event.geometry
                : null;
            const normalized = {
                event_id: `disaster:${stableHash({
                    source: normalizedSourceId,
                    nativeId: event.id,
                })}`,
                event_snapshot_id: `disaster:${stableHash({
                    source: normalizedSourceId,
                    nativeId: event.id,
                    observedAt,
                    geometry: geometryJson || { type: 'Point', coordinates: [lng, lat] },
                    subtype: event.eventType || 'unknown',
                })}`,
                layer_id: 'disasters',
                source_id: normalizedSourceId,
                event_kind: 'disaster_event',
                subtype: event.eventType || 'unknown',
                observed_at: observedAt,
                lat,
                lng,
                geometry_json: geometryJson,
                properties: event,
            };

            if (!geometryJson && (!Number.isFinite(normalized.lat) || !Number.isFinite(normalized.lng))) {
                continue;
            }

            deduped.set(normalized.event_snapshot_id, normalized);
        }

        const payload = [...deduped.values()];

        if (payload.length === 0) return;

        const rowsBySource = new Map<string, EventUpsertRow[]>();
        for (const row of payload) {
            const sourceId = row.source_id || 'unknown';
            const bucket = rowsBySource.get(sourceId);
            if (bucket) bucket.push(row);
            else rowsBySource.set(sourceId, [row]);
        }

        for (const [sourceId, rows] of rowsBySource) {
            const rawPayloadsForSource = (options?.rawPayloads || []).filter(
                (payloadRow) => (payloadRow.source_id || 'unknown') === sourceId,
            );

            await this.runTrackedIngest(
                {
                    source_id: sourceId === 'unknown' ? null : sourceId,
                    layer_id: 'disasters',
                    record_count: rows.length,
                    metadata: {
                        sourceIds: sourceId === 'unknown' ? [] : [sourceId],
                        canonicalTarget: 'events',
                        rawCaptureMode: rawPayloadsForSource.length ? 'snapshot' : 'none',
                    },
                    raw_payloads: rawPayloadsForSource,
                },
                async (ingestRunId) => {
                    await this.persistEventBatch(rows, ingestRunId);
                },
            );
        }
    }
}
