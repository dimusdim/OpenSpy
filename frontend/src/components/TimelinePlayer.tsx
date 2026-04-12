'use client';

import { useTimelineStore } from '../store/useTimelineStore';
import { Play, Pause, Rewind, FastForward, Activity } from 'lucide-react';
import { useEffect, useState, useRef, useCallback } from 'react';
import { twMerge } from 'tailwind-merge';

// Session start — the earliest point the slider can reach.
// We use the time the page loaded so the slider covers "this session".
const SESSION_START = Date.now() - 2 * 3600 * 1000; // 2h before page load

export default function TimelinePlayer() {
    // Individual selectors — whole-store subscription re-renders this
    // component on every streamMetrics write (constant) and every
    // currentTime bump from Globe's onTick. Selector-per-field isolates
    // re-renders to the fields TimelinePlayer actually reads.
    const mode = useTimelineStore(s => s.mode);
    const setMode = useTimelineStore(s => s.setMode);
    const currentTime = useTimelineStore(s => s.currentTime);
    const setCurrentTime = useTimelineStore(s => s.setCurrentTime);
    const isPlaying = useTimelineStore(s => s.isPlaying);
    const speedMultiplier = useTimelineStore(s => s.speedMultiplier);
    const setIsPlaying = useTimelineStore(s => s.setIsPlaying);
    const setSpeedMultiplier = useTimelineStore(s => s.setSpeedMultiplier);

    const [displayTime, setDisplayTime] = useState<string>('');
    const sliderRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setDisplayTime(currentTime.toISOString().replace('T', ' ').substring(0, 19) + ' UTC');
    }, [currentTime]);

    // Slider position: 0 = SESSION_START, 1 = now
    const sliderValue = useCallback(() => {
        const now = Date.now();
        const range = now - SESSION_START;
        const elapsed = currentTime.getTime() - SESSION_START;
        return Math.max(0, Math.min(1, elapsed / range));
    }, [currentTime]);

    const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = parseFloat(e.target.value);
        const now = Date.now();
        const range = now - SESSION_START;
        const targetTime = new Date(SESSION_START + val * range);

        // Switch to playback mode if dragging away from live
        if (val < 0.99 && mode === 'live') {
            setMode('playback');
            setIsPlaying(false);
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'pause' }}));
        }

        setCurrentTime(targetTime);
        // Tell Cesium to jump to this time
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'seek', time: targetTime.toISOString() }}));
    };

    const handlePlayPause = () => {
        if(mode === 'live') return;
        setIsPlaying(!isPlaying);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: isPlaying ? 'pause' : 'play' }}));
    };

    const increaseSpeed = () => {
        if(mode === 'live') return;
        let newMulti = speedMultiplier * 2;
        if(newMulti === 0) newMulti = 1;
        if(newMulti > 3600) newMulti = 3600;
        setSpeedMultiplier(newMulti);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'speed', value: newMulti }}));
    };

    const decreaseSpeed = () => {
        if(mode === 'live') return;
        let newMulti = speedMultiplier / 2;
        if(Math.abs(newMulti) < 1) newMulti = -1;
        if(newMulti < -3600) newMulti = -3600;
        setSpeedMultiplier(newMulti);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'speed', value: newMulti }}));
    };

    const toggleMode = () => {
        if (mode === 'live') {
            setMode('playback');
            setIsPlaying(false);
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'pause' }}));
        } else {
            setMode('live');
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

    const isLive = mode === 'live';
    const timeAgo = Date.now() - currentTime.getTime();

    return (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[720px] bg-black/80 backdrop-blur-xl border border-zinc-800 rounded-2xl shadow-2xl z-10 flex flex-col overflow-hidden">
            {/* Slider track — always visible */}
            <div className="px-4 pt-3 pb-1">
                <div className="flex justify-between text-[9px] font-mono text-zinc-600 mb-1">
                    <span>-2h</span>
                    <span>{!isLive && timeAgo > 1000 ? formatRelative(timeAgo) : ''}</span>
                    <span>NOW</span>
                </div>
                <input
                    ref={sliderRef}
                    type="range"
                    min="0"
                    max="1"
                    step="0.001"
                    value={isLive ? 1 : sliderValue()}
                    onChange={handleSliderChange}
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

                <div className={twMerge("flex items-center space-x-3", isLive && "opacity-30 pointer-events-none")}>
                    <button onClick={decreaseSpeed} className="text-zinc-400 hover:text-white">
                        <Rewind size={18} />
                    </button>
                    <button onClick={handlePlayPause} className="w-10 h-10 bg-cyan-600 text-black flex items-center justify-center rounded-full hover:bg-cyan-400 shadow-[0_0_10px_rgba(0,255,255,0.2)]">
                        {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
                    </button>
                    <button onClick={increaseSpeed} className="text-zinc-400 hover:text-white relative">
                        <FastForward size={18} />
                        {speedMultiplier !== 1 && !isLive && (
                            <div className="absolute -top-3 -right-3 text-[9px] font-mono text-cyan-400 font-bold bg-zinc-800 px-1 rounded border border-zinc-700">
                                {speedMultiplier}x
                            </div>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
