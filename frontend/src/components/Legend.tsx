'use client';
import { useState, useMemo, useCallback } from 'react';
import {
    Plane, Ship, Satellite, Flame, Waves, Mountain, CircleDot, Radio,
    ShieldAlert, ChevronDown, ChevronRight, PanelRightClose, PanelRight,
    Camera, Zap, Factory, Droplets, Shield, Fuel, WifiOff, Car, Ban,
    Bomb, Swords, Search, X, Globe2, Target, List, Wifi,
    Anchor, Eye, EyeOff, Skull,
} from 'lucide-react';
import { useTimelineStore, MISSION_PRESETS } from '../store/useTimelineStore';
import type { LayerName } from '../store/useTimelineStore';
import type { LucideIcon } from 'lucide-react';
import { COMPOSITE_LAYER_SOURCES, getLayerSourceVisibilityKey, type CompositeLayerCode } from '../lib/source-visibility';

// ---------------------------------------------------------------------------
// Status dot color (matches LayerManager / SettingsPanel)
// ---------------------------------------------------------------------------
const statusDotColor = (status: string | undefined) => {
    switch (status) {
        case 'streaming': return 'bg-green-500';
        case 'limited': return 'bg-green-400';
        case 'degraded': case 'warning': return 'bg-yellow-500';
        case 'connecting': return 'bg-yellow-400';
        case 'rate-limited': return 'bg-orange-400';
        case 'auth-missing': return 'bg-orange-500';
        case 'error': return 'bg-red-500';
        case 'disabled': return 'bg-zinc-600';
        default: return 'bg-zinc-600';
    }
};

// ---------------------------------------------------------------------------
// Domain tree structure
// ---------------------------------------------------------------------------
interface SubtypeNode {
    key: string;        // subtype key (e.g. 'military')
    label: string;
    icon: LucideIcon;
    color: string;
}

interface LayerNode {
    layer: LayerName;
    label: string;
    icon: LucideIcon;
    subtypes: SubtypeNode[];
    sources?: Array<{ sourceId: string; label: string }>;
    scope?: 'live-only';
    scopeNote?: string;
    // special: instead of toggleVisibility, use a different store action
    special?: 'trajectories';
}

interface DomainNode {
    domain: string;
    label: string;
    icon: LucideIcon;
    color: string;
    children: LayerNode[];
}

