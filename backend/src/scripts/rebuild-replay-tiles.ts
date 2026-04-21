import 'dotenv/config';
import { databaseService } from '../db/database.service';
import { ReplayQueryService } from '../services/replay-query.service';
import { ReplayTileBuilderService } from '../services/replay-tile-builder.service';

function readArg(name: string): string | null {
    const index = process.argv.indexOf(name);
    if (index < 0) return null;
    return process.argv[index + 1] || null;
}

async function main() {
    process.env.POSTGRES_ENABLED = process.env.POSTGRES_ENABLED || 'true';
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:5432/openspy';

    const from = readArg('--from');
    const to = readArg('--to');
    if (!from || !to) {
        throw new Error('Usage: ts-node src/scripts/rebuild-replay-tiles.ts --from ISO --to ISO [--layers a,b,c] [--z 0]');
    }

    const parsedFrom = new Date(from);
    const parsedTo = new Date(to);
    if (Number.isNaN(parsedFrom.getTime()) || Number.isNaN(parsedTo.getTime())) {
        throw new Error('Invalid --from/--to ISO timestamps');
    }

    await databaseService.init();
    if (!databaseService.isReady()) {
        throw new Error('Database is not ready');
    }

    const layersArg = readArg('--layers');
    const layers = (layersArg || 'aircraft,vessel,disasters,fire,jamming,outage,conflict,gfw,cable,pipeline,airspace')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    const zArg = readArg('--z');
    const z = zArg ? Number(zArg) : 0;
    if (!Number.isInteger(z) || z < 0 || z > 6) {
        throw new Error('Invalid --z (expected integer 0..6)');
    }

    const replayQueryService = new ReplayQueryService(databaseService);
    const builder = new ReplayTileBuilderService(databaseService, replayQueryService);
    const manifest = await builder.buildTiles({
        from: parsedFrom.toISOString(),
        to: parsedTo.toISOString(),
        layers,
        z,
    });
    const tileCount = Object.values(manifest.layers).reduce((sum, layer) => sum + layer.tiles.length, 0);
    console.log(JSON.stringify({
        from: manifest.from,
        to: manifest.to,
        layers: Object.keys(manifest.layers),
        tileCount,
    }, null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
});
