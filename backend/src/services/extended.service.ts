import axios from 'axios';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface CableFeature {
  type: string;
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: number[][] | number[][][] };
}

interface CableGeoJSON {
  type: string;
  features: CableFeature[];
}

interface FireRecord {
  id: string;
  lat: number;
  lng: number;
  brightness: number;
  confidence: string;
  frp: number;
  source: string;
}

interface AirQualityRecord {
  id: string;
  lat: number;
  lng: number;
  name: string;
  country: string;
  parameters: unknown[];
  lastUpdated: string;
  source: string;
}

// ---------------------------------------------------------------------------
// ExtendedDataService
// ---------------------------------------------------------------------------

export class ExtendedDataService {
  private cables: CableGeoJSON | null = null;
  private fires: FireRecord[] = [];
  private airQuality: AirQualityRecord[] = [];
  private firesInterval: ReturnType<typeof setInterval> | null = null;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    console.log('[ExtendedDataService] Starting extended data feeds...');

    // Fire all initial fetches in parallel — failures are logged, not thrown.
    await Promise.allSettled([
      this.fetchCables(),
      this.fetchFires(),
    ]);

    // Periodic polling
    this.firesInterval = setInterval(() => {
      this.fetchFires().catch(() => {});
    }, 30 * 60 * 1000); // 30 min

    console.log('[ExtendedDataService] All feeds initialised.');
  }

  getCables(): CableGeoJSON | null {
    return this.cables;
  }

  getFires(): FireRecord[] {
    return this.fires;
  }

  getAirQuality(): AirQualityRecord[] {
    return this.airQuality;
  }

  // -----------------------------------------------------------------------
  // Submarine Cables (static, fetched once)
  // -----------------------------------------------------------------------

  private async fetchCables(): Promise<void> {
    // TeleGeography removed their GitHub repo; the live site still serves the API.
    const url = 'https://www.submarinecablemap.com/api/v3/cable/cable-geo.json';
    try {
      const { data } = await axios.get<CableGeoJSON>(url, { timeout: 30_000 });
      this.cables = data;
      const count = data?.features?.length ?? 0;
      console.log(`[ExtendedDataService] Cables loaded: ${count} features`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ExtendedDataService] Failed to fetch cables: ${msg}`);
    }
  }

  // -----------------------------------------------------------------------
  // NASA FIRMS Active Fires (polled every 30 min)
  // -----------------------------------------------------------------------

  private async fetchFires(): Promise<void> {
    const url =
      'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv';
    try {
      const { data } = await axios.get<string>(url, {
        timeout: 60_000,
        responseType: 'text',
      });

      const lines = data.split('\n');
      if (lines.length < 2) {
        console.warn('[ExtendedDataService] FIRMS CSV has no data rows');
        return;
      }

      const header = lines[0].split(',');
      const latIdx = header.indexOf('latitude');
      const lngIdx = header.indexOf('longitude');
      const brightIdx = header.indexOf('bright_ti4');
      const confIdx = header.indexOf('confidence');
      const frpIdx = header.indexOf('frp');

      if (latIdx === -1 || lngIdx === -1) {
        console.warn('[ExtendedDataService] FIRMS CSV missing lat/lng columns');
        return;
      }

      const records: FireRecord[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(',');
        const lat = parseFloat(cols[latIdx]);
        const lng = parseFloat(cols[lngIdx]);
        if (isNaN(lat) || isNaN(lng)) continue;

        records.push({
          id: `fire-${lat}-${lng}`,
          lat,
          lng,
          brightness: brightIdx !== -1 ? parseFloat(cols[brightIdx]) || 0 : 0,
          confidence: confIdx !== -1 ? cols[confIdx] : '',
          frp: frpIdx !== -1 ? parseFloat(cols[frpIdx]) || 0 : 0,
          source: 'NASA FIRMS',
        });
      }

      this.fires = records;
      console.log(`[ExtendedDataService] Fires loaded: ${records.length} records`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ExtendedDataService] Failed to fetch fires: ${msg}`);
    }
  }

  // -----------------------------------------------------------------------
  // OpenAQ Air Quality (polled every 15 min)
  // -----------------------------------------------------------------------

  private async fetchAirQuality(): Promise<void> {
    const url =
      'https://api.openaq.org/v3/locations?limit=1000&order_by=lastUpdated&sort_order=desc';
    try {
      const { data } = await axios.get(url, {
        timeout: 30_000,
        headers: { Accept: 'application/json' },
      });

      const results: unknown[] = data?.results ?? [];
      const records: AirQualityRecord[] = [];

      for (const loc of results) {
        const l = loc as Record<string, unknown>;
        const coords = l.coordinates as
          | { latitude?: number; longitude?: number }
          | undefined;
        const country = l.country as { code?: string } | undefined;
        const datetimeLast = l.datetimeLast as { utc?: string } | undefined;

        if (!coords?.latitude || !coords?.longitude) continue;

        records.push({
          id: `aq-${l.id}`,
          lat: coords.latitude,
          lng: coords.longitude,
          name: (l.name as string) ?? '',
          country: country?.code ?? '',
          parameters: (l.sensors as unknown[]) ?? [],
          lastUpdated: datetimeLast?.utc ?? '',
          source: 'OpenAQ',
        });
      }

      this.airQuality = records;
      console.log(
        `[ExtendedDataService] Air quality loaded: ${records.length} locations`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[ExtendedDataService] Failed to fetch air quality: ${msg}`,
      );
    }
  }

}
