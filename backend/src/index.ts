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
import crypto from 'crypto';
import { recordRateLimitReject, recordReplayRequest, recordInfraFetch, withSpan } from './telemetry/observability';
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
import { LiveStreamService, type DisasterEvent } from './services/live-stream.service';
import { ExtendedDataService, type FireRecord } from './services/extended.service';
import { GPSJamService } from './services/gpsjam.service';
import { WebcamsService } from './services/webcams.service';
import { InfrastructureService } from './services/infrastructure.service';
import { OvertureService, dedupAgainstOverture } from './services/overture.service';
import { IODAService, COUNTRY_CENTROIDS, type OutageRecord } from './services/ioda.service';
import { OilPricesService } from './services/oilprices.service';
import { EnergyService } from './services/energy.service';
import { TomTomService } from './services/tomtom.service';
import { HereTrafficService } from './services/here.service';
import { ACLEDService } from './services/acled.service';
import { AirspaceService } from './services/airspace.service';
import { GFWService } from './services/gfw.service';
import { CloudflareService } from './services/cloudflare.service';
import { CopernicusService } from './services/copernicus.service';
import { WindyService } from './services/windy.service';
import { GDELTService } from './services/gdelt.service';
import { CIRService } from './services/cir.service';
import { OpenSanctionsService } from './services/opensanctions.service';
import { WigleService } from './services/wigle.service';
import { setupAIImageRoutes } from './routes/ai-image';
import { databaseService } from './db/database.service';
import { ViewStateRepository } from './repositories/view-state.repository';
import { SelectionRepository } from './repositories/selection.repository';
import { AgentRepository, type AgentProvider } from './repositories/agent.repository';
import { CatalogBootstrapService } from './services/catalog-bootstrap.service';
import { CatalogReadService } from './services/catalog-read.service';
import { ViewControlService } from './services/view-control.service';
import { AgentToolService } from './services/agent-tool.service';
import { AgentRuntimeService, getRepoRootFromBackend } from './services/agent-runtime.service';
import { RuntimeStateRepository } from './repositories/runtime-state.repository';
import { SourcePersistenceService } from './services/source-persistence.service';
import { EventQueryService } from './services/event-query.service';
import { EntityQueryService } from './services/entity-query.service';
import { AssetQueryService } from './services/asset-query.service';
import { LiveProjectionService } from './services/live-projection.service';
import { ReplayQueryService } from './services/replay-query.service';
import { ReplayRenderBatchService } from './services/replay-render-batch.service';
import { SOURCE_BINDINGS } from './services/source-bindings.service';
import { VesselEnrichmentService } from './services/vessel-enrichment.service';

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
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
};

const SENSITIVE_QUERY_KEYS = new Set([
    'access_token',
    'api_key',
    'apikey',
    'client_secret',
    'key',
    'map_key',
    'password',
    'secret',
    'token',
]);

function redactUrlForLog(value: unknown): string | undefined {
    if (!value) return undefined;
    const raw = String(value);
    const redactParams = (params: URLSearchParams) => {
        for (const key of [...params.keys()]) {
            const normalized = key.toLowerCase();
            if (SENSITIVE_QUERY_KEYS.has(normalized) || /(secret|token|password|credential|api[_-]?key|map[_-]?key)/i.test(key)) {
                params.set(key, '[redacted]');
            }
        }
    };
    try {
        const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
        const url = new URL(raw, hasProtocol ? undefined : 'http://openspy.local');
        redactParams(url.searchParams);
        const serialized = url.toString();
        return hasProtocol ? serialized : serialized.replace(/^http:\/\/openspy\.local/, '');
    } catch {
        return raw.replace(/([?&][^=&]*(?:secret|token|password|credential|api[_-]?key|map[_-]?key|key)[^=&]*=)[^&]*/gi, '$1[redacted]').slice(0, 1000);
    }
}

function redactStringForLog(value: string, maxLength = 1000): string {
    return value
        .replace(/([?&][^=&]*(?:secret|token|password|credential|api[_-]?key|map[_-]?key|key)[^=&]*=)[^&\s]*/gi, '$1[redacted]')
        .replace(/(("?(?:access_token|api_key|apikey|client_secret|key|map_key|password|secret|token)"?\s*[:=]\s*)"?)[^",}\s]+/gi, '$1[redacted]')
        .slice(0, maxLength);
}

function redactValueForLog(value: unknown, depth = 0): unknown {
    if (value == null) return value;
    if (typeof value === 'string') return redactStringForLog(value, depth === 0 ? 1000 : 500);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= 4) return '[redacted:depth]';
    if (Array.isArray(value)) {
        return value.slice(0, 25).map((item) => redactValueForLog(item, depth + 1));
    }
    if (typeof value === 'object') {
        const output: Record<string, unknown> = {};
        const entries = Object.entries(value as Record<string, unknown>);
        const diagnosticKeys = /(error|code|status|reason|message|detail|description)/i;
        const orderedEntries = [
            ...entries.filter(([key]) => diagnosticKeys.test(key)),
            ...entries.filter(([key]) => !diagnosticKeys.test(key)),
        ];
        for (const [key, item] of orderedEntries.slice(0, 50)) {
            const normalized = key.toLowerCase();
            output[key] = SENSITIVE_QUERY_KEYS.has(normalized) || /(secret|token|password|credential|api[_-]?key|map[_-]?key)/i.test(key)
                ? '[redacted]'
                : redactValueForLog(item, depth + 1);
        }
        return output;
    }
    return String(value).slice(0, 500);
}

// In production, raw err.message can leak Postgres column names, filesystem
// paths, and upstream API bodies. sendError returns only a requestId to the
// client and logs a redacted diagnostic summary server-side. In dev the
// message flows through so local debugging keeps working.
function safeErrorLog(err: any): Record<string, unknown> {
    const responseData = err?.response?.data;
    return {
        name: err?.name,
        message: err?.message || String(err),
        code: err?.code,
        status: err?.response?.status,
        statusText: err?.response?.statusText,
        method: err?.config?.method,
        url: redactUrlForLog(err?.config?.url),
        responseData: redactValueForLog(responseData),
    };
}

function sendError(res: express.Response, err: any): void {
    if (res.headersSent) return;
    const requestId = Math.random().toString(36).slice(2, 10);
    const statusCode = Number(err?.status || err?.statusCode || 500);
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        res.status(statusCode).json({
            status: 'error',
            error: {
                code: err?.code || 'BAD_REQUEST',
                message: err?.message || 'Bad request',
            },
            requestId,
        });
        return;
    }
    const isProd = process.env.NODE_ENV === 'production';
    console.error(`[error ${requestId}]`, safeErrorLog(err));
    const body = isProd
        ? { error: 'Internal error', requestId }
        : { error: err?.message ?? 'unknown error', requestId };
    res.status(500).json(body);
}

function sendSelectionPredicateErrorOrFallback(res: express.Response, err: any): void {
    const message = err?.message || String(err);
    if (/selection bbox_order/i.test(message)) {
        res.status(400).json({
            status: 'error',
            error: {
                code: 'BAD_SELECTION_PREDICATE',
                message,
            },
        });
        return;
    }
    sendError(res, err);
}

function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayField(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
}

function layerLooksEntityBacked(layer: string | undefined): boolean {
    const value = String(layer || '').trim().toLowerCase().replace(/-/g, '_');
    return ['aircraft', 'aviation', 'vessel', 'vessels', 'maritime', 'satellite', 'satellites', 'dark_vessel', 'dark_vessels'].includes(value);
}

function selectionPredicateFromRequestBody(body: Record<string, any>, fallback: Record<string, any> = {}): Record<string, any> {
    const predicate = { ...(fallback || {}) };
    const assignIfPresent = (targetKey: string, ...sourceKeys: string[]) => {
        if (predicate[targetKey] !== undefined) return;
        for (const key of sourceKeys) {
            if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
                predicate[targetKey] = body[key];
                return;
            }
        }
    };

    assignIfPresent('bbox', 'bbox');
    assignIfPresent('bbox_order', 'bbox_order', 'bboxOrder');
    assignIfPresent('from', 'from', 'timeFrom', 'time_from', 'observedFrom', 'observed_from', 'start');
    assignIfPresent('to', 'to', 'timeTo', 'time_to', 'observedTo', 'observed_to', 'end');
    assignIfPresent('at', 'at', 'time');
    assignIfPresent('ids', 'ids');
    assignIfPresent('entity_ids', 'entity_ids', 'entityIds');
    assignIfPresent('event_ids', 'event_ids', 'eventIds');
    assignIfPresent('asset_ids', 'asset_ids', 'assetIds');
    const explicitIds = stringArrayField(body.explicit || body.ids || body.objectIds || body.object_ids);
    if (explicitIds.length > 0 && predicate.ids === undefined && predicate.entity_ids === undefined && predicate.event_ids === undefined && predicate.asset_ids === undefined) {
        const layer = stringField(body.layerId) || stringField(body.layer_id) || stringField(body.layer);
        const entityLike = layerLooksEntityBacked(layer)
            || explicitIds.some((id) => /^(vessel|aircraft|satellite|dark-vessel|dark_vessel):/i.test(id));
        if (entityLike) predicate.entity_ids = explicitIds;
        else predicate.ids = explicitIds;
    }
    assignIfPresent('subtype', 'subtype');
    assignIfPresent('subtypes', 'subtypes');
    assignIfPresent('source_id', 'source_id', 'sourceId');
    assignIfPresent('sources', 'sources');
    assignIfPresent('kind', 'kind', 'object_kind', 'objectKind');

    const timeWindow = predicate.time_window && typeof predicate.time_window === 'object'
        ? predicate.time_window
        : predicate.timeWindow && typeof predicate.timeWindow === 'object'
            ? predicate.timeWindow
            : predicate.timeRange && typeof predicate.timeRange === 'object'
                ? predicate.timeRange
                : null;
    if (timeWindow) {
        if (predicate.from === undefined) predicate.from = timeWindow.from ?? timeWindow.start ?? timeWindow.observed_from;
        if (predicate.to === undefined) predicate.to = timeWindow.to ?? timeWindow.end ?? timeWindow.observed_to;
        delete predicate.time_window;
        delete predicate.timeWindow;
        delete predicate.timeRange;
    }
    if (predicate.from === undefined) predicate.from = predicate.timeFrom ?? predicate.time_from;
    if (predicate.to === undefined) predicate.to = predicate.timeTo ?? predicate.time_to;
    delete predicate.timeFrom;
    delete predicate.time_from;
    delete predicate.timeTo;
    delete predicate.time_to;

    const layer = stringField(body.layerId) || stringField(body.layer_id) || stringField(body.layer);
    if (layer && predicate.layer === undefined && predicate.layer_id === undefined && predicate.layerId === undefined) {
        predicate.layer = layer;
    }
    return predicate;
}

function parseSelectionSaveInput(body: Record<string, any>, current?: {
    selection_id?: string;
    layer_id?: string | null;
    selection_mode?: string;
    predicate?: Record<string, any>;
    geometry_json?: Record<string, any> | null;
    metadata?: Record<string, any>;
    expires_at?: string | null;
}) {
    const selectionId = stringField(body.selectionId)
        || stringField(body.selection_id)
        || current?.selection_id;
    const layerId = stringField(body.layerId)
        || stringField(body.layer_id)
        || stringField(body.layer)
        || current?.layer_id
        || null;
    const normalizedLayerId = normalizeLayerId(layerId || undefined) || null;
    const selectionMode = stringField(body.selectionMode)
        || stringField(body.selection_mode)
        || stringField(body.mode)
        || current?.selection_mode
        || 'filter';
    const explicitPredicate = body.predicate && typeof body.predicate === 'object'
        ? body.predicate
        : body.query_spec && typeof body.query_spec === 'object'
            ? body.query_spec
            : null;
    const basePredicate = current?.predicate && typeof current.predicate === 'object'
        ? { ...current.predicate }
        : {};
    const predicate = selectionPredicateFromRequestBody(
        body,
        explicitPredicate ? { ...basePredicate, ...explicitPredicate } : basePredicate,
    );
    return {
        selectionId,
        layerId: normalizedLayerId,
        selectionMode,
        predicate,
        geometryJson: body.geometry && typeof body.geometry === 'object' ? body.geometry : current?.geometry_json || null,
        metadata: body.metadata && typeof body.metadata === 'object'
            ? { ...(current?.metadata || {}), ...body.metadata }
            : current?.metadata || {},
        expiresAt: stringField(body.expiresAt) || current?.expires_at || undefined,
    };
}

function sendSourceFetchProviderError(res: express.Response, operation: string, err: any): void {
    if (res.headersSent) return;
    const status = Number(err?.response?.status || 0);
    const code = String(err?.code || '').toUpperCase();
    const retryable = status === 408 || status === 429 || status >= 500
        || ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR_NETWORK'].includes(code);
    const requestId = crypto.randomUUID().slice(0, 8);
    const providerDetail = status ? `HTTP ${status}` : code || 'unknown provider error';
    const message = retryable
        ? `${operation} provider request is temporarily unavailable (${providerDetail}). Retry later or use a narrower time window/AOI.`
        : status === 401 || status === 403
            ? `${operation} provider rejected the configured backend credentials or account access (${providerDetail}). Check the connector credential/account status.`
            : status === 400 || status === 404 || status === 422
                ? `${operation} provider rejected the bounded request (${providerDetail}). Check the operation parameters and provider capability.`
                : `${operation} provider request failed (${providerDetail}). Check provider capability and connector status.`;
    console.error(`[source-fetch ${operation} ${requestId}]`, safeErrorLog(err));
    res.status(retryable ? 503 : 502).json({
        status: 'error',
        error: {
            code: retryable ? 'PROVIDER_TEMPORARILY_UNAVAILABLE' : 'PROVIDER_REQUEST_FAILED',
            message,
            retryable,
        },
        data: {
            operation,
            provider_status: status || null,
            provider_code: code || null,
            requestId,
        },
        meta: { executed: true, persisted: false },
    });
}

