import crypto from 'crypto';
import { DatabaseService } from '../db/database.service';
import type { DisasterEvent } from './live-stream.service';
import { extractPublicSourceLiveContract } from './live-contracts';
import type { FireRecord } from './extended.service';
import type { JammingZone } from './gpsjam.service';
import type { OutageRecord } from './ioda.service';
import type { CloudflareOutage } from './cloudflare.service';
import type { ConflictEvent } from './acled.service';
import type { GdeltConflictEvent } from './gdelt.service';
import type { AirspaceZone, AirspacePolygon } from './airspace.service';
import type { GFWEvent } from './gfw.service';
import type { SatelliteRecord } from './satellite.service';

export type LiveAircraftRecord = {
    id: string;
    icao24: string;
    lat: number;
    lng: number;
    altMeters: number | null;
    alt: number;
    heading: number;
    type: string;
    speedMps: number | null;
    speed: number;
    callsign?: string;
    origin?: string;
    onGround?: boolean;
    verticalRate?: number | null;
    squawk?: string | null;
    lastContact?: number | null;
};

export type LiveVesselRecord = {
    id: string;
    lat: number;
    lng: number;
    heading: number;
    type: string;
    speed: number;
    cog?: number | null;
    navigationStatus?: string | null;
    rateOfTurn?: number | null;
    name?: string | null;
    callSign?: string | null;
    imo?: number | null;
    destination?: string | null;
    eta?: string | null;
    draught?: number | null;
    length?: number | null;
    beam?: number | null;
};

type EventRow = {
    event_id: string;
    source_id: string | null;
    subtype: string | null;
    observed_at: string | Date | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: Record<string, any>;
};

type AssetRow = {
    asset_id: string;
    source_id: string | null;
    subtype: string | null;
    display_name: string | null;
    geometry: any;
    properties: Record<string, any>;
};

type SatelliteRow = {
    entity_id: string;
    display_name: string | null;
    subtype: string | null;
    entity_properties: Record<string, any>;
    tle_line1: string | null;
    tle_line2: string | null;
    tle_epoch_at?: string | Date | null;
    fetched_at?: string | Date | null;
    provider?: string | null;
    source_publication_at?: string | Date | null;
    orbital_properties: Record<string, any>;
};

type EntityLiveRow = {
    entity_id: string;
    subtype: string | null;
    display_name: string | null;
    entity_properties: Record<string, any>;
    observed_at: string;
    display_lat: number;
    display_lng: number;
    altitude_m: number | null;
    heading_deg: number | null;
    speed_mps: number | null;
    live_properties: Record<string, any>;
};

type FireQueryOptions = {
    bbox?: [number, number, number, number];
    gridDegrees?: number | null;
};

function stripStateHash<T extends Record<string, any>>(value: T | null | undefined): T {
    const next = { ...(value || {}) } as T;
    delete (next as any)._state_hash;
    return next;
}

