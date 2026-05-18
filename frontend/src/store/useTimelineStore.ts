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
  disasters: boolean;
  jamming: boolean;
  labels: boolean;
  fires: boolean;
  cables: boolean;
  webcams: boolean;
  infrastructure: boolean;
  pipelines: boolean;
  outages: boolean;
  wifi: boolean;
  clouds: boolean;
  satellite_imagery: boolean;
  traffic: boolean;
  conflicts: boolean;
  airspace: boolean;
  gfw: boolean;
}

function shallowRecordEqual(a: Record<string, any>, b: Record<string, any>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) return false;
  }
  return true;
}

// Re-export flag name for external consumers (e.g. Legend section typing).
export type LayerName = keyof LayerFlags;

// ---------------------------------------------------------------------------
// Filter & Preset types
// ---------------------------------------------------------------------------

export interface ActiveFilter {
  type: 'solo' | 'thisType' | 'thisDomain';
  label: string;
}

export interface AppliedSelectionState {
  selectionId: string;
  mode: 'replace' | 'append' | 'exclude' | 'only';
  layer?: string;
  updatedAt?: string;
  itemIds?: string[];
  itemCount?: number;
  itemFingerprint?: string;
  materializationStatus?: string;
  truncated?: boolean;
}

export interface MissionPreset {
  name: string;
  description: string;
  visibility: Partial<LayerFlags>;
  subtypeVisibility?: Record<string, boolean>;
}

// All known subtypes per layer — used to build exhaustive preset overrides
const ALL_LAYER_SUBTYPES: Record<string, string[]> = {
  aviation: ['airliner', 'military', 'light', 'general'],
  maritime: ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'unknown'],
  satellites: ['military', 'recon', 'commercial', 'civilian'],
  conflicts: ['explosions', 'battles', 'assaults', 'mass_violence', 'protests', 'threats', 'force_posture', 'coercion'],
  disasters: ['EQ', 'TC', 'FL', 'VO', 'WF', 'DR'],
  fires: ['high', 'medium', 'low'],
  infrastructure: ['power_plant', 'power_substation', 'power_line', 'refinery', 'dam', 'desalination', 'military', 'aerodrome', 'communication_tower'],
  pipelines: ['oil', 'gas', 'water', 'other'],
  outages: ['critical', 'warning'],
  wifi: ['open', 'encrypted', 'unknown'],
  jamming: ['high', 'medium', 'low'],
  airspace: ['restricted', 'danger', 'prohibited', 'alert', 'warning'],
};

/** Build a subtype map: all=false except the listed ones=true */
function onlySubtypes(allow: Record<string, string[]>): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [layer, subs] of Object.entries(ALL_LAYER_SUBTYPES)) {
    const allowed = allow[layer] || [];
    for (const s of subs) {
      result[`${layer}:${s}`] = allowed.includes(s);
    }
  }
  return result;
}

/** Reset all subtypes to visible */
function allSubtypesOn(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [layer, subs] of Object.entries(ALL_LAYER_SUBTYPES)) {
    for (const s of subs) result[`${layer}:${s}`] = true;
  }
  return result;
}

