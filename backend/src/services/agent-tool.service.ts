import crypto from 'crypto';
import { DatabaseService } from '../db/database.service';
import { CatalogReadService } from './catalog-read.service';
import { SelectionRepository, type SelectionPayload, type SelectionItemPayload } from '../repositories/selection.repository';
import { ViewControlService } from './view-control.service';
import { ReplayQueryService, type ReplayEntityRow } from './replay-query.service';

type Bbox = [number, number, number, number]; // west, south, east, north

type RegionRecord = {
    region_id: string;
    display_name: string;
    aliases: string[];
    bbox: Bbox;
    center: { lat: number; lng: number };
    notes?: string;
};

const REGION_GAZETTEER: RegionRecord[] = [
    {
        region_id: 'region:strait-of-hormuz',
        display_name: 'Strait of Hormuz',
        aliases: ['hormuz', 'ormuz', 'ormuz strait', 'ормуз', 'ормузский пролив', 'ормский пролив'],
        bbox: [54, 24, 58.5, 28.5],
        center: { lat: 26.25, lng: 56.25 },
        notes: 'Maritime chokepoint between the Persian Gulf and the Gulf of Oman.',
    },
    {
        region_id: 'region:baltic-cable-corridor',
        display_name: 'Baltic cable corridor',
        aliases: ['baltic cables', 'baltic sea cables', 'baltic sea', 'балтика', 'балтийские кабели'],
        bbox: [12, 53, 31, 61],
        center: { lat: 57, lng: 21.5 },
    },
    {
        region_id: 'region:nordic-barents-gnss',
        display_name: 'Nordic / Barents GNSS jamming corridor',
        aliases: ['gnss jamming baltic', 'gps jamming baltic', 'barents', 'kaliningrad jamming', 'глушение gps'],
        bbox: [24.9101, 64.8548, 34.9101, 74.8548],
        center: { lat: 69.8548, lng: 29.9101 },
    },
    {
        region_id: 'region:taiwan-luzon',
        display_name: 'Taiwan / Luzon Strait cable corridor',
        aliases: ['taiwan luzon', 'luzon strait', 'taiwan strait cables', 'тайвань', 'лусон'],
        bbox: [120, 17.4, 136.1, 33.5],
        center: { lat: 25.45, lng: 128.05 },
    },
    {
        region_id: 'region:gulf-of-mexico-texas',
        display_name: 'Gulf of Mexico / Texas coastal corridor',
        aliases: ['gulf of mexico', 'texas coast', 'gulf coast'],
        bbox: [-99.2469, 25.7196, -91.2469, 33.7196],
        center: { lat: 29.7196, lng: -95.2469 },
    },
];

function hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
}

function parsePositiveIntOrDefault(value: unknown, fallback: number, label: string): { value: number; defaulted: boolean } {
    if (!hasValue(value)) return { value: fallback, defaulted: true };
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(Math.trunc(parsed))) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return { value: Math.trunc(parsed), defaulted: false };
}

function parseOptionalPositiveInt(value: unknown, label: string): number | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return Math.trunc(parsed);
}

