import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Cesium from 'cesium';
import {
    AI_CONTEXT_DEFAULTS,
    MAX_AI_CONTEXT_OBJECTS,
    useAIImageStore,
    type AIContextObject,
    type AIContextSearchCenter,
    type AIContextSourceId,
    type AIContextSnapshot,
    type Preset,
} from '../store/useAIImageStore';
import { useTimelineStore } from '../store/useTimelineStore';
import {
    AI_CONTEXT_SOURCE_LABEL,
    getAIContextCandidates,
    haversineMeters,
    type AIContextCandidate,
} from '../lib/ai-context-sources';

export type AIContextLookupStatus = 'inactive' | 'noTarget' | 'empty' | 'ok';

export interface AIContextLookupResult {
    status: AIContextLookupStatus;
    center: { lat: number; lng: number } | null;
    candidates: AIContextObject[];
    selected: AIContextObject[];
    effectiveMax: number;
    snapshot: AIContextSnapshot | null;
    refreshing: boolean;
    pendingSourceLabels: string[];
}

const RECOMPUTE_DEBOUNCE_MS = 300;
const CONTEXT_METRIC_LAYER_BY_SOURCE: Record<AIContextSourceId, string | null> = {
    infrastructure: 'infrastructure',
    aircraft: 'aviation',
    vessels: 'maritime',
    pipelines: 'pipelines',
    fires: 'fires',
    cables: 'cables',
    airspace: 'airspace',
    webcams: 'webcams',
    wifi: 'wifi',
    satellites: 'satellites',
    replay: null,
};

const EMPTY_INACTIVE: AIContextLookupResult = {
    status: 'inactive',
    center: null,
    candidates: [],
    selected: [],
    effectiveMax: 0,
    snapshot: null,
    refreshing: false,
    pendingSourceLabels: [],
};