function normalizeObservedAt(value: string | Date | null | undefined): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function metadataContentHash(value: unknown): string {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function polygonGeometryToAirspace(geometry: any): AirspacePolygon[] {
    if (!geometry || typeof geometry !== 'object') return [];
    const polygons = geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
            ? geometry.coordinates
            : [];

    return polygons
        .map((poly: unknown) => {
            if (!Array.isArray(poly) || poly.length === 0) return null;
            const outerRing = poly[0];
            const outer = Array.isArray(outerRing)
                ? outerRing.map((point: unknown) => {
                    const [lng, lat] = point as [number, number];
                    return [lat, lng] as [number, number];
                })
                : [];
            if (outer.length < 4) return null;
            const holes = poly.slice(1).map((ring: unknown) =>
                Array.isArray(ring)
                    ? ring.map((point: unknown) => {
                        const [lng, lat] = point as [number, number];
                        return [lat, lng] as [number, number];
                    })
                    : [],
            ).filter((ring: [number, number][]) => ring.length >= 4);
            return { outer, holes };
        })
        .filter((poly: AirspacePolygon | null): poly is AirspacePolygon => Boolean(poly));
}

export class LiveProjectionService {
    constructor(private readonly database: DatabaseService) {}

    isReady(): boolean {
        return this.database.isReady();
    }

    // limit = null/undefined → SQL без LIMIT (возвращаем всё).
    // Раньше default 200000 молча обрезал. 2026-04-24: пользователь запретил
    // искусственные обрезки объёма — каждый caller решает явно.
    private async listLatestEvents(layerId: string, sourceId?: string | null, limit?: number | null): Promise<EventRow[]> {
        if (!this.database.isReady()) return [];

        const params: unknown[] = [layerId];
        let sourceWhere = '';
        if (sourceId) {
            params.push(sourceId);
            sourceWhere = `AND e.source_id = $${params.length}`;
        }
        const limitSql = limit != null ? (params.push(limit), `LIMIT $${params.length}`) : '';

        const result = await this.database.query<EventRow>(
            `
                SELECT
                    e.event_id,
                    e.source_id,
                    e.subtype,
                    e.observed_at,
                    CASE WHEN e.geom IS NOT NULL THEN ST_AsGeoJSON(e.geom)::jsonb ELSE NULL END AS geometry,
                    CASE WHEN e.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(e.geom)) ELSE NULL END AS display_lat,
                    CASE WHEN e.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(e.geom)) ELSE NULL END AS display_lng,
                    e.properties
                FROM core.events e
                WHERE e.layer_id = $1
                ${sourceWhere}
                  AND (e.valid_to IS NULL OR e.valid_to > now())
                ORDER BY COALESCE(e.observed_at, e.updated_at) DESC NULLS LAST, e.updated_at DESC
                ${limitSql}
            `,
            params,
        );

        return result?.rows || [];
    }

    private async listLatestAssets(layerId: string, sourceId?: string | null, limit?: number | null): Promise<AssetRow[]> {
        if (!this.database.isReady()) return [];

        const params: unknown[] = [layerId];
        let sourceWhere = '';
        if (sourceId) {
            params.push(sourceId);
            sourceWhere = `AND a.source_id = $${params.length}`;
        }
        const limitSql = limit != null ? (params.push(limit), `LIMIT $${params.length}`) : '';

        const result = await this.database.query<AssetRow>(
            `
                SELECT
                    a.asset_id,
                    a.source_id,
                    a.subtype,
                    a.display_name,
                    CASE WHEN a.geom IS NOT NULL THEN ST_AsGeoJSON(a.geom)::jsonb ELSE NULL END AS geometry,
                    a.properties
                FROM core.assets a
                WHERE a.layer_id = $1
                ${sourceWhere}
                ORDER BY COALESCE(a.last_observed_at, a.updated_at, a.created_at) DESC NULLS LAST, a.updated_at DESC
                ${limitSql}
            `,
            params,
        );

        return result?.rows || [];
    }

    private async listLatestSatellites(limit?: number | null, atIso = new Date().toISOString()): Promise<SatelliteRow[]> {
        if (!this.database.isReady()) return [];

        const sql = `
                WITH latest_orbital AS (
                    SELECT DISTINCT ON (oe.entity_id)
                        oe.entity_id,
                        oe.tle_line1,
                        oe.tle_line2,
                        oe.tle_epoch_at,
                        oe.fetched_at,
                        oe.provider,
                        oe.source_publication_at,
                        oe.properties
                    FROM core.orbital_elements oe
                    WHERE oe.entity_id LIKE 'satellite:%'
                      AND COALESCE(oe.tle_epoch_at, oe.observed_at) <= $1::timestamptz
                    ORDER BY
                        oe.entity_id,
                        COALESCE(oe.tle_epoch_at, oe.observed_at) DESC,
                        COALESCE(oe.fetched_at, oe.created_at) DESC,
                        oe.created_at DESC
                )
                SELECT
                    e.entity_id,
                    e.display_name,
                    e.subtype,
                    e.properties AS entity_properties,
                    lo.tle_line1,
                    lo.tle_line2,
                    lo.tle_epoch_at,
                    lo.fetched_at,
                    lo.provider,
                    lo.source_publication_at,
                    lo.properties AS orbital_properties
                FROM core.entities e
                LEFT JOIN latest_orbital lo ON lo.entity_id = e.entity_id
                WHERE e.layer_id = 'satellite'
                ORDER BY COALESCE(e.last_observed_at, e.updated_at) DESC NULLS LAST, e.updated_at DESC
                ${limit != null ? 'LIMIT $2' : ''}
            `;

        const result = await this.database.query<SatelliteRow>(
            sql,
            limit != null ? [atIso, limit] : [atIso],
        );

        return result?.rows || [];
    }

    private async listLiveEntities(layerId: string, maxAgeSeconds: number, limit?: number | null, entityId?: string | null): Promise<EntityLiveRow[]> {
        if (!this.database.isReady()) return [];

        const params: unknown[] = [layerId, maxAgeSeconds];
        let liveEntityWhere = '';
        let fixEntityWhere = '';
        if (entityId) {
            params.push(entityId);
            liveEntityWhere = `AND e.entity_id = $${params.length}`;
            fixEntityWhere = `AND pf.entity_id = $${params.length}`;
        }
        const limitSql = limit != null ? (params.push(limit), `LIMIT $${params.length}`) : '';

        const result = await this.database.query<EntityLiveRow>(
            `
                SELECT
                    e.entity_id,
                    e.subtype,
                    e.display_name,
                    e.properties AS entity_properties,
                    ls.observed_at,
                    ST_Y(ls.geom) AS display_lat,
                    ST_X(ls.geom) AS display_lng,
                    ls.altitude_m,
                    ls.heading_deg,
                    ls.speed_mps,
                    ls.properties AS live_properties
                FROM app.entity_live_states ls
                JOIN core.entities e ON e.entity_id = ls.entity_id
                WHERE e.layer_id = $1
                  AND ls.observed_at >= now() - ($2::text || ' seconds')::interval
                  ${liveEntityWhere}
                ORDER BY ls.observed_at DESC, ls.updated_at DESC
                ${limitSql}
            `,
            params,
        );

        const rows = result?.rows || [];
        if (entityId && rows.length > 0) return rows;

        const fallbackResult = await this.database.query<EntityLiveRow>(
            `
                WITH latest_fixes AS (
                    SELECT DISTINCT ON (pf.entity_id)
                        pf.entity_id,
                        pf.layer_id,
                        pf.source_id,
                        pf.observed_at,
                        pf.geom,
                        pf.altitude_m,
                        pf.heading_deg,
                        pf.speed_mps,
                        pf.properties,
                        pf.created_at
                    FROM core.position_fixes pf
                    WHERE pf.layer_id = $1
                      AND pf.observed_at >= now() - ($2::text || ' seconds')::interval
                      ${fixEntityWhere}
                    ORDER BY pf.entity_id, pf.observed_at DESC, pf.created_at DESC
                )
                SELECT
                    e.entity_id,
                    e.subtype,
                    e.display_name,
                    e.properties AS entity_properties,
                    lf.observed_at,
                    ST_Y(lf.geom) AS display_lat,
                    ST_X(lf.geom) AS display_lng,
                    lf.altitude_m,
                    lf.heading_deg,
                    lf.speed_mps,
                    lf.properties AS live_properties
                FROM latest_fixes lf
                JOIN core.entities e ON e.entity_id = lf.entity_id
                ORDER BY lf.observed_at DESC, lf.created_at DESC
                ${limitSql}
            `,
            params,
        );

        const fallbackRows = fallbackResult?.rows || [];
        if (rows.length === 0) return fallbackRows;

        const byEntity = new Map<string, EntityLiveRow>();
        for (const row of fallbackRows) byEntity.set(row.entity_id, row);
        for (const row of rows) byEntity.set(row.entity_id, row);

        const merged = Array.from(byEntity.values()).sort((left, right) => {
            const rightMs = Date.parse(right.observed_at || '');
            const leftMs = Date.parse(left.observed_at || '');
            return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
        });
        return limit != null ? merged.slice(0, limit) : merged;
    }

    private async getSourceRemovalWindowSeconds(sourceId: string, fallbackSeconds: number): Promise<number> {
        if (!this.database.isReady()) return fallbackSeconds;

        const result = await this.database.query<{ manifest: any }>(
            `
                SELECT manifest
                FROM catalog.sources
                WHERE source_id = $1
                LIMIT 1
            `,
            [sourceId],
        );

        const contract = extractPublicSourceLiveContract(sourceId, result?.rows[0]?.manifest);
        if (contract?.remove_after_sec && Number.isFinite(contract.remove_after_sec)) {
            return contract.remove_after_sec;
        }
        return fallbackSeconds;
    }

    async getDisasterEvents(): Promise<DisasterEvent[]> {
        const rows = await this.listLatestEvents('disasters');
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            return {
                id: row.event_id,
                lat: Number.isFinite(props.lat) ? props.lat : row.display_lat,
                lng: Number.isFinite(props.lng) ? props.lng : row.display_lng,
                type: props.type || 'strike',
                source: props.source || row.source_id || '',
                eventType: props.eventType || row.subtype || 'unknown',
                alertLevel: props.alertLevel || 'Green',
                radiusKm: props.radiusKm,
                startTime: props.startTime || observedAt,
                endTime: props.endTime || '',
                description: '',
                geometry: null,
            } as DisasterEvent;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getFires(options?: FireQueryOptions): Promise<Array<FireRecord & { aggregated?: boolean; count?: number }>> {
        const rows = await this.listLatestEvents('fire');
        const records = rows.map((row) => {
            const props = stripStateHash(row.properties);
            return {
                ...props,
                id: props.id || row.event_id,
                lat: Number.isFinite(props.lat) ? props.lat : row.display_lat,
                lng: Number.isFinite(props.lng) ? props.lng : row.display_lng,
            } as FireRecord;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));

        const bbox = options?.bbox;
        const filtered = bbox
            ? records.filter((row) => {
                const [south, west, north, east] = bbox;
                const inLat = row.lat >= south && row.lat <= north;
                const crossAM = east < west;
                const inLng = crossAM
                    ? row.lng >= west || row.lng <= east
                    : row.lng >= west && row.lng <= east;
                return inLat && inLng;
            })
            : records;

        const gridDegrees = options?.gridDegrees;
        const toRenderFire = (fire: FireRecord & { aggregated?: boolean; count?: number }) => ({
            id: fire.id,
            lat: fire.lat,
            lng: fire.lng,
            frp: fire.frp,
            subtype: (fire as any).subtype || (fire.frp > 100 ? 'high' : fire.frp > 30 ? 'medium' : 'low'),
            aggregated: fire.aggregated,
            count: fire.count,
        });

        if (!gridDegrees || gridDegrees <= 0) return filtered.map(toRenderFire) as any;

        const crossAM = bbox ? bbox[3] < bbox[1] : false;
        const west = bbox ? bbox[1] : -180;
        const clusters = new Map<string, FireRecord & { aggregated: true; count: number }>();

        for (const fire of filtered) {
            const subtype = fire.frp > 100 ? 'high' : fire.frp > 30 ? 'medium' : 'low';
            const adjustedLng = crossAM && fire.lng < west ? fire.lng + 360 : fire.lng;
            const latBin = Math.floor(fire.lat / gridDegrees);
            const lngBin = Math.floor(adjustedLng / gridDegrees);
            const clusterKey = `${gridDegrees}:${subtype}:${latBin}:${lngBin}`;
            const existing = clusters.get(clusterKey);
            if (existing) {
                const nextCount = existing.count + 1;
                existing.lat = ((existing.lat * existing.count) + fire.lat) / nextCount;
                existing.lng = ((existing.lng * existing.count) + adjustedLng) / nextCount;
                if (crossAM && existing.lng > 180) existing.lng -= 360;
                existing.count = nextCount;
                existing.frp = Math.max(existing.frp, fire.frp);
                existing.brightness = Math.max(existing.brightness, fire.brightness);
                if (fire.acqTime > existing.acqTime) existing.acqTime = fire.acqTime;
            } else {
                clusters.set(clusterKey, {
                    ...fire,
                    id: `fire-cluster:${clusterKey}`,
                    lng: crossAM && adjustedLng > 180 ? adjustedLng - 360 : adjustedLng,
                    aggregated: true,
                    count: 1,
                });
            }
        }

        return Array.from(clusters.values()).map(toRenderFire) as any;
    }

    async getJammingZones(): Promise<JammingZone[]> {
        const rows = await this.listLatestEvents('jamming');
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const ring = row.geometry?.type === 'Polygon' && Array.isArray(row.geometry.coordinates?.[0])
                ? row.geometry.coordinates[0]
                : [];
            const boundary = ring
                .map(([lng, lat]: [number, number]) => [lat, lng] as [number, number])
                .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
            return {
                id: row.event_id,
                lat: Number.isFinite(props.lat) ? props.lat : row.display_lat,
                lng: Number.isFinite(props.lng) ? props.lng : row.display_lng,
                boundary,
                intensity: props.intensity || row.subtype || 'low',
            } as JammingZone;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getIodaOutages(): Promise<OutageRecord[]> {
        const rows = await this.listLatestEvents('outage', 'ioda');
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            return {
                id: row.event_id,
                country: '',
                countryCode: props.countryCode || '',
                lat: row.display_lat,
                lng: row.display_lng,
                level: row.subtype || props.level || 'warning',
                datasource: props.datasource || 'ioda',
                startTime: observedAt,
            } as OutageRecord;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getCloudflareOutages(): Promise<CloudflareOutage[]> {
        const rows = await this.listLatestEvents('outage', 'cloudflare_radar');
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            return {
                id: row.event_id,
                startDate: observedAt,
                endDate: props.endDate || '',
                scope: props.scope || '',
                asn: Number(props.asn || 0) || 0,
                asnName: '',
                locations: props.locationCode ? [props.locationCode] : [],
                locationNames: [],
                locationCode: props.locationCode || null,
                locationName: props.locationName || null,
                locationIndex: Number.isFinite(Number(props.locationIndex)) ? Number(props.locationIndex) : null,
                locationCount: Number.isFinite(Number(props.locationCount)) ? Number(props.locationCount) : null,
                lat: row.display_lat,
                lng: row.display_lng,
                outageType: '',
                outageCause: '',
            } as CloudflareOutage;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getAcledConflicts(): Promise<ConflictEvent[]> {
        const rows = await this.listLatestEvents('conflict', 'acled');
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            return {
                id: row.event_id,
                lat: row.display_lat ?? 0,
                lng: row.display_lng ?? 0,
                event_type: props.eventType || '',
                sub_event_type: props.subEventType || row.subtype || '',
                fatalities: props.fatalities || 0,
                country: '',
                actor1: '',
                actor2: '',
                event_date: '',
                notes: '',
            } as ConflictEvent;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getGdeltConflicts(): Promise<GdeltConflictEvent[]> {
        const rows = await this.listLatestEvents('conflict', 'gdelt');
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            const observed = observedAt ? observedAt.slice(0, 10).replace(/-/g, '') : '';
            return {
                id: row.event_id,
                lat: row.display_lat ?? 0,
                lng: row.display_lng ?? 0,
                date: observed,
                eventCode: props.eventCode || '',
                rootCode: props.rootCode || '',
                eventType: props.eventType || '',
                subEventType: props.subEventType || row.subtype || '',
                actor1: '',
                actor2: '',
                goldstein: props.goldstein || 0,
                numMentions: props.numMentions || 0,
                numSources: props.numSources || 0,
                sourceUrl: '',
                country: '',
                location: '',
            } as GdeltConflictEvent;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getGfwEvents(): Promise<GFWEvent[]> {
        const rows = await this.listLatestEvents('gfw', 'gfw');
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            return {
                id: row.event_id,
                lat: row.display_lat ?? 0,
                lng: row.display_lng ?? 0,
                type: row.subtype || 'gap',
                start: observedAt,
                end: '',
                vesselId: '',
                vesselName: '',
                flagState: '',
                confidence: null,
                duration: null,
                vesselOwner: null,
                vesselMmsi: null,
                vesselType: null,
            } as GFWEvent;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getAirspaceZones(): Promise<AirspaceZone[]> {
        const rows = await this.listLatestAssets('airspace', 'openaip');
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            return {
                id: row.asset_id.replace(/^airspace:/, ''),
                name: row.display_name || 'Unknown Airspace',
                type: props.type || 0,
                typeName: props.typeName || row.subtype || 'Other',
                upperLimit: props.upperLimit || 0,
                lowerLimit: props.lowerLimit || 0,
                geometry: polygonGeometryToAirspace(row.geometry),
            } as AirspaceZone;
        }).filter((row) => row.geometry.length > 0);
    }

    async getCables(): Promise<any> {
        const rows = await this.listLatestAssets('cable', 'telegeography');
        return {
            type: 'FeatureCollection',
            features: rows
                .filter((row) => row.geometry)
                .map((row) => ({
                    type: 'Feature',
                    properties: {
                        id: row.asset_id,
                        name: row.display_name || 'Submarine cable',
                    },
                    geometry: row.geometry,
                })),
        };
    }

    async getAircraftLive(): Promise<LiveAircraftRecord[]> {
        const rows = await this.listLiveEntities('aircraft', await this.getSourceRemovalWindowSeconds('opensky', 300));
        return rows
            .map((row) => {
                const entityProps = stripStateHash(row.entity_properties);
                const liveProps = stripStateHash(row.live_properties);
                const icao24 = String(entityProps.icao24 || row.entity_id.replace(/^aircraft:/, '')).toLowerCase();
                const altMeters = Number.isFinite(row.altitude_m) ? row.altitude_m : null;
                const speedMps = Number.isFinite(row.speed_mps) ? row.speed_mps : null;
                const heading = Number.isFinite(row.heading_deg) ? row.heading_deg : 0;
                const lastContactMs = Date.parse(row.observed_at);
                return {
                    id: icao24,
                    icao24,
                    callsign: entityProps.callsign || row.display_name || icao24,
                    origin: entityProps.origin || '',
                    lat: row.display_lat,
                    lng: row.display_lng,
                    altMeters,
                    alt: altMeters != null ? altMeters * 3.28084 : 0,
                    heading,
                    type: row.subtype || 'general',
                    speedMps,
                    speed: speedMps != null ? speedMps * 3.6 : 0,
                    // Callsign/origin/squawk/etc are intentionally left out of
                    // the live render payload. EntityHUD loads them on demand.
                } as LiveAircraftRecord;
            })
            .filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getVesselsLive(): Promise<LiveVesselRecord[]> {
        const rows = await this.listLiveEntities('vessel', await this.getSourceRemovalWindowSeconds('aisstream', 1800));
        return rows
            .map((row) => {
                const entityProps = stripStateHash(row.entity_properties);
                const liveProps = stripStateHash(row.live_properties);
                const speedMps = Number.isFinite(row.speed_mps) ? row.speed_mps : null;
                return {
                    id: String(entityProps.mmsi || row.entity_id.replace(/^vessel:/, '')),
                    lat: row.display_lat,
                    lng: row.display_lng,
                    heading: Number.isFinite(row.heading_deg) ? row.heading_deg : 0,
                    type: row.subtype || 'unknown',
                    speed: speedMps != null ? speedMps / 0.514444 : 0,
                    cog: entityProps.cog ?? liveProps.cog ?? null,
                    // Static AIS metadata is intentionally omitted from the
                    // live render payload. EntityHUD loads it on demand.
                } as LiveVesselRecord;
            })
            .filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getSatellites(limit?: number | null): Promise<SatelliteRecord[]> {
        const rows = await this.listLatestSatellites(limit);
        return rows
            .map((row) => {
                const entityProps = stripStateHash(row.entity_properties);
                const orbitalProps = stripStateHash(row.orbital_properties);
                const noradId = Number(entityProps.noradId ?? orbitalProps.noradId ?? -1);
                if (!row.tle_line1 || !row.tle_line2) return null;
                return {
                    name: row.display_name || orbitalProps.name || entityProps.name || row.entity_id,
                    tleLine1: row.tle_line1,
                    tleLine2: row.tle_line2,
                    tleEpochAt: normalizeObservedAt(row.tle_epoch_at),
                    fetchedAt: normalizeObservedAt(row.fetched_at),
                    provider: row.provider || undefined,
                    sourcePublicationAt: normalizeObservedAt(row.source_publication_at) || undefined,
                    type: entityProps.type || row.subtype || orbitalProps.type || 'civilian',
                    classificationSource: entityProps.classificationSource || orbitalProps.classificationSource || 'derived_name_heuristic',
                    noradId: Number.isFinite(noradId) ? noradId : -1,
                    recon: Boolean(entityProps.recon || orbitalProps.recon),
                    reconMeta: entityProps.reconMeta || orbitalProps.reconMeta || undefined,
                    sensor: entityProps.sensor || orbitalProps.sensor || undefined,
                } as SatelliteRecord;
            })
            .filter((row): row is SatelliteRecord => Boolean(row));
    }

    async getReconSatellites(limit?: number | null): Promise<SatelliteRecord[]> {
        const rows = await this.getSatellites(limit);
        return rows.filter((row) => row.recon === true);
    }

    async getLiveDetails(layerId: string, id: string): Promise<Record<string, any> | null> {
        const normalizedLayer = layerId === 'aviation' ? 'aircraft'
            : layerId === 'maritime' ? 'vessel'
            : layerId;
        const featureId = this.liveDetailFeatureId(normalizedLayer, id);
        const cached = featureId
            ? await this.readLiveDetailsCache(featureId, normalizedLayer).catch(() => null)
            : null;
        if (cached) return cached;

        const details = normalizedLayer === 'aircraft'
            ? await this.getAircraftDetails(id)
            : normalizedLayer === 'vessel'
                ? await this.getVesselDetails(id)
                : normalizedLayer === 'satellite'
                    ? await this.getSatelliteDetails(id)
                    : await this.getSnapshotBackedDetails(normalizedLayer, id);
        if (details && featureId) {
            await this.writeLiveDetailsCache(featureId, normalizedLayer, details).catch(() => undefined);
        }
        return details;
    }

    private liveDetailFeatureId(layerId: string, id: string): string | null {
        if (layerId === 'aircraft') return `aircraft:${id.replace(/^aircraft:/, '').toLowerCase()}`;
        if (layerId === 'vessel') return `vessel:${id.replace(/^vessel:/, '')}`;
        if (layerId === 'satellite') {
            const normalized = id.replace(/^sat-/, '').replace(/^satellite:/, '');
            return `satellite:${normalized}`;
        }
        if (id.includes(':')) return id;
        if (['cable', 'airspace', 'pipeline', 'fire', 'conflict', 'gfw', 'jamming', 'outage', 'disasters'].includes(layerId)) {
            return `${layerId}:${id}`;
        }
        return null;
    }

    private async getSnapshotBackedDetails(layerId: string, id: string): Promise<Record<string, any> | null> {
        if (layerId === 'cable' || layerId === 'airspace' || layerId === 'pipeline') {
            return this.getAssetDetails(layerId, id);
        }
        if (layerId === 'fire' || layerId === 'conflict' || layerId === 'gfw' || layerId === 'jamming' || layerId === 'outage' || layerId === 'disasters') {
            return this.getEventDetails(layerId, id);
        }
        return null;
    }

    private normalizeAssetDetailId(layerId: string, id: string): string {
        if (id.includes(':')) return id;
        if (layerId === 'airspace') return `airspace:${id.replace(/^airspace-/, '')}`;
        if (layerId === 'pipeline') return `pipeline:${id.replace(/^pipeline-/, '')}`;
        if (layerId === 'cable') return `cable:${id.replace(/^cable-/, '')}`;
        return id;
    }

    private normalizeEventDetailCandidates(layerId: string, id: string): string[] {
        if (id.includes(':')) return [id];
        const stripped = id.replace(new RegExp(`^${layerId}[-:]`), '');
        if (layerId === 'conflict') {
            return [`conflict:acled:${stripped}`, `conflict:gdelt:${stripped}`];
        }
        if (layerId === 'gfw') return [`gfw:${stripped}`];
        if (layerId === 'jamming') return [`jamming:${stripped}`, `jamming:h3:${stripped}`];
        if (layerId === 'outage') return [`outage:ioda:${stripped}`, `outage:cloudflare:${stripped}`];
        if (layerId === 'fire') return [`fire:${stripped}`];
        if (layerId === 'disasters') return [`disaster:${stripped}`];
        return [id];
    }

    private async getAssetDetails(layerId: string, id: string): Promise<Record<string, any> | null> {
        if (!this.database.isReady()) return null;
        const assetId = this.normalizeAssetDetailId(layerId, id);
        const result = await this.database.query<any>(
            `
                SELECT
                    s.asset_id,
                    s.layer_id,
                    s.source_id,
                    s.asset_kind,
                    s.subtype,
                    s.display_name,
                    s.observed_at,
                    CASE WHEN s.geom IS NOT NULL THEN ST_AsGeoJSON(s.geom)::jsonb ELSE NULL END AS geometry,
                    s.properties
                FROM core.asset_snapshots s
                WHERE s.layer_id = $1
                  AND s.asset_id = $2
                ORDER BY COALESCE(s.observed_at, s.created_at) DESC, s.created_at DESC
                LIMIT 1
            `,
            [layerId, assetId],
        );
        const row = result?.rows?.[0];
        if (!row) return null;
        return {
            layerId,
            featureKind: 'asset',
            id: row.asset_id,
            name: row.display_name || row.asset_id,
            sourceId: row.source_id,
            subtype: row.subtype,
            observedAt: normalizeObservedAt(row.observed_at),
            properties: stripStateHash(row.properties),
            geometry: row.geometry || null,
        };
    }

    private async getEventDetails(layerId: string, id: string): Promise<Record<string, any> | null> {
        if (!this.database.isReady()) return null;
        const candidates = this.normalizeEventDetailCandidates(layerId, id);
        const result = await this.database.query<any>(
            `
                SELECT
                    s.event_id,
                    s.layer_id,
                    s.source_id,
                    s.event_kind,
                    s.subtype,
                    s.observed_at,
                    s.valid_from,
                    s.valid_to,
                    CASE WHEN s.geom IS NOT NULL THEN ST_AsGeoJSON(s.geom)::jsonb ELSE NULL END AS geometry,
                    CASE WHEN s.geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lat,
                    CASE WHEN s.geom IS NOT NULL THEN ST_X(ST_PointOnSurface(s.geom)) ELSE NULL END AS display_lng,
                    s.properties
                FROM core.event_snapshots s
                WHERE s.layer_id = $1
                  AND s.event_id = ANY($2::text[])
                ORDER BY COALESCE(s.observed_at, s.valid_from, s.created_at) DESC, s.created_at DESC
                LIMIT 1
            `,
            [layerId, candidates],
        );
        const row = result?.rows?.[0];
        if (!row) return null;
        const props = stripStateHash(row.properties);
        return {
            layerId,
            featureKind: 'event',
            id: row.event_id,
            name: props.name || props.description || props.eventType || props.event_type || row.event_id,
            sourceId: row.source_id,
            subtype: row.subtype,
            observedAt: normalizeObservedAt(row.observed_at),
            validFrom: normalizeObservedAt(row.valid_from),
            validTo: normalizeObservedAt(row.valid_to),
            lat: Number.isFinite(row.display_lat) ? row.display_lat : null,
            lng: Number.isFinite(row.display_lng) ? row.display_lng : null,
            properties: props,
            geometry: row.geometry || null,
        };
    }

    private async readLiveDetailsCache(featureId: string, layerId: string): Promise<Record<string, any> | null> {
        if (!this.database.isReady()) return null;
        const result = await this.database.query<{ metadata: Record<string, any> }>(
            `
                SELECT metadata
                FROM app.feature_metadata_cache
                WHERE feature_kind = 'entity'
                  AND feature_id = $1
                  AND layer_id = $2
                  AND as_of = '-infinity'::timestamptz
                  AND (expires_at IS NULL OR expires_at > now())
                LIMIT 1
            `,
            [featureId, layerId],
        );
        return result?.rows[0]?.metadata || null;
    }

    private async writeLiveDetailsCache(featureId: string, layerId: string, metadata: Record<string, any>): Promise<void> {
        if (!this.database.isReady()) return;
        const serializedHash = metadataContentHash(metadata);
        await this.database.query(
            `
                SELECT app.upsert_feature_metadata_cache(
                    'entity'::text,
                    $1::text,
                    $2::text,
                    '-infinity'::timestamptz,
                    $3::jsonb,
                    now(),
                    $4::text,
                    now() + INTERVAL '30 seconds'
                )
            `,
            [featureId, layerId, JSON.stringify(metadata), serializedHash],
        );
    }

    private async getAircraftDetails(id: string): Promise<Record<string, any> | null> {
        if (!this.database.isReady()) return null;
        const icao24 = id.replace(/^aircraft:/, '').toLowerCase();
        const rows = await this.listLiveEntities('aircraft', await this.getSourceRemovalWindowSeconds('opensky', 300), 1, `aircraft:${icao24}`);
        const row = rows[0];
        if (!row) return null;
        const entityProps = stripStateHash(row.entity_properties);
        const liveProps = stripStateHash(row.live_properties);
        const speedMps = Number.isFinite(row.speed_mps) ? row.speed_mps : null;
        const altMeters = Number.isFinite(row.altitude_m) ? row.altitude_m : null;
        const lastContactMs = Date.parse(row.observed_at);
        return {
            layerId: 'aircraft',
            id: icao24,
            icao24,
            name: entityProps.callsign || row.display_name || icao24,
            callsign: entityProps.callsign || row.display_name || icao24,
            origin: entityProps.origin || '',
            type: row.subtype || 'general',
            lat: row.display_lat,
            lng: row.display_lng,
            altMeters,
            alt: altMeters != null ? altMeters * 3.28084 : 0,
            heading: Number.isFinite(row.heading_deg) ? row.heading_deg : 0,
            speedMps,
            speed: speedMps != null ? speedMps * 3.6 : 0,
            onGround: Boolean(entityProps.onGround ?? liveProps.onGround ?? false),
            verticalRate: entityProps.verticalRate ?? liveProps.verticalRate ?? null,
            squawk: entityProps.squawk ?? liveProps.squawk ?? null,
            lastContact: Number.isFinite(lastContactMs) ? Math.floor(lastContactMs / 1000) : null,
        };
    }

    private async getVesselDetails(id: string): Promise<Record<string, any> | null> {
        if (!this.database.isReady()) return null;
        const mmsi = id.replace(/^vessel:/, '');
        const rows = await this.listLiveEntities('vessel', await this.getSourceRemovalWindowSeconds('aisstream', 1800), 1, `vessel:${mmsi}`);
        const row = rows[0];
        if (!row) return null;
        const entityProps = stripStateHash(row.entity_properties);
        const liveProps = stripStateHash(row.live_properties);
        const speedMps = Number.isFinite(row.speed_mps) ? row.speed_mps : null;
        return {
            layerId: 'vessel',
            id: mmsi,
            name: entityProps.name || row.display_name || null,
            type: row.subtype || 'unknown',
            lat: row.display_lat,
            lng: row.display_lng,
            heading: Number.isFinite(row.heading_deg) ? row.heading_deg : 0,
            speed: speedMps != null ? speedMps / 0.514444 : 0,
            speedMps,
            navigationStatus: entityProps.navigationStatus ?? liveProps.navigationStatus ?? null,
            rateOfTurn: entityProps.rateOfTurn ?? liveProps.rateOfTurn ?? null,
            cog: entityProps.cog ?? liveProps.cog ?? null,
            callSign: entityProps.callSign ?? null,
            imo: entityProps.imo ?? null,
            destination: entityProps.destination ?? null,
            eta: entityProps.eta ?? null,
            draught: entityProps.draught ?? null,
            length: entityProps.length ?? null,
            beam: entityProps.beam ?? null,
        };
    }

    private async getSatelliteDetails(id: string): Promise<Record<string, any> | null> {
        if (!this.database.isReady()) return null;
        const normalized = id.replace(/^sat-/, '').replace(/^satellite:/, '');
        const norad = Number(normalized);
        const result = await this.database.query<SatelliteRow>(
            `
                WITH latest_orbital AS (
                    SELECT DISTINCT ON (oe.entity_id)
                        oe.entity_id,
                        oe.tle_line1,
                        oe.tle_line2,
                        oe.tle_epoch_at,
                        oe.fetched_at,
                        oe.provider,
                        oe.source_publication_at,
                        oe.properties
	                    FROM core.orbital_elements oe
	                    WHERE oe.entity_id LIKE 'satellite:%'
	                      AND COALESCE(oe.tle_epoch_at, oe.observed_at) <= now()
	                    ORDER BY
                        oe.entity_id,
                        COALESCE(oe.tle_epoch_at, oe.observed_at) DESC,
                        COALESCE(oe.fetched_at, oe.created_at) DESC,
                        oe.created_at DESC
                )
                SELECT
                    e.entity_id,
                    e.display_name,
                    e.subtype,
                    e.properties AS entity_properties,
                    lo.tle_line1,
                    lo.tle_line2,
                    lo.tle_epoch_at,
                    lo.fetched_at,
                    lo.provider,
                    lo.source_publication_at,
                    lo.properties AS orbital_properties
                FROM core.entities e
                LEFT JOIN latest_orbital lo ON lo.entity_id = e.entity_id
                WHERE e.layer_id = 'satellite'
                  AND (
                    e.entity_id = $1
                    OR e.entity_id = $2
                    OR (
                        $3::int IS NOT NULL
                        AND (e.properties->>'noradId') ~ '^[0-9]+$'
                        AND (e.properties->>'noradId')::int = $3::int
                    )
                    OR (
                        $3::int IS NOT NULL
                        AND (lo.properties->>'noradId') ~ '^[0-9]+$'
                        AND (lo.properties->>'noradId')::int = $3::int
                    )
                  )
                LIMIT 1
            `,
            [
                id,
                `satellite:${normalized}`,
                Number.isFinite(norad) ? norad : null,
            ],
        );
        const row = result?.rows[0];
        if (!row || !row.tle_line1 || !row.tle_line2) return null;
        const entityProps = stripStateHash(row.entity_properties);
        const orbitalProps = stripStateHash(row.orbital_properties);
        const noradId = Number(entityProps.noradId ?? orbitalProps.noradId ?? norad);
        return {
            layerId: 'satellite',
            id: Number.isFinite(noradId) ? `sat-${noradId}` : row.entity_id,
            name: row.display_name || orbitalProps.name || entityProps.name || row.entity_id,
            noradId: Number.isFinite(noradId) ? noradId : -1,
            type: entityProps.type || row.subtype || orbitalProps.type || 'civilian',
            subtype: row.subtype,
            recon: Boolean(entityProps.recon || orbitalProps.recon),
            reconMeta: entityProps.reconMeta || orbitalProps.reconMeta || null,
            sensor: entityProps.sensor || orbitalProps.sensor || null,
            tleEpochAt: normalizeObservedAt(row.tle_epoch_at),
            fetchedAt: normalizeObservedAt(row.fetched_at),
            provider: row.provider || null,
            sourcePublicationAt: normalizeObservedAt(row.source_publication_at) || null,
        };
    }
}