export const MISSION_PRESETS: MissionPreset[] = [
  {
    name: 'Military / Defense',
    description: 'Military aircraft, vessels, satellites, conflicts, jamming, bases, airspace',
    visibility: {
      aviation: true, maritime: true, satellites: true, satelliteFootprints: true,
      conflicts: true, jamming: true, airspace: true, gfw: true,
      disasters: false, fires: false, cables: false, webcams: false, wifi: false,
      infrastructure: true, pipelines: false, outages: false, clouds: false,
      satellite_imagery: false, traffic: false, labels: true,
    },
    subtypeVisibility: onlySubtypes({
      aviation: ['military'],
      maritime: ['military'],
      satellites: ['military', 'recon'],
      conflicts: ['explosions', 'battles', 'assaults', 'mass_violence', 'threats', 'force_posture', 'coercion'],
      jamming: ['high', 'medium', 'low'],
      airspace: ['restricted', 'danger', 'prohibited', 'alert', 'warning'],
      infrastructure: ['military', 'aerodrome'],
    }),
  },
  {
    name: 'Maritime Security',
    description: 'All vessels, AIS signal lost vessels, GFW events, cables, outages',
    visibility: {
      maritime: true, gfw: true, cables: true, outages: true,
      aviation: false, satellites: false, satelliteFootprints: false,
      disasters: false, jamming: false, fires: false, webcams: false,
      infrastructure: false, pipelines: false, wifi: false, clouds: false,
      satellite_imagery: false, traffic: false, conflicts: false,
      airspace: false, labels: true,
    },
    subtypeVisibility: onlySubtypes({
      maritime: ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'unknown'],
      outages: ['critical', 'warning'],
    }),
  },
  {
    name: 'Natural Hazards',
    description: 'Disasters, fires, outages, webcams',
    visibility: {
      disasters: true, fires: true, outages: true, webcams: true,
      aviation: false, maritime: false, satellites: false, satelliteFootprints: false,
      jamming: false, cables: false, infrastructure: false, pipelines: false,
      wifi: false, clouds: true, satellite_imagery: true, traffic: false, conflicts: false,
      airspace: false, gfw: false, labels: true,
    },
    subtypeVisibility: onlySubtypes({
      disasters: ['EQ', 'TC', 'FL', 'VO', 'WF', 'DR'],
      fires: ['high', 'medium', 'low'],
      outages: ['critical', 'warning'],
    }),
  },
  {
    name: 'Energy & Infrastructure',
    description: 'Power plants, pipelines, refineries, dams, cables',
    visibility: {
      infrastructure: true, pipelines: true, cables: true,
      aviation: false, maritime: false, satellites: false, satelliteFootprints: false,
      disasters: false, jamming: false, fires: false, webcams: false,
      outages: true, wifi: false, clouds: false, satellite_imagery: false,
      traffic: false, conflicts: false, airspace: false, gfw: false, labels: true,
    },
    subtypeVisibility: onlySubtypes({
      infrastructure: ['power_plant', 'power_substation', 'power_line', 'refinery', 'dam', 'desalination', 'communication_tower'],
      pipelines: ['oil', 'gas', 'water', 'other'],
      outages: ['critical', 'warning'],
    }),
  },
  {
    name: 'Full Awareness',
    description: 'Everything enabled',
    visibility: {
      satellites: true, satelliteFootprints: true, aviation: true, maritime: true,
      disasters: true, jamming: true, labels: true, fires: true, cables: true,
      webcams: true, infrastructure: true, pipelines: true, outages: true,
      wifi: true, clouds: true, satellite_imagery: true, traffic: true, conflicts: true,
      airspace: true, gfw: true,
    },
    subtypeVisibility: allSubtypesOn(),
  },
];

export interface StreamMetric {
    label: string;
    source: string;
    type: string;
    count: number;
    speed?: string;
    status: 'connecting' | 'streaming' | 'warning' | 'error' | 'disabled' | 'auth-missing' | 'degraded' | 'limited' | 'rate-limited';
    poll: string;       // our polling cadence (e.g. "90s", "live", "5m", "24h")
    upstream: string;   // how often the upstream actually publishes
    // Free-form status note from /api/status — surfaced in LayerManager
    // under the status badge so DuckDB / Overture / Overpass failure
    // messages (and any future backend-composed diagnostics) reach the
    // user instead of being collapsed into a single colour.
    note?: string;
}

export interface StorageStatus {
    dbBytes: number | null;
    diskFreeBytes: number | null;
    diskTotalBytes: number | null;
    diskUsedPercent: number | null;
    dbPercentOfDisk: number | null;
    updatedAt: string | null;
}

export type CurrentTimeUpdateReason =
    | 'user-seek'
    | 'mode-change'
    | 'layers-change'
    | 'driver-tick'
    | 'live-tick'
    | 'track-replay'
    | 'track-clear'
    | 'playback-clamp'
    | 'external';

export interface CurrentTimeUpdateOptions {
    silent?: boolean;
    reason?: CurrentTimeUpdateReason;
}

