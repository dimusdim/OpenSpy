import axios from 'axios';
import { SourcePersistenceService } from './source-persistence.service';

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

// Public Overpass mirrors. When the primary one is overloaded (which happens
// every few hours, especially during European working hours), it returns an
// HTTP 200 with an HTML error page like:
//   <p><strong style="color:#FF0000">Error</strong>: runtime error: ...
// axios doesn't throw on 200, so without explicit detection we'd silently
// cache an empty response. We try each mirror in order until one returns
// parseable JSON. Two mirrors is enough: the primary plus Kumi — we kept
// more initially but the total fallback latency made downstream requests
// time out on the client side.
// Mirror order matters: the chain is tried top-to-bottom, so the working
// mirror should be first to avoid paying the timeout/connect cost of a
// dead one on every request. As of this audit (April 2026)
// `overpass-api.de` is unreachable from our dev network — TCP SYNs go
// into the void and every request wastes ~500 ms before falling through.
// Kumi is the authoritative mirror we're actually using; overpass-api.de
// remains as a tertiary fallback in case Kumi rate-limits or goes down.
const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

// Descriptive User-Agent for the Overpass calls. Kumi returns HTTP 429 with
// body "Please include a meaningful User-Agent string with your requests to
// avoid rate-limiting" when the client omits or sends a generic UA, and the
// error was previously bubbling up as a fast "upstream Overpass unavailable"
// 502 because both mirrors failed within a second. Sending a real UA that
// names the app + contact source repo is the documented way to stay out of
// the rate-limit bucket on the public mirrors. OpenStreetMap's Overpass usage
// policy asks for this header on every request.
const OVERPASS_USER_AGENT =
  'ai-worldview/1.0 (OSINT command center; https://github.com/anthropics/claude-code-issues)';

/**
 * Execute an Overpass query against the public mirrors until one succeeds.
 * Throws if every mirror either returns non-JSON or errors out, so the
 * caller's catch branch can surface a real failure to health state instead
 * of caching an empty array.
 */