const DOMAIN_TREE: DomainNode[] = [
    {
        domain: 'air', label: 'Air', icon: Plane, color: 'text-sky-400',
        children: [
            {
                layer: 'aviation', label: 'Aircraft', icon: Plane,
                subtypes: [
                    { key: 'airliner', label: 'Airliner', icon: Plane, color: 'text-white' },
                    { key: 'military', label: 'Military', icon: Plane, color: 'text-yellow-400' },
                    { key: 'light', label: 'Light / GA', icon: Plane, color: 'text-blue-400' },
                    { key: 'general', label: 'General', icon: Plane, color: 'text-zinc-300' },
                ],
            },
            {
                layer: 'airspace', label: 'Airspace', icon: Ban,
                subtypes: [
                    { key: 'restricted', label: 'Restricted', icon: Ban, color: 'text-red-500' },
                    { key: 'danger', label: 'Danger', icon: Ban, color: 'text-orange-400' },
                    { key: 'prohibited', label: 'Prohibited', icon: Ban, color: 'text-red-700' },
                    { key: 'alert', label: 'Alert', icon: Ban, color: 'text-yellow-400' },
                    { key: 'warning', label: 'Warning', icon: Ban, color: 'text-amber-400' },
                ],
            },
            {
                layer: 'jamming', label: 'Jamming', icon: ShieldAlert,
                subtypes: [
                    { key: 'high', label: 'Severe', icon: ShieldAlert, color: 'text-red-500' },
                    { key: 'medium', label: 'Moderate', icon: ShieldAlert, color: 'text-orange-500' },
                    { key: 'low', label: 'Low', icon: ShieldAlert, color: 'text-yellow-500' },
                ],
            },
        ],
    },
    {
        domain: 'sea', label: 'Sea', icon: Ship, color: 'text-blue-400',
        children: [
            {
                layer: 'maritime', label: 'Vessels', icon: Ship,
                subtypes: [
                    { key: 'cargo', label: 'Cargo', icon: Ship, color: 'text-zinc-200' },
                    { key: 'tanker', label: 'Tanker', icon: Ship, color: 'text-red-500' },
                    { key: 'passenger', label: 'Passenger', icon: Ship, color: 'text-blue-500' },
                    { key: 'fishing', label: 'Fishing', icon: Ship, color: 'text-lime-500' },
                    { key: 'military', label: 'Military', icon: Ship, color: 'text-slate-400' },
                    { key: 'unknown', label: 'Unknown', icon: Ship, color: 'text-zinc-500' },
                ],
            },
            {
                layer: 'gfw', label: 'AIS Signal Lost Events', icon: Anchor,
                subtypes: [],
            },
        ],
    },
    {
        domain: 'space', label: 'Space', icon: Satellite, color: 'text-purple-400',
        children: [
            {
                layer: 'satellites', label: 'Satellites', icon: Satellite,
                subtypes: [
                    { key: 'military', label: 'Military', icon: Satellite, color: 'text-red-500' },
                    { key: 'recon', label: 'Recon', icon: Satellite, color: 'text-fuchsia-400' },
                    { key: 'commercial', label: 'Commercial', icon: Satellite, color: 'text-cyan-400' },
                    { key: 'civilian', label: 'Civilian', icon: Satellite, color: 'text-lime-400' },
                ],
            },
            {
                layer: 'satelliteFootprints', label: 'Footprints', icon: Target,
                subtypes: [],
            },
        ],
    },
    {
        domain: 'ground', label: 'Ground', icon: Bomb, color: 'text-red-400',
        children: [
            {
                layer: 'conflicts', label: 'Conflicts', icon: Swords,
                sources: COMPOSITE_LAYER_SOURCES.conflicts,
                subtypes: [
                    { key: 'explosions', label: 'Explosions', icon: Bomb, color: 'text-red-500' },
                    { key: 'battles', label: 'Battles', icon: Swords, color: 'text-orange-400' },
                    { key: 'assaults', label: 'Assaults', icon: Swords, color: 'text-red-400' },
                    { key: 'mass_violence', label: 'Mass Violence', icon: Skull, color: 'text-rose-400' },
                    { key: 'protests', label: 'Protests', icon: CircleDot, color: 'text-yellow-300' },
                    { key: 'threats', label: 'Threats', icon: ShieldAlert, color: 'text-amber-400' },
                    { key: 'force_posture', label: 'Force Posture', icon: Shield, color: 'text-violet-400' },
                    { key: 'coercion', label: 'Coercion', icon: Ban, color: 'text-orange-500' },
                ],
            },
            {
                layer: 'disasters', label: 'Disasters', icon: Mountain,
                sources: COMPOSITE_LAYER_SOURCES.disasters,
                subtypes: [
                    { key: 'EQ', label: 'Earthquake', icon: CircleDot, color: 'text-zinc-300' },
                    { key: 'TC', label: 'Cyclone', icon: Waves, color: 'text-zinc-300' },
                    { key: 'FL', label: 'Flood', icon: Waves, color: 'text-blue-400' },
                    { key: 'VO', label: 'Volcano', icon: Mountain, color: 'text-orange-400' },
                    { key: 'WF', label: 'Wildfire', icon: Flame, color: 'text-red-400' },
                    { key: 'DR', label: 'Drought', icon: Mountain, color: 'text-yellow-600' },
                ],
            },
            {
                layer: 'fires' as LayerName, label: 'Fire Detection', icon: Flame,
                subtypes: [
                    { key: 'high', label: 'High FRP', icon: Flame, color: 'text-red-500' },
                    { key: 'medium', label: 'Medium FRP', icon: Flame, color: 'text-orange-400' },
                    { key: 'low', label: 'Low FRP', icon: Flame, color: 'text-yellow-400' },
                ],
            },
        ],
    },
    {
        domain: 'infra', label: 'Infrastructure', icon: Factory, color: 'text-yellow-400',
        children: [
            {
                layer: 'infrastructure', label: 'Energy Grid', icon: Zap,
                subtypes: [
                    { key: 'power_plant', label: 'Power Plants', icon: Zap, color: 'text-yellow-400' },
                    { key: 'power_substation', label: 'Substations', icon: Zap, color: 'text-orange-400' },
                    { key: 'power_line', label: 'Transmission', icon: Zap, color: 'text-orange-300' },
                    { key: 'refinery', label: 'Refineries', icon: Factory, color: 'text-red-500' },
                    { key: 'dam', label: 'Dams', icon: Waves, color: 'text-blue-400' },
                    { key: 'desalination', label: 'Desalination', icon: Droplets, color: 'text-blue-300' },
                    { key: 'military', label: 'Mil. Bases', icon: Shield, color: 'text-zinc-400' },
                    { key: 'aerodrome', label: 'Aerodromes', icon: Plane, color: 'text-zinc-300' },
                    { key: 'communication_tower', label: 'Comm Towers', icon: Radio, color: 'text-cyan-400' },
                ],
            },
            {
                layer: 'pipelines', label: 'Pipelines', icon: Fuel,
                subtypes: [
                    { key: 'oil', label: 'Oil', icon: Fuel, color: 'text-red-500' },
                    { key: 'gas', label: 'Gas', icon: Fuel, color: 'text-sky-400' },
                    { key: 'water', label: 'Water', icon: Droplets, color: 'text-teal-400' },
                    { key: 'other', label: 'Other', icon: Fuel, color: 'text-yellow-300' },
                ],
            },
            {
                layer: 'cables' as LayerName, label: 'Submarine Cables', icon: Waves,
                subtypes: [],
            },
        ],
    },
    {
        domain: 'connectivity', label: 'Connectivity', icon: WifiOff, color: 'text-orange-400',
        children: [
            {
                layer: 'wifi', label: 'Wi-Fi Observations', icon: Wifi,
                subtypes: [
                    { key: 'open', label: 'Open', icon: Wifi, color: 'text-green-400' },
                    { key: 'encrypted', label: 'Encrypted', icon: Wifi, color: 'text-blue-400' },
                    { key: 'unknown', label: 'Unknown', icon: Wifi, color: 'text-zinc-400' },
                ],
                scope: 'live-only',
                scopeNote: 'Live-only viewport layer below 300 m AGL. Stored observations are used for cache/audit, not replay hydration.',
            },
            {
                layer: 'outages', label: 'Outages', icon: WifiOff,
                sources: COMPOSITE_LAYER_SOURCES.outages,
                subtypes: [
                    { key: 'critical', label: 'Critical', icon: WifiOff, color: 'text-red-500' },
                    { key: 'warning', label: 'Warning', icon: WifiOff, color: 'text-orange-400' },
                ],
            },
        ],
    },
    {
        domain: 'context', label: 'Context', icon: Globe2, color: 'text-zinc-400',
        children: [
            { layer: 'traffic', label: 'Traffic', icon: Car, subtypes: [], scope: 'live-only', scopeNote: 'Live-only raster traffic overlay. Historical traffic replay is not configured.' },
            { layer: 'webcams', label: 'Cameras', icon: Camera, subtypes: [], scope: 'live-only', scopeNote: 'Live/current camera metadata. Camera history is not stored for replay.' },
            { layer: 'labels', label: 'Borders', icon: Globe2, subtypes: [] },
            { layer: 'clouds', label: 'Cloud Cover', icon: Waves, subtypes: [], scope: 'live-only', scopeNote: 'Date-addressable NASA GIBS context overlay. It does not block replay hydration.' },
            { layer: 'satellite_imagery', label: 'Satellite Imagery', icon: Globe2, subtypes: [], scope: 'live-only', scopeNote: 'Context imagery overlay. Use agent imagery actions for dated scenes.' },
        ],
    },
];