export interface CurrentTimeUpdateMeta {
    seq: number;
    silent: boolean;
    reason: CurrentTimeUpdateReason;
}

export interface ImageryOverlayContext {
  id: string;
  mode: 'single' | 'compare';
  source: string;
  label: string;
  layer?: string | null;
  acquisitionTime?: string | null;
  acquisitionLabel: string;
  opacity?: number | null;
  bbox?: number[] | null;
  replayLinked: false;
  replayTimeAtShow?: string | null;
  shownAt: string;
  note: string;
}

export type VisualShaderPreset =
  | 'normal'
  | 'night-ops'
  | 'signal-grid'
  | 'thermal'
  | 'monochrome'
  | 'tactical-green'
  | 'cyberpunk'
  | 'xray'
  | 'hazard'
  | 'deep-space'
  | 'infrared';

export type PowerGridEffectPreset = 'off' | 'electric-flow' | 'ember-pulse' | 'voltage-surge';
export type TrafficFlowEffectPreset = 'off' | 'flow-particles' | 'congestion-pulse' | 'signal-rain';

interface TimelineStore {
  mode: 'live' | 'playback';
  playbackKind: 'historical' | 'track' | null;
  currentTime: Date;
  replaySeekVersion: number;
  replayHydrating: boolean;
  speedMultiplier: number;
  isPlaying: boolean;
  // Gate для вторичных слоёв. При холодном открытии primary слои
  // (aircraft/vessels/cables/webcams/labels) уходят в сеть сразу,
  // тяжёлые secondary (fires/pipelines/airspace/conflicts/gfw/
  // satellites/outages/disasters/jamming) ждут этого флага. Снимается
  // через фиксированный таймер в Globe.tsx после маунта, чтобы дать
  // live-bootstrap эксклюзивный event-loop на первые секунды.
  secondaryLoadReleased: boolean;
  releaseSecondaryLoad: () => void;
  showTrajectories: boolean;
  // New split model (sources = load, visibility = show). See `LayerFlags` comment.
  sources: LayerFlags;
  visibility: LayerFlags;
  selectedEntityId: string | null;
  selectedEntityData: any | null;
  agentReplayFocusIds: string[];
  streamMetrics: Record<string, StreamMetric>;
  storageStatus: StorageStatus;
  // Per-subtype visibility (e.g. "aviation:airliner", "satellite:military").
  // Default = visible. Layer hooks honour these flags when rendering.
  subtypeVisibility: Record<string, boolean>;
  // Per-layer source visibility for composite logical views
  // (e.g. "disasters:gdacs", "conflicts:gdelt").
  sourceVisibility: Record<string, boolean>;
  appliedSelections: Record<string, AppliedSelectionState>;
  // Per-subtype counts. Layer hooks update these from the live datasource
  // entity counts; the Legend reads them.
  subtypeCounts: Record<string, number>;
  // Per-source counts for composite logical views.
  sourceCounts: Record<string, number>;
  // Infrastructure viewport loading progress (0-100). Set by useInfrastructureLayer.
  infraViewportPct: number;
  setInfraViewportPct: (pct: number) => void;
  tileMode: 'google' | 'osm' | 'modis';
  osm3dObjectsVisible: boolean;
  clusteringEnabled: boolean;
  satelliteRenderLimit: number | null;
  activeImageryOverlay: ImageryOverlayContext | null;
  visualShader: VisualShaderPreset;
  powerGridEffect: PowerGridEffectPreset;
  trafficFlowEffect: TrafficFlowEffectPreset;
  // Filter / isolation state
  prevFilterState: { visibility: LayerFlags; subtypeVisibility: Record<string, boolean> } | null;
  activeFilter: ActiveFilter | null;
  activePreset: string | null;
  activeIconSet: 'default' | 'enhanced';
  isolatedEntityId: string | null;
  setTileMode: (mode: 'google' | 'osm' | 'modis') => void;
  setOsm3dObjectsVisible: (visible: boolean) => void;
  toggleClustering: () => void;
  setSatelliteRenderLimit: (limit: number | null) => void;
  setActiveImageryOverlay: (context: ImageryOverlayContext | null) => void;
  setVisualShader: (preset: VisualShaderPreset) => void;
  setPowerGridEffect: (preset: PowerGridEffectPreset) => void;
  setTrafficFlowEffect: (preset: TrafficFlowEffectPreset) => void;
  setMode: (mode: 'live' | 'playback') => void;
  setPlaybackKind: (kind: 'historical' | 'track' | null) => void;
  setCurrentTime: (time: Date, options?: CurrentTimeUpdateOptions) => void;
  currentTimeUpdate: CurrentTimeUpdateMeta;
  markReplaySeek: () => void;
  enterHistoricalReplay: () => void;
  exitToLive: () => void;
  setReplayHydrating: (hydrating: boolean) => void;
  setSpeedMultiplier: (speed: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setShowTrajectories: (show: boolean) => void;
  toggleTrajectories: () => void;
  // LayerManager (left panel) action — controls fetching.
  toggleSource: (layer: keyof LayerFlags) => void;
  // Legend (right panel) action — controls rendering.
  toggleVisibility: (layer: keyof LayerFlags) => void;
  setSelectedEntityId: (id: string | null, data?: any) => void;
  addAgentReplayFocusId: (id: string) => void;
  clearAgentReplayFocusIds: () => void;
  setStreamMetric: (layer: string, data: Partial<StreamMetric>) => void;
  setStorageStatus: (data: Partial<StorageStatus>) => void;
  toggleSubtype: (key: string) => void;
  toggleSourceVisibility: (key: string) => void;
  setSubtypeCounts: (layer: keyof LayerFlags, counts: Record<string, number>) => void;
  setSourceCounts: (layer: string, counts: Record<string, number>) => void;
  // Filter / isolation actions
  applyFilter: (type: ActiveFilter['type'], label: string, visOverride: LayerFlags, subOverride?: Record<string, boolean>) => void;
  clearFilter: () => void;
  applyMissionPreset: (presetName: string) => void;
  setActiveIconSet: (set: 'default' | 'enhanced') => void;
  setIsolatedEntityId: (id: string | null) => void;
}

type PersistedTimelineSettings = Pick<
  TimelineStore,
  'sources' | 'visibility' | 'subtypeVisibility' | 'sourceVisibility' | 'tileMode' | 'osm3dObjectsVisible' | 'showTrajectories' | 'clusteringEnabled' | 'activePreset' | 'activeIconSet' | 'satelliteRenderLimit' | 'visualShader' | 'powerGridEffect' | 'trafficFlowEffect'
> & {
  effectiveTileMode?: 'google' | 'osm' | 'modis';
};

// Persist control-plane state to server on change (debounced)
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSettingsToServer(state: PersistedTimelineSettings) {
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
                sourceVisibility: state.sourceVisibility,
                tileMode: state.tileMode,
                effectiveTileMode: state.effectiveTileMode || state.tileMode,
                osm3dObjectsVisible: state.osm3dObjectsVisible,
                showTrajectories: state.showTrajectories,
                clusteringEnabled: state.clusteringEnabled,
                satelliteRenderLimit: state.satelliteRenderLimit,
                activePreset: state.activePreset,
                activeIconSet: state.activeIconSet,
                visualShader: state.visualShader,
                powerGridEffect: state.powerGridEffect,
                trafficFlowEffect: state.trafficFlowEffect,
            }),
        }).catch(() => { /* ignore save errors */ });
    }, 500);
}

