import axios from 'axios';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface InfraRecord {
  id: string;
  lat: number;
  lng: number;
  name: string;
  type: 'power_plant' | 'refinery' | 'desalination' | 'military';
  subtype?: string;
}

export interface PipelineRecord {
  id: string;
  name: string;
  substance: 'oil' | 'gas';
  coordinates: [number, number][];
}

export interface PowerInfraRecord {
  id: string;
  lat: number;
  lng: number;
  name: string;
  type: 'power_plant' | 'power_line' | 'power_substation';
  source: string;          // e.g. "solar", "nuclear", "wind"
  voltage?: string;
  coordinates?: [number, number][];  // for power lines (polyline geometry)
}

// ---------------------------------------------------------------------------
// Overpass helpers
// ---------------------------------------------------------------------------

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Round coordinate to 1-degree grid for cache key */
function tileKey(south: number, west: number, north: number, east: number): string {
  const s = Math.floor(south);
  const w = Math.floor(west);
  const n = Math.ceil(north);
  const e = Math.ceil(east);
  return `${s},${w},${n},${e}`;
}

// ---------------------------------------------------------------------------
// InfrastructureService
// ---------------------------------------------------------------------------

export class InfrastructureService {
  // Infrastructure cache: key = tileKey, value = { data, timestamp }
  private infraCache = new Map<string, { data: InfraRecord[]; ts: number }>();
  private readonly INFRA_TTL = 60 * 60 * 1000; // 1 hour

  // OpenInfraMap power infrastructure cache: key = bbox string, value = { data, timestamp }
  private powerInfraCache = new Map<string, { data: PowerInfraRecord[]; ts: number }>();
  private readonly POWER_INFRA_TTL = 60 * 60 * 1000; // 1 hour

  // Pipeline cache (global, fetched once)
  private pipelinesCache: PipelineRecord[] | null = null;
  private pipelinesCacheTs = 0;
  private readonly PIPELINES_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private pipelinesFetching = false;

  // -----------------------------------------------------------------------
  // Critical Infrastructure (per-bbox)
  // -----------------------------------------------------------------------

  async getInfrastructure(south: number, west: number, north: number, east: number): Promise<InfraRecord[]> {
    const key = tileKey(south, west, north, east);
    const cached = this.infraCache.get(key);
    if (cached && Date.now() - cached.ts < this.INFRA_TTL) {
      return cached.data;
    }

    // Use the rounded tile bbox for the Overpass query to maximise cache hits
    const s = Math.floor(south);
    const w = Math.floor(west);
    const n = Math.ceil(north);
    const e = Math.ceil(east);
    const bbox = `${s},${w},${n},${e}`;

    const query = `
[out:json][timeout:25];
(
  nwr["power"="plant"](${bbox});
  nwr["industrial"="refinery"](${bbox});
  nwr["man_made"="desalination_plant"](${bbox});
  nwr["landuse"="military"](${bbox});
  nwr["military"="airfield"](${bbox});
  nwr["military"="naval_base"](${bbox});
  nwr["military"="base"](${bbox});
);
out center;`.trim();

    try {
      console.log(`[Infrastructure] Querying Overpass for bbox ${bbox}...`);
      const { data } = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30_000,
      });

      const records: InfraRecord[] = [];
      for (const el of data.elements ?? []) {
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat == null || lng == null) continue;

        const tags = el.tags ?? {};
        let type: InfraRecord['type'];
        let subtype: string | undefined;

        if (tags['power'] === 'plant') {
          type = 'power_plant';
          subtype = tags['plant:source'] || tags['generator:source'] || undefined;
        } else if (tags['industrial'] === 'refinery') {
          type = 'refinery';
          subtype = tags['product'] || undefined;
        } else if (tags['man_made'] === 'desalination_plant') {
          type = 'desalination';
        } else if (tags['landuse'] === 'military' || tags['military']) {
          type = 'military';
          subtype = tags['military'] || 'facility';
        } else {
          continue;
        }

