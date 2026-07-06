import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../db/database.service';
import type { JammingZone } from './gpsjam.service';
import type { FireRecord } from './extended.service';
import type { DisasterEvent } from './live-stream.service';
import { COUNTRY_CENTROIDS, type OutageRecord } from './ioda.service';
import type { CloudflareOutage } from './cloudflare.service';
import type { AcledDeletedEvent, ConflictEvent } from './acled.service';
import type { GdeltConflictEvent } from './gdelt.service';
import type { CirConflictEvent } from './cir.service';
import type { AirspaceZone } from './airspace.service';
import type { PipelineRecord } from './infrastructure.service';
import type { SatelliteRecord } from './satellite.service';
import type { GFWEvent } from './gfw.service';
import { requireSourceExecutionPlan, type SourceBindingDefinition } from './source-bindings.service';
import { getLayerRenderContract } from './render-contracts';

type CableFeature = {
    properties?: Record<string, any>;
    geometry?: { type: string; coordinates: any };
};

type CableGeoJSON = {
    type: string;
    features?: CableFeature[];
};

function requireSourceBinding(sourceId: string | null | undefined): SourceBindingDefinition {
    return requireSourceExecutionPlan(sourceId).binding;
}

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
    latest_snapshot_id: string | null;
    layer_id: string;
    source_id: string | null;
    entity_kind: string;
    subtype: string | null;
    display_name: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    properties: Record<string, any>;
};

