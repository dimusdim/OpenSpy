'use client';

import { API_URL } from '../lib/config';
import { useTimelineStore, type LayerName } from '../store/useTimelineStore';
import { Play, Pause, Minus, Plus, Activity, Loader2 } from 'lucide-react';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { twMerge } from 'tailwind-merge';

const REPLAY_RANGE_OPTIONS = [
    { label: '1m', ms: 60 * 1000 },
    { label: '5m', ms: 5 * 60 * 1000 },
    { label: '15m', ms: 15 * 60 * 1000 },
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];
const REPLAY_DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const AVAILABILITY_REFRESH_MIN_MS = 60 * 1000;
const AVAILABILITY_REFRESH_MAX_MS = 5 * 60 * 1000;
const LIVE_CLOCK_REFRESH_MS = 15 * 1000;

type TimelineAvailabilityBucket = {
    bucket_start: string;
    sample_count: number;
    object_count: number;
    layers?: Record<string, number>;
    families?: Record<string, number>;
};

type TimelineAvailabilitySegment = {
    key: string;
    left: number;
    width: number;
    title: string;
};

type TimelineTick = {
    fraction: number;
    major: boolean;
};

type TimelineDragState = {
    mode: 'seek' | 'pending-pan' | 'pan';
    pointerId: number;
    startClientX: number;
    startRangeEndMs: number;
    currentRangeEndMs: number;
    startSliderPosition: number;
    sliderPosition: number;
    moved: boolean;
};

type TimelineHoverState = {
    fraction: number;
    timestampMs: number;
};

const TIMELINE_LAYER_SCOPE: Partial<Record<LayerName, string>> = {
    satellites: 'satellite',
    aviation: 'aircraft',
    maritime: 'vessel',
    disasters: 'disasters',
    jamming: 'jamming',
    fires: 'fire',
    cables: 'cable',
    webcams: 'webcam',
    infrastructure: 'infrastructure',
    pipelines: 'pipeline',
    outages: 'outage',
    wifi: 'wifi',
    conflicts: 'conflict',
    airspace: 'airspace',
    gfw: 'gfw',
    labels: 'border',
};

function formatDuration(ms: number): string {
    const totalMinutes = Math.round(Math.abs(ms) / 60000);
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const totalHours = totalMinutes / 60;
    if (totalHours < 48) return Number.isInteger(totalHours) ? `${totalHours}h` : `${totalHours.toFixed(1)}h`;
    const days = totalHours / 24;
    return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}

function formatAgeLabel(timestampMs: number, nowMs: number): string {
    const deltaMs = Math.max(0, nowMs - timestampMs);
    if (deltaMs < 60 * 1000) return 'NOW';
    return `-${formatDuration(deltaMs)}`;
}

function formatPreviewTime(timestampMs: number, nowMs: number): string {
    const date = new Date(timestampMs);
    const time = date.toISOString().replace('T', ' ').substring(11, 19);
    return `${time} UTC  ${formatAgeLabel(timestampMs, nowMs)}`;
}

function availabilityResolutionSeconds(rangeMs: number): number {
    if (rangeMs <= 5 * 60 * 1000) return 1;
    if (rangeMs <= 15 * 60 * 1000) return 5;
    if (rangeMs <= 60 * 60 * 1000) return 60;
    if (rangeMs <= 6 * 60 * 60 * 1000) return 5 * 60;
    if (rangeMs <= 24 * 60 * 60 * 1000) return 5 * 60;
    return 5 * 60;
}

function availabilityMergeGapMs(resolutionMs: number): number {
    // Merge only bucket-quantization seams (a single missing bucket reads as
    // jitter). Anything wider than ~1.5 buckets is a real ingest gap and must
    // stay visible on the timeline — the bar exists to show where DB data is.
    return resolutionMs * 1.5;
}