const LIVE_ONLY_LAYERS = new Set<LayerName>(['traffic', 'webcams', 'clouds', 'satellite_imagery', 'wifi']);

// Flat list of all subtypes for the "All" tab search
const ALL_SUBTYPES: { layer: LayerName; subtypeKey: string; label: string; parentLabel: string; icon: LucideIcon; color: string }[] = [];
for (const domain of DOMAIN_TREE) {
    for (const layerNode of domain.children) {
        if (layerNode.subtypes.length === 0) {
            ALL_SUBTYPES.push({ layer: layerNode.layer, subtypeKey: '', label: layerNode.label, parentLabel: domain.label, icon: layerNode.icon, color: domain.color });
        }
        for (const sub of layerNode.subtypes) {
            ALL_SUBTYPES.push({ layer: layerNode.layer, subtypeKey: sub.key, label: sub.label, parentLabel: layerNode.label, icon: sub.icon, color: sub.color });
        }
    }
}

// Mapping from domain → list of layer keys for domain toggle
const DOMAIN_LAYERS: Record<string, LayerName[]> = {};
for (const d of DOMAIN_TREE) {
    DOMAIN_LAYERS[d.domain] = d.children.map(c => c.layer);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Tab = 'domains' | 'missions' | 'all';

export default function Legend() {
    const sources = useTimelineStore(s => s.sources);
    const visibility = useTimelineStore(s => s.visibility);
    const counts = useTimelineStore(s => s.subtypeCounts);
    const sourceCounts = useTimelineStore(s => s.sourceCounts);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const sourceVisibility = useTimelineStore(s => s.sourceVisibility);
    const streamMetrics = useTimelineStore(s => s.streamMetrics);
    const mode = useTimelineStore(s => s.mode);
    const toggleVisibility = useTimelineStore(s => s.toggleVisibility);
    const toggleSubtype = useTimelineStore(s => s.toggleSubtype);
    const toggleSourceVisibility = useTimelineStore(s => s.toggleSourceVisibility);
    const activeFilter = useTimelineStore(s => s.activeFilter);
    const clearFilter = useTimelineStore(s => s.clearFilter);
    const activePreset = useTimelineStore(s => s.activePreset);
    const applyMissionPreset = useTimelineStore(s => s.applyMissionPreset);
    const showTrajectories = useTimelineStore(s => s.showTrajectories);
    const toggleTrajectories = useTimelineStore(s => s.toggleTrajectories);

    const [collapsed, setCollapsed] = useState(false);
    const [tab, setTab] = useState<Tab>('domains');
    const [expandedDomains, setExpandedDomains] = useState<Record<string, boolean>>(() => {
        const init: Record<string, boolean> = {};
        for (const d of DOMAIN_TREE) init[d.domain] = true;
        return init;
    });
    const [expandedLayers, setExpandedLayers] = useState<Record<string, boolean>>({});
    const [searchQuery, setSearchQuery] = useState('');

    const toggleDomain = useCallback((domain: string) => {
        setExpandedDomains(prev => ({ ...prev, [domain]: !prev[domain] }));
    }, []);

    const toggleLayerExpand = useCallback((layer: string) => {
        setExpandedLayers(prev => ({ ...prev, [layer]: prev[layer] === undefined ? false : !prev[layer] }));
    }, []);

    // Toggle all layers in a domain on/off
    const toggleDomainVisibility = useCallback((domain: string) => {
        const layers = DOMAIN_LAYERS[domain];
        if (!layers) return;
        const allOn = layers.every(l => sources[l] && visibility[l]);
        for (const l of layers) {
            if (allOn || !(sources[l] && visibility[l])) toggleVisibility(l);
        }
    }, [sources, visibility, toggleVisibility]);

    // Count totals for a layer
    const layerCount = useCallback((layer: LayerName, subtypes: SubtypeNode[]) => {
        if (subtypes.length === 0) return counts[`${layer}:`] || 0;
        return subtypes.reduce((s, st) => s + (counts[`${layer}:${st.key}`] || 0), 0);
    }, [counts]);

    // Filtered "All" list
    const filteredAll = useMemo(() => {
        if (!searchQuery) return ALL_SUBTYPES;
        const q = searchQuery.toLowerCase();
        return ALL_SUBTYPES.filter(item =>
            item.label.toLowerCase().includes(q) ||
            item.parentLabel.toLowerCase().includes(q)
        );
    }, [searchQuery]);

    if (collapsed) {
        return (
            <button
                onClick={() => setCollapsed(false)}
                className="absolute top-4 left-4 z-10 bg-black/75 backdrop-blur-xl border border-zinc-800 rounded-lg p-2.5 shadow-2xl text-zinc-400 hover:text-white transition-colors"
                title="Show legend"
            >
                <PanelRight size={16} />
            </button>
        );
    }

    return (
        <div className="absolute top-4 left-4 z-10 w-80 max-h-[90vh] bg-black/80 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-[0_0_40px_rgba(0,0,0,0.8)] text-xs font-medium flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-zinc-800/60">
                <div className="flex items-center gap-1.5">
                    <Radio size={11} className="text-cyan-500" />
                    <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-500 font-bold">Legend</span>
                </div>
                <button onClick={() => setCollapsed(true)} className="text-zinc-500 hover:text-white" title="Collapse">
                    <PanelRightClose size={14} />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-zinc-800/60">
                {([
                    ['domains', 'Domains', Globe2],
                    ['missions', 'Missions', Target],
                    ['all', 'All', List],
                ] as [Tab, string, LucideIcon][]).map(([t, label, Icon]) => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={`flex-1 flex items-center justify-center gap-1 py-2 text-[10px] font-mono uppercase tracking-wider transition-colors ${
                            tab === t ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-zinc-600 hover:text-zinc-400'
                        }`}
                    >
                        <Icon size={11} />
                        {label}
                    </button>
                ))}
            </div>

            {/* Filter bar */}
            {activeFilter && (
                <div className="flex items-center justify-between px-3 py-1.5 bg-cyan-900/20 border-b border-cyan-700/30">
                    <span className="text-[10px] font-mono text-cyan-400">
                        Filter: {activeFilter.label}
                    </span>
                    <button onClick={clearFilter} className="text-cyan-500 hover:text-white">
                        <X size={12} />
                    </button>
                </div>
            )}

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 min-h-0">
                {tab === 'domains' && <DomainsTab
                    expandedDomains={expandedDomains}
                    expandedLayers={expandedLayers}
                    toggleDomain={toggleDomain}
                    toggleLayerExpand={toggleLayerExpand}
                    toggleDomainVisibility={toggleDomainVisibility}
                    sources={sources}
                    visibility={visibility}
                    subtypeVisibility={subtypeVisibility}
                    sourceVisibility={sourceVisibility}
                    counts={counts}
                    sourceCounts={sourceCounts}
                    streamMetrics={streamMetrics}
                    toggleVisibility={toggleVisibility}
                    toggleSubtype={toggleSubtype}
                    toggleSourceVisibility={toggleSourceVisibility}
                    layerCount={layerCount}
                    showTrajectories={showTrajectories}
                    toggleTrajectories={toggleTrajectories}
                    mode={mode}
                />}

                {tab === 'missions' && <MissionsTab
                    activePreset={activePreset}
                    applyMissionPreset={applyMissionPreset}
                />}

                {tab === 'all' && <AllTab
                    searchQuery={searchQuery}
                    setSearchQuery={setSearchQuery}
                    filteredAll={filteredAll}
                    sources={sources}
                    visibility={visibility}
                    subtypeVisibility={subtypeVisibility}
                    counts={counts}
                    toggleVisibility={toggleVisibility}
                    toggleSubtype={toggleSubtype}
                    mode={mode}
                />}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Domains Tab
// ---------------------------------------------------------------------------
function DomainsTab({
    expandedDomains, expandedLayers, toggleDomain, toggleLayerExpand,
    toggleDomainVisibility, sources, visibility, subtypeVisibility, sourceVisibility, counts, sourceCounts, streamMetrics,
    toggleVisibility, toggleSubtype, toggleSourceVisibility, layerCount, showTrajectories, toggleTrajectories, mode,
}: {
    expandedDomains: Record<string, boolean>;
    expandedLayers: Record<string, boolean>;
    toggleDomain: (d: string) => void;
    toggleLayerExpand: (l: string) => void;
    toggleDomainVisibility: (d: string) => void;
    sources: any;
    visibility: any;
    subtypeVisibility: Record<string, boolean>;
    sourceVisibility: Record<string, boolean>;
    counts: Record<string, number>;
    sourceCounts: Record<string, number>;
    streamMetrics: Record<string, any>;
    toggleVisibility: (l: LayerName) => void;
    toggleSubtype: (k: string) => void;
    toggleSourceVisibility: (k: string) => void;
    layerCount: (l: LayerName, s: SubtypeNode[]) => number;
    showTrajectories: boolean;
    toggleTrajectories: () => void;
    mode: string;
}) {
    return (
        <div className="p-2 flex flex-col gap-0.5">
            {DOMAIN_TREE.map(domain => {
                const isExpanded = expandedDomains[domain.domain] !== false;
                const allOn = DOMAIN_LAYERS[domain.domain].every(l => sources[l] && visibility[l]);
                const someOn = DOMAIN_LAYERS[domain.domain].some(l => sources[l] && visibility[l]);
                const DomainIcon = domain.icon;

                return (
                    <div key={domain.domain}>
                        {/* Domain header */}
                        <div className="flex items-center gap-1 group">
                            <button onClick={() => toggleDomain(domain.domain)} className="text-zinc-600 hover:text-zinc-300 p-0.5">
                                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                            <button
                                onClick={() => toggleDomainVisibility(domain.domain)}
                                className={`flex-1 flex items-center justify-between py-1 px-1 rounded transition-colors ${
                                    allOn ? 'text-cyan-400' : someOn ? 'text-cyan-700' : 'text-zinc-600'
                                } hover:bg-zinc-800/50`}
                            >
                                <span className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider font-semibold">
                                    <DomainIcon size={12} className={domain.color} />
                                    {domain.label}
                                </span>
                                <span className="text-zinc-600 text-[9px] font-mono">
                                    {allOn ? <Eye size={10} className="text-cyan-600" /> : someOn ? <Eye size={10} className="text-zinc-600" /> : <EyeOff size={10} className="text-zinc-700" />}
                                </span>
                            </button>
                        </div>

                        {/* Layer children */}
                        {isExpanded && (
                            <div className="pl-4 flex flex-col gap-0">
                                {domain.children.map(layerNode => {
                                    const layerSourceOn = sources[layerNode.layer];
                                    const layerOn = layerSourceOn && visibility[layerNode.layer];
                                    const metric = streamMetrics[layerNode.layer];
                                    const lCount = layerCount(layerNode.layer, layerNode.subtypes);
                                    const hasSubtypes = layerNode.subtypes.length > 0;
                                    const isLayerExpanded = expandedLayers[layerNode.layer] !== false;
                                    const LayerIcon = layerNode.icon;
                                    const isLiveOnly = layerNode.scope === 'live-only';
                                    const scopeNote = layerNode.scopeNote || 'Live/context layer. This layer does not block replay loading.';

                                    return (
                                        <div key={layerNode.layer}>
                                            {/* Layer header */}
                                            <div className="flex items-center gap-0.5">
                                                {hasSubtypes ? (
                                                    <button onClick={() => toggleLayerExpand(layerNode.layer)} className="text-zinc-600 hover:text-zinc-300 p-0.5">
                                                        {isLayerExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                                                    </button>
                                                ) : (
                                                    <span className="w-5" />
                                                )}
                                                <button
                                                    onClick={() => toggleVisibility(layerNode.layer)}
                                                    className={`flex-1 flex items-center justify-between py-0.5 px-1 rounded text-[10px] font-mono transition-colors ${
                                                        layerOn ? 'text-zinc-200 hover:text-white' : 'text-zinc-600 hover:text-zinc-400'
                                                    } hover:bg-zinc-800/30`}
                                                >
                                                    <span className="flex items-center gap-1.5">
                                                        {/* Health dot */}
                                                        <span className={`w-1.5 h-1.5 rounded-full ${statusDotColor(metric?.status)}`} />
                                                        <LayerIcon size={10} className={layerOn ? 'text-zinc-400' : 'text-zinc-700'} />
                                                        {layerNode.label}
                                                        {isLiveOnly && (
                                                            <span
                                                                className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[8px] uppercase tracking-wide ${
                                                                    mode === 'playback'
                                                                        ? 'border-zinc-700 text-zinc-500'
                                                                        : 'border-cyan-900/60 text-cyan-500'
                                                                }`}
                                                                title={scopeNote}
                                                            >
                                                                <Radio size={8} />
                                                                Live
                                                            </span>
                                                        )}
                                                    </span>
                                                    <span className="text-zinc-500 tabular-nums text-[9px]">{lCount > 0 ? lCount.toLocaleString() : ''}</span>
                                                </button>
                                            </div>

                                            {/* Subtypes */}
                                            {hasSubtypes && isLayerExpanded && (
                                                <div className={`pl-9 ${layerOn ? '' : 'opacity-25'}`}>
                                                    <div className="grid grid-cols-2 gap-x-1 gap-y-0">
                                                        {layerNode.subtypes.map(sub => {
                                                            const fullKey = `${layerNode.layer}:${sub.key}`;
                                                            const subOn = subtypeVisibility[fullKey] !== false;
                                                            const n = counts[fullKey] || 0;
                                                            const SubIcon = sub.icon;
                                                            return (
                                                                <button
                                                                    key={sub.key}
                                                                    onClick={() => toggleSubtype(fullKey)}
                                                                    disabled={!layerOn}
                                                                    className={`flex items-center justify-between gap-1 text-[10px] px-1 py-0.5 rounded hover:bg-cyan-900/20 transition-colors ${
                                                                        subOn ? 'text-zinc-200' : 'text-zinc-600 line-through'
                                                                    }`}
                                                                >
                                                                    <span className="flex items-center gap-1 truncate">
                                                                        <SubIcon size={9} className={subOn ? sub.color : 'text-zinc-700'} />
                                                                        <span className="truncate">{sub.label}</span>
                                                                    </span>
                                                                    <span className={`font-mono text-[9px] tabular-nums ${subOn ? 'text-zinc-500' : 'text-zinc-700'}`}>
                                                                        {n > 0 ? n.toLocaleString() : ''}
                                                                    </span>
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                    {layerNode.sources && layerNode.sources.length > 0 && (
                                                        <div className="mt-1 border-t border-zinc-800/40 pt-1">
                                                            <div className="px-1 pb-0.5 text-[9px] font-mono uppercase tracking-wider text-zinc-600">
                                                                Sources
                                                            </div>
                                                            <div className="grid grid-cols-1 gap-y-0">
                                                                {layerNode.sources.map(sourceNode => {
                                                                    const fullKey = getLayerSourceVisibilityKey(layerNode.layer as CompositeLayerCode, sourceNode.sourceId);
                                                                    const sourceOn = sourceVisibility[fullKey] !== false;
                                                                    const n = sourceCounts[fullKey] || 0;
                                                                    return (
                                                                        <button
                                                                            key={sourceNode.sourceId}
                                                                            onClick={() => toggleSourceVisibility(fullKey)}
                                                                            disabled={!layerOn}
                                                                            className={`flex items-center justify-between gap-1 text-[10px] px-1 py-0.5 rounded hover:bg-cyan-900/20 transition-colors ${
                                                                                sourceOn ? 'text-zinc-300' : 'text-zinc-600 line-through'
                                                                            }`}
                                                                        >
                                                                            <span className="truncate">{sourceNode.label}</span>
                                                                            <span className={`font-mono text-[9px] tabular-nums ${sourceOn ? 'text-zinc-500' : 'text-zinc-700'}`}>
                                                                                {n > 0 ? n.toLocaleString() : ''}
                                                                            </span>
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}

                                {/* Special: Trajectories toggle under Space domain */}
                                {domain.domain === 'space' && (
                                    <div className="flex items-center gap-0.5 pl-5">
                                        <button
                                            onClick={toggleTrajectories}
                                            className={`flex-1 flex items-center gap-1.5 py-0.5 px-1 rounded text-[10px] font-mono transition-colors ${
                                                showTrajectories ? 'text-zinc-200' : 'text-zinc-600'
                                            } hover:bg-zinc-800/30`}
                                        >
                                            <span className={`w-1.5 h-1.5 rounded-full ${showTrajectories ? 'bg-cyan-500' : 'bg-zinc-700'}`} />
                                            Trails
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Missions Tab
// ---------------------------------------------------------------------------
function MissionsTab({ activePreset, applyMissionPreset }: {
    activePreset: string | null;
    applyMissionPreset: (name: string) => void;
}) {
    return (
        <div className="p-3 flex flex-col gap-2">
            <p className="text-[10px] text-zinc-500 font-mono mb-1">Apply a mission preset to focus on specific domains.</p>
            {MISSION_PRESETS.map(preset => (
                <button
                    key={preset.name}
                    onClick={() => applyMissionPreset(preset.name)}
                    className={`text-left p-3 rounded-lg border transition-colors ${
                        activePreset === preset.name
                            ? 'border-cyan-500/50 bg-cyan-900/20 text-cyan-300'
                            : 'border-zinc-800 bg-zinc-900/30 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800/50'
                    }`}
                >
                    <div className="text-[11px] font-mono font-semibold tracking-wider uppercase">{preset.name}</div>
                    <div className="text-[9px] text-zinc-500 mt-1">{preset.description}</div>
                </button>
            ))}
            {/* Reset — always apply Full Awareness to restore defaults */}
            {activePreset && activePreset !== 'Full Awareness' && (
                <button
                    onClick={() => applyMissionPreset('Full Awareness')}
                    className="mt-1 p-2 rounded-lg border border-red-700/40 bg-red-900/10 text-red-400 hover:text-red-300 hover:border-red-600/50 transition-colors text-[10px] font-mono uppercase tracking-wider"
                >
                    Reset All
                </button>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// All Tab (searchable flat list)
// ---------------------------------------------------------------------------
function AllTab({
    searchQuery, setSearchQuery, filteredAll, sources, visibility, subtypeVisibility,
    counts, toggleVisibility, toggleSubtype, mode,
}: {
    searchQuery: string;
    setSearchQuery: (q: string) => void;
    filteredAll: typeof ALL_SUBTYPES;
    sources: any;
    visibility: any;
    subtypeVisibility: Record<string, boolean>;
    counts: Record<string, number>;
    toggleVisibility: (l: LayerName) => void;
    toggleSubtype: (k: string) => void;
    mode: string;
}) {
    return (
        <div className="flex flex-col">
            {/* Search */}
            <div className="p-2 border-b border-zinc-800/60">
                <div className="relative">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search layers..."
                        className="w-full bg-zinc-900/50 border border-zinc-800 rounded-md pl-7 pr-2 py-1.5 text-[10px] font-mono text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-cyan-700"
                    />
                    {searchQuery && (
                        <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-white">
                            <X size={10} />
                        </button>
                    )}
                </div>
            </div>

            {/* List */}
            <div className="p-1 flex flex-col gap-0">
                {filteredAll.map(item => {
                    const isLayerToggle = !item.subtypeKey;
                    const layerOn = sources[item.layer] && visibility[item.layer];
                    const fullKey = item.subtypeKey ? `${item.layer}:${item.subtypeKey}` : '';
                    const subOn = fullKey ? subtypeVisibility[fullKey] !== false : layerOn;
                    const n = fullKey ? (counts[fullKey] || 0) : 0;
                    const ItemIcon = item.icon;
                    const isLiveOnly = LIVE_ONLY_LAYERS.has(item.layer);

                    const handleClick = () => {
                        if (isLayerToggle) toggleVisibility(item.layer);
                        else toggleSubtype(fullKey);
                    };

                    return (
                        <button
                            key={`${item.layer}:${item.subtypeKey}`}
                            onClick={handleClick}
                            className={`flex items-center justify-between px-2 py-1 rounded text-[10px] font-mono transition-colors hover:bg-zinc-800/30 ${
                                subOn ? 'text-zinc-200' : 'text-zinc-600'
                            }`}
                        >
                            <span className="flex items-center gap-1.5 truncate">
                                <ItemIcon size={10} className={subOn ? item.color : 'text-zinc-700'} />
                                <span className="truncate">{item.label}</span>
                                <span className="text-[8px] text-zinc-600">{item.parentLabel}</span>
                                {isLiveOnly && (
                                    <span
                                        className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[8px] uppercase tracking-wide ${
                                            mode === 'playback'
                                                ? 'border-zinc-700 text-zinc-500'
                                                : 'border-cyan-900/60 text-cyan-500'
                                        }`}
                                        title="Live mode only. This layer does not block replay loading."
                                    >
                                        <Radio size={8} />
                                        Live
                                    </span>
                                )}
                            </span>
                            <span className="text-zinc-500 tabular-nums text-[9px]">{n > 0 ? n.toLocaleString() : ''}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
