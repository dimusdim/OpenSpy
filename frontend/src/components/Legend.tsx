'use client';
import { useState } from 'react';
import { Plane, Ship, Satellite, Flame, Waves, Mountain, CircleDot, Radio, ShieldAlert, ChevronDown, ChevronRight, PanelRightClose, PanelRight, Camera, Zap, Factory, Droplets, Shield, Fuel, WifiOff, AlertTriangle, Car, Crosshair, Ban, Anchor, Bomb, Swords, Users } from 'lucide-react';
import { useTimelineStore } from '../store/useTimelineStore';
import type { LucideIcon } from 'lucide-react';

type LegendRow = {
    key: string;
    label: string;
    icon: LucideIcon;
    color: string;
};

type LegendSection = {
    layer: 'satellites' | 'aviation' | 'maritime' | 'osint' | 'jamming' | 'labels' | 'webcams' | 'infrastructure' | 'pipelines' | 'outages' | 'satellite_imagery' | 'traffic' | 'conflicts' | 'airspace' | 'gfw';
    title: string;
    source: string;
    rows: LegendRow[];
};

const SECTIONS: LegendSection[] = [
    {
        layer: 'satellites', title: 'Satellites', source: 'CelesTrak',
        rows: [
            { key: 'military',   label: 'Military',   icon: Satellite, color: 'text-red-500' },
            { key: 'commercial', label: 'Commercial', icon: Satellite, color: 'text-cyan-400' },
            { key: 'civilian',   label: 'Civilian',   icon: Satellite, color: 'text-lime-400' },
        ],
    },
    {
        layer: 'aviation', title: 'Aviation', source: 'OpenSky',
        rows: [
            { key: 'airliner', label: 'Airliner',   icon: Plane, color: 'text-white' },
            { key: 'military', label: 'Military',   icon: Plane, color: 'text-yellow-400' },
            { key: 'light',    label: 'Light / GA', icon: Plane, color: 'text-blue-400' },
            { key: 'general',  label: 'General',    icon: Plane, color: 'text-zinc-300' },
        ],
    },
    {
        layer: 'maritime', title: 'Maritime', source: 'AISStream',
        rows: [
            { key: 'cargo',     label: 'Cargo',     icon: Ship, color: 'text-zinc-200' },
            { key: 'tanker',    label: 'Tanker',    icon: Ship, color: 'text-red-500' },
            { key: 'passenger', label: 'Passenger', icon: Ship, color: 'text-blue-500' },
            { key: 'fishing',   label: 'Fishing',   icon: Ship, color: 'text-lime-500' },
            { key: 'military',  label: 'Military',  icon: Ship, color: 'text-slate-400' },
            { key: 'unknown',   label: 'Unknown',   icon: Ship, color: 'text-zinc-500' },
        ],
    },
    {
        layer: 'osint', title: 'OSINT Events', source: 'GDACS+USGS+EONET',
        rows: [
            { key: 'EQ', label: 'Earthquake',  icon: CircleDot, color: 'text-zinc-300' },
            { key: 'TC', label: 'Cyclone',     icon: Waves,     color: 'text-zinc-300' },
            { key: 'FL', label: 'Flood',       icon: Waves,     color: 'text-blue-400' },
            { key: 'VO', label: 'Volcano',     icon: Mountain,  color: 'text-orange-400' },
            { key: 'WF', label: 'Wildfire',    icon: Flame,     color: 'text-red-400' },
            { key: 'DR', label: 'Drought',     icon: Mountain,  color: 'text-yellow-600' },
        ],
    },
    {
        layer: 'jamming', title: 'GNSS Jamming', source: 'GPSJam.org (ADS-B NIC)',
        rows: [
            { key: 'high',   label: 'High',   icon: ShieldAlert, color: 'text-red-500' },
            { key: 'medium', label: 'Medium', icon: ShieldAlert, color: 'text-orange-500' },
            { key: 'low',    label: 'Low',    icon: ShieldAlert, color: 'text-yellow-500' },
        ],
    },
    {
        layer: 'fires' as any, title: 'Active Fires', source: 'NASA FIRMS',
        rows: [
            { key: 'high',   label: 'High FRP',    icon: Flame, color: 'text-red-500' },
            { key: 'medium', label: 'Medium FRP',  icon: Flame, color: 'text-orange-400' },
            { key: 'low',    label: 'Low FRP',     icon: Flame, color: 'text-yellow-400' },
        ],
    },
    {
        layer: 'webcams', title: 'Live Webcams', source: 'Aggregated',
        rows: [],
    },
    {
        layer: 'infrastructure', title: 'Infrastructure', source: 'OpenStreetMap',
        rows: [
            { key: 'power_plant',   label: 'Power Plant',    icon: Zap,      color: 'text-yellow-400' },
            { key: 'refinery',      label: 'Refinery',       icon: Factory,  color: 'text-red-500' },
            { key: 'desalination',  label: 'Desalination',   icon: Droplets, color: 'text-blue-400' },
            { key: 'military',      label: 'Military',       icon: Shield,   color: 'text-zinc-400' },
        ],
    },
    {
        layer: 'pipelines', title: 'Pipelines', source: 'OpenStreetMap',
        rows: [
            { key: 'oil',  label: 'Oil',  icon: Fuel, color: 'text-red-500' },
            { key: 'gas',  label: 'Gas',  icon: Fuel, color: 'text-blue-400' },
        ],
    },
    {
        layer: 'conflicts', title: 'Armed Conflicts', source: 'ACLED',
        rows: [
            { key: 'explosions', label: 'Explosions',   icon: Bomb,   color: 'text-red-500' },
            { key: 'battles',    label: 'Battles',      icon: Swords, color: 'text-orange-400' },
            { key: 'violence',   label: 'Violence',     icon: Users,  color: 'text-yellow-400' },
        ],
    },
    {
        layer: 'airspace', title: 'Restricted Airspace', source: 'OpenAIP',
        rows: [
            { key: 'restricted', label: 'Restricted', icon: Ban, color: 'text-red-500' },
            { key: 'danger',     label: 'Danger',     icon: Ban, color: 'text-orange-400' },
            { key: 'prohibited', label: 'Prohibited', icon: Ban, color: 'text-red-700' },
            { key: 'tfr',        label: 'TFR',        icon: Ban, color: 'text-yellow-400' },
        ],
    },
    {
        layer: 'gfw', title: 'Dark Vessel Events', source: 'Global Fishing Watch',
        rows: [],
    },
    {
        layer: 'outages', title: 'Internet Outages', source: 'IODA + Cloudflare Radar',
        rows: [
            { key: 'critical', label: 'Critical', icon: WifiOff, color: 'text-red-500' },
            { key: 'warning',  label: 'Warning',  icon: WifiOff, color: 'text-orange-400' },
        ],
    },
    {
        layer: 'cables' as any, title: 'Submarine Cables', source: 'TeleGeography',
        rows: [],
    },
    {
        layer: 'labels', title: 'Borders & Cities', source: 'NaturalEarth',
        rows: [],
    },
    {
        layer: 'satellite_imagery', title: 'Satellite Imagery', source: 'NASA GIBS MODIS',
        rows: [],
    },
    {
        layer: 'traffic', title: 'Traffic Flow', source: 'TomTom',
        rows: [],
    },
];

