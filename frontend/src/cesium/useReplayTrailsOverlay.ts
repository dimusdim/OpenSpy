import { useEffect } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { TrailBatcher, type TrailSample } from './TrailBatcher';

// Replay-mode TrailBatcher. Fetches POST /api/trajectories on seek / layer
// change / mode switch and renders a 'replay' shard of trails up to the
// playback clock currentTime. Rolls forward through ordinary playback via a
// 2 s setInterval that advances the trail window without a full refetch when
// the user has not seeked more than REFETCH_AFTER_MS of playback-time.
//
// Extracted from useReplayOverlay as the first imperative seam (codex
// challenge 2026-04-22). No behavioral change: the effect body matches the
// previous in-line effect byte-for-byte aside from the arguments it now
// reads from props instead of closure capture.
export interface UseReplayTrailsOverlayOptions {
    viewer: Cesium.Viewer | null | undefined;
    mode: string;
    playbackKind: 'historical' | 'track' | null;
    showTrajectories: boolean;
    activeReplayLayers: string[];
    // Keys below are passed verbatim from the parent hook so the effect's
    // identity matches the original effect exactly (same deps array).
    layersKey: string;
    replaySeekVersion: number;
    cancelVersionRef: React.MutableRefObject<number>;
}

export function useReplayTrailsOverlay(opts: UseReplayTrailsOverlayOptions): void {
    const {
        viewer,
        mode,
        playbackKind,
        showTrajectories,
        activeReplayLayers,
        layersKey,
        replaySeekVersion,
        cancelVersionRef,
    } = opts;

    useEffect(() => {
        if (!viewer || mode !== 'playback' || playbackKind !== 'historical' || !showTrajectories) return;

        const batcher = new TrailBatcher(viewer, {
            shardKeys: ['replay'],
            maxSamplesPerTrail: 500,
            trailLengthSeconds: 3600,
        });

        const trailableLayers = activeReplayLayers.filter(
            (layerId) => layerId === 'aircraft' || layerId === 'vessel' || layerId === 'satellite',
        );

        let cancelled = false;
        const reqVersion = cancelVersionRef.current;
        let abort = new AbortController();
        let lastFetchEndMs = 0;
        let fetchInFlight = false;
        const REFETCH_AFTER_MS = 30_000;

        const fetchTrails = async (trigger: 'initial' | 'tick') => {
            if (cancelled || cancelVersionRef.current !== reqVersion) return;
            if (trailableLayers.length === 0) return;
            if (fetchInFlight) return;
            const currentMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
            batcher.tickClock(currentMs / 1000);
            if (trigger === 'tick' && Math.abs(currentMs - lastFetchEndMs) < REFETCH_AFTER_MS) return;

            fetchInFlight = true;
            abort.abort();
            abort = new AbortController();
            const localAbort = abort;
            const endIso = new Date(currentMs).toISOString();
            const startIso = new Date(currentMs - 60 * 60 * 1000).toISOString();

            try {
                for (const layerId of trailableLayers) {
                    if (cancelled || cancelVersionRef.current !== reqVersion) return;
                    try {
                        const res = await axios.post<{
                            entities: Record<string, { positions: TrailSample[] }>;
                        }>(`${API_URL}/api/trajectories`, {
                            layerId,
                            bbox: [-90, -180, 90, 180],
                            startTime: startIso,
                            endTime: endIso,
                            maxPointsPerEntity: 500,
                        }, { signal: localAbort.signal });
                        if (cancelled || cancelVersionRef.current !== reqVersion) return;
                        const entities = res.data?.entities || {};
                        for (const [entityId, payload] of Object.entries(entities)) {
                            if (!payload?.positions?.length) continue;
                            batcher.setTrail('replay', entityId, payload.positions);
                        }
                    } catch (err) {
                        if (cancelled || axios.isCancel(err)) return;
                        console.warn('[ReplayOverlay] trajectory fetch failed', layerId, err);
                    }
                }
                lastFetchEndMs = currentMs;
            } finally {
                fetchInFlight = false;
            }
        };

        void fetchTrails('initial');
        const refetchInterval = setInterval(() => {
            const state = useTimelineStore.getState();
            if (state.mode !== 'playback' || state.playbackKind !== 'historical') return;
            const currentMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
            batcher.tickClock(currentMs / 1000);
            void fetchTrails('tick');
        }, 2_000);

        return () => {
            cancelled = true;
            clearInterval(refetchInterval);
            abort.abort();
            batcher.dispose();
        };
    }, [viewer, mode, playbackKind, layersKey, replaySeekVersion, showTrajectories]);
}
