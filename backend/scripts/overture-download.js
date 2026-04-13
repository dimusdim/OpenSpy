#!/usr/bin/env node
/**
 * Standalone Overture cache download. Writes to temp file, atomic swap on success.
 * Usage: node scripts/overture-download.js
 */
const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

const CACHE_DIR = path.resolve(__dirname, '../data');
const LIVE = path.join(CACHE_DIR, 'overture-cache.duckdb');
const TEMP = path.join(CACHE_DIR, 'overture-cache.download.duckdb');
const VERSION = '2026-03-18.0';
const S3 = `s3://overturemaps-us-west-2/release/${VERSION}`;

fs.mkdirSync(CACHE_DIR, { recursive: true });
[TEMP, TEMP + '.wal', TEMP + '.tmp'].forEach(f => {
    try { const s = fs.statSync(f); s.isDirectory() ? fs.rmSync(f, { recursive: true }) : fs.unlinkSync(f); } catch {}
});

function run(db, sql) { return new Promise((res, rej) => db.run(sql, e => e ? rej(e) : res())); }
function count(db, t) { return new Promise((res, rej) => db.all(`SELECT count(*)::INTEGER c FROM ${t}`, (e, r) => e ? rej(e) : res(r[0].c))); }
function close(db) { return new Promise(r => db.close(() => r())); }
function elapsed(t0) { const s = Math.round((Date.now() - t0) / 1000); return s < 60 ? s + 's' : Math.floor(s/60) + 'm' + (s%60) + 's'; }

async function main() {
    console.log('════════════════════════════════════════');
    console.log(' Overture Maps cache download');
    console.log(` Version: ${VERSION}`);
    console.log(` Live:    ${LIVE}`);
    console.log(` Temp:    ${TEMP}`);
    console.log('════════════════════════════════════════');

    const db = await new Promise((res, rej) => { const d = new duckdb.Database(TEMP, e => e ? rej(e) : res(d)); });
    const t0 = Date.now();

    try {
        await run(db, 'INSTALL spatial; LOAD spatial;');
        await run(db, 'INSTALL httpfs; LOAD httpfs;');
        await run(db, `SET s3_region='us-west-2';`);

        console.log('\n[1/2] land_use (military, resource_extraction)...');
        let t = Date.now();
        await run(db, `CREATE TABLE land_use AS SELECT id, names.primary AS name, subtype, class, (bbox.ymin+bbox.ymax)/2 AS lat, (bbox.xmin+bbox.xmax)/2 AS lng, filename FROM read_parquet('${S3}/theme=base/type=land_use/*', hive_partitioning=1, filename=true) WHERE subtype IN ('military','resource_extraction')`);
        const lu = await count(db, 'land_use');
        console.log(`  ${lu} records (${elapsed(t)})`);

        console.log('\n[2/2] infrastructure...');
        t = Date.now();
        await run(db, `CREATE TABLE infra_points AS SELECT id, names.primary AS name, subtype, class, (bbox.ymin+bbox.ymax)/2 AS lat, (bbox.xmin+bbox.xmax)/2 AS lng, filename FROM read_parquet('${S3}/theme=base/type=infrastructure/*', hive_partitioning=1, filename=true) WHERE (subtype='power' AND class IN ('plant','substation','line','cable')) OR (subtype='water' AND class IN ('reservoir','water_well','wastewater','dam')) OR (subtype='communication' AND class IN ('tower','mast','line')) OR (subtype='airport' AND class IN ('aerodrome'))`);
        const ip = await count(db, 'infra_points');
        console.log(`  ${ip} records (${elapsed(t)})`);

        await run(db, `CREATE TABLE cache_meta (version VARCHAR, downloaded_at VARCHAR, land_use_count INTEGER, infra_points_count INTEGER)`);
        await run(db, `INSERT INTO cache_meta VALUES ('${VERSION}','${new Date().toISOString()}',${lu},${ip})`);
        await run(db, 'CHECKPOINT;');
        await close(db);

        // Clean WAL
        try { fs.unlinkSync(TEMP + '.wal'); } catch {}

        // Atomic swap
        [LIVE, LIVE + '.wal', LIVE + '.tmp'].forEach(f => {
            try { const s = fs.statSync(f); s.isDirectory() ? fs.rmSync(f, { recursive: true }) : fs.unlinkSync(f); } catch {}
        });
        fs.renameSync(TEMP, LIVE);

        const mb = Math.round(fs.statSync(LIVE).size / 1024 / 1024);
        console.log('\n════════════════════════════════════════');
        console.log(` DONE: ${lu + ip} records (${mb} MB)`);
        console.log(` Time: ${elapsed(t0)}`);
        console.log('════════════════════════════════════════');
    } catch (err) {
        await close(db).catch(() => {});
        [TEMP, TEMP + '.wal', TEMP + '.tmp'].forEach(f => { try { fs.unlinkSync(f); } catch {} });
        console.error('\nFAILED:', err.message);
        console.error('Old cache untouched.');
        process.exit(1);
    }
}

main();