function timelineTickConfig(rangeMs: number): { minorStepMs: number; majorStepMs: number } {
    if (rangeMs <= 5 * 60 * 1000) return { minorStepMs: 30 * 1000, majorStepMs: 60 * 1000 };
    if (rangeMs <= 15 * 60 * 1000) return { minorStepMs: 60 * 1000, majorStepMs: 5 * 60 * 1000 };
    if (rangeMs <= 60 * 60 * 1000) return { minorStepMs: 5 * 60 * 1000, majorStepMs: 15 * 60 * 1000 };
    if (rangeMs <= 6 * 60 * 60 * 1000) return { minorStepMs: 30 * 60 * 1000, majorStepMs: 60 * 60 * 1000 };
    if (rangeMs <= 24 * 60 * 60 * 1000) return { minorStepMs: 3 * 60 * 60 * 1000, majorStepMs: 6 * 60 * 60 * 1000 };
    return { minorStepMs: 12 * 60 * 60 * 1000, majorStepMs: 24 * 60 * 60 * 1000 };
}

function normalizeAvailabilityBucket(value: unknown): TimelineAvailabilityBucket | null {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, any>;
    const bucketStart = row.bucket_start || row.bucketStart || row.at;
    if (!bucketStart) return null;
    const date = new Date(String(bucketStart));
    if (Number.isNaN(date.getTime())) return null;
    const sampleCount = Number(row.sample_count ?? row.sampleCount ?? row.count ?? 0);
    const objectCount = Number(row.object_count ?? row.objectCount ?? 0);
    return {
        bucket_start: date.toISOString(),
        sample_count: Number.isFinite(sampleCount) ? sampleCount : 0,
        object_count: Number.isFinite(objectCount) ? objectCount : 0,
        layers: row.layers && typeof row.layers === 'object' ? row.layers : undefined,
        families: row.families && typeof row.families === 'object' ? row.families : undefined,
    };
}

