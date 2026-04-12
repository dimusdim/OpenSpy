/**
 * Standalone Overture Maps cache download script.
 * Downloads into a temp file, swaps atomically on success.
 * Run: npx ts-node scripts/overture-download.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = path.resolve(__dirname, '../data');
const CACHE_DB_PATH = path.join(CACHE_DIR, 'overture-cache.duckdb');
const CACHE_DOWNLOAD_PATH = path.join(CACHE_DIR, 'overture-cache.download.duckdb');
const VERSION = '2026-03-18.0';
const S3_REGION = 'us-west-2';
const S3_BASE = `s3://overturemaps-us-west-2/release/${VERSION}`;

// Same filters as overture.service.ts
const LAND_USE_SUBTYPES = ['military', 'resource_extraction'];
const INFRA_FILTERS: Record<string, string[]> = {
    power: ['plant', 'substation', 'line', 'cable'],
    water: ['reservoir', 'water_well', 'wastewater', 'dam'],
    communication: ['tower', 'mast', 'line'],
    airport: ['aerodrome'],
};

function infraWhere(): string {
    return Object.entries(INFRA_FILTERS)
        .map(([sub, classes]) => `(subtype = '${sub}' AND class IN (${classes.map(c => `'${c}'`).join(',')}))`)
        .join(' OR ');
}

function elapsed(t0: number): string {
    const s = Math.round((Date.now() - t0) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function execOn(db: any, sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(sql, (err: Error | null) => { if (err) reject(err); else resolve(); });
    });
}

function countOn(db: any, table: string): Promise<number> {
    return new Promise((resolve, reject) => {
        db.all(`SELECT count(*)::INTEGER as c FROM ${table}`, (err: Error | null, rows: any[]) => {
            if (err) reject(err); else resolve(rows?.[0]?.c ?? 0);
        });
    });
}

function closeDb(db: any): Promise<void> {
    return new Promise((resolve) => { db.close(() => resolve()); });
}

async function main() {
    const duckdb = require('duckdb');
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    // Clean leftover temp files
    for (const f of [CACHE_DOWNLOAD_PATH, `${CACHE_DOWNLOAD_PATH}.wal`, `${CACHE_DOWNLOAD_PATH}.tmp`]) {
        if (fs.existsSync(f)) {
            const stat = fs.statSync(f);
            if (stat.isDirectory()) fs.rmSync(f, { recursive: true });
            else fs.unlinkSync(f);
            console.log(`Cleaned: ${path.basename(f)}`);
        }
    }

    console.log('════════════════════════════════════════════');
    console.log(' Overture Maps cache download');
    console.log(` Version: ${VERSION}`);
    console.log(` Target:  ${CACHE_DB_PATH}`);
    console.log(` Temp:    ${CACHE_DOWNLOAD_PATH}`);
    console.log('════════════════════════════════════════════');

    const tempDb = await new Promise<any>((resolve, reject) => {
        const db = new duckdb.Database(CACHE_DOWNLOAD_PATH, (err: Error | null) => {
            if (err) reject(err); else resolve(db);
        });
    });

    const totalT0 = Date.now();

    try {
        await execOn(tempDb, 'INSTALL spatial; LOAD spatial;');
        await execOn(tempDb, 'INSTALL httpfs; LOAD httpfs;');
        await execOn(tempDb, `SET s3_region='${S3_REGION}';`);

        // Step 1
        const subtypeList = LAND_USE_SUBTYPES.map(s => `'${s}'`).join(',');
        console.log('\n[1/2] land_use...');
        const t1 = Date.now();
        await execOn(tempDb, `
            CREATE TABLE land_use AS
            SELECT id, names.primary AS name, subtype, class,
                   (bbox.ymin + bbox.ymax) / 2 AS lat,
                   (bbox.xmin + bbox.xmax) / 2 AS lng,
                   filename
            FROM read_parquet('${S3_BASE}/theme=base/type=land_use/*',
                              hive_partitioning=1, filename=true)
            WHERE subtype IN (${subtypeList})
        `);
        const luCount = await countOn(tempDb, 'land_use');
        console.log(`  ${luCount} records (${elapsed(t1)})`);

        // Step 2
        console.log('\n[2/2] infrastructure...');
        const t2 = Date.now();
        await execOn(tempDb, `
            CREATE TABLE infra_points AS
            SELECT id, names.primary AS name, subtype, class,
                   (bbox.ymin + bbox.ymax) / 2 AS lat,
                   (bbox.xmin + bbox.xmax) / 2 AS lng,
                   filename
            FROM read_parquet('${S3_BASE}/theme=base/type=infrastructure/*',
                              hive_partitioning=1, filename=true)
            WHERE ${infraWhere()}
        `);
        const ipCount = await countOn(tempDb, 'infra_points');
        console.log(`  ${ipCount} records (${elapsed(t2)})`);

        // Meta
        await execOn(tempDb, `
            CREATE TABLE cache_meta (
                version VARCHAR, downloaded_at VARCHAR,
                land_use_count INTEGER, infra_points_count INTEGER,
                land_use_subtypes VARCHAR, infra_filters VARCHAR
            )
        `);
        await execOn(tempDb, `
            INSERT INTO cache_meta VALUES (
                '${VERSION}', '${new Date().toISOString()}',
                ${luCount}, ${ipCount},
                '${LAND_USE_SUBTYPES.join(',')}',
                '${JSON.stringify(INFRA_FILTERS).replace(/'/g, "''")}'
            )
        `);

        await execOn(tempDb, 'CHECKPOINT;');
        await closeDb(tempDb);

        // Clean WAL if exists
        const walPath = `${CACHE_DOWNLOAD_PATH}.wal`;
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

        // Atomic swap
        for (const f of [CACHE_DB_PATH, `${CACHE_DB_PATH}.wal`, `${CACHE_DB_PATH}.tmp`]) {
            if (fs.existsSync(f)) {
                const stat = fs.statSync(f);
                if (stat.isDirectory()) fs.rmSync(f, { recursive: true });
                else fs.unlinkSync(f);
            }
        }
        fs.renameSync(CACHE_DOWNLOAD_PATH, CACHE_DB_PATH);

        const diskMb = Math.round(fs.statSync(CACHE_DB_PATH).size / 1024 / 1024);
        console.log('\n════════════════════════════════════════════');
        console.log(` DONE: ${luCount + ipCount} records`);
        console.log(` land_use: ${luCount} | infra: ${ipCount}`);
        console.log(` Disk: ${diskMb} MB`);
        console.log(` Time: ${elapsed(totalT0)}`);
        console.log('════════════════════════════════════════════');

    } catch (err) {
        await closeDb(tempDb).catch(() => {});
        for (const f of [CACHE_DOWNLOAD_PATH, `${CACHE_DOWNLOAD_PATH}.wal`, `${CACHE_DOWNLOAD_PATH}.tmp`]) {
            if (fs.existsSync(f)) {
                try {
                    const stat = fs.statSync(f);
                    if (stat.isDirectory()) fs.rmSync(f, { recursive: true });
                    else fs.unlinkSync(f);
                } catch {}
            }
        }
        console.error('\nDOWNLOAD FAILED:', err);
        console.error('Old cache (if any) is untouched.');
        process.exit(1);
    }
}

main();