        const name = tags['name'] || tags['name:en'] || tags['operator'] || type;
        records.push({
          id: `infra-${el.type}-${el.id}`,
          lat,
          lng,
          name,
          type,
          subtype,
        });
      }

      this.infraCache.set(key, { data: records, ts: Date.now() });
      console.log(`[Infrastructure] Loaded ${records.length} records for bbox ${bbox}`);
      return records;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Infrastructure] Overpass query failed: ${msg}`);
      // Return cached data if available (even if stale)
      return cached?.data ?? [];
    }
  }

  // -----------------------------------------------------------------------
  // OpenInfraMap Power Infrastructure (per-bbox, cached 1h)
  // -----------------------------------------------------------------------

  async getPowerInfra(bbox: string): Promise<PowerInfraRecord[]> {
    const cached = this.powerInfraCache.get(bbox);
    if (cached && Date.now() - cached.ts < this.POWER_INFRA_TTL) {
      return cached.data;
    }

    const url = `https://openinframap.org/api/features?bbox=${bbox}&layer=power_plant,power_line,power_substation`;

    try {
      console.log(`[PowerInfra] Fetching OpenInfraMap for bbox ${bbox}...`);
      const { data } = await axios.get(url, { timeout: 30_000 });

      const records: PowerInfraRecord[] = [];

      // OpenInfraMap returns GeoJSON FeatureCollection
      const features = data?.features ?? data ?? [];
      for (const feature of features) {
        const props = feature.properties ?? {};
        const geom = feature.geometry;
        if (!geom) continue;

        let type: PowerInfraRecord['type'];
        if (props.type === 'plant' || props.power === 'plant') {
          type = 'power_plant';
        } else if (props.type === 'line' || props.power === 'line') {
          type = 'power_line';
        } else if (props.type === 'substation' || props.power === 'substation') {
          type = 'power_substation';
        } else {
          // Infer from geometry: lines are typically LineString
          if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
            type = 'power_line';
          } else {
            type = 'power_substation';
          }
        }

        const id = `pwr-${feature.id ?? records.length}`;
        const name = props.name || props.operator || type.replace('_', ' ');
        const source = props.source || props['plant:source'] || props['generator:source'] || '';
        const voltage = props.voltage || '';

        if (geom.type === 'Point') {
          records.push({
            id,
            lat: geom.coordinates[1],
            lng: geom.coordinates[0],
            name,
            type,
            source,
            voltage,
          });
        } else if (geom.type === 'LineString') {
          const coords: [number, number][] = geom.coordinates.map((c: number[]) => [c[1], c[0]]);
          // Use midpoint for marker position
          const mid = coords[Math.floor(coords.length / 2)];
          records.push({
            id,
            lat: mid[0],
            lng: mid[1],
            name,
            type,
            source,
            voltage,
            coordinates: coords,
          });
        } else if (geom.type === 'MultiLineString') {
          for (let li = 0; li < geom.coordinates.length; li++) {
            const coords: [number, number][] = geom.coordinates[li].map((c: number[]) => [c[1], c[0]]);
            const mid = coords[Math.floor(coords.length / 2)];
            records.push({
              id: `${id}-${li}`,
              lat: mid[0],
              lng: mid[1],
              name,
              type,
              source,
              voltage,
              coordinates: coords,
            });
          }
        } else if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
          // Use centroid approximation from first ring
          const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
          if (ring && ring.length > 0) {
            let sumLat = 0, sumLng = 0;
            for (const c of ring) { sumLng += c[0]; sumLat += c[1]; }
            records.push({
              id,
              lat: sumLat / ring.length,
              lng: sumLng / ring.length,
              name,
              type,
              source,
              voltage,
            });
          }
        }
      }

      this.powerInfraCache.set(bbox, { data: records, ts: Date.now() });
      console.log(`[PowerInfra] Loaded ${records.length} records for bbox ${bbox}`);
      return records;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PowerInfra] OpenInfraMap query failed: ${msg}`);
      return cached?.data ?? [];
    }
  }

  // -----------------------------------------------------------------------
  // Pipelines (global fetch, cached 24h)
  // -----------------------------------------------------------------------

  async getPipelines(): Promise<PipelineRecord[]> {
    if (this.pipelinesCache && Date.now() - this.pipelinesCacheTs < this.PIPELINES_TTL) {
      return this.pipelinesCache;
    }

    // Prevent concurrent fetches
    if (this.pipelinesFetching) {
      return this.pipelinesCache ?? [];
    }
    this.pipelinesFetching = true;

    try {
      console.log('[Pipelines] Querying Overpass for global oil & gas pipelines...');

      // Query one focused region at a time — full geometry for thousands of
      // ways is heavy. Use a single Middle East bbox (most strategically
      // important), with increased maxsize and timeout.
      const oilQuery = `[out:json][timeout:120][maxsize:104857600];
way["man_made"="pipeline"]["substance"="oil"](20,30,42,60);
out geom;`;

      const gasQuery = `[out:json][timeout:120][maxsize:104857600];
way["man_made"="pipeline"]["substance"="gas"](20,30,42,60);
out geom;`;

      const [oilRes, gasRes] = await Promise.allSettled([
        axios.post(OVERPASS_URL, `data=${encodeURIComponent(oilQuery)}`, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 180_000,
        }),
        axios.post(OVERPASS_URL, `data=${encodeURIComponent(gasQuery)}`, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 180_000,
        }),
      ]);

      const records: PipelineRecord[] = [];

      const processResult = (result: PromiseSettledResult<any>, substance: 'oil' | 'gas') => {
        if (result.status !== 'fulfilled') {
          console.warn(`[Pipelines] ${substance} query failed:`, result.reason?.message ?? result.reason);
          return;
        }
        const elements = result.value.data?.elements ?? [];
        for (const el of elements) {
          if (!el.geometry?.length || el.geometry.length < 2) continue;
          const coords: [number, number][] = el.geometry.map((pt: any) => [pt.lat, pt.lon]);
          const tags = el.tags ?? {};
          records.push({
            id: `pipe-${el.id}`,
            name: tags['name'] || tags['operator'] || `${substance} pipeline`,
            substance,
            coordinates: coords,
          });
        }
      };

      processResult(oilRes, 'oil');
      processResult(gasRes, 'gas');

      this.pipelinesCache = records;
      this.pipelinesCacheTs = Date.now();
      console.log(`[Pipelines] Loaded ${records.length} pipelines (oil+gas)`);
      return records;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pipelines] Failed: ${msg}`);
      return this.pipelinesCache ?? [];
    } finally {
      this.pipelinesFetching = false;
    }
  }
}
