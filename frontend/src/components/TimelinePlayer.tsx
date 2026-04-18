'use client';

import { useTimelineStore } from '../store/useTimelineStore';
import { Play, Pause, Minus, Plus, Activity } from 'lucide-react';
import { useEffect, useState, useRef, useCallback } from 'react';
import { twMerge } from 'tailwind-merge';

const REPLAY_RANGE_OPTIONS = [
    { label: '1m', ms: 60 * 1000 },
    { label: '5m', ms: 5 * 60 * 1000 },
    { label: '15m', ms: 15 * 60 * 1000 },
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
];
const REPLAY_DEFAULT_RANGE_MS = 15 * 60 * 1000;
const TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

function formatTickLabel(rangeMs: number, fraction: number): string {
    if (fraction === 1) return 'NOW';
    if (fraction === 0) {
        const minutes = Math.round(rangeMs / 60000);
        if (minutes < 60) return `-${minutes}m`;
        const hours = rangeMs / 3600000;
        return Number.isInteger(hours) ? `-${hours}h` : `-${hours.toFixed(1)}h`;
    }
    const offsetMs = rangeMs * (1 - fraction);
    const totalMinutes = Math.round(offsetMs / 60000);
    if (totalMinutes < 60) return `-${totalMinutes}m`;
    const hours = offsetMs / 3600000;
    return Number.isInteger(hours) ? `-${hours}h` : `-${hours.toFixed(1)}h`;
}

