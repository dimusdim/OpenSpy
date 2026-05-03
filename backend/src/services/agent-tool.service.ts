import crypto from 'crypto';
import { DatabaseService } from '../db/database.service';
import { CatalogReadService } from './catalog-read.service';
import { SelectionRepository } from '../repositories/selection.repository';
import { ViewControlService } from './view-control.service';

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

function clampLimit(value: unknown, fallback = 100, max = 5000): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function sqlLike(value: string): string {
    return `%${value.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
}

function parseBboxLike(value: unknown): Bbox | null {
    const parts = Array.isArray(value)
        ? value.map(Number)
        : String(value || '').split(',').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
    const [west, south, east, north] = parts;
    if (Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) return null;
    if (south >= north || west >= east) return null;
    return [west, south, east, north];
}

function parseIso(value: unknown): string | null {
    if (!value) return null;
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

export class AgentToolService {
    constructor(
        private readonly database: DatabaseService,
        private readonly catalogReadService: CatalogReadService,
        private readonly selectionRepository: SelectionRepository,
        private readonly viewControlService: ViewControlService,
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
        const limit = clampLimit(input.limit, 10, 50);
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
                [sqlLike(query), limit],
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

        return {
            query,
            count: Math.min(limit, hardcoded.length + dbRegions.length),
            matches: [...hardcoded, ...dbRegions].slice(0, limit),
        };
    }

    async resolveEntity(input: Record<string, any>) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        const query = String(input.query || input.entity || '').trim();
        const layer = String(input.layer || '').trim();
        const limit = clampLimit(input.limit, 10, 50);
        if (!query) throw new Error('entity.resolve requires query');

        const params: unknown[] = [sqlLike(query.toLowerCase()), limit];
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

        return {
            query,
            layer: layer || null,
            count: result?.rows.length || 0,
            matches: result?.rows || [],
        };
    }

    async createAoi(input: Record<string, any>) {
        const geometry = geometryFromInput(input);
        const label = String(input.label || input.name || 'Agent AOI').trim();
        const ttlSeconds = clampLimit(input.ttl_seconds ?? input.ttlSeconds, 24 * 60 * 60, 30 * 24 * 60 * 60);
        const suffix = crypto.createHash('sha1').update(JSON.stringify({ geometry, label, now: Date.now() })).digest('hex').slice(0, 12);
        const selectionId = String(input.geometry_ref || input.selection_id || `aoi:${suffix}`);
        const selection = await this.selectionRepository.saveSelection({
            selectionId,
            layerId: typeof input.layer === 'string' ? input.layer : null,
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
        const bbox = parseBboxLike(input.bbox);
        const groupBy = String(input.group_by || input.groupBy || 'layer').toLowerCase();
        const limit = clampLimit(input.limit, 200, 1000);
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
                   LIMIT ${limit}`;
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
                   LIMIT ${limit}`;
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
                   LIMIT ${limit}`;
        }

        const result = await this.database.query(sql, params);
        return { kind, layer: layer || null, group_by: groupBy, count: result?.rows.length || 0, rows: result?.rows || [] };
    }

    async corridorSearch(input: Record<string, any>) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        const kind = normalizeKind(input.kind);
        const layer = String(input.layer || '').trim();
        const radiusM = Number(input.radius_m ?? input.radiusM ?? 5000);
        const limit = clampLimit(input.limit, 100, 1000);
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
                   LIMIT ${limit}`;
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
                   LIMIT ${limit}`;
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
                   LIMIT ${limit}`;
        }
        const result = await this.database.query(sql, params);
        return { kind, layer: layer || null, radius_m: radiusM, count: result?.rows.length || 0, items: result?.rows || [] };
    }

    async previewSelection(selectionId: string) {
        if (!this.database.isReady()) throw new Error('Database is not ready');
        const selection = await this.selectionRepository.getSelection(selectionId);
        if (!selection) throw new Error(`Selection not found: ${selectionId}`);
        const layer = selection.layer_id || String(selection.predicate?.layer || '');
        const predicate = selection.predicate || {};
        const bbox = parseBboxLike(predicate.bbox);
        const from = parseIso(predicate.from);
        const to = parseIso(predicate.to);
        const ids = Array.isArray(predicate.ids) ? predicate.ids.map(String).slice(0, 5000) : [];
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
        return {
            selection_id: selection.selection_id,
            layer: layer || null,
            predicate,
            geometry: selection.geometry_json,
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
