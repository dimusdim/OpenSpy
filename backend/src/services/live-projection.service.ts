import { DatabaseService } from '../db/database.service';
import type { DisasterEvent } from './live-stream.service';
import { getPublicSourceLiveContract } from './live-contracts';
import type { FireRecord } from './extended.service';
import type { JammingZone } from './gpsjam.service';
import type { OutageRecord } from './ioda.service';
import type { CloudflareOutage } from './cloudflare.service';
import type { ConflictEvent } from './acled.service';
import type { GdeltConflictEvent } from './gdelt.service';
import type { AirspaceZone, AirspacePolygon } from './airspace.service';
import type { GFWEvent } from './gfw.service';
import type { PipelineRecord } from './infrastructure.service';
import type { SatelliteRecord } from './satellite.service';

export type LiveAircraftRecord = {
    id: string;
    icao24: string;
    callsign: string;
    origin: string;
    lat: number;
    lng: number;
    altMeters: number | null;
    alt: number;
    heading: number;
    type: string;
    speedMps: number | null;
    speed: number;
    onGround: boolean;
    verticalRate: number | null;
    squawk: string | null;
    lastContact: number | null;
};

export type LiveVesselRecord = {
    id: string;
    lat: number;
    lng: number;
    heading: number;
    type: string;
    speed: number;
    navigationStatus: string | null;
    rateOfTurn: number | null;
    cog: number | null;
    name: string | null;
    callSign: string | null;
    imo: number | null;
    destination: string | null;
    eta: string | null;
    draught: number | null;
    length: number | null;
    beam: number | null;
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

function lineGeometryToLatLngPairs(geometry: any): [number, number][] {
    if (!geometry || typeof geometry !== 'object') return [];
    if (geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return [];
    return geometry.coordinates
        .map((point: unknown) => {
            const [lng, lat] = point as [number, number];
            return [lat, lng] as [number, number];
        })
        .filter((point: [number, number]) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

export class LiveProjectionService {
    constructor(private readonly database: DatabaseService) {}

    isReady(): boolean {
        return this.database.isReady();
    }

    private async listLatestEvents(layerId: string, sourceId?: string | null, limit = 200000): Promise<EventRow[]> {
        if (!this.database.isReady()) return [];

        const params: unknown[] = [layerId];
        let sourceWhere = '';
        if (sourceId) {
            params.push(sourceId);
            sourceWhere = `AND e.source_id = $${params.length}`;
        }
        params.push(limit);

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
                ORDER BY COALESCE(e.observed_at, e.updated_at) DESC NULLS LAST, e.updated_at DESC
                LIMIT $${params.length}
            `,
            params,
        );

        return result?.rows || [];
    }

    private async listLatestAssets(layerId: string, sourceId?: string | null, limit = 100000): Promise<AssetRow[]> {
        if (!this.database.isReady()) return [];

        const params: unknown[] = [layerId];
        let sourceWhere = '';
        if (sourceId) {
            params.push(sourceId);
            sourceWhere = `AND a.source_id = $${params.length}`;
        }
        params.push(limit);

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
                LIMIT $${params.length}
            `,
            params,
        );

        return result?.rows || [];
    }

    private async listLatestSatellites(limit?: number | null): Promise<SatelliteRow[]> {
        if (!this.database.isReady()) return [];

        const sql = `
                WITH latest_orbital AS (
                    SELECT DISTINCT ON (oe.entity_id)
                        oe.entity_id,
                        oe.tle_line1,
                        oe.tle_line2,
                        oe.properties
                    FROM core.orbital_elements oe
                    WHERE oe.entity_id LIKE 'satellite:%'
                    ORDER BY oe.entity_id, oe.observed_at DESC, oe.created_at DESC
                )
                SELECT
                    e.entity_id,
                    e.display_name,
                    e.subtype,
                    e.properties AS entity_properties,
                    lo.tle_line1,
                    lo.tle_line2,
                    lo.properties AS orbital_properties
                FROM core.entities e
                LEFT JOIN latest_orbital lo ON lo.entity_id = e.entity_id
                WHERE e.layer_id = 'satellite'
                ORDER BY COALESCE(e.last_observed_at, e.updated_at) DESC NULLS LAST, e.updated_at DESC
                ${limit != null ? 'LIMIT $1' : ''}
            `;

        const result = await this.database.query<SatelliteRow>(
            sql,
            limit != null ? [limit] : [],
        );

        return result?.rows || [];
    }

    private async listLiveEntities(layerId: string, maxAgeSeconds: number, limit = 50000): Promise<EntityLiveRow[]> {
        if (!this.database.isReady()) return [];

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
                ORDER BY ls.observed_at DESC, ls.updated_at DESC
                LIMIT $3
            `,
            [layerId, maxAgeSeconds, limit],
        );

        return result?.rows || [];
    }

    private getSourceRemovalWindowSeconds(sourceId: string, fallbackSeconds: number): number {
        const contract = getPublicSourceLiveContract(sourceId);
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
                ...props,
                id: props.id || row.event_id.replace(/^disaster:/, ''),
                lat: Number.isFinite(props.lat) ? props.lat : row.display_lat,
                lng: Number.isFinite(props.lng) ? props.lng : row.display_lng,
                startTime: props.startTime || observedAt,
                geometry: props.geometry || row.geometry || null,
            } as DisasterEvent;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getFires(): Promise<FireRecord[]> {
        const rows = await this.listLatestEvents('fire');
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            return {
                ...props,
                id: props.id || row.event_id,
                lat: Number.isFinite(props.lat) ? props.lat : row.display_lat,
                lng: Number.isFinite(props.lng) ? props.lng : row.display_lng,
            } as FireRecord;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
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
                id: props.id || `jam-${props.h3Index || row.event_id}`,
                lat: Number.isFinite(props.lat) ? props.lat : row.display_lat,
                lng: Number.isFinite(props.lng) ? props.lng : row.display_lng,
                boundary,
                countGood: props.countGood ?? 0,
                countBad: props.countBad ?? 0,
                ratio: props.ratio ?? 0,
                intensity: props.intensity || row.subtype || 'low',
                h3Index: props.h3Index || row.event_id.replace(/^jamming:/, ''),
            } as JammingZone;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getIodaOutages(): Promise<OutageRecord[]> {
        const rows = await this.listLatestEvents('outage', 'ioda', 10000);
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            return {
                id: row.event_id.replace(/^outage:ioda:/, ''),
                country: props.country || '',
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
        const rows = await this.listLatestEvents('outage', 'cloudflare_radar', 10000);
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            return {
                id: row.event_id.replace(/^outage:cloudflare:/, ''),
                startDate: observedAt,
                endDate: props.endDate || '',
                scope: props.scope || '',
                asn: props.asn || 0,
                asnName: props.asnName || '',
                locations: Array.isArray(props.locations) ? props.locations : [],
                outageType: props.outageType || row.subtype || '',
                outageCause: props.outageCause || '',
            } as CloudflareOutage;
        });
    }

    async getAcledConflicts(): Promise<ConflictEvent[]> {
        const rows = await this.listLatestEvents('conflict', 'acled', 5000);
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            return {
                id: row.event_id.replace(/^conflict:acled:/, ''),
                lat: row.display_lat ?? 0,
                lng: row.display_lng ?? 0,
                event_type: props.eventType || '',
                sub_event_type: props.subEventType || row.subtype || '',
                fatalities: props.fatalities || 0,
                country: props.country || '',
                actor1: props.actor1 || '',
                actor2: props.actor2 || '',
                event_date: observedAt ? observedAt.slice(0, 10) : '',
                notes: props.notes || '',
            } as ConflictEvent;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getGdeltConflicts(): Promise<GdeltConflictEvent[]> {
        const rows = await this.listLatestEvents('conflict', 'gdelt', 5000);
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            const observed = observedAt ? observedAt.slice(0, 10).replace(/-/g, '') : '';
            return {
                id: row.event_id.replace(/^conflict:gdelt:/, ''),
                lat: row.display_lat ?? 0,
                lng: row.display_lng ?? 0,
                date: observed,
                eventCode: props.eventCode || '',
                rootCode: props.rootCode || '',
                eventType: props.eventType || '',
                subEventType: props.subEventType || row.subtype || '',
                actor1: props.actor1 || '',
                actor2: props.actor2 || '',
                goldstein: props.goldstein || 0,
                numMentions: props.numMentions || 0,
                numSources: props.numSources || 0,
                sourceUrl: props.sourceUrl || '',
                country: props.country || '',
                location: props.location || '',
            } as GdeltConflictEvent;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getGfwEvents(): Promise<GFWEvent[]> {
        const rows = await this.listLatestEvents('gfw', 'gfw', 5000);
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            const observedAt = normalizeObservedAt(row.observed_at);
            return {
                id: row.event_id.replace(/^gfw:/, ''),
                lat: row.display_lat ?? 0,
                lng: row.display_lng ?? 0,
                type: row.subtype || 'gap',
                start: observedAt,
                end: props.end || '',
                vesselId: props.vesselId || '',
                vesselName: props.vesselName || '',
                flagState: props.flagState || '',
                confidence: props.confidence ?? null,
                duration: props.duration ?? null,
                vesselOwner: props.vesselOwner ?? null,
                vesselMmsi: props.vesselMmsi ?? null,
                vesselType: props.vesselType ?? null,
            } as GFWEvent;
        }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getAirspaceZones(): Promise<AirspaceZone[]> {
        const rows = await this.listLatestAssets('airspace', 'openaip', 50000);
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

    async getPipelines(): Promise<PipelineRecord[]> {
        const rows = await this.listLatestAssets('pipeline', 'osm_pipelines', 50000);
        return rows.map((row) => {
            const props = stripStateHash(row.properties);
            return {
                id: row.asset_id.replace(/^pipeline:/, ''),
                name: props.name || row.display_name || '',
                substance: props.substance || row.subtype || 'oil',
                coordinates: lineGeometryToLatLngPairs(row.geometry),
            } as PipelineRecord;
        }).filter((row) => row.coordinates.length >= 2);
    }

    async getCables(): Promise<any> {
        const rows = await this.listLatestAssets('cable', 'telegeography', 10000);
        return {
            type: 'FeatureCollection',
            features: rows
                .filter((row) => row.geometry)
                .map((row) => ({
                    type: 'Feature',
                    properties: {
                        ...stripStateHash(row.properties),
                        id: row.asset_id,
                    },
                    geometry: row.geometry,
                })),
        };
    }

    async getAircraftLive(): Promise<LiveAircraftRecord[]> {
        const rows = await this.listLiveEntities('aircraft', this.getSourceRemovalWindowSeconds('opensky', 300), 25000);
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
                    onGround: Boolean(entityProps.onGround ?? liveProps.onGround ?? false),
                    verticalRate: entityProps.verticalRate ?? liveProps.verticalRate ?? null,
                    squawk: entityProps.squawk ?? liveProps.squawk ?? null,
                    lastContact: Number.isFinite(lastContactMs) ? Math.floor(lastContactMs / 1000) : null,
                } as LiveAircraftRecord;
            })
            .filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    }

    async getVesselsLive(): Promise<LiveVesselRecord[]> {
        const rows = await this.listLiveEntities('vessel', this.getSourceRemovalWindowSeconds('aisstream', 1800), 60000);
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
                    navigationStatus: entityProps.navigationStatus ?? liveProps.navigationStatus ?? null,
                    rateOfTurn: entityProps.rateOfTurn ?? liveProps.rateOfTurn ?? null,
                    cog: entityProps.cog ?? liveProps.cog ?? null,
                    name: entityProps.name || row.display_name || null,
                    callSign: entityProps.callSign ?? null,
                    imo: entityProps.imo ?? null,
                    destination: entityProps.destination ?? null,
                    eta: entityProps.eta ?? null,
                    draught: entityProps.draught ?? null,
                    length: entityProps.length ?? null,
                    beam: entityProps.beam ?? null,
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
}
