'use client';

import type { ReactNode } from 'react';
import { Check, CircleOff } from 'lucide-react';
import {
    useTimelineStore,
    type PowerGridEffectPreset,
    type TrafficFlowEffectPreset,
    type VisualShaderPreset,
} from '../store/useTimelineStore';

const SHADER_PRESETS: Array<{
    id: VisualShaderPreset;
    name: string;
    tone: string;
}> = [
    { id: 'normal', name: 'Normal', tone: 'Base render' },
    { id: 'night-ops', name: 'Night Ops', tone: 'Blue intelligence display' },
    { id: 'signal-grid', name: 'Signal Grid', tone: 'Cyan grid and scan dots' },
    { id: 'thermal', name: 'Thermal', tone: 'Heat-map contrast' },
    { id: 'monochrome', name: 'Monochrome', tone: 'High-contrast grayscale' },
    { id: 'tactical-green', name: 'Tactical Green', tone: 'Phosphor command display' },
    { id: 'cyberpunk', name: 'Cyberpunk', tone: 'Magenta and cyan neon split' },
    { id: 'xray', name: 'X-Ray', tone: 'Inverted edge scan' },
    { id: 'hazard', name: 'Hazard', tone: 'Amber warning lattice' },
    { id: 'deep-space', name: 'Deep Space', tone: 'Cold star-map contrast' },
    { id: 'infrared', name: 'Infrared', tone: 'Red surveillance scope' },
];

const POWER_GRID_PRESETS: Array<{
    id: PowerGridEffectPreset;
    name: string;
    tone: string;
}> = [
    { id: 'off', name: 'Off', tone: 'Static power lines' },
    { id: 'electric-flow', name: 'Electric Flow', tone: 'Blue current moving along lines' },
    { id: 'ember-pulse', name: 'Ember Pulse', tone: 'Orange power surge glow' },
    { id: 'voltage-surge', name: 'Voltage Surge', tone: 'White-blue high voltage flashes' },
];

const TRAFFIC_PRESETS: Array<{
    id: TrafficFlowEffectPreset;
    name: string;
    tone: string;
}> = [
    { id: 'off', name: 'Off', tone: 'Traffic raster only' },
    { id: 'flow-particles', name: 'Dot Flow', tone: 'Traffic layer texture becomes moving dots' },
    { id: 'congestion-pulse', name: 'Congestion Pulse', tone: 'Traffic layer texture pulses congestion' },
    { id: 'signal-rain', name: 'Signal Rain', tone: 'Traffic layer texture becomes signal streaks' },
];

export default function GlobeShaderPanel() {
    const visualShader = useTimelineStore((s) => s.visualShader);
    const setVisualShader = useTimelineStore((s) => s.setVisualShader);
    const powerGridEffect = useTimelineStore((s) => s.powerGridEffect);
    const setPowerGridEffect = useTimelineStore((s) => s.setPowerGridEffect);
    const trafficFlowEffect = useTimelineStore((s) => s.trafficFlowEffect);
    const setTrafficFlowEffect = useTimelineStore((s) => s.setTrafficFlowEffect);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="os-section">
                <p className="os-section-title">Scene Shader</p>
                <div className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-[#1a1a1f]/80 px-2 py-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Full scene</span>
                    <span className="rounded border border-cyan-900/60 bg-cyan-950/30 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-cyan-300">
                        Icons included
                    </span>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <ShaderSection title="Scene">
                    {SHADER_PRESETS.map((preset) => {
                        const active = preset.id === visualShader;
                        return (
                            <PresetButton
                                key={preset.id}
                                active={active}
                                off={preset.id === 'normal'}
                                name={preset.name}
                                tone={preset.tone}
                                onClick={() => setVisualShader(preset.id)}
                            />
                        );
                    })}
                </ShaderSection>

                <ShaderSection title="Power Grid">
                    {POWER_GRID_PRESETS.map((preset) => (
                        <PresetButton
                            key={preset.id}
                            active={preset.id === powerGridEffect}
                            off={preset.id === 'off'}
                            name={preset.name}
                            tone={preset.tone}
                            onClick={() => setPowerGridEffect(preset.id)}
                        />
                    ))}
                </ShaderSection>

                <ShaderSection title="Traffic Raster">
                    {TRAFFIC_PRESETS.map((preset) => (
                        <PresetButton
                            key={preset.id}
                            active={preset.id === trafficFlowEffect}
                            off={preset.id === 'off'}
                            name={preset.name}
                            tone={preset.tone}
                            onClick={() => setTrafficFlowEffect(preset.id)}
                        />
                    ))}
                </ShaderSection>
            </div>
        </div>
    );
}

function ShaderSection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="mb-4 last:mb-0">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">{title}</div>
            <div className="space-y-2">{children}</div>
        </section>
    );
}

function PresetButton({
    active,
    off,
    name,
    tone,
    onClick,
}: {
    active: boolean;
    off: boolean;
    name: string;
    tone: string;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                active
                    ? 'border-cyan-700/60 bg-cyan-950/35 text-zinc-100'
                    : 'border-zinc-800 bg-[#1a1a1f]/80 text-zinc-400 hover:border-zinc-700 hover:bg-[#24242a]/70 hover:text-zinc-200'
            }`}
        >
            <div className="flex items-center gap-2">
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded border ${
                    active
                        ? 'border-cyan-700/60 bg-cyan-900/30 text-cyan-300'
                        : 'border-zinc-800 bg-black/20 text-zinc-600'
                }`}>
                    {off ? <CircleOff size={13} /> : active ? <Check size={13} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{name}</div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">{tone}</div>
                </div>
            </div>
        </button>
    );
}
