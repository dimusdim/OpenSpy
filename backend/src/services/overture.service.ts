/**
 * Overture Maps infrastructure — local DuckDB render cache.
 *
 * On first startup, extracts viewport render data from Overture's public S3
 * GeoParquet into a local DuckDB file. Subsequent startups reuse the cache.
 * Point-like infrastructure stores centroids; power transmission lines store
 * simplified render geometry as GeoJSON so viewport queries hit local disk.
 *
 * Geometry on click: NOT implemented yet. Plan: store `filename` per
 * record, on click query that single S3 file for full geometry,
 * cache locally in a geometry_cache table.
 *
 * Cache invalidation: tied to Overture release version (not time-based).
 * New version in env → re-download.
 *
 * Feature flag: OVERTURE_ENABLED=true in backend/.env
 */

import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OvertureInfraType =
    | 'power_plant'
    | 'refinery'
    | 'desalination'
    | 'military'
    | 'power_substation'
    | 'power_line'
    | 'communication_tower'
    | 'aerodrome'
    | 'dam';

export interface OvertureInfraRecord {
    id: string;
    lat: number;
    lng: number;
    name: string;
    type: OvertureInfraType;
    source: 'overture';
    coordinates?: [number, number][];
    voltage?: string | null;
    operator?: string | null;
}

export interface OverturePipelineRecord {
    id: string;
    lat: number;
    lng: number;
    name: string;
    substance: OverturePipelineSubstance;
    source: 'overture';
    operator?: string | null;
    rawSubstance?: string | null;
    coordinates?: [number, number][][];
}

export interface OverturePipelineDetails {
    layerId: 'pipeline';
    featureKind: 'asset';
    id: string;
    name: string;
    sourceId: 'overture_pipelines';
    subtype: OverturePipelineSubstance;
    lat: number;
    lng: number;
    properties: {
        name: string;
        substance: OverturePipelineSubstance;
        rawSubstance?: string | null;
        operator?: string | null;
    };
}

export type OverturePipelineSubstance = 'oil' | 'gas' | 'water' | 'other';

type OvertureQueryTask = {
    priority: number;
    seq: number;
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
};

// ---------------------------------------------------------------------------
// Configuration — what to extract from Overture
// ---------------------------------------------------------------------------
// These filters will eventually be user-configurable via a settings UI.
// For now they are hardcoded to the agreed-upon list.

/** land_use subtypes to include */
const LAND_USE_SUBTYPES = ['military', 'resource_extraction'];

/** infrastructure subtype → allowed classes */
const INFRA_FILTERS: Record<string, string[]> = {
    power: ['substation', 'power_substation', 'plant', 'power_plant',
            'transformer', 'switch', 'compensator'],
    water: ['dam', 'reservoir', 'water_treatment', 'wastewater'],
    communication: ['communication_tower', 'mobile_phone_tower'],
    airport: ['aerodrome'],
};

const POWER_LINE_CLASSES = ['power_line', 'minor_line', 'cable'];

// Build SQL WHERE for infrastructure
function infraWhere(): string {
    return Object.entries(INFRA_FILTERS)
        .map(([sub, cls]) => {
            const list = cls.map(c => `'${c}'`).join(',');
            return `(subtype = '${sub}' AND class IN (${list}))`;
        })
        .join('\n               OR ');
}

function pipelineWhere(): string {
    return `(subtype = 'utility' AND class = 'pipeline')`;
}

function normalizePipelineSubstance(raw: unknown): OverturePipelineSubstance {
    const value = String(raw ?? '').toLowerCase();
    if (!value) return 'other';
    if (
        value.includes('gas') ||
        value.includes('methane') ||
        value.includes('lng') ||
        value.includes('lpg') ||
        value.includes('ngl') ||
        value.includes('cng') ||
        value.includes('hydrogen') ||
        value.includes('propane') ||
        value.includes('butane') ||
        value.includes('ethane') ||
        value.includes('ethylene') ||
        value.includes('propylene')
    ) return 'gas';
    if (
        value.includes('oil') ||
        value.includes('petroleum') ||
        value.includes('crude') ||
        value.includes('fuel') ||
        value.includes('hydrocarbon') ||
        value.includes('condensate') ||
        value.includes('naphtha')
    ) return 'oil';
    if (
        value.includes('water') ||
        value.includes('sewer') ||
        value.includes('sewage') ||
        value.includes('drain') ||
        value.includes('steam') ||
        value.includes('brine') ||
        value.includes('heat')
    ) return 'water';
    return 'other';
}

// ---------------------------------------------------------------------------
// Type mapping: Overture subtype+class → our OvertureInfraType
// ---------------------------------------------------------------------------

function mapLandUseType(subtype: string): OvertureInfraType | null {
    if (subtype === 'military') return 'military';
    if (subtype === 'resource_extraction') return 'refinery';
    return null;
}

