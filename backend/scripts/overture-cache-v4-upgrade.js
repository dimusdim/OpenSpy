#!/usr/bin/env node
/**
 * Upgrade an existing Overture DuckDB cache to schema revision 4.
 *
 * This avoids re-downloading unchanged land_use and point infrastructure rows.
 * It rebuilds only the geometry-heavy render tables:
 *   - infra_lines: power_line + minor_line + cable
 *   - pipeline_lines: all utility/pipeline line geometry
 *
 * Usage:
 *   node scripts/overture-cache-v4-upgrade.js
 */
const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

const CACHE_DIR = path.resolve(__dirname, '../data');
const LIVE = path.join(CACHE_DIR, 'overture-cache.duckdb');
const VERSION = process.env.OVERTURE_VERSION || '2026-03-18.0';
const S3 = `s3://overturemaps-us-west-2/release/${VERSION}`;
const SCHEMA_REVISION = 4;

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, ...params, (err) => err ? reject(err) : resolve());
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, ...params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function count(db, table) {
    return all(db, `SELECT count(*)::INTEGER AS c FROM ${table}`).then((rows) => rows[0].c);
}

function close(db) {
    return new Promise((resolve) => db.close(() => resolve()));
}

function elapsed(t0) {
    const s = Math.round((Date.now() - t0) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

async function ensureColumn(db, columnSql) {
    try {
        await run(db, columnSql);
    } catch (err) {
        if (!String(err?.message || err).includes('already exists')) throw err;
    }
}

async function main() {
    if (!fs.existsSync(LIVE)) {
        throw new Error(`Missing Overture cache: ${LIVE}`);
    }

    console.log('════════════════════════════════════════');
    console.log(' Overture cache schema v4 upgrade');
    console.log(` Version: ${VERSION}`);
    console.log(` DB:      ${LIVE}`);
    console.log('════════════════════════════════════════');

    const db = await new Promise((resolve, reject) => {
        let handle;
        handle = new duckdb.Database(LIVE, (err) => err ? reject(err) : resolve(handle));
    });
    const totalT0 = Date.now();

    try {
        await run(db, 'INSTALL spatial; LOAD spatial;');
        await run(db, 'INSTALL httpfs; LOAD httpfs;');
        await run(db, "SET s3_region='us-west-2';");

        const before = await all(db, 'SELECT * FROM cache_meta LIMIT 1').catch(() => []);
        console.log('[meta:before]', JSON.stringify(before[0] || {}, null, 2));

        console.log('\n[1/2] Rebuild infra_lines: power_line + minor_line + cable');
        let t = Date.now();
        await run(db, 'DROP TABLE IF EXISTS infra_lines;');
        await run(db, `
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
            FROM read_parquet('${S3}/theme=base/type=infrastructure/*',
                              hive_partitioning=1, filename=true)
            WHERE subtype = 'power'
              AND class IN ('power_line', 'minor_line', 'cable')
        `);
        const infraLines = await count(db, 'infra_lines');
        console.log(`  infra_lines=${infraLines} (${elapsed(t)})`);

        console.log('\n[2/2] Rebuild pipeline_lines: utility/pipeline geometry');
        t = Date.now();
        await run(db, 'DROP TABLE IF EXISTS pipeline_lines;');
        await run(db, `
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
            FROM read_parquet('${S3}/theme=base/type=infrastructure/*',
                              hive_partitioning=1, filename=true)
            WHERE subtype = 'utility'
              AND class = 'pipeline'
        `);
        const pipelineLines = await count(db, 'pipeline_lines');
        console.log(`  pipeline_lines=${pipelineLines} (${elapsed(t)})`);

        await ensureColumn(db, 'ALTER TABLE cache_meta ADD COLUMN infra_lines_count INTEGER;');
        await ensureColumn(db, 'ALTER TABLE cache_meta ADD COLUMN pipeline_lines_count INTEGER;');
        await ensureColumn(db, 'ALTER TABLE cache_meta ADD COLUMN schema_revision INTEGER;');
        await run(
            db,
            `UPDATE cache_meta
             SET infra_lines_count = ?,
                 pipeline_lines_count = ?,
                 schema_revision = ?,
                 downloaded_at = ?,
                 version = ?`,
            [infraLines, pipelineLines, SCHEMA_REVISION, new Date().toISOString(), VERSION],
        );

        await run(db, 'CHECKPOINT;');
        const after = await all(db, 'SELECT * FROM cache_meta LIMIT 1');
        const mb = Math.round(fs.statSync(LIVE).size / 1024 / 1024);
        console.log('\n[meta:after]', JSON.stringify(after[0] || {}, null, 2));
        console.log('════════════════════════════════════════');
        console.log(` DONE: infra_lines=${infraLines}, pipeline_lines=${pipelineLines}, disk=${mb} MB`);
        console.log(` Time: ${elapsed(totalT0)}`);
        console.log('════════════════════════════════════════');
    } finally {
        await close(db);
    }
}

main().catch((err) => {
    console.error('FAILED:', err?.message || err);
    process.exit(1);
});