function sqlLike(value: string): string {
    return `%${value.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
}

function parseBboxLike(value: unknown): Bbox | null {
    const parts = value && typeof value === 'object' && !Array.isArray(value)
        ? [
            Number((value as any).west ?? (value as any).w),
            Number((value as any).south ?? (value as any).s),
            Number((value as any).east ?? (value as any).e),
            Number((value as any).north ?? (value as any).n),
        ]
        : Array.isArray(value)
        ? value.map(Number)
        : String(value || '').split(',').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
    const [west, south, east, north] = parts;
    if (Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) return null;
    if (south >= north || west >= east) return null;
    return [west, south, east, north];
}

function parseSelectionBbox(value: unknown, order: unknown): Bbox | null {
    const raw = Array.isArray(value)
        ? value.map(Number)
        : String(value || '').split(',').map(Number);
    const normalizedOrder = String(order || '').toLowerCase().replace(/\s+/g, '');
    const orderKey = !normalizedOrder || normalizedOrder === 'wsen' || normalizedOrder === 'west,south,east,north'
        ? 'wsen'
        : normalizedOrder === 'swne' || normalizedOrder === 'south,west,north,east'
            ? 'swne'
            : null;
    if (!orderKey) {
        throw new Error(`Unsupported selection bbox_order: ${String(order)}`);
    }
    if (raw.length === 4 && orderKey === 'swne') {
        const [south, west, north, east] = raw;
        return parseBboxLike([west, south, east, north]);
    }
    return parseBboxLike(value);
}

function parseQueryBbox(value: unknown, order: unknown): Bbox | null {
    return parseSelectionBbox(value, order);
}

function parseIso(value: unknown): string | null {
    if (!value) return null;
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isStatementTimeout(err: any): boolean {
    return err?.code === '57014' || /statement timeout/i.test(err?.message || '');
}

function bboxPolygon([west, south, east, north]: Bbox) {
    return {
        type: 'Polygon',
        coordinates: [[
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
        ]],
    };
}

function pointDistanceMetersToDegrees(radiusM: number): number {
    return Math.max(0.00001, radiusM / 111_320);
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const r = 6_371_000;
    const phi1 = a.lat * Math.PI / 180;
    const phi2 = b.lat * Math.PI / 180;
    const deltaPhi = (b.lat - a.lat) * Math.PI / 180;
    const deltaLambda = (b.lng - a.lng) * Math.PI / 180;
    const sinPhi = Math.sin(deltaPhi / 2);
    const sinLambda = Math.sin(deltaLambda / 2);
    const h = sinPhi * sinPhi + Math.cos(phi1) * Math.cos(phi2) * sinLambda * sinLambda;
    return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function bboxCenter([west, south, east, north]: Bbox): { lat: number; lng: number } {
    return { lat: (south + north) / 2, lng: (west + east) / 2 };
}

function sampledTimes(
    from: string,
    to: string,
    stepSeconds: number,
    maxSamples: number | null,
): { times: string[]; truncated: boolean; nextSampleAt: string | null } {
    const startMs = new Date(from).getTime();
    const endMs = new Date(to).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
        throw new Error('satellite overpass query requires valid from <= to');
    }
    if (startMs === endMs) {
        return { times: [new Date(startMs).toISOString()], truncated: false, nextSampleAt: null };
    }

    const requestedStepMs = Math.max(1, Math.trunc(stepSeconds)) * 1000;
    const sampleLimit = maxSamples === null ? null : Math.max(1, Math.trunc(maxSamples));
    const times: string[] = [];
    let truncated = false;
    let nextSampleAt: string | null = null;

    for (let cursor = startMs; cursor <= endMs; cursor += requestedStepMs) {
        if (sampleLimit !== null && times.length >= sampleLimit) {
            truncated = true;
            nextSampleAt = new Date(cursor).toISOString();
            break;
        }
        times.push(new Date(cursor).toISOString());
    }

    const endIso = new Date(endMs).toISOString();
    if (!truncated && times[times.length - 1] !== endIso) {
        if (sampleLimit !== null && times.length >= sampleLimit) {
            truncated = true;
            nextSampleAt = endIso;
        } else {
            times.push(endIso);
        }
    }

    return { times, truncated, nextSampleAt };
}

function geometryFromInput(input: Record<string, any>) {
    const type = String(input.type || '').toLowerCase();
    if (input.geojson && typeof input.geojson === 'object') return input.geojson;
    const bbox = parseBboxLike(input.bbox);
    if (bbox) return bboxPolygon(bbox);
    if (type === 'circle') {
        const lat = Number(input.lat ?? input.latitude);
        const lng = Number(input.lng ?? input.lon ?? input.longitude);
        const radiusM = Number(input.radius_m ?? input.radiusM ?? input.radius);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusM) || radiusM <= 0) {
            throw new Error('circle AOI requires lat, lng and radius_m');
        }
        const delta = pointDistanceMetersToDegrees(radiusM);
        return bboxPolygon([lng - delta, lat - delta, lng + delta, lat + delta]);
    }
    if (type === 'line' || type === 'corridor') {
        const coordinates = Array.isArray(input.coordinates) ? input.coordinates : null;
        if (!coordinates || coordinates.length < 2) throw new Error('line AOI requires at least two coordinates');
        return { type: 'LineString', coordinates };
    }
    throw new Error('AOI requires bbox, geojson, circle or line input');
}

function normalizeKind(kind: unknown): 'entities' | 'events' | 'assets' {
    const value = String(kind || '').toLowerCase();
    if (value === 'entity' || value === 'entities') return 'entities';
    if (value === 'event' || value === 'events') return 'events';
    if (value === 'asset' || value === 'assets') return 'assets';
    throw new Error('kind must be entities, events or assets');
}

function timeBucketSql(value: unknown, expression: string): string | null {
    const groupBy = String(value || '').toLowerCase();
    if (groupBy === 'hour') return `date_trunc('hour', ${expression})::text`;
    if (groupBy === 'day') return `date_trunc('day', ${expression})::text`;
    return null;
}

function offsetSqlPlaceholders(sql: string, offset: number): string {
    if (offset <= 0) return sql;
    // Current callers pass generated SELECT fragments without dollar-quoted
    // bodies. If that changes, replace this with SQL-token-aware rewriting.
    return sql.replace(/\$(\d+)/g, (_match, value) => `$${Number(value) + offset}`);
}

const SELECTION_LAYER_ALIASES: Record<string, string> = {
    aircraft: 'aircraft',
    aviation: 'aircraft',
    plane: 'aircraft',
    planes: 'aircraft',
    vessel: 'vessel',
    vessels: 'vessel',
    maritime: 'vessel',
    ships: 'vessel',
    ais: 'vessel',
    satellite: 'satellite',
    satellites: 'satellite',
    dark_vessel: 'dark-vessel',
    dark_vessels: 'dark-vessel',
    'dark-vessels': 'dark-vessel',
    darkvessel: 'dark-vessel',
    'dark-vessel': 'dark-vessel',
    outage: 'outage',
    outages: 'outage',
    fire: 'fire',
    fires: 'fire',
    conflict: 'conflict',
    conflicts: 'conflict',
    disaster: 'disasters',
    disasters: 'disasters',
    jamming: 'jamming',
    gps_jamming: 'jamming',
    gpsjam: 'jamming',
    gfw: 'gfw',
    fishing: 'gfw',
    airspace: 'airspace',
    cable: 'cable',
    cables: 'cable',
    pipeline: 'pipeline',
    pipelines: 'pipeline',
    border: 'border',
    borders: 'border',
    infrastructure: 'infrastructure',
    webcam: 'webcam',
    webcams: 'webcam',
    traffic: 'traffic',
    power: 'power',
};

function normalizeSelectionLayerId(value: unknown): string {
    const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
    return SELECTION_LAYER_ALIASES[key] || key;
}

function predicateTextValues(predicate: Record<string, any>, keys: string[]): string[] {
    const values: string[] = [];
    for (const key of keys) {
        const value = predicate[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                const text = String(item || '').trim();
                if (text) values.push(text);
            }
        } else if (value !== undefined && value !== null && value !== '') {
            const text = String(value).trim();
            if (text) values.push(text);
        }
    }
    return Array.from(new Set(values));
}

function validateSelectionPredicateKeys(predicate: Record<string, any>) {
    const supported = new Set([
        'at',
        'asset_kind',
        'asset_kind_in',
        'assetKind',
        'assetKindIn',
        'asset_ids',
        'assetIds',
        'bbox',
        'bbox_order',
        'bboxOrder',
        'end',
        'entity_ids',
        'entityIds',
        'entity_kind',
        'entity_kind_in',
        'entityKind',
        'entityKindIn',
        'event_ids',
        'eventIds',
        'event_kind',
        'event_kind_in',
        'eventKind',
        'eventKindIn',
        'from',
        'geometry_ref',
        'historical',
        'history_mode',
        'ids',
        'kind',
        'label',
        'layer',
        'layer_id',
        'layerId',
        'object_kind',
        'objectKind',
        'observed_from',
        'observedFrom',
        'observed_to',
        'observedTo',
        'observed_at',
        'observedAt',
        'source_id',
        'source_ids',
        'sourceId',
        'sourceIds',
        'sources',
        'start',
        'subtype',
        'subtype_in',
        'subtypeIn',
        'subtypes',
        'time',
        'to',
        'ttl_seconds',
        'ttlSeconds',
        'time_window',
        'timeWindow',
    ]);
    const unsupported = Object.keys(predicate).filter((key) => !supported.has(key));
    if (unsupported.length > 0) {
        const err = new Error(
            `Selection materialization predicate contains unsupported filter keys: ${unsupported.sort().join(', ')}`,
        ) as Error & { status?: number; code?: string };
        err.status = 400;
        err.code = 'BAD_SELECTION_PREDICATE';
        throw err;
    }
}

const ENTITY_SELECTION_LAYERS = new Set(['aircraft', 'vessel', 'satellite', 'dark-vessel']);
const EVENT_SELECTION_LAYERS = new Set(['outage', 'fire', 'conflict', 'disasters', 'jamming', 'gfw']);
const ASSET_SELECTION_LAYERS = new Set(['airspace', 'cable', 'pipeline', 'border', 'infrastructure', 'webcam', 'traffic', 'power']);

function inferSelectionKind(layer: string | null | undefined, predicate: Record<string, any>): 'entity' | 'event' | 'asset' | null {
    const explicit = String(predicate.object_kind || predicate.kind || '').toLowerCase();
    if (explicit === 'entity' || explicit === 'entities') return 'entity';
    if (explicit === 'event' || explicit === 'events') return 'event';
    if (explicit === 'asset' || explicit === 'assets') return 'asset';
    const normalizedLayer = normalizeSelectionLayerId(layer || predicate.layer || predicate.layer_id);
    if (ENTITY_SELECTION_LAYERS.has(normalizedLayer)) return 'entity';
    if (EVENT_SELECTION_LAYERS.has(normalizedLayer)) return 'event';
    if (ASSET_SELECTION_LAYERS.has(normalizedLayer)) return 'asset';
    return null;
}

export class AgentToolService {
    constructor(
        private readonly database: DatabaseService,
        private readonly catalogReadService: CatalogReadService,
        private readonly selectionRepository: SelectionRepository,
        private readonly viewControlService: ViewControlService,
        private readonly replayQueryService: ReplayQueryService,
    ) {}

    async describeCatalog(input: Record<string, any>) {
        const layerId = String(input.layer || input.layer_id || '').trim();
        const sourceId = String(input.source || input.source_id || '').trim();
        if (!layerId && !sourceId) throw new Error('catalog.describe requires layer or source');

        const layer = layerId ? await this.catalogReadService.getLayer(layerId) : null;
        const source = sourceId ? await this.catalogReadService.getSource(sourceId) : null;
        if (layerId && !layer) throw new Error(`Layer not found: ${layerId}`);
        if (sourceId && !source) throw new Error(`Source not found: ${sourceId}`);

        let fields: any[] = [];
        let relations: any[] = [];
        let layerSources: any[] = [];
        if (this.database.isReady() && layer) {
            const [fieldRows, relationRows, sourceRows] = await Promise.all([
                this.database.query(
                    `SELECT field_key, field_type, semantic_tags, filterable, aggregatable, nullable, metadata
                     FROM catalog.layer_fields WHERE layer_id = $1 ORDER BY field_key`,
                    [layer.layer_id],
                ),
                this.database.query(
                    `SELECT layer_relation_id, from_layer_id, to_layer_id, relation_type, config
                     FROM catalog.layer_relations
                     WHERE from_layer_id = $1 OR to_layer_id = $1
                     ORDER BY relation_type, layer_relation_id`,
                    [layer.layer_id],
                ),
                this.database.query(
                    `SELECT ls.layer_source_id, ls.layer_id, ls.source_id, ls.binding_kind, ls.priority, ls.config,
                            s.display_name, s.provider_kind, s.status
                     FROM catalog.layer_sources ls
                     JOIN catalog.sources s ON s.source_id = ls.source_id
                     WHERE ls.layer_id = $1
                     ORDER BY ls.priority, ls.source_id`,
                    [layer.layer_id],
                ),
            ]);
            fields = fieldRows?.rows || [];
            relations = relationRows?.rows || [];
            layerSources = sourceRows?.rows || [];
        }

        return {
            layer,
            source,
            fields,
            relations,
            layer_sources: layerSources,
            limitations: {
                details_on_demand: Boolean((layer as any)?.capabilities?.detailsOnDemand),
                replay: Boolean((layer as any)?.capabilities?.replay),
                history_mode: (layer as any)?.history_mode || null,
                coverage_scope: (layer as any)?.coverage_scope || null,
            },
        };
    }

    async resolveRegion(input: Record<string, any>) {
        const query = String(input.query || input.name || '').trim().toLowerCase();
        const limitInput = parsePositiveIntOrDefault(input.limit, 10, 'region.resolve limit');
        const limit = limitInput.value;
        if (!query) throw new Error('region.resolve requires query');

        const hardcoded = REGION_GAZETTEER
            .filter((region) => (
                region.display_name.toLowerCase().includes(query)
                || region.aliases.some((alias) => alias.toLowerCase().includes(query) || query.includes(alias.toLowerCase()))
            ))
            .map((region) => ({ ...region, source: 'built_in_gazetteer' }));

        let dbRegions: any[] = [];
        if (this.database.isReady()) {
            const result = await this.database.query(
                `SELECT region_id, region_kind, slug, display_name,
                        ST_Y(ST_PointOnSurface(geom)) AS lat,
                        ST_X(ST_PointOnSurface(geom)) AS lng,
                        ARRAY[
                            ST_YMin(Box2D(geom))::float8,
                            ST_XMin(Box2D(geom))::float8,
                            ST_YMax(Box2D(geom))::float8,
                            ST_XMax(Box2D(geom))::float8
                        ] AS bbox,
                        properties
                 FROM core.regions
                 WHERE lower(display_name) LIKE $1 ESCAPE '\\'
                    OR lower(COALESCE(slug, '')) LIKE $1 ESCAPE '\\'
                 ORDER BY display_name
                 LIMIT $2`,
                [sqlLike(query), limit + 1],
            );
            dbRegions = (result?.rows || []).map((row: any) => ({
                region_id: row.region_id,
                display_name: row.display_name,
                region_kind: row.region_kind,
                slug: row.slug,
                bbox: row.bbox,
                center: { lat: Number(row.lat), lng: Number(row.lng) },
                properties: row.properties,
                source: 'core.regions',
            }));
        }

        const matches = [...hardcoded, ...dbRegions].slice(0, limit);
        const hasMore = hardcoded.length + dbRegions.length > matches.length;
        return {
            query,
            count: matches.length,
            matches,
            pagination: {
                limit,
                defaulted: limitInput.defaulted,
                capped: false,
                returned: matches.length,
                has_more: hasMore,
            },
        };
    }

    async resolveEntity(input: Record<string, any>) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        const query = String(input.query || input.entity || '').trim();
        const layer = String(input.layer || '').trim();
        const limitInput = parsePositiveIntOrDefault(input.limit, 10, 'entity.resolve limit');
        const limit = limitInput.value;
        if (!query) throw new Error('entity.resolve requires query');

        const params: unknown[] = [sqlLike(query.toLowerCase()), limit + 1];
        const layerSql = layer ? 'AND e.layer_id = $3' : '';
        if (layer) params.push(layer);
        const result = await this.database.query(
            `SELECT DISTINCT ON (e.entity_id)
                    e.entity_id, e.layer_id, e.source_id, e.entity_kind, e.subtype, e.display_name,
                    e.first_observed_at, e.last_observed_at,
                    a.alias_type, a.alias_value,
                    p.observed_at AS latest_position_at,
                    CASE WHEN p.geom IS NOT NULL THEN ST_Y(p.geom) ELSE NULL END AS lat,
                    CASE WHEN p.geom IS NOT NULL THEN ST_X(p.geom) ELSE NULL END AS lng
             FROM core.entities e
             LEFT JOIN core.entity_aliases a ON a.entity_id = e.entity_id
             LEFT JOIN app.entity_live_states p ON p.entity_id = e.entity_id
             WHERE (
                    lower(e.entity_id) LIKE $1 ESCAPE '\\'
                 OR lower(COALESCE(e.display_name, '')) LIKE $1 ESCAPE '\\'
                 OR lower(COALESCE(a.alias_value, '')) LIKE $1 ESCAPE '\\'
             )
             ${layerSql}
             ORDER BY e.entity_id, (lower(e.entity_id) = lower($1)) DESC, e.updated_at DESC
             LIMIT $2`,
            params,
        );

        const rows = result?.rows || [];
        const matches = rows.slice(0, limit);
        return {
            query,
            layer: layer || null,
            count: matches.length,
            matches,
            pagination: {
                limit,
                defaulted: limitInput.defaulted,
                capped: false,
                returned: matches.length,
                has_more: rows.length > matches.length,
            },
        };
    }

    async createAoi(input: Record<string, any>) {
        const geometry = geometryFromInput(input);
        const label = String(input.label || input.name || 'Agent AOI').trim();
        const ttlSeconds = parsePositiveIntOrDefault(input.ttl_seconds ?? input.ttlSeconds, 24 * 60 * 60, 'AOI ttl_seconds').value;
        const suffix = crypto.createHash('sha1').update(JSON.stringify({ geometry, label, now: Date.now() })).digest('hex').slice(0, 12);
        const selectionId = String(input.geometry_ref || input.selection_id || `aoi:${suffix}`);
        const selection = await this.selectionRepository.saveSelection({
            selectionId,
            layerId: typeof input.layer === 'string' ? normalizeSelectionLayerId(input.layer) : null,
            selectionMode: 'aoi',
            predicate: {
                geometry_ref: selectionId,
                label,
                ttl_seconds: ttlSeconds,
            },
            geometryJson: geometry,
            metadata: {
                label,
                createdBy: 'agent',
                expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
                ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
            },
        });
        return {
            geometry_ref: selection.selection_id,
            selection_id: selection.selection_id,
            geometry: selection.geometry_json,
            metadata: selection.metadata,
        };
    }

    async aggregate(input: Record<string, any>) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        const kind = normalizeKind(input.kind);
        const layer = String(input.layer || '').trim();
        const from = parseIso(input.from);
        const to = parseIso(input.to);
        const bbox = parseQueryBbox(input.bbox, input.bbox_order || input.bboxOrder);
        const groupBy = String(input.group_by || input.groupBy || 'layer').toLowerCase();
        const limitInput = parsePositiveIntOrDefault(input.limit, 200, 'query.aggregate limit');
        const limit = limitInput.value;
        const queryLimit = limit + 1;
        const params: unknown[] = [];
        const clauses: string[] = [];
        const add = (sql: string, value: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };
        const addBbox = (geomExpr: string, box: Bbox) => {
            const [west, south, east, north] = box;
            params.push(west, south, east, north);
            const idx = params.length - 3;
            clauses.push(`${geomExpr} IS NOT NULL AND ST_Intersects(${geomExpr}, ST_MakeEnvelope($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, 4326))`);
        };

        let sql = '';
        if (kind === 'entities') {
            if (layer) add('pf.layer_id = ?', layer);
            if (from) add('pf.observed_at >= ?::timestamptz', from);
            if (to) add('pf.observed_at <= ?::timestamptz', to);
            if (bbox) addBbox('pf.geom', bbox);
            const bucket = timeBucketSql(groupBy, 'pf.observed_at');
            const groupExpr = bucket || (groupBy === 'source' ? 'COALESCE(pf.source_id, e.source_id)' : groupBy === 'subtype' ? 'COALESCE(e.subtype, pf.layer_id)' : 'pf.layer_id');
            sql = `SELECT ${groupExpr} AS bucket, COUNT(*)::bigint AS fixes, COUNT(DISTINCT pf.entity_id)::bigint AS entities,
                          MIN(pf.observed_at) AS min_time, MAX(pf.observed_at) AS max_time
                   FROM core.position_fixes pf
                   JOIN core.entities e ON e.entity_id = pf.entity_id
                   ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                   GROUP BY bucket
                   ORDER BY fixes DESC
                   LIMIT ${queryLimit}`;
        } else if (kind === 'events') {
            if (layer) add('e.layer_id = ?', layer);
            if (from) add('COALESCE(e.observed_at, e.valid_from, e.created_at) >= ?::timestamptz', from);
            if (to) add('COALESCE(e.observed_at, e.valid_from, e.created_at) <= ?::timestamptz', to);
            if (bbox) addBbox('e.geom', bbox);
            const timeExpr = 'COALESCE(e.observed_at, e.valid_from, e.created_at)';
            const bucket = timeBucketSql(groupBy, timeExpr);
            const groupExpr = bucket || (groupBy === 'source' ? 'e.source_id' : groupBy === 'subtype' ? 'COALESCE(e.subtype, e.event_kind)' : 'e.layer_id');
            sql = `SELECT ${groupExpr} AS bucket, COUNT(*)::bigint AS events,
                          MIN(${timeExpr}) AS min_time, MAX(${timeExpr}) AS max_time
                   FROM core.events e
                   ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                   GROUP BY bucket
                   ORDER BY events DESC
                   LIMIT ${queryLimit}`;
        } else {
            if (layer) add('a.layer_id = ?', layer);
            if (bbox) addBbox('a.geom', bbox);
            const groupExpr = groupBy === 'source' ? 'a.source_id' : groupBy === 'subtype' ? 'COALESCE(a.subtype, a.asset_kind)' : 'a.layer_id';
            sql = `SELECT ${groupExpr} AS bucket, COUNT(*)::bigint AS assets,
                          MIN(COALESCE(a.last_observed_at, a.updated_at, a.created_at)) AS min_time,
                          MAX(COALESCE(a.last_observed_at, a.updated_at, a.created_at)) AS max_time
                   FROM core.assets a
                   ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                   GROUP BY bucket
                   ORDER BY assets DESC
                   LIMIT ${queryLimit}`;
        }

        const result = await this.database.query(sql, params);
        const allRows = result?.rows || [];
        const rows = allRows.slice(0, limit);
        const hasMore = allRows.length > rows.length;
        return {
            kind,
            layer: layer || null,
            group_by: groupBy,
            count: rows.length,
            rows,
            pagination: {
                limit,
                defaulted: limitInput.defaulted,
                capped: false,
                returned: rows.length,
                has_more: hasMore,
            },
            query_status: {
                status: rows.length === 0 ? 'empty' : hasMore ? 'partial' : 'ok',
                complete: !hasMore,
                reason: rows.length === 0 ? 'empty_result' : hasMore ? 'page_has_more' : 'aggregated',
            },
        };
    }

    async corridorSearch(input: Record<string, any>) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        const kind = normalizeKind(input.kind);
        const layer = String(input.layer || '').trim();
        const radiusM = Number(input.radius_m ?? input.radiusM ?? 5000);
        const limitInput = parsePositiveIntOrDefault(input.limit, 100, 'geo.corridor limit');
        const limit = limitInput.value;
        const queryLimit = limit + 1;
        const from = parseIso(input.from);
        const to = parseIso(input.to);
        const line = geometryFromInput({ ...input, type: 'line' });
        if (line.type !== 'LineString') throw new Error('corridor search requires line geometry');
        if (!Number.isFinite(radiusM) || radiusM <= 0) throw new Error('corridor search requires positive radius_m');

        const params: unknown[] = [JSON.stringify(line), radiusM];
        const clauses: string[] = [];
        const add = (sql: string, value: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };
        if (layer) add('layer_id = ?', layer);

        let sql = '';
        if (kind === 'entities') {
            if (from) add('observed_at >= ?::timestamptz', from);
            if (to) add('observed_at <= ?::timestamptz', to);
            sql = `SELECT entity_id AS id, layer_id, source_id, observed_at,
                          ST_Y(geom) AS lat, ST_X(geom) AS lng,
                          ST_Distance(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) AS distance_m,
                          properties
                   FROM core.position_fixes
                   WHERE geom IS NOT NULL
                     AND ST_DWithin(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)
                     ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
                   ORDER BY distance_m ASC, observed_at DESC
                   LIMIT ${queryLimit}`;
        } else if (kind === 'events') {
            if (from) add('COALESCE(observed_at, valid_from, created_at) >= ?::timestamptz', from);
            if (to) add('COALESCE(observed_at, valid_from, created_at) <= ?::timestamptz', to);
            sql = `SELECT event_id AS id, layer_id, source_id, event_kind AS kind, subtype,
                          COALESCE(observed_at, valid_from, created_at) AS observed_at,
                          ST_Y(ST_PointOnSurface(geom)) AS lat, ST_X(ST_PointOnSurface(geom)) AS lng,
                          ST_Distance(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) AS distance_m,
                          properties
                   FROM core.events
                   WHERE geom IS NOT NULL
                     AND ST_DWithin(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)
                     ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
                   ORDER BY distance_m ASC, observed_at DESC NULLS LAST
                   LIMIT ${queryLimit}`;
        } else {
            sql = `SELECT asset_id AS id, layer_id, source_id, asset_kind AS kind, subtype, display_name,
                          ST_Y(ST_PointOnSurface(geom)) AS lat, ST_X(ST_PointOnSurface(geom)) AS lng,
                          ST_Distance(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) AS distance_m,
                          properties
                   FROM core.assets
                   WHERE geom IS NOT NULL
                     AND ST_DWithin(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)
                     ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
                   ORDER BY distance_m ASC
                   LIMIT ${queryLimit}`;
        }
        const result = await this.database.query(sql, params);
        const allItems = result?.rows || [];
        const items = allItems.slice(0, limit);
        const hasMore = allItems.length > items.length;
        return {
            kind,
            layer: layer || null,
            radius_m: radiusM,
            count: items.length,
            items,
            pagination: {
                limit,
                defaulted: limitInput.defaulted,
                capped: false,
                returned: items.length,
                has_more: hasMore,
            },
            query_status: {
                status: items.length === 0 ? 'empty' : hasMore ? 'partial' : 'ok',
                complete: !hasMore,
                reason: items.length === 0 ? 'empty_result' : hasMore ? 'page_has_more' : 'corridor_matched',
            },
        };
    }

    async timeline(input: Record<string, any>) {
        const groupBy = String(input.group_by || input.groupBy || 'hour').toLowerCase();
        if (!['hour', 'day'].includes(groupBy)) throw new Error('query.timeline supports group_by hour or day');
        const limitDefaulted = !hasValue(input.limit);
        const data = await this.aggregate({
            ...input,
            group_by: groupBy,
            limit: limitDefaulted ? 500 : input.limit,
        });
        return {
            ...data,
            mode: 'timeline',
            bucket: groupBy,
            pagination: data.pagination ? { ...data.pagination, defaulted: limitDefaulted } : data.pagination,
            query_status: {
                status: data.count === 0 ? 'empty' : data.pagination?.has_more ? 'partial' : 'ok',
                complete: !data.pagination?.has_more,
                reason: data.count === 0 ? 'empty_result' : data.pagination?.has_more ? 'page_has_more' : 'aggregated',
            },
            warnings: data.count === 0 ? ['No timeline buckets matched these filters in local OpenSpy storage.'] : [],
        };
    }

    async related(input: Record<string, any>) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        const id = String(input.entity_id || input.entityId || input.event_id || input.eventId || input.asset_id || input.assetId || input.id || '').trim();
        if (!id) throw new Error('query.related requires entity_id, event_id, asset_id or id');
        const radiusM = Number(input.radius_m ?? input.radiusM ?? 50_000);
        if (!Number.isFinite(radiusM) || radiusM <= 0) throw new Error('query.related requires positive radius_m');
        const limitInput = parsePositiveIntOrDefault(input.limit, 25, 'query.related limit');
        const limit = limitInput.value;
        const queryLimit = limit + 1;
        const anchor = await this.resolveAnchorGeometry(id);
        if (!anchor) throw new Error(`Related anchor not found or has no geometry: ${id}`);

        const params: unknown[] = [anchor.geojson, radiusM, queryLimit];
        const [events, assets, entities] = await Promise.all([
            this.database.query(
                `SELECT event_id AS id, layer_id, source_id, event_kind AS kind, subtype,
                        COALESCE(observed_at, valid_from, created_at) AS observed_at,
                        ST_Y(ST_PointOnSurface(geom)) AS lat,
                        ST_X(ST_PointOnSurface(geom)) AS lng,
                        ST_Distance(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) AS distance_m,
                        properties
                 FROM core.events
                 WHERE geom IS NOT NULL
                   AND event_id <> $4
                   AND ST_DWithin(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)
                 ORDER BY distance_m ASC, observed_at DESC NULLS LAST
                 LIMIT $3`,
                [...params, id],
            ),
            this.database.query(
                `SELECT asset_id AS id, layer_id, source_id, asset_kind AS kind, subtype, display_name,
                        ST_Y(ST_PointOnSurface(geom)) AS lat,
                        ST_X(ST_PointOnSurface(geom)) AS lng,
                        ST_Distance(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) AS distance_m,
                        properties
                 FROM core.assets
                 WHERE geom IS NOT NULL
                   AND asset_id <> $4
                   AND ST_DWithin(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)
                 ORDER BY distance_m ASC
                 LIMIT $3`,
                [...params, id],
            ),
            this.database.query(
                `SELECT ls.entity_id AS id, ls.layer_id, ls.source_id, e.entity_kind AS kind, e.subtype, e.display_name,
                        ls.observed_at,
                        ST_Y(ls.geom) AS lat,
                        ST_X(ls.geom) AS lng,
                        ST_Distance(ls.geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) AS distance_m,
                        COALESCE(ls.properties, e.properties) AS properties
                 FROM app.entity_live_states ls
                 LEFT JOIN core.entities e ON e.entity_id = ls.entity_id
                 WHERE ls.geom IS NOT NULL
                   AND ls.entity_id <> $4
                   AND ST_DWithin(ls.geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)
                 ORDER BY distance_m ASC, ls.observed_at DESC NULLS LAST
                 LIMIT $3`,
                [...params, id],
            ),
        ]);
        const eventRows = events?.rows || [];
        const assetRows = assets?.rows || [];
        const entityRows = entities?.rows || [];
        const eventItems = eventRows.slice(0, limit);
        const assetItems = assetRows.slice(0, limit);
        const entityItems = entityRows.slice(0, limit);
        const hasMore = eventRows.length > eventItems.length
            || assetRows.length > assetItems.length
            || entityRows.length > entityItems.length;
        return {
            anchor,
            radius_m: radiusM,
            counts: {
                events: eventItems.length,
                assets: assetItems.length,
                entities: entityItems.length,
            },
            items: {
                events: eventItems,
                assets: assetItems,
                entities: entityItems,
            },
            pagination: {
                limit_per_collection: limit,
                defaulted: limitInput.defaulted,
                capped: false,
                returned: {
                    events: eventItems.length,
                    assets: assetItems.length,
                    entities: entityItems.length,
                },
                has_more: hasMore,
            },
            query_status: {
                status: (eventItems.length || assetItems.length || entityItems.length) ? hasMore ? 'partial' : 'ok' : 'empty',
                complete: !hasMore,
                reason: (eventItems.length || assetItems.length || entityItems.length) ? hasMore ? 'page_has_more' : 'related_found' : 'empty_result',
            },
        };
    }

    async satelliteOverpasses(input: Record<string, any>) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        if (!this.replayQueryService.isReady()) throw new Error('Replay query service is not ready');

        const directBbox = parseQueryBbox(input.bbox, input.bbox_order || input.bboxOrder);
        const lat = Number(input.lat ?? input.latitude);
        const lng = Number(input.lng ?? input.lon ?? input.longitude);
        const radiusM = Number(input.radius_m ?? input.radiusM ?? input.radius);
        const radiusBbox = Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusM) && radiusM > 0
            ? (() => {
                const delta = pointDistanceMetersToDegrees(radiusM);
                return parseBboxLike([lng - delta, lat - delta, lng + delta, lat + delta]);
            })()
            : null;
        const bbox = directBbox || radiusBbox;
        if (!bbox) {
            throw new Error('query.satellite-overpasses requires bbox=west,south,east,north or lat,lng,radius_m');
        }

        const at = parseIso(input.at || input.time);
        const from = parseIso(input.from) || at;
        const to = parseIso(input.to) || at || from;
        if (!from || !to) throw new Error('query.satellite-overpasses requires from/to or at');

        const stepSecondsInput = parsePositiveIntOrDefault(input.step_seconds ?? input.stepSeconds, 180, 'query.satellite-overpasses step_seconds');
        const rawMaxSamples = input.max_samples ?? input.maxSamples;
        const maxSamplesInput = hasValue(rawMaxSamples)
            ? parsePositiveIntOrDefault(rawMaxSamples, 1, 'query.satellite-overpasses max_samples')
            : null;
        const limitInput = parsePositiveIntOrDefault(input.limit, 20, 'query.satellite-overpasses limit');
        const samplesPerObjectInput = parsePositiveIntOrDefault(input.samples_per_object ?? input.samplesPerObject, 3, 'query.satellite-overpasses samples_per_object');
        const stepSeconds = stepSecondsInput.value;
        const maxSamples = maxSamplesInput?.value ?? null;
        const limit = limitInput.value;
        const samplesPerObject = samplesPerObjectInput.value;
        const entityKind = String(input.entity_kind || input.entityKind || '').trim() || undefined;
        const subtype = String(input.subtype || '').trim() || undefined;
        const samplingPlan = sampledTimes(from, to, stepSeconds, maxSamples);
        const sampleTimes = samplingPlan.times;
        const center = bboxCenter(bbox);

        type GroupedOverpass = {
            entity_id: string;
            layer_id: string;
            source_id: string | null;
            entity_kind: string;
            subtype: string | null;
            display_name: string | null;
            first_seen_at: string | null;
            last_seen_at: string | null;
            orbital_observed_at: string | null;
            sample_count: number;
            min_center_distance_m: number;
            max_altitude_m: number | null;
            samples: Array<{
                at: string;
                lat: number;
                lng: number;
                altitude_m: number | null;
                center_distance_m: number;
                orbital_observed_at: string | null;
            }>;
        };

        const grouped = new Map<string, GroupedOverpass>();
        for (const sampleAt of sampleTimes) {
            const rows = await this.replayQueryService.listEntityStateAt({
                at: sampleAt,
                layerId: 'satellite',
                entityKind,
                subtype,
                bbox,
            });
            for (const row of rows) {
                const rowLat = Number(row.display_lat);
                const rowLng = Number(row.display_lng);
                if (!Number.isFinite(rowLat) || !Number.isFinite(rowLng)) continue;
                const distanceM = haversineMeters(center, { lat: rowLat, lng: rowLng });
                const orbitalObservedAt = row.position_properties?.orbital_observed_at || null;
                const existing = grouped.get(row.entity_id);
                const sample = {
                    at: sampleAt,
                    lat: rowLat,
                    lng: rowLng,
                    altitude_m: Number.isFinite(Number(row.altitude_m)) ? Number(row.altitude_m) : null,
                    center_distance_m: Math.round(distanceM),
                    orbital_observed_at: orbitalObservedAt,
                };
                if (!existing) {
                    grouped.set(row.entity_id, {
                        entity_id: row.entity_id,
                        layer_id: row.layer_id,
                        source_id: row.source_id,
                        entity_kind: row.entity_kind,
                        subtype: row.subtype,
                        display_name: row.display_name,
                        first_seen_at: row.first_observed_at,
                        last_seen_at: row.last_observed_at,
                        orbital_observed_at: orbitalObservedAt,
                        sample_count: 1,
                        min_center_distance_m: Math.round(distanceM),
                        max_altitude_m: sample.altitude_m,
                        samples: [sample],
                    });
                    continue;
                }
                existing.sample_count += 1;
                existing.min_center_distance_m = Math.min(existing.min_center_distance_m, Math.round(distanceM));
                if (sample.altitude_m !== null) {
                    existing.max_altitude_m = existing.max_altitude_m === null
                        ? sample.altitude_m
                        : Math.max(existing.max_altitude_m, sample.altitude_m);
                }
                if (existing.samples.length < samplesPerObject) existing.samples.push(sample);
            }
        }

        const overpasses = Array.from(grouped.values())
            .sort((left, right) => {
                const sampleDelta = right.sample_count - left.sample_count;
                if (sampleDelta !== 0) return sampleDelta;
                const distanceDelta = left.min_center_distance_m - right.min_center_distance_m;
                if (distanceDelta !== 0) return distanceDelta;
                return left.entity_id.localeCompare(right.entity_id);
            })
            .slice(0, limit);

        const hasMoreResults = grouped.size > overpasses.length;
        const complete = !samplingPlan.truncated && !hasMoreResults;
        const status = samplingPlan.truncated
            ? 'partial'
            : overpasses.length === 0
                ? 'empty'
                : hasMoreResults
                    ? 'partial'
                    : 'ok';
        const warnings = overpasses.length === 0
            ? [
                samplingPlan.truncated
                    ? 'No propagated satellite ground-track samples crossed this AOI in the sampled portion before the explicit max_samples cutoff.'
                    : 'No propagated satellite ground-track samples crossed this AOI in local OpenSpy TLE storage for the requested window.',
            ]
            : [
                'This is a possible-overpass screen from sampled TLE ground tracks. It is not sensor-specific visibility and does not prove imagery was collected.',
            ];
        if (samplingPlan.truncated) {
            warnings.push('Sampling stopped at the explicitly requested max_samples before covering the full requested window.');
        }

        return {
            mode: 'satellite_overpass',
            status,
            semantics: {
                basis: 'sampled propagated TLE ground-track positions from local OpenSpy orbital elements',
                limitation: 'Possible-overpass screen only: not sensor-specific field-of-view, tasking, cloud cover, downlink, image availability or collection proof.',
                replay_source: 'core.orbital_elements',
            },
            filters: {
                bbox,
                bbox_order: 'west,south,east,north',
                from,
                to,
                step_seconds_requested: stepSeconds,
                step_seconds_defaulted: stepSecondsInput.defaulted,
                max_samples: maxSamples,
                max_samples_explicit: maxSamples !== null,
                entity_kind: entityKind || null,
                subtype: subtype || null,
                limit,
                samples_per_object: samplesPerObject,
            },
            sampling: {
                samples_requested: maxSamples,
                samples_used: sampleTimes.length,
                sample_times: sampleTimes,
                truncated: samplingPlan.truncated,
                complete: !samplingPlan.truncated,
                next_sample_at: samplingPlan.nextSampleAt,
                step_seconds: stepSeconds,
                step_seconds_defaulted: stepSecondsInput.defaulted,
                max_samples: maxSamples,
                max_samples_explicit: maxSamples !== null,
            },
            coverage: {
                returned_count: overpasses.length,
                total_candidate_entities: grouped.size,
                complete,
                basis: 'sampled_window',
            },
            metadata: {
                sampling: {
                    step_seconds: stepSeconds,
                    step_seconds_defaulted: stepSecondsInput.defaulted,
                    max_samples: maxSamples,
                    max_samples_explicit: maxSamples !== null,
                    samples_used: sampleTimes.length,
                    truncated: samplingPlan.truncated,
                    next_sample_at: samplingPlan.nextSampleAt,
                },
                result_limit: {
                    limit,
                    defaulted: limitInput.defaulted,
                    capped: false,
                },
            },
            pagination: {
                limit,
                defaulted: limitInput.defaulted,
                capped: false,
                returned: overpasses.length,
                has_more: hasMoreResults,
            },
            query_status: {
                status,
                complete,
                reason: samplingPlan.truncated
                    ? 'max_samples_reached'
                    : overpasses.length === 0
                        ? 'empty_result'
                        : hasMoreResults
                            ? 'page_has_more'
                            : 'sampled_window',
            },
            count: overpasses.length,
            overpasses,
            warnings,
        };
    }

    async spatialJoin(input: Record<string, any>) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        const leftKind = normalizeKind(input.left_kind || input.leftKind || input.kind || 'events');
        const rightKind = normalizeKind(input.right_kind || input.rightKind || 'assets');
        const leftLayer = String(input.left_layer || input.leftLayer || '').trim();
        const rightLayer = String(input.right_layer || input.rightLayer || '').trim();
        const radiusM = Number(input.radius_m ?? input.radiusM ?? 10_000);
        if (!Number.isFinite(radiusM) || radiusM < 0) throw new Error('geo.spatial_join requires radius_m >= 0');
        const limitInput = parsePositiveIntOrDefault(input.limit, 100, 'geo.spatial_join limit');
        const limit = limitInput.value;
        const queryLimit = limit + 1;
        const bbox = parseBboxLike(input.bbox);
        const left = this.spatialJoinSourceSql(leftKind, 'l', leftLayer, bbox);
        const right = this.spatialJoinSourceSql(rightKind, 'r', rightLayer, bbox);
        const rightSql = offsetSqlPlaceholders(right.sql, left.params.length);
        const params = [...left.params, ...right.params, radiusM, queryLimit];
        const radiusParam = params.length - 1;
        const limitParam = params.length;
        const result = await this.database.query(
            `WITH left_rows AS (${left.sql}),
                  right_rows AS (${rightSql})
             SELECT
                l.id AS left_id,
                l.layer_id AS left_layer_id,
                l.source_id AS left_source_id,
                l.kind AS left_kind,
                l.label AS left_label,
                r.id AS right_id,
                r.layer_id AS right_layer_id,
                r.source_id AS right_source_id,
                r.kind AS right_kind,
                r.label AS right_label,
                ST_Distance(l.geom::geography, r.geom::geography) AS distance_m,
                ST_Y(ST_PointOnSurface(l.geom)) AS left_lat,
                ST_X(ST_PointOnSurface(l.geom)) AS left_lng,
                ST_Y(ST_PointOnSurface(r.geom)) AS right_lat,
                ST_X(ST_PointOnSurface(r.geom)) AS right_lng
             FROM left_rows l
             JOIN right_rows r
               ON CASE
                    WHEN $${radiusParam}::float8 = 0 THEN ST_Intersects(l.geom, r.geom)
                    ELSE ST_DWithin(l.geom::geography, r.geom::geography, $${radiusParam}::float8)
                  END
             ORDER BY distance_m ASC NULLS LAST
             LIMIT $${limitParam}`,
            params,
        );
        const allItems = result?.rows || [];
        const items = allItems.slice(0, limit);
        const hasMore = allItems.length > items.length;
        return {
            mode: 'spatial_join',
            left: { kind: leftKind, layer: leftLayer || null },
            right: { kind: rightKind, layer: rightLayer || null },
            radius_m: radiusM,
            bbox: bbox || null,
            count: items.length,
            items,
            pagination: {
                limit,
                defaulted: limitInput.defaulted,
                capped: false,
                returned: items.length,
                has_more: hasMore,
            },
            query_status: {
                status: items.length ? hasMore ? 'partial' : 'ok' : 'empty',
                complete: !hasMore,
                reason: items.length ? hasMore ? 'page_has_more' : 'joined' : 'empty_result',
            },
        };
    }

    async simplifiedGeometry(input: Record<string, any>) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        const kind = normalizeKind(input.kind || 'assets');
        if (kind === 'entities') throw new Error('geo.simplify supports events/assets geometry, not moving entity point streams');
        const layer = String(input.layer || '').trim();
        const id = String(input.id || input.asset_id || input.assetId || input.event_id || input.eventId || '').trim();
        const bbox = parseBboxLike(input.bbox);
        const toleranceM = Number(input.tolerance_m ?? input.toleranceM ?? 250);
        if (!Number.isFinite(toleranceM) || toleranceM < 0) throw new Error('geo.simplify requires tolerance_m >= 0');
        const limitInput = parsePositiveIntOrDefault(input.limit, 50, 'geo.simplify limit');
        const limit = limitInput.value;
        const queryLimit = limit + 1;
        const table = kind === 'events' ? 'core.events' : 'core.assets';
        const idColumn = kind === 'events' ? 'event_id' : 'asset_id';
        const kindColumn = kind === 'events' ? 'event_kind' : 'asset_kind';
        const params: unknown[] = [toleranceM, queryLimit];
        const clauses = ['geom IS NOT NULL'];
        if (layer) {
            params.push(layer);
            clauses.push(`layer_id = $${params.length}`);
        }
        if (id) {
            params.push(id);
            clauses.push(`${idColumn} = $${params.length}`);
        }
        if (bbox) {
            const [west, south, east, north] = bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            clauses.push(`ST_Intersects(geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`);
        }
        const result = await this.database.query(
            `SELECT ${idColumn} AS id, layer_id, source_id, ${kindColumn} AS kind, subtype,
                    ${kind === 'assets' ? 'display_name' : 'NULL'} AS label,
                    ST_AsGeoJSON(
                        ST_SimplifyPreserveTopology(
                            ${bbox ? `ST_Intersection(geom, ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, 4326))` : 'geom'},
                            ($1::float8 / 111320.0)
                        )
                    )::jsonb AS geometry,
                    ST_NPoints(geom)::int AS original_points
             FROM ${table}
             WHERE ${clauses.join(' AND ')}
             ORDER BY updated_at DESC NULLS LAST
             LIMIT $2`,
            params,
        );
        const allFeatures = result?.rows || [];
        const features = allFeatures.slice(0, limit);
        const hasMore = allFeatures.length > features.length;
        return {
            mode: 'simplified_geometry',
            kind,
            layer: layer || null,
            id: id || null,
            bbox: bbox || null,
            tolerance_m: toleranceM,
            count: features.length,
            features,
            pagination: {
                limit,
                defaulted: limitInput.defaulted,
                capped: false,
                returned: features.length,
                has_more: hasMore,
            },
            query_status: {
                status: features.length ? hasMore ? 'partial' : 'ok' : 'empty',
                complete: !hasMore,
                reason: features.length ? hasMore ? 'page_has_more' : 'simplified' : 'empty_result',
            },
        };
    }

    private async resolveAnchorGeometry(id: string): Promise<Record<string, any> | null> {
        const result = await this.database.query(
            `WITH candidates AS (
                SELECT e.entity_id AS id, e.layer_id, e.source_id, e.entity_kind AS kind, e.display_name AS label,
                       ls.geom AS geom, ls.observed_at AS observed_at
                FROM core.entities e
                JOIN app.entity_live_states ls ON ls.entity_id = e.entity_id
                WHERE e.entity_id = $1 AND ls.geom IS NOT NULL
                UNION ALL
                SELECT event_id AS id, layer_id, source_id, event_kind AS kind, NULL AS label,
                       geom, COALESCE(observed_at, valid_from, created_at) AS observed_at
                FROM core.events
                WHERE event_id = $1 AND geom IS NOT NULL
                UNION ALL
                SELECT asset_id AS id, layer_id, source_id, asset_kind AS kind, display_name AS label,
                       geom, COALESCE(last_observed_at, updated_at, created_at) AS observed_at
                FROM core.assets
                WHERE asset_id = $1 AND geom IS NOT NULL
             )
             SELECT id, layer_id, source_id, kind, label, observed_at,
                    ST_AsGeoJSON(ST_PointOnSurface(geom))::jsonb AS geojson,
                    ST_Y(ST_PointOnSurface(geom)) AS lat,
                    ST_X(ST_PointOnSurface(geom)) AS lng
             FROM candidates
             LIMIT 1`,
            [id],
        );
        return result?.rows[0] || null;
    }

    private spatialJoinSourceSql(kind: 'entities' | 'events' | 'assets', aliasPrefix: string, layer: string, bbox: Bbox | null) {
        const params: unknown[] = [];
        const clauses = ['geom IS NOT NULL'];
        if (layer) {
            params.push(layer);
            clauses.push(`layer_id = $${params.length}`);
        }
        if (bbox) {
            const [west, south, east, north] = bbox;
            params.push(west, south, east, north);
            const start = params.length - 3;
            clauses.push(`ST_Intersects(geom, ST_MakeEnvelope($${start}, $${start + 1}, $${start + 2}, $${start + 3}, 4326))`);
        }
        if (kind === 'entities') {
            return {
                params,
                sql: `SELECT entity_id AS id, layer_id, source_id, 'entity' AS kind, NULL::text AS label, geom
                      FROM app.entity_live_states
                      WHERE ${clauses.join(' AND ')}`,
            };
        }
        if (kind === 'events') {
            return {
                params,
                sql: `SELECT event_id AS id, layer_id, source_id, event_kind AS kind, NULL::text AS label, geom
                      FROM core.events
                      WHERE ${clauses.join(' AND ')}`,
            };
        }
        return {
            params,
            sql: `SELECT asset_id AS id, layer_id, source_id, asset_kind AS kind, display_name AS label, geom
                  FROM core.assets
                  WHERE ${clauses.join(' AND ')}`,
        };
    }

    async materializeSelection(selectionId: string, input: Record<string, any> = {}) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        await this.selectionRepository.cleanupExpiredSelections();
        const selection = await this.selectionRepository.getSelection(selectionId);
        if (!selection) throw new Error(`Selection not found: ${selectionId}`);

        const maxItems = parseOptionalPositiveInt(input.limit ?? selection.metadata?.maxMaterializedItems, 'selection materialization limit');
        const timeoutMs = parseOptionalPositiveInt(input.timeout_ms ?? input.timeoutMs ?? selection.metadata?.materializationTimeoutMs, 'selection materialization timeout');
        const fallbackLimit = parseOptionalPositiveInt(input.fallback_limit ?? input.fallbackLimit, 'selection materialization fallback limit');
        const fallbackTimeoutMs = parseOptionalPositiveInt(input.fallback_timeout_ms ?? input.fallbackTimeoutMs, 'selection materialization fallback timeout');
        let rows: SelectionItemPayload[] = [];
        let status: 'empty' | 'partial' | 'materialized' = 'empty';
        try {
            rows = await this.database.withTransaction(async () => {
                if (timeoutMs !== null) {
                    await this.database.query('SELECT set_config($1, $2, true)', ['statement_timeout', `${timeoutMs}ms`]);
                }
                return this.querySelectionItemsForMaterialization(selection, maxItems);
            });
            status = rows.length === 0 ? 'empty' : 'materialized';
            await this.selectionRepository.replaceSelectionItems(selection.selection_id, rows, selection.workspace_id, status);
        } catch (err: any) {
            const message = err?.message || 'Selection materialization failed';
            if (isStatementTimeout(err) && fallbackLimit !== null) {
                try {
                    rows = await this.database.withTransaction(async () => {
                        if (fallbackTimeoutMs !== null) {
                            await this.database.query('SELECT set_config($1, $2, true)', ['statement_timeout', `${fallbackTimeoutMs}ms`]);
                        }
                        return this.querySelectionItemsForMaterialization(selection, fallbackLimit);
                    });
                    status = rows.length === 0 ? 'empty' : 'partial';
                    await this.selectionRepository.replaceSelectionItems(selection.selection_id, rows, selection.workspace_id, status, message);
                    return {
                        selection_id: selection.selection_id,
                        layer: selection.layer_id,
                        materialized_count: rows.length,
                        materialization_status: status,
                        materialization_warning: rows.length > 0
                            ? 'Primary selection materialization timed out; stored the explicitly requested fallback subset.'
                            : 'Primary selection materialization timed out and the explicitly requested fallback found no matching rows.',
                        limits: {
                            requested_limit: maxItems,
                            fallback_limit: fallbackLimit,
                            timeout_ms: timeoutMs,
                            fallback_timeout_ms: fallbackTimeoutMs,
                            fallback: true,
                        },
                        items_preview: rows.slice(0, 10),
                    };
                } catch (fallbackErr: any) {
                    await this.selectionRepository.replaceSelectionItems(
                        selection.selection_id,
                        [],
                        selection.workspace_id,
                        'error',
                        fallbackErr?.message || message,
                    ).catch(() => null);
                    throw err;
                }
            }
            await this.selectionRepository.replaceSelectionItems(selection.selection_id, [], selection.workspace_id, 'error', message).catch(() => null);
            throw err;
        }

        return {
            selection_id: selection.selection_id,
            layer: selection.layer_id,
            materialized_count: rows.length,
            materialization_status: status,
            limits: {
                requested_limit: maxItems,
                timeout_ms: timeoutMs,
                fallback_timeout_ms: fallbackTimeoutMs,
                agent_requested_subset: maxItems !== null,
            },
            items_preview: rows.slice(0, 10),
        };
    }

    async listSelectionItems(selectionId: string, input: Record<string, any> = {}) {
        await this.selectionRepository.cleanupExpiredSelections();
        const selection = await this.selectionRepository.getSelection(selectionId);
        if (!selection) throw new Error(`Selection not found: ${selectionId}`);
        const hasLimitInput = input.limit !== undefined && input.limit !== null && input.limit !== '';
        const rawLimit = String(input.limit || '').trim().toLowerCase();
        const requestedLimit = hasLimitInput && rawLimit === 'all'
            ? null
            : hasLimitInput
                ? parseOptionalPositiveInt(input.limit, 'selection items limit')
                : 500;
        const offset = Math.max(0, Math.trunc(Number(input.offset) || 0));
        const page = await this.selectionRepository.listSelectionItems(selectionId, selection.workspace_id, requestedLimit, offset);
        return {
            selection_id: selection.selection_id,
            layer: selection.layer_id,
            materialized_count: selection.materialized_count || 0,
            materialization_status: selection.materialization_status || 'none',
            materialization_error: selection.materialization_error || null,
            pagination: {
                requested_limit: hasLimitInput ? (requestedLimit ?? 'all') : null,
                limit: requestedLimit ?? 'all',
                defaulted: !hasLimitInput,
                capped: false,
                offset,
                returned: page.items.length,
                has_more: page.has_more,
                next_offset: page.next_offset,
            },
            items: page.items,
        };
    }

    private async querySelectionItemsForMaterialization(selection: SelectionPayload, maxItems: number | null): Promise<SelectionItemPayload[]> {
        const predicate = selection.predicate || {};
        validateSelectionPredicateKeys(predicate);
        const rawLayer = selection.layer_id || String(predicate.layer || predicate.layer_id || '').trim() || null;
        const layer = rawLayer ? normalizeSelectionLayerId(rawLayer) : null;
        const kind = inferSelectionKind(layer, predicate);
        if (!kind) return [];

        const bbox = parseSelectionBbox(predicate.bbox, predicate.bbox_order || predicate.bboxOrder);
        const timeWindow = predicate.time_window && typeof predicate.time_window === 'object'
            ? predicate.time_window
            : predicate.timeWindow && typeof predicate.timeWindow === 'object'
                ? predicate.timeWindow
                : {};
        const from = parseIso(predicate.from || predicate.observed_from || predicate.observedFrom || predicate.start || (timeWindow as any).from || (timeWindow as any).start);
        const to = parseIso(predicate.to || predicate.observed_to || predicate.observedTo || predicate.end || (timeWindow as any).to || (timeWindow as any).end);
        const useHistoricalPositions = kind === 'entity' && Boolean(
            from
            || to
            || predicate.at
            || predicate.time
            || predicate.historical === true
            || predicate.history_mode === 'historical'
        );
        const ids = Array.from(new Set([
            ...(Array.isArray(predicate.ids) ? predicate.ids : []),
            ...(Array.isArray(predicate.entity_ids) ? predicate.entity_ids : []),
            ...(Array.isArray(predicate.event_ids) ? predicate.event_ids : []),
            ...(Array.isArray(predicate.asset_ids) ? predicate.asset_ids : []),
        ].map((value) => String(value).trim()).filter(Boolean)));
        const geometryJson = selection.geometry_json ? JSON.stringify(selection.geometry_json) : null;

        const params: unknown[] = [];
        const clauses: string[] = [];
        const add = (sql: string, value: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };
        const addTextValues = (expr: string, values: string[]) => {
            if (values.length === 0) return;
            if (values.length === 1) {
                add(`${expr} = ?`, values[0]);
                return;
            }
            params.push(values);
            clauses.push(`${expr} = ANY($${params.length}::text[])`);
        };
        const addBbox = (geomExpr: string, box: Bbox) => {
            const [west, south, east, north] = box;
            params.push(west, south, east, north);
            const idx = params.length - 3;
            clauses.push(`${geomExpr} IS NOT NULL AND ST_Intersects(${geomExpr}, ST_MakeEnvelope($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, 4326))`);
        };
        const addGeometry = (geomExpr: string) => {
            if (!geometryJson) return;
            params.push(geometryJson);
            clauses.push(`${geomExpr} IS NOT NULL AND ST_Intersects(${geomExpr}, ST_SetSRID(ST_GeomFromGeoJSON($${params.length}), 4326))`);
        };

        if (kind === 'entity') {
            const prefix = useHistoricalPositions ? 'pf' : 'ls';
            if (layer) add(`${prefix}.layer_id = ?`, layer);
            addTextValues('e.subtype', predicateTextValues(predicate, ['subtype', 'subtypes', 'subtype_in', 'subtypeIn']));
            addTextValues('e.entity_kind', predicateTextValues(predicate, ['entity_kind', 'entityKind', 'entity_kind_in', 'entityKindIn']));
            addTextValues(`COALESCE(${prefix}.source_id, e.source_id)`, predicateTextValues(predicate, ['source_id', 'sourceId', 'source_ids', 'sourceIds', 'sources']));
            if (bbox) addBbox(`${prefix}.geom`, bbox);
            addGeometry(`${prefix}.geom`);
            if (from) add(`${prefix}.observed_at >= ?::timestamptz`, from);
            if (to) add(`${prefix}.observed_at <= ?::timestamptz`, to);
            const at = !from && !to ? parseIso(predicate.at || predicate.time || predicate.observed_at || predicate.observedAt) : null;
            if (at) add(`${prefix}.observed_at <= ?::timestamptz`, at);
            if (ids.length > 0) {
                params.push(ids);
                clauses.push(`${prefix}.entity_id = ANY($${params.length}::text[])`);
            }
            const addLimit = () => {
                if (maxItems === null) return '';
                params.push(maxItems);
                return `LIMIT $${params.length}`;
            };
            if (useHistoricalPositions) {
                const limitClause = addLimit();
                const result = await this.database.query<SelectionItemPayload>(
                    `
                        WITH latest AS (
                            SELECT DISTINCT ON (pf.entity_id)
                                pf.entity_id AS selection_id,
                                pf.layer_id,
                                'entity'::text AS object_kind,
                                pf.entity_id AS object_id,
                                pf.observed_at,
                                ST_Y(pf.geom)::float8 AS display_lat,
                                ST_X(pf.geom)::float8 AS display_lng,
                                jsonb_build_object(
                                    'display_name', e.display_name,
                                    'source_id', COALESCE(pf.source_id, e.source_id),
                                    'subtype', e.subtype,
                                    'heading_deg', pf.heading_deg,
                                    'speed_mps', pf.speed_mps
                                ) || COALESCE(pf.properties, '{}'::jsonb) AS properties
                            FROM core.position_fixes pf
                            JOIN core.entities e ON e.entity_id = pf.entity_id
                            ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                            ORDER BY pf.entity_id, pf.observed_at DESC, pf.created_at DESC
                        )
                        SELECT *
                        FROM latest
                        ORDER BY observed_at DESC NULLS LAST, object_id
                        ${limitClause}
                    `,
                    params,
                );
                return (result?.rows || []).map((row) => ({ ...row, selection_id: selection.selection_id }));
            }
            const liveLimitClause = addLimit();
            const result = await this.database.query<SelectionItemPayload>(
                `
                    SELECT
                        ls.entity_id AS selection_id,
                        ls.layer_id,
                        'entity'::text AS object_kind,
                        ls.entity_id AS object_id,
                        ls.observed_at,
                        ST_Y(ls.geom)::float8 AS display_lat,
                        ST_X(ls.geom)::float8 AS display_lng,
                        jsonb_build_object(
                            'display_name', e.display_name,
                            'source_id', COALESCE(ls.source_id, e.source_id),
                            'subtype', e.subtype,
                            'heading_deg', ls.heading_deg,
                            'speed_mps', ls.speed_mps
                        ) AS properties
                    FROM app.entity_live_states ls
                    JOIN core.entities e ON e.entity_id = ls.entity_id
                    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                    ORDER BY ls.observed_at DESC, ls.entity_id
                    ${liveLimitClause}
                `,
                params,
            );
            return (result?.rows || []).map((row) => ({ ...row, selection_id: selection.selection_id }));
        }

        const addLimit = () => {
            if (maxItems === null) return '';
            params.push(maxItems);
            return `LIMIT $${params.length}`;
        };

        if (kind === 'event') {
            if (layer) add('ev.layer_id = ?', layer);
            addTextValues('ev.subtype', predicateTextValues(predicate, ['subtype', 'subtypes', 'subtype_in', 'subtypeIn']));
            addTextValues('ev.event_kind', predicateTextValues(predicate, ['event_kind', 'eventKind', 'event_kind_in', 'eventKindIn']));
            addTextValues('ev.source_id', predicateTextValues(predicate, ['source_id', 'sourceId', 'source_ids', 'sourceIds', 'sources']));
            if (bbox) addBbox('ev.geom', bbox);
            addGeometry('ev.geom');
            if (from) add('COALESCE(ev.observed_at, ev.valid_from, ev.created_at) >= ?::timestamptz', from);
            if (to) add('COALESCE(ev.observed_at, ev.valid_to, ev.updated_at, ev.created_at) <= ?::timestamptz', to);
            if (ids.length > 0) {
                params.push(ids);
                clauses.push(`ev.event_id = ANY($${params.length}::text[])`);
            }
            const limitClause = addLimit();
            const result = await this.database.query<SelectionItemPayload>(
                `
                    SELECT
                        ev.event_id AS selection_id,
                        ev.layer_id,
                        'event'::text AS object_kind,
                        ev.event_id AS object_id,
                        COALESCE(ev.observed_at, ev.valid_from, ev.created_at) AS observed_at,
                        CASE WHEN ev.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(ev.geom))::float8 ELSE NULL END AS display_lat,
                        CASE WHEN ev.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(ev.geom))::float8 ELSE NULL END AS display_lng,
                        jsonb_build_object(
                            'source_id', ev.source_id,
                            'event_kind', ev.event_kind,
                            'subtype', ev.subtype
                        ) || COALESCE(ev.properties, '{}'::jsonb) AS properties
                    FROM core.events ev
                    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                    ORDER BY COALESCE(ev.observed_at, ev.valid_from, ev.created_at) DESC, ev.event_id
                    ${limitClause}
                `,
                params,
            );
            return (result?.rows || []).map((row) => ({ ...row, selection_id: selection.selection_id }));
        }

        if (layer) add('a.layer_id = ?', layer);
        addTextValues('a.subtype', predicateTextValues(predicate, ['subtype', 'subtypes', 'subtype_in', 'subtypeIn']));
        addTextValues('a.asset_kind', predicateTextValues(predicate, ['asset_kind', 'assetKind', 'asset_kind_in', 'assetKindIn']));
        addTextValues('a.source_id', predicateTextValues(predicate, ['source_id', 'sourceId', 'source_ids', 'sourceIds', 'sources']));
        if (bbox) addBbox('a.geom', bbox);
        addGeometry('a.geom');
        if (from) add('COALESCE(a.last_observed_at, a.updated_at, a.created_at) >= ?::timestamptz', from);
        if (to) add('COALESCE(a.first_observed_at, a.created_at) <= ?::timestamptz', to);
        if (ids.length > 0) {
            params.push(ids);
            clauses.push(`a.asset_id = ANY($${params.length}::text[])`);
        }
        const limitClause = addLimit();
        const result = await this.database.query<SelectionItemPayload>(
            `
                SELECT
                    a.asset_id AS selection_id,
                    a.layer_id,
                    'asset'::text AS object_kind,
                    a.asset_id AS object_id,
                    COALESCE(a.last_observed_at, a.updated_at, a.created_at) AS observed_at,
                    CASE WHEN a.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(a.geom))::float8 ELSE NULL END AS display_lat,
                    CASE WHEN a.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(a.geom))::float8 ELSE NULL END AS display_lng,
                    jsonb_build_object(
                        'display_name', a.display_name,
                        'source_id', a.source_id,
                        'asset_kind', a.asset_kind,
                        'subtype', a.subtype
                    ) || COALESCE(a.properties, '{}'::jsonb) AS properties
                FROM core.assets a
                ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                ORDER BY COALESCE(a.last_observed_at, a.updated_at, a.created_at) DESC, a.asset_id
                ${limitClause}
            `,
            params,
        );
        return (result?.rows || []).map((row) => ({ ...row, selection_id: selection.selection_id }));
    }

    async previewSelection(selectionId: string) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        await this.selectionRepository.cleanupExpiredSelections();
        const selection = await this.selectionRepository.getSelection(selectionId);
        if (!selection) throw new Error(`Selection not found: ${selectionId}`);
        const layer = normalizeSelectionLayerId(selection.layer_id || String(selection.predicate?.layer || ''));
        const predicate = selection.predicate || {};
        const bbox = parseSelectionBbox(predicate.bbox, predicate.bbox_order || predicate.bboxOrder);
        const timeWindow = predicate.time_window && typeof predicate.time_window === 'object'
            ? predicate.time_window
            : predicate.timeWindow && typeof predicate.timeWindow === 'object'
                ? predicate.timeWindow
                : {};
        const from = parseIso(predicate.from || predicate.observed_from || predicate.observedFrom || predicate.start || (timeWindow as any).from || (timeWindow as any).start);
        const to = parseIso(predicate.to || predicate.observed_to || predicate.observedTo || predicate.end || (timeWindow as any).to || (timeWindow as any).end);
        const at = !from && !to ? parseIso(predicate.at || predicate.time || predicate.observed_at || predicate.observedAt) : null;
        const ids = Array.isArray(predicate.ids) ? predicate.ids.map(String) : [];
        const geometryJson = selection.geometry_json ? JSON.stringify(selection.geometry_json) : null;

        const params: unknown[] = [];
        const clauses: string[] = [];
        const add = (sql: string, value: unknown) => {
            params.push(value);
            clauses.push(sql.replace('?', `$${params.length}`));
        };
        const addBbox = (geomExpr: string, box: Bbox) => {
            const [west, south, east, north] = box;
            params.push(west, south, east, north);
            const idx = params.length - 3;
            clauses.push(`${geomExpr} IS NOT NULL AND ST_Intersects(${geomExpr}, ST_MakeEnvelope($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, 4326))`);
        };

        if (layer) add('layer_id = ?', layer);
        if (bbox) addBbox('geom', bbox);
        if (geometryJson) {
            params.push(geometryJson);
            clauses.push(`geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($${params.length}), 4326))`);
        }

        const makeWhere = (timeExpr: string, idExpr: string) => {
            const localClauses = [...clauses];
            const localParams = [...params];
            if (from) {
                localParams.push(from);
                localClauses.push(`${timeExpr} >= $${localParams.length}::timestamptz`);
            }
            if (to) {
                localParams.push(to);
                localClauses.push(`${timeExpr} <= $${localParams.length}::timestamptz`);
            }
            if (at) {
                localParams.push(at);
                localClauses.push(`${timeExpr} <= $${localParams.length}::timestamptz`);
            }
            if (ids.length > 0) {
                localParams.push(ids);
                localClauses.push(`${idExpr} = ANY($${localParams.length}::text[])`);
            }
            return { where: localClauses.length ? `WHERE ${localClauses.join(' AND ')}` : '', params: localParams };
        };

        const pf = makeWhere('observed_at', 'entity_id');
        const ev = makeWhere('COALESCE(observed_at, valid_from, created_at)', 'event_id');
        const asset = makeWhere('COALESCE(last_observed_at, updated_at, created_at)', 'asset_id');
        const [positions, events, assets] = await Promise.all([
            this.database.query(`SELECT COUNT(*)::bigint AS fixes, COUNT(DISTINCT entity_id)::bigint AS entities FROM core.position_fixes ${pf.where}`, pf.params),
            this.database.query(`SELECT COUNT(*)::bigint AS events FROM core.events ${ev.where}`, ev.params),
            this.database.query(`SELECT COUNT(*)::bigint AS assets FROM core.assets ${asset.where}`, asset.params),
        ]);
        const materialized = selection.materialized_count && selection.materialized_count > 0
            ? await this.selectionRepository.listSelectionItems(selection.selection_id, selection.workspace_id, 10, 0)
            : null;
        return {
            selection_id: selection.selection_id,
            layer: layer || null,
            predicate,
            geometry: selection.geometry_json,
            expires_at: selection.expires_at || null,
            materialization: {
                status: selection.materialization_status || 'none',
                count: selection.materialized_count || 0,
                materialized_at: selection.materialized_at || null,
                error: selection.materialization_error || null,
                preview_items: materialized?.items || [],
                has_more: materialized?.has_more || false,
            },
            counts: {
                position_fixes: positions?.rows[0] || { fixes: '0', entities: '0' },
                events: events?.rows[0] || { events: '0' },
                assets: assets?.rows[0] || { assets: '0' },
            },
        };
    }

    async getViewSummary() {
        const [state, tree] = await Promise.all([
            this.viewControlService.getState(),
            this.catalogReadService.getUiTaxonomy(),
        ]);
        return { state, legend_tree: tree };
    }
}
