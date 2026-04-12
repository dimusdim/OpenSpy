import { create } from 'zustand';

// Layer flags split into two independent dimensions:
//
// * `sources` — left-panel "Data Intelligence" control. Whether we FETCH
//   data for this layer from the backend / external APIs. Off = stop
//   polling, don't burn network/credits. Existing loaded data is NOT
//   destroyed, so flipping back on resumes in seconds.
//
// * `visibility` — right-panel "Legend" control. Whether we RENDER the
//   already-loaded data in the Cesium viewport. Off = primitive.show = false,
//   but fetches keep running in the background.
//
// These are orthogonal: you can load-but-hide (e.g. you want counts in the
// LayerManager but an uncluttered globe), or hide-source-but-keep-showing
// (stale data frozen on the map while you save bandwidth).
interface LayerFlags {
  satellites: boolean;
  // Projected satellite sensor footprints (ground cone + ray beams).
  // Kept separate from `satellites` so the user can hide the coverage
  // overlay without losing the sat billboards themselves. Only sats
  // with real Spectator Earth sensor metadata get a footprint; the
  // toggle has no effect for sats without a swath width.
  satelliteFootprints: boolean;
  aviation: boolean;
  maritime: boolean;
  osint: boolean;
  jamming: boolean;
  labels: boolean;
  fires: boolean;
  cables: boolean;
  webcams: boolean;
  infrastructure: boolean;
  pipelines: boolean;
  outages: boolean;
  clouds: boolean;
  satellite_imagery: boolean;
  traffic: boolean;
  conflicts: boolean;
  airspace: boolean;
  gfw: boolean;
}

// Re-export flag name for external consumers (e.g. Legend section typing).
export type LayerName = keyof LayerFlags;

export interface StreamMetric {
    label: string;
    source: string;
    type: string;
    count: number;
    speed?: string;
    status: 'connecting' | 'streaming' | 'warning' | 'error' | 'disabled' | 'auth-missing' | 'degraded' | 'limited';
    poll: string;       // our polling cadence (e.g. "90s", "live", "5m", "24h")
    upstream: string;   // how often the upstream actually publishes
    // Free-form status note from /api/status — surfaced in LayerManager
    // under the status badge so DuckDB / Overture / Overpass failure
    // messages (and any future backend-composed diagnostics) reach the
    // user instead of being collapsed into a single colour.
    note?: string;
}