export const useTimelineStore = create<TimelineStore>((set) => ({
  mode: 'live',
  playbackKind: null,
  currentTime: new Date(),
  replaySeekVersion: 0,
  replayHydrating: false,
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
  // Sources default: full live context. Product defaults must not disable data
  // sources to hide startup or rendering regressions. Test scripts may narrow
  // sources temporarily, but they must restore the user's state afterwards.
  sources: {
    satellites: true,
    satelliteFootprints: true,
    aviation: true,
    maritime: true,
    disasters: true,
    jamming: true,
    labels: true,
    fires: true,
    cables: true,
    webcams: true,
    infrastructure: true,
    pipelines: true,
    outages: true,
    wifi: true,
    clouds: true,
    satellite_imagery: true,
    traffic: true,
    conflicts: true,
    airspace: true,
    gfw: true,
  },
  // Visibility controls what is drawn. Full live context starts visible so
  // integration tests exercise the real product surface. Trajectory/orbit
  // lines remain controlled separately by showTrajectories.
  visibility: {
    satellites: true,
    satelliteFootprints: true,
    aviation: true,
    maritime: true,
    disasters: true,
    jamming: true,
    labels: true,
    fires: true,
    cables: true,
    webcams: true,
    infrastructure: true,
    pipelines: true,
    outages: true,
    wifi: true,
    clouds: true,
    satellite_imagery: true,
    traffic: true,
    conflicts: true,
    airspace: true,
    gfw: true,
  },
  selectedEntityId: null,
  selectedEntityData: null,
  agentReplayFocusIds: [],
  subtypeVisibility: {},
  sourceVisibility: {},
  appliedSelections: {},
  subtypeCounts: {},
  sourceCounts: {},
  infraViewportPct: -1,
  setInfraViewportPct: (pct) => set({ infraViewportPct: pct }),
  tileMode: 'google' as 'google' | 'osm' | 'modis',
  osm3dObjectsVisible: true,
  clusteringEnabled: true,
  // null = 'all' — показываем весь каталог TLE из backend (~19k). 5000 был
  // артефактом ранней оптимизации и прятал 3.8× спутников. Пользователь
  // 2026-04-24: "5000 ровно это явно обрезка, проблема в логике".
  satelliteRenderLimit: null,
  activeImageryOverlay: null,
  visualShader: 'normal',
  powerGridEffect: 'off',
  trafficFlowEffect: 'off',
  prevFilterState: null,
  activeFilter: null,
  activePreset: null,
  activeIconSet: 'default' as 'default' | 'enhanced',
  isolatedEntityId: null,
  setIsolatedEntityId: (id) => set({ isolatedEntityId: id }),
  setTileMode: (tileMode) => set((state) => {
      const next = { ...state, tileMode };
      saveSettingsToServer(next);
      return { tileMode };
  }),
  setOsm3dObjectsVisible: (osm3dObjectsVisible) => set((state) => {
      const next = { ...state, osm3dObjectsVisible };
      saveSettingsToServer(next);
      return { osm3dObjectsVisible };
  }),
  toggleClustering: () => set(state => {
      const next = { ...state, clusteringEnabled: !state.clusteringEnabled };
      saveSettingsToServer(next);
      return { clusteringEnabled: next.clusteringEnabled };
  }),
  setSatelliteRenderLimit: (limit) => set((state) => {
      const next = { ...state, satelliteRenderLimit: limit };
      saveSettingsToServer(next);
      return { satelliteRenderLimit: limit };
  }),
  setActiveImageryOverlay: (activeImageryOverlay) => set({ activeImageryOverlay }),
  setVisualShader: (visualShader) => set((state) => {
      const next = { ...state, visualShader };
      saveSettingsToServer(next);
      return { visualShader };
  }),
  setPowerGridEffect: (powerGridEffect) => set((state) => {
      const next = { ...state, powerGridEffect };
      saveSettingsToServer(next);
      return { powerGridEffect };
  }),
  setTrafficFlowEffect: (trafficFlowEffect) => set((state) => {
      const next = { ...state, trafficFlowEffect };
      saveSettingsToServer(next);
      return { trafficFlowEffect };
  }),
  streamMetrics: {
      aviation: { label: 'OpenSky Network', source: 'api.opensky-network.org', type: 'REST Polling (global)', count: 0, speed: '0 bps', status: 'connecting', poll: '90s', upstream: '5–10s ADS-B' },
      maritime: { label: 'AISStream', source: 'wss://stream.aisstream.io', type: 'WebSocket (persistent)', count: 0, speed: '0 msgs/s', status: 'connecting', poll: 'live (~3m update)', upstream: '2–10s AIS' },
      disasters: { label: 'GDACS + USGS + EONET', source: 'gdacs / usgs / nasa', type: 'REST aggregated', count: 0, speed: '-', status: 'connecting', poll: '5m', upstream: 'event-driven (~min)' },
      satellites: { label: 'CelesTrak', source: 'celestrak.org', type: 'SGP4', count: 0, speed: '-', status: 'connecting', poll: '24h cache', upstream: '2–3 ×/day' },
      satelliteFootprints: { label: 'Sensor Footprints', source: 'Spectator Earth', type: 'Projected cone', count: 0, speed: '-', status: 'connecting', poll: 'on load', upstream: '24h TTL' },
      jamming:  { label: 'GNSS Jamming Hot Spots', source: 'GPSJam.org', type: 'REST (H3 CSV)', count: 0, speed: '-', status: 'connecting', poll: '6h', upstream: 'daily ADS-B analysis' },
      labels:   { label: 'Borders & Cities', source: 'NaturalEarth', type: 'GeoJSON (static)', count: 0, speed: '-', status: 'connecting', poll: 'on load', upstream: 'yearly updates' },
      fires:    { label: 'Active Fires', source: 'NASA FIRMS', type: 'REST CSV', count: 0, speed: '-', status: 'connecting', poll: '30m', upstream: '3-hourly VIIRS' },
      cables:   { label: 'Submarine Cables', source: 'TeleGeography', type: 'GeoJSON (static)', count: 0, speed: '-', status: 'connecting', poll: 'on load', upstream: 'yearly' },
      webcams:  { label: 'Live Webcams', source: 'LES + Windy + Caltrans', type: 'REST (HLS/preview)', count: 0, speed: '-', status: 'connecting', poll: '1h', upstream: 'live HLS / 10min preview' },
      infrastructure: { label: 'Critical Infrastructure', source: 'OpenStreetMap + Overture Maps', type: 'Viewport APIs', count: 0, speed: '-', status: 'connecting', poll: 'on viewport', upstream: '1h / release cache' },
      pipelines: { label: 'Utility Pipelines', source: 'Overture Maps', type: 'DuckDB viewport geometry', count: 0, speed: '-', status: 'connecting', poll: 'on viewport', upstream: 'release cache' },
      outages:   { label: 'Internet Outages', source: 'IODA + Cloudflare Radar', type: 'REST Polling', count: 0, speed: '-', status: 'connecting', poll: '5m', upstream: '10m alerts' },
      wifi: { label: 'Wi-Fi Observations', source: 'WiGLE', type: 'Viewport API', count: 0, speed: '-', status: 'auth-missing', poll: 'on viewport', upstream: 'crowdsourced observations' },
      clouds:   { label: 'Satellite Clouds', source: 'NASA GIBS', type: 'WMTS imagery overlay', count: 0, speed: 'daily snapshot', status: 'streaming', poll: 'daily', upstream: 'daily MODIS' },
      satellite_imagery: { label: 'Satellite Imagery', source: 'NASA GIBS MODIS', type: 'WMTS imagery overlay', count: 0, speed: 'daily snapshot', status: 'streaming', poll: 'daily', upstream: 'daily MODIS' },
      traffic: { label: 'Traffic Flow', source: 'TomTom', type: 'Raster tile overlay', count: 0, speed: '-', status: 'connecting', poll: 'on demand', upstream: 'real-time (~1 min)' },
      conflicts: { label: 'Armed Conflicts', source: 'ACLED + GDELT', type: 'REST + CSV', count: 0, speed: '-', status: 'connecting', poll: '15m (GDELT) / 30m (ACLED)', upstream: '15-min GDELT + daily ACLED' },
      airspace: { label: 'Restricted Airspace', source: 'OpenAIP', type: 'REST paginated', count: 0, speed: '-', status: 'connecting', poll: '1h', upstream: 'weekly updates' },
      gfw: { label: 'AIS Signal Lost Events', source: 'Global Fishing Watch', type: 'REST Polling', count: 0, speed: '-', status: 'auth-missing', poll: '1h', upstream: 'event-driven' },
  },
  storageStatus: {
      dbBytes: null,
      diskFreeBytes: null,
      diskTotalBytes: null,
      diskUsedPercent: null,
      dbPercentOfDisk: null,
      updatedAt: null,
  },
  currentTimeUpdate: {
      seq: 0,
      silent: false,
      reason: 'external',
  },
  setMode: (mode) => set({ mode }),
  setPlaybackKind: (playbackKind) => set({ playbackKind }),
  setCurrentTime: (time, options) => set((state) => ({
      currentTime: time,
      currentTimeUpdate: {
          seq: state.currentTimeUpdate.seq + 1,
          silent: options?.silent ?? false,
          reason: options?.reason ?? 'external',
      },
  })),
  markReplaySeek: () => set((state) => ({ replaySeekVersion: state.replaySeekVersion + 1 })),
  enterHistoricalReplay: () => set((state) => ({
      isPlaying: false,
      mode: 'playback',
      playbackKind: 'historical',
      replaySeekVersion: state.replaySeekVersion + 1,
  })),
  exitToLive: () => set((state) => ({
      mode: 'live',
      playbackKind: null,
      speedMultiplier: 1,
      isPlaying: true,
      currentTime: new Date(),
      currentTimeUpdate: {
          seq: state.currentTimeUpdate.seq + 1,
          silent: true,
          reason: 'mode-change',
      },
  })),
  setReplayHydrating: (replayHydrating) => set({ replayHydrating }),
  setSpeedMultiplier: (speedMultiplier) => set({ speedMultiplier }),
  // Snapshot = все объекты. Запрет включить play в historical replay
  // пока идёт гидрация: UI-кнопка уже disabled на `replayHydrating`,
  // но store-guard нужен, чтобы прямой вызов (тесты, keyboard shortcut,
  // URL-параметр) не стартовал playback на наполовину загруженном
  // snapshot. Отключение playback (isPlaying=false) разрешено всегда.
  setIsPlaying: (isPlaying) => set((state) => {
      if (isPlaying && state.mode === 'playback' && state.playbackKind === 'historical' && state.replayHydrating) {
          return {} as Partial<typeof state>;
      }
      return { isPlaying };
  }),
  secondaryLoadReleased: false,
  releaseSecondaryLoad: () => set({ secondaryLoadReleased: true }),
  setShowTrajectories: (show) => set(state => {
      const next = { ...state, showTrajectories: show };
      saveSettingsToServer(next);
      return { showTrajectories: show };
  }),
  toggleTrajectories: () => set((state) => {
      const next = { ...state, showTrajectories: !state.showTrajectories };
      saveSettingsToServer(next);
      return { showTrajectories: next.showTrajectories };
  }),
  // LayerManager → sources (fetch control)
  toggleSource: (layer) => set((state) => {
      const next = { ...state, sources: { ...state.sources, [layer]: !state.sources[layer] } };
      saveSettingsToServer(next);
      return { sources: next.sources };
  }),
  // Legend → visibility (render control)
  toggleVisibility: (layer) => set((state) => {
      const nextVisible = !state.visibility[layer];
      const next = {
          ...state,
          visibility: { ...state.visibility, [layer]: nextVisible },
          // Effective rendering is `sources && visibility`. If a user turns a
          // layer back on from the legend, also restart its source so the UI
          // cannot look enabled while the data feed remains stopped.
          sources: nextVisible
              ? { ...state.sources, [layer]: true }
              : state.sources,
      };
      saveSettingsToServer(next);
      return { visibility: next.visibility, sources: next.sources };
  }),
  setSelectedEntityId: (id, data) => set({ selectedEntityId: id, selectedEntityData: data || null }),
  addAgentReplayFocusId: (id) => set((state) => {
      const normalized = String(id || '').trim();
      if (!normalized || state.agentReplayFocusIds.includes(normalized)) return state as any;
      return { agentReplayFocusIds: [...state.agentReplayFocusIds, normalized] };
  }),
  clearAgentReplayFocusIds: () => set((state) => (
      state.agentReplayFocusIds.length === 0 ? state as any : { agentReplayFocusIds: [] }
  )),
  setStreamMetric: (layer, data) => set(state => {
      const current = state.streamMetrics[layer] || {};
      const nextMetric = { ...current, ...data };
      if (shallowRecordEqual(current as any, nextMetric as any)) return state as any;
      return {
          streamMetrics: {
              ...state.streamMetrics,
              [layer]: nextMetric,
          }
      };
  }),
  setStorageStatus: (data) => set(state => {
      const nextStorageStatus = {
          ...state.storageStatus,
          ...data,
      };
      if (shallowRecordEqual(state.storageStatus as any, nextStorageStatus as any)) return state as any;
      return { storageStatus: nextStorageStatus };
  }),
  toggleSubtype: (key) => set(state => {
      const subtypeVisibility = {
          ...state.subtypeVisibility,
          [key]: state.subtypeVisibility[key] === false ? true : false,
      };
      saveSettingsToServer({ ...state, subtypeVisibility });
      return { subtypeVisibility };
  }),
  toggleSourceVisibility: (key) => set(state => {
      const sourceVisibility = {
          ...state.sourceVisibility,
          [key]: state.sourceVisibility[key] === false ? true : false,
      };
      saveSettingsToServer({ ...state, sourceVisibility });
      return { sourceVisibility };
  }),
  setSubtypeCounts: (layer, counts) => set(state => {
      // Replace all counts for this layer atomically.
      const next: Record<string, number> = { ...state.subtypeCounts };
      // Drop existing entries for this layer (prefix match).
      const prefix = `${layer}:`;
      for (const k of Object.keys(next)) if (k.startsWith(prefix)) delete next[k];
      for (const [sub, n] of Object.entries(counts)) next[`${prefix}${sub}`] = n;
      if (shallowRecordEqual(state.subtypeCounts, next)) return state as any;
      return { subtypeCounts: next };
  }),
  setSourceCounts: (layer, counts) => set(state => {
      const next: Record<string, number> = { ...state.sourceCounts };
      const prefix = `${layer}:`;
      for (const k of Object.keys(next)) if (k.startsWith(prefix)) delete next[k];
      for (const [sourceId, n] of Object.entries(counts)) next[`${prefix}${sourceId}`] = n;
      if (shallowRecordEqual(state.sourceCounts, next)) return state as any;
      return { sourceCounts: next };
  }),
  // --- Filter / isolation actions ---
  applyFilter: (type, label, visOverride, subOverride) => set(state => {
      // Save current state so clearFilter can restore it
      const prevFilterState = state.prevFilterState || {
          visibility: { ...state.visibility },
          subtypeVisibility: { ...state.subtypeVisibility },
      };
      const patch: Partial<TimelineStore> = {
          prevFilterState,
          activeFilter: { type, label },
          activePreset: null,
          visibility: visOverride,
      };
      if (subOverride) patch.subtypeVisibility = subOverride;
      return patch;
  }),
  clearFilter: () => set(state => {
      if (!state.prevFilterState) return { activeFilter: null, isolatedEntityId: null };
      return {
          visibility: state.prevFilterState.visibility,
          subtypeVisibility: state.prevFilterState.subtypeVisibility,
          prevFilterState: null,
          activeFilter: null,
          isolatedEntityId: null,
      };
  }),
  applyMissionPreset: (presetName) => set(state => {
      const preset = MISSION_PRESETS.find(p => p.name === presetName);
      if (!preset) return {};
      const vis = { ...state.visibility, ...preset.visibility } as LayerFlags;
      // Replace (not merge) subtypeVisibility — presets explicitly set all subtypes
      const sub = preset.subtypeVisibility || state.subtypeVisibility;
      const next = { ...state, visibility: vis, subtypeVisibility: sub };
      saveSettingsToServer(next);
      return { visibility: vis, subtypeVisibility: sub, activePreset: presetName, activeFilter: null, prevFilterState: null };
  }),
  setActiveIconSet: (iconSet) => set(state => {
      const next = { ...state, activeIconSet: iconSet };
      saveSettingsToServer(next);
      return { activeIconSet: iconSet };
  }),
}));

declare global {
  interface Window {
    __openspyTimelineStore?: typeof useTimelineStore;
  }
}

if (typeof window !== 'undefined') {
  window.__openspyTimelineStore = useTimelineStore;
}
