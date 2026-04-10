import { create } from 'zustand';

interface LayerState {
  satellites: boolean;
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

export interface StreamMetric {
    label: string;
    source: string;
    type: string;
    count: number;
    speed?: string;
    status: 'connecting' | 'streaming' | 'warning' | 'error';
    poll: string;       // our polling cadence (e.g. "90s", "live", "5m", "24h")
    upstream: string;   // how often the upstream actually publishes
}

interface TimelineStore {
  mode: 'live' | 'playback';
  currentTime: Date;
  speedMultiplier: number;
  isPlaying: boolean;
  showTrajectories: boolean;
  layers: LayerState;
  selectedEntityId: string | null;
  selectedEntityData: any | null;
  streamMetrics: Record<string, StreamMetric>;
  // Per-subtype visibility (e.g. "aviation:airliner", "satellite:military").
  // Default = visible. Layer hooks honour these flags when rendering.
  subtypeVisibility: Record<string, boolean>;
  // Per-subtype counts. Layer hooks update these from the live datasource
  // entity counts; the Legend reads them.
  subtypeCounts: Record<string, number>;
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
  toggleLayer: (layer: keyof LayerState) => void;
  setSelectedEntityId: (id: string | null, data?: any) => void;
  setStreamMetric: (layer: string, data: Partial<StreamMetric>) => void;
  toggleSubtype: (key: string) => void;
  setSubtypeCounts: (layer: keyof LayerState, counts: Record<string, number>) => void;
}

export const useTimelineStore = create<TimelineStore>((set) => ({
  mode: 'live',
  currentTime: new Date(),
  speedMultiplier: 1,
  isPlaying: true,
  showTrajectories: true,
  layers: {
    satellites: true,
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
    clouds: false, // off by default — heavy imagery overlay
    satellite_imagery: false, // off by default — MODIS true color overlay
    traffic: false, // off by default — requires TOMTOM_API_KEY
    conflicts: true,
    airspace: false, // off by default — requires OPENAIP_API_KEY
    gfw: false,      // off by default — requires GFW_TOKEN
  },
  selectedEntityId: null,
  selectedEntityData: null,
  subtypeVisibility: {},
  subtypeCounts: {},
  tileMode: 'google' as 'google' | 'osm',
  clusteringEnabled: true,
  setTileMode: (tileMode) => set({ tileMode }),
  toggleClustering: () => set(s => ({ clusteringEnabled: !s.clusteringEnabled })),
  streamMetrics: {
      aviation: { label: 'OpenSky Network', source: 'api.opensky-network.org', type: 'REST Polling (global)', count: 0, speed: '0 bps', status: 'connecting', poll: '90s', upstream: '5–10s ADS-B' },
      maritime: { label: 'AISStream', source: 'wss://stream.aisstream.io', type: 'WebSocket', count: 0, speed: '0 msgs/s', status: 'connecting', poll: 'push (live)', upstream: '2–10s AIS' },
      osint: { label: 'GDACS + USGS + EONET', source: 'gdacs / usgs / nasa', type: 'REST aggregated', count: 0, speed: '-', status: 'connecting', poll: '5m', upstream: 'event-driven (~min)' },
      satellites: { label: 'CelesTrak', source: 'celestrak.org', type: 'SGP4', count: 0, speed: '-', status: 'connecting', poll: '24h cache', upstream: '2–3 ×/day' },
      jamming:  { label: 'GNSS Jamming Hot Spots', source: 'OSINT aggregated', type: 'static (hardcoded)', count: 0, speed: '-', status: 'connecting', poll: 'on connect', upstream: 'manual updates' },
      labels:   { label: 'Borders & Cities', source: 'NaturalEarth', type: 'GeoJSON (static)', count: 0, speed: '-', status: 'connecting', poll: 'on load', upstream: 'yearly updates' },
      fires:    { label: 'Active Fires', source: 'NASA FIRMS', type: 'REST CSV', count: 0, speed: '-', status: 'connecting', poll: '30m', upstream: '3-hourly VIIRS' },
      cables:   { label: 'Submarine Cables', source: 'TeleGeography', type: 'GeoJSON (static)', count: 0, speed: '-', status: 'connecting', poll: 'on load', upstream: 'yearly' },
      webcams:  { label: 'Live Webcams', source: 'Aggregated', type: 'REST (HLS streams)', count: 0, speed: '-', status: 'connecting', poll: '1h', upstream: 'live HLS' },
      infrastructure: { label: 'Critical Infrastructure', source: 'OpenStreetMap', type: 'Overpass API', count: 0, speed: '-', status: 'connecting', poll: 'on viewport', upstream: '1h cache' },
      pipelines: { label: 'Oil & Gas Pipelines', source: 'OpenStreetMap', type: 'Overpass API', count: 0, speed: '-', status: 'connecting', poll: 'once', upstream: '24h cache' },
      outages:   { label: 'Internet Outages', source: 'IODA + Cloudflare Radar', type: 'REST Polling', count: 0, speed: '-', status: 'connecting', poll: '5m', upstream: '10m alerts' },
      clouds:   { label: 'Satellite Clouds', source: 'NASA GIBS', type: 'WMTS imagery overlay', count: 0, speed: 'daily snapshot', status: 'streaming', poll: 'daily', upstream: 'daily MODIS' },
      satellite_imagery: { label: 'Satellite Imagery', source: 'NASA GIBS MODIS', type: 'WMTS imagery overlay', count: 0, speed: 'daily snapshot', status: 'streaming', poll: 'daily', upstream: 'daily MODIS' },
      traffic: { label: 'Traffic Flow', source: 'TomTom + HERE', type: 'Raster tile overlay', count: 0, speed: '-', status: 'connecting', poll: 'on demand', upstream: 'real-time (~1 min)' },
      conflicts: { label: 'Armed Conflicts', source: 'ACLED', type: 'REST Polling', count: 0, speed: '-', status: 'connecting', poll: '30m', upstream: 'daily updates' },
      airspace: { label: 'Restricted Airspace', source: 'OpenAIP', type: 'REST cached', count: 0, speed: '-', status: 'connecting', poll: '1h', upstream: 'weekly updates' },
      gfw: { label: 'Dark Vessel Events', source: 'Global Fishing Watch', type: 'REST Polling', count: 0, speed: '-', status: 'connecting', poll: '1h', upstream: 'event-driven' },
  },
  setMode: (mode) => set({ mode }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setSpeedMultiplier: (speedMultiplier) => set({ speedMultiplier }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setShowTrajectories: (show) => set({ showTrajectories: show }),
  toggleTrajectories: () => set((state) => ({ showTrajectories: !state.showTrajectories })),
  toggleLayer: (layer) => set((state) => ({ 
      layers: { ...state.layers, [layer]: !state.layers[layer] } 
  })),
  setSelectedEntityId: (id, data) => set({ selectedEntityId: id, selectedEntityData: data || null }),
  setStreamMetric: (layer, data) => set(state => ({
      streamMetrics: {
          ...state.streamMetrics,
          [layer]: { ...state.streamMetrics[layer], ...data }
      }
  })),
  toggleSubtype: (key) => set(state => ({
      subtypeVisibility: {
          ...state.subtypeVisibility,
          // default is true; first click flips to false
          [key]: state.subtypeVisibility[key] === false ? true : false,
      }
  })),
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