function isLoopbackRequest(req: express.Request): boolean {
    const raw = req.socket.remoteAddress || '';
    const address = raw.replace(/^::ffff:/, '');
    return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function tokenMatches(candidate: string, expected: string): boolean {
    if (!candidate || !expected) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAgentAccess(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (isLoopbackRequest(req)) {
        next();
        return;
    }

    const expected = process.env.AGENT_API_TOKEN || process.env.AI_WORLDVIEW_AGENT_TOKEN || '';
    const auth = String(req.headers.authorization || '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const headerToken = String(req.headers['x-agent-dev-token'] || '');
    if (expected && (tokenMatches(bearer, expected) || tokenMatches(headerToken, expected))) {
        next();
        return;
    }

    res.status(403).json({
        status: 'error',
        error: {
            code: 'AGENT_ACCESS_DENIED',
            message: 'Agent runtime endpoints are available only from loopback or with AGENT_API_TOKEN.',
        },
    });
}

function hasStatementSeparatorOutsideSqlLiterals(sql: string): boolean {
    let quote: 'single' | 'double' | 'line-comment' | 'block-comment' | null = null;
    let dollarTag: string | null = null;

    for (let i = 0; i < sql.length; i += 1) {
        const char = sql[i];
        const next = sql[i + 1];

        if (dollarTag) {
            if (sql.startsWith(dollarTag, i)) {
                i += dollarTag.length - 1;
                dollarTag = null;
            }
            continue;
        }

        if (quote === 'line-comment') {
            if (char === '\n' || char === '\r') quote = null;
            continue;
        }

        if (quote === 'block-comment') {
            if (char === '*' && next === '/') {
                i += 1;
                quote = null;
            }
            continue;
        }

        if (quote === 'single') {
            if (char === "'" && next === "'") {
                i += 1;
                continue;
            }
            if (char === "'") quote = null;
            continue;
        }

        if (quote === 'double') {
            if (char === '"' && next === '"') {
                i += 1;
                continue;
            }
            if (char === '"') quote = null;
            continue;
        }

        if (char === '-' && next === '-') {
            i += 1;
            quote = 'line-comment';
            continue;
        }

        if (char === '/' && next === '*') {
            i += 1;
            quote = 'block-comment';
            continue;
        }

        if (char === "'") {
            quote = 'single';
            continue;
        }

        if (char === '"') {
            quote = 'double';
            continue;
        }

        if (char === '$') {
            const rest = sql.slice(i);
            const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
            if (match?.[0]) {
                dollarTag = match[0];
                i += dollarTag.length - 1;
                continue;
            }
        }

        if (char === ';') return true;
    }

    return false;
}

function sqlCodeOutsideLiterals(sql: string): string {
    let out = '';
    let quote: 'single' | 'double' | 'line-comment' | 'block-comment' | null = null;
    let dollarTag: string | null = null;

    for (let i = 0; i < sql.length; i += 1) {
        const char = sql[i];
        const next = sql[i + 1];

        if (dollarTag) {
            if (sql.startsWith(dollarTag, i)) {
                out += ' '.repeat(dollarTag.length);
                i += dollarTag.length - 1;
                dollarTag = null;
            } else {
                out += char === '\n' || char === '\r' ? char : ' ';
            }
            continue;
        }

        if (quote === 'line-comment') {
            if (char === '\n' || char === '\r') {
                quote = null;
                out += char;
            } else {
                out += ' ';
            }
            continue;
        }

        if (quote === 'block-comment') {
            if (char === '*' && next === '/') {
                out += '  ';
                i += 1;
                quote = null;
            } else {
                out += char === '\n' || char === '\r' ? char : ' ';
            }
            continue;
        }

        if (quote === 'single') {
            if (char === "'" && next === "'") {
                out += '  ';
                i += 1;
                continue;
            }
            out += ' ';
            if (char === "'") quote = null;
            continue;
        }

        if (quote === 'double') {
            if (char === '"' && next === '"') {
                out += '  ';
                i += 1;
                continue;
            }
            out += ' ';
            if (char === '"') quote = null;
            continue;
        }

        if (char === '-' && next === '-') {
            out += '  ';
            i += 1;
            quote = 'line-comment';
            continue;
        }

        if (char === '/' && next === '*') {
            out += '  ';
            i += 1;
            quote = 'block-comment';
            continue;
        }

        if (char === "'") {
            out += ' ';
            quote = 'single';
            continue;
        }

        if (char === '"') {
            out += ' ';
            quote = 'double';
            continue;
        }

        if (char === '$') {
            const rest = sql.slice(i);
            const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
            if (match?.[0]) {
                dollarTag = match[0];
                out += ' '.repeat(dollarTag.length);
                i += dollarTag.length - 1;
                continue;
            }
        }

        out += char;
    }

    return out;
}

function validateReadOnlyAgentSql(sql: string): string {
    let trimmed = sql.trim().replace(/;+\s*$/g, '').trim();
    if (!trimmed) throw new Error('SQL is required');
    const lower = trimmed.toLowerCase();
    if (!/^(select|with)\s/.test(lower)) {
        throw new Error('Only SELECT or WITH ... SELECT statements are allowed');
    }
    if (hasStatementSeparatorOutsideSqlLiterals(trimmed)) {
        throw new Error('Only one SQL statement is allowed');
    }
    const codeOnly = sqlCodeOutsideLiterals(trimmed).toLowerCase();
    if (/\b(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|copy|call|do|execute)\b/.test(codeOnly)) {
        throw new Error('Only read-only SELECT expressions are allowed');
    }
    if (/\b(pg_sleep|pg_advisory_lock|pg_advisory_xact_lock|pg_try_advisory_lock|pg_try_advisory_xact_lock)\s*\(/.test(codeOnly)) {
        throw new Error('Blocking or session-locking database functions are not allowed');
    }
    const broadMovingInfrastructureProximity =
        codeOnly.includes('core.position_fixes')
        && /\bcore\.(assets|events)\b/.test(codeOnly)
        && /\bst_dwithin\s*\(/.test(codeOnly)
        && /\b[a-z_][a-z0-9_.]*geom\s*::\s*geography[\s\S]{0,240},[\s\S]{0,240}\b[a-z_][a-z0-9_.]*geom\s*::\s*geography/.test(codeOnly);
    if (broadMovingInfrastructureProximity) {
        throw new Error(
            'Raw SQL proximity joins from core.position_fixes to infrastructure/events with geom::geography can bypass spatial indexes and stall the product. Use semantic OpenSpy geo tools such as worldview-cli geo spatial_join, geo corridor, or query related, or rewrite the SQL with a narrow indexed geometry prefilter before exact distance.',
        );
    }
    return trimmed;
}

let agentReadonlyRoleReady = false;
let agentReadonlyRoleError = '';

async function verifyAgentReadonlyRole(): Promise<void> {
    agentReadonlyRoleReady = false;
    agentReadonlyRoleError = '';
    if (!databaseService.isReady()) return;
    try {
        await databaseService.withTransaction(async () => {
            await databaseService.query('SET TRANSACTION READ ONLY');
            await databaseService.query('SET LOCAL ROLE app_agent_readonly');
            await databaseService.query('SELECT 1');
        });
        agentReadonlyRoleReady = true;
    } catch (err: any) {
        agentReadonlyRoleError = err?.message || 'app_agent_readonly role is not usable by the backend database user';
        console.error('[AgentSQL] app_agent_readonly role check failed:', err);
    }
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
    filter: (req, res) => {
        if (req.path.startsWith('/api/replay/render-chunks/') && req.path.endsWith('/data')) return false;
        if (req.path.startsWith('/api/agents/')) return false;
        return compression.filter(req, res);
    },
}));
app.use(express.json({ limit: '50mb' }));

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

async function collectSourceIngestStatus() {
    const latest = await sourcePersistenceService.listLatestSourceIngestMetrics();
    const latestByKey = new Map(latest.map((row) => [`${row.sourceId || ''}|${row.layerId || ''}`, row]));
    const configured = Object.values(SOURCE_BINDINGS)
        .slice()
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    return configured.map((binding) => {
        const row = latestByKey.get(`${binding.sourceId}|${binding.layerId}`) || null;
        return {
            sourceId: binding.sourceId,
            layerId: binding.layerId,
            canonicalTarget: binding.canonicalTarget,
            rawCaptureMode: binding.rawCaptureMode,
            storagePolicyId: binding.storagePolicyId,
            coverageScope: binding.coverageScope || null,
            status: row?.status || 'unavailable',
            completeness: row?.completeness || 'unavailable',
            latestIngest: row ? {
                ingestRunId: row.ingestRunId,
                startedAt: row.startedAt,
                completedAt: row.completedAt,
                upstreamBytes: row.upstreamBytes,
                rawCount: row.rawCount,
                normalizedCount: row.normalizedCount,
                changedCount: row.changedCount,
                parseMs: row.parseMs,
                dbWriteMs: row.dbWriteMs,
                rawPersistMs: row.rawPersistMs,
                totalMs: row.totalMs,
                renderBatchBytes: row.renderBatchBytes,
                errorMessage: row.errorMessage,
            } : null,
        };
    });
}

async function countCurrentCanonicalEvents(layerId: string, sourceId: string): Promise<number> {
    if (!databaseService.isReady()) return 0;
    try {
        const result = await databaseService.query<{ count: string }>(
            `
                SELECT COUNT(*)::text AS count
                FROM core.events
                WHERE layer_id = $1
                  AND source_id = $2
                  AND (valid_to IS NULL OR valid_to > now())
            `,
            [layerId, sourceId],
        );
        return Number(result?.rows?.[0]?.count || 0) || 0;
    } catch (error: any) {
        console.warn(`[status] failed to count ${sourceId}/${layerId} current events:`, error?.message || error);
        return 0;
    }
}

// ---------------------------------------------------------------------------
// User settings persistence (JSON file on disk)
// ---------------------------------------------------------------------------
const viewStateRepository = new ViewStateRepository(databaseService);
const selectionRepository = new SelectionRepository(databaseService);
const agentRepository = new AgentRepository(databaseService);
const catalogBootstrapService = new CatalogBootstrapService(databaseService);
const catalogReadService = new CatalogReadService(databaseService);
const viewControlService = new ViewControlService(viewStateRepository, catalogReadService);
const agentRuntimeService = new AgentRuntimeService(agentRepository, getRepoRootFromBackend());
const runtimeStateRepository = new RuntimeStateRepository(databaseService);
const eventQueryService = new EventQueryService(databaseService);
const entityQueryService = new EntityQueryService(databaseService);
const assetQueryService = new AssetQueryService(databaseService);
const liveProjectionService = new LiveProjectionService(databaseService);
const replayQueryService = new ReplayQueryService(databaseService);
const agentToolService = new AgentToolService(databaseService, catalogReadService, selectionRepository, viewControlService, replayQueryService);
const replayRenderBatchService = new ReplayRenderBatchService(replayQueryService);
const liveIngestEnabled = process.env.DISABLE_LIVE_INGEST !== 'true';
const REPLAY_RENDER_PREWARM_LAYERS = ['airspace', 'pipeline', 'cable', 'jamming', 'gfw', 'disasters', 'fire', 'outage', 'conflict'];
let replayRenderPrewarmInFlight = false;

async function prewarmReplayRenderChunksWindow(reason = 'startup'): Promise<void> {
    if (replayRenderPrewarmInFlight || !databaseService.isReady()) return;
    if (process.env.REPLAY_RENDER_PREWARM_DISABLED === 'true') return;
    replayRenderPrewarmInFlight = true;
    const startedAt = performance.now();
    try {
        const to = new Date();
        const from = new Date(to.getTime() - 60 * 60 * 1000);
        const result = await replayRenderBatchService.prewarmReplayChunks({
            at: to.toISOString(),
            from: from.toISOString(),
            to: to.toISOString(),
            layers: REPLAY_RENDER_PREWARM_LAYERS,
            z: 0,
            stepSeconds: 15 * 60,
            maxFrames: 5,
            aggregateFires: true,
        });
        logPerfEvent('replay.render_chunks_prewarm', {
            source: 'backend',
            reason,
            ...result,
            wallMs: Math.round(performance.now() - startedAt),
        });
        console.log(`[ReplayRender] Prewarmed ${result.chunks} chunks (${result.hits} hits, ${result.misses} misses, ${Math.round(result.bytes / 1024 / 1024)} MB) in ${Math.round(result.ms)}ms`);
    } catch (error: any) {
        console.error('[ReplayRender] Prewarm failed:', error?.message || error);
        logPerfEvent('replay.render_chunks_prewarm_failed', {
            source: 'backend',
            reason,
            error: error?.message || String(error),
            ms: Math.round(performance.now() - startedAt),
        });
    } finally {
        replayRenderPrewarmInFlight = false;
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

// ---------------------------------------------------------------------------
// Map icon packs
// ---------------------------------------------------------------------------
type IconTarget = {
    id: string;
    group: string;
    label: string;
    layer: string;
    subtype: string;
    file: string;
};

type IconPackIcon = IconTarget & {
    scale: number;
    opacity: number;
};

type IconPackManifest = {
    schemaVersion: number;
    id: string;
    name: string;
    icons: Record<string, IconPackIcon>;
    // Content revision (max file mtime, ms). The frontend appends it to icon
    // URLs so browser caches refresh together with manifest scale changes.
    revision?: number;
};

const ICON_PACK_REPO_ROOT = getRepoRootFromBackend();
const ICON_PACK_ROOT = path.join(ICON_PACK_REPO_ROOT, 'frontend/public/icon-packs');
const ICON_PACK_SETTINGS_FILE = path.join(ICON_PACK_ROOT, '_settings.json');
const ICON_TARGETS_FILE = path.join(ICON_PACK_REPO_ROOT, 'config/icon-targets.json');

function readIconTargets(): IconTarget[] {
    const parsed = JSON.parse(fs.readFileSync(ICON_TARGETS_FILE, 'utf8'));
    if (!Array.isArray(parsed?.targets)) return [];
    return parsed.targets.filter((target: any) =>
        target
        && typeof target.id === 'string'
        && typeof target.group === 'string'
        && typeof target.label === 'string'
        && typeof target.layer === 'string'
        && typeof target.subtype === 'string'
        && typeof target.file === 'string',
    );
}

function sanitizeIconPackId(value: unknown): string {
    const raw = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return raw || 'icon-pack';
}

function sanitizeSvgFileName(value: unknown, fallback: string): string {
    const base = path.basename(String(value || fallback))
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const withExt = base.toLowerCase().endsWith('.svg') ? base : `${base || fallback}.svg`;
    return withExt.slice(0, 96);
}

function iconPackPath(packId: string): string {
    const safeId = sanitizeIconPackId(packId);
    return path.join(ICON_PACK_ROOT, safeId);
}

function assertInsideIconPackRoot(filePath: string): void {
    const relative = path.relative(ICON_PACK_ROOT, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Invalid icon pack path');
    }
}

function normalizeIconManifestIcon(target: IconTarget, icon: Partial<IconPackIcon> | undefined): IconPackIcon {
    return {
        ...target,
        file: sanitizeSvgFileName(icon?.file || target.file, target.file),
        scale: Number.isFinite(Number(icon?.scale)) ? Math.max(0.05, Math.min(8, Number(icon?.scale))) : 1,
        opacity: Number.isFinite(Number(icon?.opacity)) ? Math.max(0, Math.min(1, Number(icon?.opacity))) : 1,
    };
}

async function readIconPackSettings(): Promise<{ activePackId: string }> {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(ICON_PACK_SETTINGS_FILE, 'utf8'));
        return { activePackId: sanitizeIconPackId(parsed?.activePackId || 'default') };
    } catch {
        return { activePackId: 'default' };
    }
}

async function writeIconPackSettings(activePackId: string): Promise<void> {
    await fs.promises.mkdir(ICON_PACK_ROOT, { recursive: true });
    await fs.promises.writeFile(
        ICON_PACK_SETTINGS_FILE,
        JSON.stringify({ schemaVersion: 1, activePackId: sanitizeIconPackId(activePackId) }, null, 2) + '\n',
    );
}

async function readIconPackManifest(packId: string): Promise<IconPackManifest> {
    const safeId = sanitizeIconPackId(packId);
    const manifestPath = path.join(iconPackPath(safeId), 'manifest.json');
    assertInsideIconPackRoot(manifestPath);
    const parsed = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    const targets = readIconTargets();
    const icons: Record<string, IconPackIcon> = {};
    for (const target of targets) {
        icons[target.id] = normalizeIconManifestIcon(target, parsed?.icons?.[target.id]);
    }
    let revision = 0;
    const packDir = iconPackPath(safeId);
    const files = await fs.promises.readdir(packDir).catch(() => [] as string[]);
    for (const file of files) {
        const stat = await fs.promises.stat(path.join(packDir, file)).catch(() => null);
        if (stat) revision = Math.max(revision, Math.round(stat.mtimeMs));
    }
    return {
        schemaVersion: 1,
        id: safeId,
        name: typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name.trim() : safeId,
        icons,
        revision,
    };
}

async function writeIconPackManifest(manifest: IconPackManifest): Promise<void> {
    const safeId = sanitizeIconPackId(manifest.id);
    const manifestPath = path.join(iconPackPath(safeId), 'manifest.json');
    assertInsideIconPackRoot(manifestPath);
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.promises.writeFile(manifestPath, JSON.stringify({ ...manifest, id: safeId }, null, 2) + '\n');
}

async function listIconPackPayload() {
    await fs.promises.mkdir(ICON_PACK_ROOT, { recursive: true });
    const targets = readIconTargets();
    const entries = await fs.promises.readdir(ICON_PACK_ROOT, { withFileTypes: true }).catch(() => []);
    const packs: IconPackManifest[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
            packs.push(await readIconPackManifest(entry.name));
        } catch (error: any) {
            console.warn(`[icon-packs] skipped ${entry.name}:`, error?.message || error);
        }
    }
    packs.sort((a, b) => a.name.localeCompare(b.name));
    const settings = await readIconPackSettings();
    const activePackId = packs.some((pack) => pack.id === settings.activePackId)
        ? settings.activePackId
        : (packs[0]?.id || 'default');
    return { activePackId, targets, packs };
}

app.get('/api/icon-packs', async (_req, res) => {
    try {
        res.json(await listIconPackPayload());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/icon-packs', async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim() || 'Icon Pack';
        const requestedId = sanitizeIconPackId(req.body?.id || name);
        let packId = requestedId;
        let suffix = 2;
        while (fs.existsSync(iconPackPath(packId))) {
            packId = `${requestedId}-${suffix++}`;
        }

        const cloneFrom = sanitizeIconPackId(req.body?.cloneFrom || 'default');
        const sourceManifest = await readIconPackManifest(cloneFrom);
        const sourceDir = iconPackPath(cloneFrom);
        const targetDir = iconPackPath(packId);
        assertInsideIconPackRoot(targetDir);
        await fs.promises.mkdir(targetDir, { recursive: false });

        const nextManifest: IconPackManifest = {
            ...sourceManifest,
            id: packId,
            name,
            icons: { ...sourceManifest.icons },
        };
        for (const icon of Object.values(sourceManifest.icons)) {
            const sourceFile = path.join(sourceDir, icon.file);
            const targetFile = path.join(targetDir, icon.file);
            assertInsideIconPackRoot(sourceFile);
            assertInsideIconPackRoot(targetFile);
            if (fs.existsSync(sourceFile)) {
                await fs.promises.copyFile(sourceFile, targetFile);
            }
        }
        await writeIconPackManifest(nextManifest);
        res.json(await listIconPackPayload());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.put('/api/icon-packs/active', async (req, res) => {
    try {
        const packId = sanitizeIconPackId(req.body?.packId);
        await readIconPackManifest(packId);
        await writeIconPackSettings(packId);
        res.json(await listIconPackPayload());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.patch('/api/icon-packs/:packId/icons/:iconId', async (req, res) => {
    try {
        const packId = sanitizeIconPackId(req.params.packId);
        const iconId = decodeURIComponent(req.params.iconId || '');
        const targets = readIconTargets();
        const target = targets.find((candidate) => candidate.id === iconId);
        if (!target) {
            res.status(404).json({ error: 'Icon target not found' });
            return;
        }
        const manifest = await readIconPackManifest(packId);
        manifest.icons[iconId] = normalizeIconManifestIcon(target, {
            ...manifest.icons[iconId],
            scale: req.body?.scale,
            opacity: req.body?.opacity,
            file: req.body?.file || manifest.icons[iconId]?.file,
        });
        await writeIconPackManifest(manifest);
        res.json(await listIconPackPayload());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.patch('/api/icon-packs/:packId/icons', async (req, res) => {
    try {
        const packId = sanitizeIconPackId(req.params.packId);
        const updates = req.body?.icons && typeof req.body.icons === 'object' ? req.body.icons : {};
        const targets = readIconTargets();
        const targetsById = new Map(targets.map((target) => [target.id, target]));
        const manifest = await readIconPackManifest(packId);
        for (const [iconId, patch] of Object.entries(updates)) {
            const target = targetsById.get(iconId);
            if (!target) continue;
            const iconPatch = patch && typeof patch === 'object' ? patch as any : {};
            manifest.icons[iconId] = normalizeIconManifestIcon(target, {
                ...manifest.icons[iconId],
                scale: iconPatch.scale,
                opacity: iconPatch.opacity,
                file: iconPatch.file || manifest.icons[iconId]?.file,
            });
        }
        await writeIconPackManifest(manifest);
        res.json(await listIconPackPayload());
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/icon-packs/:packId/icons/:iconId/upload', async (req, res) => {
    try {
        const packId = sanitizeIconPackId(req.params.packId);
        const iconId = decodeURIComponent(req.params.iconId || '');
        const targets = readIconTargets();
        const target = targets.find((candidate) => candidate.id === iconId);
        if (!target) {
            res.status(404).json({ error: 'Icon target not found' });
            return;
        }
        const svg = String(req.body?.svg || '').trim();
        if (!svg.startsWith('<svg') || /<script[\s>]/i.test(svg) || svg.length > 512_000) {
            res.status(400).json({ error: 'Expected a safe SVG document under 512KB' });
            return;
        }
        const manifest = await readIconPackManifest(packId);
        const fileName = sanitizeSvgFileName(req.body?.filename, target.file);
        const filePath = path.join(iconPackPath(packId), fileName);
        assertInsideIconPackRoot(filePath);
        await fs.promises.writeFile(filePath, svg + (svg.endsWith('\n') ? '' : '\n'));
        manifest.icons[iconId] = normalizeIconManifestIcon(target, {
            ...manifest.icons[iconId],
            file: fileName,
        });
        await writeIconPackManifest(manifest);
        res.json(await listIconPackPayload());
    } catch (err: any) {
        sendError(res, err);
    }
});

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

app.get('/api/catalog/render-contracts', async (_req, res) => {
    try {
        res.json(await catalogReadService.listRenderContracts());
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
        const result = await viewControlService.patchStateWithExplanation(patch);
        res.json({ updated: true, ...result });
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
        const result = await viewControlService.setLegendNodeStateWithExplanation(nodeId, enabled, target);
        res.json({ updated: true, nodeId, target, ...result });
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
        const saveInput = parseSelectionSaveInput(req.body || {});
        const selection = await selectionRepository.saveSelection(saveInput);
        const shouldMaterialize = req.body?.materialize === true || req.body?.metadata?.materialize === true;
        const materialization = shouldMaterialize
            ? await agentToolService.materializeSelection(selection.selection_id, { limit: req.body?.materializeLimit || req.body?.maxItems })
            : null;
        res.json({
            selection_id: selection.selection_id,
            layer: selection.layer_id,
            query_spec: selection.predicate,
            geometry: selection.geometry_json,
            metadata: selection.metadata,
            expires_at: selection.expires_at || null,
            materialization,
        });
    } catch (err: any) {
        sendSelectionPredicateErrorOrFallback(res, err);
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
            expires_at: selection.expires_at || null,
            materialized_count: selection.materialized_count || 0,
            materialization_status: selection.materialization_status || 'none',
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
        const saveInput = parseSelectionSaveInput(req.body || {}, current);
        const selection = await selectionRepository.saveSelection(saveInput);
        const shouldMaterialize = req.body?.materialize === true || req.body?.metadata?.materialize === true;
        const materialization = shouldMaterialize
            ? await agentToolService.materializeSelection(selection.selection_id, { limit: req.body?.materializeLimit || req.body?.maxItems })
            : null;
        res.json({
            selection_id: selection.selection_id,
            layer: selection.layer_id,
            query_spec: selection.predicate,
            geometry: selection.geometry_json,
            metadata: selection.metadata,
            expires_at: selection.expires_at || null,
            materialization,
        });
    } catch (err: any) {
        sendSelectionPredicateErrorOrFallback(res, err);
    }
});

app.post('/api/selections/:selectionId/materialize', async (req, res) => {
    try {
        const data = await agentToolService.materializeSelection(req.params.selectionId, req.body || {});
        res.json({ status: 'ok', data, warnings: [] });
    } catch (err: any) {
        res.status(400).json({
            status: 'error',
            error: {
                code: 'SELECTION_MATERIALIZE_FAILED',
                message: err.message || 'Failed to materialize selection',
            },
        });
    }
});

app.get('/api/selections/:selectionId/items', async (req, res) => {
    try {
        const data = await agentToolService.listSelectionItems(req.params.selectionId, {
            limit: req.query.limit,
            offset: req.query.offset,
        });
        res.json({ status: 'ok', data, warnings: [] });
    } catch (err: any) {
        res.status(400).json({
            status: 'error',
            error: {
                code: 'SELECTION_ITEMS_FAILED',
                message: err.message || 'Failed to list selection items',
            },
        });
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
        const selection = await selectionRepository.getSelection(selectionId);
        if (!selection) {
            res.status(404).json({ error: 'Selection not found or expired' });
            return;
        }
        const result = await viewControlService.applySelectionWithExplanation(layer, selectionId, mode);
        res.json({ applied: true, layer, selection_id: selectionId, mode, ...result });
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
        const result = await viewControlService.clearSelectionWithExplanation(layer);
        res.json({ cleared: true, layer, ...result });
    } catch (err: any) {
        sendError(res, err);
    }
});

function acledIngestCredentialsConfigured(): boolean {
    const mode = (process.env.ACLED_AUTH_MODE || '').trim().toLowerCase();
    const email = Boolean(process.env.ACLED_EMAIL);
    const password = Boolean(process.env.ACLED_PASSWORD);
    const key = Boolean(process.env.ACLED_KEY);
    if (mode === 'oauth') return email && password;
    if (mode === 'legacy-key') return email && key;
    if (email && key) return true;
    return email && password && process.env.ACLED_ENABLE_PASSWORD_OAUTH === 'true';
}

type SourceFetchStatus = 'available' | 'auth_required' | 'unsupported' | 'planned';
type SourceFetchCapability = {
    source: string;
    status: SourceFetchStatus;
    history: string;
    notes: string;
    policy?: Record<string, unknown>;
};

const SOURCE_FETCH_CAPABILITIES: Record<string, SourceFetchCapability> = {
    'cloudflare-outages': {
        source: 'cloudflare_radar',
        status: process.env.CLOUDFLARE_API_TOKEN ? 'available' : 'auth_required',
        history: 'Provider supports time-window outage queries; backend connector is already present for live polling.',
        notes: 'Fetches and persists Cloudflare Radar outage annotations for the requested time window.',
        policy: {
            free_tier: 'Cloudflare Radar API access depends on the configured account/token.',
            min_fetch_interval_ms: 60_000,
            min_provider_request_interval_ms: Number.parseInt(process.env.CLOUDFLARE_MIN_REQUEST_INTERVAL_MS || '60000', 10) || 60_000,
            max_window_hours: 24,
            default_page_size: Number.parseInt(process.env.CLOUDFLARE_OUTAGE_PAGE_SIZE || process.env.CLOUDFLARE_OUTAGE_LIMIT || '100', 10) || 100,
            max_pages: Number.parseInt(process.env.CLOUDFLARE_OUTAGE_MAX_PAGES || '50', 10) || 50,
        },
    },
    'gfw-events': {
        source: 'gfw',
        status: process.env.GFW_TOKEN ? 'available' : 'auth_required',
        history: 'Provider can return vessel tracks/events when token and product access allow it.',
        notes: 'Fetches and persists GFW gap events for an explicit date window.',
    },
    'vessel-enrichment': {
        source: 'wikimedia_commons',
        status: 'available',
        history: 'Wikimedia Commons keys ship media by IMO number (Category:IMO <imo>, optionally nested in a ship-name subcategory); the GFW Vessels API resolves registry identity for the same IMO.',
        notes: 'Fetches vessel photos from Wikimedia Commons plus GFW registry identity for a 7-digit --imo and caches the combined result in core.vessel_enrichment. The GFW portion reuses the gfw source GFW_TOKEN and reports per-provider state in provider_status instead of failing the whole operation.',
        policy: {
            free_tier: 'Commons MediaWiki API is keyless; GFW identity uses the configured non-commercial GFW token.',
            cache_ttl_hours_hit: 720,
            cache_ttl_hours_miss: 24,
            photos_limit: 20,
            gfw_identity_status: process.env.GFW_TOKEN ? 'available' : 'auth_required',
        },
    },
    'acled-conflicts': {
        source: 'acled',
        status: acledIngestCredentialsConfigured() ? 'planned' : 'auth_required',
        history: 'ACLED supports account/license-dependent event reads by timestamp/date filters. OpenSpy currently runs incremental ACLED ingest when credentials are configured.',
        notes: 'This operation status refers only to arbitrary user-triggered ACLED historical data import, which is not executable yet. Local incremental ACLED ingest is a separate configured source capability and can populate conflict snapshots when credentials are present.',
        policy: {
            free_tier: 'ACLED requires a myACLED account/license; availability depends on account terms.',
            live_poll_ms: 30 * 60 * 1000,
            bootstrap_lookback_days: Number.parseInt(process.env.ACLED_BOOTSTRAP_LOOKBACK_DAYS || '7', 10) || 7,
            incremental_overlap_hours: Number.parseFloat(process.env.ACLED_INCREMENTAL_OVERLAP_HOURS || '6') || 6,
            page_size: Number.parseInt(process.env.ACLED_PAGE_SIZE || '5000', 10) || 5000,
            max_pages: Number.parseInt(process.env.ACLED_MAX_PAGES || '100', 10) || 100,
            provider_fetch_status: 'planned',
            local_incremental_ingest_status: acledIngestCredentialsConfigured() ? 'available' : 'auth_required',
        },
    },
    'opensky-tracks': {
        source: 'opensky',
        status: process.env.OPENSKY_USERNAME && process.env.OPENSKY_PASSWORD ? 'available' : 'auth_required',
        history: 'OpenSky REST exposes an experimental per-aircraft track endpoint for a known ICAO24 and timestamp; deeper bulk history requires OpenSky data infrastructure/licensing.',
        notes: 'Fetches one aircraft trajectory around a requested timestamp and persists returned waypoints into aircraft position fixes.',
        policy: {
            free_tier: 'Authenticated OpenSky REST credits are limited; use local DB first and do not poll provider history during replay.',
            current_state_poll_seconds: 90,
            authenticated_state_history_limit: 'up to 1 hour in the past on the REST state endpoint',
            tracks_endpoint: 'experimental per-aircraft trajectory endpoint; not a bulk AOI history API',
        },
    },
    'spacetrack-gp-history': {
        source: 'space_track',
        status: process.env.SPACETRACK_EMAIL && process.env.SPACETRACK_PASSWORD ? 'available' : 'auth_required',
        history: 'Space-Track GP_HISTORY can provide historical orbital elements for targeted NORAD IDs and epoch windows.',
        notes: 'Fetches historical TLE/3LE records for targeted NORAD IDs and stores orbital epochs for satellite replay.',
        policy: {
            free_tier: 'Account-based public access; cache aggressively and respect Space-Track request limits.',
            current_tle_cache_hours: 24,
            provider_history_import: 'available for targeted NORAD/time windows when credentials are configured',
        },
    },
    'firms-fires': {
        source: 'firms',
        status: process.env.FIRMS_MAP_KEY || process.env.NASA_FIRMS_MAP_KEY ? 'available' : 'auth_required',
        history: 'NASA FIRMS Area API exposes dated CSV fire products with MAP_KEY, source, bbox/world area, day range and date.',
        notes: 'Fetches VIIRS/MODIS active-fire CSV for an explicit date/day range and persists normalized fire events when credentials are configured.',
        policy: {
            free_tier: 'NASA FIRMS MAP_KEY is free by email and documents 5,000 transactions per 10 minutes.',
            max_day_range: 10,
            default_poll_minutes: 30,
            upstream_granularity: 'VIIRS/MODIS active-fire products, not raw satellite imagery',
            visual_overlay: 'FIRMS WMS/WMS-Time overlay is proxied by the backend so the MAP_KEY is not exposed to browser or agent.',
        },
    },
    'usgs-earthquakes': {
        source: 'usgs',
        status: 'available',
        history: 'USGS FDSN earthquake catalog supports GeoJSON queries by start/end time, magnitude and bbox.',
        notes: 'Fetches and persists earthquake events into the disaster layer for the requested window.',
    },
    'eonet-events': {
        source: 'eonet',
        status: 'available',
        history: 'NASA EONET v3 supports status, days, start, end and bbox filters for natural events.',
        notes: 'Fetches and persists EONET natural events into the disaster layer for the requested window.',
    },
    'gdacs-disasters': {
        source: 'gdacs',
        status: 'available',
        history: 'GDACS exposes a public SEARCH API for historical event windows and a current/recent MAP feed for map context.',
        notes: 'Fetches and persists GDACS disaster alerts. Requests with --from and --to use SEARCH with provider pagination; requests without a time window use the current/recent MAP feed.',
        policy: {
            free_tier: 'GDACS data are free through the public API; acknowledge Global Disaster Alert and Coordination System, GDACS.',
            search_page_size: 'provider returns up to 100 records per page; OpenSpy follows pagenumber until the provider returns no more rows unless --max-pages is explicitly provided',
            map_feed_mode: 'current/recent map context when no historical window is supplied',
        },
    },
    'ioda-outages': {
        source: 'ioda',
        status: 'available',
        history: 'The current IODA connector queries country-level alerts over a Unix timestamp window.',
        notes: 'Fetches and persists country-level IODA outage alerts for the requested window. Treat as alert-level evidence, not full raw signal history.',
    },
    'gpsjam-history': {
        source: 'gpsjam',
        status: 'available',
        history: 'GPSJam publishes daily historical CSV products.',
        notes: 'Fetches and persists a daily GPSJam H3 CSV by YYYY-MM-DD date.',
    },
    'nasa-gibs-imagery': {
        source: 'nasa_gibs',
        status: 'available',
        history: 'NASA GIBS/Worldview provides date-addressable public WMTS/WMS imagery layers.',
        notes: 'UI can display time-aware NASA GIBS imagery overlays. This operation returns metadata and map actions, not raw pixels.',
        policy: {
            free_tier: 'Public NASA GIBS/Worldview WMTS/WMS imagery; no product key is required.',
            selected_date_rule: 'default to yesterday UTC because same-day true-color tiles can be incomplete',
            tile_cache: 'browser/provider tile cache only; no raw imagery is stored locally by default',
        },
    },
    'imagery-search-latest': {
        source: 'nasa_gibs',
        status: 'available',
        history: 'NASA GIBS/Worldview provides public daily/date-addressable global imagery layers suitable for fresh context overlays.',
        notes: 'Returns a lightweight scene descriptor for the latest usable NASA GIBS date and UI actions for overlay/compare. It does not download raw pixels.',
        policy: {
            free_tier: 'Public NASA GIBS/Worldview WMTS/WMS imagery; no product key is required.',
            selected_date_rule: 'default to yesterday UTC because same-day true-color tiles can be incomplete',
            resolution: 'context imagery; use Copernicus Sentinel or Landsat for higher-resolution targeted scenes',
        },
    },
    'copernicus-sentinel-imagery': {
        source: 'copernicus',
        status: process.env.COPERNICUS_CLIENT_ID && process.env.COPERNICUS_CLIENT_SECRET ? 'available' : 'auth_required',
        history: 'Copernicus Data Space can search Sentinel scenes by AOI/time after registration/auth.',
        notes: 'Searches Sentinel scene metadata and renders bounded Sentinel-2 optical previews and Sentinel-1 GRD VV radar previews through backend-owned Sentinel Hub APIs.',
        policy: {
            free_tier: 'Copernicus Data Space / Sentinel Hub general-user access is free after registration within request and processing-unit quotas.',
            max_search_window_days: Number.parseInt(process.env.COPERNICUS_MAX_SEARCH_WINDOW_DAYS || '14', 10) || 14,
            max_bbox_area_degrees2: Number.parseFloat(process.env.COPERNICUS_MAX_BBOX_AREA_DEG2 || '25') || 25,
            max_results: Number.parseInt(process.env.COPERNICUS_MAX_SEARCH_RESULTS || '10', 10) || 10,
            min_provider_request_interval_ms: Number.parseInt(process.env.COPERNICUS_MIN_REQUEST_INTERVAL_MS || '2500', 10) || 2500,
            default_render_max_pixels: Number.parseInt(process.env.COPERNICUS_MAX_RENDER_PIXELS || '1024', 10) || 1024,
        },
    },
    'landsat-stac-imagery': {
        source: 'usgs_landsat',
        status: 'available',
        history: 'USGS Landsat STAC supports public historical AOI/time scene search.',
        notes: 'Searches Landsat STAC scene metadata and returns browse/thumbnail overlay actions when available. It does not render raw multiband COG products.',
        policy: {
            free_tier: 'USGS/Landsat public STAC archive access is free for metadata and browse assets.',
            visual_overlay: 'rough browse/thumbnail georeferenced to the STAC bbox; raw COG rendering is not implemented',
        },
    },
    'imagery-evidence-artifact': {
        source: 'imagery_artifact',
        status: 'available',
        history: 'Creates a bounded evidence image artifact from an already selected imagery source or preview payload.',
        notes: 'Downloads or renders one image artifact for human/vision review. It does not fabricate pixel analysis and does not import raw imagery into replay storage.',
        policy: {
            product_status: 'download/render artifact path; backend vision analysis is not executed by this operation',
            supported_sources: ['copernicus', 'landsat', 'firms'],
        },
    },
};

function currentSourceFetchStatus(operation: string, base: SourceFetchCapability): SourceFetchStatus {
    if (operation === 'cloudflare-outages') return process.env.CLOUDFLARE_API_TOKEN ? 'available' : 'auth_required';
    if (operation === 'gfw-events') return process.env.GFW_TOKEN ? 'available' : 'auth_required';
    if (operation === 'acled-conflicts') return acledIngestCredentialsConfigured() ? 'planned' : 'auth_required';
    if (operation === 'opensky-tracks') return process.env.OPENSKY_USERNAME && process.env.OPENSKY_PASSWORD ? 'available' : 'auth_required';
    if (operation === 'spacetrack-gp-history') return process.env.SPACETRACK_EMAIL && process.env.SPACETRACK_PASSWORD ? 'available' : 'auth_required';
    if (operation === 'firms-fires') return process.env.FIRMS_MAP_KEY || process.env.NASA_FIRMS_MAP_KEY ? 'available' : 'auth_required';
    if (operation === 'copernicus-sentinel-imagery') return process.env.COPERNICUS_CLIENT_ID && process.env.COPERNICUS_CLIENT_SECRET ? 'available' : 'auth_required';
    return base.status;
}

function currentSourceFetchCapability(operation: string): SourceFetchCapability | null {
    const base = SOURCE_FETCH_CAPABILITIES[operation];
    if (!base) return null;
    return {
        ...base,
        status: currentSourceFetchStatus(operation, base),
    };
}

function currentSourceFetchCapabilities(): Record<string, SourceFetchCapability> {
    return Object.fromEntries(
        Object.keys(SOURCE_FETCH_CAPABILITIES).map((operation) => [operation, currentSourceFetchCapability(operation)!]),
    );
}

function envInt(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
    const parsed = Number.parseFloat(process.env[name] || '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SOURCE_PROVIDER_POLICIES: Record<string, Record<string, unknown>> = {
    cloudflare_radar: {
        account_tier: 'configured Cloudflare account/token; Radar API access is free on available plans, subject to Cloudflare terms',
        upstream_rate_limit_reference: 'Cloudflare global REST API limit is documented as 1,200 requests / 5 minutes per user/account token and 200 requests / second per IP; OpenSpy uses a stricter local gate.',
        local_cadence: {
            live_poll_ms: 15 * 60 * 1000,
            source_fetch_min_interval_ms: envInt('CLOUDFLARE_MIN_REQUEST_INTERVAL_MS', 60_000),
            source_fetch_max_window_hours: 24,
            source_fetch_page_size: envInt('CLOUDFLARE_OUTAGE_PAGE_SIZE', 100),
            source_fetch_max_pages: envInt('CLOUDFLARE_OUTAGE_MAX_PAGES', 50),
        },
        replay_rule: 'Replay reads local event snapshots; replay speed never increases Cloudflare provider polling.',
        storage_rule: 'Persist raw audit payloads and normalized outage events when provider fetch executes.',
    },
    copernicus: {
        account_tier: 'Copernicus Data Space / Sentinel Hub registration; general-user access is free within request and processing-unit quotas.',
        upstream_rate_limit_reference: 'General user quotas include monthly/per-minute request and processing-unit limits; OpenSpy keeps AOI and render requests bounded.',
        local_cadence: {
            source_fetch_min_interval_ms: envInt('COPERNICUS_MIN_REQUEST_INTERVAL_MS', 2500),
            search_cache_seconds: envInt('COPERNICUS_SEARCH_CACHE_SECONDS', 600),
            render_cache_seconds: envInt('COPERNICUS_RENDER_CACHE_SECONDS', 3600),
            max_search_window_days: envInt('COPERNICUS_MAX_SEARCH_WINDOW_DAYS', 14),
            max_bbox_area_degrees2: envFloat('COPERNICUS_MAX_BBOX_AREA_DEG2', 25),
            max_search_results: envInt('COPERNICUS_MAX_SEARCH_RESULTS', 10),
            max_render_pixels: envInt('COPERNICUS_MAX_RENDER_PIXELS', 1024),
        },
        replay_rule: 'Sentinel imagery is a targeted visual overlay/action, not a replay-clock source and not canonical vector hydration.',
        storage_rule: 'Store search/render cache only; raw Sentinel products are not imported into canonical storage by default.',
    },
    opensky: {
        account_tier: 'OpenSky OAuth client; authenticated REST credits are limited.',
        upstream_rate_limit_reference: 'Authenticated state-vector endpoint uses daily credits; standard account bucket is 4,000 credits/day.',
        local_cadence: {
            live_poll_seconds: 90,
            provider_history_max_past_window: 'up to 1 hour for authenticated REST state vectors; deeper history requires OpenSky data infrastructure/licensing',
        },
        replay_rule: 'Aircraft replay reads local position_fixes. Provider history is a user-triggered gap-fill path only when implemented, never tied to replay speed.',
        storage_rule: 'Store accepted aircraft fixes and entity snapshots locally.',
    },
    acled: {
        account_tier: 'myACLED account/license; credentials required for the ACLED provider path.',
        upstream_rate_limit_reference: 'ACLED access is account/license dependent. OpenSpy uses incremental timestamp windows and page caps.',
        local_cadence: {
            live_poll_ms: 30 * 60 * 1000,
            bootstrap_lookback_days: envInt('ACLED_BOOTSTRAP_LOOKBACK_DAYS', 7),
            incremental_overlap_hours: envFloat('ACLED_INCREMENTAL_OVERLAP_HOURS', 6),
            page_size: envInt('ACLED_PAGE_SIZE', 5000),
            max_pages: envInt('ACLED_MAX_PAGES', 100),
        },
        replay_rule: 'Conflict replay reads local event snapshots. ACLED provider ingest is incremental and independent from replay speed.',
        storage_rule: 'Persist raw pages, deleted-event pages and normalized conflict events when credentials are configured.',
    },
    celestrak: {
        account_tier: 'Public fallback for current satellite GP/TLE catalogs; no key.',
        upstream_rate_limit_reference: 'CelesTrak checks for GP updates roughly every 2 hours and can block aggressive clients.',
        local_cadence: {
            current_tle_cache_hours: 24,
            recommended_provider_refresh_hours: 2,
        },
        replay_rule: 'Satellite positions are computed from stored orbital elements; replay speed never downloads new TLEs.',
        storage_rule: 'Store orbital element snapshots for replay and audit.',
    },
    space_track: {
        account_tier: 'Space-Track account required for primary GP and GP_HISTORY.',
        upstream_rate_limit_reference: 'Respect Space-Track request limits; cache aggressively and do not repeatedly query GP_HISTORY.',
        local_cadence: {
            current_tle_cache_hours: 24,
            historical_gp_import: 'available for targeted NORAD/time windows when credentials are configured',
        },
        replay_rule: 'Deep satellite replay requires stored historical GP/TLE epochs selected at or before the replay timestamp.',
        storage_rule: 'Historical orbital elements must be stored in core.orbital_elements before being advertised as available replay evidence.',
    },
    firms: {
        account_tier: 'Free NASA FIRMS MAP_KEY by email.',
        upstream_rate_limit_reference: 'NASA FIRMS MAP_KEY documents 5,000 transactions / 10 minutes.',
        local_cadence: {
            default_poll_minutes: 30,
            source_fetch_max_day_range: 10,
        },
        replay_rule: 'Fire replay reads local event snapshots; FIRMS source-fetch is user/action driven.',
        storage_rule: 'Persist active-fire rows as normalized fire events and raw CSV audit payloads when fetched.',
    },
    nasa_gibs: {
        account_tier: 'Public NASA GIBS/Worldview WMTS/WMS; no OpenSpy key required.',
        upstream_rate_limit_reference: 'Use provider/browser tile caching. OpenSpy does not bulk-download global imagery tiles.',
        local_cadence: {
            selected_date_rule: 'default to yesterday UTC because same-day true-color tiles can be incomplete',
            tile_cache: 'browser/provider cache',
        },
        replay_rule: 'GIBS is date-addressable context imagery and must not block replay hydration.',
        storage_rule: 'No raw pixel storage by default.',
    },
    usgs_landsat: {
        account_tier: 'Public USGS Landsat STAC archive; no OpenSpy key required for metadata and browse assets.',
        upstream_rate_limit_reference: 'Use targeted AOI/time searches. OpenSpy does not bulk-download Landsat COG assets.',
        local_cadence: {
            search_mode: 'user/action-driven source-fetch',
            visual_overlay: 'browse/thumbnail overlay georeferenced by STAC bbox',
        },
        replay_rule: 'Landsat browse imagery is date-addressed context imagery and must not block replay hydration.',
        storage_rule: 'No raw pixel or COG storage by default.',
    },
    imagery_artifact: {
        account_tier: 'OpenSpy-local artifact store using already configured imagery providers.',
        upstream_rate_limit_reference: 'Artifact creation performs one bounded provider image request or one preview download per operation.',
        local_cadence: {
            storage_dir: '.local/imagery-artifacts',
            product_status: 'download/render artifact only; no backend visual inference is executed here',
        },
        replay_rule: 'Imagery artifacts are evidence attachments. They do not retime vector replay and do not hydrate canonical replay state.',
        storage_rule: 'Stores image file plus redacted metadata in local artifact storage.',
    },
};

function providerPolicyForSource(sourceId: string): Record<string, unknown> | null {
    if (SOURCE_PROVIDER_POLICIES[sourceId]) return SOURCE_PROVIDER_POLICIES[sourceId];
    if (sourceId === 'space-track' || sourceId === 'spacetrack') return SOURCE_PROVIDER_POLICIES.space_track;
    if (sourceId === 'space_track') return SOURCE_PROVIDER_POLICIES.space_track;
    return null;
}

function providerPolicyForSourceFetchOperation(operation: string, sourceId: string): Record<string, unknown> | null {
    if (operation === 'spacetrack-gp-history') return SOURCE_PROVIDER_POLICIES.space_track;
    return providerPolicyForSource(sourceId);
}

function authConfigured(manifest: any): boolean | null {
    const auth = manifest?.auth;
    if (!auth || auth.required === false) return true;
    const sourceId = String(manifest?.id || manifest?.source_id || manifest?.slug || '').trim().toLowerCase();
    if (sourceId === 'acled') return acledIngestCredentialsConfigured();
    const keys = Array.isArray(auth.env_keys) ? auth.env_keys : [];
    if (keys.length === 0) return null;
    return keys.every((key: string) => Boolean(process.env[key]));
}

function sourceFetchAuthMetadata(manifest: any): Record<string, unknown> | null {
    const auth = manifest?.source_fetch_auth;
    if (!auth) return null;
    const envKeys = Array.isArray(auth.env_keys) ? auth.env_keys.map((key: unknown) => String(key)).filter(Boolean) : [];
    const required = Boolean(auth.required);
    return {
        required,
        configured: required
            ? (envKeys.length > 0 ? envKeys.some((key: string) => Boolean(process.env[key])) : null)
            : true,
        method: auth.method || null,
        env_keys: envKeys,
        limits: auth.limits || null,
    };
}

function stableHash(value: unknown): string {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

type OpenSpyBbox = [number, number, number, number]; // west, south, east, north
type ProviderBboxSwne = [number, number, number, number]; // south, west, north, east

const SPACETRACK_LOGIN_URL = 'https://www.space-track.org/ajaxauth/login';
const SPACETRACK_GP_HISTORY_BASE_URL = 'https://www.space-track.org/basicspacedata/query/class/gp_history';
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSPY_LOCAL_ARTIFACT_DIR = path.resolve(__dirname, '../..', '.local/imagery-artifacts');

function classifyAircraftForSourceFetch(callsign: string, altMeters: number | null, speedMps: number | null): 'military' | 'airliner' | 'light' | 'general' {
    const cs = String(callsign || '').toUpperCase();
    if (/^(RCH|CMB|HKY|VV|VV|NATO|ASY|FORTE|JAKE|DUKE|QID|LAGR|BART|CNV|IAM|MMF|BAF|FNF|CTM)/.test(cs)) return 'military';
    if ((altMeters ?? 0) > 8000 || (speedMps ?? 0) > 180) return 'airliner';
    if ((altMeters ?? 0) < 3000 && (speedMps ?? 0) < 90) return 'light';
    return 'general';
}

function extractNoradIdFromTle(tleLine1: string): number {
    const match = String(tleLine1 || '').match(/^1\s+(\d+)/);
    return match ? Number.parseInt(match[1], 10) : -1;
}

function parseTleEpochAtFromLine1(tleLine1: string): string | null {
    if (!tleLine1 || tleLine1.length < 32) return null;
    const epochYear = Number.parseInt(tleLine1.slice(18, 20).trim(), 10);
    const dayOfYear = Number.parseFloat(tleLine1.slice(20, 32).trim());
    if (!Number.isFinite(epochYear) || !Number.isFinite(dayOfYear) || dayOfYear < 1) return null;
    const fullYear = epochYear >= 57 ? 1900 + epochYear : 2000 + epochYear;
    const epochMs = Date.UTC(fullYear, 0, 1, 0, 0, 0, 0) + (dayOfYear - 1) * 86_400_000;
    const date = new Date(epochMs);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function classifySatelliteTypeByName(name: string): 'military' | 'civilian' | 'commercial' {
    const nameUpper = String(name || '').toUpperCase();
    if (nameUpper.includes('USA') || nameUpper.includes('COSMOS') || nameUpper.includes('YAOGAN')) return 'military';
    if (nameUpper.includes('STARLINK') || nameUpper.includes('ONEWEB') || nameUpper.includes('WORLDVIEW') || nameUpper.includes('CAPELLA')) return 'commercial';
    return 'civilian';
}

function parseTleTextRecords(tleText: string): any[] {
    const lines = String(tleText || '')
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^0\s+/, ''))
        .filter(Boolean);
    const records: any[] = [];
    for (let index = 0; index < lines.length;) {
        let name = '';
        let tleLine1 = '';
        let tleLine2 = '';
        if (lines[index]?.startsWith('1 ') && lines[index + 1]?.startsWith('2 ')) {
            tleLine1 = lines[index];
            tleLine2 = lines[index + 1];
            const noradId = extractNoradIdFromTle(tleLine1);
            name = Number.isFinite(noradId) && noradId > 0 ? `NORAD ${noradId}` : `Satellite ${records.length + 1}`;
            index += 2;
        } else if (lines[index + 1]?.startsWith('1 ') && lines[index + 2]?.startsWith('2 ')) {
            name = lines[index];
            tleLine1 = lines[index + 1];
            tleLine2 = lines[index + 2];
            index += 3;
        } else {
            index += 1;
            continue;
        }
        const noradId = extractNoradIdFromTle(tleLine1);
        const nameUpper = name.toUpperCase();
        if (nameUpper.includes(' DEB') || nameUpper.includes(' R/B') || nameUpper.includes('COOLANT')) continue;
        records.push({
            name,
            tleLine1,
            tleLine2,
            tleEpochAt: parseTleEpochAtFromLine1(tleLine1),
            fetchedAt: new Date().toISOString(),
            provider: 'space-track',
            sourcePublicationAt: null,
            type: classifySatelliteTypeByName(name),
            classificationSource: 'derived_name_heuristic',
            noradId,
        });
    }
    return records;
}

async function getOpenSkySourceFetchAuthHeader(): Promise<Record<string, any>> {
    const clientId = process.env.OPENSKY_USERNAME;
    const clientSecret = process.env.OPENSKY_PASSWORD;
    if (!clientId || !clientSecret) {
        throw new Error('OpenSky credentials are not configured');
    }
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });
    const response = await axios.post(OPENSKY_TOKEN_URL, params.toString(), {
        timeout: 15_000,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const token = response.data?.access_token;
    if (!token) throw new Error('OpenSky OAuth response did not include an access token');
    return { headers: { Authorization: `Bearer ${token}` } };
}

async function getSpaceTrackCookie(): Promise<string> {
    const identity = process.env.SPACETRACK_EMAIL;
    const password = process.env.SPACETRACK_PASSWORD;
    if (!identity || !password) {
        throw new Error('Space-Track credentials are not configured');
    }
    const body = `identity=${encodeURIComponent(identity)}&password=${encodeURIComponent(password)}`;
    const login = await axios.post(SPACETRACK_LOGIN_URL, body, {
        timeout: 15_000,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookies = login.headers['set-cookie'];
    if (!cookies?.length) throw new Error('Space-Track login did not return a session cookie');
    return cookies.map((cookie: string) => cookie.split(';')[0]).join('; ');
}

function parseProviderImageContentType(value: unknown): { contentType: string; extension: string } {
    const contentType = String(value || 'image/png').split(';')[0].trim().toLowerCase();
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return { contentType: 'image/jpeg', extension: 'jpg' };
    if (contentType.includes('webp')) return { contentType: 'image/webp', extension: 'webp' };
    return { contentType: 'image/png', extension: 'png' };
}

async function saveImageryArtifact(buffer: Buffer, contentTypeRaw: unknown, metadata: Record<string, any>) {
    await fs.promises.mkdir(OPENSPY_LOCAL_ARTIFACT_DIR, { recursive: true });
    const { contentType, extension } = parseProviderImageContentType(contentTypeRaw);
    const artifactId = `img-${new Date().toISOString().replace(/[:.]/g, '-')}-${stableHash({ metadata, bytes: buffer.length })}`;
    const filename = `${artifactId}.${extension}`;
    const metadataFilename = `${artifactId}.json`;
    const imagePath = path.join(OPENSPY_LOCAL_ARTIFACT_DIR, filename);
    const metadataPath = path.join(OPENSPY_LOCAL_ARTIFACT_DIR, metadataFilename);
    await fs.promises.writeFile(imagePath, buffer);
    await fs.promises.writeFile(metadataPath, JSON.stringify({
        artifact_id: artifactId,
        filename,
        content_type: contentType,
        bytes: buffer.length,
        created_at: new Date().toISOString(),
        ...metadata,
    }, null, 2));
    return {
        artifact_id: artifactId,
        filename,
        content_type: contentType,
        bytes: buffer.length,
        artifact_url: `/api/imagery/artifacts/${encodeURIComponent(filename)}`,
        metadata_url: `/api/imagery/artifacts/${encodeURIComponent(metadataFilename)}`,
    };
}

function parseOpenSpyBbox(value: unknown): OpenSpyBbox | null {
    if (!value) return null;
    const parts = Array.isArray(value)
        ? value
        : String(value).split(',');
    if (parts.length !== 4) return null;
    const parsed = parts.map((part) => Number(part));
    if (parsed.some((part) => !Number.isFinite(part))) return null;
    const [west, south, east, north] = parsed;
    if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) {
        return null;
    }
    return [west, south, east, north];
}

function isoDateOnly(value: string | null | undefined): string | null {
    if (!value) return null;
    return value.slice(0, 10);
}

function dayRangeFromWindow(from: string, to: string | null, fallback = 1): number {
    if (!to) return fallback;
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return fallback;
    return Math.max(1, Math.ceil((toMs - fromMs) / 86_400_000) + 1);
}

function splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
            if (quoted && line[index + 1] === '"') {
                current += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
            continue;
        }
        if (char === ',' && !quoted) {
            out.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    out.push(current);
    return out;
}

function parseFirmsCsv(csv: string): FireRecord[] {
    const lines = csv.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return [];
    const header = splitCsvLine(lines[0]).map((name) => name.trim());
    const indexOf = (name: string) => header.indexOf(name);
    const latIdx = indexOf('latitude');
    const lngIdx = indexOf('longitude');
    const brightIdx = indexOf('bright_ti4');
    const confIdx = indexOf('confidence');
    const frpIdx = indexOf('frp');
    const dnIdx = indexOf('daynight');
    const dateIdx = indexOf('acq_date');
    const timeIdx = indexOf('acq_time');
    const typeIdx = indexOf('type');
    if (latIdx < 0 || lngIdx < 0) return [];

    const records: FireRecord[] = [];
    for (const line of lines.slice(1)) {
        const cols = splitCsvLine(line);
        const lat = Number(cols[latIdx]);
        const lng = Number(cols[lngIdx]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        records.push({
            id: `fire-${dateIdx >= 0 ? cols[dateIdx] : 'unknown'}-${timeIdx >= 0 ? cols[timeIdx] : '0000'}-${lat}-${lng}`,
            lat,
            lng,
            acqDate: dateIdx >= 0 ? cols[dateIdx] : '',
            brightness: brightIdx >= 0 ? Number(cols[brightIdx]) || 0 : 0,
            confidence: confIdx >= 0 ? cols[confIdx] : '',
            frp: frpIdx >= 0 ? Number(cols[frpIdx]) || 0 : 0,
            source: 'NASA FIRMS',
            daynight: dnIdx >= 0 ? cols[dnIdx] : '',
            acqTime: timeIdx >= 0 ? cols[timeIdx] : '',
            fireType: typeIdx >= 0 ? Number.parseInt(cols[typeIdx] || '0', 10) || 0 : 0,
        });
    }
    return records;
}

function extractPointLikeCoordinates(geometry: any): [number, number] | null {
    if (!geometry?.coordinates) return null;
    if (geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
        return [Number(geometry.coordinates[0]), Number(geometry.coordinates[1])];
    }
    const flat = (geometry.coordinates.flat(Infinity) as unknown[]).filter((item) => typeof item === 'number');
    if (flat.length < 2) return null;
    return [Number(flat[0]), Number(flat[1])];
}

function mapUsgsEarthquakeFeature(feature: any): DisasterEvent | null {
    const coords = extractPointLikeCoordinates(feature?.geometry);
    if (!coords) return null;
    const props = feature.properties || {};
    const mag = Number(props.mag || 0);
    const [lng, lat] = coords;
    const timeMs = Number(props.time || Date.now());
    return {
        id: `usgs-${feature.id || stableHash(feature)}`,
        type: 'strike',
        source: 'USGS',
        eventType: 'EQ',
        alertLevel: mag >= 6.5 ? 'Red' : mag >= 5.5 ? 'Orange' : 'Green',
        radiusKm: Math.round(10 * Math.pow(10, (mag - 2) / 3)),
        lat,
        lng,
        startTime: new Date(timeMs).toISOString(),
        endTime: new Date(timeMs + 7 * 86_400_000).toISOString(),
        description: `M${Number.isFinite(mag) ? mag.toFixed(1) : '?'} — ${props.place || 'unknown location'}`,
        geometry: feature.geometry || null,
    };
}

function mapEonetEvent(event: any): DisasterEvent | null {
    const catToCode: Record<string, string> = {
        wildfires: 'WF',
        volcanoes: 'VO',
        severeStorms: 'TC',
        floods: 'FL',
        drought: 'DR',
        earthquakes: 'EQ',
        seaLakeIce: 'XX',
        snow: 'XX',
        dustHaze: 'XX',
        manmade: 'XX',
        landslides: 'XX',
        waterColor: 'XX',
        tempExtremes: 'XX',
    };
    const geometry = Array.isArray(event.geometry) ? event.geometry.at(-1) : null;
    const coords = extractPointLikeCoordinates(geometry);
    if (!coords) return null;
    const [lng, lat] = coords;
    const category = event.categories?.[0]?.id || '';
    return {
        id: `eonet-${event.id || stableHash(event)}`,
        type: 'strike',
        source: 'NASA EONET',
        eventType: catToCode[category] || 'XX',
        alertLevel: 'Orange',
        lat,
        lng,
        startTime: geometry.date || event.closed || null,
        endTime: event.closed || new Date(Date.now() + 7 * 86_400_000).toISOString(),
        description: event.title || 'NASA EONET event',
        geometry: geometry || null,
    };
}

function mapGdacsFeature(feature: any): DisasterEvent | null {
    const coords = extractPointLikeCoordinates(feature?.geometry);
    if (!coords) return null;
    const props = feature.properties || {};
    const eventType = String(props.eventtype || 'XX').toUpperCase();
    const defaultRadii: Record<string, number> = {
        EQ: 100,
        TC: 300,
        FL: 150,
        VO: 50,
        WF: 80,
        DR: 200,
    };
    const [lng, lat] = coords;
    const fromDate = props.fromdate ? new Date(props.fromdate) : null;
    const toDate = props.todate ? new Date(props.todate) : null;
    const startTime = fromDate && Number.isFinite(fromDate.getTime()) ? fromDate.toISOString() : null;
    const endTime = toDate && Number.isFinite(toDate.getTime())
        ? toDate.toISOString()
        : new Date(Date.now() + 86_400_000).toISOString();
    return {
        id: `gdacs-${props.eventid || stableHash(feature)}`,
        type: 'strike',
        source: 'GDACS',
        eventType,
        alertLevel: props.alertlevel || 'Green',
        radiusKm: defaultRadii[eventType] || 100,
        lat,
        lng,
        startTime,
        endTime,
        description: props.name || props.description || `GDACS ${eventType} event`,
        geometry: feature.geometry || null,
    };
}

function gdacsFeatureKey(feature: any): string {
    const props = feature?.properties || {};
    return String(props.eventid || props.eventId || feature?.id || stableHash(feature));
}

function iodaSeverityRank(level: string): number {
    if (level === 'critical') return 2;
    if (level === 'warning') return 1;
    return 0;
}

function mapIodaAlerts(payload: any): OutageRecord[] {
    const alerts = Array.isArray(payload?.data) ? payload.data : [];
    const byCountry = new Map<string, OutageRecord>();
    for (const alert of alerts) {
        const code = String(alert?.entity?.code || '').toUpperCase();
        const centroid = COUNTRY_CENTROIDS[code];
        if (!code || !centroid) continue;
        const level = String(alert.level || 'normal').toLowerCase();
        if (level === 'normal') continue;
        const datasource = String(alert.datasource || 'unknown');
        const startTime = alert.time
            ? new Date(Number(alert.time) * 1000).toISOString()
            : new Date().toISOString();
        const record: OutageRecord = {
            id: `ioda-${code}-${datasource}-${alert.time || 0}`,
            country: alert.entity?.name || code,
            countryCode: code,
            lat: centroid[0],
            lng: centroid[1],
            level,
            datasource,
            startTime,
        };
        const existing = byCountry.get(code);
        if (!existing || iodaSeverityRank(record.level) > iodaSeverityRank(existing.level)) {
            byCountry.set(code, record);
        }
    }
    return [...byCountry.values()];
}

function resolveGibsLayerAlias(layer: unknown): string {
    const key = String(layer || 'viirs_true_color').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases: Record<string, string> = {
        modis_true_color: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        terra_true_color: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        aqua_true_color: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
        viirs_true_color: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
        viirs_noaa20_true_color: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
        viirs_noaa21_true_color: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
    };
    return aliases[key] || String(layer || aliases.viirs_true_color);
}

function resolveFirmsWmsLayerAlias(layer: unknown): string {
    const key = String(layer || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases: Record<string, string> = {
        viirs: 'fires_viirs_24',
        viirs_24: 'fires_viirs_24',
        fires_viirs_24: 'fires_viirs_24',
        fires_viirs_48: 'fires_viirs_48',
        fires_viirs_72: 'fires_viirs_72',
        fires_viirs_7: 'fires_viirs_7',
        modis: 'fires_modis_24',
        modis_24: 'fires_modis_24',
        fires_modis_24: 'fires_modis_24',
        fires_modis_48: 'fires_modis_48',
        fires_modis_72: 'fires_modis_72',
        fires_modis_7: 'fires_modis_7',
        landsat: 'fires_landsat_24',
        fires_landsat_24: 'fires_landsat_24',
        tsd_viirs: 'tsd_4_viirs_all',
        tsd_4_viirs_all: 'tsd_4_viirs_all',
        tsd_modis: 'tsd_4_modis_all',
        tsd_4_modis_all: 'tsd_4_modis_all',
    };
    if (aliases[key]) return aliases[key];
    if (/^(fires|tsd)_/.test(key)) return key;
    return 'fires_viirs_24';
}

function buildFirmsWmsOverlayDescriptor(input: {
    date?: string | null;
    from?: string | null;
    to?: string | null;
    bbox?: OpenSpyBbox | null;
    layer?: unknown;
    opacity?: unknown;
}) {
    const layer = resolveFirmsWmsLayerAlias(input.layer);
    const time = input.from && input.to
        ? `${input.from}/${input.to}`
        : input.from || input.to || input.date || null;
    const opacity = Number(input.opacity ?? 0.72);
    const payload = {
        source: 'firms',
        layer,
        wmsLayer: layer,
        time,
        opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 0.72,
        switchBase: false,
        ...(input.bbox ? { bbox: input.bbox, bbox_order: 'west,south,east,north' } : {}),
    };
    return {
        scene_id: `scene:firms:${layer}:${stableHash({ time, bbox: input.bbox || null })}`,
        source: 'firms',
        provider: 'NASA FIRMS WMS',
        imagery_kind: 'wms_time_active_fire_overlay',
        layer,
        time,
        coverage: input.bbox
            ? { scope: 'aoi_overlay', bbox: input.bbox, bbox_order: 'west,south,east,north' }
            : { scope: 'global_overlay' },
        visual_use: 'Thermal active-fire/hotspot WMS overlay for corroboration. This is not raw optical satellite imagery.',
        ui_actions: ['imagery.show_layer', 'imagery.show_scene', 'imagery.clear'],
        action_payloads: {
            show_layer: { type: 'imagery.show_layer', label: `Show FIRMS ${layer}`, payload },
            show_scene: { type: 'imagery.show_scene', label: `Show FIRMS ${layer}`, payload },
            clear: { type: 'imagery.clear', label: 'Clear FIRMS overlay', payload: {} },
        },
    };
}

function imageryRenderSizeForBbox([west, south, east, north]: OpenSpyBbox, maxPixels = 768): { width: number; height: number } {
    const latSpan = Math.max(0.0001, Math.abs(north - south));
    const lngSpan = Math.max(0.0001, Math.abs(east - west));
    const midLatRad = ((north + south) / 2) * Math.PI / 180;
    const widthAtLat = Math.max(0.0001, lngSpan * Math.max(0.2, Math.cos(midLatRad)));
    const aspect = Math.max(0.25, Math.min(4, widthAtLat / latSpan));
    const longSide = Math.max(128, Math.min(maxPixels, 1024));
    if (aspect >= 1) {
        return { width: longSide, height: Math.max(128, Math.round(longSide / aspect)) };
    }
    return { width: Math.max(128, Math.round(longSide * aspect)), height: longSide };
}

function buildGibsSceneDescriptor(input: {
    operation: string;
    date?: string | null;
    layer?: unknown;
    bbox?: [number, number, number, number] | null;
    opacity?: unknown;
}) {
    const requestedDate = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
        ? input.date
        : new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const layerAlias = String(input.layer || 'viirs_true_color').trim() || 'viirs_true_color';
    const layerId = resolveGibsLayerAlias(layerAlias);
    const opacity = Number(input.opacity ?? 0.72);
    const sceneId = `scene:nasa_gibs:${layerId}:${requestedDate}`;
    const showPayload = {
        source: 'nasa_gibs',
        scene_id: sceneId,
        layer: layerAlias,
        gibsLayer: layerId,
        date: requestedDate,
        opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 0.72,
        switchBase: true,
        ...(input.bbox ? { bbox: input.bbox } : {}),
    };
    return {
        scene_id: sceneId,
        source: 'nasa_gibs',
        provider: 'NASA GIBS / NASA Worldview',
        imagery_kind: 'date_addressable_wmts',
        coverage: input.bbox
            ? { scope: 'aoi_overlay', bbox: input.bbox, bbox_order: 'west,south,east,north' }
            : { scope: 'global_overlay' },
        requested_layer: layerAlias,
        layer_id: layerId,
        date: requestedDate,
        freshness: {
            selected_date: requestedDate,
            rule: 'Default latest date is yesterday UTC because same-day GIBS true-color tiles can be incomplete.',
        },
        visual_use: 'Context imagery overlay for corroboration, not canonical vector replay data.',
        resolution_notes: 'Public GIBS corrected-reflectance layers are global context imagery; use Sentinel/Landsat scene search for higher-resolution targeted evidence when connectors are configured.',
        supported_layer_aliases: {
            modis_true_color: 'MODIS_Terra_CorrectedReflectance_TrueColor',
            terra_true_color: 'MODIS_Terra_CorrectedReflectance_TrueColor',
            aqua_true_color: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
            viirs_true_color: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
            viirs_noaa20_true_color: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
            viirs_noaa21_true_color: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
        },
        wmts: {
            tile_matrix_set: 'GoogleMapsCompatible_Level9',
            format: 'image/jpeg',
            url_template: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layerId}/default/${requestedDate}/GoogleMapsCompatible_Level9/{TileMatrix}/{TileRow}/{TileCol}.jpg`,
        },
        ui_actions: ['imagery.show_layer', 'imagery.show_scene', 'imagery.compare', 'imagery.clear'],
        action_payloads: {
            show_layer: { type: 'imagery.show_layer', label: `Show NASA GIBS ${requestedDate}`, payload: showPayload },
            show_scene: { type: 'imagery.show_scene', label: `Show scene ${requestedDate}`, payload: showPayload },
            clear: { type: 'imagery.clear', label: 'Clear satellite imagery', payload: {} },
        },
    };
}

function mapLandsatStacFeature(feature: any, requestedLayer: string, opacity: number) {
    const bbox = Array.isArray(feature?.bbox) && feature.bbox.length === 4
        ? feature.bbox.map((value: unknown) => Number(value))
        : null;
    const assets = feature?.assets && typeof feature.assets === 'object' ? feature.assets : {};
    const thumbnailUrl = assets.reduced_resolution_browse?.href || assets.thumbnail?.href || null;
    const datetime = feature?.properties?.datetime || feature?.properties?.['start_datetime'] || null;
    const cloudCover = feature?.properties?.['eo:cloud_cover'] ?? feature?.properties?.cloud_cover ?? null;
    const sceneId = `scene:landsat:${feature?.id || stableHash(feature)}`;
    const renderSupported = Boolean(thumbnailUrl && bbox && bbox.every(Number.isFinite));
    const showPayload = renderSupported ? {
        source: 'landsat',
        scene_id: sceneId,
        scene: {
            scene_id: sceneId,
            source: 'landsat',
            provider: 'USGS Landsat STAC',
            id: feature.id || sceneId,
            collection: feature.collection || null,
            datetime,
            cloud_cover: cloudCover,
            bbox,
            bbox_order: 'west,south,east,north',
            thumbnail_url: thumbnailUrl,
        },
        bbox,
        bbox_order: 'west,south,east,north',
        thumbnail_url: thumbnailUrl,
        collection: feature.collection || null,
        layer: requestedLayer,
        opacity,
        switchBase: true,
    } : null;
    return {
        scene_id: sceneId,
        source: 'landsat',
        provider: 'USGS Landsat STAC',
        id: feature.id || sceneId,
        collection: feature.collection || null,
        datetime,
        cloud_cover: cloudCover,
        bbox,
        bbox_order: bbox ? 'west,south,east,north' : null,
        render_supported: renderSupported,
        visual_use: 'Historical browse imagery overlay for corroboration. Raw multiband COG rendering is not implemented.',
        assets: {
            thumbnail: assets.thumbnail?.href || null,
            reduced_resolution_browse: assets.reduced_resolution_browse?.href || null,
            red: assets.red?.href || null,
            green: assets.green?.href || null,
            blue: assets.blue?.href || null,
        },
        action_payloads: showPayload ? {
            show_scene: {
                type: 'imagery.show_scene',
                label: `Show Landsat ${datetime ? String(datetime).slice(0, 10) : 'scene'}`,
                payload: showPayload,
            },
        } : {},
    };
}

async function buildSourceCapabilityMatrix() {
    const currentCapabilities = currentSourceFetchCapabilities();
    const [sources, layers, ingestRows] = await Promise.all([
        catalogReadService.listSources(),
        catalogReadService.listLayers(),
        collectSourceIngestStatus(),
    ]);
    const layersById = new Map((layers || []).map((layer: any) => [layer.layer_id || layer.id || layer.slug, layer]));
    const ingestBySource = new Map<string, any[]>();
    for (const row of ingestRows) {
        if (!ingestBySource.has(row.sourceId)) ingestBySource.set(row.sourceId, []);
        ingestBySource.get(row.sourceId)!.push(row);
    }
    const bindingsBySource = new Map<string, any[]>();
    for (const binding of Object.values(SOURCE_BINDINGS)) {
        if (!bindingsBySource.has(binding.sourceId)) bindingsBySource.set(binding.sourceId, []);
        bindingsBySource.get(binding.sourceId)!.push(binding);
    }
    const operationsBySource = new Map<string, Array<any>>();
    for (const [operation, capability] of Object.entries(currentCapabilities)) {
        if (!operationsBySource.has(capability.source)) operationsBySource.set(capability.source, []);
        operationsBySource.get(capability.source)!.push({
            operation,
            ...capability,
            provider_policy: providerPolicyForSourceFetchOperation(operation, capability.source),
        });
    }

    const matrix = (sources || []).map((source: any) => {
        const sourceId = source.source_id || source.id;
        const manifest = source.manifest || source;
        const bindings = bindingsBySource.get(sourceId) || [];
        const boundLayers = bindings.map((binding) => {
            const layer = layersById.get(binding.layerId) as any;
            return {
                layer_id: binding.layerId,
                canonical_target: binding.canonicalTarget,
                coverage_scope: binding.coverageScope || layer?.coverage_scope || null,
                history_mode: layer?.history_mode || null,
                replay_scope: layer?.capabilities?.replayScope || layer?.metadata?.replayScope || null,
                replay: Boolean(layer?.capabilities?.replay),
                details_on_demand: Boolean(layer?.capabilities?.detailsOnDemand),
                live_only_context: layer?.capabilities?.replayScope === 'live_only_context'
                    || layer?.metadata?.replayScope === 'live_only_context'
                    || layer?.history_mode === 'none'
                    || binding.coverageScope === 'viewport',
                raw_capture_mode: binding.rawCaptureMode,
                storage_policy_id: binding.storagePolicyId,
            };
        });
        const ingest = ingestBySource.get(sourceId) || [];
        const sourceFetchOperations = operationsBySource.get(sourceId) || [];
        const liveContract = manifest.live_contract || source.live_contract || null;
        const sourceFetchAuth = sourceFetchAuthMetadata(manifest);
        return {
            source_id: sourceId,
            slug: source.slug || manifest.slug || sourceId,
            display_name: source.display_name || manifest.name || sourceId,
            provider: manifest.provider || null,
            provider_kind: source.provider_kind || manifest.provider_kind || manifest.type || null,
            catalog_status: source.status || manifest.status || null,
            category: manifest.category || null,
            layer: manifest.layer || null,
            refresh: manifest.refresh || null,
            auth: {
                required: Boolean(manifest.auth?.required),
                configured: authConfigured(manifest),
                method: manifest.auth?.method || null,
                env_keys: Array.isArray(manifest.auth?.env_keys) ? manifest.auth.env_keys : [],
                limits: manifest.auth?.limits || null,
            },
            source_fetch_auth: sourceFetchAuth,
            live_contract: liveContract,
            local_storage: {
                layers: boundLayers,
                has_local_history: boundLayers.some((layer) => ['local_history', 'event_log', 'snapshot'].includes(String(layer.history_mode || '')) || layer.replay),
                replay_supported: boundLayers.some((layer) => layer.replay),
                live_only: boundLayers.length > 0 && boundLayers.every((layer) => layer.live_only_context),
            },
            provider_policy: providerPolicyForSource(sourceId),
            source_fetch_operations: sourceFetchOperations.map((operation) => ({
                operation: operation.operation,
                status: operation.status,
                history: operation.history,
                notes: operation.notes,
                policy: operation.policy || null,
                provider_policy: operation.provider_policy || null,
            })),
            latest_ingest: ingest.map((row) => ({
                layer_id: row.layerId,
                status: row.status,
                completeness: row.completeness,
                latest_completed_at: row.latestIngest?.completedAt || null,
                upstream_bytes: row.latestIngest?.upstreamBytes ?? null,
                raw_count: row.latestIngest?.rawCount ?? null,
                normalized_count: row.latestIngest?.normalizedCount ?? null,
                changed_count: row.latestIngest?.changedCount ?? null,
                total_ms: row.latestIngest?.totalMs ?? null,
                error_message: row.latestIngest?.errorMessage || null,
            })),
            fields_available_not_loaded: manifest.fields_available_not_loaded || {},
            api_capabilities_not_used: manifest.api_capabilities_not_used || {},
            notes: {
                inactive_catalog_entry: boundLayers.length === 0,
                provider_history_actionable: sourceFetchOperations.some((operation) => operation.status === 'available' || operation.status === 'auth_required'),
            },
        };
    });

    return {
        sources: matrix.sort((a, b) => a.source_id.localeCompare(b.source_id)),
        operations: Object.entries(currentCapabilities)
            .map(([operationId, capability]) => ({
                operation: operationId,
                ...capability,
                provider_policy: providerPolicyForSourceFetchOperation(operationId, capability.source),
            }))
            .sort((a, b) => a.operation.localeCompare(b.operation)),
        summary: {
            sources: matrix.length,
            bound_sources: matrix.filter((source) => !source.notes.inactive_catalog_entry).length,
            inactive_catalog_entries: matrix.filter((source) => source.notes.inactive_catalog_entry).length,
            auth_required_sources: matrix.filter((source) => source.auth.required && source.auth.configured !== true).length,
            source_fetch_operations: Object.keys(currentCapabilities).length,
            actionable_source_fetch_operations: Object.values(currentCapabilities)
                .filter((operation) => operation.status === 'available' || operation.status === 'auth_required').length,
        },
    };
}

function compactProviderPolicyForCapabilityResponse(policy: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!policy) return null;
    return {
        account_tier: policy.account_tier || null,
        local_cadence: policy.local_cadence || null,
    };
}

function compactOperationPolicyForCapabilityResponse(policy: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!policy) return null;
    const compact: Record<string, unknown> = {};
    for (const key of [
        'max_window_hours',
        'max_search_window_days',
        'max_bbox_area_degrees2',
        'max_results',
        'max_day_range',
        'min_fetch_interval_ms',
        'min_provider_request_interval_ms',
        'live_poll_ms',
        'default_poll_minutes',
        'provider_fetch_status',
        'local_incremental_ingest_status',
        'product_status',
        'supported_sources',
        'tracks_endpoint',
        'provider_history_import',
        'current_tle_cache_hours',
        'search_page_size',
        'map_feed_mode',
        'visual_overlay',
        'selected_date_rule',
        'resolution',
        'upstream_granularity',
    ]) {
        if (policy[key] !== undefined && policy[key] !== null) compact[key] = policy[key];
    }
    return Object.keys(compact).length > 0 ? compact : null;
}

function sourceFetchStatusMeaning(status: string): string {
    if (status === 'available') return 'callable_now';
    if (status === 'auth_required') return 'needs_credentials_or_plan';
    if (status === 'planned') return 'not_executable_yet';
    if (status === 'unsupported') return 'not_supported';
    return status;
}

function compactSourceCapabilityMatrixForAgent(matrix: Awaited<ReturnType<typeof buildSourceCapabilityMatrix>>) {
    return {
        operations: matrix.operations.map((operation: any) => ({
            operation: operation.operation,
            source: operation.source,
            status: operation.status,
            meaning: sourceFetchStatusMeaning(operation.status),
            policy: compactOperationPolicyForCapabilityResponse(operation.policy),
        })),
        sources: matrix.sources
            .filter((source: any) => (
                !source.notes?.inactive_catalog_entry
                || (source.source_fetch_operations || []).length > 0
                || source.auth?.required
            ))
            .map((source: any) => ({
                source_id: source.source_id,
                display_name: source.display_name,
                provider: source.provider,
                category: source.category,
                auth: {
                    required: source.auth?.required,
                    configured: source.auth?.configured,
                    env_keys: source.auth?.env_keys || [],
                },
                source_fetch_auth: source.source_fetch_auth
                    ? {
                        required: source.source_fetch_auth.required,
                        configured: source.source_fetch_auth.configured,
                        method: source.source_fetch_auth.method || null,
                        env_keys: source.source_fetch_auth.env_keys || [],
                        limits: source.source_fetch_auth.limits || null,
                    }
                    : null,
                local_storage: {
                    has_local_history: source.local_storage?.has_local_history,
                    replay_supported: source.local_storage?.replay_supported,
                    live_only: source.local_storage?.live_only,
                    layers: (source.local_storage?.layers || []).map((layer: any) => layer.layer_id),
                },
                provider_policy: compactProviderPolicyForCapabilityResponse(source.provider_policy),
                source_fetch_operations: (source.source_fetch_operations || []).map((operation: any) => ({
                    operation: operation.operation,
                    status: operation.status,
                    meaning: sourceFetchStatusMeaning(operation.status),
                })),
                latest_ingest: (source.latest_ingest || []).map((ingest: any) => ({
                    layer_id: ingest.layer_id,
                    status: ingest.status,
                    completeness: ingest.completeness,
                    latest_completed_at: ingest.latest_completed_at,
                    normalized_count: ingest.normalized_count,
                    error_message: ingest.error_message,
                })),
            })),
        summary: matrix.summary,
    };
}

const agentRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const AGENT_RATE_LIMIT_WINDOW_MS = 60_000;
const AGENT_RATE_LIMIT_MAX = 240;

function agentRateLimiter(req: any, res: any, next: any) {
    const isRunEventStream = req.method === 'GET'
        && /^\/api\/agents\/runs\/[^/]+\/events(?:\?|$)/.test(req.originalUrl || req.url || '');
    if (isRunEventStream) {
        next();
        return;
    }

    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const bucketKey = `${ip}:agent:${req.baseUrl || ''}`;
    const now = Date.now();
    const bucket = agentRateLimitMap.get(bucketKey);
    if (!bucket || now >= bucket.resetAt) {
        agentRateLimitMap.set(bucketKey, { count: 1, resetAt: now + AGENT_RATE_LIMIT_WINDOW_MS });
    } else {
        bucket.count++;
        if (bucket.count > AGENT_RATE_LIMIT_MAX) {
            recordRateLimitReject('agent', req.originalUrl || req.path || 'unknown');
            res.status(429).json({ status: 'error', error: { code: 'RATE_LIMITED', message: 'Too many agent requests' } });
            return;
        }
    }
    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of agentRateLimitMap) {
        if (now >= bucket.resetAt) agentRateLimitMap.delete(key);
    }
}, 5 * 60_000);

app.use('/api/agents', agentRateLimiter, requireAgentAccess);
app.use('/api/agent-tools', agentRateLimiter, requireAgentAccess);

app.post('/api/agent-tools/sql-query', async (req, res) => {
    try {
        if (!databaseService.isReady()) {
            res.status(503).json({ status: 'error', error: { code: 'DATABASE_REQUIRED', message: 'Database is required for agent SQL' } });
            return;
        }
        if (!agentReadonlyRoleReady) {
            res.status(503).json({
                status: 'error',
                error: {
                    code: 'AGENT_READONLY_ROLE_NOT_READY',
                    message: agentReadonlyRoleError || 'app_agent_readonly is not granted to the backend database role',
                },
            });
            return;
        }
        const sql = validateReadOnlyAgentSql(String(req.body?.sql || ''));
        const reason = String(req.body?.reason || '').trim();
        if (!reason) {
            res.status(400).json({ status: 'error', error: { code: 'REASON_REQUIRED', message: 'Read-only SQL requires a reason' } });
            return;
        }
        const rawLimit = req.body?.limit;
        const limit = rawLimit === undefined || rawLimit === null || rawLimit === ''
            ? null
            : Number(rawLimit);
        if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
            res.status(400).json({ status: 'error', error: { code: 'BAD_LIMIT', message: 'limit must be a positive integer when provided' } });
            return;
        }
        const rawTimeoutMs = req.body?.timeout_ms ?? req.body?.timeoutMs;
        const timeoutMs = rawTimeoutMs === undefined || rawTimeoutMs === null || rawTimeoutMs === ''
            ? null
            : Number(rawTimeoutMs);
        if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
            res.status(400).json({ status: 'error', error: { code: 'BAD_TIMEOUT', message: 'timeout_ms must be a positive integer when provided' } });
            return;
        }
        const limitClause = limit === null ? '' : `LIMIT ${Math.trunc(limit)}`;

        // Always bound the statement: without a timeout a pathological read holds a
        // pool connection indefinitely and can stall the product. Callers may raise
        // it via timeout_ms; the default is a measured product ceiling, reported in
        // meta and overridable via AGENT_SQL_TIMEOUT_MS.
        const defaultTimeoutMs = Number(process.env.AGENT_SQL_TIMEOUT_MS) || 120_000;
        const effectiveTimeoutMs = timeoutMs !== null ? Math.trunc(timeoutMs) : defaultTimeoutMs;

        const rows = await databaseService.withTransaction(async () => {
            await databaseService.query('SET TRANSACTION READ ONLY');
            await databaseService.query('SET LOCAL ROLE app_agent_readonly');
            await databaseService.query(`SET LOCAL statement_timeout = '${effectiveTimeoutMs}ms'`);
            const result = await databaseService.query(
                `
                    SELECT *
                    FROM (${sql}) AS agent_q
                    ${limitClause}
                `,
            );
            return result?.rows || [];
        });

        res.json({
            status: 'ok',
            data: { rows },
            meta: {
                limit: limit === null ? null : Math.trunc(limit),
                timeout_ms: effectiveTimeoutMs,
                timeout_defaulted: timeoutMs === null,
                reason,
            },
            warnings: [],
        });
    } catch (err: any) {
        if (err.code === '57014' || /statement timeout/i.test(err.message || '')) {
            res.status(408).json({
                status: 'error',
                error: {
                    code: 'SQL_TIMEOUT',
                    message: err.message,
                },
            });
            return;
        }
        if (err.code === '25006' || /read-only transaction/i.test(err.message || '')) {
            res.status(403).json({
                status: 'error',
                error: {
                    code: 'SQL_WRITE_REJECTED',
                    message: err.message,
                },
            });
            return;
        }
        const sqlErrorCode = String(err.code || '');
        const sqlErrorMessage = String(err.message || '');
        const geometryAggregateHint = /function\s+(min|max)\(geometry\)|min\(geometry\)|max\(geometry\)/i.test(sqlErrorMessage)
            ? 'Geometry values cannot be aggregated with MIN/MAX. For a representative point, select a concrete geometry with array_agg(... ORDER BY observed_at)[1], or use semantic OpenSpy track/search tools.'
            : null;
        if (/SQL|SELECT|statement|allowed|required|operator|column|relation|syntax|function/i.test(sqlErrorMessage) || ['42601', '42703', '42725', '42804', '42883', '42P01'].includes(sqlErrorCode)) {
            res.status(400).json({
                status: 'error',
                error: {
                    code: 'SQL_REJECTED',
                    message: sqlErrorMessage,
                    hint: geometryAggregateHint || 'Fix the read-only SELECT or use a semantic OpenSpy query tool.',
                },
            });
            return;
        }
        if (err.code === '42501' && /role/i.test(err.message || '')) {
            res.status(503).json({
                status: 'error',
                error: {
                    code: 'AGENT_READONLY_ROLE_NOT_GRANTED',
                    message: err.message,
                },
            });
            return;
        }
        if (err.code === '42501' || /permission denied/i.test(err.message || '')) {
            res.status(403).json({
                status: 'error',
                error: {
                    code: 'SQL_PERMISSION_DENIED',
                    message: err.message,
                },
            });
            return;
        }
        sendError(res, err);
    }
});

app.post('/api/agent-tools/source-fetch', async (req, res) => {
    try {
        const operation = String(req.body?.operation || '').trim();
        const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
        if (!operation) {
            res.status(400).json({ status: 'error', error: { code: 'MISSING_OPERATION', message: 'Missing source fetch operation' } });
            return;
        }
        if (operation === 'capabilities') {
            const matrix = await buildSourceCapabilityMatrix();
            const detail = String(args.detail || args.view || args.mode || '').trim().toLowerCase();
            const full = detail === 'full' || args.full === true || args.compact === false;
            const data = full ? matrix : compactSourceCapabilityMatrixForAgent(matrix);
            res.json({
                status: 'ok',
                data: {
                    operation: 'capabilities',
                    ...data,
                },
                meta: {
                    executed: false,
                    operation_count: matrix.operations.length,
                    source_count: matrix.sources.length,
                    detail: full ? 'full' : 'compact',
                    full_detail_hint: full ? null : 'Use source-fetch.sh capabilities --detail full for the verbose operator matrix.',
                },
            });
            return;
        }
        const capability = currentSourceFetchCapability(operation);
        if (!capability) {
            res.status(400).json({
                status: 'error',
                error: {
                    code: 'UNKNOWN_SOURCE_FETCH_OPERATION',
                    message: `Unknown source fetch operation: ${operation}`,
                },
                data: {
                    available_operations: Object.keys(SOURCE_FETCH_CAPABILITIES).sort(),
                },
            });
            return;
        }
        const capabilityWithPolicy = {
            ...capability,
            provider_policy: providerPolicyForSourceFetchOperation(operation, capability.source),
        };
        if (capability.status === 'auth_required' || capability.status === 'unsupported' || capability.status === 'planned') {
            res.json({
                status: capability.status,
                data: {
                    operation,
                    args,
                    capability: capabilityWithPolicy,
                },
                meta: {
                    executed: false,
                },
                warnings: [
                    capability.status === 'auth_required'
                        ? `Missing credentials for ${capability.source}.`
                        : capability.status === 'planned'
                            ? capability.notes
                        : capability.notes,
                ],
            });
            return;
        }

        const persist = args.persist !== false && args.dry_run !== true && args.dryRun !== true;
        const dryRun = args.dry_run === true || args.dryRun === true;
        const from = parseIsoDateOrNull(args.from ? String(args.from) : undefined);
        const to = parseIsoDateOrNull(args.to ? String(args.to) : undefined);

        const requireMaxWindowHours = (operationId: string, start: string | null, end: string | null, maxHours: number): boolean => {
            if (!start || !end) return true;
            const hours = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000);
            if (hours <= maxHours) return true;
            res.status(400).json({
                status: 'error',
                error: {
                    code: 'WINDOW_TOO_LARGE',
                    message: `${operationId} window is capped at ${maxHours} hours to protect provider rate limits.`,
                },
                data: { operation: operationId, from: start, to: end, max_hours: maxHours },
            });
            return false;
        };

        if (operation === 'vessel-enrichment') {
            const imo = String(args.imo || '').trim();
            if (!vesselEnrichmentService.isValidImo(imo)) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_IMO', message: 'vessel-enrichment requires --imo with a 7-digit IMO number' } });
                return;
            }
            const mmsi = args.mmsi != null ? String(args.mmsi) : null;
            const refresh = args.refresh === true;
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: { operation, source: capability.source, imo, mmsi, capability: capabilityWithPolicy },
                    meta: { executed: false, persisted: false, dry_run: true },
                });
                return;
            }
            const enrichment = await vesselEnrichmentService.getEnrichment(imo, mmsi, refresh);
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    ...enrichment,
                    capability: capabilityWithPolicy,
                },
                meta: {
                    executed: true,
                    persisted: databaseService.isReady(),
                    cached: enrichment.cached,
                    photo_count: enrichment.photos.length,
                    photos_truncated: enrichment.photosTruncated,
                },
            });
            return;
        }

        if (operation === 'opensky-tracks') {
            const icao24 = String(args.icao24 || args.icao || args.entity || '').trim().toLowerCase().replace(/^aircraft:/, '');
            if (!/^[0-9a-f]{6}$/.test(icao24)) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_ICAO24', message: 'opensky-tracks requires --icao24 with a 6-character lowercase hex transponder address' } });
                return;
            }
            const explicitTime = args.time || args.at;
            const trackTimeSeconds = explicitTime
                ? Math.floor(new Date(String(explicitTime)).getTime() / 1000)
                : from && to
                    ? Math.floor((new Date(from).getTime() + new Date(to).getTime()) / 2000)
                    : from
                        ? Math.floor(new Date(from).getTime() / 1000)
                        : 0;
            if (!Number.isFinite(trackTimeSeconds) || trackTimeSeconds < 0) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_TIME', message: 'opensky-tracks requires a valid --time/--at ISO timestamp, or a valid --from/--to window' } });
                return;
            }
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: {
                        operation,
                        source: capability.source,
                        icao24,
                        time: trackTimeSeconds,
                        requested_window: { from: from || null, to: to || null },
                        capability: capabilityWithPolicy,
                    },
                    meta: { executed: false, persisted: false, dry_run: true },
                    warnings: ['Dry run only. No OpenSky provider request was sent and no local data was written.'],
                });
                return;
            }
            const authConfig = await getOpenSkySourceFetchAuthHeader();
            const params = new URLSearchParams({ icao24, time: String(trackTimeSeconds) });
            const response = await axios.get(`https://opensky-network.org/api/tracks/all?${params.toString()}`, {
                ...authConfig,
                timeout: 30_000,
            });
            const pathRows = Array.isArray(response.data?.path) ? response.data.path : [];
            const callsign = String(response.data?.callsign || icao24).trim() || icao24;
            const records = pathRows
                .map((point: any[]) => {
                    const pointTime = Number(point?.[0]);
                    const lat = Number(point?.[1]);
                    const lng = Number(point?.[2]);
                    const altMeters = point?.[3] == null ? null : Number(point[3]);
                    const heading = point?.[4] == null ? null : Number(point[4]);
                    if (!Number.isFinite(pointTime) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                    return {
                        id: icao24,
                        icao24,
                        callsign,
                        origin: null,
                        lat,
                        lng,
                        altMeters: Number.isFinite(altMeters) ? altMeters : null,
                        heading: Number.isFinite(heading) ? heading : null,
                        type: classifyAircraftForSourceFetch(callsign, Number.isFinite(altMeters) ? altMeters : null, null),
                        speedMps: null,
                        onGround: Boolean(point?.[5]),
                        verticalRate: null,
                        squawk: null,
                        lastContact: pointTime,
                    };
                })
                .filter(Boolean);
            if (persist) await sourcePersistenceService.persistAircraftPositions(records as any[]);
            const fromMs = from ? new Date(from).getTime() : Number.NEGATIVE_INFINITY;
            const toMs = to ? new Date(to).getTime() : Number.POSITIVE_INFINITY;
            const requestedWindowCount = records.filter((record: any) => {
                const observedMs = Number(record.lastContact || 0) * 1000;
                return observedMs >= fromMs && observedMs <= toMs;
            }).length;
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    icao24,
                    callsign,
                    count: records.length,
                    rawCount: pathRows.length,
                    requestedWindowCount,
                    track: {
                        startTime: response.data?.startTime || null,
                        endTime: response.data?.endTime || null,
                        time: trackTimeSeconds,
                    },
                },
                meta: { executed: true, persisted: persist, provider_checked: true },
                warnings: [
                    'OpenSky /tracks/all is experimental and returns a generalized flight trajectory for one aircraft around the requested time, not a bulk AOI history export.',
                    ...(from || to ? ['requestedWindowCount is reported separately; returned track points can cover the wider flight containing the requested time.'] : []),
                ],
            });
            return;
        }

        if (operation === 'spacetrack-gp-history') {
            const noradRaw = String(args.norad || args.norad_id || args.noradId || '').trim();
            const noradIds = noradRaw
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
            if (noradIds.length === 0 || noradIds.some((item) => !/^\d+$/.test(item))) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_NORAD', message: 'spacetrack-gp-history requires --norad with one or more comma-separated numeric NORAD IDs' } });
                return;
            }
            if (!from || !to) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_WINDOW', message: 'spacetrack-gp-history requires --from and --to ISO timestamps' } });
                return;
            }
            const epochRange = `${from.replace(/\.\d{3}Z$/, 'Z').replace('T', ' ').replace(/Z$/, '')}--${to.replace(/\.\d{3}Z$/, 'Z').replace('T', ' ').replace(/Z$/, '')}`;
            const limitRaw = args.limit == null ? null : Number(args.limit);
            const limitValue = Number.isFinite(limitRaw) && Number(limitRaw) > 0 ? Math.floor(Number(limitRaw)) : null;
            const queryUrl = [
                SPACETRACK_GP_HISTORY_BASE_URL,
                'NORAD_CAT_ID',
                encodeURIComponent(noradIds.join(',')),
                'EPOCH',
                encodeURIComponent(epochRange),
                'orderby',
                encodeURIComponent('NORAD_CAT_ID,EPOCH asc'),
                ...(limitValue != null ? ['limit', String(limitValue)] : []),
                'format',
                '3le',
            ].join('/');
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: {
                        operation,
                        source: capability.source,
                        upstream_provider: 'space-track',
                        noradIds,
                        epochRange,
                        limit: limitValue,
                        capability: capabilityWithPolicy,
                    },
                    meta: { executed: false, persisted: false, dry_run: true },
                    warnings: ['Dry run only. No Space-Track provider request was sent and no local data was written.'],
                });
                return;
            }
            const cookie = await getSpaceTrackCookie();
            const response = await axios.get<string>(queryUrl, {
                timeout: 60_000,
                responseType: 'text',
                headers: { Cookie: cookie },
            });
            const records = parseTleTextRecords(response.data);
            if (persist) {
                await sourcePersistenceService.persistSatelliteOrbitalHistory(records as any[], {
                    sourceId: capability.source,
                    provider: 'space-track',
                    fetchedAt: new Date().toISOString(),
                    query: {
                        operation,
                        noradIds,
                        epochRange,
                        limit: limitValue,
                    },
                });
            }
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    upstream_provider: 'space-track',
                    count: records.length,
                    rawBytes: Buffer.byteLength(response.data || '', 'utf8'),
                    noradIds,
                    epochRange,
                    epochs: records.map((record: any) => ({
                        norad_id: record.noradId,
                        name: record.name,
                        tle_epoch_at: record.tleEpochAt,
                    })),
                },
                meta: { executed: true, persisted: persist, provider_checked: true },
                warnings: [
                    'Space-Track GP_HISTORY import stores historical orbital elements. Replay still computes positions locally from stored TLE epochs.',
                    'The current importer uses TLE/3LE records; objects requiring OMM-only Alpha-5 handling need a separate OMM parser.',
                ],
            });
            return;
        }

        if (operation === 'firms-fires') {
            if (!from && !args.date) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_WINDOW', message: 'firms-fires requires --from ISO timestamp or --date YYYY-MM-DD' } });
                return;
            }
            const date = String(args.date || isoDateOnly(from) || '').slice(0, 10);
            const bbox = parseOpenSpyBbox(args.bbox);
            const requestedDayRange = Number.parseInt(String(args.day_range || args.dayRange || dayRangeFromWindow(from || `${date}T00:00:00.000Z`, to)), 10) || 1;
            if (!Number.isFinite(requestedDayRange) || requestedDayRange < 1) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_DAY_RANGE', message: 'firms-fires day_range must be a positive integer' } });
                return;
            }
            if (requestedDayRange > 10) {
                res.status(400).json({
                    status: 'error',
                    error: {
                        code: 'DAY_RANGE_TOO_LARGE',
                        message: 'firms-fires day_range is limited by NASA FIRMS provider policy to 10 days.',
                    },
                    data: {
                        operation,
                        requested_day_range: requestedDayRange,
                        max_day_range: 10,
                    },
                });
                return;
            }
            const dayRange = Math.trunc(requestedDayRange);
            const source = String(args.source || 'VIIRS_SNPP_NRT').trim();
            const area = String(args.area || (bbox ? bbox.join(',') : 'world')).trim();
            const wmsOverlay = buildFirmsWmsOverlayDescriptor({
                date,
                from,
                to,
                bbox,
                layer: args.wms_layer || args.wmsLayer || args.layer || 'fires_viirs_24',
                opacity: args.opacity,
            });
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: {
                        operation,
                        source: capability.source,
                        date,
                        dayRange,
                        firmsSource: source,
                        area,
                        wms_overlay: wmsOverlay,
                        ui_actions: wmsOverlay.ui_actions,
                        action_payload_example: wmsOverlay.action_payloads.show_layer,
                        capability: capabilityWithPolicy,
                    },
                    meta: { executed: false, persisted: false, dry_run: true },
                    warnings: ['Dry run only. No provider request was sent and no local data was written.'],
                });
                return;
            }
            const mapKey = process.env.FIRMS_MAP_KEY || process.env.NASA_FIRMS_MAP_KEY;
            const areaPath = area === 'world'
                ? 'world'
                : bbox
                    ? bbox.join(',')
                    : area;
            const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey || '')}/${encodeURIComponent(source)}/${areaPath}/${dayRange}/${encodeURIComponent(date)}`;
            const response = await axios.get<string>(url, { timeout: 60_000, responseType: 'text' });
            const records = parseFirmsCsv(response.data);
            if (persist) await sourcePersistenceService.persistFires(records, { rawCsv: response.data });
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    date,
                    dayRange,
                    firmsSource: source,
                    area,
                    count: records.length,
                    rawBytes: Buffer.byteLength(response.data, 'utf8'),
                    wms_overlay: wmsOverlay,
                    ui_actions: wmsOverlay.ui_actions,
                    action_payload_example: wmsOverlay.action_payloads.show_layer,
                },
                meta: { executed: true, persisted: persist },
                warnings: [
                    ...(dayRange > 1 ? ['FIRMS date window is inclusive from date through date + dayRange - 1.'] : []),
                    'FIRMS WMS overlay is proxied through OpenSpy so the MAP_KEY is not exposed to browser or agent.',
                ],
            });
            return;
        }

        if (operation === 'usgs-earthquakes') {
            if (!from || !to) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_WINDOW', message: 'usgs-earthquakes requires --from and --to ISO timestamps' } });
                return;
            }
            const bbox = parseOpenSpyBbox(args.bbox);
            const params = new URLSearchParams({
                format: 'geojson',
                starttime: from,
                endtime: to,
                minmagnitude: String(args.min_magnitude || args.minMagnitude || '2.5'),
                limit: String(args.limit || '2000'),
                orderby: 'time',
            });
            if (bbox) {
                params.set('minlatitude', String(bbox[1]));
                params.set('minlongitude', String(bbox[0]));
                params.set('maxlatitude', String(bbox[3]));
                params.set('maxlongitude', String(bbox[2]));
            }
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: { operation, source: capability.source, query: Object.fromEntries(params.entries()), capability: capabilityWithPolicy },
                    meta: { executed: false, persisted: false, dry_run: true },
                    warnings: ['Dry run only. No provider request was sent and no local data was written.'],
                });
                return;
            }
            const response = await axios.get(`https://earthquake.usgs.gov/fdsnws/event/1/query?${params.toString()}`, { timeout: 30_000 });
            const features = Array.isArray(response.data?.features) ? response.data.features : [];
            const events = features.map(mapUsgsEarthquakeFeature).filter((event: DisasterEvent | null): event is DisasterEvent => Boolean(event));
            if (persist) {
                await sourcePersistenceService.persistDisasterEvents(events, {
                    rawPayloads: [{
                        source_id: 'usgs',
                        payload: response.data,
                        observed_at: from,
                        upstream_id: `${from}:${to}`,
                        metadata: { format: 'geojson', payloadKind: 'historical_query', query: Object.fromEntries(params.entries()) },
                    }],
                });
            }
            res.json({
                status: 'ok',
                data: { operation, source: capability.source, count: events.length, rawCount: features.length, metadata: response.data?.metadata || null },
                meta: { executed: true, persisted: persist },
                warnings: [],
            });
            return;
        }

        if (operation === 'eonet-events') {
            if (!from || !to) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_WINDOW', message: 'eonet-events requires --from and --to ISO timestamps' } });
                return;
            }
            const bbox = parseOpenSpyBbox(args.bbox);
            const params = new URLSearchParams({
                status: String(args.status || 'all'),
                start: from.slice(0, 10),
                end: to.slice(0, 10),
                limit: String(args.limit || '500'),
            });
            if (bbox) params.set('bbox', `${bbox[0]},${bbox[3]},${bbox[2]},${bbox[1]}`);
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: { operation, source: capability.source, query: Object.fromEntries(params.entries()), capability: capabilityWithPolicy },
                    meta: { executed: false, persisted: false, dry_run: true },
                    warnings: ['Dry run only. No provider request was sent and no local data was written.'],
                });
                return;
            }
            const response = await axios.get(`https://eonet.gsfc.nasa.gov/api/v3/events?${params.toString()}`, { timeout: 30_000 });
            const rawEvents = Array.isArray(response.data?.events) ? response.data.events : [];
            const events = rawEvents.map(mapEonetEvent).filter((event: DisasterEvent | null): event is DisasterEvent => Boolean(event));
            if (persist) {
                await sourcePersistenceService.persistDisasterEvents(events, {
                    rawPayloads: [{
                        source_id: 'eonet',
                        payload: response.data,
                        observed_at: from,
                        upstream_id: `${from}:${to}`,
                        metadata: { format: 'json', payloadKind: 'historical_query', query: Object.fromEntries(params.entries()) },
                    }],
                });
            }
            res.json({
                status: 'ok',
                data: { operation, source: capability.source, count: events.length, rawCount: rawEvents.length },
                meta: { executed: true, persisted: persist },
                warnings: [],
            });
            return;
        }

        if (operation === 'gdacs-disasters') {
            const bbox = parseOpenSpyBbox(args.bbox);
            const useHistoricalSearch = Boolean(from && to);
            const fromMs = from ? new Date(from).getTime() : Number.NEGATIVE_INFINITY;
            const toMs = to ? new Date(to).getTime() : Number.POSITIVE_INFINITY;
            if ((from || to) && !useHistoricalSearch) {
                res.status(400).json({
                    status: 'error',
                    error: {
                        code: 'BAD_WINDOW',
                        message: 'gdacs-disasters historical SEARCH requires both --from and --to ISO timestamps. Omit both for the current/recent MAP feed.',
                    },
                });
                return;
            }
            if (useHistoricalSearch && (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs)) {
                res.status(400).json({
                    status: 'error',
                    error: { code: 'BAD_WINDOW', message: 'gdacs-disasters received an invalid historical SEARCH window' },
                });
                return;
            }
            const maxPagesArg = args.max_pages ?? args.maxPages;
            const maxPages = maxPagesArg === undefined || maxPagesArg === null || maxPagesArg === ''
                ? null
                : Number(maxPagesArg);
            if (maxPages !== null && (!Number.isFinite(maxPages) || maxPages < 1)) {
                res.status(400).json({
                    status: 'error',
                    error: { code: 'BAD_MAX_PAGES', message: 'gdacs-disasters --max-pages must be a positive integer when provided' },
                });
                return;
            }
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: {
                        operation,
                        source: capability.source,
                        bbox: bbox || null,
                        from: from || null,
                        to: to || null,
                        query: useHistoricalSearch
                            ? {
                                endpoint: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH',
                                fromdate: isoDateOnly(from),
                                todate: isoDateOnly(to),
                                max_pages: maxPages,
                            }
                            : {
                                endpoint: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP',
                            },
                        capability: capabilityWithPolicy,
                    },
                    meta: {
                        executed: false,
                        persisted: false,
                        dry_run: true,
                        provider_feed: useHistoricalSearch ? 'historical_search' : 'current_recent_map',
                    },
                    warnings: ['Dry run only. No GDACS provider request was sent and no local data was written.'],
                });
                return;
            }
            const providerFeed = useHistoricalSearch ? 'historical_search' : 'current_recent_map';
            let features: any[] = [];
            let providerPayload: any = null;
            let pageCount = 0;
            let pageLimited = false;
            let repeatedPage = false;
            let query: Record<string, any> = {};

            if (useHistoricalSearch) {
                const baseQuery: Record<string, any> = {
                    fromdate: isoDateOnly(from),
                    todate: isoDateOnly(to),
                };
                const eventList = args.eventlist ?? args.event_list ?? args.event_types ?? args.eventType;
                const alertLevel = args.alertlevel ?? args.alert_level;
                const pageSize = args.pagesize ?? args.page_size;
                if (eventList) baseQuery.eventlist = String(eventList);
                if (alertLevel) baseQuery.alertlevel = String(alertLevel);
                if (pageSize) baseQuery.pagesize = String(pageSize);

                const pages: Array<{ pagenumber: number; rawCount: number; acceptedCount: number }> = [];
                const seenPageFingerprints = new Set<string>();
                const seenFeatureKeys = new Set<string>();
                for (let page = 1; ; page += 1) {
                    const params = new URLSearchParams(
                        Object.entries({ ...baseQuery, pagenumber: String(page) })
                            .filter(([, value]) => value !== null && value !== undefined)
                            .map(([key, value]) => [key, String(value)]),
                    );
                    const response = await axios.get(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?${params.toString()}`, {
                        timeout: 30_000,
                        validateStatus: (status) => (status >= 200 && status < 300) || status === 204,
                    });
                    if (response.status === 204 || !response.data) break;
                    const pageFeatures = Array.isArray(response.data?.features) ? response.data.features : [];
                    if (pageFeatures.length === 0) break;
                    const pageKeys = pageFeatures.map(gdacsFeatureKey);
                    const pageFingerprint = pageKeys.join('|');
                    if (seenPageFingerprints.has(pageFingerprint)) {
                        repeatedPage = true;
                        break;
                    }
                    seenPageFingerprints.add(pageFingerprint);
                    const acceptedFeatures = pageFeatures.filter((feature: any, index: number) => {
                        const key = pageKeys[index];
                        if (seenFeatureKeys.has(key)) return false;
                        seenFeatureKeys.add(key);
                        return true;
                    });
                    if (acceptedFeatures.length === 0) {
                        repeatedPage = true;
                        break;
                    }
                    features.push(...acceptedFeatures);
                    pages.push({ pagenumber: page, rawCount: pageFeatures.length, acceptedCount: acceptedFeatures.length });
                    if (maxPages !== null && page >= Math.trunc(maxPages)) {
                        pageLimited = true;
                        break;
                    }
                }
                pageCount = pages.length;
                query = { ...baseQuery, max_pages: maxPages, pages };
                providerPayload = { type: 'FeatureCollection', features };
            } else {
                const response = await axios.get('https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP', { timeout: 30_000 });
                features = Array.isArray(response.data?.features) ? response.data.features : [];
                providerPayload = response.data;
                query = { endpoint: 'MAP' };
            }

            const allEvents = features.map(mapGdacsFeature).filter((event: DisasterEvent | null): event is DisasterEvent => Boolean(event));
            const events = allEvents.filter((event: DisasterEvent) => {
                if (bbox && (event.lng < bbox[0] || event.lng > bbox[2] || event.lat < bbox[1] || event.lat > bbox[3])) {
                    return false;
                }
                const startMs = event.startTime ? new Date(event.startTime).getTime() : Number.NEGATIVE_INFINITY;
                const endMs = event.endTime ? new Date(event.endTime).getTime() : startMs;
                return endMs >= fromMs && startMs <= toMs;
            });
            if (persist) {
                await sourcePersistenceService.persistDisasterEvents(events, {
                    rawPayloads: [{
                        source_id: 'gdacs',
                        payload: providerPayload,
                        observed_at: from || new Date().toISOString(),
                        upstream_id: useHistoricalSearch
                            ? `gdacs-search:${isoDateOnly(from)}:${isoDateOnly(to)}:${bbox ? bbox.join(',') : 'world'}`
                            : `gdacs-map:${from || 'open'}:${to || 'open'}:${bbox ? bbox.join(',') : 'world'}`,
                        metadata: {
                            format: 'geojson',
                            payloadKind: useHistoricalSearch ? 'historical_search' : 'current_recent_map_feed',
                            filters: { from, to, bbox },
                            query,
                            pageCount,
                            complete: !pageLimited && !repeatedPage,
                        },
                    }],
                });
            }
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    count: events.length,
                    rawCount: features.length,
                    provider_feed: providerFeed,
                    bbox: bbox || null,
                    from: from || null,
                    to: to || null,
                    query,
                    page_count: pageCount,
                    complete: !pageLimited && !repeatedPage,
                },
                meta: {
                    executed: true,
                    persisted: persist,
                    provider_checked: true,
                },
                warnings: [
                    ...(useHistoricalSearch
                        ? ['GDACS SEARCH returns historical event collections. OpenSpy followed provider pagination until no more rows were returned unless --max-pages was explicitly supplied.']
                        : ['GDACS MAP feed is current/recent event context. Pass both --from and --to to use the historical SEARCH API.']),
                    ...(pageLimited ? ['GDACS SEARCH stopped at the explicit --max-pages limit supplied by the caller; result is not complete.'] : []),
                    ...(repeatedPage ? ['GDACS SEARCH stopped because the provider returned a repeated page fingerprint; result is marked incomplete to avoid duplicating rows.'] : []),
                ],
            });
            return;
        }

        if (operation === 'ioda-outages') {
            if (!from || !to) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_WINDOW', message: 'ioda-outages requires --from and --to ISO timestamps' } });
                return;
            }
            const query = {
                from: Math.floor(new Date(from).getTime() / 1000),
                until: Math.floor(new Date(to).getTime() / 1000),
                entityType: String(args.entity_type || args.entityType || 'country'),
            };
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: { operation, source: capability.source, query, capability: capabilityWithPolicy },
                    meta: { executed: false, persisted: false, dry_run: true },
                    warnings: ['Dry run only. No provider request was sent and no local data was written.'],
                });
                return;
            }
            const params = new URLSearchParams({
                from: String(query.from),
                until: String(query.until),
                entityType: query.entityType,
            });
            const response = await axios.get(`https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?${params.toString()}`, { timeout: 30_000 });
            const records = mapIodaAlerts(response.data);
            if (persist) await sourcePersistenceService.persistOutages(records, { sourceId: 'ioda', rawPayload: response.data });
            res.json({
                status: 'ok',
                data: { operation, source: capability.source, count: records.length, rawCount: Array.isArray(response.data?.data) ? response.data.data.length : null, query },
                meta: { executed: true, persisted: persist },
                warnings: ['IODA import stores country-level alerts, not raw BGP/probing/darknet signal time series.'],
            });
            return;
        }

        if (operation === 'gpsjam-history') {
            const date = String(args.date || (from ? from.slice(0, 10) : '')).trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_DATE', message: 'gpsjam-history requires --date YYYY-MM-DD or --from ISO timestamp' } });
                return;
            }
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: { operation, source: capability.source, date, capability: capabilityWithPolicy },
                    meta: { executed: false, persisted: false, dry_run: true, granularity: 'daily' },
                    warnings: ['Dry run only. No GPSJam provider request was sent and no local data was written.'],
                });
                return;
            }
            let fetched;
            try {
                fetched = await gpsJamService.fetchDate(date, { persist });
            } catch (err: any) {
                if (axios.isAxiosError(err) && err.response?.status === 404) {
                    res.json({
                        status: 'unsupported',
                        error: {
                            code: 'DATE_NOT_AVAILABLE',
                            message: `GPSJam has no published daily CSV for ${date}.`,
                        },
                        data: { operation, source: capability.source, date },
                        meta: {
                            executed: true,
                            provider_checked: true,
                            persisted: false,
                            granularity: 'daily',
                        },
                        warnings: ['GPSJam provider request was sent, but the daily CSV is not published for this date.'],
                    });
                    return;
                }
                throw err;
            }
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    date: fetched.date,
                    count: fetched.zones.length,
                    rawBytes: fetched.rawBytes,
                },
                meta: { executed: true, persisted: persist, granularity: 'daily' },
                warnings: ['GPSJam source granularity is daily, not sub-day.'],
            });
            return;
        }

        if (operation === 'cloudflare-outages') {
            if (!from) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_WINDOW', message: 'cloudflare-outages requires --from ISO timestamp' } });
                return;
            }
            if (!requireMaxWindowHours(operation, from, to || new Date().toISOString(), Number(capability.policy?.max_window_hours || 24))) return;
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: {
                        operation,
                        source: capability.source,
                        from,
                        to: to || null,
                        capability: capabilityWithPolicy,
                    },
                    meta: { executed: false, persisted: false, dry_run: true },
                    warnings: ['Dry run only. No Cloudflare provider request was sent and no local data was written.'],
                });
                return;
            }
            const fetched = await cloudflareService.fetchOutagesWindow({ dateStart: from, dateEnd: to || undefined, persist });
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    count: fetched.records.length,
                    rawCount: fetched.rawCount,
                    rawPages: fetched.rawPages,
                    metadata: fetched.metadata,
                },
                meta: { executed: true, persisted: persist },
                warnings: fetched.metadata?.pagination?.truncated ? ['Cloudflare fetch hit pagination or malformed-page limit; result may be incomplete.'] : [],
            });
            return;
        }

        if (operation === 'gfw-events') {
            if (!from || !to) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_WINDOW', message: 'gfw-events requires --from and --to ISO timestamps' } });
                return;
            }
            const gfwWarnings = args.bbox
                ? ['GFW gap-event source-fetch currently applies the date window only; bbox is accepted by the CLI envelope but not forwarded to the GFW provider. Use local query/layer filters after import for AOI narrowing.']
                : [];
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: {
                        operation,
                        source: capability.source,
                        startDate: from.slice(0, 10),
                        endDate: to.slice(0, 10),
                        bbox: args.bbox || null,
                        bbox_supported: false,
                        capability: capabilityWithPolicy,
                    },
                    meta: { executed: false, persisted: false, dry_run: true, granularity: 'daily-window' },
                    warnings: [
                        'Dry run only. No GFW provider request was sent and no local data was written.',
                        ...gfwWarnings,
                    ],
                });
                return;
            }
            const fetched = await gfwService.fetchEventsWindow({ startDate: from.slice(0, 10), endDate: to.slice(0, 10), persist });
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    count: fetched.records.length,
                    rawCount: fetched.rawCount,
                    rawPages: fetched.rawPages,
                    metadata: fetched.metadata,
                },
                meta: { executed: true, persisted: persist, granularity: 'daily-window' },
                warnings: [
                    ...(fetched.metadata?.pagination?.truncated ? ['GFW fetch hit pagination or malformed-page limit; result may be incomplete.'] : []),
                    ...gfwWarnings,
                ],
            });
            return;
        }

        if (operation === 'nasa-gibs-imagery' || operation === 'imagery-search-latest') {
            const date = String(args.date || args.time || (from ? from.slice(0, 10) : new Date().toISOString().slice(0, 10))).slice(0, 10);
            const layer = String(args.layer || 'viirs_true_color').trim();
            const bbox = parseOpenSpyBbox(args.bbox);
            const scene = buildGibsSceneDescriptor({
                operation,
                date: operation === 'imagery-search-latest' && !args.date && !args.time && !from
                    ? null
                    : date,
                layer,
                bbox,
                opacity: args.opacity,
            });
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    scene,
                    scenes: [scene],
                    imagery_kind: scene.imagery_kind,
                    date: scene.date,
                    requested_layer: scene.requested_layer,
                    supported_layer_aliases: scene.supported_layer_aliases,
                    ui_actions: scene.ui_actions,
                    action_payload_example: scene.action_payloads.show_layer,
                },
                meta: {
                    executed: false,
                    persisted: false,
                    raw_pixels_downloaded: false,
                },
                warnings: [
                    'NASA GIBS is a context imagery overlay. It does not import raw pixels into canonical replay storage.',
                ],
            });
            return;
        }

        if (operation === 'copernicus-sentinel-imagery') {
            const bbox = parseOpenSpyBbox(args.bbox);
            if (!bbox) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_BBOX', message: 'copernicus-sentinel-imagery requires --bbox west,south,east,north' } });
                return;
            }
            const defaultTo = to || new Date().toISOString();
            const defaultFrom = from || new Date(new Date(defaultTo).getTime() - 7 * 86_400_000).toISOString();
            const collection = String(args.collection || args.dataset || 'sentinel-2-l2a');
            const layer = String(args.layer || 'true_color');
            const maxCloudCover = Number(args.max_cloud_cover ?? args.maxCloudCover ?? 40);
            const limit = Number(args.limit || 5);
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: {
                        operation,
                        source: capability.source,
                        bbox,
                        from: defaultFrom,
                        to: defaultTo,
                        collection,
                        layer,
                        maxCloudCover,
                        limit,
                        capability: capabilityWithPolicy,
                        policy: copernicusService.getPolicy(),
                    },
                    meta: { executed: false, persisted: false, dry_run: true },
                    warnings: ['Dry run only. No Copernicus provider request was sent and no local data was written.'],
                });
                return;
            }
            const result = await copernicusService.searchScenes({
                bbox,
                from: defaultFrom,
                to: defaultTo,
                collection,
                layer,
                maxCloudCover,
                limit,
            });
            const scenes = result.scenes.map((scene) => ({
                ...scene,
                action_payloads: scene.render ? {
                    show_scene: {
                        type: 'imagery.show_scene',
                        label: `Show ${scene.collection} ${scene.datetime ? scene.datetime.slice(0, 10) : 'scene'}`,
                        payload: {
                            source: 'copernicus',
                            scene_id: scene.scene_id,
                            scene,
                            bbox: scene.render.bbox,
                            bbox_order: scene.render.bbox_order,
                            collection: scene.render.collection,
                            layer: scene.render.layer,
                            from: scene.render.from,
                            to: scene.render.to,
                            maxCloudCover: scene.render.maxCloudCover,
                            opacity: Number(args.opacity ?? 0.72),
                            switchBase: true,
                        },
                    },
                } : {},
            }));
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    scenes,
                    scene: scenes[0] || null,
                    rawCount: result.rawCount,
                    query: result.query,
                    policy: copernicusService.getPolicy(),
                    ui_actions: ['imagery.show_scene', 'imagery.compare', 'imagery.clear'],
                    action_payload_example: scenes[0]?.action_payloads?.show_scene || null,
                },
                meta: {
                    executed: true,
                    persisted: false,
                    cached: result.cached,
                    raw_pixels_downloaded: false,
                },
                warnings: [
                    'Copernicus search returns scene metadata. Browser show-scene renders a bounded preview through the backend; raw Sentinel products are not stored locally by default.',
                    ...(scenes.some((scene) => !scene.render_supported)
                        ? ['Some returned Sentinel scenes are metadata-only because the current preview renderer supports Sentinel-2 L2A optical scenes only.']
                        : []),
                ],
            });
            return;
        }

        if (operation === 'landsat-stac-imagery') {
            const bbox = parseOpenSpyBbox(args.bbox);
            if (!bbox) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_BBOX', message: 'landsat-stac-imagery requires --bbox west,south,east,north' } });
                return;
            }
            const defaultTo = to || new Date().toISOString();
            const defaultFrom = from || new Date(new Date(defaultTo).getTime() - 90 * 86_400_000).toISOString();
            const collection = String(args.collection || args.dataset || 'landsat-c2l2-sr');
            const layer = String(args.layer || 'browse');
            const limit = Number(args.limit || 5);
            const maxCloudCover = args.max_cloud_cover ?? args.maxCloudCover;
            const query: Record<string, any> = {
                bbox,
                datetime: `${defaultFrom}/${defaultTo}`,
                collections: [collection],
                limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5,
            };
            if (maxCloudCover !== undefined && maxCloudCover !== null && String(maxCloudCover).trim() !== '') {
                query.query = {
                    'eo:cloud_cover': {
                        lte: Number(maxCloudCover),
                    },
                };
            }
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: {
                        operation,
                        source: capability.source,
                        query,
                        capability: capabilityWithPolicy,
                    },
                    meta: { executed: false, persisted: false, dry_run: true },
                    warnings: ['Dry run only. No Landsat STAC provider request was sent.'],
                });
                return;
            }
            const response = await axios.post('https://landsatlook.usgs.gov/stac-server/search', query, {
                timeout: 30_000,
                headers: { 'content-type': 'application/json' },
            });
            const features = Array.isArray(response.data?.features) ? response.data.features : [];
            const opacity = Number(args.opacity ?? 0.72);
            const scenes = features.map((feature: any) => mapLandsatStacFeature(
                feature,
                layer,
                Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 0.72,
            ));
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    scenes,
                    scene: scenes[0] || null,
                    rawCount: features.length,
                    numberMatched: response.data?.numberMatched ?? null,
                    query,
                    ui_actions: ['imagery.show_scene', 'imagery.compare', 'imagery.clear'],
                    action_payload_example: scenes[0]?.action_payloads?.show_scene || null,
                },
                meta: {
                    executed: true,
                    persisted: false,
                    raw_pixels_downloaded: false,
                },
                warnings: [
                    'Landsat STAC search returns scene metadata and browse/thumbnail overlay actions. OpenSpy does not render raw multiband Landsat COG products yet.',
                    ...(scenes.some((scene: any) => !scene.render_supported)
                        ? ['Some returned Landsat scenes are metadata-only because no browse/thumbnail asset was present.']
                        : []),
                ],
            });
            return;
        }

        if (operation === 'imagery-evidence-artifact') {
            const payload = (() => {
                if (args.payload_json) {
                    try {
                        return JSON.parse(String(args.payload_json));
                    } catch {
                        return null;
                    }
                }
                if (args.payload && typeof args.payload === 'object') return args.payload;
                return null;
            })();
            if (args.payload_json && !payload) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_PAYLOAD_JSON', message: 'imagery-evidence-artifact received invalid --payload-json' } });
                return;
            }
            const source = String(args.source || payload?.source || payload?.provider || payload?.scene?.source || '').trim().toLowerCase();
            if (!source) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_SOURCE', message: 'imagery-evidence-artifact requires --source or payload_json.source' } });
                return;
            }
            if (dryRun) {
                res.json({
                    status: 'ok',
                    data: {
                        operation,
                        source: capability.source,
                        requested_source: source,
                        capability: capabilityWithPolicy,
                    },
                    meta: { executed: false, persisted: false, dry_run: true, raw_pixels_downloaded: false },
                    warnings: ['Dry run only. No imagery artifact was rendered or downloaded.'],
                });
                return;
            }

            let artifactBuffer: Buffer | null = null;
            let artifactContentType = 'image/png';
            let artifactMetadata: Record<string, any> = {
                operation,
                requested_source: source,
                pixel_analysis_executed: false,
            };

            if (/copernicus|sentinel/.test(source)) {
                const bbox = parseOpenSpyBbox(args.bbox || payload?.bbox || payload?.scene?.bbox || payload?.scene?.render?.bbox);
                if (!bbox) {
                    res.status(400).json({ status: 'error', error: { code: 'BAD_BBOX', message: 'Copernicus imagery artifact requires bbox=west,south,east,north' } });
                    return;
                }
                const renderSize = imageryRenderSizeForBbox(bbox, Number(args.max_pixels || args.maxPixels || payload?.maxPixels || payload?.max_pixels || 768));
                const rendered = await copernicusService.renderScene({
                    bbox,
                    from: parseIsoDateOrNull(args.from ? String(args.from) : undefined)
                        || parseIsoDateOrNull(payload?.from ? String(payload.from) : undefined)
                        || parseIsoDateOrNull(payload?.scene?.render?.from ? String(payload.scene.render.from) : undefined)
                        || new Date(Date.now() - 86_400_000).toISOString(),
                    to: parseIsoDateOrNull(args.to ? String(args.to) : undefined)
                        || parseIsoDateOrNull(payload?.to ? String(payload.to) : undefined)
                        || parseIsoDateOrNull(payload?.scene?.render?.to ? String(payload.scene.render.to) : undefined)
                        || new Date().toISOString(),
                    collection: String(args.collection || payload?.collection || payload?.scene?.render?.collection || payload?.scene?.collection || 'sentinel-2-l2a'),
                    layer: String(args.layer || payload?.layer || payload?.scene?.render?.layer || 'true_color'),
                    maxCloudCover: Number(args.maxCloudCover || args.max_cloud_cover || payload?.maxCloudCover || payload?.scene?.render?.maxCloudCover || 40),
                    width: Number(args.width || payload?.width || renderSize.width),
                    height: Number(args.height || payload?.height || renderSize.height),
                });
                artifactBuffer = rendered.buffer;
                artifactContentType = rendered.contentType;
                artifactMetadata = {
                    ...artifactMetadata,
                    provider: 'Copernicus Sentinel',
                    bbox,
                    bbox_order: 'west,south,east,north',
                    collection: String(args.collection || payload?.collection || payload?.scene?.render?.collection || payload?.scene?.collection || 'sentinel-2-l2a'),
                    layer: String(args.layer || payload?.layer || payload?.scene?.render?.layer || 'true_color'),
                };
            } else if (/landsat|usgs/.test(source)) {
                const scene = payload?.scene && typeof payload.scene === 'object' ? payload.scene : null;
                const imageUrl = args.thumbnail_url
                    || args.thumbnailUrl
                    || payload?.thumbnail_url
                    || payload?.thumbnailUrl
                    || scene?.thumbnail_url
                    || scene?.assets?.reduced_resolution_browse
                    || scene?.assets?.thumbnail;
                if (!imageUrl) {
                    res.status(400).json({ status: 'error', error: { code: 'BAD_IMAGE_URL', message: 'Landsat imagery artifact requires a thumbnail_url or a Landsat show_scene payload with a browse asset' } });
                    return;
                }
                const response = await axios.get<ArrayBuffer>(String(imageUrl), { timeout: 30_000, responseType: 'arraybuffer' });
                artifactBuffer = Buffer.from(response.data);
                artifactContentType = String(response.headers['content-type'] || 'image/jpeg');
                artifactMetadata = {
                    ...artifactMetadata,
                    provider: 'USGS Landsat STAC',
                    scene_id: payload?.scene_id || scene?.scene_id || null,
                    bbox: payload?.bbox || scene?.bbox || null,
                    bbox_order: payload?.bbox_order || scene?.bbox_order || null,
                    source_url_host: (() => {
                        try { return new URL(String(imageUrl)).host; } catch { return null; }
                    })(),
                };
            } else if (/firms/.test(source)) {
                const mapKey = process.env.FIRMS_MAP_KEY || process.env.NASA_FIRMS_MAP_KEY;
                if (!mapKey) {
                    res.status(401).json({ status: 'auth_required', error: { code: 'AUTH_REQUIRED', message: 'FIRMS MAP_KEY is required to render a FIRMS WMS artifact' } });
                    return;
                }
                const bbox = parseOpenSpyBbox(args.bbox || payload?.bbox);
                if (!bbox) {
                    res.status(400).json({ status: 'error', error: { code: 'BAD_BBOX', message: 'FIRMS imagery artifact requires bbox=west,south,east,north' } });
                    return;
                }
                const width = Number(args.width || payload?.width || 1024);
                const height = Number(args.height || payload?.height || 1024);
                const layer = resolveFirmsWmsLayerAlias(args.layer || payload?.layer || payload?.wmsLayer);
                const params = new URLSearchParams({
                    SERVICE: 'WMS',
                    REQUEST: 'GetMap',
                    VERSION: '1.1.1',
                    FORMAT: 'image/png',
                    TRANSPARENT: 'true',
                    SRS: 'EPSG:4326',
                    BBOX: bbox.join(','),
                    WIDTH: String(Number.isFinite(width) && width > 0 ? Math.floor(width) : 1024),
                    HEIGHT: String(Number.isFinite(height) && height > 0 ? Math.floor(height) : 1024),
                    LAYERS: layer,
                    STYLES: '',
                });
                const time = args.time || payload?.time;
                if (time) params.set('TIME', String(time));
                const response = await axios.get<ArrayBuffer>(`https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/${encodeURIComponent(mapKey)}/?${params.toString()}`, {
                    timeout: 30_000,
                    responseType: 'arraybuffer',
                });
                artifactBuffer = Buffer.from(response.data);
                artifactContentType = String(response.headers['content-type'] || 'image/png');
                artifactMetadata = {
                    ...artifactMetadata,
                    provider: 'NASA FIRMS WMS',
                    layer,
                    time: time || null,
                    bbox,
                    bbox_order: 'west,south,east,north',
                };
            } else {
                res.status(400).json({
                    status: 'error',
                    error: { code: 'UNSUPPORTED_IMAGERY_ARTIFACT_SOURCE', message: `imagery-evidence-artifact does not support source: ${source}` },
                    data: { supported_sources: ['copernicus', 'landsat', 'firms'] },
                });
                return;
            }

            const artifact = await saveImageryArtifact(artifactBuffer, artifactContentType, artifactMetadata);
            res.json({
                status: 'ok',
                data: {
                    operation,
                    source: capability.source,
                    artifact,
                    vision_path: {
                        status: 'artifact_ready',
                        pixel_analysis_executed: false,
                        note: 'OpenSpy created an evidence image artifact. A vision-capable agent/model can inspect artifact_url; this backend operation does not claim visual findings.',
                    },
                },
                meta: {
                    executed: true,
                    persisted: false,
                    artifact_persisted: true,
                    raw_pixels_downloaded: true,
                    artifact_store: '.local/imagery-artifacts',
                },
                warnings: ['Imagery artifact creation is evidence capture only; no backend pixel-level visual inference was executed.'],
            });
            return;
        }

        res.json({
            status: 'unsupported',
            data: {
                operation,
                args,
                capability: capabilityWithPolicy,
            },
            meta: {
                executed: false,
                reason: 'No executable backend source-fetch adapter is implemented for this operation yet.',
            },
            warnings: [
                'This endpoint does not fabricate missing historical data.',
            ],
        });
    } catch (err: any) {
        const failedOperation = String(req.body?.operation || 'source-fetch').trim() || 'source-fetch';
        sendSourceFetchProviderError(res, failedOperation, err);
    }
});

app.get('/api/imagery/copernicus/render', async (req, res) => {
    try {
        const bbox = parseOpenSpyBbox(req.query.bbox);
        if (!bbox) {
            res.status(400).json({ error: 'copernicus render requires bbox=west,south,east,north' });
            return;
        }
        const to = parseIsoDateOrNull(req.query.to ? String(req.query.to) : undefined)
            || parseIsoDateOrNull(req.query.time ? String(req.query.time) : undefined)
            || new Date().toISOString();
        const from = parseIsoDateOrNull(req.query.from ? String(req.query.from) : undefined)
            || new Date(new Date(to).getTime() - 24 * 60 * 60 * 1000).toISOString();
        const rendered = await copernicusService.renderScene({
            bbox,
            from,
            to,
            collection: String(req.query.collection || req.query.dataset || 'sentinel-2-l2a'),
            layer: String(req.query.layer || 'true_color'),
            maxCloudCover: Number(req.query.maxCloudCover || req.query.max_cloud_cover || 40),
            width: req.query.width == null ? undefined : Number(req.query.width),
            height: req.query.height == null ? undefined : Number(req.query.height),
        });
        res.setHeader('Content-Type', rendered.contentType);
        res.setHeader('Cache-Control', `public, max-age=${rendered.cached ? 3600 : 900}`);
        res.setHeader('X-OpenSpy-Imagery-Provider', 'copernicus');
        res.setHeader('X-OpenSpy-Imagery-Cached', rendered.cached ? 'true' : 'false');
        res.send(rendered.buffer);
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/imagery/firms/wms', async (req, res) => {
    try {
        const mapKey = process.env.FIRMS_MAP_KEY || process.env.NASA_FIRMS_MAP_KEY;
        if (!mapKey) {
            res.status(401).json({ error: 'FIRMS MAP_KEY is required for FIRMS WMS imagery' });
            return;
        }
        const params = new URLSearchParams();
        const setParam = (target: string, sourceNames: string[], fallback?: string) => {
            for (const name of sourceNames) {
                const value = req.query[name] ?? req.query[name.toLowerCase()] ?? req.query[name.toUpperCase()];
                if (value != null) {
                    params.set(target, String(Array.isArray(value) ? value[0] : value));
                    return;
                }
            }
            if (fallback != null) params.set(target, fallback);
        };
        setParam('SERVICE', ['SERVICE', 'service'], 'WMS');
        setParam('REQUEST', ['REQUEST', 'request'], 'GetMap');
        setParam('VERSION', ['VERSION', 'version'], '1.1.1');
        setParam('FORMAT', ['FORMAT', 'format'], 'image/png');
        setParam('TRANSPARENT', ['TRANSPARENT', 'transparent'], 'true');
        setParam('SRS', ['SRS', 'srs', 'CRS', 'crs'], 'EPSG:4326');
        setParam('BBOX', ['BBOX', 'bbox']);
        setParam('WIDTH', ['WIDTH', 'width']);
        setParam('HEIGHT', ['HEIGHT', 'height']);
        setParam('STYLES', ['STYLES', 'styles'], '');
        const layer = resolveFirmsWmsLayerAlias(req.query.layers || req.query.LAYERS || req.query.layer || req.query.wmsLayer);
        params.set('LAYERS', layer);
        const time = req.query.TIME || req.query.time;
        if (time) params.set('TIME', String(Array.isArray(time) ? time[0] : time));
        const upstream = `https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/${encodeURIComponent(mapKey)}/?${params.toString()}`;
        const response = await axios.get<ArrayBuffer>(upstream, {
            timeout: 30_000,
            responseType: 'arraybuffer',
        });
        res.setHeader('Content-Type', String(response.headers['content-type'] || 'image/png'));
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-OpenSpy-Imagery-Provider', 'firms');
        res.setHeader('X-OpenSpy-Firms-Layer', layer);
        res.send(Buffer.from(response.data));
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/imagery/artifacts/:filename', async (req, res) => {
    try {
        const filename = String(req.params.filename || '');
        if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) {
            res.status(400).json({ error: 'Invalid imagery artifact filename' });
            return;
        }
        const filePath = path.join(OPENSPY_LOCAL_ARTIFACT_DIR, filename);
        if (!filePath.startsWith(OPENSPY_LOCAL_ARTIFACT_DIR)) {
            res.status(400).json({ error: 'Invalid imagery artifact path' });
            return;
        }
        if (!fs.existsSync(filePath)) {
            res.status(404).json({ error: 'Imagery artifact not found' });
            return;
        }
        const extension = path.extname(filename).toLowerCase();
        const contentType = extension === '.json' ? 'application/json'
            : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
                : extension === '.webp' ? 'image/webp'
                    : 'image/png';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(await fs.promises.readFile(filePath));
    } catch (err: any) {
        sendError(res, err);
    }
});

function sendAgentToolError(res: express.Response, err: any): void {
    const message = err?.message || 'Agent tool failed';
    const explicitStatus = Number(err?.status || err?.statusCode);
    const status = Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus < 600 ? explicitStatus
        : /not found/i.test(message) ? 404
        : /requires|must be|invalid|missing|bad/i.test(message) ? 400
            : /not ready|required/i.test(message) ? 503
                : 500;
    res.status(status).json({
        status: 'error',
        error: {
            code: err?.code || (status === 404 ? 'NOT_FOUND'
                : status === 400 ? 'BAD_REQUEST'
                    : status === 503 ? 'UNAVAILABLE'
                        : 'AGENT_TOOL_FAILED'),
            message,
        },
    });
}

app.get('/api/agent-tools/catalog/describe', async (req, res) => {
    try {
        const data = await agentToolService.describeCatalog({
            layer: req.query.layer,
            source: req.query.source,
        });
        res.json({ status: 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/resolve/region', async (req, res) => {
    try {
        const data = await agentToolService.resolveRegion(req.body || {});
        res.json({ status: 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/resolve/entity', async (req, res) => {
    try {
        const data = await agentToolService.resolveEntity(req.body || {});
        res.json({ status: 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/geometry/aoi', async (req, res) => {
    try {
        const data = await agentToolService.createAoi(req.body || {});
        res.json({ status: 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/query/aggregate', async (req, res) => {
    try {
        const data = await agentToolService.aggregate(req.body || {});
        res.json({ status: data.query_status?.status || 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/query/timeline', async (req, res) => {
    try {
        const data = await agentToolService.timeline(req.body || {});
        res.json({ status: data.query_status?.status || 'ok', data, warnings: data.warnings || [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/query/related', async (req, res) => {
    try {
        const data = await agentToolService.related(req.body || {});
        res.json({ status: data.query_status?.status || 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/query/satellite-overpasses', async (req, res) => {
    try {
        const data = await agentToolService.satelliteOverpasses(req.body || {});
        res.json({ status: data.status || 'ok', data, warnings: data.warnings || [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/geo/corridor', async (req, res) => {
    try {
        const data = await agentToolService.corridorSearch(req.body || {});
        res.json({ status: data.query_status?.status || 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/geo/spatial-join', async (req, res) => {
    try {
        const data = await agentToolService.spatialJoin(req.body || {});
        res.json({ status: data.query_status?.status || 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/geo/simplify', async (req, res) => {
    try {
        const data = await agentToolService.simplifiedGeometry(req.body || {});
        res.json({
            status: data.query_status?.status || (data.count > 0 ? 'ok' : 'empty'),
            data,
            warnings: data.count > 0 ? [] : ['No geometry matched these filters.'],
        });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.get('/api/agent-tools/selections/:selectionId/preview', async (req, res) => {
    try {
        const data = await agentToolService.previewSelection(req.params.selectionId);
        res.json({ status: 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.post('/api/agent-tools/selections/:selectionId/materialize', async (req, res) => {
    try {
        const data = await agentToolService.materializeSelection(req.params.selectionId, req.body || {});
        res.json({ status: data.materialization_status === 'empty' ? 'empty' : 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.get('/api/agent-tools/selections/:selectionId/items', async (req, res) => {
    try {
        const data = await agentToolService.listSelectionItems(req.params.selectionId, {
            limit: req.query.limit,
            offset: req.query.offset,
        });
        res.json({ status: 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.get('/api/agent-tools/view/summary', async (_req, res) => {
    try {
        const data = await agentToolService.getViewSummary();
        res.json({ status: 'ok', data, warnings: [] });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

app.get('/api/agent-tools/view/request-context', async (req, res) => {
    try {
        const runId = String(req.query.run_id || '').trim();
        if (!runId) {
            res.json({
                status: 'ok',
                data: {
                    available: false,
                    run_id: null,
                    session_id: null,
                    context: null,
                    reason: 'AGENT_RUN_ID is not set. This command is meant for an active product agent run.',
                },
                warnings: [],
            });
            return;
        }
        const run = await agentRuntimeService.getRun(runId);
        if (!run) {
            res.json({
                status: 'ok',
                data: {
                    available: false,
                    run_id: runId,
                    session_id: null,
                    context: null,
                    reason: 'No agent run found for this run_id.',
                },
                warnings: [],
            });
            return;
        }
        const context = run.metadata?.requestContext && typeof run.metadata.requestContext === 'object'
            ? run.metadata.requestContext
            : null;
        res.json({
            status: 'ok',
            data: {
                available: Boolean(context),
                run_id: run.agent_run_id,
                session_id: run.agent_session_id,
                context,
                captured_at: context?.view?.capturedAt || null,
            },
            warnings: [],
        });
    } catch (err: any) {
        sendAgentToolError(res, err);
    }
});

const UI_BROWSER_ACTION_COMMANDS = new Set([
    'map.fly_to',
    'map.annotate',
    'map.highlight',
    'map.add_aoi',
    'map.draw_aoi',
    'map.add_corridor',
    'map.draw_corridor',
    'map.clear_agent_overlays',
    'overlay.draw_geometry',
    'object.open',
    'object.focus',
    'entity.open',
    'entity.place',
    'entity.show_marker',
    'entity.highlight',
    'entity.track',
    'entity.draw_track',
    'entity.animate_track',
    'entity.show_marker',
    'track.draw',
    'track.animate',
    'imagery.show_layer',
    'imagery.show_scene',
    'imagery.compare',
    'imagery.clear',
    'replay.seek',
    'replay.play_window',
    'replay.set_speed',
    'replay.follow_entity',
    'replay.pause',
    'replay.stop',
]);

const BACKEND_MAP_COMMANDS = new Set([
    'selection.apply',
    'selection.clear',
    'layer.filter',
    'legend.set_node_state',
    'view.patch',
    'map.set_layers',
    'source.set_enabled',
    'layer.set_visibility',
]);

const SUPPORTED_MAP_COMMANDS = [
    ...Array.from(BACKEND_MAP_COMMANDS),
    ...Array.from(UI_BROWSER_ACTION_COMMANDS),
].sort();

function mapCommandBoolean(value: any, fallback = true): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    }
    return fallback;
}

function buildLayerViewPatch(payload: Record<string, any>, defaultTarget: 'sources' | 'visibility' = 'visibility'): Record<string, any> {
    const patch: Record<string, any> = {};
    const addFlags = (target: 'sources' | 'visibility', value: any) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        patch[target] = {
            ...(patch[target] || {}),
            ...value,
        };
    };
    addFlags('sources', payload.sources);
    addFlags('visibility', payload.visibility);

    const items = Array.isArray(payload.layers) ? payload.layers : [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const layer = String(item.layer || item.layer_id || item.id || '').trim();
        if (!layer) continue;
        const target = item.target === 'sources' || item.source === true ? 'sources' : defaultTarget;
        patch[target] = {
            ...(patch[target] || {}),
            [layer]: mapCommandBoolean(item.enabled),
        };
    }

    const singleLayer = String(payload.layer || payload.layer_id || '').trim();
    if (singleLayer) {
        const target = payload.target === 'sources' || payload.source === true ? 'sources' : defaultTarget;
        patch[target] = {
            ...(patch[target] || {}),
            [singleLayer]: mapCommandBoolean(payload.enabled),
        };
    }

    if (payload.subtypeVisibility && typeof payload.subtypeVisibility === 'object' && !Array.isArray(payload.subtypeVisibility)) {
        patch.subtypeVisibility = payload.subtypeVisibility;
    }
    if (payload.sourceVisibility && typeof payload.sourceVisibility === 'object' && !Array.isArray(payload.sourceVisibility)) {
        patch.sourceVisibility = payload.sourceVisibility;
    }
    return patch;
}

app.post('/api/agent-tools/map-command', async (req, res) => {
    try {
        const command = String(req.body?.command || '').trim();
        const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
        if (!command) {
            res.status(400).json({ status: 'error', error: { code: 'MISSING_COMMAND', message: 'Missing map command' } });
            return;
        }

        if (command === 'selection.apply') {
            const layer = String(payload.layer || '').trim();
            const selectionId = String(payload.selection_id || payload.selectionId || '').trim();
            const mode = ['replace', 'append', 'exclude', 'only'].includes(payload.mode) ? payload.mode : 'only';
            if (!layer || !selectionId) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_SELECTION_ACTION', message: 'selection.apply requires layer and selection_id' } });
                return;
            }
            const selection = await selectionRepository.getSelection(selectionId);
            if (!selection) {
                res.status(404).json({ status: 'error', error: { code: 'SELECTION_NOT_FOUND', message: 'Selection not found or expired' } });
                return;
            }
            const status = String(selection.materialization_status || 'none');
            const materializedMs = Date.parse(String(selection.materialized_at || ''));
            const updatedMs = Date.parse(String(selection.updated_at || ''));
            const reusableStatuses = ['materialized', 'partial', 'empty'];
            const hasReusableMaterialization = reusableStatuses.includes(status)
                && Number.isFinite(materializedMs)
                && (!Number.isFinite(updatedMs) || materializedMs + 1000 >= updatedMs)
                && payload.force_materialize !== true
                && payload.rematerialize !== true;
            const materialization = hasReusableMaterialization
                ? {
                    selection_id: selection.selection_id,
                    layer: selection.layer_id,
                    materialized_count: selection.materialized_count || 0,
                    materialization_status: status,
                    materialized_at: selection.materialized_at || null,
                    reused: true,
                }
                : await agentToolService.materializeSelection(selectionId, {
                    limit: payload.materialize_limit || payload.max_items || payload.limit,
                    timeout_ms: payload.materialize_timeout_ms || payload.materialization_timeout_ms || payload.timeout_ms || payload.timeoutMs,
                });
            const result = await viewControlService.applySelectionWithExplanation(layer, selectionId, mode);
            res.json({
                status: 'ok',
                data: {
                    command,
                    layer,
                    selection_id: selectionId,
                    mode,
                    materialization,
                    warnings: materialization.materialization_status === 'partial'
                        ? ['Selection materialization is partial; materialization metadata describes the applied subset.']
                        : [],
                    ...result,
                },
            });
            return;
        }

        if (command === 'selection.clear') {
            const layer = String(payload.layer || '').trim();
            if (!layer) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_SELECTION_CLEAR', message: 'selection.clear requires layer' } });
                return;
            }
            const result = await viewControlService.clearSelectionWithExplanation(layer);
            res.json({ status: 'ok', data: { command, layer, ...result } });
            return;
        }

        if (command === 'legend.set_node_state') {
            const nodeId = String(payload.node || payload.nodeId || payload.node_id || payload.id || '').trim();
            const enabled = payload.enabled !== false;
            const target = payload.target === 'sources' ? 'sources' : 'visibility';
            if (!nodeId) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_LEGEND_ACTION', message: 'legend.set_node_state requires node' } });
                return;
            }
            const result = await viewControlService.setLegendNodeStateWithExplanation(nodeId, enabled, target);
            res.json({ status: 'ok', data: { command, node_id: nodeId, enabled, target, ...result } });
            return;
        }

        if (command === 'view.patch') {
            const patch = payload.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch) ? payload.patch : payload;
            if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_VIEW_PATCH', message: 'view.patch requires a patch object' } });
                return;
            }
            const result = await viewControlService.patchStateWithExplanation(patch);
            res.json({ status: 'ok', data: { command, patch, ...result } });
            return;
        }

        if (command === 'map.set_layers' || command === 'source.set_enabled' || command === 'layer.set_visibility') {
            const patch = buildLayerViewPatch(payload, command === 'source.set_enabled' ? 'sources' : 'visibility');
            if (Object.keys(patch).length === 0) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_LAYER_STATE_ACTION', message: `${command} requires layer/source/visibility payload` } });
                return;
            }
            const result = await viewControlService.patchStateWithExplanation(patch, payload);
            res.json({ status: 'ok', data: { command, patch, ...result } });
            return;
        }

        if (command === 'layer.filter') {
            const layer = String(payload.layer || payload.layer_id || '').trim();
            const mode = ['replace', 'append', 'exclude', 'only'].includes(payload.mode) ? payload.mode : 'only';
            const predicate = payload.predicate && typeof payload.predicate === 'object'
                ? payload.predicate
                : payload.filter && typeof payload.filter === 'object'
                    ? payload.filter
                    : {
                        ...(Array.isArray(payload.bbox) ? { bbox: payload.bbox } : {}),
                        ...(payload.from ? { from: payload.from } : {}),
                        ...(payload.to ? { to: payload.to } : {}),
                        ...(payload.observed_from ? { observed_from: payload.observed_from } : {}),
                        ...(payload.observed_to ? { observed_to: payload.observed_to } : {}),
                        ...(Array.isArray(payload.ids) ? { ids: payload.ids } : {}),
                        ...(Array.isArray(payload.entity_ids) ? { ids: payload.entity_ids } : {}),
                        ...(Array.isArray(payload.event_ids) ? { event_ids: payload.event_ids } : {}),
                        ...(Array.isArray(payload.asset_ids) ? { asset_ids: payload.asset_ids } : {}),
                        ...(payload.source_id ? { source_id: payload.source_id } : {}),
                        ...(Array.isArray(payload.source_ids) ? { source_ids: payload.source_ids } : {}),
                        ...(payload.subtype ? { subtype: payload.subtype } : {}),
                        ...(Array.isArray(payload.subtype_in) ? { subtype_in: payload.subtype_in } : {}),
                        ...(payload.entity_kind ? { entity_kind: payload.entity_kind } : {}),
                        ...(Array.isArray(payload.entity_kind_in) ? { entity_kind_in: payload.entity_kind_in } : {}),
                        ...(payload.event_kind ? { event_kind: payload.event_kind } : {}),
                        ...(Array.isArray(payload.event_kind_in) ? { event_kind_in: payload.event_kind_in } : {}),
                        ...(payload.asset_kind ? { asset_kind: payload.asset_kind } : {}),
                        ...(Array.isArray(payload.asset_kind_in) ? { asset_kind_in: payload.asset_kind_in } : {}),
                    };
            if (!layer) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_LAYER_FILTER', message: 'layer.filter requires layer' } });
                return;
            }
            if (Object.keys(predicate).length === 0 && !payload.geometry) {
                res.status(400).json({ status: 'error', error: { code: 'BAD_LAYER_FILTER', message: 'layer.filter requires predicate, filter, bbox, ids or geometry' } });
                return;
            }
            const selection = await selectionRepository.saveSelection({
                selectionId: typeof payload.selection_id === 'string' ? payload.selection_id
                    : typeof payload.selectionId === 'string' ? payload.selectionId
                        : undefined,
                layerId: normalizeLayerId(layer) || layer,
                selectionMode: 'filter',
                predicate,
                geometryJson: payload.geometry && typeof payload.geometry === 'object' ? payload.geometry : null,
                metadata: {
                    source: 'agent-layer-filter',
                    label: payload.label || null,
                    createdBy: 'agent',
                    materialize: true,
                    expiresAt: payload.expires_at || payload.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                },
                expiresAt: payload.expires_at || payload.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
            const materialization = await agentToolService.materializeSelection(selection.selection_id, {
                limit: payload.materialize_limit || payload.max_items || payload.limit,
                timeout_ms: payload.materialize_timeout_ms || payload.materialization_timeout_ms || payload.timeout_ms || payload.timeoutMs,
            });
            const result = await viewControlService.applySelectionWithExplanation(layer, selection.selection_id, mode);
            res.json({
                status: 'ok',
                data: {
                    command,
                    layer,
                    selection_id: selection.selection_id,
                    mode,
                    predicate,
                    geometry: selection.geometry_json,
                    expires_at: selection.expires_at || null,
                    materialization,
                    warnings: materialization.materialization_status === 'partial'
                        ? ['Layer filter materialization is partial; materialization metadata describes the applied subset.']
                        : [],
                    ...result,
                },
            });
            return;
        }

        if (!SUPPORTED_MAP_COMMANDS.includes(command)) {
            res.status(400).json({
                status: 'error',
                error: {
                    code: 'UNKNOWN_MAP_COMMAND',
                    message: `Unknown map command: ${command}`,
                },
                data: {
                    supported_commands: SUPPORTED_MAP_COMMANDS,
                },
            });
            return;
        }

        const state = await viewControlService.patchState({
            agentCommand: {
                command,
                payload,
                createdAt: new Date().toISOString(),
            },
        });
        res.json({
            status: 'ok',
            data: {
                command,
                payload,
                execution: 'browser_action',
                state,
            },
            warnings: [
                'Command stored in view state. Live browser execution happens through the Agent Panel action handler.',
            ],
        });
    } catch (err: any) {
        sendSelectionPredicateErrorOrFallback(res, err);
    }
});

app.get('/api/agents/providers', (_req, res) => {
    try {
        res.json({
            status: 'ok',
            data: agentRuntimeService.listProviders(),
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/agents/sessions', async (_req, res) => {
    try {
        res.json({
            status: 'ok',
            data: await agentRuntimeService.listSessions(),
        });
    } catch (err: any) {
        if (/Database is required/i.test(err.message || '')) {
            res.status(503).json({ status: 'error', error: { code: 'DATABASE_REQUIRED', message: err.message } });
            return;
        }
        sendError(res, err);
    }
});

app.post('/api/agents/sessions', async (req, res) => {
    try {
        const provider = String(req.body?.provider || 'claude_code').trim() as AgentProvider;
        const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
        const session = await agentRuntimeService.createSession(provider, metadata);
        res.json({ status: 'ok', data: session });
    } catch (err: any) {
        if (/not installed|Unknown agent provider|Database is required/i.test(err.message || '')) {
            res.status(/Database is required/i.test(err.message || '') ? 503 : 400).json({
                status: 'error',
                error: { code: 'AGENT_SESSION_CREATE_FAILED', message: err.message },
            });
            return;
        }
        sendError(res, err);
    }
});

app.get('/api/agents/sessions/:sessionId/messages', async (req, res) => {
    try {
        const session = await agentRuntimeService.getSession(req.params.sessionId);
        if (!session) {
            res.status(404).json({ status: 'error', error: { code: 'SESSION_NOT_FOUND', message: 'Agent session not found' } });
            return;
        }
        const messages = await agentRuntimeService.listMessages(req.params.sessionId);
        res.json({ status: 'ok', data: { session, messages } });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.post('/api/agents/sessions/:sessionId/messages', async (req, res) => {
    try {
        const prompt = String(req.body?.content || req.body?.prompt || '').trim();
        if (!prompt) {
            res.status(400).json({ status: 'error', error: { code: 'PROMPT_REQUIRED', message: 'Prompt is required' } });
            return;
        }
        const requestContext = req.body?.context && typeof req.body.context === 'object' && !Array.isArray(req.body.context)
            ? req.body.context
            : null;
        const result = await agentRuntimeService.startRun(req.params.sessionId, prompt, {
            requestContext,
        });
        res.json({ status: 'ok', data: result });
    } catch (err: any) {
        if (/not found|Prompt is required|Database is required|already has a running request|cannot resume sessions/i.test(err.message || '')) {
            res.status(/not found/i.test(err.message || '') ? 404 : 400).json({
                status: 'error',
                error: { code: 'AGENT_RUN_FAILED_TO_START', message: err.message },
            });
            return;
        }
        sendError(res, err);
    }
});

app.post('/api/agents/runs/:runId/cancel', async (req, res) => {
    try {
        await agentRuntimeService.cancelRun(req.params.runId);
        res.json({ status: 'ok', data: { run_id: req.params.runId, cancelled: true } });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/agents/runs/:runId/events', async (req, res) => {
    try {
        const after = Number(req.query.after || req.headers['last-event-id'] || '0');
        const afterSequence = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
        const run = await agentRuntimeService.getRun(req.params.runId);
        if (!run) {
            res.status(404).json({ status: 'error', error: { code: 'RUN_NOT_FOUND', message: 'Agent run not found' } });
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

        const seenSequences = new Set<string>();
        const bufferedLiveEvents: any[] = [];
        let passThroughLive = false;
        let unsubscribe = () => {};
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let closed = false;

        const responseWritable = () => !res.writableEnded && !res.destroyed;
        const closeStream = (status: string) => {
            if (closed) return;
            closed = true;
            if (heartbeat) clearInterval(heartbeat);
            unsubscribe();
            if (responseWritable()) {
                res.write('event: stream.closed\n');
                res.write(`data: ${JSON.stringify({ run_id: req.params.runId, status })}\n\n`);
                res.end();
            }
        };

        const writeEvent = (event: any) => {
            if (closed || !responseWritable()) return;
            const sequence = String(event.sequence_no || '');
            if (sequence && seenSequences.has(sequence)) return;
            if (sequence) seenSequences.add(sequence);
            res.write(`event: ${event.event_type}\n`);
            res.write(`id: ${event.sequence_no}\n`);
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            if (event.event_type === 'run.completed' || event.event_type === 'run.failed') {
                const status = String(event.payload?.status || (event.event_type === 'run.completed' ? 'completed' : 'error'));
                closeStream(status);
            }
        };

        if (!['completed', 'cancelled', 'error'].includes(run.status)) {
            unsubscribe = agentRuntimeService.subscribe(req.params.runId, (event) => {
                if (passThroughLive) writeEvent(event);
                else bufferedLiveEvents.push(event);
            });
        }

        const existing = await agentRuntimeService.listRunEvents(req.params.runId, afterSequence);
        for (const event of existing) writeEvent(event);
        if (closed) return;

        passThroughLive = true;
        for (const event of bufferedLiveEvents) writeEvent(event);
        bufferedLiveEvents.length = 0;
        if (closed) return;

        const lastSequence = [...seenSequences].reduce((max, value) => {
            const n = Number(value);
            return Number.isFinite(n) ? Math.max(max, n) : max;
        }, afterSequence);
        res.write('event: stream.cursor\n');
        res.write(`data: ${JSON.stringify({ run_id: req.params.runId, after: lastSequence })}\n\n`);

        const latestRun = await agentRuntimeService.getRun(req.params.runId);
        if (!latestRun || ['completed', 'cancelled', 'error'].includes(latestRun.status)) {
            closeStream(latestRun?.status || run.status);
            return;
        }

        heartbeat = setInterval(() => {
            if (closed) return;
            res.write('event: heartbeat\n');
            res.write(`data: ${JSON.stringify({ t: new Date().toISOString() })}\n\n`);
        }, 15_000);

        req.on('close', () => {
            closeStream('client_closed');
        });
    } catch (err: any) {
        if (!res.headersSent) sendError(res, err);
        else res.end();
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
    conflicts: { label: 'ACLED', envVars: ['ACLED_EMAIL', 'ACLED_PASSWORD', 'ACLED_KEY'] },
    airspace: { label: 'OpenAIP', envVars: ['OPENAIP_API_KEY'] },
    gfw: { label: 'Global Fishing Watch', envVars: ['GFW_TOKEN'] },
    outages: { label: 'Cloudflare Radar', envVars: ['CLOUDFLARE_API_TOKEN'] },
    fires: { label: 'NASA FIRMS', envVars: ['FIRMS_MAP_KEY', 'NASA_FIRMS_MAP_KEY'] },
    wifi: { label: 'WiGLE', envVars: ['WIGLE_API_NAME', 'WIGLE_API_TOKEN'] },
    imagery: { label: 'Copernicus Data Space', envVars: ['COPERNICUS_CLIENT_ID', 'COPERNICUS_CLIENT_SECRET'] },
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
 * Parse a 4-number bbox string into the internal/provider tuple shape:
 * south,west,north,east. Public OpenSpy endpoints should not rely on this
 * helper's default. They should call parsePublicBbox, which defaults to the
 * OpenSpy public contract west,south,east,north and only accepts legacy
 * south,west,north,east when the caller names that order explicitly.
 *
 * Returns null for:
 *   - wrong number of components or non-finite values
 *   - latitudes outside [-90,90] or longitudes outside [-180,180]
 *   - inverted boxes (south >= north or west >= east)
 */
type BboxOrder = 'swne' | 'wsen';
function parseBbox(bbox: string | undefined, order: BboxOrder = 'swne'): ProviderBboxSwne | null {
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

    return [south, west, north, east];
}

function parseBboxOrder(value: unknown): BboxOrder | null {
    const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!normalized) return null;
    if (normalized === 'wsen' || normalized === 'west,south,east,north') return 'wsen';
    if (normalized === 'swne' || normalized === 'south,west,north,east') return 'swne';
    return null;
}

function parsePublicBbox(bbox: string | undefined, orderValue?: unknown): ProviderBboxSwne | null {
    const rawOrder = String(orderValue || '').trim();
    const parsedOrder = parseBboxOrder(orderValue);
    if (rawOrder && !parsedOrder) return null;
    return parseBbox(bbox, parsedOrder || 'wsen');
}

function parseBboxWsen(bbox: string | undefined, order: BboxOrder = 'wsen'): OpenSpyBbox | null {
    const parsed = parseBbox(bbox, order);
    if (!parsed) return null;
    const [south, west, north, east] = parsed;
    return [west, south, east, north];
}

function normalizeLayerId(layerId: string | undefined): string | undefined {
    if (!layerId) return layerId;
    const key = layerId.trim().toLowerCase().replace(/\s+/g, '_');
    const aliases: Record<string, string> = {
        aviation: 'aircraft',
        aircraft: 'aircraft',
        plane: 'aircraft',
        planes: 'aircraft',
        maritime: 'vessel',
        vessels: 'vessel',
        vessel: 'vessel',
        ships: 'vessel',
        ais: 'vessel',
        satellites: 'satellite',
        satellite: 'satellite',
        dark_vessels: 'dark-vessel',
        'dark-vessels': 'dark-vessel',
        dark_vessel: 'dark-vessel',
        'dark-vessel': 'dark-vessel',
        fires: 'fire',
        fire: 'fire',
        outages: 'outage',
        outage: 'outage',
        conflicts: 'conflict',
        conflict: 'conflict',
        disasters: 'disasters',
        disaster: 'disasters',
        pipelines: 'pipeline',
        pipeline: 'pipeline',
        cables: 'cable',
        cable: 'cable',
        webcams: 'webcam',
        webcam: 'webcam',
        borders: 'border',
        border: 'border',
    };
    return aliases[key] || layerId;
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
// клиент явно передал limit=N, он получает ровно N.
// 2026-05-05: explicit bad limit/offset values are request errors, not silent
// fallbacks. Omitted values may still use an endpoint default page size.
function parsePositiveLimit(value: string | undefined, fallback = 200): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        const err = new Error('Invalid limit (expected positive integer)') as Error & { status?: number; code?: string };
        err.status = 400;
        err.code = 'BAD_LIMIT';
        throw err;
    }
    return Math.max(1, Math.trunc(parsed));
}

function parseNonNegativeOffset(value: string | undefined): number {
    if (!value) return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        const err = new Error('Invalid offset (expected non-negative integer)') as Error & { status?: number; code?: string };
        err.status = 400;
        err.code = 'BAD_OFFSET';
        throw err;
    }
    return Math.max(0, Math.trunc(parsed));
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

function parseReplayTimelineResolutionSeconds(value: string | undefined): number {
    if (!value) return 300;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 86400) {
        const err = new Error('Invalid resolutionSeconds (expected integer between 1 and 86400)') as Error & { status?: number; code?: string };
        err.status = 400;
        err.code = 'BAD_RESOLUTION_SECONDS';
        throw err;
    }
    return parsed;
}

function parseIsoDateOrNull(value: string | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function queryItemTime(item: any): string | null {
    return item?.position_observed_at
        || item?.observed_at
        || item?.valid_from
        || item?.last_observed_at
        || item?.first_observed_at
        || item?.updated_at
        || item?.created_at
        || null;
}

function publicQueryFilters(filters: Record<string, any>): Record<string, any> {
    const next = { ...filters };
    if (Array.isArray(next.bbox) && next.bbox.length === 4) {
        const [south, west, north, east] = next.bbox;
        next.bbox = [west, south, east, north];
        next.bbox_order = 'west,south,east,north';
    }
    return next;
}

function compactQuerySearchItem(kind: 'entities' | 'events' | 'assets', item: any): Record<string, any> {
    if (kind === 'entities') {
        return {
            entity_id: item.entity_id,
            layer_id: item.layer_id,
            source_id: item.source_id,
            entity_kind: item.entity_kind,
            subtype: item.subtype,
            display_name: item.display_name,
            first_observed_at: item.first_observed_at,
            last_observed_at: item.last_observed_at,
            position_observed_at: item.position_observed_at,
            updated_at: item.updated_at,
            display_lat: item.display_lat,
            display_lng: item.display_lng,
            altitude_m: item.altitude_m,
            heading_deg: item.heading_deg,
            speed_mps: item.speed_mps,
        };
    }
    if (kind === 'events') {
        return {
            event_id: item.event_id,
            layer_id: item.layer_id,
            source_id: item.source_id,
            event_kind: item.event_kind,
            subtype: item.subtype,
            observed_at: item.observed_at,
            valid_from: item.valid_from,
            valid_to: item.valid_to,
            first_observed_at: item.first_observed_at,
            last_observed_at: item.last_observed_at,
            updated_at: item.updated_at,
            display_lat: item.display_lat,
            display_lng: item.display_lng,
        };
    }
    return {
        asset_id: item.asset_id,
        layer_id: item.layer_id,
        source_id: item.source_id,
        asset_kind: item.asset_kind,
        subtype: item.subtype,
        display_name: item.display_name,
        first_observed_at: item.first_observed_at,
        last_observed_at: item.last_observed_at,
        updated_at: item.updated_at,
        display_lat: item.display_lat,
        display_lng: item.display_lng,
    };
}

function normalizeQueryDetail(value: unknown): 'full' | 'compact' {
    const detail = String(value || '').trim().toLowerCase();
    return detail === 'compact' || detail === 'summary' ? 'compact' : 'full';
}

function buildQuerySearchResponse(
    kind: 'entities' | 'events' | 'assets',
    filters: Record<string, any>,
    rawItems: any[],
    requestedLimit: number,
    offset: number,
    detail: 'full' | 'compact' = 'full',
    limitDefaulted = false,
) {
    const hasMore = rawItems.length > requestedLimit;
    const returnedItems = hasMore ? rawItems.slice(0, requestedLimit) : rawItems;
    const items = detail === 'compact'
        ? returnedItems.map((item) => compactQuerySearchItem(kind, item))
        : returnedItems;
    const times = items
        .map(queryItemTime)
        .filter((value): value is string => Boolean(value))
        .map((value) => new Date(value).getTime())
        .filter(Number.isFinite);
    const sourceIds = Array.from(new Set(items.map((item) => item.source_id).filter(Boolean))).sort();
    const layerIds = Array.from(new Set(items.map((item) => item.layer_id).filter(Boolean))).sort();
    const status = items.length === 0 ? 'empty' : hasMore ? 'partial' : 'ok';
    const warnings = items.length === 0
        ? ['No rows matched these filters in local OpenSpy storage. Check coverage or source capability before interpreting this as absence in the real world.']
        : hasMore
            ? ['More rows are available. Use pagination.next_offset to continue.']
            : [];
    return {
        status,
        mode: 'latest',
        kind,
        detail,
        filters: {
            ...publicQueryFilters(filters),
            limit: requestedLimit,
            offset,
        },
        query_status: {
            status,
            complete: !hasMore,
            reason: items.length === 0 ? 'empty_result' : hasMore ? 'limit_exceeded' : 'within_limit',
        },
        pagination: {
            requested_limit: requestedLimit,
            limit: requestedLimit,
            defaulted: limitDefaulted,
            capped: false,
            offset,
            returned: items.length,
            has_more: hasMore,
            next_offset: hasMore ? offset + items.length : null,
        },
        coverage: {
            returned_count: items.length,
            source_ids: sourceIds,
            layer_ids: layerIds,
            min_time: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
            max_time: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
            basis: 'returned_rows',
        },
        count: items.length,
        items,
        detail_note: detail === 'compact'
            ? 'Compact query.search omits heavy geometry/properties. Use --detail full, geo.simplify, query.related or object.open when full geometry/properties are needed.'
            : null,
        warnings,
    };
}

function buildReplayPage<T>(
    rawItems: T[],
    requestedLimit: number,
    offset: number,
    limitDefaulted = false,
) {
    const hasMore = rawItems.length > requestedLimit;
    const items = hasMore ? rawItems.slice(0, requestedLimit) : rawItems;
    return {
        items,
        pagination: {
            requested_limit: requestedLimit,
            limit: requestedLimit,
            defaulted: limitDefaulted,
            capped: false,
            offset,
            returned: items.length,
            has_more: hasMore,
            next_offset: hasMore ? offset + items.length : null,
        },
        query_status: {
            status: items.length === 0 ? 'empty' : hasMore ? 'partial' : 'ok',
            complete: !hasMore,
            reason: items.length === 0 ? 'empty_result' : hasMore ? 'page_has_more' : 'within_limit',
        },
    };
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
const cirService = new CIRService(sourcePersistenceService);
const openSanctionsService = new OpenSanctionsService();
liveStreamService.setSanctionsProvider(openSanctionsService);
const airspaceService = new AirspaceService(sourcePersistenceService);
const gfwService = new GFWService(sourcePersistenceService);
const cloudflareService = new CloudflareService(sourcePersistenceService);
const copernicusService = new CopernicusService();
const wigleService = new WigleService(databaseService);
const vesselEnrichmentService = new VesselEnrichmentService(databaseService);

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

    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const limitDefaulted = req.query.limit === undefined || req.query.limit === '';
        const limit = parsePositiveLimit(req.query.limit as string | undefined, 200);
        const offset = parseNonNegativeOffset(req.query.offset as string | undefined);
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            eventId: req.query.eventId as string | undefined,
            eventKind: req.query.eventKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: limit + 1,
            offset,
        };
        const [items, summary] = await Promise.all([
            eventQueryService.listSnapshots(filters),
            eventQueryService.summarizeSnapshots(filters),
        ]);
        const page = buildReplayPage(items, limit, offset, limitDefaulted);
        res.json({
            mode: 'history',
            filters: {
                ...publicQueryFilters(filters),
                limit,
                offset,
            },
            summary,
            count: page.items.length,
            pagination: page.pagination,
            query_status: page.query_status,
            items: page.items,
        });
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/replay/timeline-availability', async (req, res) => {
    if (!databaseService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if (!from || !to) {
        res.status(400).json({ error: 'Missing or invalid from/to timestamp' });
        return;
    }
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (fromMs > toMs) {
        res.status(400).json({ error: 'Invalid from/to timestamp: from must be before to' });
        return;
    }

    let resolutionSeconds: number;
    try {
        resolutionSeconds = parseReplayTimelineResolutionSeconds(
            (req.query.resolutionSeconds as string | undefined)
                || (req.query.bucketSeconds as string | undefined),
        );
    } catch (err: any) {
        sendError(res, err);
        return;
    }

    const layers = parseLayerScopeList(req.query.layers as string | undefined);
    const params: unknown[] = [from, to, resolutionSeconds];
    if (layers.length > 0) params.push(layers);
    const layerParam = layers.length > 0 ? `$${params.length}::text[]` : null;
    const layerFilter = (alias: string) => layerParam ? `AND ${alias}.layer_id = ANY(${layerParam})` : '';

    try {
        const result = await databaseService.query<{
            bucket_start: Date | string;
            sample_count: string;
            object_count: string;
            layers: Record<string, number> | null;
            families: Record<string, number> | null;
        }>(
            `
                WITH raw AS (
                    SELECT
                        'position'::text AS family,
                        pf.layer_id,
                        pf.observed_at,
                        'position:' || pf.entity_id AS object_key,
                        1::bigint AS sample_weight
                    FROM core.position_fixes pf
                    WHERE $3::int < 300
                      AND pf.observed_at >= $1::timestamptz
                      AND pf.observed_at <= $2::timestamptz
                      ${layerFilter('pf')}

                    UNION ALL

                    SELECT
                        'position'::text AS family,
                        ca.layer_id,
                        ca.bucket AS observed_at,
                        'position:' || ca.entity_id AS object_key,
                        GREATEST(ca.n_samples, 1)::bigint AS sample_weight
                    FROM app.ca_position_fixes_5min ca
                    WHERE $3::int >= 300
                      AND ca.bucket >= $1::timestamptz
                      AND ca.bucket <= $2::timestamptz
                      ${layerFilter('ca')}

                    UNION ALL

                    SELECT
                        'event'::text AS family,
                        es.layer_id,
                        COALESCE(es.observed_at, es.valid_from, es.created_at) AS observed_at,
                        'event:' || es.event_id AS object_key,
                        1::bigint AS sample_weight
                    FROM core.event_snapshots es
                    WHERE COALESCE(es.observed_at, es.valid_from, es.created_at) >= $1::timestamptz
                      AND COALESCE(es.observed_at, es.valid_from, es.created_at) <= $2::timestamptz
                      ${layerFilter('es')}

                    UNION ALL

                    SELECT
                        'asset'::text AS family,
                        asset.layer_id,
                        COALESCE(asset.observed_at, asset.created_at) AS observed_at,
                        'asset:' || asset.asset_id AS object_key,
                        1::bigint AS sample_weight
                    FROM core.asset_snapshots asset
                    WHERE COALESCE(asset.observed_at, asset.created_at) >= $1::timestamptz
                      AND COALESCE(asset.observed_at, asset.created_at) <= $2::timestamptz
                      ${layerFilter('asset')}

                    UNION ALL

                    SELECT
                        'orbital'::text AS family,
                        oe.layer_id,
                        oe.observed_at,
                        'orbital:' || oe.entity_id AS object_key,
                        1::bigint AS sample_weight
                    FROM core.orbital_elements oe
                    WHERE oe.observed_at >= $1::timestamptz
                      AND oe.observed_at <= $2::timestamptz
                      ${layerFilter('oe')}

                    UNION ALL

                    SELECT
                        'observation'::text AS family,
                        obs.layer_id,
                        obs.observed_at,
                        'observation:' || obs.observation_id AS object_key,
                        1::bigint AS sample_weight
                    FROM core.observations obs
                    WHERE obs.observed_at >= $1::timestamptz
                      AND obs.observed_at <= $2::timestamptz
                      ${layerFilter('obs')}
                ),
                bucketed AS (
                    SELECT
                        to_timestamp(floor(extract(epoch FROM observed_at) / $3::int) * $3::int) AS bucket_start,
                        family,
                        layer_id,
                        object_key,
                        sample_weight
                    FROM raw
                    WHERE observed_at IS NOT NULL
                ),
                totals AS (
                    SELECT
                        bucket_start,
                        SUM(sample_weight)::text AS sample_count,
                        COUNT(DISTINCT object_key)::text AS object_count
                    FROM bucketed
                    GROUP BY bucket_start
                ),
                layer_totals AS (
                    SELECT
                        bucket_start,
                        jsonb_object_agg(layer_id, sample_count ORDER BY layer_id) AS layers
                    FROM (
                        SELECT bucket_start, layer_id, SUM(sample_weight) AS sample_count
                        FROM bucketed
                        GROUP BY bucket_start, layer_id
                    ) layer_rows
                    GROUP BY bucket_start
                ),
                family_totals AS (
                    SELECT
                        bucket_start,
                        jsonb_object_agg(family, sample_count ORDER BY family) AS families
                    FROM (
                        SELECT bucket_start, family, SUM(sample_weight) AS sample_count
                        FROM bucketed
                        GROUP BY bucket_start, family
                    ) family_rows
                    GROUP BY bucket_start
                )
                SELECT
                    totals.bucket_start,
                    totals.sample_count,
                    totals.object_count,
                    COALESCE(layer_totals.layers, '{}'::jsonb) AS layers,
                    COALESCE(family_totals.families, '{}'::jsonb) AS families
                FROM totals
                LEFT JOIN layer_totals USING (bucket_start)
                LEFT JOIN family_totals USING (bucket_start)
                ORDER BY totals.bucket_start ASC
            `,
            params,
        );

        const buckets = (result?.rows || []).map((row) => {
            const date = row.bucket_start instanceof Date ? row.bucket_start : new Date(String(row.bucket_start));
            return {
                bucket_start: Number.isNaN(date.getTime()) ? String(row.bucket_start) : date.toISOString(),
                sample_count: Number(row.sample_count || 0),
                object_count: Number(row.object_count || 0),
                layers: row.layers || {},
                families: row.families || {},
            };
        });

        res.setHeader('Cache-Control', 'no-store');
        res.json({
            mode: 'timeline-availability',
            time_basis: 'observed',
            from,
            to,
            resolution_seconds: resolutionSeconds,
            bucket_seconds: resolutionSeconds,
            filters: {
                layers,
            },
            count: buckets.length,
            buckets,
        });
    } catch (err: any) {
        console.error('[api/replay/timeline-availability] failed:', err?.message || err);
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

app.get('/api/live/details/:layer/:id', async (req, res) => {
    const layer = String(req.params.layer || '');
    const id = String(req.params.id || '');
    if (layer !== 'webcam' && layer !== 'pipeline' && layer !== 'wifi' && !liveProjectionService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }
    try {
        let details = layer === 'webcam'
            ? webcamsService.getWebcamDetails(id)
            : layer === 'wifi'
                ? await wigleService.getWifiDetails(id)
            : liveProjectionService.isReady()
                ? await liveProjectionService.getLiveDetails(layer, id)
                : null;
        if (!details && layer === 'pipeline') {
            details = await overtureService.getPipelineDetails(id);
        }
        if (!details) {
            res.status(404).json({ error: 'Live feature not found' });
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(details);
    } catch (err: any) {
        console.error('[api/live/details] failed:', err?.message || err);
        sendError(res, err);
    }
});

// Reference-class vessel enrichment: Commons photos by IMO category plus
// GFW registry identity. Fetched on demand for an open entity card and
// cached in core.vessel_enrichment (lazy TTL refresh inside the service).
app.get('/api/enrichment/vessel/:imo', async (req, res) => {
    const imo = String(req.params.imo || '').trim();
    if (!vesselEnrichmentService.isValidImo(imo)) {
        res.status(400).json({ error: 'IMO must be a 7-digit number' });
        return;
    }
    const mmsi = typeof req.query.mmsi === 'string' ? req.query.mmsi : null;
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    try {
        const enrichment = await vesselEnrichmentService.getEnrichment(imo, mmsi, refresh);
        res.setHeader('Cache-Control', 'no-store');
        res.json(enrichment);
    } catch (err: any) {
        console.error('[api/enrichment/vessel] failed:', err?.message || err);
        sendError(res, err);
    }
});

app.post('/api/replay/render-chunks/prewarm', async (req, res) => {
    if (!replayQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const body = ((req.body && typeof req.body === 'object') ? req.body : {}) as Record<string, any>;
    const rawAt = typeof body.at === 'string' ? body.at : undefined;
    const parsedAt = parseIsoDateOrNull(rawAt);
    if (rawAt && !parsedAt) {
        res.status(400).json({ error: 'Invalid at timestamp' });
        return;
    }
    const at = parsedAt || new Date().toISOString();
    const rawFrom = typeof body.from === 'string' ? body.from : undefined;
    const rawTo = typeof body.to === 'string' ? body.to : undefined;
    const parsedFrom = parseIsoDateOrNull(rawFrom);
    const parsedTo = parseIsoDateOrNull(rawTo);
    if ((rawFrom && !parsedFrom) || (rawTo && !parsedTo)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }
    const from = parsedFrom || at;
    const to = parsedTo || at;

    const layersRaw = Array.isArray(body.layers)
        ? body.layers.join(',')
        : (typeof body.layers === 'string' ? body.layers : undefined);
    const layers = parseLayerScopeList(layersRaw);
    const effectiveLayers = layers.length > 0 ? layers : REPLAY_RENDER_PREWARM_LAYERS;

    const bboxRaw = Array.isArray(body.bbox)
        ? body.bbox.join(',')
        : (typeof body.bbox === 'string' ? body.bbox : undefined);
    const bbox = parsePublicBbox(bboxRaw, body.bbox_order || body.bboxOrder);
    if (body.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
        return;
    }

    const z = body.z == null ? 0 : Number(body.z);
    if (!Number.isInteger(z) || z < 0 || z > 6) {
        res.status(400).json({ error: 'Invalid z (expected integer 0..6)' });
        return;
    }
    const stepSeconds = Number(body.stepSeconds ?? body.step_seconds ?? 15 * 60);
    const maxFrames = Number(body.maxFrames ?? body.max_frames ?? 5);
    if (!Number.isInteger(stepSeconds) || stepSeconds <= 0 || !Number.isInteger(maxFrames) || maxFrames <= 0) {
        res.status(400).json({ error: 'Invalid stepSeconds/maxFrames (expected positive integers)' });
        return;
    }
    const aggregateFires = body.cluster === 0 || body.cluster === false || body.cluster === '0' || body.cluster === 'false'
        ? false
        : true;

    const routeStartedAt = performance.now();
    try {
        const result = await withSpan('replay.render_chunks_prewarm_manual', {
            'replay.layers': effectiveLayers.join(','),
            'replay.layers.count': effectiveLayers.length,
            'replay.from': from,
            'replay.to': to,
        }, async () => replayRenderBatchService.prewarmReplayChunks({
            at,
            from,
            to,
            layers: effectiveLayers,
            z,
            bbox: bbox || undefined,
            stepSeconds,
            maxFrames,
            aggregateFires,
        }));
        logPerfEvent('replay.render_chunks_prewarm_manual', {
            source: 'backend',
            at,
            from,
            to,
            layers: effectiveLayers,
            z,
            frames: result.frames,
            chunks: result.chunks,
            hits: result.hits,
            misses: result.misses,
            bytes: result.bytes,
            buildMs: result.ms,
            ms: Math.round(performance.now() - routeStartedAt),
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, ...result });
    } catch (err: any) {
        console.error('[api/replay/render-chunks/prewarm] failed:', err?.message || err);
        sendError(res, err);
    }
});

function sendLegacyReplayTileGone(_req: any, res: any) {
    res.status(410).json({
        status: 'gone',
        error: {
            code: 'LEGACY_REPLAY_TILE_ENDPOINT_REMOVED',
            message: 'Legacy replay tile endpoints were removed. Use render-chunks for map rendering or replay state for semantic data queries.',
        },
        replacement: {
            render_chunks: '/api/replay/render-chunks',
            semantic_state: '/api/replay/state',
        },
    });
}

app.get('/api/replay/manifest', sendLegacyReplayTileGone);
app.get('/api/replay/tile-bundle', sendLegacyReplayTileGone);
app.get(/^\/api\/replay\/tile(?:\/.*)?$/, sendLegacyReplayTileGone);
app.get(/^\/static\/replay-tiles(?:\/.*)?$/, sendLegacyReplayTileGone);

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

    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
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
        const chunks = Object.values(response.layers).flat();
        const bytes = chunks.reduce((sum, chunk) => sum + chunk.bytes.binary, 0);
        const cacheHits = chunks.filter((chunk) => chunk.cache?.hit === true).length;
        const timingTotals = chunks.reduce((acc, chunk) => {
            for (const key of ['source', 'pack', 'binary', 'cacheRead', 'cacheWrite', 'total']) {
                const value = chunk.timingsMs?.[key];
                if (Number.isFinite(value)) acc[key] = Math.round(((acc[key] || 0) + value) * 100) / 100;
            }
            return acc;
        }, {} as Record<string, number>);
        logPerfEvent('replay.render_chunks', {
            source: 'backend',
            at,
            layers,
            chunks: chunks.length,
            cacheHits,
            cacheMisses: chunks.length - cacheHits,
            bytes,
            timingsMs: timingTotals,
            layerStats: chunks.map((chunk) => ({
                layerId: chunk.layerId,
                hit: chunk.cache?.hit === true,
                cacheAt: chunk.cache?.at,
                sourceAt: chunk.cache?.sourceAt,
                bytes: chunk.bytes.binary,
                features: chunk.counts.features,
                pointVertices: chunk.counts.pointVertices,
                fillTriangles: chunk.counts.fillTriangles,
                totalMs: chunk.timingsMs?.total,
                sourceMs: chunk.timingsMs?.source,
                packMs: chunk.timingsMs?.pack,
                binaryMs: chunk.timingsMs?.binary,
                cacheReadMs: chunk.timingsMs?.cacheRead,
                cacheWriteMs: chunk.timingsMs?.cacheWrite,
            })),
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
    const since = parseIsoDateOrNull(req.query.since as string | undefined);
    if (req.query.since && !since) {
        res.status(400).json({ error: 'Invalid since timestamp' });
        return;
    }
    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
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
                since: since || undefined,
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
            since: since || undefined,
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

app.post('/api/perf-event', (req, res) => {
    const body = req.body;
    if (Array.isArray(body)) {
        for (const ev of body) logPerfEventFromClient(ev);
    } else {
        logPerfEventFromClient(body);
    }
    res.status(204).end();
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

    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
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
    if (!replayQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const at = parseIsoDateOrNull(req.query.at as string | undefined);
    if (!at) {
        res.status(400).json({ error: 'Missing or invalid at timestamp' });
        return;
    }

    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
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
        const limitDefaulted = req.query.limit === undefined || req.query.limit === '';
        const limit = parsePositiveLimit(req.query.limit as string | undefined, 1000);
        const offset = parseNonNegativeOffset(req.query.offset as string | undefined);
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
                    limit: limit + 1,
                    offset,
                    order,
                    stepSeconds: stepSeconds || undefined,
                })
                : entityQueryService.listTrack({
                    entityId: req.params.entityId,
                    from: from || undefined,
                    to: to || undefined,
                    limit: limit + 1,
                    offset,
                    order,
                }),
        ]);
        const page = buildReplayPage(items, limit, offset, limitDefaulted);

        recordReplayRequest('track', performance.now() - routeStartedAt, page.items.length, req.params.entityId);

        res.json({
            mode: 'historical-replay',
            replay_kind: 'track',
            entityId: req.params.entityId,
            order,
            entity: entityState[0] || null,
            count: page.items.length,
            pagination: page.pagination,
            query_status: page.query_status,
            items: page.items,
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
        const limitDefaulted = req.query.limit === undefined || req.query.limit === '';
        const limit = parsePositiveLimit(req.query.limit as string | undefined, 500);
        const offset = parseNonNegativeOffset(req.query.offset as string | undefined);
        const items = await eventQueryService.listSnapshots({
            eventId: req.params.eventId,
            limit: limit + 1,
            offset,
        });
        const page = buildReplayPage(items, limit, offset, limitDefaulted);
        res.json({
            mode: 'event-history',
            eventId: req.params.eventId,
            count: page.items.length,
            pagination: page.pagination,
            query_status: page.query_status,
            items: page.items,
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

    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const limitDefaulted = req.query.limit === undefined || req.query.limit === '';
        const limit = parsePositiveLimit(req.query.limit as string | undefined, 200);
        const offset = parseNonNegativeOffset(req.query.offset as string | undefined);
        const detail = normalizeQueryDetail(req.query.detail || req.query.view || req.query.mode);
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            eventId: req.query.eventId as string | undefined,
            eventKind: req.query.eventKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: limit + 1,
            offset,
        };
        const items = await eventQueryService.listLatest(filters);
        res.json(buildQuerySearchResponse('events', filters, items, limit, offset, detail, limitDefaulted));
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/query/entities/latest', async (req, res) => {
    if (!entityQueryService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }

    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const limitDefaulted = req.query.limit === undefined || req.query.limit === '';
        const limit = parsePositiveLimit(req.query.limit as string | undefined, 200);
        const offset = parseNonNegativeOffset(req.query.offset as string | undefined);
        const detail = normalizeQueryDetail(req.query.detail || req.query.view || req.query.mode);
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            entityId: req.query.entityId as string | undefined,
            entityKind: req.query.entityKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: limit + 1,
            offset,
        };
        const items = await entityQueryService.listLatest(filters);
        res.json(buildQuerySearchResponse('entities', filters, items, limit, offset, detail, limitDefaulted));
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/query/entities/live-status', async (req, res) => {
    if (!entityQueryService.isReady()) {
        res.status(503).json({ error: 'Query database is not ready' });
        return;
    }

    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
        return;
    }

    const freshnessMinutesRaw = req.query.freshnessMinutes || req.query.freshness_minutes;
    const freshnessMinutes = freshnessMinutesRaw ? Number(freshnessMinutesRaw) : 30;
    if (!Number.isFinite(freshnessMinutes) || freshnessMinutes <= 0) {
        res.status(400).json({ error: 'Invalid freshnessMinutes' });
        return;
    }

    try {
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            bbox: bbox || undefined,
            freshnessMinutes,
            limit: parsePositiveLimit(req.query.limit as string | undefined, 20),
        };
        const data = await entityQueryService.getLiveStatus(filters);
        res.json({
            mode: 'live-status',
            filters,
            ...data,
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
        const limit = parsePositiveLimit(req.query.limit as string | undefined, 1000);
        const offset = parseNonNegativeOffset(req.query.offset as string | undefined);
        const rows = await entityQueryService.listTrack({
            entityId: req.params.entityId,
            from: from || undefined,
            to: to || undefined,
            limit: limit + 1,
            offset,
            order,
        });
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        res.json({
            mode: 'track',
            entityId: req.params.entityId,
            order,
            limit,
            offset,
            count: items.length,
            pagination: {
                limit,
                offset,
                has_more: hasMore,
                next_offset: hasMore ? offset + limit : null,
            },
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

    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const limitDefaulted = req.query.limit === undefined || req.query.limit === '';
        const limit = parsePositiveLimit(req.query.limit as string | undefined, 200);
        const offset = parseNonNegativeOffset(req.query.offset as string | undefined);
        const detail = normalizeQueryDetail(req.query.detail || req.query.view || req.query.mode);
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            assetId: req.query.assetId as string | undefined,
            assetKind: req.query.assetKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: limit + 1,
            offset,
        };
        const items = await assetQueryService.listLatest(filters);
        res.json(buildQuerySearchResponse('assets', filters, items, limit, offset, detail, limitDefaulted));
    } catch (err: any) {
        sendError(res, err);
    }
});

app.get('/api/replay/assets', async (req, res) => {
    if (!assetQueryService.isReady()) {
        res.status(503).json({ error: 'Replay database is not ready' });
        return;
    }

    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
        return;
    }

    const from = parseIsoDateOrNull(req.query.from as string | undefined);
    const to = parseIsoDateOrNull(req.query.to as string | undefined);
    if ((req.query.from && !from) || (req.query.to && !to)) {
        res.status(400).json({ error: 'Invalid from/to timestamp' });
        return;
    }

    try {
        const limitDefaulted = req.query.limit === undefined || req.query.limit === '';
        const limit = parsePositiveLimit(req.query.limit as string | undefined, 500);
        const offset = parseNonNegativeOffset(req.query.offset as string | undefined);
        const filters = {
            layerId: normalizeLayerId((req.query.layerId as string | undefined) || (req.query.layer as string | undefined)),
            sourceId: req.query.sourceId as string | undefined,
            assetId: req.query.assetId as string | undefined,
            assetKind: req.query.assetKind as string | undefined,
            subtype: req.query.subtype as string | undefined,
            from: from || undefined,
            to: to || undefined,
            bbox: bbox || undefined,
            limit: limit + 1,
            offset,
        };
        const items = await assetQueryService.listSnapshots(filters);
        const page = buildReplayPage(items, limit, offset, limitDefaulted);
        res.json({
            mode: 'history',
            filters: {
                ...publicQueryFilters(filters),
                limit,
                offset,
            },
            count: page.items.length,
            pagination: page.pagination,
            query_status: page.query_status,
            items: page.items,
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
        const limitDefaulted = req.query.limit === undefined || req.query.limit === '';
        const limit = parsePositiveLimit(req.query.limit as string | undefined, 1000);
        const offset = parseNonNegativeOffset(req.query.offset as string | undefined);
        const items = await assetQueryService.listSnapshots({
            assetId: req.params.assetId,
            limit: limit + 1,
            offset,
        });
        const page = buildReplayPage(items, limit, offset, limitDefaulted);
        res.json({
            mode: 'asset-history',
            assetId: req.params.assetId,
            count: page.items.length,
            pagination: page.pagination,
            query_status: page.query_status,
            items: page.items,
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
    const bbox = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (req.query.bbox && !bbox) {
        res.status(400).json({ error: 'Invalid bbox (expected west,south,east,north)' });
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
const OVERPASS_PRIMARY_TIMEOUT_MS = 5000;
const OVERPASS_SECONDARY_TIMEOUT_MS = 250;
const POWER_INFRA_OVERPASS_TIMEOUT_MS = 5000;
const WIFI_MAX_BBOX_AREA_SQDEG = Number(process.env.WIFI_MAX_BBOX_AREA_SQDEG || 0.0001);

function overpassViewportBudgetMs(primaryRecords: readonly unknown[]): number {
    return primaryRecords.length > 0 ? OVERPASS_SECONDARY_TIMEOUT_MS : OVERPASS_PRIMARY_TIMEOUT_MS;
}

function bboxArea(a: number, b: number, c: number, d: number): number {
    // Called with normalized south,west,north,east values after the public
    // west,south,east,north contract has been parsed at the endpoint boundary.
    return Math.abs(a - c) * Math.abs(b - d);
}

// Critical infrastructure — hybrid Overpass + Overture merge.
//
// Overture is the fast local viewport source when enabled. Overpass is a
// secondary enrichment source: if Overture already returned records, do not
// hold the whole response for seconds waiting on public Overpass mirrors. The
// response still carries `overpassTimedOut` so incomplete enrichment is visible
// to diagnostics instead of being silently masked.
app.get('/api/infrastructure', async (req, res) => {
    const parsed = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (!parsed) {
        res.status(400).json({ error: 'Missing or invalid bbox (expected west,south,east,north; lat +/-90, lng +/-180; south<north; west<east)' });
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

        const overpassBudgetMs = overpassViewportBudgetMs(overtureRecords);
        let overpassRecords: any[] = [];
        let overpassTimedOut = false;
        const tOp0 = Date.now();
        try {
            overpassRecords = await Promise.race([
                infrastructureService.getInfrastructure(south, west, north, east),
                new Promise<any[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Overpass too slow')), overpassBudgetMs)
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
        logPerfEvent('infra.fetch', { source: 'backend', endpoint: 'infrastructure', overtureMs: tOv, overtureRecords: overtureRecords.length, overpassMs: tOp, overpassBudgetMs, overpassRecords: overpassRecords.length, overpassTimedOut, mergedRecords: merged.length, bboxAreaSq: Number(area.toFixed(2)) });
        console.log(`[Infra] /api/infrastructure overture=${tOv}ms(${overtureRecords.length}) overpass=${tOp}ms/${overpassBudgetMs}ms(${overpassRecords.length}${overpassTimedOut ? ',timeout' : ''}) merged=${merged.length} bbox=${area.toFixed(1)}sq`);
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
    const parsed = parseBboxWsen(bbox);
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

        const overtureHasLineGeometry = overtureRecords.some((record) =>
            record.type === 'power_line' &&
            Array.isArray(record.coordinates) &&
            record.coordinates.length >= 2
        );
        // If the local Overture cache already has transmission-line geometry,
        // Overture is the source for this endpoint. Do not call public
        // Overpass mirrors just to enrich a complete Overture power tile.
        const overpassBudgetMs = overtureHasLineGeometry
            ? 0
            : POWER_INFRA_OVERPASS_TIMEOUT_MS;
        let overpassRecords: any[] = [];
        let overpassTimedOut = false;
        const tOp0 = Date.now();
        if (!overtureHasLineGeometry) {
            try {
                overpassRecords = await Promise.race([
                    infrastructureService.getPowerInfra(bbox),
                    new Promise<any[]>((_, reject) =>
                        setTimeout(() => reject(new Error('Overpass too slow')), overpassBudgetMs)
                    ),
                ]);
            } catch {
                overpassTimedOut = true;
            }
        }
        const tOp = Date.now() - tOp0;
        recordInfraFetch('power-infra', 'overture', tOv, overtureRecords.length, false);
        recordInfraFetch('power-infra', 'overpass', tOp, overpassRecords.length, overpassTimedOut);
        logPerfEvent('infra.fetch', { source: 'backend', endpoint: 'power-infra', overtureMs: tOv, overtureRecords: overtureRecords.length, overpassMs: tOp, overpassBudgetMs, overpassRecords: overpassRecords.length, overpassTimedOut });
        console.log(`[Infra] /api/power-infra overture=${tOv}ms(${overtureRecords.length}) overpass=${tOp}ms/${overpassBudgetMs}ms(${overpassRecords.length}${overpassTimedOut ? ',timeout' : ''})`);

        const overpassForMerge = overtureHasLineGeometry
            ? overpassRecords.filter((record) => record?.type !== 'power_line')
            : overpassRecords;
        const deduped = dedupAgainstOverture(overpassForMerge, overtureRecords);
        const merged = [
            ...overtureRecords.map((r) => ({
                id: r.id,
                lat: r.lat,
                lng: r.lng,
                name: r.name,
                type: r.type,
                source: 'overture',
                voltage: r.voltage || '',
                operator: r.operator || null,
                coordinates: r.coordinates,
            })),
            ...deduped,
        ];
        res.json({ data: merged, overpassTimedOut });
    } catch (err: any) {
        console.error('[PowerInfra] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch power infrastructure data' });
    }
});

// Pipeline render geometry from the local Overture DuckDB cache. The viewport
// payload includes only render-critical fields; descriptive metadata remains
// behind /api/live/details/pipeline/:id.
app.get('/api/pipelines', async (req, res) => {
    const parsed = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (!parsed) {
        res.status(400).json({ error: 'Missing or invalid bbox (expected west,south,east,north; lat +/-90, lng +/-180; south<north; west<east)' });
        return;
    }
    const [south, west, north, east] = parsed;
    const area = bboxArea(south, west, north, east);
    if (area > MAX_BBOX_AREA_SQDEG) {
        res.status(400).json({
            error: `bbox too large: ${area.toFixed(1)} sq.deg (max ${MAX_BBOX_AREA_SQDEG}). Request smaller viewport tiles.`,
        });
        return;
    }
    if (!overtureService.isEnabled() || !overtureService.isReady()) {
        res.status(503).json({ error: 'Overture cache is not ready for pipeline queries' });
        return;
    }
    try {
        const t0 = Date.now();
        const rows = await overtureService.getPipelinesInBbox(south, west, north, east);
        const elapsedMs = Date.now() - t0;
        logPerfEvent('infra.fetch', {
            source: 'backend',
            endpoint: 'pipelines',
            provider: 'overture',
            elapsedMs,
            records: rows.length,
            bboxAreaSq: Number(area.toFixed(2)),
        });
        res.json({
            data: rows.map((row) => ({
                id: row.id,
                lat: row.lat,
                lng: row.lng,
                substance: row.substance,
                coordinates: row.coordinates,
            })),
            source: 'overture',
            elapsedMs,
        });
    } catch (err: any) {
        console.error('[Pipelines] endpoint error:', err.message);
        if (String(err?.message || '').includes('pipeline cache schema')) {
            res.status(503).json({ error: err.message });
            return;
        }
        sendError(res, err);
    }
});

// Wi-Fi observations from WiGLE. Viewport-only by design: WiGLE is rate-limited
// per account and the layer must not become a global crawler. Response payload
// is render-only; SSID/channel/encryption detail is loaded through
// /api/live/details/wifi/:id after the user selects an observation.
app.get('/api/wifi', async (req, res) => {
    const parsed = parsePublicBbox(req.query.bbox as string | undefined, req.query.bbox_order || req.query.bboxOrder);
    if (!parsed) {
        res.status(400).json({ error: 'Missing or invalid bbox (expected west,south,east,north; lat +/-90, lng +/-180; south<north; west<east)' });
        return;
    }
    const [south, west, north, east] = parsed;
    const area = bboxArea(south, west, north, east);
    if (area > WIFI_MAX_BBOX_AREA_SQDEG) {
        res.status(400).json({
            error: `bbox too large: ${area.toFixed(3)} sq.deg (max ${WIFI_MAX_BBOX_AREA_SQDEG}). Request smaller Wi-Fi viewport tiles.`,
        });
        return;
    }
    try {
        const payload = await wigleService.searchBbox(south, west, north, east);
        logPerfEvent('wifi.fetch', {
            source: 'backend',
            endpoint: 'wifi',
            provider: 'wigle',
            elapsedMs: payload.elapsedMs,
            records: payload.data.length,
            totalResults: payload.totalResults,
            truncated: payload.truncated,
            cached: payload.cached,
            bboxAreaSq: Number(area.toFixed(6)),
        });
        res.json(payload);
    } catch (err: any) {
        const status = Number(err?.status || err?.response?.status || 0);
        if (status === 401 || status === 403) {
            res.status(503).json({ error: 'WiGLE credentials rejected' });
            return;
        }
        if (status === 429) {
            res.status(429).json({ error: 'WiGLE rate limit reached' });
            return;
        }
        if (status === 503) {
            res.status(503).json({ error: err.message || 'WiGLE provider unavailable' });
            return;
        }
        console.error('[WiFi] endpoint error:', err?.message || err);
        res.status(502).json({ error: 'Failed to fetch Wi-Fi observations from WiGLE' });
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
    const parsed = parseBboxWsen(req.query.bbox as string | undefined);
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
    const acledH = acledService.getHealth();
    const gdeltH = gdeltService.getHealth();
    const gdeltPersistedCount = gdeltH.status === 'streaming'
        ? 0
        : await countCurrentCanonicalEvents('conflict', 'gdelt');
    const gdeltPersistedFreshnessMs = 45 * 60 * 1000;
    const gdeltHasFreshFetch = typeof gdeltH.lastSuccessfulFetchAgeMs === 'number'
        && gdeltH.lastSuccessfulFetchAgeMs <= gdeltPersistedFreshnessMs;
    const effectiveGdeltH = gdeltH.status === 'streaming' || gdeltPersistedCount <= 0 || !gdeltHasFreshFetch
        ? gdeltH
        : {
            ...gdeltH,
            status: 'streaming' as const,
            count: Math.max(Number(gdeltH.count || 0), gdeltPersistedCount),
            note: `serving ${gdeltPersistedCount} persisted current events from a recent successful GDELT fetch; latest live fetch ${gdeltH.status}${gdeltH.note ? `: ${gdeltH.note}` : ''}`,
            upstreamStatus: gdeltH.status,
            upstreamNote: gdeltH.note,
        };

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

    const conflictCount = Number(acledH.count || 0) + Number(effectiveGdeltH.count || 0);
    const conflictsStatus = effectiveGdeltH.status === 'streaming' || acledH.status === 'streaming'
        ? 'streaming'
        : acledH.status === 'auth-missing'
            ? 'auth-missing'
            : 'error';
    const conflictsNote = [
        effectiveGdeltH.status === 'streaming' ? `GDELT streaming${effectiveGdeltH.note ? ` (${effectiveGdeltH.note})` : ''}` : effectiveGdeltH.note ? `GDELT ${effectiveGdeltH.status}: ${effectiveGdeltH.note}` : `GDELT ${effectiveGdeltH.status}`,
        acledH.status === 'streaming' ? 'ACLED streaming' : acledH.note ? `ACLED ${acledH.status}: ${acledH.note}` : `ACLED ${acledH.status}`,
    ].join('; ');
    const conflictsHealth = {
        status: conflictsStatus,
        note: conflictsNote,
        count: conflictCount,
        completeness: acledH.status === 'streaming' && effectiveGdeltH.status === 'streaming' ? 'complete' : 'incomplete',
        providers: { acled: acledH, gdelt: effectiveGdeltH },
    };
    const sourceStatuses = await collectSourceIngestStatus();
    const gpsJamH = gpsJamService.getHealth();
    const gpsJamPersisted = sourceStatuses.find((row) => row.sourceId === 'gpsjam' && row.layerId === 'jamming');
    const gpsJamPersistedCount = gpsJamH.status === 'streaming'
        ? 0
        : await countCurrentCanonicalEvents('jamming', 'gpsjam');
    const effectiveGpsJamH = gpsJamH.status === 'streaming' || gpsJamPersistedCount <= 0 || gpsJamPersisted?.status !== 'completed'
        ? gpsJamH
        : {
            ...gpsJamH,
            status: 'streaming' as const,
            count: Math.max(Number(gpsJamH.count || 0), gpsJamPersistedCount),
            note: `serving ${gpsJamPersistedCount} persisted current GPSJam zones; latest live fetch ${gpsJamH.status}${gpsJamH.note ? `: ${gpsJamH.note}` : ''}`,
            upstreamStatus: gpsJamH.status,
            upstreamNote: gpsJamH.note,
        };

    const statusPayload = {
        runtime: {
            liveIngestEnabled,
            replayRenderPrewarmEnabled: process.env.REPLAY_RENDER_PREWARM_DISABLED !== 'true',
        },
        database: databaseService.getHealth(),
        satellites: satelliteService.getHealth(),
        aviation: adsbHealth.aviation,
        maritime: adsbHealth.maritime,
        cables: extendedHealth.cables,
        fires: extendedHealth.fires,
        jamming: effectiveGpsJamH,
        airspace: airspaceService.getHealth(),
        acled: acledH,
        conflicts: conflictsHealth,
        gdelt: effectiveGdeltH,
        gfw: gfwService.getHealth(),
        outages: {
            status: outagesStatus,
            note: outagesNote,
            count: outagesCount,
            cloudflare: cfH,
            ioda: iodaH,
            truncated: Boolean((cfH as any).truncated),
            completeness: (cfH as any).truncated ? 'incomplete' : outagesStatus === 'auth-missing' ? 'unavailable' : 'complete',
        },
        // Services without real health getters still fall back to env check
        traffic: { status: envCheck('TOMTOM_API_KEY') ? 'streaming' : 'auth-missing' },
        webcams: { status: webcamsStatus, note: webcamsNote },
        infrastructure: { status: infraStatus, note: infraNote },
        wifi: wigleService.getHealth(),
        overture: os ?? { state: 'disabled' },
        sources: sourceStatuses,
        storage: await collectStorageStatus(),
    };

    void runtimeStateRepository.persistSnapshot(statusPayload);
    res.json(statusPayload);
});

app.get('/api/status/sources', async (_req, res) => {
    res.json({
        version: 1,
        updatedAt: new Date().toISOString(),
        sources: await collectSourceIngestStatus(),
    });
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
    if (databaseService.isReady()) {
        await verifyAgentReadonlyRole();
        await agentRuntimeService.recoverInterruptedRuns('backend_restart');
    }
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
        cirService.start();
        openSanctionsService.start();
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
    setTimeout(() => {
        void prewarmReplayRenderChunksWindow('startup');
    }, 2500);
    setInterval(() => {
        void prewarmReplayRenderChunksWindow('interval');
    }, 15 * 60 * 1000);
}

bootstrap();