export default function TimelinePlayer({ embedded = false }: { embedded?: boolean }) {
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
    const sources = useTimelineStore(s => s.sources);
    const visibility = useTimelineStore(s => s.visibility);

    const [displayTime, setDisplayTime] = useState<string>('');
    const [rangeMs, setRangeMs] = useState<number>(REPLAY_DEFAULT_RANGE_MS);
    const [sliderPosition, setSliderPosition] = useState<number>(1);
    const [availabilityBuckets, setAvailabilityBuckets] = useState<TimelineAvailabilityBucket[]>([]);
    const [timelineNowMs, setTimelineNowMs] = useState<number>(() => Date.now());
    const [isWindowPanning, setIsWindowPanning] = useState(false);
    const [hoverState, setHoverState] = useState<TimelineHoverState | null>(null);
    const scrubRef = useRef<HTMLDivElement>(null);
    const scrubDragRef = useRef<TimelineDragState | null>(null);
    const pendingSeekRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [rangeEndTimeMs, setRangeEndTimeMs] = useState<number>(() => Date.now());
    const isScrubbingRef = useRef(false);
    const scrubAnchorRef = useRef<number | null>(null);
    const isLive = mode === 'live';
    const visibleRangeEndMs = isLive ? timelineNowMs : rangeEndTimeMs;
    const visibleRangeStartMs = visibleRangeEndMs - rangeMs;
    const resolutionSeconds = availabilityResolutionSeconds(rangeMs);
    const availabilityRefreshMs = Math.max(
        AVAILABILITY_REFRESH_MIN_MS,
        Math.min(AVAILABILITY_REFRESH_MAX_MS, resolutionSeconds * 1000),
    );
    const availabilityQueryEndMs = Math.ceil(visibleRangeEndMs / availabilityRefreshMs) * availabilityRefreshMs;
    const availabilityQueryStartMs = availabilityQueryEndMs - rangeMs;

    const activeLayerScope = useMemo(() => {
        const layers = new Set<string>();
        for (const [key, enabled] of Object.entries(sources) as [LayerName, boolean][]) {
            if (!enabled) continue;
            // Replay hydration draws a layer only when BOTH the source and its
            // visibility flag are on (useReplayOverlay.activeReplayLayers).
            // The availability bar must use the same gate, otherwise hidden
            // layers paint the bar green for times the replay will not render.
            if (visibility[key] === false) continue;
            const layer = TIMELINE_LAYER_SCOPE[key];
            if (layer) layers.add(layer);
        }
        return Array.from(layers).sort().join(',');
    }, [sources, visibility]);

    useEffect(() => {
        setDisplayTime(currentTime.toISOString().replace('T', ' ').substring(0, 19) + ' UTC');
    }, [currentTime]);

    useEffect(() => {
        const timer = window.setInterval(() => setTimelineNowMs(Date.now()), LIVE_CLOCK_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!activeLayerScope || !Number.isFinite(availabilityQueryStartMs) || !Number.isFinite(availabilityQueryEndMs)) {
            setAvailabilityBuckets([]);
            return;
        }

        const controller = new AbortController();
        const params = new URLSearchParams({
            from: new Date(availabilityQueryStartMs).toISOString(),
            to: new Date(availabilityQueryEndMs).toISOString(),
            resolutionSeconds: String(resolutionSeconds),
            layers: activeLayerScope,
        });

        fetch(`${API_URL}/api/replay/timeline-availability?${params.toString()}`, {
            signal: controller.signal,
        })
            .then((response) => response.ok ? response.json() : null)
            .then((payload) => {
                if (!payload || !Array.isArray(payload.buckets)) {
                    setAvailabilityBuckets([]);
                    return;
                }
                setAvailabilityBuckets(payload.buckets
                    .map(normalizeAvailabilityBucket)
                    .filter((bucket: TimelineAvailabilityBucket | null): bucket is TimelineAvailabilityBucket => Boolean(bucket)));
            })
            .catch((error) => {
                if (error?.name !== 'AbortError') setAvailabilityBuckets([]);
            });

        return () => controller.abort();
    }, [activeLayerScope, availabilityQueryEndMs, availabilityQueryStartMs, resolutionSeconds]);

    useEffect(() => {
        if (isLive) {
            setRangeEndTimeMs(timelineNowMs);
        }
    }, [isLive, timelineNowMs]);

    useEffect(() => {
        if (isLive) return;
        const rangeStartMs = rangeEndTimeMs - rangeMs;
        const timeMs = currentTime.getTime();
        const clampedMs = Math.max(rangeStartMs, Math.min(rangeEndTimeMs, timeMs));
        if (timeMs !== clampedMs) {
            setCurrentTime(new Date(clampedMs), {
                silent: true,
                reason: 'playback-clamp',
            });
        }
        if (timeMs > rangeEndTimeMs && isPlaying) {
            setIsPlaying(false);
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'pause' }}));
        }
    }, [currentTime, isLive, isPlaying, rangeEndTimeMs, rangeMs, setCurrentTime, setIsPlaying]);

    // Slider position: 0 = REPLAY_START, 1 = now
    const sliderValue = useCallback(() => {
        const replayEnd = isLive ? timelineNowMs : rangeEndTimeMs;
        const replayStart = replayEnd - rangeMs;
        const elapsed = currentTime.getTime() - replayStart;
        const range = rangeMs;
        return Math.max(0, Math.min(1, elapsed / range));
    }, [currentTime, isLive, rangeEndTimeMs, rangeMs, timelineNowMs]);

    useEffect(() => {
        if (isScrubbingRef.current) return;
        setSliderPosition(isLive ? 1 : sliderValue());
    }, [isLive, sliderValue]);

    const commitSeek = useCallback((val: number, replayEndMs: number) => {
        const replayStart = replayEndMs - rangeMs;
        const targetTime = new Date(replayStart + val * rangeMs);

        markReplaySeek();
        setCurrentTime(targetTime, { reason: 'user-seek' });
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'seek', time: targetTime.toISOString() }}));
    }, [markReplaySeek, rangeMs, setCurrentTime]);

    const pauseHistoricalPlayback = useCallback(() => {
        setMode('playback');
        setPlaybackKind('historical');
        setIsPlaying(false);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'pause' }}));
    }, [setIsPlaying, setMode, setPlaybackKind]);

    const clampRangeEnd = useCallback((endMs: number) => {
        const nowMs = Date.now();
        return Math.max(0, Math.min(nowMs, endMs));
    }, []);

    const ensurePlaybackForSeek = useCallback((val: number) => {
        if (val < 0.99 && mode === 'live') {
            const anchorMs = timelineNowMs;
            setRangeEndTimeMs(anchorMs);
            scrubAnchorRef.current = anchorMs;
            pauseHistoricalPlayback();
            return anchorMs;
        }
        return scrubAnchorRef.current ?? rangeEndTimeMs;
    }, [mode, pauseHistoricalPlayback, rangeEndTimeMs, timelineNowMs]);

    useEffect(() => () => {
        if (pendingSeekRef.current) clearTimeout(pendingSeekRef.current);
    }, []);

    const clientXToSliderPosition = useCallback((clientX: number) => {
        const rect = scrubRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0) return sliderPosition;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }, [sliderPosition]);

    const updateHoverPreview = useCallback((clientX: number, replayEndMs = visibleRangeEndMs) => {
        const fraction = clientXToSliderPosition(clientX);
        setHoverState({
            fraction,
            timestampMs: replayEndMs - rangeMs + fraction * rangeMs,
        });
    }, [clientXToSliderPosition, rangeMs, visibleRangeEndMs]);

    const scheduleSeek = useCallback((val: number, anchorMs: number) => {
        if (pendingSeekRef.current) clearTimeout(pendingSeekRef.current);
        pendingSeekRef.current = setTimeout(() => {
            commitSeek(val, anchorMs);
            pendingSeekRef.current = null;
        }, 120);
    }, [commitSeek]);

    const setReplayRange = useCallback((nextRangeMs: number) => {
        const selectedMs = currentTime.getTime();
        const currentValue = sliderValue();
        const nextEndMs = isLive
            ? timelineNowMs
            : clampRangeEnd(selectedMs + (1 - currentValue) * nextRangeMs);
        setRangeMs(nextRangeMs);
        setRangeEndTimeMs(nextEndMs);
    }, [clampRangeEnd, currentTime, isLive, sliderValue, timelineNowMs]);

    const handleScrubPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();

        const target = event.target as HTMLElement | null;
        const isPlayhead = Boolean(target?.closest('[data-playhead="true"]'));
        const anchorMs = mode === 'live' ? timelineNowMs : rangeEndTimeMs;
        const pointerPosition = clientXToSliderPosition(event.clientX);
        updateHoverPreview(event.clientX, anchorMs);

        scrubDragRef.current = {
            mode: isPlayhead ? 'seek' : 'pending-pan',
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startRangeEndMs: anchorMs,
            currentRangeEndMs: anchorMs,
            startSliderPosition: isPlayhead ? sliderPosition : pointerPosition,
            sliderPosition: isPlayhead ? sliderPosition : pointerPosition,
            moved: false,
        };
        scrubAnchorRef.current = anchorMs;
        isScrubbingRef.current = true;
        document.body.classList.add('os-timeline-dragging');
        window.getSelection()?.removeAllRanges();
        event.currentTarget.setPointerCapture(event.pointerId);

        if (isPlayhead) {
            if (mode !== 'live') pauseHistoricalPlayback();
            return;
        }

        if (mode !== 'live' && isPlaying) pauseHistoricalPlayback();
    }, [clientXToSliderPosition, isPlaying, mode, pauseHistoricalPlayback, rangeEndTimeMs, sliderPosition, timelineNowMs]);

    const handleScrubPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = scrubDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) {
            updateHoverPreview(event.clientX);
            return;
        }
        event.preventDefault();
        window.getSelection()?.removeAllRanges();

        const dx = event.clientX - drag.startClientX;
        if (drag.mode === 'seek') {
            const nextValue = clientXToSliderPosition(event.clientX);
            drag.sliderPosition = nextValue;
            setSliderPosition(nextValue);
            setHoverState({
                fraction: nextValue,
                timestampMs: drag.currentRangeEndMs - rangeMs + nextValue * rangeMs,
            });
            scheduleSeek(nextValue, drag.currentRangeEndMs);
            return;
        }

        if (Math.abs(dx) < 5 && drag.mode === 'pending-pan') return;

        if (drag.mode === 'pending-pan') {
            drag.mode = 'pan';
            drag.moved = true;
            setIsWindowPanning(true);
            pauseHistoricalPlayback();
        }

        const rect = scrubRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;

        const nextEndMs = clampRangeEnd(drag.startRangeEndMs - (dx / rect.width) * rangeMs);
        drag.currentRangeEndMs = nextEndMs;
        setRangeEndTimeMs(nextEndMs);
        updateHoverPreview(event.clientX, nextEndMs);
    }, [clientXToSliderPosition, clampRangeEnd, pauseHistoricalPlayback, rangeMs, scheduleSeek, updateHoverPreview]);

    const handleScrubPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = scrubDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;

        if (pendingSeekRef.current) {
            clearTimeout(pendingSeekRef.current);
            pendingSeekRef.current = null;
        }

        if (drag.mode === 'pending-pan') {
            const nextValue = clientXToSliderPosition(event.clientX);
            setSliderPosition(nextValue);
            const anchorMs = ensurePlaybackForSeek(nextValue);
            commitSeek(nextValue, anchorMs);
        } else {
            commitSeek(drag.sliderPosition, drag.currentRangeEndMs);
        }

        scrubDragRef.current = null;
        scrubAnchorRef.current = null;
        isScrubbingRef.current = false;
        setIsWindowPanning(false);
        document.body.classList.remove('os-timeline-dragging');
        event.currentTarget.releasePointerCapture(event.pointerId);
    }, [clientXToSliderPosition, commitSeek, ensurePlaybackForSeek]);

    const handleScrubPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (scrubDragRef.current?.pointerId === event.pointerId) {
            scrubDragRef.current = null;
            scrubAnchorRef.current = null;
            isScrubbingRef.current = false;
            setIsWindowPanning(false);
            document.body.classList.remove('os-timeline-dragging');
        }
    }, []);

    const handleScrubPointerEnter = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        updateHoverPreview(event.clientX);
    }, [updateHoverPreview]);

    const handleScrubPointerLeave = useCallback(() => {
        if (!scrubDragRef.current) setHoverState(null);
    }, []);

    useEffect(() => () => {
        document.body.classList.remove('os-timeline-dragging');
    }, []);

    const handleScrubWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
        const rect = scrubRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (!delta) return;
        event.preventDefault();
        pauseHistoricalPlayback();
        const baseEndMs = mode === 'live' ? timelineNowMs : rangeEndTimeMs;
        setRangeEndTimeMs(clampRangeEnd(baseEndMs + (delta / rect.width) * rangeMs));
    }, [clampRangeEnd, mode, pauseHistoricalPlayback, rangeEndTimeMs, rangeMs, timelineNowMs]);

    const handleScrubKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const seekStep = event.shiftKey ? 0.1 : 0.01;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const nextValue = Math.max(0, Math.min(1, sliderPosition + direction * seekStep));
            setSliderPosition(nextValue);
            const anchorMs = ensurePlaybackForSeek(nextValue);
            commitSeek(nextValue, anchorMs);
        }
        if (event.key === 'PageUp' || event.key === 'PageDown') {
            event.preventDefault();
            pauseHistoricalPlayback();
            const direction = event.key === 'PageDown' ? -1 : 1;
            const baseEndMs = mode === 'live' ? timelineNowMs : rangeEndTimeMs;
            setRangeEndTimeMs(clampRangeEnd(baseEndMs + direction * rangeMs));
        }
    }, [clampRangeEnd, commitSeek, ensurePlaybackForSeek, mode, pauseHistoricalPlayback, rangeEndTimeMs, rangeMs, sliderPosition, timelineNowMs]);

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

    const enterReplayWindow = useCallback(() => {
        const anchorMs = Date.now();
        const targetTime = new Date(anchorMs - rangeMs);
        setRangeEndTimeMs(anchorMs);
        setSliderPosition(0);
        useTimelineStore.getState().enterHistoricalReplay();
        markReplaySeek();
        setCurrentTime(targetTime, { reason: 'mode-change' });
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'seek', time: targetTime.toISOString() }}));
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'pause' }}));
    }, [markReplaySeek, rangeMs, setCurrentTime]);

    const toggleMode = () => {
        if (mode === 'live') {
            enterReplayWindow();
        } else {
            useTimelineStore.getState().exitToLive();
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'speed', value: 1.0 }}));
            document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'play' }}));
        }
    }

    const setReplayMode = () => {
        if (mode !== 'live') return;
        enterReplayWindow();
    };

    const setLiveMode = () => {
        if (mode === 'live') return;
        useTimelineStore.getState().exitToLive();
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'speed', value: 1.0 }}));
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'play' }}));
    };

    const setSpeed = (value: number) => {
        if (mode === 'live') return;
        setSpeedMultiplier(value);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'speed', value }}));
    };

    const handleEmbeddedPlayPause = () => {
        if (isLive) {
            enterReplayWindow();
            return;
        }
        handlePlayPause();
    };

    // Format relative time for slider tooltip
    const formatRelative = (ms: number) => {
        const sec = Math.abs(ms) / 1000;
        if (sec < 60) return `${sec.toFixed(0)}s ago`;
        if (sec < 3600) return `${(sec / 60).toFixed(0)}m ago`;
        return `${(sec / 3600).toFixed(1)}h ago`;
    };

    const timeAgo = Date.now() - currentTime.getTime();
    const tickLabels = useMemo<TimelineTick[]>(() => {
        const { minorStepMs, majorStepMs } = timelineTickConfig(rangeMs);
        const minOffsetMs = Math.max(0, timelineNowMs - visibleRangeEndMs);
        const maxOffsetMs = Math.max(0, timelineNowMs - visibleRangeStartMs);
        const firstOffsetMs = Math.floor(maxOffsetMs / minorStepMs) * minorStepMs;
        const ticks: TimelineTick[] = [];

        for (let offsetMs = firstOffsetMs; offsetMs >= minOffsetMs; offsetMs -= minorStepMs) {
            const timestampMs = timelineNowMs - offsetMs;
            const fraction = (timestampMs - visibleRangeStartMs) / rangeMs;
            if (fraction < 0 || fraction > 1) continue;
            const major = offsetMs % majorStepMs === 0;
            ticks.push({
                fraction,
                major,
            });
        }

        if (ticks.length === 0 || ticks[ticks.length - 1].fraction < 0.995) {
            ticks.push({
                fraction: 1,
                major: true,
            });
        }

        if (ticks[0]?.fraction > 0.005) {
            ticks.unshift({
                fraction: 0,
                major: true,
            });
        }

        return ticks;
    }, [rangeMs, timelineNowMs, visibleRangeEndMs, visibleRangeStartMs]);
    const availabilitySegments = useMemo<TimelineAvailabilitySegment[]>(() => {
        const resolutionMs = resolutionSeconds * 1000;
        const mergeGapMs = availabilityMergeGapMs(resolutionMs);
        const ranges = availabilityBuckets
            .map((bucket) => {
                if (!bucket.sample_count) return null;
                const startMs = new Date(bucket.bucket_start).getTime();
                if (!Number.isFinite(startMs)) return null;
                return {
                    startMs,
                    endMs: startMs + resolutionMs,
                    sampleCount: bucket.sample_count,
                    objectCount: bucket.object_count,
                };
            })
            .filter((range): range is { startMs: number; endMs: number; sampleCount: number; objectCount: number } => Boolean(range))
            .sort((left, right) => left.startMs - right.startMs);

        const merged: typeof ranges = [];
        for (const range of ranges) {
            const previous = merged[merged.length - 1];
            if (previous && range.startMs <= previous.endMs + mergeGapMs) {
                previous.endMs = Math.max(previous.endMs, range.endMs);
                previous.sampleCount += range.sampleCount;
                previous.objectCount += range.objectCount;
            } else {
                merged.push({ ...range });
            }
        }

        return merged.flatMap((range) => {
            const clippedStartMs = Math.max(range.startMs, visibleRangeStartMs);
            const clippedEndMs = Math.min(range.endMs, visibleRangeEndMs);
            if (clippedEndMs <= clippedStartMs) return [];

            const left = Math.max(0, Math.min(100, ((clippedStartMs - visibleRangeStartMs) / rangeMs) * 100));
            const rawWidth = ((clippedEndMs - clippedStartMs) / rangeMs) * 100;
            const width = Math.max(0.2, Math.min(100 - left, rawWidth));
            if (width <= 0) return [];
            return [{
                key: `${range.startMs}:${range.endMs}`,
                left,
                width,
                title: `${range.sampleCount.toLocaleString()} rows / ${range.objectCount.toLocaleString()} objects`,
            }];
        });
    }, [availabilityBuckets, rangeMs, resolutionSeconds, visibleRangeEndMs, visibleRangeStartMs]);

    const renderAvailabilitySegments = () => availabilitySegments.map((segment) => (
        <div
            key={segment.key}
            aria-hidden="true"
            className="os-timeline__data-segment"
            title={segment.title}
            style={{
                left: `${segment.left}%`,
                width: `${segment.width}%`,
            }}
        />
    ));

    const renderTicks = () => (
        <div className="os-timeline__ticks" aria-hidden="true">
            {tickLabels.map((tick) => (
                <div
                    key={`${tick.fraction}:${tick.major}`}
                    className={twMerge('os-timeline__tick', tick.major && 'os-timeline__tick--major')}
                    style={{ left: `${tick.fraction * 100}%` }}
                />
            ))}
        </div>
    );

    const renderScrubBar = (compact = false) => (
        <div
            ref={scrubRef}
            className={twMerge('os-timeline__scrub', compact && 'os-timeline__scrub--compact')}
            data-panning={isWindowPanning ? 'true' : 'false'}
            onPointerEnter={handleScrubPointerEnter}
            onPointerDown={handleScrubPointerDown}
            onPointerMove={handleScrubPointerMove}
            onPointerUp={handleScrubPointerUp}
            onPointerCancel={handleScrubPointerCancel}
            onPointerLeave={handleScrubPointerLeave}
            onWheel={handleScrubWheel}
            onKeyDown={handleScrubKeyDown}
            role="slider"
            tabIndex={0}
            aria-label="Replay time window"
            aria-valuemin={0}
            aria-valuemax={1000}
            aria-valuenow={Math.round(sliderPosition * 1000)}
        >
            {renderTicks()}
            <div className="os-timeline__track">
                {renderAvailabilitySegments()}
            </div>
            {hoverState && (
                <div
                    aria-hidden="true"
                    className="os-timeline__preview"
                    data-edge={hoverState.fraction < 0.14 ? 'start' : hoverState.fraction > 0.86 ? 'end' : 'middle'}
                    style={{ left: `${hoverState.fraction * 100}%` }}
                >
                    <div className="os-timeline__preview-head" />
                    <div className="os-timeline__preview-tooltip">
                        {formatPreviewTime(hoverState.timestampMs, timelineNowMs)}
                    </div>
                </div>
            )}
            <div
                data-playhead="true"
                className="os-timeline__thumb"
                style={{ left: `${sliderPosition * 100}%` }}
            />
        </div>
    );

    if (embedded) {
        return (
            <div data-timeline-player="true" className="os-timeline">
                <div className="os-timeline__mode">
                    <button data-active={isLive ? 'true' : 'false'} onClick={setLiveMode}>LIVE</button>
                    <button data-active={!isLive ? 'true' : 'false'} onClick={setReplayMode}>REPLAY</button>
                </div>

                <button
                    onClick={handleEmbeddedPlayPause}
                    disabled={replayHydrating}
                    aria-label={replayHydrating ? 'Replay loading' : isPlaying ? 'Pause playback' : 'Start playback'}
                    className="os-rail-btn disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ width: 28, height: 28 }}
                >
                    {replayHydrating ? (
                        <Loader2 size={14} className="animate-spin" />
                    ) : isPlaying && !isLive ? (
                        <Pause size={14} fill="currentColor" />
                    ) : (
                        <Play size={14} fill="currentColor" className="ml-0.5" />
                    )}
                </button>

                {renderScrubBar(true)}

                <div className="os-timeline__mode">
                    {REPLAY_RANGE_OPTIONS.map((option) => (
                        <button
                            key={option.label}
                            data-active={rangeMs === option.ms ? 'true' : 'false'}
                            onClick={() => setReplayRange(option.ms)}
                            aria-label={`Replay range ${option.label}`}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>

                <div className="os-timeline__mode">
                    {[0.5, 1, 4, 60, 3600].map((value) => (
                        <button
                            key={value}
                            data-active={!isLive && speedMultiplier === value ? 'true' : 'false'}
                            onClick={() => setSpeed(value)}
                            disabled={isLive}
                        >
                            {value}x
                        </button>
                    ))}
                </div>

                <div className="os-timeline__time">
                    <b>{replayHydrating ? 'LOADING REPLAY' : displayTime}</b>
                </div>
            </div>
        );
    }

    return (
        <div
            data-timeline-player="true"
            className={twMerge(
                // no overflow-hidden: the scrub hover tooltip floats above the panel
                'bg-black/80 backdrop-blur-xl border border-zinc-800 shadow-2xl flex flex-col',
                'absolute bottom-6 left-1/2 -translate-x-1/2 w-[720px] rounded-2xl z-10',
            )}
        >
            <div className="flex items-center justify-between px-4 pt-3">
                <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500">
                    Replay Range
                </div>
                <div className="flex items-center gap-1">
                    {REPLAY_RANGE_OPTIONS.map((option) => (
                        <button
                            key={option.label}
                            onClick={() => setReplayRange(option.ms)}
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
                <div className="relative mb-1 h-4">
                    {!isLive && timeAgo > 1000 && (
                        <div className="absolute right-0 top-0 text-[9px] font-mono text-cyan-400">
                            {formatRelative(timeAgo)}
                        </div>
                    )}
                </div>
                {renderScrubBar()}
            </div>

            {/* Controls row */}
            <div className="flex items-center px-6 pb-3 pt-1">
                <button
                    onClick={toggleMode}
                    aria-label="Toggle live mode"
                    className={twMerge(
                        "flex items-center space-x-2 px-4 py-1.5 rounded-full text-xs font-bold font-mono transition-all border",
                        isLive ? "bg-red-500/20 text-red-400 border-red-500/50 shadow-[0_0_10px_rgba(255,0,0,0.3)]"
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
