import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Spectator Earth sensor metadata service.
 *
 * Spectator Earth publishes a small catalog (~55 satellites as of 2026-04)
 * of Earth-observation satellites with real sensor metadata: swath width,
 * sensor type, platform. This service fetches that catalog once at boot
 * and caches it keyed by NORAD id. The SatelliteService then merges the
 * cached swath data into its /api/satellites response, letting the
 * frontend render honest projected footprint cones for the subset of sats
 * that Spectator knows about.
 *
 * Coverage is intentionally NOT expanded by inventing swath values for
 * satellites Spectator doesn't know — the frontend just skips rendering
 * a footprint in that case. No hardcoded FOV table.
 *
 * API docs: https://api.spectator.earth/ (endpoint /satellite/ returns a
 * GeoJSON FeatureCollection). Auth: api_key query param. Free tier allows
 * a daily refresh comfortably.
 */

export interface SpectatorSensorMeta {
    // Spectator's own catalog id (distinct from NORAD). Kept for debugging
    // and in case we later hit sensor-specific endpoints like overpasses.
    spectatorId: number;
    // Canonical satellite name in Spectator DB — may differ from CelesTrak
    // naming (e.g. "Sentinel-2A" vs "SENTINEL-2A").
    name: string;
    noradId: number;
    // Name of the instrument (e.g. "MODIS", "MSI", "Pleiades"). Shown in
    // the EntityHUD detail card as the data source.
    sensorName: string;
    // Sensor swath width in metres. Value of 0 means Spectator knows the
    // satellite but doesn't have a swath for its current mode — treated
    // as "no footprint" by the frontend.
    sensorSwathMeters: number;
    // Whether the sensor is SAR (side-looking) or optical (nadir). The
    // frontend uses this to tint the projected cone and in the HUD badge.
    sensorType: 'OPTICAL' | 'SAR' | 'OTHER';
    platform: string | null;
    // True when the satellite's imagery is freely accessible (Sentinels,
    // Landsats) — useful for future UI badges.
    open: boolean;
}

const SPECTATOR_SAT_URL = 'https://api.spectator.earth/satellite/';
const SPECTATOR_TTL_MS = 24 * 60 * 60 * 1000;
// Disk cache — survives restarts so we don't hit the API on every reboot.
const SPECTATOR_CACHE_FILE = path.resolve(__dirname, '../../spectator_cache.json');

export class SpectatorService {
    private byNorad: Map<number, SpectatorSensorMeta> = new Map();
    private lastFetch = 0;
    // Guards against parallel refresh requests fired by concurrent
    // lookups when the TTL expires — only the first caller does work,
    // the rest await the same promise.
    private inFlight: Promise<void> | null = null;

    async init() {
        // Try disk cache first — avoids an API call on restart.
        this.loadFromDisk();

        // If disk cache was fresh enough, skip the network fetch.
        if (this.byNorad.size > 0 && this.lastFetch > 0
            && Date.now() - this.lastFetch < SPECTATOR_TTL_MS) {
            const withSwath = Array.from(this.byNorad.values())
                .filter((m) => m.sensorSwathMeters > 0).length;
            console.log(
                `[Spectator] Loaded ${this.byNorad.size} satellites from disk cache ` +
                `(${withSwath} with non-zero swath)`
            );
            return;
        }

        // Disk cache stale or missing — fetch from API.
        await this.refresh();
    }

    async refresh() {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.doRefresh();
        try {
            await this.inFlight;
        } finally {
            this.inFlight = null;
        }
    }

    private loadFromDisk(): void {
        try {
            if (!fs.existsSync(SPECTATOR_CACHE_FILE)) return;
            const raw = JSON.parse(fs.readFileSync(SPECTATOR_CACHE_FILE, 'utf-8'));
            if (!raw?.fetchedAt || !Array.isArray(raw?.entries)) return;
            const map = new Map<number, SpectatorSensorMeta>();
            for (const e of raw.entries) {
                if (typeof e.noradId === 'number') map.set(e.noradId, e);
            }
            this.byNorad = map;
            this.lastFetch = raw.fetchedAt;
        } catch {
            // Corrupt cache — ignore, will fetch from API.
        }
    }

    private saveToDisk(): void {
        try {
            const data = {
                fetchedAt: this.lastFetch,
                entries: Array.from(this.byNorad.values()),
            };
            fs.writeFileSync(SPECTATOR_CACHE_FILE, JSON.stringify(data));
        } catch (err: any) {
            console.warn('[Spectator] Failed to save disk cache:', err?.message);
        }
    }

