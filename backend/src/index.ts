import 'dotenv/config';
import './telemetry/bootstrap';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import compression from 'compression';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { recordRateLimitReject, recordReplayRequest, recordInfraFetch, recordReplayTileBundle, recordReplayTileBundlePhase, withSpan } from './telemetry/observability';
import { logPerfEvent, logPerfEventFromClient } from './telemetry/perf-log';

// Global process-level safety nets. Without these, a single upstream HTTP
// client throwing during a response-parsing phase will bring the whole
// backend down and force nodemon to restart. nodemon restart takes ~2 s
// during which every /api/* call fails with ECONNREFUSED and the smoke
// test cascades. Logging instead keeps the server alive while still
// making the failure loud.
process.on('unhandledRejection', (reason, _promise) => {
    console.error('[process] Unhandled Promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[process] Uncaught exception:', err);
});
import { SatelliteService } from './services/satellite.service';
import { SpectatorService } from './services/spectator.service';
import { LiveStreamService } from './services/live-stream.service';
import { ExtendedDataService } from './services/extended.service';
import { GPSJamService } from './services/gpsjam.service';
import { WebcamsService } from './services/webcams.service';
import { InfrastructureService } from './services/infrastructure.service';
import { OvertureService, dedupAgainstOverture } from './services/overture.service';
import { IODAService } from './services/ioda.service';
import { OilPricesService } from './services/oilprices.service';
import { EnergyService } from './services/energy.service';
import { TomTomService } from './services/tomtom.service';
import { HereTrafficService } from './services/here.service';
import { ACLEDService } from './services/acled.service';
import { AirspaceService } from './services/airspace.service';
import { GFWService } from './services/gfw.service';
import { CloudflareService } from './services/cloudflare.service';
import { WindyService } from './services/windy.service';
import { GDELTService } from './services/gdelt.service';
import { setupAIImageRoutes } from './routes/ai-image';
import { databaseService } from './db/database.service';
import { ViewStateRepository } from './repositories/view-state.repository';
import { SelectionRepository } from './repositories/selection.repository';
import { CatalogBootstrapService } from './services/catalog-bootstrap.service';
import { CatalogReadService } from './services/catalog-read.service';
import { ViewControlService } from './services/view-control.service';
import { RuntimeStateRepository } from './repositories/runtime-state.repository';
import { SourcePersistenceService } from './services/source-persistence.service';
import { EventQueryService } from './services/event-query.service';
import { EntityQueryService } from './services/entity-query.service';
import { AssetQueryService } from './services/asset-query.service';
import { LiveProjectionService } from './services/live-projection.service';
import { ReplayQueryService } from './services/replay-query.service';
import { ReplayTileBuilderService } from './services/replay-tile-builder.service';
import { ReplayRenderBatchService } from './services/replay-render-batch.service';

// CORS origin whitelist — comma-separated list in ALLOWED_ORIGINS env var.
// Defaults to localhost dev ports if unset.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3737,http://localhost:3000,http://127.0.0.1:3737,http://127.0.0.1:3000')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
        // Allow same-origin and tools without origin (curl, Postman) in dev.
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'DELETE'],
};

// In production, raw err.message can leak Postgres column names, filesystem
// paths, and upstream API bodies. sendError returns only a requestId to the
// client and logs the full error server-side. In dev the message flows through
// so local debugging keeps working. Used from ~44 handler catch blocks.
function sendError(res: express.Response, err: any): void {
    if (res.headersSent) return;
    const requestId = Math.random().toString(36).slice(2, 10);
    const isProd = process.env.NODE_ENV === 'production';
    console.error(`[error ${requestId}]`, err);
    const body = isProd
        ? { error: 'Internal error', requestId }
        : { error: err?.message ?? 'unknown error', requestId };
    res.status(500).json(body);
}