async function overpassQuery(query: string, label: string, perCallTimeoutMs = 12_000): Promise<any> {
  let lastErr: unknown = null;
  for (const url of OVERPASS_MIRRORS) {
    try {
      const { data } = await axios.post(url, `data=${encodeURIComponent(query)}`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Kumi mirror specifically returns HTTP 429 for requests without
          // a meaningful UA. Identifying the app here prevents the whole
          // fallback chain from collapsing to "upstream unavailable" on
          // networks where the primary overpass-api.de host is unreachable.
          'User-Agent': OVERPASS_USER_AGENT,
        },
        timeout: perCallTimeoutMs,
        // axios defaults to string for non-JSON; ask for JSON so it parses
        // when the server sets the right content-type, and throws otherwise.
        responseType: 'json',
        // Treat only 2xx as success — any 4xx/5xx from the mirror should
        // fall through to the next one.
        validateStatus: (s) => s >= 200 && s < 300,
        // Hard cap on response size. A 3°×3° power-infra query can easily
        // hit ~27 MB and crash the backend at 50k+ features. 50 MB is
        // generous enough for legitimate infra queries and small enough
        // to fail fast if someone probes the API with an overly wide
        // query (we also reject by sq.deg area at the Express layer).
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024,
      });
      // Overpass returns 200 with an HTML body when overloaded. Detect both
      // the parsed-string case and the parsed-object-without-elements case.
      if (typeof data === 'string') {
        throw new Error(`non-JSON response (HTML?) from ${url}`);
      }
      if (!data || typeof data !== 'object') {
        throw new Error(`unexpected response shape from ${url}`);
      }
      if (!Array.isArray((data as any).elements)) {
        // Might be an error envelope like {remark: "runtime error: ..."}.
        const remark = (data as any).remark;
        if (remark) throw new Error(`Overpass remark: ${remark}`);
        throw new Error(`no 'elements' array in response from ${url}`);
      }
      return data;
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${label}] Overpass mirror ${url} failed: ${msg}`);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`All Overpass mirrors failed for ${label}`);
}

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
  // LRU-capped via insertion-order Map; oldest tiles evicted when size exceeds MAX_CACHE_SIZE.
  private infraCache = new Map<string, { data: InfraRecord[]; ts: number }>();
  private readonly INFRA_TTL = 60 * 60 * 1000; // 1 hour
  private readonly MAX_CACHE_SIZE = 500;

  // OpenInfraMap power infrastructure cache: key = bbox string, value = { data, timestamp }
  private powerInfraCache = new Map<string, { data: PowerInfraRecord[]; ts: number }>();
  private readonly POWER_INFRA_TTL = 60 * 60 * 1000; // 1 hour

  // Periodic prune of expired entries every 10 minutes (both caches)
  constructor(private readonly persistence?: SourcePersistenceService) {
    setInterval(() => this.pruneExpired(), 10 * 60 * 1000);
  }

  private pruneExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.infraCache) {
      if (now - entry.ts > this.INFRA_TTL) {
        this.infraCache.delete(key);
        removed++;
      }
    }
    for (const [key, entry] of this.powerInfraCache) {
      if (now - entry.ts > this.POWER_INFRA_TTL) {
        this.powerInfraCache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[Infrastructure] Pruned ${removed} expired cache entries`);
    }
  }

  private enforceCacheCap<T>(cache: Map<string, T>) {
    while (cache.size > this.MAX_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
      else break;
    }
  }

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

    // Server-side timeout well above the typical heavy query (7 nwr + one
    // bbox can easily take 20+ s). Keep client timeout in overpassQuery
    // above this so the mirror gets a chance to finish; shorter client
    // timeouts caused silent empty-elements responses before.
    const query = `
[out:json][timeout:60];
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
      // Give the mirror up to 65 s (server-side timeout is 60 s). Anything
      // shorter risks aborting right as Overpass is assembling the result.
      const data = await overpassQuery(query, 'Infrastructure', 65_000);

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
      this.enforceCacheCap(this.infraCache);
      console.log(`[Infrastructure] Loaded ${records.length} records for bbox ${bbox}`);
      return records;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Infrastructure] Overpass query failed: ${msg}`);
      // Stale cache fallback: if we have ANY previously-cached data for this
      // tile, return it so the client keeps seeing something. Otherwise
      // propagate the error so the HTTP endpoint can respond 502 instead of
      // silently masking the upstream failure as "no data".
      if (cached?.data) {
        console.warn(`[Infrastructure] Serving stale cache for ${bbox} after upstream fail`);
        return cached.data;
      }
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  // -----------------------------------------------------------------------
  // Power Infrastructure via Overpass (per-bbox, cached 1h)
  //
  // Historically this hit `openinframap.org/api/features`, but that endpoint
  // returns 404 now — OpenInfraMap explicitly directs callers back to OSM
  // Overpass for data access. We query the same OSM tags OpenInfraMap
  // consumes (`power=plant`, `power=line`, `power=substation`) directly.
  // The frontend format is preserved so the consuming Cesium layer doesn't
  // change.
  // -----------------------------------------------------------------------

  async getPowerInfra(bbox: string): Promise<PowerInfraRecord[]> {
    const cached = this.powerInfraCache.get(bbox);
    if (cached && Date.now() - cached.ts < this.POWER_INFRA_TTL) {
      return cached.data;
    }

    // bbox arrives as "west,south,east,north" per the API contract (the
    // Express endpoint already validated ordering and range via parseBbox).
    // Overpass wants "south,west,north,east" so swap here.
    const parts = bbox.split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      throw new Error(`Invalid bbox string for PowerInfra: ${bbox}`);
    }
    const [w, s, e, n] = parts;
    const overpassBbox = `${s},${w},${n},${e}`;

    const query = `
[out:json][timeout:60];
(
  nwr["power"="plant"](${overpassBbox});
  nwr["power"="substation"](${overpassBbox});
  way["power"="line"](${overpassBbox});
);
out center tags geom;`.trim();

    try {
      console.log(`[PowerInfra] Querying Overpass for bbox ${overpassBbox}...`);
      const data = await overpassQuery(query, 'PowerInfra', 65_000);

      const records: PowerInfraRecord[] = [];
      for (const el of data.elements ?? []) {
        const tags = el.tags ?? {};
        let type: PowerInfraRecord['type'];
        if (tags['power'] === 'plant') {
          type = 'power_plant';
        } else if (tags['power'] === 'substation') {
          type = 'power_substation';
        } else if (tags['power'] === 'line') {
          type = 'power_line';
        } else {
          continue;
        }

        const id = `pwr-${el.type}-${el.id}`;
        const name = tags['name'] || tags['operator'] || type.replace('_', ' ');
        const source = tags['plant:source'] || tags['generator:source'] || tags['substation'] || '';
        const voltage = tags['voltage'] || '';

        if (type === 'power_line') {
          // Expect `way` with geom array: [{lat, lon}, ...]
          const geom: Array<{ lat: number; lon: number }> = el.geometry ?? [];
          if (geom.length < 2) continue;
          const coords: [number, number][] = geom.map((g) => [g.lat, g.lon]);
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
        } else {
          // Point: prefer .lat/.lon (node), fall back to .center (way/relation)
          const lat = el.lat ?? el.center?.lat;
          const lng = el.lon ?? el.center?.lon;
          if (lat == null || lng == null) continue;
          records.push({
            id,
            lat,
            lng,
            name,
            type,
            source,
            voltage,
          });
        }
      }

      this.powerInfraCache.set(bbox, { data: records, ts: Date.now() });
      this.enforceCacheCap(this.powerInfraCache);
      console.log(`[PowerInfra] Loaded ${records.length} records for bbox ${overpassBbox}`);
      return records;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PowerInfra] Overpass query failed: ${msg}`);
      if (cached?.data) {
        console.warn(`[PowerInfra] Serving stale cache for ${bbox} after upstream fail`);
        return cached.data;
      }
      throw err instanceof Error ? err : new Error(msg);
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

      // Route both pipeline queries through the mirror fallback helper so
      // one mirror being busy doesn't blow away the whole result set.
      const [oilRes, gasRes] = await Promise.allSettled([
        overpassQuery(oilQuery, 'Pipelines/oil', 180_000),
        overpassQuery(gasQuery, 'Pipelines/gas', 180_000),
      ]);

      const records: PipelineRecord[] = [];

      const processResult = (result: PromiseSettledResult<any>, substance: 'oil' | 'gas') => {
        if (result.status !== 'fulfilled') {
          console.warn(`[Pipelines] ${substance} query failed:`, result.reason?.message ?? result.reason);
          return;
        }
        const elements = result.value?.elements ?? [];
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
      await this.persistence?.persistPipelines(records);
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
