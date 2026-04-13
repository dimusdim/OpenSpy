/**
 * Overture Maps infrastructure — local DuckDB point cache.
 *
 * On first startup, extracts point data (no geometry) from Overture's
 * public S3 GeoParquet into a local DuckDB file. Subsequent startups
 * reuse the cache. All viewport queries hit local disk (milliseconds).
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
}

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

// Build SQL WHERE for infrastructure
function infraWhere(): string {
    return Object.entries(INFRA_FILTERS)
        .map(([sub, cls]) => {
            const list = cls.map(c => `'${c}'`).join(',');
            return `(subtype = '${sub}' AND class IN (${list}))`;
        })
        .join('\n               OR ');
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

// Types that /api/infrastructure serves (all point types except power_line)
const INFRA_ENDPOINT_TYPES = new Set<OvertureInfraType>([
    'power_plant', 'refinery', 'desalination', 'military',
    'power_substation', 'communication_tower', 'aerodrome', 'dam',
]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OVERTURE_VERSION = '2026-03-18.0';
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
    // Mutex queue: DuckDB Node.js binding deadlocks when multiple
    // db.all() calls run concurrently on the same Database handle.
    // This queue serializes all queries so only one runs at a time.
    private _queryQueue: Promise<any> = Promise.resolve();
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
            const ageMs = Date.now() - new Date(rows[0].downloaded_at).getTime();
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            this._status.cacheAge = ageDays < 1 ? '<1d' : `${Math.floor(ageDays)}d`;
            return true;
        } catch (err) {
            // DuckDB may not be ready yet (cold boot, locked file).
            // Don't treat a transient query failure as "stale" — that
            // triggers a 25-min re-download. If the DB file exists on
            // disk, assume the cache is valid.
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
                `SELECT land_use_count, infra_points_count, downloaded_at,
                        version FROM cache_meta LIMIT 1`
            );
            if (rows.length > 0) {
                this._status.records =
                    (rows[0].land_use_count ?? 0) + (rows[0].infra_points_count ?? 0);
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
    private execOn(db: any, sql: string): Promise<void> {
        return new Promise((resolve, reject) => {
            db.run(sql, (err: Error | null) => {
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
        console.log('[Overture]  Downloading Overture point cache');
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

            // ---- Step 2: infrastructure ----
            this._status.step = '[2/2] infrastructure (power, water, communication, airport)';
            console.log(`[Overture] ${this._status.step}...`);
            const t2 = Date.now();
            await this.execOn(tempDb, `
                CREATE TABLE infra_points AS
                SELECT id, names.primary AS name, subtype, class,
                       (bbox.ymin + bbox.ymax) / 2 AS lat,
                       (bbox.xmin + bbox.xmax) / 2 AS lng,
                       filename
                FROM read_parquet('${s3Base}/theme=base/type=infrastructure/*',
                                  hive_partitioning=1, filename=true)
                WHERE ${infraWhere()}
            `);
            const ipCount = await this.countTableOn(tempDb, 'infra_points');
            console.log(`[Overture]   ${ipCount} records (${this.elapsed(t2)})`);

            // ---- Metadata ----
            await this.execOn(tempDb, `
                CREATE TABLE cache_meta (
                    version VARCHAR, downloaded_at VARCHAR,
                    land_use_count INTEGER, infra_points_count INTEGER,
                    land_use_subtypes VARCHAR, infra_filters VARCHAR
                )
            `);
            await this.execOn(tempDb, `
                INSERT INTO cache_meta VALUES (
                    '${this.version}', '${new Date().toISOString()}',
                    ${luCount}, ${ipCount},
                    '${LAND_USE_SUBTYPES.join(',')}',
                    '${JSON.stringify(INFRA_FILTERS).replace(/'/g, "''")}'
                )
            `);

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

            this._status.records = luCount + ipCount;
            this._status.cacheAge = '<1d';
            this.updateDiskSize();
            this.ready = true;
            this._status.state = 'ready';
            this._status.step = '';

            console.log('[Overture] ════════════════════════════════════════════');
            console.log(`[Overture]  DONE: ${luCount + ipCount} records`);
            console.log(`[Overture]  land_use: ${luCount} | infra: ${ipCount}`);
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

        const rows = await this.query<any>(`
            SELECT id, name, subtype, class, lat, lng FROM infra_points
            WHERE subtype = 'power'
              AND lat BETWEEN ${south} AND ${north}
              AND lng BETWEEN ${west} AND ${east}
            LIMIT ${QUERY_LIMIT}
        `);

        const records: OvertureInfraRecord[] = [];
        for (const row of rows) {
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
        return records;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private exec(sql: string): Promise<void> {
        const run = () => new Promise<void>((resolve, reject) => {
            if (!this.db) return reject(new Error('DuckDB not initialized'));
            this.db.run(sql, (err: Error | null) => {
                if (err) reject(err); else resolve();
            });
        });
        this._queryQueue = this._queryQueue.then(() => run(), () => run());
        return this._queryQueue as Promise<void>;
    }

    private query<T = any>(sql: string): Promise<T[]> {
        // Serialize through the queue — DuckDB's Node.js binding deadlocks
        // when multiple db.all() calls overlap on a single Database handle.
        const run = () => new Promise<T[]>((resolve, reject) => {
            if (!this.db) return reject(new Error('DuckDB not initialized'));
            this.db.all(sql, (err: Error | null, rows: T[]) => {
                if (err) reject(err); else resolve(rows ?? []);
            });
        });
        this._queryQueue = this._queryQueue.then(() => run(), () => run());
        return this._queryQueue as Promise<T[]>;
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