const app = express();
app.use(cors(corsOptions));
// Required because frontend runs under COEP: credentialless. Without CORP,
// cross-origin fetches and Socket.IO upgrades from 3737 to 3055 are blocked
// silently (Network tab only, no console error).
app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
});
app.use(compression({
    threshold: 1024,
    level: 6,
    // Skip compression for already-binary tile-bundle and static replay tiles:
    // msgpack barely compresses (1-2%) but gzip on a 30+ MB payload blocks
    // the event loop for ~30s and serialises subsequent requests.
    filter: (req, res) => {
        if (req.path === '/api/replay/tile-bundle') return false;
        if (req.path.startsWith('/api/replay/render-chunks/') && req.path.endsWith('/data')) return false;
        if (req.path.startsWith('/static/replay-tiles/')) return false;
        return compression.filter(req, res);
    },
}));
app.use(express.json({ limit: '50mb' }));
app.use('/static/replay-tiles', express.static(path.resolve(__dirname, '../var/replay-tiles'), {
    immutable: true,
    maxAge: '365d',
    setHeaders: (res) => {
        res.setHeader('Content-Type', 'application/msgpack');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
}));

type StorageStatusPayload = {
    db_bytes: number | null;
    disk_free_bytes: number | null;
    disk_total_bytes: number | null;
    disk_used_percent: number | null;
    db_percent_of_disk: number | null;
    updated_at: string;
};

let storageStatusCache: { expiresAt: number; value: StorageStatusPayload } | null = null;

async function collectStorageStatus(): Promise<StorageStatusPayload> {
    const now = Date.now();
    if (storageStatusCache && now < storageStatusCache.expiresAt) {
        return storageStatusCache.value;
    }

    let dbBytes: number | null = null;
    if (databaseService.isReady()) {
        try {
            const result = await databaseService.query<{ bytes: string }>(
                `SELECT pg_database_size(current_database())::text AS bytes`,
            );
            const parsed = Number(result?.rows?.[0]?.bytes || '0');
            dbBytes = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
        } catch (error: any) {
            console.warn('[status] failed to read database size:', error?.message || error);
        }
    }

    let diskFreeBytes: number | null = null;
    let diskTotalBytes: number | null = null;
    try {
        const dataRoot = path.resolve(process.cwd(), '..', '.local/postgres/data');
        const statfs = await fs.promises.statfs(dataRoot);
        const blockSize = Number(statfs.bsize || 0);
        const availableBlocks = Number(statfs.bavail || 0);
        const totalBlocks = Number(statfs.blocks || 0);
        const free = blockSize > 0 && availableBlocks >= 0 ? availableBlocks * blockSize : 0;
        const total = blockSize > 0 && totalBlocks > 0 ? totalBlocks * blockSize : 0;
        diskFreeBytes = Number.isFinite(free) ? free : null;
        diskTotalBytes = Number.isFinite(total) && total > 0 ? total : null;
    } catch (error: any) {
        console.warn('[status] failed to read disk usage:', error?.message || error);
    }

    const diskUsedPercent = diskTotalBytes && diskFreeBytes != null
        ? Number((((diskTotalBytes - diskFreeBytes) / diskTotalBytes) * 100).toFixed(1))
        : null;
    const dbPercentOfDisk = diskTotalBytes && dbBytes != null
        ? Number(((dbBytes / diskTotalBytes) * 100).toFixed(2))
        : null;

    const value: StorageStatusPayload = {
        db_bytes: dbBytes,
        disk_free_bytes: diskFreeBytes,
        disk_total_bytes: diskTotalBytes,
        disk_used_percent: diskUsedPercent,
        db_percent_of_disk: dbPercentOfDisk,
        updated_at: new Date().toISOString(),
    };
    storageStatusCache = {
        expiresAt: now + 30_000,
        value,
    };
    return value;
}

// ---------------------------------------------------------------------------
// User settings persistence (JSON file on disk)
// ---------------------------------------------------------------------------
const viewStateRepository = new ViewStateRepository(databaseService);
const selectionRepository = new SelectionRepository(databaseService);
const catalogBootstrapService = new CatalogBootstrapService(databaseService);
const catalogReadService = new CatalogReadService(databaseService);
const viewControlService = new ViewControlService(viewStateRepository, catalogReadService);
const runtimeStateRepository = new RuntimeStateRepository(databaseService);
const eventQueryService = new EventQueryService(databaseService);
const entityQueryService = new EntityQueryService(databaseService);
const assetQueryService = new AssetQueryService(databaseService);
const liveProjectionService = new LiveProjectionService(databaseService);
const replayQueryService = new ReplayQueryService(databaseService);
const replayTileBuilderService = new ReplayTileBuilderService(databaseService, replayQueryService);
const replayRenderBatchService = new ReplayRenderBatchService(replayQueryService, replayTileBuilderService);
const liveIngestEnabled = process.env.DISABLE_LIVE_INGEST !== 'true';
const REPLAY_TILE_REFRESH_LAYERS = ['aircraft', 'vessel', 'disasters', 'fire', 'jamming', 'outage', 'conflict', 'gfw', 'cable', 'pipeline', 'airspace'];
let replayTileRefreshInFlight = false;

async function refreshReplayTilesWindow(): Promise<void> {
    if (replayTileRefreshInFlight || !databaseService.isReady()) return;
    replayTileRefreshInFlight = true;
    try {
        const to = new Date();
        const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
        const manifest = await replayTileBuilderService.buildTiles({
            from: from.toISOString(),
            to: to.toISOString(),
            layers: REPLAY_TILE_REFRESH_LAYERS,
            z: 0,
        });
        const tileCount = Object.values(manifest.layers).reduce((sum, layer) => sum + layer.tiles.length, 0);
        console.log(`[ReplayTiles] Refreshed ${tileCount} tiles for last 24h @ z0`);
    } catch (error) {
        console.error('[ReplayTiles] Refresh failed:', error);
    } finally {
        replayTileRefreshInFlight = false;
    }
}

async function handleGetViewState(_req: express.Request, res: express.Response) {
    try {
        const data = await viewStateRepository.loadDefaultViewState();
        res.json(data);
    } catch (err) {
        console.error('[settings] failed to load persisted view state:', err);
        res.json({});
    }
}

async function handleSaveViewState(req: express.Request, res: express.Response) {
    try {
        await viewStateRepository.saveDefaultViewState(req.body ?? {});
        res.json({ ok: true });
    } catch (err: any) {
        sendError(res, err);
    }
}

app.get('/api/settings', handleGetViewState);
app.post('/api/settings', handleSaveViewState);
app.get('/api/view-state', handleGetViewState);
app.post('/api/view-state', handleSaveViewState);

app.get('/api/catalog/sources', async (_req, res) => {
    try {
        res.json(await catalogReadService.listSources());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/catalog/sources/:sourceId', async (req, res) => {
    try {
        const source = await catalogReadService.getSource(req.params.sourceId);
        if (!source) {
            res.status(404).json({ error: 'Source not found' });
            return;
        }
        res.json(source);
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/catalog/layers', async (_req, res) => {
    try {
        res.json(await catalogReadService.listLayers());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/catalog/layers/:layerId', async (req, res) => {
    try {
        const layer = await catalogReadService.getLayer(req.params.layerId);
        if (!layer) {
            res.status(404).json({ error: 'Layer not found' });
            return;
        }
        res.json(layer);
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/catalog/ui-taxonomy', async (_req, res) => {
    try {
        res.json(await catalogReadService.getUiTaxonomy());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/catalog/ui-taxonomy/node', async (req, res) => {
    try {
        const requestedId = String(req.query.id || '').trim();
        if (!requestedId) {
            res.status(400).json({ error: 'Missing taxonomy node id' });
            return;
        }
        const node = await catalogReadService.getUiTaxonomyNode(requestedId);
        if (!node) {
            res.status(404).json({ error: 'Taxonomy node not found' });
            return;
        }
        res.json(node);
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/catalog/ui-taxonomy/:nodeId', async (req, res) => {
    try {
        const node = await catalogReadService.getUiTaxonomyNode(req.params.nodeId);
        if (!node) {
            res.status(404).json({ error: 'Taxonomy node not found' });
            return;
        }
        res.json(node);
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/legend/tree', async (_req, res) => {
    try {
        res.json(await catalogReadService.getUiTaxonomy());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/legend/node', async (req, res) => {
    try {
        const requestedId = String(req.query.id || '').trim();
        if (!requestedId) {
            res.status(400).json({ error: 'Missing legend node id' });
            return;
        }
        const node = await catalogReadService.getUiTaxonomyNode(requestedId);
        if (!node) {
            res.status(404).json({ error: 'Legend node not found' });
            return;
        }
        res.json(node);
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/view-state/patch', async (req, res) => {
    try {
        const patch = req.body?.patch && typeof req.body.patch === 'object'
            ? req.body.patch
            : (req.body && typeof req.body === 'object' ? req.body : null);
        if (!patch) {
            res.status(400).json({ error: 'Missing patch object' });
            return;
        }
        const state = await viewControlService.patchState(patch);
        res.json({ updated: true, state });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/view-state/legend-node-state', async (req, res) => {
    try {
        const nodeId = String(req.body?.nodeId || req.body?.node_id || '').trim();
        const enabled = Boolean(req.body?.enabled);
        const target = req.body?.target === 'sources' ? 'sources' : 'visibility';
        if (!nodeId) {
            res.status(400).json({ error: 'Missing nodeId' });
            return;
        }
        const state = await viewControlService.setLegendNodeState(nodeId, enabled, target);
        res.json({ updated: true, nodeId, target, state });
    } catch (err: any) {
        if (/not found/i.test(err.message || '')) {
            res.status(404).json({ error: err.message });
            return;
        }
        sendError(res, err);
    }
});

app.post('/api/selections', async (req, res) => {
    try {
        const selection = await selectionRepository.saveSelection({
            selectionId: typeof req.body?.selectionId === 'string' ? req.body.selectionId : undefined,
            layerId: typeof req.body?.layerId === 'string' ? req.body.layerId : null,
            selectionMode: typeof req.body?.selectionMode === 'string' ? req.body.selectionMode : 'filter',
            predicate: req.body?.predicate && typeof req.body.predicate === 'object' ? req.body.predicate : {},
            geometryJson: req.body?.geometry && typeof req.body.geometry === 'object' ? req.body.geometry : null,
            metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {},
        });
        res.json({
            selection_id: selection.selection_id,
            layer: selection.layer_id,
            query_spec: selection.predicate,
            geometry: selection.geometry_json,
            metadata: selection.metadata,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/selections/:selectionId', async (req, res) => {
    try {
        const selection = await selectionRepository.getSelection(req.params.selectionId);
        if (!selection) {
            res.status(404).json({ error: 'Selection not found' });
            return;
        }
        res.json({
            selection_id: selection.selection_id,
            layer: selection.layer_id,
            query_spec: selection.predicate,
            geometry: selection.geometry_json,
            metadata: selection.metadata,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/selections/:selectionId/patch', async (req, res) => {
    try {
        const current = await selectionRepository.getSelection(req.params.selectionId);
        if (!current) {
            res.status(404).json({ error: 'Selection not found' });
            return;
        }
        const selection = await selectionRepository.saveSelection({
            selectionId: current.selection_id,
            layerId: typeof req.body?.layerId === 'string' ? req.body.layerId : current.layer_id,
            selectionMode: typeof req.body?.selectionMode === 'string' ? req.body.selectionMode : current.selection_mode,
            predicate: req.body?.predicate && typeof req.body.predicate === 'object'
                ? { ...(current.predicate || {}), ...req.body.predicate }
                : current.predicate,
            geometryJson: req.body?.geometry && typeof req.body.geometry === 'object' ? req.body.geometry : current.geometry_json,
            metadata: req.body?.metadata && typeof req.body.metadata === 'object'
                ? { ...(current.metadata || {}), ...req.body.metadata }
                : current.metadata,
        });
        res.json({
            selection_id: selection.selection_id,
            layer: selection.layer_id,
            query_spec: selection.predicate,
            geometry: selection.geometry_json,
            metadata: selection.metadata,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/map/apply-selection', async (req, res) => {
    try {
        const layer = String(req.body?.layer || '').trim();
        const selectionId = String(req.body?.selectionId || req.body?.selection_id || '').trim();
        const mode = ['replace', 'append', 'exclude', 'only'].includes(req.body?.mode) ? req.body.mode : 'only';
        if (!layer || !selectionId) {
            res.status(400).json({ error: 'Missing layer or selectionId' });
            return;
        }
        const state = await viewControlService.applySelection(layer, selectionId, mode);
        res.json({ applied: true, layer, selection_id: selectionId, mode, state });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/map/clear-selection', async (req, res) => {
    try {
        const layer = String(req.body?.layer || '').trim();
        if (!layer) {
            res.status(400).json({ error: 'Missing layer' });
            return;
        }
        const state = await viewControlService.clearSelection(layer);
        res.json({ cleared: true, layer, state });
    } catch (err: any) {
        sendError(res, err);
    }
});

// ---------------------------------------------------------------------------
// API Keys management — read/update .env keys at runtime
// ---------------------------------------------------------------------------

const ENV_FILE = path.resolve(__dirname, '../.env');

// Known API key env vars and their display labels
const API_KEY_DEFS: Record<string, { label: string; envVars: string[] }> = {
    aviation: { label: 'OpenSky Network', envVars: ['OPENSKY_USERNAME', 'OPENSKY_PASSWORD'] },
    maritime: { label: 'AISStream', envVars: ['AISSTREAM_API_KEY'] },
    satellites: { label: 'Space-Track.org', envVars: ['SPACETRACK_EMAIL', 'SPACETRACK_PASSWORD'] },
    webcams: { label: 'Windy API', envVars: ['WINDY_API_KEY'] },
    traffic: { label: 'TomTom', envVars: ['TOMTOM_API_KEY'] },
    conflicts: { label: 'ACLED', envVars: ['ACLED_KEY', 'ACLED_EMAIL'] },
    airspace: { label: 'OpenAIP', envVars: ['OPENAIP_API_KEY'] },
    gfw: { label: 'Global Fishing Watch', envVars: ['GFW_TOKEN'] },
    outages: { label: 'Cloudflare Radar', envVars: ['CLOUDFLARE_API_TOKEN'] },
};

app.get('/api/keys', (_req, res) => {
    // Return which keys are configured (masked) vs missing
    const result: Record<string, { label: string; keys: Record<string, { set: boolean; masked: string }> }> = {};
    for (const [source, def] of Object.entries(API_KEY_DEFS)) {
        const keys: Record<string, { set: boolean; masked: string }> = {};
        for (const envVar of def.envVars) {
            const val = process.env[envVar] || '';
            keys[envVar] = {
                set: val.length > 0,
                masked: val.length > 0 ? val.slice(0, 3) + '•'.repeat(Math.max(0, val.length - 3)) : '',
            };
        }
        result[source] = { label: def.label, keys };
    }
    res.json(result);
});

app.post('/api/keys', (req, res) => {
    try {
        const updates: Record<string, string> = req.body;
        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Expected { ENV_VAR: value } object' });
        }

        // Read existing .env
        let envContent = '';
        if (fs.existsSync(ENV_FILE)) {
            envContent = fs.readFileSync(ENV_FILE, 'utf-8');
        }

        // Update each key
        for (const [key, value] of Object.entries(updates)) {
            // Validate key is in our known list
            const isKnown = Object.values(API_KEY_DEFS).some(d => d.envVars.includes(key));
            if (!isKnown) continue;

            // Update process.env immediately (no restart needed for new connections)
            process.env[key] = value;

            // Update .env file
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
                envContent += `\n${key}=${value}`;
            }
        }

        fs.writeFileSync(ENV_FILE, envContent);
        res.json({ ok: true, message: 'Keys updated. Some services may need reconnection.' });
    } catch (err: any) {
        sendError(res, err);
    }
});

// Simple in-memory rate limiter.
//
// Important: historical replay is a legitimate high-churn UI path
// (timeline seek + playback), so it must not share the same small bucket as
// the rest of `/api/*`. Otherwise the frontend starts rate-limiting itself
// during normal scrubbing and playback.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 600;
const STATUS_RATE_LIMIT_MAX = 600;
const INFRA_RATE_LIMIT_MAX = 1_200;
const REPLAY_RATE_LIMIT_MAX = 2_400;

function classifyRateLimit(reqPath: string): { bucket: string; limitMax: number } {
    if (reqPath.startsWith('/api/replay/')) {
        return { bucket: 'replay', limitMax: REPLAY_RATE_LIMIT_MAX };
    }
    if (reqPath === '/api/status') {
        return { bucket: 'status', limitMax: STATUS_RATE_LIMIT_MAX };
    }
    if (reqPath === '/api/infrastructure' || reqPath === '/api/power-infra') {
        return { bucket: 'infrastructure', limitMax: INFRA_RATE_LIMIT_MAX };
    }
    return { bucket: 'default', limitMax: DEFAULT_RATE_LIMIT_MAX };
}

app.use((req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const { bucket: bucketName, limitMax } = classifyRateLimit(req.path);
    const bucketKey = `${ip}:${bucketName}`;
    const now = Date.now();
    const bucket = rateLimitMap.get(bucketKey);
    if (!bucket || now >= bucket.resetAt) {
        rateLimitMap.set(bucketKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
        bucket.count++;
        if (bucket.count > limitMax) {
            recordRateLimitReject(bucketName, req.path);
            res.status(429).json({ error: 'Too many requests' });
            return;
        }
    }
    next();
});

// Prune rate-limit buckets every 5 min so the Map doesn't grow unbounded.
setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateLimitMap) {
        if (now >= bucket.resetAt) rateLimitMap.delete(ip);
    }
}, 5 * 60_000);

// --- Input validators -------------------------------------------------------
const ICAO24_RE = /^[0-9a-f]{6}$/i;
const CALLSIGN_RE = /^[A-Z0-9]{1,8}$/i;
const INT_RE = /^-?\d+$/;

/**
 * Parse a 4-number bbox string in one of two orderings: south,west,north,east
 * (OSM/Overpass convention) or west,south,east,north (Tile/OpenInfraMap
 * convention). `order` picks which ordering to enforce. Returns null for:
 *   - wrong number of components or non-finite values
 *   - latitudes outside [-90,90] or longitudes outside [-180,180]
 *   - inverted boxes (south >= north or west >= east)
 */
type BboxOrder = 'swne' | 'wsen';
function parseBbox(bbox: string | undefined, order: BboxOrder = 'swne'): [number, number, number, number] | null {
    if (!bbox) return null;
    const parts = bbox.split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null;

    let south: number, west: number, north: number, east: number;
    if (order === 'swne') {
        [south, west, north, east] = parts;
    } else {
        [west, south, east, north] = parts;
    }

    // Range checks: latitudes are the half-circle, longitudes the full one.
    if (Math.abs(south) > 90 || Math.abs(north) > 90) return null;
    if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
    // Ordering: reject inverted / zero-area boxes so we never forward them
    // to upstream Overpass (where they'd either 400 or return 0 elements).
    // This also rejects antimeridian-crossing bboxes (west > east across
    // ±180°). That limitation is documented in tests/README.md; direct API
    // callers that need to cover the dateline should split into two halves
    // client-side (west..180 + -180..east). The frontend infrastructure
    // layer already handles this by skipping antimeridian viewports.
    if (south >= north || west >= east) return null;

    // Return the numbers back in the input order so callers can destructure
    // as they already do. This keeps existing `[south, west, north, east]`
    // and `[w, s, e, n]` destructures at call sites working.
    return parts as [number, number, number, number];
}

function normalizeLayerId(layerId: string | undefined): string | undefined {
    if (!layerId) return layerId;
    if (layerId === 'satellites') return 'satellite';
    return layerId;
}

function parseLayerScopeList(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(',')
        .map((part) => normalizeLayerId(part.trim()))
        .filter((part): part is string => Boolean(part));
}

function parseLayerLimitMap(value: string | undefined): Record<string, number> {
    if (!value) return {};
    const entries = value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    const result: Record<string, number> = {};
    for (const entry of entries) {
        const [rawLayerId, rawLimit] = entry.split(':');
        const layerId = normalizeLayerId(rawLayerId?.trim());
        const limit = parseOptionalPositiveLimit(rawLimit?.trim());
        if (!layerId || limit == null) continue;
        result[layerId] = limit;
    }
    return result;
}

// 2026-04-24: убрал жёсткий потолок Math.min(5000, ...) — это был скрытый
// максимум для любого endpoint'а использующего этот helper. Теперь если
// клиент явно передал limit=N, он получает ровно N. Защита от бреда остаётся:
// невалидное значение → fallback.
function parsePositiveLimit(value: string | undefined, fallback = 200): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.max(1, Math.trunc(parsed));
}

function parseOptionalPositiveLimit(value: string | undefined): number | undefined {
    if (!value || value === 'all') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.max(1, Math.trunc(parsed));
}

function parseOptionalPositiveGridDegrees(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.max(0.1, Math.min(10, parsed));
}

function parseIsoDateOrNull(value: string | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  },
  // Live snapshot is large (7k aircraft + 23k vessels = 9 MB JSON).
  // Without compression and a raised buffer the browser silently drops
  // the WS frame. perMessageDeflate compresses ~5–8x, gets payload to 1–2 MB.
  maxHttpBufferSize: 50 * 1024 * 1024,
  perMessageDeflate: { threshold: 1024 },
  httpCompression: { threshold: 1024 },
});
// Socket.IO bypasses Express middleware, so the global CORP header is not set
// on /socket.io/ responses. Without it the browser's COEP: credentialless
// silently blocks WebSocket upgrade and polling, leaving live data invisible.
io.engine.on('initial_headers', (headers: Record<string, string>) => {
    headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
});
io.engine.on('headers', (headers: Record<string, string>) => {
    headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
});

// Spectator Earth sensor catalog fetched at boot and merged into
// /api/satellites so the frontend can draw projected footprint cones
// sized to real swath widths. Passed into SatelliteService so the two
// share state and avoid a duplicate catalog fetch.
const sourcePersistenceService = new SourcePersistenceService(databaseService);
const spectatorService = new SpectatorService();
const satelliteService = new SatelliteService(spectatorService, sourcePersistenceService);
const liveStreamService = new LiveStreamService(io, sourcePersistenceService, liveProjectionService);
const extendedService = new ExtendedDataService(sourcePersistenceService);
const gpsJamService = new GPSJamService(sourcePersistenceService);
const windyService = new WindyService();
const webcamsService = new WebcamsService(windyService);
const infrastructureService = new InfrastructureService(sourcePersistenceService);
// Overture Maps (opt-in via OVERTURE_ENABLED=true). When enabled, its
// DuckDB+httpfs queries run in parallel with Overpass and the two
// result sets are merged + deduped per request. Disabled by default
// until we've validated the category/class mapping against live
// Overture data; flipping it off never degrades Overpass behaviour.
const overtureService = new OvertureService();
const iodaService = new IODAService(sourcePersistenceService);
const oilPricesService = new OilPricesService();
const energyService = new EnergyService();
const tomtomService = new TomTomService();
const hereTrafficService = new HereTrafficService();
const acledService = new ACLEDService(sourcePersistenceService);
const gdeltService = new GDELTService(sourcePersistenceService);
const airspaceService = new AirspaceService(sourcePersistenceService);
const gfwService = new GFWService(sourcePersistenceService);
const cloudflareService = new CloudflareService(sourcePersistenceService);

// AI Vision — image generation via OpenRouter Gemini Flash Image
setupAIImageRoutes(app);

app.get('/api/satellites', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        // 2026-04-24: default=null (весь каталог). Раньше 5000 скрывало
        // 3.8× спутников (реальных 19k). Клиент явно передаёт ?limit=N
        // только если хочет обрезку (напр. тесты).
        const rawLimit = typeof _req.query.limit === 'string' ? _req.query.limit.trim().toLowerCase() : '';
        let limit: number | null | undefined = null;
        if (rawLimit === 'all' || rawLimit === '0' || rawLimit === '') {
            limit = null;
        } else {
            const parsed = Number(rawLimit);
            if (!Number.isInteger(parsed) || parsed < 0) {
                res.status(400).json({ error: 'Invalid limit (expected positive integer or "all")' });
                return;
            }
            limit = parsed;
        }
        res.json(await liveProjectionService.getSatellites(limit));
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/satellites/recon', async (req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        const rawLimit = typeof req.query.limit === 'string' ? req.query.limit.trim().toLowerCase() : '';
        let limit: number | null | undefined = null;
        if (rawLimit === 'all' || rawLimit === '0' || rawLimit === '') {
            limit = null;
        } else {
            const parsed = Number(rawLimit);
            if (!Number.isInteger(parsed) || parsed < 0) {
                res.status(400).json({ error: 'Invalid limit (expected positive integer or "all")' });
                return;
            }
            limit = parsed;
        }
        res.json(await liveProjectionService.getReconSatellites(limit));
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/disasters', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getDisasterEvents());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/replay/events', async (req, res) => {
    if (!eventQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            eventId: req.query.eventId as string | undefined,
            eventKind: req.query.eventKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: parsePositiveLimit(req.query.limit as string | undefined, 200),
        };
        const [items, summary] = await Promise.all([
            eventQueryService.listSnapshots(filters),
            eventQueryService.summarizeSnapshots(filters),
        ]);
        res.json({
            mode: 'history',
            filters,
            summary,
            items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

// Bootstrap snapshot for live mode. Socket.IO drops large WS frames silently
// in-browser, so initial state must come over plain HTTP. Frontend fetches
// once on mount; periodic deltas still arrive via socket broadcast.
app.get('/api/live/snapshot', async (_req, res) => {
    try {
        const payload = await liveStreamService.getFullSnapshot();
        res.json(payload);
    } catch (err: any) {
        console.error('[api/live/snapshot] failed:', err?.message || err);
        res.status(500).json({ error: 'snapshot-failed' });
    }
});

app.get('/api/replay/render-chunks', async (req, res) => {
    if (!replayQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const at = parseIsoDateOrNull(req.query.at as string | undefined);
    if (!at) {
        res.status(400).json({ error: 'Missing or invalid at timestamp' });
        return;
    }
    const from = parseIsoDateOrNull(req.query.from as string | undefined) || at;
    const to = parseIsoDateOrNull(req.query.to as string | undefined) || at;

    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }

    const zRaw = req.query.z as string | undefined;
    const z = zRaw == null ? 0 : Number(zRaw);
    if (zRaw != null && (!Number.isInteger(z) || z < 0 || z > 6)) {
        res.status(400).json({ error: 'Invalid z (expected integer 0..6)' });
        return;
    }

    const layers = parseLayerScopeList(req.query.layers as string | undefined);
    if (layers.length === 0) {
        res.status(400).json({ error: 'render-chunks requires at least one layer' });
        return;
    }

    const aggregateFires = req.query.cluster === '0' || req.query.cluster === 'false'
        ? false
        : true;

    const routeStartedAt = performance.now();
    try {
        const response = await withSpan('replay.render_chunks', {
            'replay.layers': layers.join(','),
            'replay.layers.count': layers.length,
            'replay.at': at,
        }, async () => replayRenderBatchService.buildReplayChunks({
            at,
            from,
            to,
            layers,
            z,
            bbox: bbox || undefined,
            aggregateFires,
        }));
        const bytes = Object.values(response.layers)
            .flat()
            .reduce((sum, chunk) => sum + chunk.bytes.binary, 0);
        logPerfEvent('replay.render_chunks', {
            source: 'backend',
            at,
            layers,
            bytes,
            ms: Math.round(performance.now() - routeStartedAt),
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json(response);
    } catch (err: any) {
        console.error('[api/replay/render-chunks] failed:', err?.message || err);
        sendError(res, err);
    }
});

app.get('/api/replay/render-chunks/:chunkId/data', async (req, res) => {
    try {
        const read = await replayRenderBatchService.readChunkData(req.params.chunkId);
        if (!read) {
            res.status(404).json({ error: 'Render chunk not found' });
            return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('ETag', read.manifest.chunkId);
        res.send(read.buffer);
    } catch (err: any) {
        console.error('[api/replay/render-chunks/:chunkId/data] failed:', err?.message || err);
        sendError(res, err);
    }
});

app.get('/api/replay/render-chunks/:chunkId/features', async (req, res) => {
    try {
        const read = await replayRenderBatchService.readFeatureRefs(req.params.chunkId);
        if (!read) {
            res.status(404).json({ error: 'Render chunk not found' });
            return;
        }
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.json({
            chunkId: req.params.chunkId,
            at: read.manifest.at,
            layerId: read.manifest.layerId,
            features: read.features,
        });
    } catch (err: any) {
        console.error('[api/replay/render-chunks/:chunkId/features] failed:', err?.message || err);
        sendError(res, err);
    }
});

app.get('/api/replay/render-chunks/:chunkId/features/:featureIndex', async (req, res) => {
    const featureIndex = Number(req.params.featureIndex);
    if (!Number.isInteger(featureIndex) || featureIndex < 0) {
        res.status(400).json({ error: 'Invalid feature index' });
        return;
    }
    try {
        const feature = await replayRenderBatchService.readFeatureMetadata(req.params.chunkId, featureIndex);
        if (!feature) {
            res.status(404).json({ error: 'Render feature not found' });
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(feature);
    } catch (err: any) {
        console.error('[api/replay/render-chunks/:chunkId/features/:featureIndex] failed:', err?.message || err);
        sendError(res, err);
    }
});

app.get('/api/replay/render-point-deltas', async (req, res) => {
    if (!replayQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const at = parseIsoDateOrNull(req.query.at as string | undefined);
    if (!at) {
        res.status(400).json({ error: 'Missing or invalid at timestamp' });
        return;
    }
    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }
    const layers = parseLayerScopeList(req.query.layers as string | undefined);
    if (layers.length === 0) {
        res.status(400).json({ error: 'render-point-deltas requires at least one layer' });
        return;
    }
    const aggregateFires = req.query.cluster === '0' || req.query.cluster === 'false'
        ? false
        : true;

    const routeStartedAt = performance.now();
    try {
        if (String(req.query.format || '').toLowerCase() === 'bin') {
            if (layers.length !== 1) {
                res.status(400).json({ error: 'Binary render-point-deltas requires exactly one layer' });
                return;
            }
            const binary = await withSpan('replay.render_point_delta_binary', {
                'replay.layers': layers.join(','),
                'replay.layers.count': layers.length,
                'replay.at': at,
            }, async () => replayRenderBatchService.buildPointDeltaBinary({
                at,
                layers,
                bbox: bbox || undefined,
                aggregateFires,
            }));
            if (!binary) {
                res.status(404).json({ error: 'Render point delta not found' });
                return;
            }
            logPerfEvent('replay.render_point_delta_binary', {
                source: 'backend',
                at,
                layers,
                count: binary.count,
                bytes: binary.buffer.byteLength,
                ms: Math.round(performance.now() - routeStartedAt),
            });
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('X-Replay-At', binary.at);
            res.setHeader('X-Replay-Layer', binary.layerId);
            res.send(binary.buffer);
            return;
        }
        const response = await withSpan('replay.render_point_deltas', {
            'replay.layers': layers.join(','),
            'replay.layers.count': layers.length,
            'replay.at': at,
        }, async () => replayRenderBatchService.buildPointDeltas({
            at,
            layers,
            bbox: bbox || undefined,
            aggregateFires,
        }));
        logPerfEvent('replay.render_point_deltas', {
            source: 'backend',
            at,
            layers,
            count: Object.values(response.layers).reduce((sum, layer) => sum + layer.count, 0),
            ms: Math.round(performance.now() - routeStartedAt),
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json(response);
    } catch (err: any) {
        console.error('[api/replay/render-point-deltas] failed:', err?.message || err);
        sendError(res, err);
    }
});

app.get('/api/replay/render-feature', async (req, res) => {
    if (!replayQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }
    const at = parseIsoDateOrNull(req.query.at as string | undefined);
    const layerId = String(req.query.layerId || '');
    const family = String(req.query.family || '');
    const id = String(req.query.id || '');
    const hashRaw = req.query.hash != null ? Number(req.query.hash) : null;
    if (!at || !layerId || (!id && !Number.isFinite(hashRaw ?? NaN)) || !['entity', 'event', 'asset'].includes(family)) {
        res.status(400).json({ error: 'Missing or invalid at/layerId/family/id-or-hash' });
        return;
    }
    try {
        const feature = await replayRenderBatchService.readFeatureMetadataAt({
            at,
            layerId,
            family: family as any,
            id: id || undefined,
            hash: Number.isFinite(hashRaw ?? NaN) ? Number(hashRaw) : undefined,
            sourceId: req.query.sourceId ? String(req.query.sourceId) : null,
        });
        if (!feature) {
            res.status(404).json({ error: 'Render feature not found' });
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(feature);
    } catch (err: any) {
        console.error('[api/replay/render-feature] failed:', err?.message || err);
        sendError(res, err);
    }
});

app.get('/api/replay/manifest', async (req, res) => {
    if (!replayQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if (!from || !to) {
        res.status(400).json({ error: 'Missing or invalid from/to timestamp' });
        return;
    }

    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }

    const zRaw = req.query.z as string | undefined;
    const z = zRaw == null ? 0 : Number(zRaw);
    if (zRaw != null && (!Number.isInteger(z) || z < 0 || z > 6)) {
        res.status(400).json({ error: 'Invalid z (expected integer 0..6)' });
        return;
    }

    const layers = parseLayerScopeList(req.query.layers as string | undefined);
    if (layers.length === 0) {
        res.status(400).json({ error: 'Manifest requires at least one layer' });
        return;
    }

    try {
        const manifest = await replayTileBuilderService.buildManifest({
            from,
            to,
            layers,
            z,
            bbox: bbox || undefined,
        });
        res.json(manifest);
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/replay/tile/:layer/:z/:x/:y/:tBucketIso', async (req, res) => {
    if (!replayQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const layerId = normalizeLayerId(req.params.layer);
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    const tBucket = parseIsoDateOrNull(req.params.tBucketIso);
    if (!layerId || !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || !tBucket) {
        res.status(400).json({ error: 'Invalid tile coordinates or tBucket' });
        return;
    }

    try {
        const tile = await replayTileBuilderService.readTileBuffer({
            layerId,
            z,
            x,
            y,
            tBucket,
        });
        if (!tile) {
            res.status(404).json({ error: 'Replay tile not found' });
            return;
        }
        res.setHeader('Content-Type', 'application/msgpack');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('ETag', tile.entry.contentHash);
        res.send(tile.buffer);
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/perf-event', (req, res) => {
    const body = req.body;
    if (Array.isArray(body)) {
        for (const ev of body) logPerfEventFromClient(ev);
    } else {
        logPerfEventFromClient(body);
    }
    res.status(204).end();
});

app.post('/api/replay/tile-bundle', async (req, res) => {
    const urls: string[] = Array.isArray(req.body?.urls) ? req.body.urls : [];
    if (urls.length === 0) {
        res.status(400).json({ error: 'urls[] required' });
        return;
    }
    if (urls.length > 2000) {
        res.status(400).json({ error: 'urls[] too large (max 2000)' });
        return;
    }
    const tileRoot = path.resolve(__dirname, '../var/replay-tiles');
    try {
        const layerSet = new Set<string>();
        for (const u of urls) {
            if (typeof u !== 'string') continue;
            const parts = u.split('/');
            if (parts[3]) layerSet.add(parts[3]);
        }
        await withSpan('replay.tile_bundle', {
            'http.route': '/api/replay/tile-bundle',
            'replay.tiles': urls.length,
            'replay.layers': Array.from(layerSet).join(','),
        }, async () => {
            const t0 = performance.now();
            const tRead0 = performance.now();
            const buffers = await withSpan('replay.tile_bundle.read', {
                'replay.tiles': urls.length,
                'replay.layers': Array.from(layerSet).join(','),
            }, async () => Promise.all(urls.map(async (url) => {
                // url формат: /static/replay-tiles/{layer}/{z}/{x}/{y}/{filename}
                if (typeof url !== 'string' || !url.startsWith('/static/replay-tiles/')) return null;
                const rel = url.slice('/static/replay-tiles/'.length);
                if (rel.includes('..')) return null;
                const filePath = path.join(tileRoot, rel);
                const tOne = performance.now();
                try {
                    const buffer = await fs.promises.readFile(filePath);
                    const readMs = performance.now() - tOne;
                    if (readMs > 250) {
                        logPerfEvent('replay.tile_bundle_read_slow', {
                            source: 'backend',
                            url,
                            bytes: buffer.byteLength,
                            ms: Math.round(readMs),
                        });
                    }
                    return buffer;
                } catch {
                    return null;
                }
            })));
            const readMs = performance.now() - tRead0;
            const readBytes = buffers.reduce((acc, b) => acc + (b?.length || 0), 0);
            const missing = buffers.reduce((acc, b) => acc + (b ? 0 : 1), 0);
            recordReplayTileBundlePhase('read', urls.length, readBytes, readMs);

            const tEncode0 = performance.now();
            const out = await withSpan('replay.tile_bundle.encode', {
                'replay.tiles': urls.length,
                'replay.bytes.read': readBytes,
                'replay.missing': missing,
            }, async () => {
                const urlBufs = urls.map((u) => Buffer.from(u, 'utf8'));
                const totalSize = 4 + buffers.reduce((acc, b, i) => acc + 4 + urlBufs[i].length + 4 + (b?.length || 0), 0);
                const encoded = Buffer.allocUnsafe(totalSize);
                let off = 0;
                encoded.writeUInt32LE(buffers.length, off); off += 4;
                for (let i = 0; i < buffers.length; i += 1) {
                    const kb = urlBufs[i];
                    encoded.writeUInt32LE(kb.length, off); off += 4;
                    kb.copy(encoded, off); off += kb.length;
                    const pb = buffers[i];
                    const plen = pb?.length || 0;
                    encoded.writeUInt32LE(plen, off); off += 4;
                    if (pb && plen > 0) { pb.copy(encoded, off); off += plen; }
                }
                return encoded;
            });
            const encodeMs = performance.now() - tEncode0;
            recordReplayTileBundlePhase('encode', urls.length, out.length, encodeMs);

            const took = performance.now() - t0;
            recordReplayTileBundle(urls.length, out.length, took);
            logPerfEvent('replay.tile_bundle', {
                source: 'backend',
                tileCount: urls.length,
                bytes: out.length,
                ms: Math.round(took),
                readMs: Math.round(readMs),
                encodeMs: Math.round(encodeMs),
                missing,
                layers: Array.from(layerSet),
            });
            if (urls.length > 50 || took > 200) {
                console.log(`[tile-bundle] ${urls.length} tiles, ${out.length} bytes, ${Math.round(took)}ms read=${Math.round(readMs)}ms encode=${Math.round(encodeMs)}ms missing=${missing}`);
            }
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store');
            const tSend0 = performance.now();
            res.send(out);
            const sendMs = performance.now() - tSend0;
            recordReplayTileBundlePhase('send', urls.length, out.length, sendMs);
            logPerfEvent('replay.tile_bundle_phase', {
                source: 'backend',
                phase: 'send',
                tileCount: urls.length,
                bytes: out.length,
                ms: Math.round(sendMs),
                layers: Array.from(layerSet),
            });
        });
    } catch (err: any) {
        console.error('[api/replay/tile-bundle] failed:', err?.message || err);
        res.status(500).json({ error: err?.message || 'tile-bundle-failed' });
    }
});

// Cache satellite-TLE responses for ~5 min: TLE elements barely change in
// that window, but the underlying query returns ~19MB of data and dominates
// the seek path. Bucket by 5-minute slots so different seek times share the
// same response.
const SATELLITE_TLE_CACHE_TTL_MS = 5 * 60 * 1000;
const satelliteTleCache = new Map<string, { json: string; expiresAt: number }>();

app.get('/api/replay/satellite-tle', async (req, res) => {
    if (!replayQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const at = parseIsoDateOrNull(req.query.at as string | undefined);
    if (!at) {
        res.status(400).json({ error: 'Missing or invalid at timestamp' });
        return;
    }

    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }

    const limit = parseOptionalPositiveLimit(req.query.limit as string | undefined);
    const now = Date.now();
    const slot = Math.floor(new Date(at).getTime() / SATELLITE_TLE_CACHE_TTL_MS);
    const cacheKey = `${slot}|${limit ?? ''}|${bbox ? bbox.join(',') : ''}`;
    const cached = satelliteTleCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-OpenSpy-Cache', 'hit');
        res.send(cached.json);
        return;
    }
    try {
        const items = await replayQueryService.listSatelliteTleAt({
            at,
            layerId: 'satellite',
            bbox: bbox || undefined,
            limit,
        });
        const json = JSON.stringify({
            mode: 'historical-replay',
            replay_kind: 'satellite-tle',
            at,
            count: items.length,
            items,
        });
        satelliteTleCache.set(cacheKey, { json, expiresAt: now + SATELLITE_TLE_CACHE_TTL_MS });
        // Periodic cleanup
        if (satelliteTleCache.size > 64) {
            for (const [k, v] of satelliteTleCache.entries()) {
                if (v.expiresAt <= now) satelliteTleCache.delete(k);
            }
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-OpenSpy-Cache', 'miss');
        res.send(json);
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/replay/state', async (req, res) => {
    console.warn('[deprecated] /api/replay/state called');
    if (!replayQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const at = parseIsoDateOrNull(req.query.at as string | undefined);
    if (!at) {
        res.status(400).json({ error: 'Missing or invalid at timestamp' });
        return;
    }

    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }

    try {
        const replayLimit = parseOptionalPositiveLimit(req.query.limit as string | undefined);
        if ((req.query.limit as string | undefined) && replayLimit === undefined && req.query.limit !== 'all') {
            res.status(400).json({ error: 'Invalid limit (expected positive integer or \"all\")' });
            return;
        }

        const layerIds = parseLayerScopeList(req.query.layers as string | undefined);
        const layerLimitMap = parseLayerLimitMap(req.query.layerLimits as string | undefined);
        const aggregateFires = req.query.cluster === '0' || req.query.cluster === 'false'
            ? false
            : true;
        const routeStartedAt = performance.now();

        await withSpan('replay.state', {
            'replay.layers.count': layerIds.length,
            'replay.has_bbox': Boolean(bbox),
        }, async () => {
            const filters = {
                at,
                layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
                sourceId: req.query.sourceId as string | undefined,
                entityId: req.query.entityId as string | undefined,
                entityKind: req.query.entityKind as string | undefined,
                eventId: req.query.eventId as string | undefined,
                eventKind: req.query.eventKind as string | undefined,
                assetId: req.query.assetId as string | undefined,
                assetKind: req.query.assetKind as string | undefined,
                subtype: req.query.subtype as string | undefined,
                bbox: bbox || undefined,
                limit: replayLimit,
                aggregateFires,
            };

            let entities;
            let events;
            let assets;
            if (layerIds.length > 0) {
                const perLayer = await Promise.all(
                    layerIds.map(async (layerId) => {
                        const scoped = {
                            ...filters,
                            layerId,
                            limit: layerLimitMap[layerId] ?? replayLimit,
                        };
                        const [layerEntities, layerEvents, layerAssets] = await Promise.all([
                            replayQueryService.listEntityStateAt(scoped),
                            replayQueryService.listEventStateAt(scoped),
                            replayQueryService.listAssetStateAt(scoped),
                        ]);
                        return { layerEntities, layerEvents, layerAssets };
                    }),
                );
                entities = perLayer.flatMap((row) => row.layerEntities);
                events = perLayer.flatMap((row) => row.layerEvents);
                assets = perLayer.flatMap((row) => row.layerAssets);
            } else {
                [entities, events, assets] = await Promise.all([
                    replayQueryService.listEntityStateAt(filters),
                    replayQueryService.listEventStateAt(filters),
                    replayQueryService.listAssetStateAt(filters),
                ]);
            }

            recordReplayRequest(
                'state',
                performance.now() - routeStartedAt,
                entities.length + events.length + assets.length,
                layerIds.length > 0 ? layerIds.join(',') : filters.layerId || filters.sourceId || 'all',
            );

            res.json({
                mode: 'historical-replay',
                replay_kind: 'state',
                time_basis: 'observed',
                at,
                filters: {
                    ...filters,
                    ...(layerIds.length > 0 ? { layers: layerIds } : {}),
                },
                semantics: {
                    entities: 'latest entity snapshot <= at, with latest position fix <= at when available',
                    events: 'latest event snapshot <= at; valid_to is respected when present',
                    assets: 'latest asset snapshot <= at',
                },
                counts: {
                    entities: entities.length,
                    events: events.length,
                    assets: assets.length,
                },
                entities,
                events,
                assets,
            });
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/replay/track/:entityId', async (req, res) => {
    if (!replayQueryService.isReady() || !entityQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    const order = req.query.order === 'desc' ? 'desc' : 'asc';
    const stepSecondsRaw = req.query.stepSeconds as string | undefined;
    const stepSeconds = stepSecondsRaw ? Number(stepSecondsRaw) : undefined;
    if (stepSecondsRaw && (!Number.isFinite(stepSeconds) || stepSeconds! <= 0)) {
        res.status(400).json({ error: 'Invalid stepSeconds (expected positive integer)' });
        return;
    }

    try {
        const routeStartedAt = performance.now();
        const [entityState, items] = await Promise.all([
            replayQueryService.listEntityStateAt({
                at: to || new Date().toISOString(),
                entityId: req.params.entityId,
                limit: 1,
            }),
            req.params.entityId.startsWith('satellite:')
                ? replayQueryService.listSatelliteTrack({
                    entityId: req.params.entityId,
                    from: from || undefined,
                    to: to || undefined,
                    limit: parsePositiveLimit(req.query.limit as string | undefined, 1000),
                    order,
                    stepSeconds: stepSeconds || undefined,
                })
                : entityQueryService.listTrack({
                    entityId: req.params.entityId,
                    from: from || undefined,
                    to: to || undefined,
                    limit: parsePositiveLimit(req.query.limit as string | undefined, 1000),
                    order,
                }),
        ]);

        recordReplayRequest('track', performance.now() - routeStartedAt, items.length, req.params.entityId);

        res.json({
            mode: 'historical-replay',
            replay_kind: 'track',
            entityId: req.params.entityId,
            order,
            entity: entityState[0] || null,
            count: items.length,
            items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/replay/events/:eventId/snapshots', async (req, res) => {
    if (!eventQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    try {
        const items = await eventQueryService.listSnapshots({
            eventId: req.params.eventId,
            limit: parsePositiveLimit(req.query.limit as string | undefined, 500),
        });
        res.json({
            mode: 'event-history',
            eventId: req.params.eventId,
            count: items.length,
            items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/trajectories', async (req, res) => {
    if (!databaseService.isReady()) {
        res.status(503).json({ error: 'Database is not ready' });
        return;
    }

    const body = req.body || {};
    const layerId = typeof body.layerId === 'string' ? body.layerId : undefined;
    const entityIds = Array.isArray(body.entityIds) ? body.entityIds as unknown[] : undefined;
    const bbox = Array.isArray(body.bbox) ? body.bbox as unknown[] : undefined;
    const startTimeRaw = body.startTime as string | undefined;
    const endTimeRaw = body.endTime as string | undefined;
    const maxPointsRaw = body.maxPointsPerEntity;

    if (!layerId) {
        res.status(400).json({ error: 'layerId required' });
        return;
    }

    const hasIds = Array.isArray(entityIds) && entityIds.length > 0
        && entityIds.every((id): id is string => typeof id === 'string' && id.length > 0);
    const hasBbox = Array.isArray(bbox) && bbox.length === 4
        && bbox.every((n) => typeof n === 'number' && Number.isFinite(n));

    if (!hasIds && !hasBbox) {
        res.status(400).json({ error: 'entityIds or bbox required' });
        return;
    }

    const start = startTimeRaw ? new Date(startTimeRaw) : null;
    const end = endTimeRaw ? new Date(endTimeRaw) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
        res.status(400).json({ error: 'startTime must be a valid ISO8601 earlier than endTime' });
        return;
    }

    const maxPoints = Math.min(
        Math.max(Math.trunc(Number(maxPointsRaw) || 200), 1),
        2000,
    );

    const normalizedLayerId = normalizeLayerId(layerId) ?? layerId;
    const normalizedIds = hasIds
        ? (entityIds as string[]).map((id) => (id.includes(':') ? id : `${normalizedLayerId}:${id}`))
        : [];

    const now = Date.now();
    const oldestEdgeMs = Math.min(start.getTime(), end.getTime());
    const ageSec = (now - oldestEdgeMs) / 1000;
    const windowSec = (end.getTime() - start.getTime()) / 1000;
    const useCagg = ageSec < 180 * 86400 && windowSec > 2 * 3600 && ageSec > 30 * 86400;

    // CAGG path: widen bucket predicate to cover edge-case rows inside the
    // start/end buckets (chunk exclusion), then filter precisely on
    // last_observed_at (the real sample time).
    const sourceFragment = useCagg
        ? `FROM app.ca_position_fixes_5min
           WHERE layer_id = $1
             AND bucket >= time_bucket('5 minutes', $2::timestamptz)
             AND bucket <= $3::timestamptz
             AND last_observed_at BETWEEN $2 AND $3`
        : 'FROM core.position_fixes WHERE layer_id = $1 AND observed_at BETWEEN $2 AND $3';

    const timeCol = useCagg ? 'last_observed_at' : 'observed_at';
    const timeOrderCol = useCagg ? 'last_observed_at' : 'observed_at';
    const geomCol = useCagg ? 'last_geom' : 'geom';
    const altCol = useCagg ? 'last_alt' : 'altitude_m';
    const hdgCol = useCagg ? 'last_heading' : 'heading_deg';
    const spdCol = useCagg ? 'last_speed' : 'speed_mps';

    const whereFrags: string[] = [];
    const params: any[] = [normalizedLayerId, start.toISOString(), end.toISOString()];

    if (hasIds) {
        params.push(normalizedIds);
        whereFrags.push(`entity_id = ANY($${params.length}::text[])`);
    }

    if (hasBbox) {
        const [south, west, north, east] = bbox as [number, number, number, number];
        params.push(west, south, east, north);
        const base = params.length - 3;
        whereFrags.push(
            `${geomCol} && ST_MakeEnvelope($${base}, $${base + 1}, $${base + 2}, $${base + 3}, 4326)`,
        );
    }

    params.push(maxPoints);
    const pMax = params.length;

    const whereClause = whereFrags.length > 0 ? ` AND ${whereFrags.join(' AND ')}` : '';

    // Stride-based decimation: ceil(total_count/maxPoints) guarantees
    // <= maxPoints rows per entity without a separate cap.
    const sql = `
        WITH base AS (
            SELECT entity_id,
                   ${timeCol} AS observed_at,
                   ${geomCol} AS geom,
                   ${altCol} AS altitude_m,
                   ${hdgCol} AS heading_deg,
                   ${spdCol} AS speed_mps,
                   row_number() OVER (PARTITION BY entity_id ORDER BY ${timeOrderCol}) AS rn,
                   count(*)     OVER (PARTITION BY entity_id) AS total_count
            ${sourceFragment}${whereClause}
        )
        SELECT entity_id, observed_at,
               ST_X(geom) AS lon, ST_Y(geom) AS lat,
               altitude_m, heading_deg, speed_mps
        FROM base
        WHERE MOD(rn - 1, GREATEST(CEIL(total_count::numeric / $${pMax})::int, 1)) = 0
        ORDER BY entity_id, observed_at
    `;

    try {
        const result = await databaseService.query<{
            entity_id: string;
            observed_at: string | Date;
            lon: number;
            lat: number;
            altitude_m: number | null;
            heading_deg: number | null;
            speed_mps: number | null;
        }>(sql, params);

        const entities: Record<string, { positions: Array<[number, number, number | null, number]> }> = {};
        for (const row of result?.rows || []) {
            const bucket = entities[row.entity_id] ?? (entities[row.entity_id] = { positions: [] });
            const tSec = Math.floor(new Date(row.observed_at).getTime() / 1000);
            bucket.positions.push([row.lon, row.lat, row.altitude_m, tSec]);
        }

        res.json({ entities });
    } catch (err: any) {
        console.error('[api] /api/trajectories failed', err);
        res.status(500).json({ error: err?.message || 'trajectories query failed' });
    }
});

app.get('/api/query/events/latest', async (req, res) => {
    if (!eventQueryService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }

    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            eventId: req.query.eventId as string | undefined,
            eventKind: req.query.eventKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: parsePositiveLimit(req.query.limit as string | undefined, 200),
        };
        const items = await eventQueryService.listLatest(filters);
        res.json({
            mode: 'latest',
            filters,
            count: items.length,
            items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/query/entities/latest', async (req, res) => {
    if (!entityQueryService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }

    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            entityId: req.query.entityId as string | undefined,
            entityKind: req.query.entityKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: parsePositiveLimit(req.query.limit as string | undefined, 200),
        };
        const items = await entityQueryService.listLatest(filters);
        res.json({
            mode: 'latest',
            filters,
            count: items.length,
            items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/query/entities/:entityId/track', async (req, res) => {
    if (!entityQueryService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    const order = req.query.order === 'desc' ? 'desc' : 'asc';

    try {
        const items = await entityQueryService.listTrack({
            entityId: req.params.entityId,
            from: from || undefined,
            to: to || undefined,
            limit: parsePositiveLimit(req.query.limit as string | undefined, 1000),
            order,
        });
        res.json({
            mode: 'track',
            entityId: req.params.entityId,
            order,
            count: items.length,
            items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/query/assets/latest', async (req, res) => {
    if (!assetQueryService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }

    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            assetId: req.query.assetId as string | undefined,
            assetKind: req.query.assetKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: parsePositiveLimit(req.query.limit as string | undefined, 200),
        };
        const items = await assetQueryService.listLatest(filters);
        res.json({
            mode: 'latest',
            filters,
            count: items.length,
            items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/replay/assets', async (req, res) => {
    if (!assetQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            assetId: req.query.assetId as string | undefined,
            assetKind: req.query.assetKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: parsePositiveLimit(req.query.limit as string | undefined, 500),
        };
        const items = await assetQueryService.listSnapshots(filters);
        res.json({
            mode: 'history',
            filters,
            count: items.length,
            items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/replay/assets/:assetId/snapshots', async (req, res) => {
    if (!assetQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    try {
        const items = await assetQueryService.listSnapshots({
            assetId: req.params.assetId,
            limit: parsePositiveLimit(req.query.limit as string | undefined, 1000),
        });
        res.json({
            mode: 'asset-history',
            assetId: req.params.assetId,
            count: items.length,
            items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/cables', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getCables());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/fires', async (req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    const bbox = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected south,west,north,east)' });
        return;
    }
    const gridDegrees = parseOptionalPositiveGridDegrees(req.query.gridDegrees as string | undefined);
    if ((req.query.gridDegrees as string | undefined) && gridDegrees == null) {
        res.status(400).json({ error: 'Invalid gridDegrees (expected positive number)' });
        return;
    }
    try {
        res.json(await liveProjectionService.getFires({
            bbox: bbox || undefined,
            gridDegrees,
        }));
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/jamming', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getJammingZones());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/webcams', (_req, res) => {
    res.json(webcamsService.getWebcams());
});

app.get('/api/outages', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getIodaOutages());
    } catch (err: any) {
        sendError(res, err);
    }
});

// Overpass queries on multi-tag bounding boxes scale faster than linearly.
// A 3°×3° power-infra query can return 40k+ elements / 27 MB of JSON and
// push the backend into OOM when parsing. The frontend requests ~1° tiles,
// so 4 sq.deg (2°×2°) is loose enough for direct API callers without
// exceeding the axios maxContentLength guard in the Overpass client.
const MAX_BBOX_AREA_SQDEG = 4;

function bboxArea(a: number, b: number, c: number, d: number): number {
    // parseBbox accepts either south,west,north,east or west,south,east,north.
    // Either way, |latA-latC| × |lonB-lonD| gives the right magnitude.
    return Math.abs(a - c) * Math.abs(b - d);
}

// Critical infrastructure — hybrid Overpass + Overture merge.
//
// Overpass is the canonical source (always runs). When OVERTURE_ENABLED
// is set, Overture Maps runs in parallel via OvertureService and its
// results are merged into the response. Overpass records that collide
// spatially with an Overture record (same type, within ~555 m) are
// dropped so the two sources don't render as duplicate billboards.
// Overture stays off by default; `dedupAgainstOverture` is a safe
// no-op on an empty Overture list so the fallback path matches the
// previous behaviour exactly.
app.get('/api/infrastructure', async (req, res) => {
    const parsed = parseBbox(req.query.bbox as string | undefined, 'swne');
    if (!parsed) {
        res.status(400).json({ error: 'Missing or invalid bbox (expected south,west,north,east; lat ±90, lng ±180; south<north; west<east)' });
        return;
    }
    const [south, west, north, east] = parsed;
    const area = bboxArea(south, west, north, east);
    if (area > MAX_BBOX_AREA_SQDEG) {
        res.status(400).json({
            error: `bbox too large: ${area.toFixed(1)} sq.deg (max ${MAX_BBOX_AREA_SQDEG}). Request smaller tiles — Overpass will time out otherwise.`,
        });
        return;
    }
    try {
        const tOv0 = Date.now();
        const overtureRecords = await overtureService.getInfrastructureInBbox(south, west, north, east);
        const tOv = Date.now() - tOv0;

        const OVERPASS_FAST_TIMEOUT = 5000;
        let overpassRecords: any[] = [];
        let overpassTimedOut = false;
        const tOp0 = Date.now();
        try {
            overpassRecords = await Promise.race([
                infrastructureService.getInfrastructure(south, west, north, east),
                new Promise<any[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Overpass too slow')), OVERPASS_FAST_TIMEOUT)
                ),
            ]);
        } catch {
            overpassTimedOut = true;
        }
        const tOp = Date.now() - tOp0;

        const deduped = dedupAgainstOverture(overpassRecords, overtureRecords);
        const merged = [
            ...overtureRecords.map((r) => ({
                id: r.id,
                lat: r.lat,
                lng: r.lng,
                name: r.name,
                type: r.type,
            })),
            ...deduped,
        ];
        recordInfraFetch('infrastructure', 'overture', tOv, overtureRecords.length, false);
        recordInfraFetch('infrastructure', 'overpass', tOp, overpassRecords.length, overpassTimedOut);
        logPerfEvent('infra.fetch', { source: 'backend', endpoint: 'infrastructure', overtureMs: tOv, overtureRecords: overtureRecords.length, overpassMs: tOp, overpassRecords: overpassRecords.length, overpassTimedOut, mergedRecords: merged.length, bboxAreaSq: Number(area.toFixed(2)) });
        console.log(`[Infra] /api/infrastructure overture=${tOv}ms(${overtureRecords.length}) overpass=${tOp}ms(${overpassRecords.length}${overpassTimedOut ? ',timeout' : ''}) merged=${merged.length} bbox=${area.toFixed(1)}sq`);
        res.json({ data: merged, overpassTimedOut });
    } catch (err: any) {
        console.error('[Infrastructure] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch infrastructure data (upstream Overpass unavailable)' });
    }
});

// Power infrastructure via OSM Overpass (power=plant/substation/line tags).
// (The name "power-infra" is historic — it used to proxy openinframap.org
// but that API is gone, so we now hit Overpass directly.)
// Endpoint receives bbox as west,south,east,north (Tile convention) so the
// frontend can hand off its own viewport ordering directly.
app.get('/api/power-infra', async (req, res) => {
    const bbox = req.query.bbox as string | undefined;
    const parsed = parseBbox(bbox, 'wsen');
    if (!parsed || !bbox) {
        res.status(400).json({ error: 'Missing or invalid bbox (expected west,south,east,north; lat ±90, lng ±180; south<north; west<east)' });
        return;
    }
    const [west, south, east, north] = parsed;
    const area = bboxArea(south, west, north, east);
    if (area > MAX_BBOX_AREA_SQDEG) {
        res.status(400).json({
            error: `bbox too large: ${area.toFixed(1)} sq.deg (max ${MAX_BBOX_AREA_SQDEG}). Request smaller tiles — Overpass will time out otherwise.`,
        });
        return;
    }
    try {
        const tOv0 = Date.now();
        const overtureRecords = await overtureService.getPowerInfraInBbox(south, west, north, east);
        const tOv = Date.now() - tOv0;

        const OVERPASS_FAST_TIMEOUT = 5000;
        let overpassRecords: any[] = [];
        let overpassTimedOut = false;
        const tOp0 = Date.now();
        try {
            overpassRecords = await Promise.race([
                infrastructureService.getPowerInfra(bbox),
                new Promise<any[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Overpass too slow')), OVERPASS_FAST_TIMEOUT)
                ),
            ]);
        } catch {
            overpassTimedOut = true;
        }
        const tOp = Date.now() - tOp0;
        recordInfraFetch('power-infra', 'overture', tOv, overtureRecords.length, false);
        recordInfraFetch('power-infra', 'overpass', tOp, overpassRecords.length, overpassTimedOut);
        logPerfEvent('infra.fetch', { source: 'backend', endpoint: 'power-infra', overtureMs: tOv, overtureRecords: overtureRecords.length, overpassMs: tOp, overpassRecords: overpassRecords.length, overpassTimedOut });
        console.log(`[Infra] /api/power-infra overture=${tOv}ms(${overtureRecords.length}) overpass=${tOp}ms(${overpassRecords.length}${overpassTimedOut ? ',timeout' : ''})`);

        const deduped = dedupAgainstOverture(overpassRecords, overtureRecords);
        const merged = [
            ...overtureRecords.map((r) => ({
                id: r.id,
                lat: r.lat,
                lng: r.lng,
                name: r.name,
                type: r.type,
                source: 'overture',
                voltage: '',
                coordinates: r.coordinates,
            })),
            ...deduped,
        ];
        res.json({ data: merged, overpassTimedOut });
    } catch (err: any) {
        console.error('[PowerInfra] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch power infrastructure data (upstream Overpass unavailable)' });
    }
});

// Oil & gas pipelines from OSM Overpass
app.get('/api/pipelines', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        let rows = await liveProjectionService.getPipelines();
        if (rows.length === 0) {
            await infrastructureService.getPipelines();
            rows = await liveProjectionService.getPipelines();
        }
        res.json(rows);
    } catch (err: any) {
        console.error('[Pipelines] endpoint error:', err.message);
        sendError(res, err);
    }
});

// Oil prices from Yahoo Finance
app.get('/api/oil-prices', (_req, res) => {
    res.json(oilPricesService.getPrices());
});

// OWID country energy data
app.get('/api/energy', (_req, res) => {
    res.json(energyService.getAllCountries());
});

app.get('/api/energy/:iso', (req, res) => {
    const data = energyService.getCountryEnergy(req.params.iso);
    if (!data) {
        res.status(404).json({ error: 'Country not found' });
        return;
    }
    res.json(data);
});

// Historical flight track from OpenSky Network
app.get('/api/track/:icao24', async (req, res) => {
    const { icao24 } = req.params;
    const time = req.query.time ? Number(req.query.time) : Math.floor(Date.now() / 1000);

    if (!icao24 || !/^[0-9a-fA-F]{6}$/.test(icao24)) {
        res.status(400).json({ error: 'Invalid ICAO24 hex code. Must be exactly 6 hex characters.' });
        return;
    }

    try {
        const url = `https://opensky-network.org/api/tracks/all?icao24=${icao24.toLowerCase()}&time=${time}`;
        console.log(`[Track] Fetching: ${url}`);
        const response = await axios.get(url, { timeout: 15000 });
        res.json(response.data);
    } catch (err: any) {
        const status = err.response?.status;
        if (status === 404) {
            console.warn(`[Track] No track found for icao24=${icao24}`);
            res.status(404).json({ error: 'No track found for this aircraft. It may not have been airborne recently.' });
        } else if (status === 429) {
            console.warn(`[Track] Rate limited by OpenSky`);
            res.status(429).json({ error: 'Rate limited by OpenSky Network. Try again in a few seconds.' });
        } else {
            console.error(`[Track] Error fetching track:`, err.message);
            res.status(status || 502).json({ error: 'Failed to fetch track from OpenSky Network.' });
        }
    }
});

// Proxy Planespotters photo API
app.get('/api/aircraft-photo/:icao24', async (req, res) => {
    const { icao24 } = req.params;
    if (!ICAO24_RE.test(icao24)) {
        res.status(400).json({ error: 'Invalid icao24 hex code' });
        return;
    }
    try {
        const response = await axios.get(
            `https://api.planespotters.net/pub/photos/hex/${icao24.toLowerCase()}`,
            { timeout: 10000 }
        );
        res.json(response.data);
    } catch {
        res.status(502).json({ error: 'Failed to fetch photo' });
    }
});

// Proxy OpenSky routes API (avoids CORS when called from browser)
app.get('/api/routes/:callsign', async (req, res) => {
    const { callsign } = req.params;
    if (!CALLSIGN_RE.test(callsign.trim())) {
        res.status(400).json({ error: 'Invalid callsign (1-8 alphanumeric chars)' });
        return;
    }
    try {
        const response = await axios.get(
            `https://opensky-network.org/api/routes?callsign=${encodeURIComponent(callsign.trim())}`,
            { timeout: 10000 }
        );
        res.json(response.data);
    } catch (err: any) {
        if (err.response?.status === 404) {
            res.json({ route: [] });
            return;
        }
        const status = err.response?.status || 502;
        res.status(status).json({ error: 'Failed to fetch route' });
    }
});

// TomTom Traffic Flow tiles (vector + raster proxy)
function validateTileParams(req: express.Request, res: express.Response): boolean {
    const z = String(req.params.z ?? '');
    const x = String(req.params.x ?? '');
    const y = String(req.params.y ?? '');
    if (!INT_RE.test(z) || !INT_RE.test(x) || !INT_RE.test(y)) {
        res.status(400).json({ error: 'z/x/y must be integers' });
        return false;
    }
    const zn = Number(z);
    if (zn < 0 || zn > 22) {
        res.status(400).json({ error: 'zoom out of range (0-22)' });
        return false;
    }
    return true;
}
app.get('/api/traffic/tile/:z/:x/:y', (req, res) => {
    if (!validateTileParams(req, res)) return;
    tomtomService.proxyVectorTile(req, res);
});
app.get('/api/traffic/raster/:z/:x/:y', (req, res) => {
    if (!validateTileParams(req, res)) return;
    tomtomService.proxyRasterTile(req, res);
});

// ACLED armed conflict events
app.get('/api/conflicts', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getAcledConflicts());
    } catch (err: any) {
        sendError(res, err);
    }
});

// GDELT real-time conflict events (no auth, 15-min updates)
app.get('/api/gdelt-conflicts', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getGdeltConflicts());
    } catch (err: any) {
        sendError(res, err);
    }
});

// OpenAIP restricted airspace / no-fly zones
app.get('/api/airspace', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getAirspaceZones());
    } catch (err: any) {
        sendError(res, err);
    }
});

// Global Fishing Watch AIS signal-lost events
app.get('/api/gfw-events', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getGfwEvents());
    } catch (err: any) {
        sendError(res, err);
    }
});

// Cloudflare Radar internet outages
app.get('/api/cloudflare-outages', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getCloudflareOutages());
    } catch (err: any) {
        sendError(res, err);
    }
});

// HERE Traffic Flow v7
app.get('/api/here-traffic', async (req, res) => {
    const parsed = parseBbox(req.query.bbox as string | undefined, 'wsen');
    if (!parsed) {
        res.status(400).json({ error: 'Missing or invalid bbox (expected west,south,east,north; lat ±90, lng ±180; south<north; west<east)' });
        return;
    }
    // HERE wants the same ordering we validated (west,south,east,north). Pass
    // the normalised numeric form so a caller can't smuggle arbitrary text
    // into the upstream URL.
    const [west, south, east, north] = parsed;
    const safeBbox = `${west},${south},${east},${north}`;
    try {
        const data = await hereTrafficService.getFlow(safeBbox);
        if (data.error) {
            res.status(502).json({ error: `HERE upstream failed: ${data.error}` });
            return;
        }
        res.json(data);
    } catch (err: any) {
        console.error('[HereTraffic] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch HERE traffic' });
    }
});

// Windy Webcams — nearby cameras by lat/lng/radius
app.get('/api/windy-webcams', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radius = Number(req.query.radius) || 50;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 ||
        !Number.isFinite(lng) || Math.abs(lng) > 180 ||
        !Number.isFinite(radius) || radius <= 0 || radius > 250) {
        res.status(400).json({ error: 'Invalid lat (±90), lng (±180), or radius (0-250 km)' });
        return;
    }
    try {
        const data = await windyService.getWebcams(lat, lng, radius);
        res.json(data);
    } catch (err: any) {
        console.error('[WindyWebcams] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch Windy webcams' });
    }
});

// Service health status — real state from each service's getHealth(),
// not just env-var presence. Services report streaming/error/auth-missing
// based on actual upstream success.
app.get('/api/status', async (_req, res) => {
    const envCheck = (key: string) => !!(process.env[key] && process.env[key]!.length > 0);
const adsbHealth = liveStreamService.getHealth();
    const extendedHealth = extendedService.getHealth();

    // Outages are an aggregate of two independent upstreams (Cloudflare Radar +
    // IODA). Report the best-of-two status and surface per-source detail in
    // the note — don't hardcode which one is broken.
    const cfH = cloudflareService.getHealth();
    const iodaH = iodaService.getHealth();
    // streaming if either upstream is live; error if both broken; auth-missing
    // only if both are gated by missing creds (iodaH only exposes streaming/
    // error, so this reduces to cfH.status === 'auth-missing' in practice).
    let outagesStatus: 'streaming' | 'error' | 'auth-missing';
    if (cfH.status === 'streaming' || iodaH.status === 'streaming') {
        outagesStatus = 'streaming';
    } else if (cfH.status === 'auth-missing') {
        outagesStatus = 'auth-missing';
    } else {
        outagesStatus = 'error';
    }
    const outagesNote = `Cloudflare: ${cfH.status}${cfH.note ? ` (${cfH.note})` : ''}; IODA: ${iodaH.status}${iodaH.note ? ` (${iodaH.note})` : ''}`;
    const outagesCount = (cfH.count || 0) + (iodaH.count || 0);

    // Webcams aggregate Windy + Live-Environment-Streams + Caltrans CCTV.
    // Use Windy's real health and tag the note so UI knows whether we're on
    // full (Windy) or a limited fallback feed.
    const windyH = windyService.getHealth();
    let webcamsStatus: 'streaming' | 'error' | 'auth-missing' | 'limited';
    if (windyH.status === 'streaming') {
        webcamsStatus = 'streaming';
    } else if (windyH.status === 'auth-missing') {
        // No Windy key — still streaming via Live-Environment-Streams +
        // Caltrans, just without Windy's global webcam set.
        webcamsStatus = 'limited';
    } else {
        // Windy errored — the layer still works via Live-Environment-Streams
        // + Caltrans, but we surface 'limited' with the Windy error note so
        // ops can see the underlying failure without treating the whole
        // layer as broken.
        webcamsStatus = 'limited';
    }
    const webcamsNote = windyH.status === 'streaming'
        ? `Windy: ${windyH.count} cams`
        : windyH.status === 'auth-missing'
            ? 'Live-Env-Streams + Caltrans (no Windy key)'
            : `Windy: ${windyH.note || 'error'}; fallback Live-Env-Streams + Caltrans`;

    // Infrastructure composite health: Overpass is authoritative; Overture
    // is the opt-in secondary. If Overture is enabled and init'd OK, it's
    // adding coverage → streaming with a note. If Overture is enabled but
    // init failed (DuckDB / httpfs / spatial ext broken) we surface the
    // real error to the UI via status='warning' so the user sees the
    // dependency failure instead of having it silently fall back. When
    // Overture is disabled, the row shows plain Overpass streaming.
    const overtureEnabled = overtureService.isEnabled();
    const os = overtureEnabled ? overtureService.getStatus() : null;
    let infraStatus: 'streaming' | 'warning' = 'streaming';
    let infraNote = 'Overpass (OSM)';
    if (overtureEnabled && os) {
        if (os.state === 'ready') {
            infraNote = `Overpass + Overture (${os.records} records, ${os.diskMb} MB, cache ${os.cacheAge ?? 'fresh'})`;
        } else if (os.state === 'downloading') {
            infraStatus = 'warning';
            infraNote = `Overpass + Overture downloading: ${os.step}`;
        } else if (os.state === 'error') {
            infraStatus = 'warning';
            infraNote = `Overture error: ${os.error}; Overpass only`;
        }
    }

    const statusPayload = {
        database: databaseService.getHealth(),
        satellites: satelliteService.getHealth(),
        aviation: adsbHealth.aviation,
        maritime: adsbHealth.maritime,
        cables: extendedHealth.cables,
        fires: extendedHealth.fires,
        jamming: gpsJamService.getHealth(),
        airspace: airspaceService.getHealth(),
        conflicts: acledService.getHealth(),
        gdelt: gdeltService.getHealth(),
        gfw: gfwService.getHealth(),
        outages: { status: outagesStatus, note: outagesNote, count: outagesCount },
        // Services without real health getters still fall back to env check
        traffic: { status: envCheck('TOMTOM_API_KEY') ? 'streaming' : 'auth-missing' },
        webcams: { status: webcamsStatus, note: webcamsNote },
        infrastructure: { status: infraStatus, note: infraNote },
        overture: os ?? { state: 'disabled' },
        storage: await collectStorageStatus(),
    };

    void runtimeStateRepository.persistSnapshot(statusPayload);
    res.json(statusPayload);
});

// Detailed Overture cache status for the frontend settings panel.
app.get('/api/overture-status', (_req, res) => {
    if (!overtureService.isEnabled()) {
        res.json({ state: 'disabled' });
        return;
    }
    res.json(overtureService.getStatus());
});

// Global error safety net for routes that do not catch their own errors
// (Express 5 forwards async rejections here). In production only a short
// requestId is returned to clients so Postgres error text, filesystem paths,
// and upstream API bodies do not leak. Full err is always logged server-side.
// Disclosed through /cso 2026-04-22 as err.message disclosure at 44 call sites.
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    const requestId = Math.random().toString(36).slice(2, 10);
    const isProd = process.env.NODE_ENV === 'production';
    console.error(`[error ${requestId}] ${req.method} ${req.path}:`, err);
    const body = isProd
        ? { error: 'Internal error', requestId }
        : { error: err?.message ?? 'unknown error', requestId };
    res.status(500).json(body);
});

async function bootstrap() {
    console.log('Initializing backend services...');
    await databaseService.init();
    await catalogBootstrapService.seed();
    // Spectator must init before SatelliteService so the TLE enrichment
    // step sees a populated catalog on first boot. If the Spectator fetch
    // fails (network, missing key) we still continue — SatelliteService
    // just skips sensor enrichment and the frontend shows no footprints.
    await spectatorService.init();
    await satelliteService.init();
    // OvertureService boots the DuckDB + httpfs stack lazily. When
    // disabled via OVERTURE_ENABLED this is a fast no-op; when enabled
    // a failure here (missing extension, no network) leaves the
    // service unready and the hybrid merge silently falls back to
    // Overpass-only responses — no request path bails.
    await overtureService.init();
    if (liveIngestEnabled) {
        liveStreamService.start();
        extendedService.start();
        gpsJamService.start();
        webcamsService.start();
        iodaService.start();
        oilPricesService.start();
        energyService.start();
        acledService.start();
        gdeltService.start();
        airspaceService.start();
        gfwService.start();
        cloudflareService.start();
    } else {
        console.log('[bootstrap] Live ingest disabled via DISABLE_LIVE_INGEST=true');
    }

    io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);
    });

    const PORT = process.env.PORT || 3055;
    server.listen(PORT, () => {
        console.log(`Backend server running on port ${PORT}`);
    });
    void refreshReplayTilesWindow();
    setInterval(() => {
        void refreshReplayTilesWindow();
    }, 10 * 60 * 1000);
}

bootstrap();
