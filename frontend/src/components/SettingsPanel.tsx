'use client';

import { useState, useEffect, useMemo } from 'react';
import { Settings, X, Radio, Database, Eye, EyeOff, Save, ChevronDown, ChevronRight } from 'lucide-react';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

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
    layers: string[];
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
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Tab = 'sources' | 'display';

interface KeyInfo {
    label: string;
    keys: Record<string, { set: boolean; masked: string }>;
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
    const satelliteRenderLimit = useTimelineStore(s => s.satelliteRenderLimit);
    const setSatelliteRenderLimit = useTimelineStore(s => s.setSatelliteRenderLimit);

    const [tab, setTab] = useState<Tab>('sources');
    const [apiKeys, setApiKeys] = useState<Record<string, KeyInfo>>({});

    useEffect(() => {
        if (!isOpen) return;
        fetch(`${API_URL}/api/keys`)
            .then(r => r.json())
            .then(data => setApiKeys(data))
            .catch(() => {});
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Derive provider status from streamMetrics
    const providerStatuses = useMemo(() => {
        const result: Record<string, { status: string; count: number; note?: string }> = {};
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
        return result;
    }, [streamMetrics, apiKeys]);

    if (!isOpen) return null;

    const TABS: { key: Tab; label: string; icon: typeof Database }[] = [
        { key: 'sources', label: 'Data Sources', icon: Database },
        { key: 'display', label: 'Display', icon: Eye },
    ];

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={onClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div className="relative bg-black/95 backdrop-blur-xl border border-zinc-800 rounded-xl w-full max-w-[750px] h-[70vh] flex shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                {/* Left sidebar */}
                <div className="w-44 shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-900/50">
                    <div className="flex items-center gap-2 px-4 py-4 border-b border-zinc-800">
                        <Settings className="w-4 h-4 text-zinc-400" />
                        <span className="text-xs font-mono font-bold uppercase tracking-widest text-zinc-400">Settings</span>
                    </div>
                    <nav className="flex-1 py-2">
                        {TABS.map(t => {
                            const Icon = t.icon;
                            return (
                                <button key={t.key} onClick={() => setTab(t.key)}
                                    className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-mono transition-colors ${
                                        tab === t.key ? 'text-cyan-400 bg-cyan-900/20 border-r-2 border-cyan-400' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                                    }`}>
                                    <Icon size={14} />{t.label}
                                </button>
                            );
                        })}
                    </nav>
                </div>
                {/* Right content */}
                <div className="flex-1 flex flex-col min-w-0">
                    <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
                        <h2 className="text-sm font-semibold text-zinc-200">{TABS.find(t => t.key === tab)?.label}</h2>
                        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"><X className="w-4 h-4" /></button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
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
                                satelliteRenderLimit={satelliteRenderLimit}
                                setSatelliteRenderLimit={setSatelliteRenderLimit}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Sources Tab — per-provider rows
// ---------------------------------------------------------------------------
function SourcesTab({ providers, providerStatuses, sources, toggleSource, apiKeys, onKeysChanged }: {
    providers: ProviderDef[]; providerStatuses: Record<string, any>; sources: any; toggleSource: (k: any) => void;
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
                    <div className="flex items-center gap-2 pt-2 pb-1">
                        <div className="flex-1 border-t border-zinc-800" />
                        <span className="text-[10px] font-mono text-orange-500 uppercase tracking-wider">Needs Setup</span>
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
    provider: ProviderDef; status: any; sources: any; toggleSource: (k: any) => void;
    apiKeys: Record<string, KeyInfo>; onKeysChanged: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const st = status?.status || 'connecting';
    const isOn = provider.layers.some(l => sources[l]);

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
        <div className={`rounded-lg border transition-colors ${isOn ? 'border-zinc-700/60 bg-zinc-900/30' : 'border-zinc-800/40 bg-zinc-950/30 opacity-60'}`}>
            <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-zinc-800/30 transition-colors">
                {expanded ? <ChevronDown size={12} className="text-zinc-600 shrink-0" /> : <ChevronRight size={12} className="text-zinc-600 shrink-0" />}
                <span className={`w-2 h-2 rounded-full shrink-0 ${getStatusColor(st)}`} />
                <span className="text-sm text-zinc-200 flex-1 truncate">{provider.name}</span>
                {provider.free && <span className="text-[8px] font-mono text-green-600 border border-green-800/40 rounded px-1 py-0.5">FREE</span>}
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                    st === 'streaming' ? 'border-green-800/50 text-green-400 bg-green-900/20'
                    : st === 'auth-missing' ? 'border-orange-800/50 text-orange-400 bg-orange-900/20'
                    : st === 'error' ? 'border-red-800/50 text-red-400 bg-red-900/20'
                    : 'border-zinc-700/50 text-zinc-500 bg-zinc-800/20'
                }`}>{getStatusLabel(st)}</span>
            </button>

            {expanded && (
                <div className="px-4 pb-3 pt-1 space-y-2.5 border-t border-zinc-800/40">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                        <div><span className="text-zinc-600">URL</span><p className="text-zinc-400">{provider.url}</p></div>
                        <div><span className="text-zinc-600">Type</span><p className="text-zinc-400">{provider.type}</p></div>
                        <div><span className="text-zinc-600">Poll</span><p className="text-zinc-400">{provider.poll}</p></div>
                        <div><span className="text-zinc-600">Entities</span><p className="text-zinc-400">{(status?.count ?? 0).toLocaleString()}</p></div>
                    </div>
                    <p className="text-[10px] text-zinc-600 leading-relaxed">{provider.description}</p>

                    {status?.note && (
                        <div className="flex items-start gap-1.5">
                            <Radio className="w-3 h-3 text-orange-400 mt-0.5 shrink-0" />
                            <span className="text-[10px] text-orange-400 break-words">{status.note}</span>
                        </div>
                    )}

                    {/* Inline API keys */}
                    {providerKeyInfo && Object.keys(providerKeyInfo).length > 0 && (
                        <ApiKeyFields envVars={providerKeyInfo} note={provider.envVarNote} registrationUrl={provider.registrationUrl} registrationLabel={provider.registrationLabel} onKeysChanged={onKeysChanged} />
                    )}

                    {/* Source toggle per layer */}
                    {provider.layers.map(l => (
                        <div key={l} className="flex items-center justify-between">
                            <span className="text-[10px] text-zinc-500">{l} layer</span>
                            <button onClick={() => toggleSource(l)} className={`relative w-8 h-4 rounded-full transition-colors ${sources[l] ? 'bg-green-600' : 'bg-zinc-700'}`}>
                                <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${sources[l] ? 'translate-x-4' : ''}`} />
                            </button>
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
        <div className="space-y-1.5 pt-1 border-t border-zinc-800/40">
            <div className="text-[9px] font-mono text-zinc-600 uppercase tracking-wider">API Keys</div>
            {note && <p className="text-[10px] text-zinc-500 leading-relaxed">{note}</p>}
            {Object.entries(envVars).map(([envVar, info]) => (
                <div key={envVar} className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-zinc-500 w-36 truncate" title={envVar}>{envVar}</span>
                    <input
                        type={revealed[envVar] ? 'text' : 'password'}
                        value={envVar in editing ? editing[envVar] : (info.set ? info.masked : '')}
                        placeholder={info.set ? '' : 'Not configured'}
                        onChange={e => setEditing(prev => ({ ...prev, [envVar]: e.target.value }))}
                        className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[10px] font-mono text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-cyan-700"
                    />
                    <button onClick={() => setRevealed(prev => ({ ...prev, [envVar]: !prev[envVar] }))} className="text-zinc-600 hover:text-zinc-400" title={revealed[envVar] ? 'Hide' : 'Reveal'}>
                        {revealed[envVar] ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                </div>
            ))}
            {registrationUrl && !Object.values(envVars).every(v => v.set) && (
                <div className="text-[10px]">
                    <span className="text-zinc-500">Register at </span>
                    <a href={registrationUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 underline">{registrationLabel || registrationUrl}</a>
                </div>
            )}
            {hasEdits && (
                <button onClick={handleSave} disabled={saving}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider bg-cyan-900/30 text-cyan-400 border border-cyan-700/50 hover:bg-cyan-800/40 disabled:opacity-50 transition-colors">
                    <Save size={10} />{saving ? 'Saving...' : 'Save Keys'}
                </button>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Display Tab
// ---------------------------------------------------------------------------
function DisplayTab({ showTrajectories, toggleTrajectories, tileMode, setTileMode, satelliteRenderLimit, setSatelliteRenderLimit }: {
    showTrajectories: boolean; toggleTrajectories: () => void;
    tileMode: 'google' | 'osm' | 'modis'; setTileMode: (m: 'google' | 'osm' | 'modis') => void;
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
        <div className="space-y-4">
            <div className="rounded-lg border border-zinc-800/60 p-3">
                <label className="flex items-center justify-between cursor-pointer">
                    <div>
                        <div className="text-sm text-zinc-200">Orbital / Flight Trajectories</div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">Show vessel wakes and satellite orbital trails</div>
                    </div>
                    <button onClick={toggleTrajectories} className={`relative w-8 h-4 rounded-full transition-colors ${showTrajectories ? 'bg-green-600' : 'bg-zinc-700'}`}>
                        <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${showTrajectories ? 'translate-x-4' : ''}`} />
                    </button>
                </label>
            </div>
            <div className="rounded-lg border border-zinc-800/60 p-3">
                <div className="text-sm text-zinc-200 mb-2">Base Map</div>
                <div className="flex gap-2">
                    {(['google', 'osm', 'modis'] as const).map(mode => (
                        <button key={mode} onClick={() => setTileMode(mode)}
                            className={`flex-1 px-3 py-2 rounded-md text-xs font-mono uppercase tracking-wider transition-colors ${
                                tileMode === mode ? 'bg-cyan-900/30 text-cyan-400 border border-cyan-700/50' : 'bg-zinc-900/30 text-zinc-500 border border-zinc-800 hover:text-zinc-300'
                            }`}>{MODE_LABELS[mode]}</button>
                    ))}
                </div>
            </div>
            <div className="rounded-lg border border-zinc-800/60 p-3">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <div className="text-sm text-zinc-200">Satellite render limit</div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">Explicit visible cap. Type labels are still derived heuristics from TLE names.</div>
                    </div>
                    <button
                        onClick={() => setSatelliteRenderLimit(satelliteRenderLimit == null ? 5000 : null)}
                        className={`relative w-8 h-4 rounded-full transition-colors ${satelliteRenderLimit != null ? 'bg-green-600' : 'bg-zinc-700'}`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${satelliteRenderLimit != null ? 'translate-x-4' : ''}`} />
                    </button>
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
                        className="w-28 px-3 py-2 rounded-md text-xs font-mono bg-zinc-900/30 text-zinc-200 border border-zinc-800 disabled:opacity-40"
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
                            className={`px-3 py-1.5 rounded-md text-[10px] font-mono uppercase tracking-wider transition-colors ${
                                satelliteRenderLimit === value
                                    ? 'bg-cyan-900/30 text-cyan-400 border border-cyan-700/50'
                                    : 'bg-zinc-900/30 text-zinc-500 border border-zinc-800 hover:text-zinc-300 disabled:opacity-40'
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
