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
    degraded?: Record<string, Record<string, number | string | boolean>>;
};

type ReplayHttpStatus = {
    state?: 'idle' | 'retrying' | 'recovered' | 'failed';
    attempt?: number;
    retries?: number;
    retryAfterMs?: number | null;
    message?: string | null;
};

function formatNumber(value: number | null | undefined, digits = 1): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return value.toFixed(digits);
}

export default function RenderPerfStatus() {
    const [stats, setStats] = useState<RenderStats | null>(null);
    const [replayStats, setReplayStats] = useState<ReplayStats | null>(null);
    const [replayHttpStatus, setReplayHttpStatus] = useState<ReplayHttpStatus | null>(null);

    useEffect(() => {
        const publish = () => {
            const stats = (window as any).__openspyRenderStats;
            const replayStats = (window as any).__openspyReplayStats;
            const replayHttpStatus = (window as any).__openspyReplayHttpStatus;
            setStats(stats ? { ...stats } : null);
            setReplayStats(replayStats ? { ...replayStats } : null);
            setReplayHttpStatus(replayHttpStatus ? { ...replayHttpStatus } : null);
        };
        publish();
        const timer = window.setInterval(publish, 500);
        window.addEventListener('openspy:replay-http-status', publish);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('openspy:replay-http-status', publish);
        };
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
    const degradedSummary = useMemo(() => {
        const degraded = replayStats?.degraded || {};
        const entries = Object.entries(degraded)
            .flatMap(([layerId, values]) => Object.entries(values).map(([key, value]) => `${layerId}.${key}=${String(value)}`));
        return entries.slice(0, 3).join(' • ');
    }, [replayStats]);

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
            {degradedSummary ? (
                <div className="mt-1 max-w-[28rem] leading-5 text-amber-300">
                    <span className="text-amber-400">Replay Degraded</span> {degradedSummary}
                </div>
            ) : null}
            {replayHttpStatus?.state === 'retrying' ? (
                <div className="mt-1 leading-5 text-amber-300">
                    <span className="text-amber-400">Replay Retry</span> {replayHttpStatus.attempt ?? 1}/{replayHttpStatus.retries ?? 1}
                    {Number.isFinite(Number(replayHttpStatus.retryAfterMs))
                        ? ` • ${formatNumber(Number(replayHttpStatus.retryAfterMs) / 1000, 0)}s`
                        : ''}
                </div>
            ) : replayHttpStatus?.state === 'failed' ? (
                <div className="mt-1 max-w-[28rem] leading-5 text-red-300">
                    <span className="text-red-400">Replay Network</span> {replayHttpStatus.message || 'request failed'}
                </div>
            ) : null}
        </div>
    );
}