export default function Legend() {
    const layers = useTimelineStore(s => s.layers);
    const counts = useTimelineStore(s => s.subtypeCounts);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const toggleLayer = useTimelineStore(s => s.toggleLayer);
    const toggleSubtype = useTimelineStore(s => s.toggleSubtype);

    const [collapsed, setCollapsed] = useState(false);
    const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

    const toggleGroup = (layer: string) => {
        setCollapsedGroups(prev => ({ ...prev, [layer]: !prev[layer] }));
    };

    if (collapsed) {
        return (
            <button
                onClick={() => setCollapsed(false)}
                className="absolute bottom-6 right-4 z-10 bg-black/75 backdrop-blur-xl border border-zinc-800 rounded-lg p-2.5 shadow-2xl text-zinc-400 hover:text-white transition-colors"
                title="Show legend"
            >
                <PanelRight size={16} />
            </button>
        );
    }

    return (
        <div className="absolute bottom-6 right-4 z-10 bg-black/75 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-2xl text-xs font-medium max-w-[300px] max-h-[60vh] flex flex-col">
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

            {/* Scrollable body */}
            <div className="overflow-y-auto p-2 flex flex-col gap-1">
                {SECTIONS.map(section => {
                    const isLayerOn = layers[section.layer];
                    const isGroupCollapsed = collapsedGroups[section.layer];
                    const totalCount = section.rows.reduce(
                        (sum, r) => sum + (counts[`${section.layer}:${r.key}`] || 0), 0
                    );

                    return (
                        <div key={section.layer} className="flex flex-col">
                            {/* Section header */}
                            <div className="flex items-center gap-1">
                                {/* Collapse chevron */}
                                {section.rows.length > 0 && (
                                    <button onClick={() => toggleGroup(section.layer)} className="text-zinc-600 hover:text-zinc-300 p-0.5">
                                        {isGroupCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                    </button>
                                )}

                                {/* Layer toggle */}
                                <button
                                    onClick={() => toggleLayer(section.layer)}
                                    className={`flex-1 flex items-center justify-between text-[10px] uppercase font-mono tracking-wider px-1 py-1 rounded transition-colors ${
                                        isLayerOn ? 'text-cyan-400 hover:text-cyan-300' : 'text-zinc-600 hover:text-zinc-400'
                                    }`}
                                >
                                    <div className="flex flex-col items-start">
                                        <span>{section.title}</span>
                                        <span className="text-[8px] text-zinc-600 normal-case tracking-normal">{section.source}</span>
                                    </div>
                                    <span className="text-zinc-500 font-normal tabular-nums">{totalCount > 0 ? totalCount.toLocaleString() : '—'}</span>
                                </button>
                            </div>

                            {/* Subtype rows — 2-column grid */}
                            {!isGroupCollapsed && section.rows.length > 0 && (
                                <div className={`grid grid-cols-2 gap-x-1 gap-y-0 pl-5 ${isLayerOn ? '' : 'opacity-25'}`}>
                                    {section.rows.map(row => {
                                        const fullKey = `${section.layer}:${row.key}`;
                                        const subOn = subtypeVisibility[fullKey] !== false;
                                        const n = counts[fullKey] || 0;
                                        const Icon = row.icon;
                                        return (
                                            <button
                                                key={row.key}
                                                onClick={() => toggleSubtype(fullKey)}
                                                disabled={!isLayerOn}
                                                className={`flex items-center justify-between gap-1 text-[10px] px-1 py-0.5 rounded hover:bg-cyan-900/20 transition-colors ${
                                                    subOn ? 'text-zinc-200' : 'text-zinc-600 line-through'
                                                }`}
                                                title={subOn ? 'Click to hide' : 'Click to show'}
                                            >
                                                <span className="flex items-center gap-1 truncate">
                                                    <Icon size={10} className={subOn ? row.color : 'text-zinc-700'} />
                                                    <span className="truncate">{row.label}</span>
                                                </span>
                                                <span className={`font-mono text-[9px] tabular-nums ${subOn ? 'text-zinc-500' : 'text-zinc-700'}`}>
                                                    {n > 0 ? n.toLocaleString() : ''}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
