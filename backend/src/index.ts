import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import axios from 'axios';

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

// CORS origin whitelist — comma-separated list in ALLOWED_ORIGINS env var.
// Defaults to localhost dev ports if unset.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3737,http://localhost:3000')
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

const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// ---------------------------------------------------------------------------
// User settings persistence (JSON file on disk)
// ---------------------------------------------------------------------------
import path from 'path';
import fs from 'fs';
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/catalog/layers', async (_req, res) => {
    try {
        res.json(await catalogReadService.listLayers());
    } catch (err: any) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/catalog/ui-taxonomy', async (_req, res) => {
    try {
        res.json(await catalogReadService.getUiTaxonomy());
    } catch (err: any) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/legend/tree', async (_req, res) => {
    try {
        res.json(await catalogReadService.getUiTaxonomy());
    } catch (err: any) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

// Simple in-memory rate limiter — per-IP token bucket, 120 req/min.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
app.use((req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = rateLimitMap.get(ip);
    if (!bucket || now >= bucket.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
        bucket.count++;
        if (bucket.count > RATE_LIMIT_MAX) {
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
    return layerId;
}

function parsePositiveLimit(value: string | undefined, fallback = 200): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.max(1, Math.min(5000, Math.trunc(parsed)));
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
  }
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
        const rawLimit = typeof _req.query.limit === 'string' ? _req.query.limit.trim().toLowerCase() : '';
        let limit: number | null | undefined = 5000;
        if (rawLimit === 'all' || rawLimit === '0') {
            limit = null;
        } else if (rawLimit) {
            const parsed = Number(rawLimit);
            if (!Number.isInteger(parsed) || parsed < 0) {
                res.status(400).json({ error: 'Invalid limit (expected positive integer or "all")' });
                return;
            }
            limit = parsed;
        }
        res.json(await liveProjectionService.getSatellites(limit));
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/satellites/recon', async (req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        const rawLimit = typeof req.query.limit === 'string' ? req.query.limit.trim().toLowerCase() : '';
        let limit: number | null | undefined = 5000;
        if (rawLimit === 'all' || rawLimit === '0') {
            limit = null;
        } else if (rawLimit) {
            const parsed = Number(rawLimit);
            if (!Number.isInteger(parsed) || parsed < 0) {
                res.status(400).json({ error: 'Invalid limit (expected positive integer or "all")' });
                return;
            }
            limit = parsed;
        }
        res.json(await liveProjectionService.getReconSatellites(limit));
    } catch (err: any) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/fires', async (_req, res) => {
    if (!liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        res.json(await liveProjectionService.getFires());
    } catch (err: any) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        // Overture is local DuckDB — instant. Overpass is external HTTP — slow.
        // Don't block response on Overpass: return Overture immediately,
        // merge Overpass only if it finishes within a tight timeout.
        const overtureRecords = await overtureService.getInfrastructureInBbox(south, west, north, east);

        // Fire Overpass with a 5s timeout — if it responds fast, merge;
        // otherwise return Overture-only (better than waiting 60s).
        const OVERPASS_FAST_TIMEOUT = 5000;
        let overpassRecords: any[] = [];
        let overpassTimedOut = false;
        try {
            overpassRecords = await Promise.race([
                infrastructureService.getInfrastructure(south, west, north, east),
                new Promise<any[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Overpass too slow')), OVERPASS_FAST_TIMEOUT)
                ),
            ]);
        } catch {
            // Overpass slow or failed — proceed with Overture only
            overpassTimedOut = true;
        }

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
        // Overture is local DuckDB — instant. Overpass is external HTTP — slow.
        // Same race pattern as /api/infrastructure: return Overture immediately,
        // merge Overpass only if it finishes within a tight timeout.
        const overtureRecords = await overtureService.getPowerInfraInBbox(south, west, north, east);

        // Fire Overpass with a 5s timeout — if it responds fast, merge;
        // otherwise return Overture-only (better than waiting 60s).
        const OVERPASS_FAST_TIMEOUT = 5000;
        let overpassRecords: any[] = [];
        let overpassTimedOut = false;
        try {
            overpassRecords = await Promise.race([
                infrastructureService.getPowerInfra(bbox),
                new Promise<any[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Overpass too slow')), OVERPASS_FAST_TIMEOUT)
                ),
            ]);
        } catch {
            // Overpass slow or failed — proceed with Overture only
            overpassTimedOut = true;
        }

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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
app.get('/api/status', (_req, res) => {
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

    io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);
    });

    const PORT = process.env.PORT || 3055;
    server.listen(PORT, () => {
        console.log(`Backend server running on port ${PORT}`);
    });
}

bootstrap();