export default function TimelinePlayer() {
    // Individual selectors — whole-store subscription re-renders this
    // component on every streamMetrics write (constant) and every
    // currentTime bump from Globe's onTick. Selector-per-field isolates
    // re-renders to the fields TimelinePlayer actually reads.
    const mode = useTimelineStore(s => s.mode);
    const setMode = useTimelineStore(s => s.setMode);
    const setPlaybackKind = useTimelineStore(s => s.setPlaybackKind);
    const currentTime = useTimelineStore(s => s.currentTime);
    const setCurrentTime = useTimelineStore(s => s.setCurrentTime);
    const markReplaySeek = useTimelineStore(s => s.markReplaySeek);
    const replayHydrating = useTimelineStore(s => s.replayHydrating);
    const isPlaying = useTimelineStore(s => s.isPlaying);
    const speedMultiplier = useTimelineStore(s => s.speedMultiplier);
    const setIsPlaying = useTimelineStore(s => s.setIsPlaying);
    const setSpeedMultiplier = useTimelineStore(s => s.setSpeedMultiplier);

    const [displayTime, setDisplayTime] = useState<string>('');
    const [rangeMs, setRangeMs] = useState<number>(REPLAY_DEFAULT_RANGE_MS);
    const [sliderPosition, setSliderPosition] = useState<number>(1);
    const sliderRef = useRef<HTMLInputElement>(null);
    const pendingSeekRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [rangeEndTimeMs, setRangeEndTimeMs] = useState<number>(() => Date.now());
    const isScrubbingRef = useRef(false);
    const scrubAnchorRef = useRef<number | null>(null);
    const isLive = mode === 'live';

    useEffect(() => {
        setDisplayTime(currentTime.toISOString().replace('T', ' ').substring(0, 19) + ' UTC');
    }, [currentTime]);

    useEffect(() => {
        if (isLive) {
            setRangeEndTimeMs(currentTime.getTime());
        }
    }, [currentTime, isLive]);

    useEffect(() => {
        if (isLive) return;
        if (currentTime.getTime() < rangeEndTimeMs) return;
        if (currentTime.getTime() !== rangeEndTimeMs) {
            setCurrentTime(new Date(rangeEndTimeMs));
        }
        if (isPlaying) {
            setIsPlaying(false);
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'pause' }}));
        }
    }, [currentTime, isLive, isPlaying, rangeEndTimeMs, setCurrentTime, setIsPlaying]);

    // Slider position: 0 = REPLAY_START, 1 = now
    const sliderValue = useCallback(() => {
        const replayEnd = isLive ? currentTime.getTime() : rangeEndTimeMs;
        const replayStart = replayEnd - rangeMs;
        const elapsed = currentTime.getTime() - replayStart;
        const range = rangeMs;
        return Math.max(0, Math.min(1, elapsed / range));
    }, [currentTime, isLive, rangeEndTimeMs, rangeMs]);

    useEffect(() => {
        if (isScrubbingRef.current) return;
        setSliderPosition(isLive ? 1 : sliderValue());
    }, [isLive, sliderValue]);

    const commitSeek = useCallback((val: number, replayEndMs: number) => {
        const replayStart = replayEndMs - rangeMs;
        const targetTime = new Date(replayStart + val * rangeMs);

        markReplaySeek();
        setCurrentTime(targetTime);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'seek', time: targetTime.toISOString() }}));
    }, [markReplaySeek, rangeMs, setCurrentTime]);

    const ensurePlaybackForSeek = useCallback((val: number) => {
        if (val < 0.99 && mode === 'live') {
            const anchorMs = Date.now();
            setRangeEndTimeMs(anchorMs);
            scrubAnchorRef.current = anchorMs;
            setMode('playback');
            setPlaybackKind('historical');
            setIsPlaying(false);
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'pause' }}));
            return anchorMs;
        }
        return scrubAnchorRef.current ?? rangeEndTimeMs;
    }, [mode, rangeEndTimeMs, setIsPlaying, setMode, setPlaybackKind]);

    const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = parseFloat(e.target.value);
        setSliderPosition(val);
        const anchorMs = ensurePlaybackForSeek(val);
        if (pendingSeekRef.current) clearTimeout(pendingSeekRef.current);
        if (isScrubbingRef.current) return;
        pendingSeekRef.current = setTimeout(() => {
            commitSeek(val, anchorMs);
            pendingSeekRef.current = null;
        }, 120);
    };

    const handleSliderCommit = () => {
        if (pendingSeekRef.current) {
            clearTimeout(pendingSeekRef.current);
            pendingSeekRef.current = null;
        }
        const anchorMs = ensurePlaybackForSeek(sliderPosition);
        commitSeek(sliderPosition, anchorMs);
        isScrubbingRef.current = false;
        scrubAnchorRef.current = null;
    };

    const handleSliderPointerDown = () => {
        isScrubbingRef.current = true;
        scrubAnchorRef.current = mode === 'live' ? Date.now() : rangeEndTimeMs;
        if (mode !== 'live' && isPlaying) {
            setIsPlaying(false);
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'pause' }}));
        }
    };

    useEffect(() => () => {
        if (pendingSeekRef.current) clearTimeout(pendingSeekRef.current);
    }, []);

    const handlePlayPause = () => {
        if(mode === 'live' || replayHydrating) return;
        setIsPlaying(!isPlaying);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: isPlaying ? 'pause' : 'play' }}));
    };

    const increaseSpeed = () => {
        if(mode === 'live') return;
        let newMulti = Math.max(1, speedMultiplier) * 2;
        if(newMulti > 3600) newMulti = 3600;
        setSpeedMultiplier(newMulti);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'speed', value: newMulti }}));
    };

    const decreaseSpeed = () => {
        if(mode === 'live') return;
        let newMulti = Math.max(1, speedMultiplier) / 2;
        if (newMulti < 1) newMulti = 1;
        setSpeedMultiplier(newMulti);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'speed', value: newMulti }}));
    };

    const toggleMode = () => {
        if (mode === 'live') {
            setMode('playback');
            setPlaybackKind('historical');
            setIsPlaying(false);
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'pause' }}));
        } else {
            setMode('live');
            setPlaybackKind(null);
            setSpeedMultiplier(1);
            setIsPlaying(true);
            setCurrentTime(new Date());
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'speed', value: 1.0 }}));
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'play' }}));
        }
    }

    // Format relative time for slider tooltip
    const formatRelative = (ms: number) => {
        const sec = Math.abs(ms) / 1000;
        if (sec < 60) return `${sec.toFixed(0)}s ago`;
        if (sec < 3600) return `${(sec / 60).toFixed(0)}m ago`;
        return `${(sec / 3600).toFixed(1)}h ago`;
    };

    const timeAgo = Date.now() - currentTime.getTime();
    const tickLabels = TICK_FRACTIONS.map((fraction) => ({
        fraction,
        label: formatTickLabel(rangeMs, fraction),
    }));

    return (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[720px] bg-black/80 backdrop-blur-xl border border-zinc-800 rounded-2xl shadow-2xl z-10 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 pt-3">
                <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500">
                    Replay Range
                </div>
                <div className="flex items-center gap-1">
                    {REPLAY_RANGE_OPTIONS.map((option) => (
                        <button
                            key={option.label}
                            onClick={() => setRangeMs(option.ms)}
                            aria-label={`Replay range ${option.label}`}
                            className={twMerge(
                                'px-2 py-1 rounded-md border text-[10px] font-mono transition-colors',
                                rangeMs === option.ms
                                    ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-300'
                                    : 'border-zinc-800 bg-zinc-900/80 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300',
                            )}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Slider track — always visible */}
            <div className="px-4 pt-3 pb-1">
                <div className="relative mb-2 h-5">
                    {tickLabels.map((tick) => (
                        <div
                            key={tick.fraction}
                            className="absolute top-0 -translate-x-1/2"
                            style={{ left: `${tick.fraction * 100}%` }}
                        >
                            <div className="mx-auto h-2 w-px bg-zinc-700" />
                            <div className="mt-1 whitespace-nowrap text-[9px] font-mono text-zinc-600">
                                {tick.label}
                            </div>
                        </div>
                    ))}
                    {!isLive && timeAgo > 1000 && (
                        <div className="absolute right-0 -top-5 text-[9px] font-mono text-cyan-400">
                            {formatRelative(timeAgo)}
                        </div>
                    )}
                </div>
                <input
                    ref={sliderRef}
                    type="range"
                    min="0"
                    max="1"
                    step="0.001"
                    value={sliderPosition}
                    onChange={handleSliderChange}
                    onMouseDown={handleSliderPointerDown}
                    onTouchStart={handleSliderPointerDown}
                    onMouseUp={handleSliderCommit}
                    onTouchEnd={handleSliderCommit}
                    onKeyUp={handleSliderCommit}
                    className="w-full h-1.5 rounded-full appearance-none cursor-pointer
                        [&::-webkit-slider-thumb]:appearance-none
                        [&::-webkit-slider-thumb]:w-3.5
                        [&::-webkit-slider-thumb]:h-3.5
                        [&::-webkit-slider-thumb]:rounded-full
                        [&::-webkit-slider-thumb]:bg-cyan-400
                        [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(0,255,255,0.5)]
                        [&::-webkit-slider-thumb]:border-2
                        [&::-webkit-slider-thumb]:border-cyan-600
                        [&::-webkit-slider-thumb]:cursor-grab
                        [&::-webkit-slider-thumb]:active:cursor-grabbing
                        bg-gradient-to-r from-zinc-800 via-zinc-700 to-cyan-800"
                />
            </div>

            {/* Controls row */}
            <div className="flex items-center px-6 pb-3 pt-1">
                <button
                    onClick={toggleMode}
                    aria-label="Toggle live mode"
                    className={twMerge(
                        "flex items-center space-x-2 px-4 py-1.5 rounded-full text-xs font-bold font-mono transition-all border",
                        isLive ? "bg-red-500/20 text-red-400 border-red-500/50 shadow-[0_0_10px_rgba(255,0,0,0.3)] animate-pulse"
                               : "bg-zinc-800 text-zinc-400 border-transparent hover:bg-zinc-700"
                    )}
                >
                    <Activity size={14} />
                    <span>LIVE</span>
                </button>

                <div className="mx-4 h-8 w-px bg-zinc-800" />

                <div className="flex-1 text-center">
                    <div className="font-mono text-lg text-cyan-400 tracking-wider drop-shadow-[0_0_8px_rgba(0,255,255,0.5)]">
                        {displayTime}
                    </div>
                </div>

                <div className="mx-4 h-8 w-px bg-zinc-800" />

                <div className={twMerge("flex items-center space-x-3", (isLive || replayHydrating) && "opacity-30 pointer-events-none")}>
                    <button
                        onClick={decreaseSpeed}
                        disabled={isLive || replayHydrating || speedMultiplier <= 1}
                        aria-label="Slower playback"
                        className={twMerge(
                            "text-zinc-400 hover:text-white disabled:text-zinc-700 disabled:cursor-default",
                        )}
                    >
                        <Minus size={18} />
                    </button>
                    <button
                        onClick={handlePlayPause}
                        disabled={replayHydrating}
                        aria-label={replayHydrating ? 'Replay loading' : isPlaying ? 'Pause playback' : 'Start playback'}
                        className="w-10 h-10 bg-cyan-600 text-black flex items-center justify-center rounded-full hover:bg-cyan-400 shadow-[0_0_10px_rgba(0,255,255,0.2)] disabled:bg-zinc-700 disabled:text-zinc-400 disabled:shadow-none"
                    >
                        {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
                    </button>
                    <button onClick={increaseSpeed} disabled={replayHydrating} aria-label="Faster playback" className="text-zinc-400 hover:text-white relative disabled:text-zinc-700 disabled:cursor-default">
                        <Plus size={18} />
                        {speedMultiplier !== 1 && !isLive && (
                            <div className="absolute -top-3 -right-3 text-[9px] font-mono text-cyan-400 font-bold bg-zinc-800 px-1 rounded border border-zinc-700">
                                {speedMultiplier}x
                            </div>
                        )}
                    </button>
                </div>
            </div>

            {!isLive && replayHydrating && (
                <div className="px-6 pb-3 -mt-1 text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">
                    Loading Replay Frame
                </div>
            )}
        </div>
    );
}