function mapInfraPointType(subtype: string, cls: string): OvertureInfraType | null {
    if (subtype === 'power') {
        if (cls === 'substation' || cls === 'power_substation') return 'power_substation';
        return 'power_plant';
    }
    if (subtype === 'water') return 'dam';
    if (subtype === 'communication') return 'communication_tower';
    if (subtype === 'airport') return 'aerodrome';
    return null;
}

function parseLineCoordinates(raw: unknown): [number, number][] | null {
    if (!raw) return null;
    let parsed: any;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
    const coords = parsed?.coordinates;
    if (!Array.isArray(coords)) return null;
    const first = coords[0];
    const line = Array.isArray(first?.[0])
        ? coords.flatMap((part: any[]) => Array.isArray(part) ? part : [])
        : coords;
    const out: [number, number][] = [];
    for (const pair of line) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const lng = Number(pair[0]);
        const lat = Number(pair[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        out.push([lat, lng]);
    }
    return out.length >= 2 ? out : null;
}

function parseLineCoordinateParts(raw: unknown): [number, number][][] | null {
    if (!raw) return null;
    let parsed: any;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
    const coords = parsed?.coordinates;
    if (!Array.isArray(coords)) return null;

    const rawParts = parsed?.type === 'MultiLineString' || Array.isArray(coords[0]?.[0])
        ? coords
        : [coords];
    const parts: [number, number][][] = [];

    for (const rawPart of rawParts) {
        if (!Array.isArray(rawPart)) continue;
        const part: [number, number][] = [];
        for (const pair of rawPart) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const lng = Number(pair[0]);
            const lat = Number(pair[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            part.push([lat, lng]);
        }
        if (part.length >= 2) parts.push(part);
    }

    return parts.length > 0 ? parts : null;
}

// Types that /api/infrastructure serves. Power records are deliberately
// excluded here because /api/power-infra is the dedicated power endpoint; if
// both endpoints return the same Overture power records the frontend will draw
// duplicate billboards for one logical object.
const INFRA_ENDPOINT_TYPES = new Set<OvertureInfraType>([
    'refinery', 'desalination', 'military',
    'communication_tower', 'aerodrome', 'dam',
]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OVERTURE_VERSION = '2026-03-18.0';
const CACHE_SCHEMA_REVISION = 4;
const OVERTURE_S3_REGION = 'us-west-2';
const OVERTURE_S3_BASE = 's3://overturemaps-us-west-2/release';
const CACHE_DIR = path.resolve(__dirname, '../../data');
const CACHE_DB_PATH = path.join(CACHE_DIR, 'overture-cache.duckdb');
// Temp DB for atomic downloads — never serves queries. On success,
// renamed over CACHE_DB_PATH in one POSIX rename() call.
const CACHE_DOWNLOAD_PATH = path.join(CACHE_DIR, 'overture-cache.download.duckdb');
const QUERY_LIMIT = 10000;

// ---------------------------------------------------------------------------
// Download progress (exposed to /api/status)
// ---------------------------------------------------------------------------

export interface OvertureStatus {
    state: 'disabled' | 'init' | 'downloading' | 'ready' | 'error';
    version: string;
    step: string;          // e.g. "[1/2] land_use"
    records: number;       // total cached records
    diskMb: number;        // cache file size
    cacheAge: string | null;
    error: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class OvertureService {
    private db: any = null;
    private ready = false;
    // DuckDB Node.js binding can deadlock when multiple db.all() calls overlap
    // on the same Database handle. Keep one active query, but use priorities so
    // small render-critical viewport requests are not starved behind slower
    // infrastructure enrichment scans.
    private _queryQueue: OvertureQueryTask[] = [];
    private _queryRunning = false;
    private _querySeq = 0;
    private readonly version: string;

    // Observable status
    private _status: OvertureStatus;

    constructor() {
        this.version = process.env.OVERTURE_VERSION || DEFAULT_OVERTURE_VERSION;
        this._status = {
            state: 'init',
            version: this.version,
            step: '',
            records: 0,
            diskMb: 0,
            cacheAge: null,
            error: null,
        };
    }

    isEnabled(): boolean {
        return process.env.OVERTURE_ENABLED === 'true';
    }

    isReady(): boolean {
        return this.ready;
    }

    getInitError(): string | null {
        return this._status.error;
    }

    /** Full status for /api/status */
    getStatus(): OvertureStatus {
        return { ...this._status };
    }

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------

    async init(): Promise<void> {
        if (!this.isEnabled()) {
            this._status.state = 'disabled';
            console.log('[Overture] disabled (set OVERTURE_ENABLED=true to opt in)');
            return;
        }
        try {
            fs.mkdirSync(CACHE_DIR, { recursive: true });

            // Clean up incomplete downloads from previous crashes
            for (const f of [CACHE_DOWNLOAD_PATH, `${CACHE_DOWNLOAD_PATH}.wal`, `${CACHE_DOWNLOAD_PATH}.tmp`]) {
                if (fs.existsSync(f)) {
                    const stat = fs.statSync(f);
                    if (stat.isDirectory()) fs.rmSync(f, { recursive: true });
                    else fs.unlinkSync(f);
                    console.log(`[Overture] Cleaned incomplete download artifact: ${path.basename(f)}`);
                }
            }

            const duckdb = require('duckdb');

            // Open live DB if it exists
            if (fs.existsSync(CACHE_DB_PATH)) {
                await new Promise<void>((resolve, reject) => {
                    this.db = new duckdb.Database(CACHE_DB_PATH, (err: Error | null) => {
                        if (err) reject(err); else resolve();
                    });
                });
                await this.exec('INSTALL spatial; LOAD spatial;');

                const fresh = await this.isCacheFresh();
                if (fresh) {
                    this.ready = true;
                    this._status.state = 'ready';
                    await this.loadMeta();
                    this.updateDiskSize();
                    console.log(
                        `[Overture] Cache valid (v${this.version}, ${this._status.cacheAge}): ` +
                        `${this._status.records} records, ${this._status.diskMb} MB`
                    );
                    return;
                }
                // Stale but usable — keep serving old data while downloading
                this.ready = true;
                this._status.state = 'ready';
                await this.loadMeta();
                this.updateDiskSize();
                console.log(`[Overture] Cache stale — serving old data, downloading update in background...`);
            } else {
                console.log('[Overture] No cache — downloading in background...');
            }

            // Download into temp file, swap on success
            this._status.state = this.ready ? 'ready' : 'downloading';
            this.downloadCache().catch(err => {
                this._status.state = this.ready ? 'ready' : 'error';
                this._status.error = err?.message || String(err);
                console.error('[Overture] Download failed:', this._status.error);
            });
        } catch (err: any) {
            this._status.state = 'error';
            this._status.error = err?.message || String(err);
            console.error('[Overture] init failed:', this._status.error);
        }
    }

    // -----------------------------------------------------------------------
    // Cache freshness
    // -----------------------------------------------------------------------

    private async isCacheFresh(): Promise<boolean> {
        try {
            const rows = await this.query<any>(
                'SELECT version, downloaded_at FROM cache_meta LIMIT 1'
            );
            if (rows.length === 0) return false;
            if (rows[0].version !== this.version) {
                console.log(`[Overture] Version changed: cache=${rows[0].version}, target=${this.version}`);
                return false;
            }
            const schemaRows = await this.query<any>(`
                SELECT COUNT(*)::INTEGER AS c
                FROM information_schema.columns
                WHERE table_schema = 'main'
                  AND table_name = 'infra_points'
                  AND column_name IN ('pipeline_substance', 'pipeline_operator')
            `);
            if ((schemaRows[0]?.c ?? 0) < 2) {
                console.log('[Overture] Cache schema changed: missing pipeline columns');
                return false;
            }
            const lineTableRows = await this.query<any>(`
                SELECT COUNT(*)::INTEGER AS c
                FROM information_schema.tables
                WHERE table_schema = 'main'
                  AND table_name = 'infra_lines'
            `);
            if ((lineTableRows[0]?.c ?? 0) < 1) {
                console.log('[Overture] Cache schema changed: missing infra_lines');
                return false;
            }
            const pipelineLineTableRows = await this.query<any>(`
                SELECT COUNT(*)::INTEGER AS c
                FROM information_schema.tables
                WHERE table_schema = 'main'
                  AND table_name = 'pipeline_lines'
            `);
            if ((pipelineLineTableRows[0]?.c ?? 0) < 1) {
                console.log('[Overture] Cache schema changed: missing pipeline_lines');
                return false;
            }
            const metaSchemaRows = await this.query<any>(`
                SELECT COUNT(*)::INTEGER AS c
                FROM information_schema.columns
                WHERE table_schema = 'main'
                  AND table_name = 'cache_meta'
                  AND column_name = 'schema_revision'
            `);
            if ((metaSchemaRows[0]?.c ?? 0) > 0) {
                const revisionRows = await this.query<any>('SELECT schema_revision FROM cache_meta LIMIT 1');
                if (Number(revisionRows[0]?.schema_revision || 0) < CACHE_SCHEMA_REVISION) {
                    console.log(`[Overture] Cache schema revision changed: cache=${revisionRows[0]?.schema_revision ?? 'missing'}, target=${CACHE_SCHEMA_REVISION}`);
                    return false;
                }
            }
            const ageMs = Date.now() - new Date(rows[0].downloaded_at).getTime();
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            this._status.cacheAge = ageDays < 1 ? '<1d' : `${Math.floor(ageDays)}d`;
            return true;
        } catch (err) {
            // DuckDB may not be ready yet (cold boot, locked file).
            // Don't treat a transient query failure as "stale" — that
            // triggers a 25-min re-download. If the DB file exists on
            // disk, assume the cache is valid for startup. Query methods
            // still fail loudly/return explicit unavailable responses if
            // the required table shape is absent.
            if (fs.existsSync(CACHE_DB_PATH)) {
                console.warn('[Overture] Cache query failed but DB file exists — treating as fresh');
                return true;
            }
            return false;
        }
    }

    private async loadMeta(): Promise<void> {
        try {
            const rows = await this.query<any>(
                `SELECT land_use_count, infra_points_count,
                        COALESCE(infra_lines_count, 0) AS infra_lines_count,
                        COALESCE(pipeline_lines_count, 0) AS pipeline_lines_count,
                        downloaded_at,
                        version FROM cache_meta LIMIT 1`
            );
            if (rows.length > 0) {
                this._status.records =
                    (rows[0].land_use_count ?? 0) +
                    (rows[0].infra_points_count ?? 0) +
                    (rows[0].infra_lines_count ?? 0) +
                    (rows[0].pipeline_lines_count ?? 0);
                const ageMs = Date.now() - new Date(rows[0].downloaded_at).getTime();
                const ageDays = ageMs / (1000 * 60 * 60 * 24);
                this._status.cacheAge = ageDays < 1 ? '<1d' : `${Math.floor(ageDays)}d`;
            }
        } catch { /* first run */ }
    }

    private updateDiskSize(): void {
        try {
            const stat = fs.statSync(CACHE_DB_PATH);
            this._status.diskMb = Math.round(stat.size / 1024 / 1024);
        } catch {
            this._status.diskMb = 0;
        }
    }

    // -----------------------------------------------------------------------
    // Download from S3 into local DuckDB
    // -----------------------------------------------------------------------

    /** Run SQL on an arbitrary DuckDB database handle */
    private execOn(db: any, sql: string, params: unknown[] = []): Promise<void> {
        return new Promise((resolve, reject) => {
            db.run(sql, ...params, (err: Error | null) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    /** Count rows in a table on an arbitrary db handle */
    private countTableOn(db: any, table: string): Promise<number> {
        return new Promise((resolve, reject) => {
            db.all(`SELECT count(*)::INTEGER as c FROM ${table}`, (err: Error | null, rows: any[]) => {
                if (err) reject(err);
                else resolve(rows?.[0]?.c ?? 0);
            });
        });
    }

    /** Close a DuckDB database handle */
    private closeDb(db: any): Promise<void> {
        return new Promise((resolve) => {
            if (!db) { resolve(); return; }
            db.close(() => resolve());
        });
    }

    private async downloadCache(): Promise<void> {
        const duckdb = require('duckdb');
        const s3Base = `${OVERTURE_S3_BASE}/${this.version}`;

        console.log('[Overture] ════════════════════════════════════════════');
        console.log('[Overture]  Downloading Overture render cache');
        console.log(`[Overture]  Version: ${this.version}`);
        console.log('[Overture]  Writing to temp file (atomic swap on success)');
        console.log('[Overture]  This may take 10-25 min on first run');
        console.log('[Overture] ════════════════════════════════════════════');

        // Clean any leftover temp artifacts
        for (const f of [CACHE_DOWNLOAD_PATH, `${CACHE_DOWNLOAD_PATH}.wal`, `${CACHE_DOWNLOAD_PATH}.tmp`]) {
            if (fs.existsSync(f)) {
                const stat = fs.statSync(f);
                if (stat.isDirectory()) fs.rmSync(f, { recursive: true });
                else fs.unlinkSync(f);
            }
        }

        // Open temp DB — completely separate from live DB
        const tempDb: any = await new Promise<any>((resolve, reject) => {
            const db = new duckdb.Database(CACHE_DOWNLOAD_PATH, (err: Error | null) => {
                if (err) reject(err); else resolve(db);
            });
        });

        try {
            await this.execOn(tempDb, 'INSTALL spatial; LOAD spatial;');
            await this.execOn(tempDb, 'INSTALL httpfs; LOAD httpfs;');
            await this.execOn(tempDb, `SET s3_region='${OVERTURE_S3_REGION}';`);

            const totalT0 = Date.now();
            const subtypeList = LAND_USE_SUBTYPES.map(s => `'${s}'`).join(',');

            // ---- Step 1: land_use ----
            this._status.step = '[1/2] land_use (military, resource_extraction)';
            console.log(`[Overture] ${this._status.step}...`);
            const t1 = Date.now();
            await this.execOn(tempDb, `
                CREATE TABLE land_use AS
                SELECT id, names.primary AS name, subtype, class,
                       (bbox.ymin + bbox.ymax) / 2 AS lat,
                       (bbox.xmin + bbox.xmax) / 2 AS lng,
                       filename
                FROM read_parquet('${s3Base}/theme=base/type=land_use/*',
                                  hive_partitioning=1, filename=true)
                WHERE subtype IN (${subtypeList})
            `);
            const luCount = await this.countTableOn(tempDb, 'land_use');
            console.log(`[Overture]   ${luCount} records (${this.elapsed(t1)})`);

            // ---- Step 2: point/centroid infrastructure ----
            this._status.step = '[2/4] infrastructure points (power, water, communication, airport, pipelines)';
            console.log(`[Overture] ${this._status.step}...`);
            const t2 = Date.now();
            await this.execOn(tempDb, `
                CREATE TABLE infra_points AS
                SELECT id, names.primary AS name, subtype, class,
                       (bbox.ymin + bbox.ymax) / 2 AS lat,
                       (bbox.xmin + bbox.xmax) / 2 AS lng,
                       TRY_CAST(map_extract_value(source_tags, 'substance') AS VARCHAR) AS pipeline_substance,
                       TRY_CAST(map_extract_value(source_tags, 'operator') AS VARCHAR) AS pipeline_operator,
                       filename
                FROM read_parquet('${s3Base}/theme=base/type=infrastructure/*',
                                  hive_partitioning=1, filename=true)
                WHERE ${infraWhere()}
                   OR ${pipelineWhere()}
            `);
            const ipCount = await this.countTableOn(tempDb, 'infra_points');
            console.log(`[Overture]   ${ipCount} records (${this.elapsed(t2)})`);

            // ---- Step 3: power transmission line geometry ----
            this._status.step = '[3/4] infrastructure lines (power_line/minor_line/cable geometry)';
            console.log(`[Overture] ${this._status.step}...`);
            const t3 = Date.now();
            const powerLineClassList = POWER_LINE_CLASSES.map((value) => `'${value}'`).join(',');
            await this.execOn(tempDb, `
                CREATE TABLE infra_lines AS
                SELECT id, names.primary AS name, subtype, class,
                       (bbox.ymin + bbox.ymax) / 2 AS lat,
                       (bbox.xmin + bbox.xmax) / 2 AS lng,
                       bbox.ymin AS south,
                       bbox.xmin AS west,
                       bbox.ymax AS north,
                       bbox.xmax AS east,
                       TRY_CAST(map_extract_value(source_tags, 'voltage') AS VARCHAR) AS voltage,
                       TRY_CAST(map_extract_value(source_tags, 'operator') AS VARCHAR) AS operator,
                       ST_AsGeoJSON(geometry) AS geometry_geojson,
                       filename
                FROM read_parquet('${s3Base}/theme=base/type=infrastructure/*',
                                  hive_partitioning=1, filename=true)
                WHERE subtype = 'power'
                  AND class IN (${powerLineClassList})
            `);
            const ilCount = await this.countTableOn(tempDb, 'infra_lines');
            console.log(`[Overture]   ${ilCount} records (${this.elapsed(t3)})`);

            // ---- Step 4: utility pipeline line geometry ----
            this._status.step = '[4/4] pipeline line geometry';
            console.log(`[Overture] ${this._status.step}...`);
            const t4 = Date.now();
            await this.execOn(tempDb, `
                CREATE TABLE pipeline_lines AS
                SELECT id, names.primary AS name, subtype, class,
                       (bbox.ymin + bbox.ymax) / 2 AS lat,
                       (bbox.xmin + bbox.xmax) / 2 AS lng,
                       bbox.ymin AS south,
                       bbox.xmin AS west,
                       bbox.ymax AS north,
                       bbox.xmax AS east,
                       TRY_CAST(map_extract_value(source_tags, 'substance') AS VARCHAR) AS pipeline_substance,
                       TRY_CAST(map_extract_value(source_tags, 'operator') AS VARCHAR) AS pipeline_operator,
                       ST_AsGeoJSON(geometry) AS geometry_geojson,
                       filename
                FROM read_parquet('${s3Base}/theme=base/type=infrastructure/*',
                                  hive_partitioning=1, filename=true)
                WHERE subtype = 'utility'
                  AND class = 'pipeline'
            `);
            const plCount = await this.countTableOn(tempDb, 'pipeline_lines');
            console.log(`[Overture]   ${plCount} records (${this.elapsed(t4)})`);

            // ---- Metadata ----
            await this.execOn(tempDb, `
                CREATE TABLE cache_meta (
                    version VARCHAR, downloaded_at VARCHAR,
                    land_use_count INTEGER, infra_points_count INTEGER,
                    infra_lines_count INTEGER,
                    pipeline_lines_count INTEGER,
                    schema_revision INTEGER,
                    land_use_subtypes VARCHAR, infra_filters VARCHAR
                )
            `);
            await this.execOn(
                tempDb,
                'INSERT INTO cache_meta VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    this.version,
                    new Date().toISOString(),
                    luCount,
                    ipCount,
                    ilCount,
                    plCount,
                    CACHE_SCHEMA_REVISION,
                    LAND_USE_SUBTYPES.join(','),
                    JSON.stringify(INFRA_FILTERS),
                ],
            );

            // Flush WAL into main file before swap
            await this.execOn(tempDb, 'CHECKPOINT;');
            await this.closeDb(tempDb);

            // Verify WAL is gone (CHECKPOINT should have merged it)
            const walPath = `${CACHE_DOWNLOAD_PATH}.wal`;
            if (fs.existsSync(walPath)) {
                fs.unlinkSync(walPath);
            }

            // ---- Atomic swap: close live DB, rename temp → live ----
            if (this.db) {
                await this.closeDb(this.db);
                this.db = null;
            }
            // Remove old live DB files
            for (const f of [CACHE_DB_PATH, `${CACHE_DB_PATH}.wal`, `${CACHE_DB_PATH}.tmp`]) {
                if (fs.existsSync(f)) {
                    const stat = fs.statSync(f);
                    if (stat.isDirectory()) fs.rmSync(f, { recursive: true });
                    else fs.unlinkSync(f);
                }
            }
            // Rename temp → live (atomic on same volume)
            fs.renameSync(CACHE_DOWNLOAD_PATH, CACHE_DB_PATH);

            // Reopen live DB
            await new Promise<void>((resolve, reject) => {
                this.db = new duckdb.Database(CACHE_DB_PATH, (err: Error | null) => {
                    if (err) reject(err); else resolve();
                });
            });
            await this.exec('INSTALL spatial; LOAD spatial;');

            this._status.records = luCount + ipCount + ilCount + plCount;
            this._status.cacheAge = '<1d';
            this.updateDiskSize();
            this.ready = true;
            this._status.state = 'ready';
            this._status.step = '';

            console.log('[Overture] ════════════════════════════════════════════');
            console.log(`[Overture]  DONE: ${luCount + ipCount + ilCount + plCount} records`);
            console.log(`[Overture]  land_use: ${luCount} | infra points: ${ipCount} | infra lines: ${ilCount} | pipeline lines: ${plCount}`);
            console.log(`[Overture]  Disk: ${this._status.diskMb} MB`);
            console.log(`[Overture]  Time: ${this.elapsed(totalT0)}`);
            console.log('[Overture] ════════════════════════════════════════════');

        } catch (err) {
            // Download failed — close temp DB, clean up temp files.
            // Live DB stays untouched.
            await this.closeDb(tempDb).catch(() => {});
            for (const f of [CACHE_DOWNLOAD_PATH, `${CACHE_DOWNLOAD_PATH}.wal`, `${CACHE_DOWNLOAD_PATH}.tmp`]) {
                if (fs.existsSync(f)) {
                    try {
                        const stat = fs.statSync(f);
                        if (stat.isDirectory()) fs.rmSync(f, { recursive: true });
                        else fs.unlinkSync(f);
                    } catch {}
                }
            }
            throw err; // re-throw so caller logs the error
        }
    }

    // -----------------------------------------------------------------------
    // Public query methods — local DuckDB
    // -----------------------------------------------------------------------

    async getInfrastructureInBbox(
        south: number, west: number, north: number, east: number
    ): Promise<OvertureInfraRecord[]> {
        if (!this.ready) return [];

        const [luRows, ipRows] = await Promise.all([
            this.query<any>(`
                SELECT id, name, subtype, class, lat, lng FROM land_use
                WHERE lat BETWEEN ${south} AND ${north}
                  AND lng BETWEEN ${west} AND ${east}
                LIMIT ${QUERY_LIMIT}
            `),
            this.query<any>(`
                SELECT id, name, subtype, class, lat, lng FROM infra_points
                WHERE lat BETWEEN ${south} AND ${north}
                  AND lng BETWEEN ${west} AND ${east}
                LIMIT ${QUERY_LIMIT}
            `),
        ]);

        const records: OvertureInfraRecord[] = [];

        for (const row of luRows) {
            const type = mapLandUseType(row.subtype);
            if (!type || !INFRA_ENDPOINT_TYPES.has(type)) continue;
            const lat = Number(row.lat);
            const lng = Number(row.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            records.push({
                id: `overture-lu-${row.id}`, lat, lng,
                name: row.name || row.class || row.subtype || type,
                type, source: 'overture',
            });
        }

        for (const row of ipRows) {
            const type = mapInfraPointType(row.subtype, row.class);
            if (!type || !INFRA_ENDPOINT_TYPES.has(type)) continue;
            const lat = Number(row.lat);
            const lng = Number(row.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            records.push({
                id: `overture-inf-${row.id}`, lat, lng,
                name: row.name || row.class || row.subtype || type,
                type, source: 'overture',
            });
        }

        return records;
    }

    async getPowerInfraInBbox(
        south: number, west: number, north: number, east: number
    ): Promise<OvertureInfraRecord[]> {
        if (!this.ready) return [];

        const pointRows = await this.query<any>(`
            SELECT id, name, subtype, class, lat, lng FROM infra_points
            WHERE subtype = 'power'
              AND lat BETWEEN ${south} AND ${north}
              AND lng BETWEEN ${west} AND ${east}
            LIMIT ${QUERY_LIMIT}
        `);
        let lineRows: any[] = [];
        try {
            lineRows = await this.query<any>(`
                SELECT id, name, subtype, class, lat, lng, voltage, operator,
                       geometry_geojson
                FROM infra_lines
                WHERE subtype = 'power'
                  AND class IN (${POWER_LINE_CLASSES.map((value) => `'${value}'`).join(',')})
                  AND west <= ${east}
                  AND east >= ${west}
                  AND south <= ${north}
                  AND north >= ${south}
                LIMIT ${QUERY_LIMIT}
            `);
        } catch {
            lineRows = [];
        }

        const records: OvertureInfraRecord[] = [];
        for (const row of pointRows) {
            const type = mapInfraPointType(row.subtype, row.class);
            if (!type) continue;
            const lat = Number(row.lat);
            const lng = Number(row.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            records.push({
                id: `overture-inf-${row.id}`, lat, lng,
                name: row.name || row.class || type,
                type, source: 'overture',
            });
        }
        for (const row of lineRows) {
            const coordinates = parseLineCoordinates(row.geometry_geojson);
            if (!coordinates) continue;
            const mid = coordinates[Math.floor(coordinates.length / 2)];
            const lat = Number.isFinite(Number(row.lat)) ? Number(row.lat) : mid[0];
            const lng = Number.isFinite(Number(row.lng)) ? Number(row.lng) : mid[1];
            records.push({
                id: `overture-inf-line-${row.id}`,
                lat,
                lng,
                name: row.name || 'Power line',
                type: 'power_line',
                source: 'overture',
                coordinates,
                voltage: row.voltage || null,
                operator: row.operator || null,
            });
        }
        return records;
    }

    async getPipelinesInBbox(
        south: number, west: number, north: number, east: number
    ): Promise<OverturePipelineRecord[]> {
        if (!this.ready) return [];

        let rows: any[];
        try {
            rows = await this.query<any>(`
                SELECT id, name, lat, lng, pipeline_substance, pipeline_operator,
                       geometry_geojson
                FROM pipeline_lines
                WHERE subtype = 'utility'
                  AND class = 'pipeline'
                  AND west <= ${east}
                  AND east >= ${west}
                  AND south <= ${north}
                  AND north >= ${south}
                LIMIT ${QUERY_LIMIT}
            `, [], 10);
        } catch (err: any) {
            throw new Error(`Overture pipeline cache schema is not available; cache refresh is required: ${err?.message || err}`);
        }

        const records: OverturePipelineRecord[] = [];
        for (const row of rows) {
            const substance = normalizePipelineSubstance(row.pipeline_substance);
            const coordinates = parseLineCoordinateParts(row.geometry_geojson);
            if (!coordinates) continue;
            const firstPart = coordinates[0];
            const mid = firstPart[Math.floor(firstPart.length / 2)];
            const lat = Number.isFinite(Number(row.lat)) ? Number(row.lat) : mid[0];
            const lng = Number.isFinite(Number(row.lng)) ? Number(row.lng) : mid[1];
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            records.push({
                id: `overture-pipeline-${row.id}`,
                lat,
                lng,
                name: row.name || `${substance} pipeline`,
                substance,
                operator: row.pipeline_operator || null,
                rawSubstance: row.pipeline_substance || null,
                coordinates,
                source: 'overture',
            });
        }
        return records;
    }

    async getPipelineDetails(id: string): Promise<OverturePipelineDetails | null> {
        if (!this.ready) return null;
        const stripped = String(id || '')
            .replace(/^pipeline:/, '')
            .replace(/^overture-pipeline-/, '')
            .replace(/#\d+$/, '');
        // DuckDB's node binding path here is serialized through db.all(sql)
        // without positional parameters, so only allow inert Overture ids.
        if (!/^[A-Za-z0-9:_-]{1,160}$/.test(stripped)) return null;

        const rows = await this.query<any>(
            `
            SELECT id, name, lat, lng, pipeline_substance, pipeline_operator
            FROM pipeline_lines
            WHERE id = ?
              AND subtype = 'utility'
              AND class = 'pipeline'
            LIMIT 1
        `,
            [stripped],
        );
        const row = rows[0];
        if (!row) return null;
        const substance = normalizePipelineSubstance(row.pipeline_substance);
        const lat = Number(row.lat);
        const lng = Number(row.lng);
        if (!substance || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const publicId = `overture-pipeline-${row.id}`;
        const name = row.name || `${substance} pipeline`;
        return {
            layerId: 'pipeline',
            featureKind: 'asset',
            id: publicId,
            name,
            sourceId: 'overture_pipelines',
            subtype: substance,
            lat,
            lng,
            properties: {
                name,
                substance,
                rawSubstance: row.pipeline_substance || null,
                operator: row.pipeline_operator || null,
            },
        };
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private exec(sql: string, params: unknown[] = [], priority = 0): Promise<void> {
        const run = () => new Promise<void>((resolve, reject) => {
            if (!this.db) return reject(new Error('DuckDB not initialized'));
            this.db.run(sql, ...params, (err: Error | null) => {
                if (err) reject(err); else resolve();
            });
        });
        return this.enqueueDbOperation(run, priority);
    }

    private query<T = any>(sql: string, params: unknown[] = [], priority = 0): Promise<T[]> {
        const run = () => new Promise<T[]>((resolve, reject) => {
            if (!this.db) return reject(new Error('DuckDB not initialized'));
            this.db.all(sql, ...params, (err: Error | null, rows: T[]) => {
                if (err) reject(err); else resolve(rows ?? []);
            });
        });
        return this.enqueueDbOperation(run, priority);
    }

    private enqueueDbOperation<T>(run: () => Promise<T>, priority = 0): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this._queryQueue.push({
                priority,
                seq: this._querySeq++,
                run: run as () => Promise<unknown>,
                resolve: (value: unknown) => resolve(value as T),
                reject,
            });
            this._queryQueue.sort((left, right) => (
                right.priority - left.priority || left.seq - right.seq
            ));
            this.drainDbQueue();
        });
    }

    private drainDbQueue(): void {
        if (this._queryRunning) return;
        const task = this._queryQueue.shift();
        if (!task) return;
        this._queryRunning = true;
        task.run()
            .then(task.resolve, task.reject)
            .finally(() => {
                this._queryRunning = false;
                this.drainDbQueue();
            });
    }

    private async countTable(table: string): Promise<number> {
        const rows = await this.query<any>(`SELECT COUNT(*)::INT AS c FROM ${table}`);
        return rows[0]?.c ?? 0;
    }

    private elapsed(t0: number): string {
        const s = (Date.now() - t0) / 1000;
        return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    }
}

// ---------------------------------------------------------------------------
// Proximity dedup helper (unchanged)
// ---------------------------------------------------------------------------

const DEDUP_RADIUS_DEG = 0.005;
const POINT_TYPES: ReadonlySet<string> = new Set([
    'power_plant', 'refinery', 'desalination', 'military', 'power_substation',
    'communication_tower', 'aerodrome', 'dam',
]);

export function dedupAgainstOverture<
    T extends { lat: number; lng: number; type: string }
>(
    overpassRecords: T[],
    overtureRecords: ReadonlyArray<OvertureInfraRecord>
): T[] {
    if (overtureRecords.length === 0) return overpassRecords;

    const bucket = new Map<string, OvertureInfraRecord[]>();
    const bucketKey = (lat: number, lng: number) =>
        `${Math.floor(lat / DEDUP_RADIUS_DEG)},${Math.floor(lng / DEDUP_RADIUS_DEG)}`;

    for (const r of overtureRecords) {
        if (!POINT_TYPES.has(r.type)) continue;
        const key = bucketKey(r.lat, r.lng);
        const list = bucket.get(key);
        if (list) list.push(r);
        else bucket.set(key, [r]);
    }

    const kept: T[] = [];
    for (const r of overpassRecords) {
        if (!POINT_TYPES.has(r.type)) { kept.push(r); continue; }
        const baseLatCell = Math.floor(r.lat / DEDUP_RADIUS_DEG);
        const baseLngCell = Math.floor(r.lng / DEDUP_RADIUS_DEG);
        let duplicate = false;
        outer: for (let dLat = -1; dLat <= 1; dLat++) {
            for (let dLng = -1; dLng <= 1; dLng++) {
                const list = bucket.get(`${baseLatCell + dLat},${baseLngCell + dLng}`);
                if (!list) continue;
                for (const o of list) {
                    if (o.type !== r.type) continue;
                    const dy = o.lat - r.lat;
                    const dx = o.lng - r.lng;
                    if (dy * dy + dx * dx <= DEDUP_RADIUS_DEG * DEDUP_RADIUS_DEG) {
                        duplicate = true;
                        break outer;
                    }
                }
            }
        }
        if (!duplicate) kept.push(r);
    }
    return kept;
}