type EntitySnapshotUpsertRow = {
    entity_snapshot_id: string;
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    entity_kind: string;
    subtype: string | null;
    display_name: string | null;
    observed_at: string | null;
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

type RawPayloadPersistStats = {
    count: number;
    bytes: number;
    storedCount: number;
    duplicateCount: number;
    hashes: string[];
};

type IngestRunInput = {
    source_id?: string | null;
    layer_id: string;
    record_count: number;
    metadata?: Record<string, any>;
    raw_payloads?: RawPayloadInput[];
};

export type SourceIngestMetricRow = {
    sourceId: string | null;
    layerId: string | null;
    ingestRunId: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    upstreamBytes: number;
    rawCount: number;
    normalizedCount: number;
    changedCount: number;
    parseMs: number | null;
    dbWriteMs: number | null;
    rawPersistMs: number | null;
    totalMs: number | null;
    renderBatchBytes: number | null;
    completeness: string;
    errorMessage: string | null;
    metadata: Record<string, any>;
};

type RawBackedIngestOptions = {
    rawPayload?: unknown;
    metadata?: Record<string, any>;
    rawPayloadMetadata?: Record<string, any>;
    deletedRecords?: AcledDeletedEvent[];
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
    layer_id: string;
    source_id: string | null;
    observed_at: string;
    tle_epoch_at?: string | null;
    fetched_at?: string | null;
    provider?: string | null;
    source_publication_at?: string | null;
    norad_id: string | null;
    tle_line1: string;
    tle_line2: string;
    state_hash?: string | null;
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

function tleStateHash(tleLine1: string, tleLine2: string): string {
    return crypto.createHash('md5').update(`${tleLine1}|${tleLine2}`).digest('hex');
}

function aisVesselWalDir(): string {
    return process.env.AIS_VESSEL_WAL_DIR
        ? path.resolve(process.env.AIS_VESSEL_WAL_DIR)
        : path.resolve(process.cwd(), 'var', 'ais-vessel-position-buffer');
}

const DEFAULT_AIS_VESSEL_DB_FLUSH_DELAY_MS = 10_000;

function positiveIntFromEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function normalizeVesselWalRecord(value: any): VesselPositionRecord | null {
    const record = value?.record && typeof value.record === 'object' ? value.record : value;
    if (!record || typeof record !== 'object') return null;
    if (!record.id || !Number.isFinite(Number(record.lat)) || !Number.isFinite(Number(record.lng)) || !record.observedAt) {
        return null;
    }
    const finiteOrNull = (input: unknown): number | null => {
        if (input == null) return null;
        const numeric = Number(input);
        return Number.isFinite(numeric) ? numeric : null;
    };
    return {
        id: String(record.id),
        lat: Number(record.lat),
        lng: Number(record.lng),
        heading: finiteOrNull(record.heading),
        type: String(record.type || 'unknown'),
        speedKnots: finiteOrNull(record.speedKnots),
        navigationStatus: record.navigationStatus || null,
        rateOfTurn: finiteOrNull(record.rateOfTurn),
        cog: finiteOrNull(record.cog),
        name: record.name || null,
        callSign: record.callSign || null,
        imo: finiteOrNull(record.imo),
        destination: record.destination || null,
        eta: record.eta || null,
        draught: finiteOrNull(record.draught),
        length: finiteOrNull(record.length),
        beam: finiteOrNull(record.beam),
        observedAt: String(record.observedAt),
    };
}

function roundMs(value: number): number {
    return Math.round(value * 100) / 100;
}

function finiteNumberOrNull(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function inferCompleteness(metadata: Record<string, any> | undefined, status: 'completed' | 'failed'): 'complete' | 'incomplete' | 'unavailable' {
    if (status === 'failed') return 'unavailable';
    const explicit = metadata?.sourceMetrics?.completeness
        ?? metadata?.completeness
        ?? metadata?.apiCompleteness
        ?? metadata?.completenessStatus;
    if (explicit === 'complete' || explicit === 'incomplete' || explicit === 'unavailable') return explicit;
    if (metadata?.truncated === true || metadata?.hitPageLimit === true || metadata?.pagination?.hitPageLimit === true) return 'incomplete';
    return 'complete';
}

function buildSourceMetrics(
    input: IngestRunInput,
    rawPersistStats: RawPayloadPersistStats,
    rawPersistMs: number,
    canonicalWriteMs: number,
    totalMs: number,
    status: 'completed' | 'failed',
): Record<string, number | string | null> {
    const existing = input.metadata?.sourceMetrics || {};
    const rawCount = finiteNumberOrNull(existing.rawCount ?? input.metadata?.rawCount) ?? rawPersistStats.count;
    const normalizedCount = finiteNumberOrNull(existing.normalizedCount ?? input.metadata?.normalizedCount) ?? input.record_count;
    const changedCount = finiteNumberOrNull(existing.changedCount ?? input.metadata?.changedCount)
        ?? (rawPersistStats.count > 0 ? rawPersistStats.storedCount : input.record_count);
    return {
        upstreamBytes: finiteNumberOrNull(existing.upstreamBytes ?? input.metadata?.upstreamBytes) ?? rawPersistStats.bytes,
        rawCount,
        normalizedCount,
        changedCount,
        parseMs: finiteNumberOrNull(existing.parseMs ?? input.metadata?.parseMs ?? input.metadata?.timingsMs?.parse),
        dbWriteMs: finiteNumberOrNull(existing.dbWriteMs) ?? canonicalWriteMs,
        rawPersistMs,
        totalMs,
        renderBatchBytes: finiteNumberOrNull(existing.renderBatchBytes ?? input.metadata?.renderBatchBytes),
        completeness: inferCompleteness(input.metadata, status),
    };
}

function escapeIdentifier(value: string | null | undefined): string | null {
    if (!value) return null;
    return value.replace(/\s+/g, ' ').trim();
}

function requireCanonicalLayerId(layerId: string | null | undefined, context: string): string {
    const normalized = String(layerId || '').trim();
    if (!normalized) {
        throw new Error(`[source-persistence] ${context} is missing layer_id`);
    }
    const contract = getLayerRenderContract(normalized);
    if (contract.layerId !== normalized) {
        throw new Error(`[source-persistence] ${context} uses non-canonical layer_id=${normalized}; expected ${contract.layerId}`);
    }
    return normalized;
}

function validateLayerRows<T extends { layer_id?: string | null }>(
    rows: T[],
    context: string,
    rowId: (row: T) => string | null | undefined,
): void {
    for (const row of rows) {
        const id = rowId(row);
        requireCanonicalLayerId(row.layer_id, `${context}${id ? ` row=${id}` : ''}`);
    }
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
    private readonly vesselPositionWalFile: string;
    private readonly vesselDbFlushDelayMs = positiveIntFromEnv('AIS_VESSEL_DB_FLUSH_DELAY_MS', DEFAULT_AIS_VESSEL_DB_FLUSH_DELAY_MS);
    private vesselFlushTimer: NodeJS.Timeout | null = null;
    private vesselFlushInFlight: Promise<void> | null = null;
    private vesselWalRecoveredCount = 0;
    private vesselWalLastError: string | null = null;

    constructor(private readonly database: DatabaseService) {
        this.vesselPositionWalFile = path.join(aisVesselWalDir(), 'pending-vessel-positions.jsonl');
        this.loadVesselPositionWal();
        this.registerVesselBeforeExitFlush();
    }

    getVesselDurabilityStatus(): {
        mode: 'persisted_buffer';
        scope: string;
        walFile: string;
        pendingBufferCount: number;
        recoveredCount: number;
        lastError: string | null;
    } {
        return {
            mode: 'persisted_buffer',
            scope: 'post-throttle latest accepted position fix per MMSI before DB flush',
            walFile: this.vesselPositionWalFile,
            pendingBufferCount: this.vesselPositionBuffer.size,
            recoveredCount: this.vesselWalRecoveredCount,
            lastError: this.vesselWalLastError,
        };
    }

    private loadVesselPositionWal(): void {
        if (!fs.existsSync(this.vesselPositionWalFile)) return;
        let loaded = 0;
        let malformed = 0;
        try {
            const text = fs.readFileSync(this.vesselPositionWalFile, 'utf8');
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const record = normalizeVesselWalRecord(JSON.parse(trimmed));
                    if (!record) {
                        malformed += 1;
                        continue;
                    }
                    this.vesselPositionBuffer.set(record.id, record);
                    loaded += 1;
                } catch {
                    malformed += 1;
                }
            }
            this.vesselWalRecoveredCount = this.vesselPositionBuffer.size;
            if (loaded > 0 || malformed > 0) {
                console.log(`[AISStream] recovered ${this.vesselPositionBuffer.size} pending vessel fixes from WAL (${malformed} malformed lines ignored)`);
            }
        } catch (error: any) {
            this.vesselWalLastError = error?.message || String(error);
            throw new Error(`Failed to read AIS vessel WAL ${this.vesselPositionWalFile}: ${this.vesselWalLastError}`);
        }
    }

    private appendVesselPositionWal(record: VesselPositionRecord): void {
        try {
            fs.mkdirSync(path.dirname(this.vesselPositionWalFile), { recursive: true });
            fs.appendFileSync(
                this.vesselPositionWalFile,
                `${JSON.stringify({ version: 1, queuedAt: new Date().toISOString(), record })}\n`,
                'utf8',
            );
            this.vesselWalLastError = null;
        } catch (error: any) {
            this.vesselWalLastError = error?.message || String(error);
            throw new Error(`Failed to append AIS vessel WAL ${this.vesselPositionWalFile}: ${this.vesselWalLastError}`);
        }
    }

    private rewriteVesselPositionWalFromBuffer(): void {
        try {
            fs.mkdirSync(path.dirname(this.vesselPositionWalFile), { recursive: true });
            if (this.vesselPositionBuffer.size === 0) {
                if (fs.existsSync(this.vesselPositionWalFile)) fs.unlinkSync(this.vesselPositionWalFile);
                this.vesselWalLastError = null;
                return;
            }
            const tmpFile = `${this.vesselPositionWalFile}.${process.pid}.tmp`;
            const body = [...this.vesselPositionBuffer.values()]
                .map((record) => JSON.stringify({ version: 1, queuedAt: new Date().toISOString(), record }))
                .join('\n');
            fs.writeFileSync(tmpFile, `${body}\n`, 'utf8');
            fs.renameSync(tmpFile, this.vesselPositionWalFile);
            this.vesselWalLastError = null;
        } catch (error: any) {
            this.vesselWalLastError = error?.message || String(error);
            throw new Error(`Failed to rewrite AIS vessel WAL ${this.vesselPositionWalFile}: ${this.vesselWalLastError}`);
        }
    }

    private registerVesselBeforeExitFlush(): void {
        process.once('beforeExit', () => {
            if (!this.database.isReady() || this.vesselPositionBuffer.size === 0) return;
            void this.flushPendingVesselPositions().catch((error: any) => {
                console.warn('[AISStream] failed to flush pending vessel positions before exit:', error?.message || error);
            });
        });
    }

    private buildIngestRunId(layerId: string, sourceId: string | null | undefined, metadata: Record<string, any> | undefined): string {
        return `ingest:${layerId}:${sourceId || 'mixed'}:${stableHash({
            timestamp: new Date().toISOString(),
            metadata: metadata || null,
        })}`;
    }

    private serializeRawPayload(payload: unknown): { json: string; bytes: number; hash: string } {
        const json = JSON.stringify(payload === undefined ? null : payload) ?? 'null';
        return {
            json,
            bytes: Buffer.byteLength(json, 'utf8'),
            hash: crypto.createHash('md5').update(json).digest('hex'),
        };
    }

    private buildRawPayloadId(layerId: string, sourceId: string | null | undefined, upstreamId: string | null | undefined, contentHash: string): string {
        return `raw:${stableHash({ layerId, sourceId: sourceId || null, upstreamId: upstreamId || null, contentHash })}`;
    }

    async getLatestEventObservedAt(layerId: string, sourceId?: string | null): Promise<string | null> {
        if (!this.database.isReady()) return null;
        const params: unknown[] = [layerId];
        let sourceWhere = '';
        if (sourceId) {
            params.push(sourceId);
            sourceWhere = `AND source_id = $${params.length}`;
        }
        const result = await this.database.query<{ observed_at: string | Date | null }>(
            `
                SELECT observed_at
                FROM core.events
                WHERE layer_id = $1
                  ${sourceWhere}
                  AND observed_at IS NOT NULL
                ORDER BY observed_at DESC, updated_at DESC
                LIMIT 1
            `,
            params,
        );
        const value = result?.rows[0]?.observed_at;
        if (!value) return null;
        return value instanceof Date ? value.toISOString() : String(value);
    }

    async getLatestEventPropertyNumber(layerId: string, sourceId: string | null | undefined, propertyKey: string): Promise<number | null> {
        if (!this.database.isReady()) return null;
        const params: unknown[] = [layerId, propertyKey];
        let sourceWhere = '';
        if (sourceId) {
            params.push(sourceId);
            sourceWhere = `AND source_id = $${params.length}`;
        }
        const result = await this.database.query<{ value: string | number | null }>(
            `
                SELECT MAX((properties ->> $2)::double precision) AS value
                FROM core.events
                WHERE layer_id = $1
                  ${sourceWhere}
                  AND properties ? $2
                  AND (properties ->> $2) ~ '^-?[0-9]+(\\.[0-9]+)?$'
            `,
            params,
        );
        const value = result?.rows[0]?.value;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    async listLatestSourceIngestMetrics(): Promise<SourceIngestMetricRow[]> {
        if (!this.database.isReady()) return [];
        const result = await this.database.query<any>(
            `
                SELECT
                    ingest_run_id,
                    source_id,
                    layer_id,
                    started_at,
                    completed_at,
                    status,
                    error_message,
                    upstream_bytes,
                    raw_count,
                    normalized_count,
                    changed_count,
                    parse_ms,
                    db_write_ms,
                    raw_persist_ms,
                    total_ms,
                    render_batch_bytes,
                    completeness,
                    metadata
                FROM raw.latest_source_ingest_metrics
                ORDER BY COALESCE(source_id, ''), COALESCE(layer_id, '')
            `,
        );
        return (result?.rows || []).map((row) => ({
            sourceId: row.source_id ?? null,
            layerId: row.layer_id ?? null,
            ingestRunId: row.ingest_run_id,
            status: row.status,
            startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at ? String(row.started_at) : null,
            completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at ? String(row.completed_at) : null,
            upstreamBytes: Number(row.upstream_bytes || 0),
            rawCount: Number(row.raw_count || 0),
            normalizedCount: Number(row.normalized_count || 0),
            changedCount: Number(row.changed_count || 0),
            parseMs: finiteNumberOrNull(row.parse_ms),
            dbWriteMs: finiteNumberOrNull(row.db_write_ms),
            rawPersistMs: finiteNumberOrNull(row.raw_persist_ms),
            totalMs: finiteNumberOrNull(row.total_ms),
            renderBatchBytes: finiteNumberOrNull(row.render_batch_bytes),
            completeness: String(row.completeness || 'unavailable'),
            errorMessage: row.error_message ?? null,
            metadata: row.metadata || {},
        }));
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

    private async persistRawPayloads(ingestRunId: string | null, layerId: string, payloads: RawPayloadInput[]): Promise<RawPayloadPersistStats> {
        const empty: RawPayloadPersistStats = {
            count: payloads.length,
            bytes: 0,
            storedCount: 0,
            duplicateCount: 0,
            hashes: [],
        };
        if (!this.database.isReady() || !ingestRunId || payloads.length === 0) return empty;

        const stats: RawPayloadPersistStats = { ...empty };

        for (const payload of payloads) {
            const serialized = this.serializeRawPayload(payload.payload);
            stats.bytes += serialized.bytes;
            stats.hashes.push(serialized.hash);
            const payloadSourceId = payload.source_id || null;
            const upstreamId = payload.upstream_id || null;
            const result = await this.database.query<{ raw_payload_id: string }>(
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
                        content_hash,
                        payload_bytes,
                        created_at
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        COALESCE($5::timestamptz, now()),
                        $6,
                        $7::jsonb,
                        $8::jsonb,
                        $9,
                        $10,
                        now()
                    )
                    ON CONFLICT (raw_payload_id)
                    DO NOTHING
                    RETURNING raw_payload_id
                `,
                [
                    this.buildRawPayloadId(layerId, payloadSourceId, upstreamId, serialized.hash),
                    ingestRunId,
                    payloadSourceId,
                    layerId,
                    payload.observed_at || null,
                    upstreamId,
                    serialized.json,
                    JSON.stringify({
                        ...(payload.metadata || {}),
                        contentHash: serialized.hash,
                        payloadBytes: serialized.bytes,
                    }),
                    serialized.hash,
                    serialized.bytes,
                ],
            );
            if ((result?.rowCount || 0) > 0) stats.storedCount += 1;
            else stats.duplicateCount += 1;
        }

        return stats;
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
        const layerId = requireCanonicalLayerId(input.layer_id, `ingest source=${input.source_id || 'mixed'}`);
        const executionPlan = input.source_id ? requireSourceExecutionPlan(input.source_id) : null;
        if (executionPlan && executionPlan.binding.layerId !== layerId) {
            throw new Error(
                `[source-persistence] source_id=${input.source_id} is bound to layer_id=${executionPlan.binding.layerId}, got ${layerId}`,
            );
        }
        const trackedInput: IngestRunInput = {
            ...input,
            layer_id: layerId,
            metadata: {
                ...(executionPlan
                    ? {
                        sourceExecution: {
                            transformerId: executionPlan.binding.transformerId,
                            writerId: executionPlan.binding.writerId,
                            storagePolicyId: executionPlan.binding.storagePolicyId,
                            canonicalTarget: executionPlan.binding.canonicalTarget,
                        },
                    }
                    : {}),
                ...(input.metadata || {}),
            },
        };
        // beginIngestRun runs OUTSIDE the transaction so even a rolled-back
        // canonical pass leaves a visible run record. Otherwise a failed ingest
        // would disappear entirely and the operator would have no trail.
        const ingestRunId = await this.beginIngestRun(trackedInput);
        const totalStart = performance.now();
        let rawPersistStats: RawPayloadPersistStats = {
            count: trackedInput.raw_payloads?.length || 0,
            bytes: 0,
            storedCount: 0,
            duplicateCount: 0,
            hashes: [],
        };
        let rawPersistMs = 0;
        let canonicalWriteMs = 0;

        try {
            // Wrap raw-payload persistence + the actual multi-table canonical
            // operation (entities, snapshots, aliases, live_state, position_fixes,
            // events, assets) in a single transaction. Partial failures no
            // longer leave canonical head rows without their corresponding
            // snapshot history. Scar-tissue dedup reads (loadLatestAssetHashes,
            // loadLatestOrbitalHashes) still execute inside the same txn so
            // their REPEATABLE-READ-adjacent guarantees survive.
            const result = await this.database.withTransaction(async () => {
                const rawStart = performance.now();
                rawPersistStats = await this.persistRawPayloads(ingestRunId, trackedInput.layer_id, trackedInput.raw_payloads || []);
                rawPersistMs = roundMs(performance.now() - rawStart);

                const canonicalStart = performance.now();
                const value = await operation(ingestRunId);
                canonicalWriteMs = roundMs(performance.now() - canonicalStart);
                return value;
            });
            const totalMs = roundMs(performance.now() - totalStart);
            await this.completeIngestRun(ingestRunId, 'completed', input.record_count, {
                sourceMetrics: buildSourceMetrics(trackedInput, rawPersistStats, rawPersistMs, canonicalWriteMs, totalMs, 'completed'),
                rawPayloadCount: rawPersistStats.count,
                rawPayloadBytes: rawPersistStats.bytes,
                rawPayloadStoredCount: rawPersistStats.storedCount,
                rawPayloadDuplicateCount: rawPersistStats.duplicateCount,
                rawPayloadHashes: rawPersistStats.hashes.slice(0, 16),
                timingsMs: {
                    rawPersist: rawPersistMs,
                    canonicalWrite: canonicalWriteMs,
                    total: totalMs,
                },
            });
            return result;
        } catch (error: any) {
            // completeIngestRun runs outside the transaction (which already
            // rolled back) so the failed marker is recorded.
            await this.completeIngestRun(
                ingestRunId,
                'failed',
                input.record_count,
                {
                    sourceMetrics: buildSourceMetrics(trackedInput, rawPersistStats, rawPersistMs, canonicalWriteMs, roundMs(performance.now() - totalStart), 'failed'),
                    rawPayloadCount: rawPersistStats.count,
                    rawPayloadBytes: rawPersistStats.bytes,
                    rawPayloadStoredCount: rawPersistStats.storedCount,
                    rawPayloadDuplicateCount: rawPersistStats.duplicateCount,
                    rawPayloadHashes: rawPersistStats.hashes.slice(0, 16),
                    timingsMs: {
                        rawPersist: rawPersistMs,
                        canonicalWrite: canonicalWriteMs,
                        total: roundMs(performance.now() - totalStart),
                    },
                },
                error?.message || String(error),
            );
            throw error;
        }
    }

    private async persistAssetBatch(rows: AssetUpsertRow[], ingestRunId: string | null = null): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;
        validateLayerRows(rows, 'asset batch', (row) => row.asset_id);

        const rowsWithRenderPolicy = rows.map((row) => ({
            ...row,
            render_tolerance: getLayerRenderContract(row.layer_id).simplifyTolerance ?? null,
        }));
        const latestAssetHashes = await this.loadLatestAssetHashes(rows.map((row) => row.asset_id));

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
	                        properties jsonb,
	                        render_tolerance double precision
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
                        properties,
                        render_tolerance
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
	                    geom_render_low,
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
	                    CASE
	                        WHEN geometry_json IS NULL THEN NULL
		                        WHEN render_tolerance IS NOT NULL THEN ST_SimplifyPreserveTopology(ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326), render_tolerance)
		                        ELSE ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326)
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
	                    geom_render_low = CASE
	                        WHEN EXCLUDED.last_observed_at IS NULL THEN core.assets.geom_render_low
	                        WHEN core.assets.last_observed_at IS NULL OR EXCLUDED.last_observed_at >= core.assets.last_observed_at THEN EXCLUDED.geom_render_low
	                        ELSE core.assets.geom_render_low
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
	            [JSON.stringify(rowsWithRenderPolicy), ingestRunId],
        );

        const snapshotRows = rows.filter((row) => {
            const stateHash = typeof row.properties?._state_hash === 'string'
                ? row.properties._state_hash as string
                : '';
            if (!stateHash) return true;
            return latestAssetHashes.get(row.asset_id) !== stateHash;
        });

        if (snapshotRows.length === 0) return;

        const snapshotRowsWithFallback = snapshotRows.map((row) => ({
            ...row,
            observed_at: row.observed_at || new Date().toISOString(),
            render_tolerance: getLayerRenderContract(row.layer_id).simplifyTolerance ?? null,
        }));

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
	                        properties jsonb,
	                        render_tolerance double precision
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
	                    geom_render_low,
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
	                    CASE
	                        WHEN geometry_json IS NULL THEN NULL
		                        WHEN render_tolerance IS NOT NULL THEN ST_SimplifyPreserveTopology(ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326), render_tolerance)
		                        ELSE ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326)
	                    END,
	                    properties,
                    now()
                FROM incoming
                ON CONFLICT (asset_snapshot_id, observed_at)
                DO NOTHING
            `,
            [JSON.stringify(snapshotRowsWithFallback), ingestRunId],
        );
    }

    private async upsertEntities(rows: EntityUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;
        validateLayerRows(rows, 'entity batch', (row) => row.entity_id);

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
                        latest_snapshot_id text,
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
                    latest_snapshot_id,
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
                    latest_snapshot_id,
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
                    latest_snapshot_id = EXCLUDED.latest_snapshot_id,
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
                WHERE core.entity_aliases.entity_id IS DISTINCT FROM EXCLUDED.entity_id
            `,
            [JSON.stringify([...deduped.values()])],
        );
    }

    private async loadLatestEntityHashes(entityIds: string[]): Promise<Map<string, string>> {
        const uniqueEntityIds = [...new Set(entityIds)];
        const hashes = new Map<string, string>();
        if (!this.database.isReady() || uniqueEntityIds.length === 0) return hashes;

        const result = await this.database.query<{ entity_id: string; state_hash: string | null }>(
            `
                SELECT
                    entity_id,
                    properties->>'_state_hash' AS state_hash
                FROM core.entities
                WHERE entity_id = ANY($1::text[])
            `,
            [uniqueEntityIds],
        );

        for (const row of result?.rows || []) {
            if (row.state_hash) hashes.set(row.entity_id, row.state_hash);
        }

        const missingEntityIds = uniqueEntityIds.filter((entityId) => !hashes.has(entityId));
        if (missingEntityIds.length > 0) {
            const fallback = await this.database.query<{ entity_id: string; state_hash: string | null }>(
                `
                    SELECT DISTINCT ON (entity_id)
                        entity_id,
                        properties->>'_state_hash' AS state_hash
                    FROM core.position_fixes
                    WHERE entity_id = ANY($1::text[])
                    ORDER BY entity_id, observed_at DESC, created_at DESC
                `,
                [missingEntityIds],
            );
            for (const row of fallback?.rows || []) {
                if (row.state_hash) hashes.set(row.entity_id, row.state_hash);
            }
        }

        return hashes;
    }

    private async loadLatestPositionHashes(entityIds: string[]): Promise<Map<string, string>> {
        const uniqueEntityIds = [...new Set(entityIds)];
        const hashes = new Map<string, string>();
        if (!this.database.isReady() || uniqueEntityIds.length === 0) return hashes;

        const result = await this.database.query<{ entity_id: string; state_hash: string | null }>(
            `
                SELECT
                    entity_id,
                    properties->>'_state_hash' AS state_hash
                FROM app.entity_live_states
                WHERE entity_id = ANY($1::text[])
            `,
            [uniqueEntityIds],
        );

        for (const row of result?.rows || []) {
            hashes.set(row.entity_id, row.state_hash || '');
        }

        return hashes;
    }

    private async loadLatestAssetHashes(assetIds: string[]): Promise<Map<string, string>> {
        const uniqueAssetIds = [...new Set(assetIds)];
        const hashes = new Map<string, string>();
        if (!this.database.isReady() || uniqueAssetIds.length === 0) return hashes;

        // Read from asset_snapshots so a partial failure (base upsert ok,
        // snapshot insert failing) doesn't cause the next retry to skip the
        // missing snapshot.
        const result = await this.database.query<{ asset_id: string; state_hash: string | null }>(
            `
                SELECT DISTINCT ON (asset_id)
                    asset_id,
                    properties->>'_state_hash' AS state_hash
                FROM core.asset_snapshots
                WHERE asset_id = ANY($1::text[])
                ORDER BY asset_id, observed_at DESC, created_at DESC
            `,
            [uniqueAssetIds],
        );

        for (const row of result?.rows || []) {
            hashes.set(row.asset_id, row.state_hash || '');
        }

        return hashes;
    }

    private async loadLatestOrbitalHashes(entityIds: string[]): Promise<Map<string, string>> {
        const uniqueEntityIds = [...new Set(entityIds)];
        const hashes = new Map<string, string>();
        if (!this.database.isReady() || uniqueEntityIds.length === 0) return hashes;

        const result = await this.database.query<{ entity_id: string; state_hash: string | null }>(
            `
                SELECT DISTINCT ON (entity_id)
                    entity_id,
                    COALESCE(state_hash, properties->>'_state_hash') AS state_hash
                FROM core.orbital_elements
                WHERE entity_id = ANY($1::text[])
                ORDER BY entity_id, COALESCE(tle_epoch_at, observed_at) DESC, COALESCE(fetched_at, observed_at) DESC, created_at DESC
            `,
            [uniqueEntityIds],
        );

        for (const row of result?.rows || []) {
            hashes.set(row.entity_id, row.state_hash || '');
        }

        return hashes;
    }

    private async insertEntitySnapshots(rows: EntitySnapshotUpsertRow[], ingestRunId: string | null = null): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;
        validateLayerRows(rows, 'entity snapshot batch', (row) => row.entity_snapshot_id);

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT rowset.*, $2::text AS ingest_run_id
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        entity_snapshot_id text,
                        entity_id text,
                        layer_id text,
                        source_id text,
                        entity_kind text,
                        subtype text,
                        display_name text,
                        observed_at timestamptz,
                        properties jsonb
                    )
                )
                INSERT INTO core.entity_snapshots (
                    entity_snapshot_id,
                    entity_id,
                    ingest_run_id,
                    layer_id,
                    source_id,
                    entity_kind,
                    subtype,
                    display_name,
                    observed_at,
                    properties,
                    created_at
                )
                SELECT
                    entity_snapshot_id,
                    entity_id,
                    ingest_run_id,
                    layer_id,
                    source_id,
                    entity_kind,
                    subtype,
                    display_name,
                    observed_at,
                    properties,
                    now()
                FROM incoming
                ON CONFLICT (entity_snapshot_id, observed_at)
                DO NOTHING
            `,
            [JSON.stringify(rows), ingestRunId],
        );
    }

    private async insertPositionFixes(rows: PositionFixUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;
        validateLayerRows(rows, 'position fix batch', (row) => row.position_fix_id);

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
                ON CONFLICT (position_fix_id, observed_at)
                DO NOTHING
            `,
            [JSON.stringify(rows)],
        );
    }

    private async upsertEntityLiveStates(rows: PositionFixUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;
        validateLayerRows(rows, 'entity live state batch', (row) => row.position_fix_id);

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
                WHERE app.entity_live_states.observed_at <= EXCLUDED.observed_at
            `,
            [JSON.stringify(rows)],
        );
    }

    private async insertOrbitalElements(rows: OrbitalElementUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;
        validateLayerRows(rows, 'orbital element batch', (row) => row.orbital_element_id);

        const latestOrbitalHashes = await this.loadLatestOrbitalHashes(rows.map((row) => row.entity_id));

        const filtered = rows.filter((row) => {
            const stateHash = typeof row.properties?._state_hash === 'string'
                ? row.properties._state_hash as string
                : '';
            if (!stateHash) return true;
            return latestOrbitalHashes.get(row.entity_id) !== stateHash;
        });

        if (filtered.length === 0) return;

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT *
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        orbital_element_id text,
                        entity_id text,
                        layer_id text,
                        source_id text,
                        observed_at timestamptz,
                        tle_epoch_at timestamptz,
                        fetched_at timestamptz,
                        provider text,
                        source_publication_at timestamptz,
                        norad_id text,
                        tle_line1 text,
                        tle_line2 text,
                        state_hash text,
                        properties jsonb
                    )
                ),
                hashed_incoming AS (
                    SELECT *
                    FROM incoming
                    WHERE state_hash IS NOT NULL
                      AND state_hash <> ''
                ),
                unhashed_incoming AS (
                    SELECT *
                    FROM incoming
                    WHERE state_hash IS NULL
                       OR state_hash = ''
                ),
                deduped_hashes AS (
                    SELECT DISTINCT ON (entity_id, state_hash)
                        *
                    FROM hashed_incoming
                    ORDER BY entity_id, state_hash, COALESCE(tle_epoch_at, observed_at) DESC, COALESCE(fetched_at, observed_at) DESC
                ),
                deduped_unhashed AS (
                    SELECT DISTINCT ON (entity_id, orbital_element_id)
                        *
                    FROM unhashed_incoming
                    ORDER BY entity_id, orbital_element_id, COALESCE(tle_epoch_at, observed_at) DESC, COALESCE(fetched_at, observed_at) DESC
                ),
                inserted_hashes AS (
                    INSERT INTO core.orbital_element_state_hashes (
                        entity_id,
                        state_hash,
                        first_observed_at,
                        first_orbital_element_id
                    )
                    SELECT
                        entity_id,
                        state_hash,
                        COALESCE(tle_epoch_at, observed_at),
                        orbital_element_id
                    FROM deduped_hashes
                    ON CONFLICT (entity_id, state_hash) DO NOTHING
                    RETURNING entity_id, state_hash
                ),
                to_insert AS (
                    SELECT d.*
                    FROM deduped_hashes d
                    JOIN inserted_hashes ih
                      ON ih.entity_id = d.entity_id
                     AND ih.state_hash = d.state_hash
                    UNION ALL
                    SELECT *
                    FROM deduped_unhashed
                )
                INSERT INTO core.orbital_elements (
                    orbital_element_id,
                    entity_id,
                    layer_id,
                    source_id,
                    observed_at,
                    tle_epoch_at,
                    fetched_at,
                    provider,
                    source_publication_at,
                    norad_id,
                    tle_line1,
                    tle_line2,
                    state_hash,
                    properties,
                    created_at
                )
                SELECT
                    orbital_element_id,
                    entity_id,
                    layer_id,
                    source_id,
                    observed_at,
                    tle_epoch_at,
                    fetched_at,
                    provider,
                    source_publication_at,
                    norad_id,
                    tle_line1,
                    tle_line2,
                    state_hash,
                    properties,
                    now()
                FROM to_insert
                ON CONFLICT (orbital_element_id, observed_at)
                DO NOTHING
            `,
            [JSON.stringify(filtered)],
        );
    }

    private async persistEventBatch(rows: EventUpsertRow[], ingestRunId: string | null = null): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;
        validateLayerRows(rows, 'event batch', (row) => row.event_id);

        const effectiveRows: Array<EventUpsertRow & { render_tolerance: number | null }> = [];
        for (const row of rows) {
            const effective = row.observed_at || row.valid_from || null;
            if (!effective) {
                console.warn('[source-persistence] dropping event without observable time', {
                    event_id: row.event_id,
                    source_id: row.source_id,
                    layer_id: row.layer_id,
                });
                continue;
            }
            const renderContract = getLayerRenderContract(row.layer_id);
            effectiveRows.push({
                ...row,
                observed_at: effective,
                render_tolerance: renderContract.simplifiedRenderGeometry
                    ? (renderContract.simplifyTolerance ?? null)
                    : null,
            });
        }

        if (effectiveRows.length === 0) return;

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
                        render_tolerance double precision,
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
                        render_tolerance,
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
                        geom_render_low,
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
                        CASE
                            WHEN geometry_json IS NULL THEN NULL
                            WHEN render_tolerance IS NOT NULL THEN ST_SimplifyPreserveTopology(ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326), render_tolerance)
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
                        geom_render_low = CASE
                            WHEN EXCLUDED.observed_at IS NULL THEN core.events.geom_render_low
                            WHEN core.events.observed_at IS NULL OR EXCLUDED.observed_at >= core.events.observed_at THEN EXCLUDED.geom_render_low
                            ELSE core.events.geom_render_low
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
                    geom_render_low,
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
                    CASE
                        WHEN geometry_json IS NULL THEN NULL
                        WHEN render_tolerance IS NOT NULL THEN ST_SimplifyPreserveTopology(ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(geometry_json::text)), 4326), render_tolerance)
                        ELSE NULL
                    END,
                    properties,
                    now()
                FROM incoming
                ON CONFLICT (event_snapshot_id, observed_at)
                DO NOTHING
            `,
            [JSON.stringify(effectiveRows), ingestRunId],
        );
    }

    private async expireAcledEventBatch(rows: AcledDeletedEvent[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;

        const binding = requireSourceBinding('acled');
        const normalizedRows = rows
            .filter((row) => row.id && row.deletedAt && Number.isFinite(row.deletedTimestamp))
            .map((row) => {
                const strippedId = row.id.replace(/^acled-/, '');
                return {
                    event_id: `conflict:acled:${row.id}`,
                    acled_id: strippedId,
                    deleted_at: row.deletedAt,
                    deleted_timestamp: row.deletedTimestamp,
                    reason: row.reason,
                };
            });
        if (normalizedRows.length === 0) return;

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT *
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        event_id text,
                        acled_id text,
                        deleted_at timestamptz,
                        deleted_timestamp double precision,
                        reason text
                    )
                ),
                updated_snapshots AS (
                    UPDATE core.event_snapshots s
                    SET
                        valid_to = incoming.deleted_at,
                        properties = COALESCE(s.properties, '{}'::jsonb) || jsonb_build_object(
                            'acledDeleted', true,
                            'acledDeletedAt', incoming.deleted_at,
                            'acledDeletedTimestamp', incoming.deleted_timestamp,
                            'acledDeletionReason', incoming.reason
                        )
                    FROM incoming
                    WHERE s.layer_id = $2
                      AND s.source_id = $3
                      AND (
                          s.event_id = incoming.event_id
                          OR s.properties ->> 'acledEventIdCnty' = incoming.acled_id
                          OR s.properties ->> 'acledDataId' = incoming.acled_id
                      )
                      AND COALESCE(s.observed_at, s.valid_from, s.created_at) <= incoming.deleted_at
                      AND (s.valid_to IS NULL OR s.valid_to > incoming.deleted_at)
                    RETURNING s.event_id
                )
                UPDATE core.events e
                SET
                    valid_to = incoming.deleted_at,
                    properties = COALESCE(e.properties, '{}'::jsonb) || jsonb_build_object(
                        'acledDeleted', true,
                        'acledDeletedAt', incoming.deleted_at,
                        'acledDeletedTimestamp', incoming.deleted_timestamp,
                        'acledDeletionReason', incoming.reason
                    ),
                    updated_at = now()
                FROM incoming
                WHERE e.layer_id = $2
                  AND e.source_id = $3
                  AND (
                      e.event_id = incoming.event_id
                      OR e.properties ->> 'acledEventIdCnty' = incoming.acled_id
                      OR e.properties ->> 'acledDataId' = incoming.acled_id
                  )
                  AND (e.valid_to IS NULL OR e.valid_to > incoming.deleted_at)
            `,
            [JSON.stringify(normalizedRows), binding.layerId, binding.sourceId],
        );
    }

    private async executeEventSnapshotWriter(sourceId: string, rows: EventUpsertRow[], ingestRunId: string | null): Promise<void> {
        const plan = requireSourceExecutionPlan(sourceId);
        if (plan.writer.writerId !== 'event-snapshot') {
            throw new Error(`Source writer mismatch for source_id=${sourceId}: expected event-snapshot, got ${plan.writer.writerId}`);
        }
        await this.persistEventBatch(rows, ingestRunId);
    }

    private async executeAssetSnapshotWriter(sourceId: string, rows: AssetUpsertRow[], ingestRunId: string | null): Promise<void> {
        const plan = requireSourceExecutionPlan(sourceId);
        if (plan.writer.writerId !== 'asset-snapshot') {
            throw new Error(`Source writer mismatch for source_id=${sourceId}: expected asset-snapshot, got ${plan.writer.writerId}`);
        }
        await this.persistAssetBatch(rows, ingestRunId);
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

    // Serialize aircraft persistence so concurrent writers (opensky + adsb_mil)
    // upserting overlapping entity rows do not deadlock on core.entities. The
    // chain swallows errors so one failed batch does not block the next.
    private aircraftPersistQueue: Promise<void> = Promise.resolve();

    async persistAircraftPositions(records: AircraftPositionRecord[], sourceBindingId: string = 'opensky'): Promise<void> {
        const run = this.aircraftPersistQueue.then(() => this.persistAircraftPositionsImpl(records, sourceBindingId));
        this.aircraftPersistQueue = run.catch(() => undefined);
        return run;
    }

    private async persistAircraftPositionsImpl(records: AircraftPositionRecord[], sourceBindingId: string = 'opensky'): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = requireSourceBinding(sourceBindingId);
        const entities: EntityUpsertRow[] = [];
        const entitySnapshotsSeed: Array<EntitySnapshotUpsertRow & { state_hash: string }> = [];
        const aliases: EntityAliasUpsertRow[] = [];
        const fixesSeed: Array<PositionFixUpsertRow & { state_hash: string }> = [];

        for (const record of records) {
            if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng) || !record.icao24) continue;

            const entityId = `aircraft:${record.icao24.toLowerCase()}`;
            const observedAt = record.lastContact
                ? new Date(record.lastContact * 1000).toISOString()
                : new Date().toISOString();
            const entityStateHash = stableHash({
                icao24: record.icao24,
                callsign: record.callsign || null,
                origin: record.origin || null,
                type: record.type,
                squawk: record.squawk || null,
            });
            const positionStateHash = stableHash({
                lat: Number(record.lat.toFixed(5)),
                lng: Number(record.lng.toFixed(5)),
                altMeters: record.altMeters ?? null,
                heading: record.heading ?? 0,
                speedMps: record.speedMps ?? null,
                onGround: record.onGround ?? false,
                verticalRate: record.verticalRate ?? null,
            });

            entities.push({
                entity_id: entityId,
                latest_snapshot_id: `entity-snap:${entityId}:${entityStateHash}`,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                entity_kind: binding.recordKind,
                subtype: record.type || null,
                display_name: escapeIdentifier(record.callsign || record.icao24),
                first_observed_at: observedAt,
                last_observed_at: observedAt,
                properties: {
                    icao24: record.icao24,
                    callsign: record.callsign,
                    origin: record.origin || null,
                    onGround: record.onGround ?? false,
                    squawk: record.squawk || null,
                    _state_hash: entityStateHash,
                },
            });

            entitySnapshotsSeed.push({
                entity_snapshot_id: `entity-snap:${entityId}:${entityStateHash}`,
                entity_id: entityId,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                entity_kind: binding.recordKind,
                subtype: record.type || null,
                display_name: escapeIdentifier(record.callsign || record.icao24),
                observed_at: observedAt,
                properties: {
                    icao24: record.icao24,
                    callsign: record.callsign,
                    origin: record.origin || null,
                    onGround: record.onGround ?? false,
                    squawk: record.squawk || null,
                    _state_hash: entityStateHash,
                },
                state_hash: entityStateHash,
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
                position_fix_id: `fix:${entityId}:${observedAt}:${positionStateHash}`,
                entity_id: entityId,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
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
                    _state_hash: positionStateHash,
                },
                state_hash: positionStateHash,
            });
        }

        const [latestEntityHashes, latestPositionHashes] = await Promise.all([
            this.loadLatestEntityHashes(entitySnapshotsSeed.map((row) => row.entity_id)),
            this.loadLatestPositionHashes(fixesSeed.map((row) => row.entity_id)),
        ]);
        const entitySnapshots = entitySnapshotsSeed
            .filter((row) => latestEntityHashes.get(row.entity_id) !== row.state_hash)
            .map(({ state_hash: _stateHash, ...row }) => row);
        const liveRows = fixesSeed.map(({ state_hash: _stateHash, ...row }) => row);
        const fixes = fixesSeed
            .filter((row) => latestPositionHashes.get(row.entity_id) !== row.state_hash)
            .map(({ state_hash: _stateHash, ...row }) => row);

        await this.runTrackedIngest(
            {
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: records.length,
                metadata: {
                    canonicalTarget: 'entities',
                    changedEntityCount: entitySnapshots.length,
                    changedFixCount: fixes.length,
                    entityCount: entities.length,
                },
            },
            async () => {
                await this.upsertEntities(entities);
                await this.upsertEntityAliases(aliases);
                await this.insertEntitySnapshots(entitySnapshots);
                await this.upsertEntityLiveStates(liveRows);
                await this.insertPositionFixes(fixes);
            },
        );
    }

    queueVesselPosition(record: VesselPositionRecord): void {
        const normalized = normalizeVesselWalRecord(record);
        if (!normalized) return;
        this.appendVesselPositionWal(normalized);
        this.vesselPositionBuffer.set(normalized.id, normalized);
        if (!this.database.isReady()) return;
        if (this.vesselFlushTimer) return;

        this.vesselFlushTimer = setTimeout(() => {
            this.vesselFlushTimer = null;
            void this.flushPendingVesselPositions();
        }, this.vesselDbFlushDelayMs);
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
                try {
                    await this.persistVesselPositions(pending);
                    this.rewriteVesselPositionWalFromBuffer();
                } catch (error) {
                    for (const record of pending) {
                        if (!this.vesselPositionBuffer.has(record.id)) {
                            this.vesselPositionBuffer.set(record.id, record);
                        }
                    }
                    try {
                        this.rewriteVesselPositionWalFromBuffer();
                    } catch {
                        // Keep the original DB/write error as the reason the flush failed.
                    }
                    throw error;
                }
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

        const binding = requireSourceBinding('aisstream');
        const entities: EntityUpsertRow[] = [];
        const entitySnapshotsSeed: Array<EntitySnapshotUpsertRow & { state_hash: string }> = [];
        const aliases: EntityAliasUpsertRow[] = [];
        const fixesSeed: Array<PositionFixUpsertRow & { state_hash: string }> = [];

        for (const record of records) {
            if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng) || !record.id) continue;

            const entityId = `vessel:${record.id}`;
            const observedAt = record.observedAt;
            const entityStateHash = stableHash({
                type: record.type,
                navigationStatus: record.navigationStatus || null,
                name: record.name || null,
                callSign: record.callSign || null,
                imo: record.imo || null,
                destination: record.destination || null,
                eta: record.eta || null,
                draught: record.draught ?? null,
                length: record.length ?? null,
                beam: record.beam ?? null,
            });
            const positionStateHash = stableHash({
                lat: Number(record.lat.toFixed(5)),
                lng: Number(record.lng.toFixed(5)),
                heading: record.heading ?? 0,
                speedKnots: record.speedKnots ?? null,
                rateOfTurn: record.rateOfTurn ?? null,
                cog: record.cog ?? null,
            });

            entities.push({
                entity_id: entityId,
                latest_snapshot_id: `entity-snap:${entityId}:${entityStateHash}`,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                entity_kind: binding.recordKind,
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
                    _state_hash: entityStateHash,
                },
            });

            entitySnapshotsSeed.push({
                entity_snapshot_id: `entity-snap:${entityId}:${entityStateHash}`,
                entity_id: entityId,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                entity_kind: binding.recordKind,
                subtype: record.type || null,
                display_name: escapeIdentifier(record.name || record.callSign || record.id),
                observed_at: observedAt,
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
                    _state_hash: entityStateHash,
                },
                state_hash: entityStateHash,
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
                position_fix_id: `fix:${entityId}:${observedAt}:${positionStateHash}`,
                entity_id: entityId,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
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
                    _state_hash: positionStateHash,
                },
                state_hash: positionStateHash,
            });
        }

        const [latestEntityHashes, latestPositionHashes] = await Promise.all([
            this.loadLatestEntityHashes(entitySnapshotsSeed.map((row) => row.entity_id)),
            this.loadLatestPositionHashes(fixesSeed.map((row) => row.entity_id)),
        ]);
        const entitySnapshots = entitySnapshotsSeed
            .filter((row) => latestEntityHashes.get(row.entity_id) !== row.state_hash)
            .map(({ state_hash: _stateHash, ...row }) => row);
        const liveRows = fixesSeed.map(({ state_hash: _stateHash, ...row }) => row);
        const fixes = fixesSeed
            .filter((row) => latestPositionHashes.get(row.entity_id) !== row.state_hash)
            .map(({ state_hash: _stateHash, ...row }) => row);

        await this.runTrackedIngest(
            {
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: records.length,
                metadata: {
                    canonicalTarget: 'entities',
                    changedEntityCount: entitySnapshots.length,
                    changedFixCount: fixes.length,
                    entityCount: entities.length,
                },
            },
            async () => {
                await this.upsertEntities(entities);
                await this.upsertEntityAliases(aliases);
                await this.insertEntitySnapshots(entitySnapshots);
                await this.upsertEntityLiveStates(liveRows);
                await this.insertPositionFixes(fixes);
            },
        );
    }

    async persistCables(cables: CableGeoJSON | null): Promise<void> {
        if (!this.database.isReady() || !cables?.features?.length) return;

        const binding = requireSourceBinding('telegeography');
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
                    layer_id: binding.layerId,
                    source_id: binding.sourceId,
                    asset_kind: binding.recordKind,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length,
                metadata: {
                    canonicalTarget: binding.canonicalTarget,
                    rawCaptureMode: binding.rawCaptureMode,
                },
                raw_payloads: binding.rawCaptureMode === 'snapshot'
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
                await this.executeAssetSnapshotWriter(binding.sourceId, rows, ingestRunId);
            },
        );
    }

    async persistOutages(records: OutageRecord[], options?: { sourceId?: string | null; rawPayload?: unknown }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const sourceId = options?.sourceId || 'ioda';
        const binding = requireSourceBinding(sourceId);
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
                    layer_id: binding.layerId,
                    source_id: binding.sourceId,
                    event_kind: binding.recordKind,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length,
                metadata: { canonicalTarget: binding.canonicalTarget },
                raw_payloads: options?.rawPayload
                    ? [{
                        source_id: binding.sourceId,
                        payload: options.rawPayload,
                        metadata: { format: 'json', payloadKind: 'upstream_response' },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.executeEventSnapshotWriter(binding.sourceId, rows, ingestRunId);
            },
        );
    }

    async persistCloudflareOutages(records: CloudflareOutage[], options?: RawBackedIngestOptions): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = requireSourceBinding('cloudflare_radar');
        const expandedRecords = records.flatMap((record) => this.expandCloudflareOutageLocations(record));
        const rows: EventUpsertRow[] = expandedRecords.map((record) => {
            const eventId = `outage:cloudflare:${record.id}`;
            const renderProperties = {
                scope: record.scope,
                asn: record.asn,
                locationCode: record.locationCode || null,
                locationName: record.locationName || null,
                locationIndex: record.locationIndex ?? null,
                locationCount: record.locationCount ?? null,
                datasource: 'cloudflare_radar',
                source: 'Cloudflare',
                endDate: record.endDate || null,
            };
            const properties = {
                ...renderProperties,
                asnName: record.asnName,
                locations: record.locations,
                locationNames: record.locationNames || [],
                outageType: record.outageType,
                outageCause: record.outageCause,
                url: record.url || null,
                description: record.description || null,
            };
            const stateHash = stableHash({
                startDate: record.startDate,
                ...properties,
            });
            return {
                event_id: eventId,
                event_snapshot_id: `event-snap:${eventId}:${stateHash}`,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                event_kind: binding.recordKind,
                subtype: record.outageType || 'outage',
                observed_at: record.startDate || null,
                valid_to: record.endDate || null,
                lat: record.lat ?? null,
                lng: record.lng ?? null,
                properties: {
                    ...properties,
                    _state_hash: stateHash,
                },
            };
        });

        await this.runTrackedIngest(
            {
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length,
                metadata: {
                    canonicalTarget: binding.canonicalTarget,
                    cloudflareAnnotationCount: records.length,
                    cloudflareLocationRenderCount: rows.length,
                    ...(options?.metadata || {}),
                },
                raw_payloads: options?.rawPayload
                    ? [{
                        source_id: binding.sourceId,
                        payload: options.rawPayload,
                        metadata: {
                            format: 'json',
                            payloadKind: 'upstream_response',
                            ...(options.rawPayloadMetadata || {}),
                        },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.executeEventSnapshotWriter(binding.sourceId, rows, ingestRunId);
            },
        );
    }

    private expandCloudflareOutageLocations(record: CloudflareOutage): CloudflareOutage[] {
        const locations = (record.locations || []).map((location) => String(location || '').trim().toUpperCase()).filter(Boolean);
        const names = record.locationNames || [];
        if (locations.length === 0) {
            if (Number.isFinite(record.lat) && Number.isFinite(record.lng)) {
                return [{
                    ...record,
                    locationCode: record.locationCode || null,
                    locationName: record.locationName || null,
                    locationIndex: 0,
                    locationCount: 1,
                }];
            }
            return [];
        }

        const expanded: CloudflareOutage[] = [];
        locations.forEach((locationCode, index) => {
            const centroid = COUNTRY_CENTROIDS[locationCode];
            if (!centroid) {
                console.warn('[source-persistence] Cloudflare outage location has no centroid', {
                    id: record.id,
                    locationCode,
                });
                return;
            }
            expanded.push({
                ...record,
                id: `${record.id}:loc:${locationCode}`,
                lat: centroid[0],
                lng: centroid[1],
                locationCode,
                locationName: names[index] || locationCode,
                locationIndex: index,
                locationCount: locations.length,
            });
        });
        return expanded;
    }

    async persistAcledConflicts(records: ConflictEvent[], options?: RawBackedIngestOptions): Promise<void> {
        if (!this.database.isReady()) return;

        const binding = requireSourceBinding('acled');
        const deletedRecords = options?.deletedRecords || [];
        const rows: EventUpsertRow[] = records
            .filter((record) => Number.isFinite(record.lat) && Number.isFinite(record.lng))
            .map((record) => {
                const eventId = `conflict:acled:${record.id}`;
                const acledTimestamp = Number.isFinite(record.timestamp || NaN) ? Number(record.timestamp) : null;
                const properties = {
                    country: record.country,
                    actor1: record.actor1,
                    actor2: record.actor2,
                    fatalities: record.fatalities,
                    notes: record.notes,
                    acledTimestamp,
                    acledEventIdCnty: record.event_id_cnty || null,
                    acledDataId: record.data_id || null,
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
                    layer_id: binding.layerId,
                    source_id: binding.sourceId,
                    event_kind: binding.recordKind,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length + deletedRecords.length,
                metadata: {
                    canonicalTarget: binding.canonicalTarget,
                    ...(options?.metadata || {}),
                },
                raw_payloads: options?.rawPayload
                    ? [{
                        source_id: binding.sourceId,
                        payload: options.rawPayload,
                        metadata: {
                            format: 'json',
                            payloadKind: 'upstream_response',
                            ...(options.rawPayloadMetadata || {}),
                        },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.executeEventSnapshotWriter(binding.sourceId, rows, ingestRunId);
                await this.expireAcledEventBatch(deletedRecords);
            },
        );
    }

    async persistGdeltConflicts(records: GdeltConflictEvent[]): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = requireSourceBinding('gdelt');
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
                    layer_id: binding.layerId,
                    source_id: binding.sourceId,
                    event_kind: binding.recordKind,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length,
                metadata: { canonicalTarget: binding.canonicalTarget },
            },
            async (ingestRunId) => {
                await this.executeEventSnapshotWriter(binding.sourceId, rows, ingestRunId);
            },
        );
    }

    async persistCirConflicts(records: CirConflictEvent[]): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = requireSourceBinding('eyes_on_russia');
        const rows: EventUpsertRow[] = records
            .filter((record) => Number.isFinite(record.lat) && Number.isFinite(record.lng))
            .map((record) => {
                const eventId = `conflict:cir:${record.id}`;
                const properties = {
                    category: record.category,
                    secondaryCategory: record.secondaryCategory,
                    description: record.description,
                    sourceUrl: record.sourceUrl,
                    town: record.town,
                    province: record.province,
                    country: record.country,
                    graphicLevel: record.graphicLevel,
                    credit: 'CIR / Eyes on Russia',
                };
                const stateHash = stableHash({
                    lat: Number(record.lat.toFixed(4)),
                    lng: Number(record.lng.toFixed(4)),
                    observedAt: record.observedAt,
                    ...properties,
                });
                return {
                    event_id: eventId,
                    event_snapshot_id: `event-snap:${eventId}:${stateHash}`,
                    layer_id: binding.layerId,
                    source_id: binding.sourceId,
                    event_kind: binding.recordKind,
                    subtype: record.category,
                    observed_at: record.observedAt,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length,
                metadata: { canonicalTarget: binding.canonicalTarget },
            },
            async (ingestRunId) => {
                await this.executeEventSnapshotWriter(binding.sourceId, rows, ingestRunId);
            },
        );
    }

    async persistGfwEvents(records: GFWEvent[], options?: RawBackedIngestOptions): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = requireSourceBinding('gfw');
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
                    layer_id: binding.layerId,
                    source_id: binding.sourceId,
                    event_kind: binding.recordKind,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length,
                metadata: {
                    canonicalTarget: binding.canonicalTarget,
                    ...(options?.metadata || {}),
                },
                raw_payloads: options?.rawPayload
                    ? [{
                        source_id: binding.sourceId,
                        payload: options.rawPayload,
                        metadata: {
                            format: 'json',
                            payloadKind: 'upstream_response',
                            ...(options.rawPayloadMetadata || {}),
                        },
                    }]
                    : [],
            },
            async (ingestRunId) => {
                await this.executeEventSnapshotWriter(binding.sourceId, rows, ingestRunId);
            },
        );
    }

    async persistSatelliteCatalog(records: SatelliteRecord[], options?: {
        provider?: string | null;
        loadedFromCache?: boolean;
        fetchedAt?: string | null;
        sourcePublicationAt?: string | null;
    }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = requireSourceBinding('celestrak');
        const observedAt = options?.fetchedAt || new Date().toISOString();
        const provider = options?.provider || null;
        const sourcePublicationAt = options?.sourcePublicationAt || null;
        const entities: EntityUpsertRow[] = [];
        const entitySnapshotsSeed: Array<EntitySnapshotUpsertRow & { state_hash: string }> = [];
        const aliases: EntityAliasUpsertRow[] = [];
        const orbitalRows: OrbitalElementUpsertRow[] = [];

        for (const record of records) {
            if (!record.tleLine1 || !record.tleLine2) continue;
            const noradId = Number.isFinite(record.noradId) && record.noradId > 0 ? String(record.noradId) : null;
            const entityId = noradId
                ? `satellite:${noradId}`
                : `satellite:${stableHash({ name: record.name, tleLine1: record.tleLine1, tleLine2: record.tleLine2 })}`;
            const stateHash = tleStateHash(record.tleLine1, record.tleLine2);
            const tleEpochAt = record.tleEpochAt || null;

            entities.push({
                entity_id: entityId,
                latest_snapshot_id: `entity-snap:${entityId}:${stateHash}`,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                entity_kind: binding.recordKind,
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
                    provider,
                    loadedFromCache: options?.loadedFromCache || false,
                    fetchedAt: observedAt,
                    tleEpochAt,
                    sourcePublicationAt,
                },
            });

            entitySnapshotsSeed.push({
                entity_snapshot_id: `entity-snap:${entityId}:${stateHash}`,
                entity_id: entityId,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                entity_kind: binding.recordKind,
                subtype: record.type || null,
                display_name: escapeIdentifier(record.name || noradId || entityId),
                observed_at: observedAt,
                properties: {
                    noradId: record.noradId,
                    type: record.type,
                    classificationSource: record.classificationSource || 'derived_name_heuristic',
                    recon: record.recon || false,
                    reconMeta: record.reconMeta || null,
                    sensor: record.sensor || null,
                    provider,
                    loadedFromCache: options?.loadedFromCache || false,
                    fetchedAt: observedAt,
                    tleEpochAt,
                    sourcePublicationAt,
                },
                state_hash: stateHash,
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
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                observed_at: observedAt,
                tle_epoch_at: tleEpochAt,
                fetched_at: observedAt,
                provider,
                source_publication_at: sourcePublicationAt,
                norad_id: noradId,
                tle_line1: record.tleLine1,
                tle_line2: record.tleLine2,
                state_hash: stateHash,
                properties: {
                    name: record.name,
                    type: record.type,
                    classificationSource: record.classificationSource || 'derived_name_heuristic',
                    provider,
                    loadedFromCache: options?.loadedFromCache || false,
                    fetchedAt: observedAt,
                    tleEpochAt,
                    sourcePublicationAt,
                    recon: record.recon || false,
                    sensor: record.sensor || null,
                },
            });
        }

        const latestEntityHashes = await this.loadLatestEntityHashes(entitySnapshotsSeed.map((row) => row.entity_id));
        const entitySnapshots = entitySnapshotsSeed
            .filter((row) => latestEntityHashes.get(row.entity_id) !== row.state_hash)
            .map(({ state_hash: _stateHash, ...row }) => row);

        await this.runTrackedIngest(
            {
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: records.length,
                metadata: {
                    canonicalTarget: binding.canonicalTarget,
                    changedEntityCount: entitySnapshots.length,
                    provider,
                    loadedFromCache: options?.loadedFromCache || false,
                    fetchedAt: observedAt,
                    sourcePublicationAt,
                },
            },
            async () => {
                await this.upsertEntities(entities);
                await this.upsertEntityAliases(aliases);
                await this.insertEntitySnapshots(entitySnapshots);
                await this.insertOrbitalElements(orbitalRows);
            },
        );
    }

    private async upsertSatelliteHistoryEntities(rows: EntityUpsertRow[]): Promise<void> {
        if (!this.database.isReady() || rows.length === 0) return;
        validateLayerRows(rows, 'satellite history entity batch', (row) => row.entity_id);

        const deduped = new Map<string, EntityUpsertRow>();
        for (const row of rows) {
            const existing = deduped.get(row.entity_id);
            if (!existing) {
                deduped.set(row.entity_id, row);
                continue;
            }
            const existingFirst = existing.first_observed_at ? Date.parse(existing.first_observed_at) : Number.POSITIVE_INFINITY;
            const rowFirst = row.first_observed_at ? Date.parse(row.first_observed_at) : Number.POSITIVE_INFINITY;
            const existingLast = existing.last_observed_at ? Date.parse(existing.last_observed_at) : Number.NEGATIVE_INFINITY;
            const rowLast = row.last_observed_at ? Date.parse(row.last_observed_at) : Number.NEGATIVE_INFINITY;
            deduped.set(row.entity_id, {
                ...existing,
                first_observed_at: rowFirst < existingFirst ? row.first_observed_at : existing.first_observed_at,
                last_observed_at: rowLast > existingLast ? row.last_observed_at : existing.last_observed_at,
            });
        }

        await this.database.query(
            `
                WITH incoming AS (
                    SELECT *
                    FROM jsonb_to_recordset($1::jsonb) AS rowset(
                        entity_id text,
                        latest_snapshot_id text,
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
                    latest_snapshot_id,
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
                    latest_snapshot_id,
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
                    display_name = COALESCE(core.entities.display_name, EXCLUDED.display_name),
                    updated_at = now()
            `,
            [JSON.stringify([...deduped.values()])],
        );
    }

    async persistSatelliteOrbitalHistory(records: SatelliteRecord[], options?: {
        sourceId?: string | null;
        provider?: string | null;
        fetchedAt?: string | null;
        sourcePublicationAt?: string | null;
        query?: Record<string, any>;
    }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = requireSourceBinding(options?.sourceId || (options?.provider === 'space-track' ? 'space_track' : 'celestrak'));
        const fetchedAt = options?.fetchedAt || new Date().toISOString();
        const provider = options?.provider || null;
        const entities: EntityUpsertRow[] = [];
        const entitySnapshotsSeed: Array<EntitySnapshotUpsertRow & { state_hash: string }> = [];
        const aliases: EntityAliasUpsertRow[] = [];
        const orbitalRows: OrbitalElementUpsertRow[] = [];

        for (const record of records) {
            if (!record.tleLine1 || !record.tleLine2) continue;
            const noradId = Number.isFinite(record.noradId) && record.noradId > 0 ? String(record.noradId) : null;
            const entityId = noradId
                ? `satellite:${noradId}`
                : `satellite:${stableHash({ name: record.name, tleLine1: record.tleLine1, tleLine2: record.tleLine2 })}`;
            const stateHash = tleStateHash(record.tleLine1, record.tleLine2);
            const tleEpochAt = record.tleEpochAt || null;
            const observedAt = tleEpochAt || fetchedAt;
            const sourcePublicationAt = record.sourcePublicationAt || options?.sourcePublicationAt || null;

            entities.push({
                entity_id: entityId,
                latest_snapshot_id: null,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                entity_kind: binding.recordKind,
                subtype: record.type || null,
                display_name: escapeIdentifier(record.name || noradId || entityId),
                first_observed_at: observedAt,
                last_observed_at: observedAt,
                properties: {
                    noradId: record.noradId,
                    type: record.type,
                    classificationSource: record.classificationSource || 'derived_name_heuristic',
                    provider,
                    fetchedAt,
                    tleEpochAt,
                    sourcePublicationAt,
                    historicalOrbitalImport: true,
                },
            });

            entitySnapshotsSeed.push({
                entity_snapshot_id: `entity-snap:${entityId}:history:${stateHash}`,
                entity_id: entityId,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                entity_kind: binding.recordKind,
                subtype: record.type || null,
                display_name: escapeIdentifier(record.name || noradId || entityId),
                observed_at: observedAt,
                properties: {
                    noradId: record.noradId,
                    type: record.type,
                    classificationSource: record.classificationSource || 'derived_name_heuristic',
                    provider,
                    fetchedAt,
                    tleEpochAt,
                    sourcePublicationAt,
                    historicalOrbitalImport: true,
                    _state_hash: stateHash,
                },
                state_hash: stateHash,
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
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                observed_at: observedAt,
                tle_epoch_at: tleEpochAt,
                fetched_at: fetchedAt,
                provider,
                source_publication_at: sourcePublicationAt,
                norad_id: noradId,
                tle_line1: record.tleLine1,
                tle_line2: record.tleLine2,
                state_hash: stateHash,
                properties: {
                    name: record.name,
                    type: record.type,
                    classificationSource: record.classificationSource || 'derived_name_heuristic',
                    provider,
                    fetchedAt,
                    tleEpochAt,
                    sourcePublicationAt,
                    historicalOrbitalImport: true,
                    _state_hash: stateHash,
                },
            });
        }

        const latestEntityHashes = await this.loadLatestEntityHashes(entitySnapshotsSeed.map((row) => row.entity_id));
        const entitySnapshots = entitySnapshotsSeed
            .filter((row) => latestEntityHashes.get(row.entity_id) !== row.state_hash)
            .map(({ state_hash: _stateHash, ...row }) => row);

        await this.runTrackedIngest(
            {
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: records.length,
                metadata: {
                    canonicalTarget: binding.canonicalTarget,
                    changedEntityCount: entitySnapshots.length,
                    provider,
                    fetchedAt,
                    sourcePublicationAt: options?.sourcePublicationAt || null,
                    historicalOrbitalImport: true,
                    query: options?.query || null,
                },
            },
            async () => {
                await this.upsertSatelliteHistoryEntities(entities);
                await this.upsertEntityAliases(aliases);
                await this.insertEntitySnapshots(entitySnapshots);
                await this.insertOrbitalElements(orbitalRows);
            },
        );
    }

    async persistAirspaceZones(zones: AirspaceZone[]): Promise<void> {
        if (!this.database.isReady() || zones.length === 0) return;

        const binding = requireSourceBinding('openaip');
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
                    layer_id: binding.layerId,
                    source_id: binding.sourceId,
                    asset_kind: binding.recordKind,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length,
                metadata: { canonicalTarget: binding.canonicalTarget },
            },
            async (ingestRunId) => {
                await this.executeAssetSnapshotWriter(binding.sourceId, rows, ingestRunId);
            },
        );
    }

    async persistPipelines(records: PipelineRecord[]): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;

        const binding = requireSourceBinding('overture_pipelines');
        const observedAt = new Date().toISOString();
        const rows = records
            .map((record) => {
                let geometryJson: GeoJsonGeometry | null = null;
                if (Array.isArray(record.coordinates) && record.coordinates.length >= 2) {
                    const coordinates = record.coordinates
                        .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
                        .map(([lat, lng]) => [lng, lat]);
                    if (coordinates.length >= 2) {
                        geometryJson = {
                            type: 'LineString',
                            coordinates,
                        };
                    }
                } else if (Number.isFinite(record.lat) && Number.isFinite(record.lng)) {
                    geometryJson = {
                        type: 'Point',
                        coordinates: [record.lng as number, record.lat as number],
                    };
                }
                if (!geometryJson) return null;
                const assetId = `pipeline:${record.id}`;
                const stateHash = stableHash({
                    geometry: geometryJson,
                    name: record.name,
                    substance: record.substance,
                });
                return {
                    asset_id: assetId,
                    asset_snapshot_id: `asset-snap:${assetId}:${stateHash}`,
                    layer_id: binding.layerId,
                    source_id: binding.sourceId,
                    asset_kind: binding.recordKind,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length,
                metadata: { canonicalTarget: binding.canonicalTarget },
            },
            async (ingestRunId) => {
                await this.executeAssetSnapshotWriter(binding.sourceId, rows, ingestRunId);
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
        const binding = requireSourceBinding('gpsjam');
        const rows: EventUpsertRow[] = [];

        for (const zone of zones) {
            const ring = zone.boundary.map(([lat, lng]) => [lng, lat]);
            if (ring.length < 3) continue;
            const closedRing = [...ring, ring[0]];
            rows.push({
                event_id: `jamming:${zone.h3Index}`,
                event_snapshot_id: `jamming:${snapshotDate || 'unknown'}:${zone.h3Index}`,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                event_kind: binding.recordKind,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: rows.length,
                metadata: {
                    snapshotDate,
                    canonicalTarget: binding.canonicalTarget,
                    rawCaptureMode: binding.rawCaptureMode,
                },
                raw_payloads: binding.rawCaptureMode === 'snapshot' && options?.rawCsv
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
                await this.executeEventSnapshotWriter(binding.sourceId, rows, ingestRunId);
            },
        );
    }

    async persistFires(records: FireRecord[], options?: { rawCsv?: string | null }): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;
        const binding = requireSourceBinding('firms');

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
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                event_kind: binding.recordKind,
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
                source_id: binding.sourceId,
                layer_id: binding.layerId,
                record_count: payload.length,
                metadata: {
                    canonicalTarget: binding.canonicalTarget,
                    rawCaptureMode: binding.rawCaptureMode,
                },
                raw_payloads: binding.rawCaptureMode === 'snapshot' && options?.rawCsv
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
                await this.executeEventSnapshotWriter(binding.sourceId, payload, ingestRunId);
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
            const binding = requireSourceBinding(normalizedSourceId);
            // Keep source-derived time only; persistEventBatch will skip rows
            // with no observable time. Do NOT fall back to wall-clock — it
            // poisons composite-PK idempotency.
            const observedAt = event.startTime || null;
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
                // Snapshot ID must be content-derived, NOT time-derived, so
                // repeated polls of the same event state yield the same ID
                // and hit the composite ON CONFLICT guard.
                event_snapshot_id: `disaster:${stableHash({
                    source: normalizedSourceId,
                    nativeId: event.id,
                    geometry: geometryJson || { type: 'Point', coordinates: [lng, lat] },
                    subtype: event.eventType || 'unknown',
                })}`,
                layer_id: binding.layerId,
                source_id: binding.sourceId,
                event_kind: binding.recordKind,
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
            const sourceId = row.source_id;
            if (!sourceId) throw new Error(`Disaster event missing source_id for event_id=${row.event_id}`);
            const bucket = rowsBySource.get(sourceId);
            if (bucket) bucket.push(row);
            else rowsBySource.set(sourceId, [row]);
        }

        for (const [sourceId, rows] of rowsBySource) {
            const binding = requireSourceBinding(sourceId);
            const rawPayloadsForSource = (options?.rawPayloads || []).filter(
                (payloadRow) => payloadRow.source_id === sourceId,
            );

            await this.runTrackedIngest(
                {
                    source_id: binding.sourceId,
                    layer_id: binding.layerId,
                    record_count: rows.length,
                    metadata: {
                        sourceIds: [binding.sourceId],
                        canonicalTarget: binding.canonicalTarget,
                        rawCaptureMode: rawPayloadsForSource.length ? binding.rawCaptureMode : 'none',
                    },
                    raw_payloads: rawPayloadsForSource,
                },
                async (ingestRunId) => {
                    await this.executeEventSnapshotWriter(binding.sourceId, rows, ingestRunId);
                },
            );
        }
    }
}

export const sourcePersistenceTestHooks = {
    requireSourceBinding,
};
