'use client';

import { useEffect, useMemo, useState } from 'react';

type RenderStats = {
    avgFps?: number;
    avgFrameMs?: number;
    p95FrameMs?: number;
    avgSceneRenderMs?: number;
    p95SceneRenderMs?: number;
    lastReplayDrainMs?: number;
    maxFrameMs?: number;
    totalFrames?: number;
    longFrames16?: number;
    longFrames33?: number;
    longFrames50?: number;
    mode?: string;
    playbackKind?: string | null;
    isPlaying?: boolean;
    currentTimeIso?: string;
};

type ReplayStats = {
    error?: string | null;
};

function formatNumber(value: number | null | undefined, digits = 1): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return value.toFixed(digits);
}

export default function RenderPerfStatus() {
    const [stats, setStats] = useState<RenderStats | null>(null);
    const [replayStats, setReplayStats] = useState<ReplayStats | null>(null);

    useEffect(() => {
        const publish = () => {
            const stats = (window as any).__openspyRenderStats;
            const replayStats = (window as any).__openspyReplayStats;
            setStats(stats ? { ...stats } : null);
            setReplayStats(replayStats ? { ...replayStats } : null);
        };
        publish();
        const timer = window.setInterval(publish, 500);
        return () => window.clearInterval(timer);
    }, []);

    const summary = useMemo(() => {
        const avgFps = formatNumber(stats?.avgFps, 1);
        const avgFrameMs = formatNumber(stats?.avgFrameMs, 1);
        const p95FrameMs = formatNumber(stats?.p95FrameMs, 1);
        const avgSceneRenderMs = formatNumber(stats?.avgSceneRenderMs, 1);
        const replayDrainMs = formatNumber(stats?.lastReplayDrainMs, 1);
        const longFrames33 = stats?.longFrames33 ?? null;
        const mode = stats?.playbackKind === 'historical' ? 'Replay' : stats?.mode === 'live' ? 'Live' : 'Mode';
        const playing = stats?.playbackKind === 'historical'
            ? (stats?.isPlaying ? 'playing' : 'paused')
            : null;
        return { avgFps, avgFrameMs, p95FrameMs, avgSceneRenderMs, replayDrainMs, longFrames33, mode, playing };
    }, [stats]);

    return (
        <div className="bg-black/70 backdrop-blur-xl border border-zinc-800 rounded-lg px-3 py-2 text-[11px] font-mono text-zinc-300 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
                <span className="text-zinc-500 uppercase tracking-[0.18em]">Render</span>
                <span className="text-zinc-600">
                    {summary.mode}
                    {summary.playing ? ` • ${summary.playing}` : ''}
                </span>
            </div>
            <div className="mt-1 leading-5">
                <span className="text-zinc-500">FPS</span> {summary.avgFps}
                <span className="text-zinc-700"> • </span>
                <span className="text-zinc-500">Avg</span> {summary.avgFrameMs}ms
                <span className="text-zinc-700"> • </span>
                <span className="text-zinc-500">p95</span> {summary.p95FrameMs}ms
            </div>
            <div className="leading-5">
                <span className="text-zinc-500">Scene</span> {summary.avgSceneRenderMs}ms
                <span className="text-zinc-700"> • </span>
                <span className="text-zinc-500">Drain</span> {summary.replayDrainMs}ms
            </div>
            <div className="leading-5">
                <span className="text-zinc-500">Long &gt;33ms</span> {summary.longFrames33 ?? '—'}
            </div>
            {replayStats?.error ? (
                <div className="mt-1 max-w-[28rem] leading-5 text-red-300">
                    <span className="text-red-400">Replay Error</span> {replayStats.error}
                </div>
            ) : null}
        </div>
    );
}
