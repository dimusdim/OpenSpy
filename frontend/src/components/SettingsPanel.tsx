'use client';

import { useState, useEffect, useMemo } from 'react';
import { Settings, X, Radio, Database, Eye, EyeOff, Save, ChevronDown, ChevronRight } from 'lucide-react';
import { useTimelineStore, type LayerName } from '../store/useTimelineStore';
import { API_URL, CESIUM_ION_TOKEN } from '../lib/config';

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const getStatusColor = (status: string) => {
    switch (status) {
        case 'streaming': return 'bg-green-500';
        case 'limited': return 'bg-green-400';
        case 'degraded': case 'warning': return 'bg-yellow-500';
        case 'connecting': return 'bg-yellow-400';
        case 'rate-limited': return 'bg-orange-400';
        case 'auth-missing': return 'bg-orange-500';
        case 'disabled': return 'bg-zinc-600';
        case 'error': return 'bg-red-500';
        default: return 'bg-yellow-400';
    }
};

const getStatusLabel = (status: string) => {
    switch (status) {
        case 'streaming': return 'Active';
        case 'limited': return 'Free tier';
        case 'connecting': return 'Loading...';
        case 'rate-limited': return 'Rate limited';
        case 'auth-missing': return 'API key needed';
        case 'disabled': return 'Disabled';
        case 'error': return 'Error';
        default: return status;
    }
};

const getStatusBadgeClass = (status: string) => {
    switch (status) {
        case 'streaming':
        case 'limited':
            return 'border-emerald-700/50 bg-emerald-950/30 text-emerald-300';
        case 'auth-missing':
        case 'rate-limited':
            return 'border-amber-700/50 bg-amber-950/30 text-amber-300';
        case 'error':
            return 'border-red-800/60 bg-red-950/40 text-red-300';
        case 'disabled':
            return 'border-zinc-700/60 bg-zinc-900/60 text-zinc-500';
        default:
            return 'border-zinc-700/60 bg-zinc-900/50 text-zinc-400';
    }
};

const formatCount = (value: number | undefined) => (value ?? 0).toLocaleString();

function ToggleSwitch({ enabled, onClick, title, disabled = false }: {
    enabled: boolean;
    onClick: () => void;
    title?: string;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            className={`relative h-4 w-8 shrink-0 rounded-full border transition-colors ${
                enabled
                    ? 'border-cyan-500 bg-cyan-500'
                    : 'border-zinc-700 bg-zinc-800'
            } ${disabled ? 'cursor-not-allowed opacity-40' : 'hover:border-zinc-500'}`}
        >
            <span
                className={`absolute top-0.5 h-3 w-3 rounded-full transition-transform ${
                    enabled ? 'translate-x-4 bg-black' : 'translate-x-0.5 bg-zinc-300'
                }`}
            />
        </button>
    );
}

// ---------------------------------------------------------------------------
// Provider definitions — atomic data sources, NOT layer groupings
// ---------------------------------------------------------------------------

interface ProviderDef {
    id: string;
    name: string;
    description: string;
    url: string;
    type: string;
    poll: string;
    // Which layer(s) this provider feeds
    layers: LayerName[];
    // API key env vars (if any)
    envVars?: string[];
    envVarNote?: string;
    registrationUrl?: string;
    registrationLabel?: string;
    // Is this provider always free / no auth needed?
    free?: boolean;
}