export function useAIImageNearbyContext(
    preset: Preset,
    viewer: Cesium.Viewer | null,
): AIContextLookupResult {
    const isPanelActive = useAIImageStore((s) => s.isActive);
    const excludedContextObjects = useAIImageStore((s) => s.excludedContextObjects);
    const excludedForPreset = useMemo(
        () => excludedContextObjects[preset.id] ?? {},
        [excludedContextObjects, preset.id],
    );
    const bumpSeen = useAIImageStore((s) => s.bumpExcludedContextObjectsSeen);

    const contextMode = preset.contextMode ?? AI_CONTEXT_DEFAULTS.contextMode;
    const searchCenter = preset.searchCenter ?? AI_CONTEXT_DEFAULTS.searchCenter;
    const radiusM = preset.searchRadiusM ?? AI_CONTEXT_DEFAULTS.searchRadiusM;
    const sources = preset.contextSources ?? AI_CONTEXT_DEFAULTS.contextSources;
    const maxObjects = preset.maxContextObjects ?? AI_CONTEXT_DEFAULTS.maxContextObjects;
    const effectiveMax = Math.max(1, Math.min(maxObjects, MAX_AI_CONTEXT_OBJECTS));
    const isActive = isPanelActive && contextMode !== 'none';
    const metricsSignal = useTimelineStore((state) => {
        const pending: AIContextSourceId[] = [];
        const parts = sources.map((sourceId) => {
            const layerId = CONTEXT_METRIC_LAYER_BY_SOURCE[sourceId];
            if (!layerId) return `${sourceId}:static`;
            const metric = state.streamMetrics[layerId];
            if (metric?.status === 'connecting') pending.push(sourceId);
            return [
                sourceId,
                metric?.status ?? 'unknown',
                metric?.count ?? 0,
                metric?.speed ?? '',
                metric?.note ?? '',
            ].join(':');
        });
        return `${parts.join('|')}\n${pending.join(',')}`;
    });
    const [metricsKey, pendingSourceIdsRaw = ''] = metricsSignal.split('\n');
    const pendingSourceLabels = useMemo(
        () => pendingSourceIdsRaw
            .split(',')
            .filter(Boolean)
            .map((sourceId) => AI_CONTEXT_SOURCE_LABEL[sourceId as AIContextSourceId] ?? sourceId),
        [pendingSourceIdsRaw],
    );

    const [result, setResult] = useState<AIContextLookupResult>(EMPTY_INACTIVE);
    const [cameraSettling, setCameraSettling] = useState(false);

    const recompute = useCallback(() => {
        if (!isActive || !viewer || viewer.isDestroyed()) {
            setResult(EMPTY_INACTIVE);
            return;
        }

        const center = computeContextCenter(viewer, searchCenter);
        if (!center) {
            setResult({
                status: 'noTarget',
                center: null,
                candidates: [],
                selected: [],
                effectiveMax,
                snapshot: null,
                refreshing: false,
                pendingSourceLabels: [],
            });
            return;
        }

        const candidates: AIContextObject[] = [];
        for (const sourceId of sources) {
            for (const candidate of getAIContextCandidates(sourceId)) {
                const distanceM = haversineMeters(center.lat, center.lng, candidate.lat, candidate.lng);
                if (distanceM > radiusM) continue;
                candidates.push(withDistance(candidate, distanceM));
            }
        }
        candidates.sort((a, b) => a.distanceM - b.distanceM);

        const excludedCount = candidates.filter((candidate) => excludedForPreset[candidate.id]).length;
        const selected = candidates
            .filter((candidate) => !excludedForPreset[candidate.id])
            .slice(0, effectiveMax);

        const snapshot: AIContextSnapshot | null = center
            ? {
                  mode: contextMode,
                  center,
                  searchCenter,
                  radiusM,
                  selected,
                  candidatesCount: candidates.length,
                  excludedCount,
                  generatedAt: new Date().toISOString(),
              }
            : null;

        setResult({
            status: candidates.length > 0 ? 'ok' : 'empty',
            center,
            candidates,
            selected,
            effectiveMax,
            snapshot,
            refreshing: false,
            pendingSourceLabels: [],
        });

        const seenExcluded = candidates
            .filter((candidate) => excludedForPreset[candidate.id])
            .map((candidate) => ({ id: candidate.id, sourceId: candidate.sourceId }));
        if (seenExcluded.length > 0) bumpSeen(preset.id, seenExcluded);
    }, [
        isActive,
        viewer,
        searchCenter,
        radiusM,
        effectiveMax,
        contextMode,
        preset.id,
        excludedForPreset,
        bumpSeen,
        sources,
    ]);

    useEffect(() => {
        if (!isActive || !viewer || viewer.isDestroyed()) {
            setResult(EMPTY_INACTIVE);
            return;
        }

        recompute();

        let timer: ReturnType<typeof setTimeout> | null = null;
        const onCameraChanged = () => {
            setCameraSettling(true);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                recompute();
            }, RECOMPUTE_DEBOUNCE_MS);
        };
        const onMoveEnd = () => {
            recompute();
            if (pendingSourceLabels.length === 0) setCameraSettling(false);
        };
        const onExternalRefresh = (event: Event) => {
            const reason = String((event as CustomEvent).detail?.reason ?? '');
            if (reason.endsWith('start')) setCameraSettling(true);
            recompute();
            if (!reason.endsWith('start') && pendingSourceLabels.length === 0) {
                setCameraSettling(false);
            }
        };

        const removeChanged = viewer.camera.changed.addEventListener(onCameraChanged);
        const removeMoveEnd = viewer.camera.moveEnd.addEventListener(onMoveEnd);
        document.addEventListener('openspy:ai-context-refresh', onExternalRefresh);
        return () => {
            removeChanged?.();
            removeMoveEnd?.();
            document.removeEventListener('openspy:ai-context-refresh', onExternalRefresh);
            if (timer) clearTimeout(timer);
        };
    }, [isActive, viewer, recompute, pendingSourceLabels.length]);

    useEffect(() => {
        if (!isActive || !viewer || viewer.isDestroyed()) return;
        recompute();
        if (pendingSourceLabels.length === 0) setCameraSettling(false);
    }, [isActive, viewer, recompute, metricsKey, pendingSourceLabels.length]);

    return {
        ...result,
        refreshing: isActive && (cameraSettling || pendingSourceLabels.length > 0),
        pendingSourceLabels,
    };
}

function withDistance(candidate: AIContextCandidate, distanceM: number): AIContextObject {
    return {
        ...candidate,
        distanceM,
    };
}

function computeContextCenter(
    viewer: Cesium.Viewer,
    mode: AIContextSearchCenter,
): { lat: number; lng: number } | null {
    if (mode === 'cameraPosition') {
        return cameraLonLat(viewer);
    }

    const canvas = viewer.canvas;
    const screen = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);

    let pickCart: Cesium.Cartesian3 | undefined;
    try {
        if (viewer.scene.pickPositionSupported) {
            pickCart = viewer.scene.pickPosition(screen);
        }
    } catch {
        pickCart = undefined;
    }

    if (!pickCart) {
        const ray = viewer.camera.getPickRay(screen);
        if (ray) {
            pickCart = viewer.scene.globe.pick(ray, viewer.scene);
        }
    }

    if (!pickCart) return cameraLonLat(viewer);

    const cart = Cesium.Cartographic.fromCartesian(pickCart);
    return {
        lat: Cesium.Math.toDegrees(cart.latitude),
        lng: Cesium.Math.toDegrees(cart.longitude),
    };
}

function cameraLonLat(viewer: Cesium.Viewer): { lat: number; lng: number } {
    const cart = viewer.camera.positionCartographic;
    return {
        lat: Cesium.Math.toDegrees(cart.latitude),
        lng: Cesium.Math.toDegrees(cart.longitude),
    };
}
