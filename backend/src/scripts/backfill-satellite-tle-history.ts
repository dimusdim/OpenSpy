import { DatabaseService } from '../db/database.service';

async function countMissing(database: DatabaseService): Promise<number> {
    const result = await database.query<{ count: string }>(
        `
            SELECT COUNT(*)::text AS count
            FROM core.orbital_elements
            WHERE tle_epoch_at IS NULL
               OR fetched_at IS NULL
               OR provider IS NULL
               OR source_publication_at IS NULL
        `,
    );
    return Number(result?.rows[0]?.count || 0);
}

async function serviceCompressedChunks(database: DatabaseService, action: 'decompress' | 'compress'): Promise<void> {
    const functionName = action === 'decompress' ? 'decompress_chunk' : 'compress_chunk';
    const flagName = action === 'decompress' ? 'if_not_decompressed' : 'if_not_compressed';
    await database.query(
        `
            DO $$
            DECLARE
                chunk regclass;
            BEGIN
                IF to_regproc('show_chunks') IS NULL OR to_regproc('${functionName}') IS NULL THEN
                    RAISE NOTICE 'Timescale chunk function ${functionName} is unavailable; skipping ${action}';
                    RETURN;
                END IF;

                FOR chunk IN SELECT show_chunks('core.orbital_elements'::regclass)
                LOOP
                    BEGIN
                        EXECUTE format('SELECT ${functionName}(%L::regclass, ${flagName} => true)', chunk::text);
                    EXCEPTION WHEN OTHERS THEN
                        RAISE NOTICE 'Skipping ${action} for chunk %: %', chunk::text, SQLERRM;
                    END;
                END LOOP;
            END $$;
        `,
    );
}

async function backfill(database: DatabaseService): Promise<number> {
    const result = await database.query<{ updated_count: string }>(
        `
            WITH updated AS (
                UPDATE core.orbital_elements
                SET
                    tle_epoch_at = COALESCE(tle_epoch_at, app.parse_tle_epoch_at(tle_line1)),
                    fetched_at = COALESCE(fetched_at, observed_at),
                    provider = COALESCE(provider, 'unknown-backfill'),
                    source_publication_at = COALESCE(source_publication_at, app.parse_tle_epoch_at(tle_line1))
                WHERE tle_line1 IS NOT NULL
                  AND (
                      tle_epoch_at IS NULL
                      OR fetched_at IS NULL
                      OR provider IS NULL
                      OR source_publication_at IS NULL
                  )
                RETURNING 1
            )
            SELECT COUNT(*)::text AS updated_count
            FROM updated
        `,
    );
    return Number(result?.rows[0]?.updated_count || 0);
}

async function main() {
    process.env.POSTGRES_ENABLED = process.env.POSTGRES_ENABLED || 'true';
    const database = new DatabaseService();
    await database.init();
    if (!database.isReady()) {
        throw new Error(`Database is not ready: ${database.getHealth().note || 'unknown error'}`);
    }

    const serviceCompressed = ['1', 'true', 'yes', 'on'].includes(
        String(process.env.SATELLITE_TLE_BACKFILL_SERVICE_COMPRESSED || '').toLowerCase(),
    );
    const beforeMissing = await countMissing(database);
    if (serviceCompressed) await serviceCompressedChunks(database, 'decompress');
    const updated = await backfill(database);
    if (serviceCompressed) await serviceCompressedChunks(database, 'compress');
    const afterMissing = await countMissing(database);

    console.log(JSON.stringify({
        ok: true,
        serviceCompressed,
        beforeMissing,
        updated,
        afterMissing,
    }, null, 2));
}

main().catch((error) => {
    console.error('[backfill-satellite-tle-history] failed:', error?.message || error);
    process.exitCode = 1;
});