const PROVIDERS: ProviderDef[] = [
    // Aviation
    { id: 'opensky', name: 'OpenSky Network', description: 'Real-time ADS-B aircraft positions worldwide. OAuth2 gives 4000 credits/day.', url: 'opensky-network.org', type: 'REST Polling', poll: '90s', layers: ['aviation'], envVars: ['OPENSKY_USERNAME', 'OPENSKY_PASSWORD'], registrationUrl: 'https://opensky-network.org/index.php/register', registrationLabel: 'OpenSky Network' },
    // Maritime
    { id: 'aisstream', name: 'AISStream', description: 'Live AIS vessel tracking via persistent WebSocket. Global coverage.', url: 'stream.aisstream.io', type: 'WebSocket', poll: 'live', layers: ['maritime'], envVars: ['AISSTREAM_API_KEY'], registrationUrl: 'https://aisstream.io/', registrationLabel: 'AISStream.io' },
    // Satellites
    { id: 'spacetrack', name: 'Space-Track.org', description: 'Primary TLE source for orbital elements. Falls back to CelesTrak if unconfigured.', url: 'space-track.org', type: 'REST', poll: '24h', layers: ['satellites'], envVars: ['SPACETRACK_EMAIL', 'SPACETRACK_PASSWORD'], registrationUrl: 'https://www.space-track.org/auth/createAccount', registrationLabel: 'Space-Track.org' },
    { id: 'celestrak', name: 'CelesTrak', description: 'Free TLE fallback source. No auth needed.', url: 'celestrak.org', type: 'REST', poll: '24h', layers: ['satellites'], free: true },
    { id: 'spectator', name: 'Spectator Earth', description: 'Satellite sensor metadata for footprint projections.', url: 'api.spectator.earth', type: 'REST', poll: 'on load', layers: ['satelliteFootprints'], free: true },
    // Disasters
    { id: 'gdacs', name: 'GDACS', description: 'Global Disaster Alert and Coordination System. Earthquakes, cyclones, floods, volcanoes.', url: 'gdacs.org', type: 'REST', poll: '5m', layers: ['disasters'], free: true },
    { id: 'usgs', name: 'USGS Earthquakes', description: 'M2.5+ earthquakes worldwide, updated every few minutes.', url: 'earthquake.usgs.gov', type: 'GeoJSON', poll: '5m', layers: ['disasters'], free: true },
    { id: 'eonet', name: 'NASA EONET', description: 'NASA natural events — wildfires, volcanoes, storms, icebergs.', url: 'eonet.gsfc.nasa.gov', type: 'REST', poll: '5m', layers: ['disasters'], free: true },
    // Conflicts
    { id: 'acled', name: 'ACLED', description: 'Armed Conflict Location & Event Data. Battles, explosions, violence against civilians.', url: 'acleddata.com', type: 'REST', poll: '30m', layers: ['conflicts'], envVars: ['ACLED_EMAIL', 'ACLED_PASSWORD', 'ACLED_KEY'], envVarNote: 'Use ACLED_EMAIL + ACLED_KEY for access-key accounts. Password OAuth requires explicit ACLED_AUTH_MODE=oauth or ACLED_ENABLE_PASSWORD_OAUTH=true.', registrationUrl: 'https://acleddata.com/api-documentation/getting-started', registrationLabel: 'ACLED' },
    { id: 'gdelt', name: 'GDELT', description: 'Global events database. Auto-updated from news, no auth needed.', url: 'gdeltproject.org', type: 'CSV', poll: '15m', layers: ['conflicts'], free: true },
    // Fires
    { id: 'firms', name: 'NASA FIRMS', description: 'VIIRS active fire hotspots, 3-hourly global updates. MAP_KEY enables targeted historical Area API imports.', url: 'firms.modaps.eosdis.nasa.gov', type: 'CSV', poll: '30m', layers: ['fires'], envVars: ['FIRMS_MAP_KEY', 'NASA_FIRMS_MAP_KEY'], envVarNote: 'Live/recent fire feed works without a key. Configure one free NASA FIRMS MAP_KEY for source-fetch firms-fires history.', registrationUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/', registrationLabel: 'NASA FIRMS MAP_KEY', free: true },
    // Infrastructure
    { id: 'overture', name: 'Overture Maps', description: 'Global infrastructure data cached in local DuckDB. Power plants, refineries, military bases, power lines, and utility pipeline geometry.', url: 'overturemaps.org', type: 'DuckDB cache', poll: 'on viewport', layers: ['infrastructure', 'pipelines'], free: true },
    { id: 'overpass', name: 'OpenStreetMap Overpass', description: 'Real-time OSM queries for infrastructure viewport enrichment.', url: 'overpass-api.de', type: 'Overpass QL', poll: 'on viewport', layers: ['infrastructure'], free: true },
    // Cables
    { id: 'telegeography', name: 'TeleGeography', description: 'Global submarine cable network map.', url: 'submarinecablemap.com', type: 'GeoJSON', poll: 'on load', layers: ['cables'], free: true },
    // Webcams
    { id: 'les', name: 'Live Environment Streams', description: 'Aggregated live HLS camera streams worldwide.', url: 'live-environment-streams', type: 'REST', poll: '1h', layers: ['webcams'], free: true },
    { id: 'windy', name: 'Windy Webcams', description: 'Windy.com webcam previews and embeds.', url: 'api.windy.com', type: 'REST', poll: '1h', layers: ['webcams'], envVars: ['WINDY_API_KEY'], registrationUrl: 'https://api.windy.com/', registrationLabel: 'Windy API' },
    // Jamming
    { id: 'gpsjam', name: 'GPSJam.org', description: 'GNSS jamming hotspots from ADS-B navigation integrity analysis.', url: 'gpsjam.org', type: 'CSV (H3)', poll: '6h', layers: ['jamming'], free: true },
    // Outages
    { id: 'ioda', name: 'IODA', description: 'Internet Outage Detection & Analysis. BGP + active probing.', url: 'ioda.inetintel.cc.gatech.edu', type: 'REST', poll: '5m', layers: ['outages'], free: true },
    { id: 'cloudflare', name: 'Cloudflare Radar', description: 'Internet outage detection from Cloudflare edge network.', url: 'radar.cloudflare.com', type: 'REST', poll: '5m', layers: ['outages'], envVars: ['CLOUDFLARE_API_TOKEN'], registrationUrl: 'https://dash.cloudflare.com/profile/api-tokens', registrationLabel: 'Cloudflare' },
    { id: 'wigle', name: 'WiGLE', description: 'Crowdsourced Wi-Fi access point observations. Viewport-only queries; passwords are never fetched or displayed.', url: 'api.wigle.net', type: 'REST viewport', poll: 'on viewport', layers: ['wifi'], envVars: ['WIGLE_API_NAME', 'WIGLE_API_TOKEN'], registrationUrl: 'https://wigle.net/account', registrationLabel: 'WiGLE' },
    // Traffic
    { id: 'tomtom', name: 'TomTom Traffic', description: 'Real-time traffic flow raster tiles.', url: 'developer.tomtom.com', type: 'Raster tiles', poll: 'on demand', layers: ['traffic'], envVars: ['TOMTOM_API_KEY'], registrationUrl: 'https://developer.tomtom.com/', registrationLabel: 'TomTom Developer' },
    // Airspace
    { id: 'openaip', name: 'OpenAIP', description: 'Restricted, prohibited, and danger airspace zones.', url: 'openaip.net', type: 'REST paginated', poll: '1h', layers: ['airspace'], envVars: ['OPENAIP_API_KEY'], registrationUrl: 'https://www.openaip.net/', registrationLabel: 'OpenAIP' },
    // GFW
    { id: 'gfw', name: 'Global Fishing Watch', description: 'Dark vessel gap events and AIS anomalies.', url: 'globalfishingwatch.org', type: 'REST', poll: '1h', layers: ['gfw'], envVars: ['GFW_TOKEN'], registrationUrl: 'https://globalfishingwatch.org/our-apis/', registrationLabel: 'Global Fishing Watch' },
    // Borders
    { id: 'naturalearth', name: 'Natural Earth', description: 'Country borders, coastlines, and major cities.', url: 'naturalearthdata.com', type: 'GeoJSON (static)', poll: 'on load', layers: ['labels'], free: true },
    // Imagery
    { id: 'nasa-gibs', name: 'NASA GIBS', description: 'MODIS satellite imagery and cloud cover overlays.', url: 'gibs.earthdata.nasa.gov', type: 'WMTS tiles', poll: 'daily', layers: ['clouds', 'satellite_imagery'], free: true },
    { id: 'copernicus', name: 'Copernicus Data Space', description: 'Sentinel scene search and bounded imagery overlays via backend-owned OAuth credentials.', url: 'dataspace.copernicus.eu', type: 'STAC / Sentinel Hub', poll: 'on demand', layers: ['satellite_imagery'], envVars: ['COPERNICUS_CLIENT_ID', 'COPERNICUS_CLIENT_SECRET'], registrationUrl: 'https://shapps.dataspace.copernicus.eu/', registrationLabel: 'Copernicus Data Space' },
    // Map rendering (frontend NEXT_PUBLIC_* keys — validated client-side, not via /api/keys)
    { id: 'cesium-ion', name: 'Cesium ion', description: 'World Terrain, ion aerial imagery and OSM 3D Buildings (used by the OSM 3D mode). Without a token the globe falls back to keyless OSM raster.', url: 'ion.cesium.com', type: 'ion assets', poll: 'on load', layers: [], envVarNote: 'Set NEXT_PUBLIC_CESIUM_ION_TOKEN in frontend/.env.local and restart the frontend.', registrationUrl: 'https://ion.cesium.com/tokens', registrationLabel: 'Cesium ion' },
    { id: 'google-3d', name: 'Google Map Tiles', description: 'Photorealistic 3D Tiles base layer (Google 3D mode). Requires a Google Cloud project with billing; falls back to OSM when missing.', url: 'tile.googleapis.com', type: '3D Tiles', poll: 'on load', layers: [], envVarNote: 'Set NEXT_PUBLIC_GOOGLE_MAPS_KEY in frontend/.env.local and restart the frontend.', registrationUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key', registrationLabel: 'Google Map Tiles API' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Tab = 'sources' | 'display';

interface KeyInfo {
    label: string;
    keys: Record<string, { set: boolean; masked: string }>;
}

interface ProviderStatus {
    status: string;
    count: number;
    note?: string;
}

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
    const streamMetrics = useTimelineStore(s => s.streamMetrics);
    const sources = useTimelineStore(s => s.sources);
    const toggleSource = useTimelineStore(s => s.toggleSource);
    const showTrajectories = useTimelineStore(s => s.showTrajectories);
    const toggleTrajectories = useTimelineStore(s => s.toggleTrajectories);
    const tileMode = useTimelineStore(s => s.tileMode);
    const setTileMode = useTimelineStore(s => s.setTileMode);
    const osm3dObjectsVisible = useTimelineStore(s => s.osm3dObjectsVisible);
    const setOsm3dObjectsVisible = useTimelineStore(s => s.setOsm3dObjectsVisible);
    const satelliteRenderLimit = useTimelineStore(s => s.satelliteRenderLimit);
    const setSatelliteRenderLimit = useTimelineStore(s => s.setSatelliteRenderLimit);

    const [tab, setTab] = useState<Tab>('sources');
    const [apiKeys, setApiKeys] = useState<Record<string, KeyInfo>>({});
    const [mapKeyStatuses, setMapKeyStatuses] = useState<Record<string, ProviderStatus>>({});

    useEffect(() => {
        if (!isOpen) return;
        fetch(`${API_URL}/api/keys`)
            .then(r => r.json())
            .then(data => setApiKeys(data))
            .catch(() => {});
    }, [isOpen]);

    // Frontend map-rendering keys: validate live against the providers so an
    // expired/revoked token shows as a real error instead of silently failing.
    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        const set = (id: string, status: ProviderStatus) => {
            if (!cancelled) setMapKeyStatuses(prev => ({ ...prev, [id]: status }));
        };

        if (!CESIUM_ION_TOKEN) {
            set('cesium-ion', { status: 'auth-missing', count: 0 });
        } else {
            set('cesium-ion', { status: 'connecting', count: 0 });
            fetch(`https://api.cesium.com/v1/assets/2/endpoint?access_token=${encodeURIComponent(CESIUM_ION_TOKEN)}`)
                .then(r => set('cesium-ion', r.ok
                    ? { status: 'streaming', count: 0 }
                    : { status: 'error', count: 0, note: r.status === 401 ? 'Token rejected by Cesium ion (401) — expired or revoked. Generate a new one and update NEXT_PUBLIC_CESIUM_ION_TOKEN.' : `Cesium ion returned HTTP ${r.status}` }))
                .catch(() => set('cesium-ion', { status: 'error', count: 0, note: 'Cesium ion unreachable' }));
        }

        const googleKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
        if (!googleKey) {
            set('google-3d', { status: 'auth-missing', count: 0 });
        } else {
            set('google-3d', { status: 'connecting', count: 0 });
            fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(googleKey)}`)
                .then(r => set('google-3d', r.ok
                    ? { status: 'streaming', count: 0 }
                    : { status: 'error', count: 0, note: `Google Map Tiles rejected the key (HTTP ${r.status}). Check key restrictions and billing in Google Cloud Console.` }))
                .catch(() => set('google-3d', { status: 'error', count: 0, note: 'Google Map Tiles unreachable' }));
        }
        return () => { cancelled = true; };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Derive provider status from streamMetrics
    const providerStatuses = useMemo(() => {
        const result: Record<string, ProviderStatus> = {};
        for (const p of PROVIDERS) {
            // Aggregate status from all layers this provider feeds
            let bestStatus = 'connecting';
            let totalCount = 0;
            let note: string | undefined;
            for (const l of p.layers) {
                const m = streamMetrics[l];
                if (!m) continue;
                totalCount += m.count || 0;
                if (m.note) note = m.note;
                // Pick the "best" status (streaming > limited > warning/degraded/rate-limited > connecting > error > auth-missing)
                if (m.status === 'streaming' || m.status === 'limited') bestStatus = m.status;
                else if ((m.status === 'warning' || m.status === 'degraded') && bestStatus !== 'streaming' && bestStatus !== 'limited') bestStatus = 'warning';
                else if (m.status === 'rate-limited' && bestStatus !== 'streaming' && bestStatus !== 'limited') bestStatus = 'rate-limited';
                else if (m.status === 'error' && bestStatus !== 'streaming' && bestStatus !== 'limited') bestStatus = 'error';
                else if (m.status === 'auth-missing' && bestStatus === 'connecting') bestStatus = 'auth-missing';
            }
            // If provider has envVars and none are set, show auth-missing
            if (p.envVars && !p.free) {
                const allKeysSet = p.envVars.every(ev => {
                    const layerKeys = Object.values(apiKeys);
                    return layerKeys.some(lk => lk.keys[ev]?.set);
                });
                if (!allKeysSet && bestStatus === 'connecting') bestStatus = 'auth-missing';
            }
            if (p.free && bestStatus === 'auth-missing') bestStatus = 'streaming';
            result[p.id] = { status: bestStatus, count: totalCount, note };
        }
        // Frontend map-rendering keys are validated client-side (live probe),
        // not via backend stream metrics — their probed status wins.
        Object.assign(result, mapKeyStatuses);
        return result;
    }, [streamMetrics, apiKeys, mapKeyStatuses]);

    if (!isOpen) return null;

    const TABS: { key: Tab; label: string; icon: typeof Database }[] = [
        { key: 'sources', label: 'Sources & keys', icon: Database },
        { key: 'display', label: 'Display', icon: Eye },
    ];

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" onClick={onClose}>
            <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
            <div
                className="relative flex h-[84vh] w-full max-w-[820px] flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#09090b] text-zinc-100 shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-xl"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-4 py-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-[#17171b] text-cyan-300">
                        <Settings className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h2 className="m-0 text-sm font-semibold text-zinc-100">Settings</h2>
                        <p className="mt-0.5 truncate text-[11px] text-zinc-500">Provider status, source toggles, credentials, and display controls</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                        title="Close settings"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex shrink-0 gap-1 border-b border-zinc-800 px-4">
                    {TABS.map(t => {
                        const Icon = t.icon;
                        return (
                            <button
                                key={t.key}
                                onClick={() => setTab(t.key)}
                                className={`mb-[-1px] flex items-center gap-2 border-b-2 px-3 py-2 text-xs transition-colors ${
                                    tab === t.key
                                        ? 'border-cyan-400 text-zinc-100'
                                        : 'border-transparent text-zinc-500 hover:text-zinc-200'
                                }`}
                            >
                                <Icon size={13} />
                                {t.label}
                            </button>
                        );
                    })}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {tab === 'sources' && (
                        <SourcesTab providers={PROVIDERS} providerStatuses={providerStatuses} sources={sources} toggleSource={toggleSource} apiKeys={apiKeys}
                            onKeysChanged={() => { fetch(`${API_URL}/api/keys`).then(r => r.json()).then(d => setApiKeys(d)).catch(() => {}); }} />
                    )}
                    {tab === 'display' && (
                        <DisplayTab
                            showTrajectories={showTrajectories}
                            toggleTrajectories={toggleTrajectories}
                            tileMode={tileMode}
                            setTileMode={setTileMode}
                            osm3dObjectsVisible={osm3dObjectsVisible}
                            setOsm3dObjectsVisible={setOsm3dObjectsVisible}
                            satelliteRenderLimit={satelliteRenderLimit}
                            setSatelliteRenderLimit={setSatelliteRenderLimit}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Sources Tab — per-provider rows
// ---------------------------------------------------------------------------
function SourcesTab({ providers, providerStatuses, sources, toggleSource, apiKeys, onKeysChanged }: {
    providers: ProviderDef[]; providerStatuses: Record<string, ProviderStatus>; sources: Record<LayerName, boolean>; toggleSource: (k: LayerName) => void;
    apiKeys: Record<string, KeyInfo>; onKeysChanged: () => void;
}) {
    const active = providers.filter(p => providerStatuses[p.id]?.status !== 'auth-missing');
    const needsSetup = providers.filter(p => providerStatuses[p.id]?.status === 'auth-missing');

    return (
        <div className="space-y-2">
            {active.map(p => (
                <ProviderRow key={p.id} provider={p} status={providerStatuses[p.id]} sources={sources} toggleSource={toggleSource} apiKeys={apiKeys} onKeysChanged={onKeysChanged} />
            ))}
            {needsSetup.length > 0 && (
                <>
                    <div className="flex items-center gap-2 pb-1 pt-3">
                        <div className="flex-1 border-t border-zinc-800" />
                        <span className="font-mono text-[10px] uppercase tracking-wider text-amber-400">Needs setup</span>
                        <div className="flex-1 border-t border-zinc-800" />
                    </div>
                    {needsSetup.map(p => (
                        <ProviderRow key={p.id} provider={p} status={providerStatuses[p.id]} sources={sources} toggleSource={toggleSource} apiKeys={apiKeys} onKeysChanged={onKeysChanged} />
                    ))}
                </>
            )}
        </div>
    );
}

function ProviderRow({ provider, status, sources, toggleSource, apiKeys, onKeysChanged }: {
    provider: ProviderDef; status?: ProviderStatus; sources: Record<LayerName, boolean>; toggleSource: (k: LayerName) => void;
    apiKeys: Record<string, KeyInfo>; onKeysChanged: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const st = status?.status || 'connecting';
    const isOn = provider.layers.some(l => sources[l]);
    const toggleProvider = () => {
        const next = !isOn;
        for (const layer of provider.layers) {
            if (Boolean(sources[layer]) !== next) toggleSource(layer);
        }
    };

    // Find relevant API key info for this provider
    const providerKeyInfo = useMemo(() => {
        if (!provider.envVars?.length) return null;
        const keys: Record<string, { set: boolean; masked: string }> = {};
        for (const ev of provider.envVars) {
            // Search across all apiKeys entries for this env var
            let found = false;
            for (const lk of Object.values(apiKeys)) {
                if (lk.keys[ev]) {
                    keys[ev] = lk.keys[ev];
                    found = true;
                    break;
                }
            }
            if (!found) keys[ev] = { set: false, masked: '' };
        }
        return keys;
    }, [provider.envVars, apiKeys]);

    return (
        <div className={`overflow-hidden rounded-md border transition-colors ${isOn ? 'border-zinc-700/70 bg-[#1a1a1f]/92' : 'border-zinc-800/60 bg-[#151519]/78 opacity-75'}`}>
            <div className="flex items-stretch">
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[#24242a]/70"
                >
                    {expanded ? <ChevronDown size={13} className="shrink-0 text-zinc-600" /> : <ChevronRight size={13} className="shrink-0 text-zinc-600" />}
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${getStatusColor(st)}`} />
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium text-zinc-100">{provider.name}</span>
                            {provider.free && <span className="rounded border border-emerald-800/50 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-emerald-400">Free</span>}
                            <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${getStatusBadgeClass(st)}`}>{getStatusLabel(st)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-500">
                            <span><span className="text-zinc-600">objects</span> <span className="text-zinc-300">{formatCount(status?.count)}</span></span>
                            <span><span className="text-zinc-600">poll</span> <span className="text-zinc-300">{provider.poll}</span></span>
                            <span><span className="text-zinc-600">layers</span> <span className="text-zinc-300">{provider.layers.join(', ')}</span></span>
                        </div>
                    </div>
                </button>
                <div className="flex items-center border-l border-zinc-800/80 bg-black/10 px-3">
                    <ToggleSwitch
                        enabled={isOn}
                        onClick={toggleProvider}
                        title={isOn ? `Disable ${provider.name}` : `Enable ${provider.name}`}
                    />
                </div>
            </div>

            {expanded && (
                <div className="space-y-3 border-t border-zinc-800/70 bg-black/10 px-4 pb-3 pt-3">
                    <div className="grid grid-cols-2 gap-2 text-[10px] md:grid-cols-4">
                        <div className="rounded border border-zinc-800/80 bg-[#24242a]/70 px-2 py-1.5"><span className="block text-zinc-500">URL</span><p className="truncate text-zinc-200">{provider.url}</p></div>
                        <div className="rounded border border-zinc-800/80 bg-[#24242a]/70 px-2 py-1.5"><span className="block text-zinc-500">Type</span><p className="truncate text-zinc-200">{provider.type}</p></div>
                        <div className="rounded border border-zinc-800/80 bg-[#24242a]/70 px-2 py-1.5"><span className="block text-zinc-500">Poll</span><p className="truncate text-zinc-200">{provider.poll}</p></div>
                        <div className="rounded border border-zinc-800/80 bg-[#24242a]/70 px-2 py-1.5"><span className="block text-zinc-500">Objects</span><p className="truncate text-zinc-200">{formatCount(status?.count)}</p></div>
                    </div>
                    <p className="text-[11px] leading-relaxed text-zinc-500">{provider.description}</p>

                    {status?.note && (
                        <div className="flex items-start gap-2 rounded border border-amber-900/50 bg-amber-950/20 px-2 py-2">
                            <Radio className="mt-0.5 h-3 w-3 shrink-0 text-amber-300" />
                            <span className="break-words text-[10px] text-amber-200">{status.note}</span>
                        </div>
                    )}

                    {/* Inline API keys */}
                    {providerKeyInfo && Object.keys(providerKeyInfo).length > 0 && (
                        <ApiKeyFields envVars={providerKeyInfo} note={provider.envVarNote} registrationUrl={provider.registrationUrl} registrationLabel={provider.registrationLabel} onKeysChanged={onKeysChanged} />
                    )}

                    {/* Source toggle per layer */}
                    {provider.layers.map(l => (
                        <div key={l} className="flex items-center justify-between rounded border border-zinc-800/80 bg-[#24242a]/60 px-2 py-1.5">
                            <span className="font-mono text-[10px] text-zinc-500">{l} layer</span>
                            <ToggleSwitch enabled={Boolean(sources[l])} onClick={() => toggleSource(l)} title={sources[l] ? `Disable ${l}` : `Enable ${l}`} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Inline API Key Fields
// ---------------------------------------------------------------------------
function ApiKeyFields({ envVars, note, registrationUrl, registrationLabel, onKeysChanged }: {
    envVars: Record<string, { set: boolean; masked: string }>;
    note?: string; registrationUrl?: string; registrationLabel?: string; onKeysChanged: () => void;
}) {
    const [editing, setEditing] = useState<Record<string, string>>({});
    const [revealed, setRevealed] = useState<Record<string, boolean>>({});
    const [saving, setSaving] = useState(false);
    const hasEdits = Object.keys(editing).length > 0;

    const handleSave = async () => {
        if (!hasEdits) return;
        setSaving(true);
        try {
            await fetch(`${API_URL}/api/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editing) });
            setEditing({});
            onKeysChanged();
        } catch { /* ignore */ }
        setSaving(false);
    };

    return (
        <div className="space-y-2 rounded border border-zinc-800/80 bg-[#202025]/75 p-2">
            <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">API keys</div>
            {note && <p className="text-[10px] leading-relaxed text-zinc-500">{note}</p>}
            {Object.entries(envVars).map(([envVar, info]) => (
                <div key={envVar} className="flex items-center gap-2">
                    <span className="w-36 truncate font-mono text-[9px] text-zinc-500" title={envVar}>{envVar}</span>
                    <input
                        type={revealed[envVar] ? 'text' : 'password'}
                        value={envVar in editing ? editing[envVar] : (info.set ? info.masked : '')}
                        placeholder={info.set ? '' : 'Not configured'}
                        onChange={e => setEditing(prev => ({ ...prev, [envVar]: e.target.value }))}
                        className="h-7 min-w-0 flex-1 rounded border border-zinc-800 bg-[#101014]/85 px-2 font-mono text-[10px] text-zinc-300 placeholder-zinc-600 outline-none focus:border-cyan-700"
                    />
                    <button onClick={() => setRevealed(prev => ({ ...prev, [envVar]: !prev[envVar] }))} className="text-zinc-600 hover:text-zinc-300" title={revealed[envVar] ? 'Hide' : 'Reveal'}>
                        {revealed[envVar] ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                </div>
            ))}
            {registrationUrl && !Object.values(envVars).every(v => v.set) && (
                <div className="text-[10px]">
                    <span className="text-zinc-500">Register at </span>
                    <a href={registrationUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline hover:text-cyan-200">{registrationLabel || registrationUrl}</a>
                </div>
            )}
            {hasEdits && (
                <button onClick={handleSave} disabled={saving}
                    className="flex items-center gap-1.5 rounded border border-cyan-700/50 bg-cyan-950/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-cyan-300 transition-colors hover:bg-cyan-900/50 disabled:opacity-50">
                    <Save size={10} />{saving ? 'Saving...' : 'Save Keys'}
                </button>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Display Tab
// ---------------------------------------------------------------------------
function DisplayTab({ showTrajectories, toggleTrajectories, tileMode, setTileMode, osm3dObjectsVisible, setOsm3dObjectsVisible, satelliteRenderLimit, setSatelliteRenderLimit }: {
    showTrajectories: boolean; toggleTrajectories: () => void;
    tileMode: 'google' | 'osm' | 'modis'; setTileMode: (m: 'google' | 'osm' | 'modis') => void;
    osm3dObjectsVisible: boolean; setOsm3dObjectsVisible: (visible: boolean) => void;
    satelliteRenderLimit: number | null; setSatelliteRenderLimit: (limit: number | null) => void;
}) {
    const [satelliteLimitInput, setSatelliteLimitInput] = useState(
        satelliteRenderLimit == null ? '5000' : String(satelliteRenderLimit),
    );

    useEffect(() => {
        setSatelliteLimitInput(satelliteRenderLimit == null ? '5000' : String(satelliteRenderLimit));
    }, [satelliteRenderLimit]);

    const MODE_LABELS: Record<'google' | 'osm' | 'modis', string> = {
        google: 'Google 3D',
        osm: 'OpenStreetMap',
        modis: 'MODIS',
    };
    return (
        <div className="space-y-3">
            <div className="rounded-md border border-zinc-800/80 bg-[#1a1a1f]/92 p-3">
                <label className="flex cursor-pointer items-center justify-between">
                    <div>
                        <div className="text-sm text-zinc-100">Orbital / Flight Trajectories</div>
                        <div className="mt-0.5 text-[10px] text-zinc-500">Show vessel wakes and satellite orbital trails</div>
                    </div>
                    <ToggleSwitch enabled={showTrajectories} onClick={toggleTrajectories} />
                </label>
            </div>
            <div className="rounded-md border border-zinc-800/80 bg-[#1a1a1f]/92 p-3">
                <div className="mb-2 text-sm text-zinc-100">Base Map</div>
                <div className="flex overflow-hidden rounded border border-zinc-800">
                    {(['google', 'osm', 'modis'] as const).map(mode => (
                        <button key={mode} onClick={() => setTileMode(mode)}
                            className={`flex-1 border-r border-zinc-800 px-3 py-2 font-mono text-xs uppercase tracking-wider transition-colors last:border-r-0 ${
                                tileMode === mode ? 'bg-cyan-950/40 text-cyan-300' : 'bg-[#24242a]/60 text-zinc-500 hover:bg-[#2a2a31]/75 hover:text-zinc-300'
                            }`}>{MODE_LABELS[mode]}</button>
                    ))}
                </div>
                {tileMode === 'osm' && (
                    <label className="mt-3 flex cursor-pointer items-center justify-between rounded border border-zinc-800/70 bg-[#24242a]/55 px-3 py-2">
                        <div>
                            <div className="text-xs text-zinc-100">OSM 3D Objects</div>
                            <div className="mt-0.5 text-[10px] text-zinc-500">Show building blocks in OpenStreetMap mode</div>
                        </div>
                        <ToggleSwitch enabled={osm3dObjectsVisible} onClick={() => setOsm3dObjectsVisible(!osm3dObjectsVisible)} />
                    </label>
                )}
            </div>
            <div className="rounded-md border border-zinc-800/80 bg-[#1a1a1f]/92 p-3">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <div className="text-sm text-zinc-100">Satellite render limit</div>
                        <div className="mt-0.5 text-[10px] text-zinc-500">Explicit visible cap. Type labels are still derived heuristics from TLE names.</div>
                    </div>
                    <ToggleSwitch enabled={satelliteRenderLimit != null} onClick={() => setSatelliteRenderLimit(satelliteRenderLimit == null ? 5000 : null)} />
                </div>
                <div className="mt-3 flex items-center gap-2">
                    <input
                        type="number"
                        min={1}
                        step={500}
                        value={satelliteLimitInput}
                        disabled={satelliteRenderLimit == null}
                        onChange={(e) => setSatelliteLimitInput(e.target.value)}
                        onBlur={() => {
                            const parsed = Number(satelliteLimitInput);
                            if (Number.isInteger(parsed) && parsed > 0) {
                                setSatelliteRenderLimit(parsed);
                            } else {
                                setSatelliteLimitInput(satelliteRenderLimit == null ? '5000' : String(satelliteRenderLimit));
                            }
                        }}
                        className="w-28 rounded border border-zinc-800 bg-[#101014]/85 px-3 py-2 font-mono text-xs text-zinc-200 disabled:opacity-40"
                    />
                    <span className="text-[10px] text-zinc-500">Disable the toggle to render the full visible catalog.</span>
                </div>
                <div className="mt-2 flex gap-2">
                    {[2000, 5000, 10000].map((value) => (
                        <button
                            key={value}
                            onClick={() => {
                                setSatelliteLimitInput(String(value));
                                setSatelliteRenderLimit(value);
                            }}
                            disabled={satelliteRenderLimit == null}
                            className={`rounded border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                                satelliteRenderLimit === value
                                    ? 'border-cyan-700/50 bg-cyan-950/40 text-cyan-300'
                                    : 'border-zinc-800 bg-[#24242a]/60 text-zinc-500 hover:text-zinc-300 disabled:opacity-40'
                            }`}
                        >
                            {value}
                        </button>
                    ))}
                    </div>
            </div>
        </div>
    );
}