    private async doRefresh() {
        const key = process.env.SPECTATOR_EARTH_API_KEY;
        if (!key) {
            // Not fatal — the rest of the backend still runs, just without
            // footprint enrichment. Log once so the ops missing config is
            // visible in the boot log.
            console.warn('[Spectator] SPECTATOR_EARTH_API_KEY not set — skipping catalog fetch');
            return;
        }
        try {
            const res = await axios.get(SPECTATOR_SAT_URL, {
                params: { api_key: key },
                timeout: 30_000,
                headers: { 'User-Agent': 'ai-worldview/1.0' },
            });
            const features: any[] = res.data?.features ?? [];
            const next = new Map<number, SpectatorSensorMeta>();
            for (const f of features) {
                const props = f?.properties ?? {};
                const noradId = props.norad_id;
                if (typeof noradId !== 'number') continue;

                // Spectator returns a `modes` array with one or more sensor
                // profiles per satellite (e.g. MODIS has one, Sentinel-2
                // could have several). Prefer the first mode with a real
                // (>0) swath; otherwise fall back to the first mode so we
                // still capture sensor_name/type for the HUD.
                const modes: any[] = Array.isArray(props.modes) ? props.modes : [];
                const modeWithSwath = modes.find((m) => typeof m?.swath === 'number' && m.swath > 0);
                const chosen = modeWithSwath ?? modes[0] ?? null;

                // Normalise sensor type — Spectator returns uppercase
                // "OPTICAL" / "SAR" strings. Anything else (including
                // missing mode) is flagged as "OTHER" so downstream code
                // can detect and skip it.
                const rawType = chosen?.sensor_type;
                const sensorType: SpectatorSensorMeta['sensorType'] =
                    rawType === 'OPTICAL' || rawType === 'SAR' ? rawType : 'OTHER';

                next.set(noradId, {
                    spectatorId: f.id,
                    name: props.name ?? '',
                    noradId,
                    sensorName: chosen?.name ?? '',
                    sensorSwathMeters: typeof chosen?.swath === 'number' ? chosen.swath : 0,
                    sensorType,
                    platform: props.platform ?? null,
                    open: !!props.open,
                });
            }
            this.byNorad = next;
            this.lastFetch = Date.now();
            this.saveToDisk();
            const withSwath = Array.from(next.values()).filter((m) => m.sensorSwathMeters > 0).length;
            console.log(`[Spectator] Loaded ${next.size} satellites (${withSwath} with non-zero swath)`);
        } catch (err: any) {
            console.warn('[Spectator] fetch failed:', err?.message || err);
            // Back off for 1 hour to avoid retry storms when API is down.
            // Without this, every getMeta() call retriggers a fetch because
            // lastFetch stays at its old value and the TTL check always fires.
            this.lastFetch = Date.now() - SPECTATOR_TTL_MS + 3600_000;
        }
    }

    /**
     * Lookup sensor metadata for a satellite by its NORAD catalog number.
     * Returns undefined if the satellite isn't in Spectator's database.
     *
     * Also acts as the lazy-refresh trigger: if the cached catalog is older
     * than SPECTATOR_TTL_MS, this kicks off a fire-and-forget background
     * refresh (still inside the main process — no worker, no cron). The
     * current lookup still returns from the stale cache immediately so
     * callers never block on network I/O.
     */
    getMeta(noradId: number): SpectatorSensorMeta | undefined {
        if (this.lastFetch > 0 && Date.now() - this.lastFetch > SPECTATOR_TTL_MS) {
            // Fire-and-forget refresh. inFlight guard inside refresh()
            // prevents parallel fetches when multiple lookups race.
            this.refresh().catch((err) => {
                console.warn('[Spectator] lazy refresh failed:', err?.message || err);
            });
        }
        return this.byNorad.get(noradId);
    }

    /**
     * All NORAD ids Spectator knows about. Used by SatelliteService to
     * force-include these satellites in its output even when they don't
     * match the default classification filter (Spectator's catalog is
     * mostly civilian EO, which our filter normally drops).
     */
    getKnownNorads(): number[] {
        return Array.from(this.byNorad.keys());
    }

    /** Timestamp of last successful refresh (0 if never). */
    getLastFetchTime(): number {
        return this.lastFetch;
    }
}