interface TimelineStore {
  mode: 'live' | 'playback';
  currentTime: Date;
  speedMultiplier: number;
  isPlaying: boolean;
  showTrajectories: boolean;
  // New split model (sources = load, visibility = show). See `LayerFlags` comment.
  sources: LayerFlags;
  visibility: LayerFlags;
  selectedEntityId: string | null;
  selectedEntityData: any | null;
  streamMetrics: Record<string, StreamMetric>;
  // Per-subtype visibility (e.g. "aviation:airliner", "satellite:military").
  // Default = visible. Layer hooks honour these flags when rendering.
  subtypeVisibility: Record<string, boolean>;
  // Per-subtype counts. Layer hooks update these from the live datasource
  // entity counts; the Legend reads them.
  subtypeCounts: Record<string, number>;
  // Infrastructure viewport loading progress (0-100). Set by useInfrastructureLayer.
  infraViewportPct: number;
  setInfraViewportPct: (pct: number) => void;
  tileMode: 'google' | 'osm';
  clusteringEnabled: boolean;
  setTileMode: (mode: 'google' | 'osm') => void;
  toggleClustering: () => void;
  setMode: (mode: 'live' | 'playback') => void;
  setCurrentTime: (time: Date) => void;
  setSpeedMultiplier: (speed: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setShowTrajectories: (show: boolean) => void;
  toggleTrajectories: () => void;
  // LayerManager (left panel) action — controls fetching.
  toggleSource: (layer: keyof LayerFlags) => void;
  // Legend (right panel) action — controls rendering.
  toggleVisibility: (layer: keyof LayerFlags) => void;
  setSelectedEntityId: (id: string | null, data?: any) => void;
  setStreamMetric: (layer: string, data: Partial<StreamMetric>) => void;
  toggleSubtype: (key: string) => void;
  setSubtypeCounts: (layer: keyof LayerFlags, counts: Record<string, number>) => void;
}

// Persist sources/visibility to server on change (debounced)
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSettingsToServer(state: Pick<TimelineStore, 'sources' | 'visibility' | 'subtypeVisibility' | 'tileMode'>) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3055';
        fetch(`${API_URL}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sources: state.sources,
                visibility: state.visibility,
                subtypeVisibility: state.subtypeVisibility,
                tileMode: state.tileMode,
            }),
        }).catch(() => { /* ignore save errors */ });
    }, 500);
}

export const useTimelineStore = create<TimelineStore>((set) => ({
  mode: 'live',
  currentTime: new Date(),
  speedMultiplier: 1,
  isPlaying: true,
  // Trajectories default OFF — the "Show Orbital/Flight Trajectories"
  // checkbox lives in LayerManager and the user can enable it anytime.
  //
  // Reason for off-by-default: vessel `Entity.path` visualisation is
  // a per-frame main-thread killer with thousands of AIS vessels.
  // Cesium's `dataSourceDisplay.update(time)` runs on every RAF tick
  // — NOT gated by `scene.maximumRenderTimeChange` — and
  // `PathVisualizer.updateObject` unconditionally re-runs `subSample()`
  // and re-assigns `polyline.positions` for every entity whose `path`
  // is visible. With 2000 vessels × hundreds of samples each that
  // dominated the rotation frame budget and was the biggest remaining
  // cost after the rate-limit fix. Setting `path.show = false` lets
  // the PathVisualizer short-circuit the whole rebuild per vessel.
  //
  // The batched satellite trails primitive is unaffected — it's a
  // GPU-batched Primitive, not an Entity.path, and has its own
  // separate `show` gating driven by the same `showTrajectories` flag.
  showTrajectories: false,
  // Sources default: everything ON. The panel reflects user intent at
  // a glance instead of hiding feature availability behind a click.
  // Layers that need auth or fail their upstream still start "on" so
  // the LayerManager surfaces the auth-missing / error state loud —
  // the user sees immediately what's available and what to configure.
  sources: {
    satellites: true,
    satelliteFootprints: true,
    aviation: true,
    maritime: true,
    osint: true,
    jamming: true,
    labels: true,
    fires: true,
    cables: true,
    webcams: true,
    infrastructure: true,
    pipelines: true,
    outages: true,
    clouds: true,
    satellite_imagery: true,
    traffic: true,
    conflicts: true,
    airspace: true,
    gfw: true,
  },
  // Visibility mirrors sources on boot. Toggling visibility hides the
  // rendered primitive without stopping the fetch; toggling source
  // stops the fetch AND hides (the effective show state for every
  // layer hook is `sources && visibility`).
  visibility: {
    satellites: true,
    satelliteFootprints: true,
    aviation: true,
    maritime: true,
    osint: true,
    jamming: true,
    labels: true,
    fires: true,
    cables: true,
    webcams: true,
    infrastructure: true,
    pipelines: true,
    outages: true,
    clouds: true,
    satellite_imagery: true,
    traffic: true,
    conflicts: true,
    airspace: true,
    gfw: true,
  },
  selectedEntityId: null,
  selectedEntityData: null,
  subtypeVisibility: {},
  subtypeCounts: {},
  infraViewportPct: -1,
  setInfraViewportPct: (pct) => set({ infraViewportPct: pct }),
  tileMode: 'google' as 'google' | 'osm',
  clusteringEnabled: true,
  setTileMode: (tileMode) => set({ tileMode }),
  toggleClustering: () => set(s => ({ clusteringEnabled: !s.clusteringEnabled })),
  streamMetrics: {
      aviation: { label: 'OpenSky Network', source: 'api.opensky-network.org', type: 'REST Polling (global)', count: 0, speed: '0 bps', status: 'connecting', poll: '90s', upstream: '5–10s ADS-B' },
      maritime: { label: 'AISStream', source: 'wss://stream.aisstream.io', type: 'WebSocket (persistent)', count: 0, speed: '0 msgs/s', status: 'connecting', poll: 'live (~3m update)', upstream: '2–10s AIS' },
      osint: { label: 'GDACS + USGS + EONET', source: 'gdacs / usgs / nasa', type: 'REST aggregated', count: 0, speed: '-', status: 'connecting', poll: '5m', upstream: 'event-driven (~min)' },
      satellites: { label: 'CelesTrak', source: 'celestrak.org', type: 'SGP4', count: 0, speed: '-', status: 'connecting', poll: '24h cache', upstream: '2–3 ×/day' },
      satelliteFootprints: { label: 'Sensor Footprints', source: 'Spectator Earth', type: 'Projected cone', count: 0, speed: '-', status: 'connecting', poll: 'on load', upstream: '24h TTL' },
      jamming:  { label: 'GNSS Jamming Hot Spots', source: 'GPSJam.org', type: 'REST (H3 CSV)', count: 0, speed: '-', status: 'connecting', poll: '6h', upstream: 'daily ADS-B analysis' },
      labels:   { label: 'Borders & Cities', source: 'NaturalEarth', type: 'GeoJSON (static)', count: 0, speed: '-', status: 'connecting', poll: 'on load', upstream: 'yearly updates' },
      fires:    { label: 'Active Fires', source: 'NASA FIRMS', type: 'REST CSV', count: 0, speed: '-', status: 'connecting', poll: '30m', upstream: '3-hourly VIIRS' },
      cables:   { label: 'Submarine Cables', source: 'TeleGeography', type: 'GeoJSON (static)', count: 0, speed: '-', status: 'connecting', poll: 'on load', upstream: 'yearly' },
      webcams:  { label: 'Live Webcams', source: 'LES + Windy + Caltrans', type: 'REST (HLS/preview)', count: 0, speed: '-', status: 'connecting', poll: '1h', upstream: 'live HLS / 10min preview' },
      infrastructure: { label: 'Critical Infrastructure', source: 'OpenStreetMap', type: 'Overpass API', count: 0, speed: '-', status: 'connecting', poll: 'on viewport', upstream: '1h cache' },
      pipelines: { label: 'Oil & Gas Pipelines', source: 'OpenStreetMap', type: 'Overpass API', count: 0, speed: '-', status: 'connecting', poll: 'once', upstream: '24h cache' },
      outages:   { label: 'Internet Outages', source: 'IODA + Cloudflare Radar', type: 'REST Polling', count: 0, speed: '-', status: 'connecting', poll: '5m', upstream: '10m alerts' },
      clouds:   { label: 'Satellite Clouds', source: 'NASA GIBS', type: 'WMTS imagery overlay', count: 0, speed: 'daily snapshot', status: 'streaming', poll: 'daily', upstream: 'daily MODIS' },
      satellite_imagery: { label: 'Satellite Imagery', source: 'NASA GIBS MODIS', type: 'WMTS imagery overlay', count: 0, speed: 'daily snapshot', status: 'streaming', poll: 'daily', upstream: 'daily MODIS' },
      traffic: { label: 'Traffic Flow', source: 'TomTom', type: 'Raster tile overlay', count: 0, speed: '-', status: 'connecting', poll: 'on demand', upstream: 'real-time (~1 min)' },
      conflicts: { label: 'Armed Conflicts', source: 'ACLED', type: 'REST Polling', count: 0, speed: '-', status: 'auth-missing', poll: '30m', upstream: 'daily updates' },
      airspace: { label: 'Restricted Airspace', source: 'OpenAIP', type: 'REST paginated', count: 0, speed: '-', status: 'connecting', poll: '1h', upstream: 'weekly updates' },
      gfw: { label: 'Dark Vessel Events', source: 'Global Fishing Watch', type: 'REST Polling', count: 0, speed: '-', status: 'auth-missing', poll: '1h', upstream: 'event-driven' },
  },
  setMode: (mode) => set({ mode }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setSpeedMultiplier: (speedMultiplier) => set({ speedMultiplier }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setShowTrajectories: (show) => set({ showTrajectories: show }),
  toggleTrajectories: () => set((state) => ({ showTrajectories: !state.showTrajectories })),
  // LayerManager → sources (fetch control)
  toggleSource: (layer) => set((state) => {
      const next = { ...state, sources: { ...state.sources, [layer]: !state.sources[layer] } };
      saveSettingsToServer(next);
      return { sources: next.sources };
  }),
  // Legend → visibility (render control)
  toggleVisibility: (layer) => set((state) => {
      const next = { ...state, visibility: { ...state.visibility, [layer]: !state.visibility[layer] } };
      saveSettingsToServer(next);
      return { visibility: next.visibility };
  }),
  setSelectedEntityId: (id, data) => set({ selectedEntityId: id, selectedEntityData: data || null }),
  setStreamMetric: (layer, data) => set(state => ({
      streamMetrics: {
          ...state.streamMetrics,
          [layer]: { ...state.streamMetrics[layer], ...data }
      }
  })),
  toggleSubtype: (key) => set(state => {
      const subtypeVisibility = {
          ...state.subtypeVisibility,
          [key]: state.subtypeVisibility[key] === false ? true : false,
      };
      saveSettingsToServer({ ...state, subtypeVisibility });
      return { subtypeVisibility };
  }),
  setSubtypeCounts: (layer, counts) => set(state => {
      // Replace all counts for this layer atomically.
      const next: Record<string, number> = { ...state.subtypeCounts };
      // Drop existing entries for this layer (prefix match).
      const prefix = `${layer}:`;
      for (const k of Object.keys(next)) if (k.startsWith(prefix)) delete next[k];
      for (const [sub, n] of Object.entries(counts)) next[`${prefix}${sub}`] = n;
      return { subtypeCounts: next };
  }),
}));
