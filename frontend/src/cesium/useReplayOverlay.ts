import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { useTimelineStore, type LayerName } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { perfLog } from '../lib/perf-log';
import { withSpan } from '../lib/otel';
import { safeCartesianFromDegrees } from './position-utils';
import { COMPOSITE_LAYER_SOURCES, getLayerSourceVisibilityKey, normalizeLayerSourceId, type CompositeLayerCode } from '../lib/source-visibility';
import { ReplayShapeBatch, type ReplayShapeDescriptor } from './replayShapeBatch';
import { createSatellitePositionsSAB, type SatellitePositionsSAB } from './satellitePositionsSAB';
import { applyFastBillboardPosition, clearSatelliteApplySource, setSatelliteApplySource, type SatelliteApplySlot } from './satelliteApplyManager';
import { useReplayTrailsOverlay } from './useReplayTrailsOverlay';
import { satelliteFootprintMetaMap, type SatelliteFootprintMeta } from './useSatellitesLayer';
import { ReplayRenderBatchManager, replayRenderBatchMetaMap, type ReplayRenderBatchFootprint, type ReplayRenderBatchMotionTrack } from './replayRenderBatch';
import { applyBillboardScreenSpaceHeading, createBillboardScreenHeadingScratch, headingFallbackRotation, screenSpaceRotationForHeading } from './billboardScreenHeading';
import {
    canReplayPointDelta,
    canReplayPointDeltaBeforeFullSync,
    canReuseStaticReplayBucket,
    fillColorForStyle,
    getReplayApplyChunkSize,
    getReplayHydrationStage,
    getReplayLayerBucketSeconds,
    getReplayMotionModel,
    getReplayMotionTrackRefreshSeconds,
    getReplayPlaybackPriority,
    getReplayPlaybackRefreshSeconds,
    getReplaySeekPriority,
    isReplayCriticalDeltaLayer,
    isReplayMotionLayer,
    isReplayMovingFixLayer,
    isReplayRenderBatchLayer,
    listReplayStoreLayerBindings,
    pointIconForStyle,
    pointOpacityForStyle,
    pointScaleForStyle,
    shouldRunReplayHydrationInParallel,
    styleLikeForReplayFeature,
    strokeColorForStyle,
    toHudLayerName,
} from './renderStyleRegistry';

type ReplayEntity = {
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    entity_kind: string;
    subtype: string | null;
    display_name: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    updated_at: string;
    entity_observed_at: string | null;
    entity_properties: any;
    position_observed_at: string | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    altitude_m: number | null;
    heading_deg: number | null;
    speed_mps: number | null;
    position_properties: any;
};

type ReplayEvent = {
    event_id: string;
    layer_id: string;
    source_id: string | null;
    event_kind: string;
    subtype: string | null;
    observed_at: string | null;
    valid_from: string | null;
    valid_to: string | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: any;
};

type ReplayAsset = {
    asset_id: string;
    layer_id: string;
    source_id: string | null;
    asset_kind: string;
    subtype: string | null;
    display_name: string | null;
    observed_at: string | null;
    geometry: any;
    display_lat: number | null;
    display_lng: number | null;
    properties: any;
};

type ReplayMotionSampleRaw = {
    atMs: number;
    lat: number;
    lng: number;
    alt: number;
};

type ReplayStateResponse = {
    at: string;
    entities: ReplayEntity[];
    events: ReplayEvent[];
    assets: ReplayAsset[];
    // Full ordered trajectory per entity for the current window. The motion
    // worker does a binary search on atMs for each motion-tick, so cadence
    // refreshes only need to fire when the window shifts — not for every
    // sample boundary. A typical aircraft tile bucket (10 min) carries
    // ~10–20 samples per entity, so this stays well under 1 MB per fleet.
    motionSamples?: Map<string, ReplayMotionSampleRaw[]>;
};

type ReplaySatelliteTleItem = {
    entity_id: string;
    layer_id: string;
    source_id: string | null;
    entity_kind: string;
    subtype: string | null;
    display_name: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    updated_at: string;
    entity_observed_at: string | null;
    entity_properties: any;
    orbital_observed_at: string | null;
    tle_line1: string | null;
    tle_line2: string | null;
    orbital_properties: any;
};

type ReplayFootprintState = {
    satId: string;
    ellipseEntity: Cesium.Entity;
    rayEntities: Cesium.Entity[];
    radiusMeters: number;
};

type ReplayFootprintConfig = {
    satId: string;
    footprintId: string;
    radiusMeters: number;
    baseColor: Cesium.Color;
    meta: SatelliteFootprintMeta;
};

type ReplayMotionSample = {
    atMs: number;
    position: [number, number, number];
};

// Full trajectory for one moving entity inside the current replay window,
// samples ordered by atMs ascending and unique per atMs. Storing the full
// sample list (vs. only previous/next) lets the motion worker interpolate
// the correct pair for any atMs via binary search — so aircraft/vessel
// keep moving at any playback speed even when cadence refreshes are
// infrequent (aircraft cadence is 90 virtual s).
type ReplayMotionTrack = {
    samples: ReplayMotionSample[];
};

type ReplayRuntimePerf = {
    queuedItems: number;
    lastDrainOps: number;
    lastDrainMs: number;
    droppedDrainPasses: number;
    maxObservedQueue: number;
    shapeRebuildCount: number;
    shapeEntityAddCount: number;
    shapeKindFallbackRebuildCount: number;
    polygonEntityAddCount: number;
    polylineEntityAddCount: number;
    polygonInPlaceMutationCount: number;
    polylineInPlaceMutationCount: number;
    shapeSignatureSkipCount: number;
    error: string | null;
};

type ReplayPointDeltaRun = {
    count: number;
    firstSinceMs: number;
};

export type ReplayMeta = {
    id: string;
    name: string;
    layer: string;
    layerId: string;
    subtype?: string | null;
    source?: string | null;
    lat: number;
    lng: number;
    alt: number;
    speed?: number | null;
    heading?: number | null;
    description?: string;
    extra?: Record<string, any>;
};

export const replayMetaMap = new Map<string, ReplayMeta>();

declare global {
    interface Window {
        __openspyReplayStats?: {
            pointCount: number;
            shapeCount: number;
            layerCounts: Record<string, number>;
            lastAppliedTime: string | null;
            lastAppliedSeekVersion: number;
            lastVisibleTime: string | null;
            lastVisibleSeekVersion: number;
            cancelVersion: number;
            layersKey: string;
            busy: boolean;
            pending: boolean;
            layerTimes: Record<string, string>;
            bufferedLayerTimes: Record<string, string>;
            motionApplySlots: number;
            motionEpochMs: number | null;
            motionLastAppliedEpochMs: number | null;
            motionApplyCursor: number;
            queueLength: number;
            lastDrainOps: number;
            lastDrainMs: number;
            droppedDrainPasses: number;
            maxObservedQueue: number;
            shapeRebuildCount: number;
            shapeEntityAddCount: number;
            shapeKindFallbackRebuildCount: number;
            polygonEntityAddCount: number;
            polylineEntityAddCount: number;
            polygonInPlaceMutationCount: number;
            polylineInPlaceMutationCount: number;
            shapeSignatureSkipCount: number;
            error: string | null;
            degraded: Record<string, Record<string, number | string | boolean>>;
            samples: ReplayMeta[];
        };
        __openspyReplayMetaLookup?: (id: string) => ReplayMeta | null;
    }
}

const REPLAY_LAYER_BINDINGS = listReplayStoreLayerBindings()
    .map((binding) => ({
        storeKey: binding.storeKey as LayerName,
        layerId: binding.layerId,
    }));
const REPLAY_CANONICAL_STORE_KEYS = REPLAY_LAYER_BINDINGS.map((binding) => binding.storeKey);
const REPLAY_LAYER_BY_STORE_KEY = new Map<LayerName, string>(
    REPLAY_LAYER_BINDINGS.map((binding) => [binding.storeKey, binding.layerId]),
);
const REPLAY_STORE_KEY_BY_LAYER = new Map<string, LayerName>(
    REPLAY_LAYER_BINDINGS.map((binding) => [binding.layerId, binding.storeKey]),
);
const REPLAY_MOTION_APPLY_BUDGET_MS = 4;
const REPLAY_MOTION_APPLY_CHECK_INTERVAL = 32;
const REPLAY_AIRCRAFT_SCREEN_ROTATION_INTERVAL_MS = 50;
const REPLAY_FOOTPRINT_UPDATE_MS = 250;
const REPLAY_FOOTPRINT_RAY_COUNT = 8;
const REPLAY_POINT_DELTA_FULL_SYNC_EVERY = 10;
const REPLAY_POINT_DELTA_MAX_SPAN_MS = 5 * 60 * 1000;

function fingerprintStrings(values: readonly string[]): string {
    let hash = 0x811c9dc5;
    let count = 0;
    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
        const value = values[valueIndex];
        count += 1;
        const str = String(value || '');
        for (let i = 0; i < str.length; i += 1) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
    }
    return `${count}:${hash.toString(16)}`;
}

function toStoreLayerKey(layerId: string): LayerName | null {
    return REPLAY_STORE_KEY_BY_LAYER.get(layerId) || null;
}

function normalizeReplayId(id: string): string {
    return id.startsWith('sat-') ? id.replace(/^sat-/, 'satellite:') : id;
}

function styleLikeForReplayItem(item: any): { subtype?: string | null; variant?: string | null } {
    return styleLikeForReplayFeature(String(item?.layer_id || ''), item);
}

function isPointGeometry(geometry: any): boolean {
    return geometry?.type === 'Point' && Array.isArray(geometry?.coordinates) && geometry.coordinates.length >= 2;
}

function toPolylinePositions(geometry: any): Cesium.Cartesian3[] {
    if (geometry?.type === 'LineString') {
        return (geometry.coordinates || [])
            .map((coord: number[]) => safeCartesianFromDegrees(coord[0], coord[1], Number(coord[2] || 0)))
            .filter((value: Cesium.Cartesian3 | null): value is Cesium.Cartesian3 => Boolean(value));
    }
    return [];
}

function toPolygonHierarchy(geometry: any): Cesium.PolygonHierarchy | null {
    if (geometry?.type !== 'Polygon' || !Array.isArray(geometry?.coordinates?.[0])) return null;
    const [outer, ...holes] = geometry.coordinates;
    const outerPositions = outer
        .map((coord: number[]) => safeCartesianFromDegrees(coord[0], coord[1], Number(coord[2] || 0)))
        .filter((value: Cesium.Cartesian3 | null): value is Cesium.Cartesian3 => Boolean(value));
    if (outerPositions.length < 3) return null;
    const holeHierarchies = holes
        .map((ring: number[][]) =>
            ring
                .map((coord: number[]) => safeCartesianFromDegrees(coord[0], coord[1], Number(coord[2] || 0)))
                .filter((value: Cesium.Cartesian3 | null): value is Cesium.Cartesian3 => Boolean(value)),
        )
        .filter((positions: Cesium.Cartesian3[]) => positions.length >= 3)
        .map((positions: Cesium.Cartesian3[]) => new Cesium.PolygonHierarchy(positions));
    return new Cesium.PolygonHierarchy(outerPositions, holeHierarchies);
}

function deriveReplayMeta(
    item: ReplayEntity | ReplayEvent | ReplayAsset,
    targetId: string,
    previousMeta?: ReplayMeta | null,
): ReplayMeta | null {
    const lat = Number(item.display_lat);
    const lng = Number(item.display_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const layerName = toHudLayerName(item.layer_id);
    const rawProps = 'entity_properties' in item
        ? (item.entity_properties || item.position_properties || null)
        : (item.properties || null);
    const props = rawProps && typeof rawProps === 'object'
        ? rawProps
        : (previousMeta?.extra || {});
    const displayName = ('display_name' in item && item.display_name)
        || props.callsign
        || props.name
        || previousMeta?.name
        || targetId;
    const speed = 'speed_mps' in item
        ? (item.speed_mps ?? previousMeta?.speed ?? undefined)
        : (previousMeta?.speed ?? undefined);
    const heading = 'heading_deg' in item
        ? (item.heading_deg ?? previousMeta?.heading ?? undefined)
        : (previousMeta?.heading ?? undefined);

    return {
        id: targetId,
        name: displayName,
        layer: layerName,
        layerId: item.layer_id,
        subtype: item.subtype,
        source: item.source_id || previousMeta?.source || null,
        lat,
        lng,
        alt: Number(('altitude_m' in item ? item.altitude_m : 0) || 0),
        speed,
        heading,
        description: props.description || props.notes || props.summary || props.event_type || previousMeta?.description || undefined,
        extra: props,
    };
}

function getReplayDisplayName(item: ReplayEvent | ReplayAsset, fallbackId: string): string {
    if (item.layer_id === 'fire' && item.properties?.aggregated) {
        const count = Number(item.properties?.count || 0);
        return count > 0 ? `Fire Cluster (${count})` : 'Fire Cluster';
    }
    if ('display_name' in item && typeof item.display_name === 'string' && item.display_name.length > 0) {
        return item.display_name;
    }
    const props = item.properties || {};
    return props.name || props.title || props.summary || fallbackId;
}

export function useReplayOverlay(viewer: Cesium.Viewer | null) {
    const mode = useTimelineStore((s) => s.mode);
    const playbackKind = useTimelineStore((s) => s.playbackKind);
    const replaySeekVersion = useTimelineStore((s) => s.replaySeekVersion);
    const showTrajectories = useTimelineStore((s) => s.showTrajectories);
    const setReplayHydrating = useTimelineStore((s) => s.setReplayHydrating);
    const sources = useTimelineStore((s) => s.sources);
    const visibility = useTimelineStore((s) => s.visibility);
    const subtypeVisibility = useTimelineStore((s) => s.subtypeVisibility);
    const sourceVisibility = useTimelineStore((s) => s.sourceVisibility);
    const appliedSelections = useTimelineStore((s) => s.appliedSelections);
    const isolatedEntityId = useTimelineStore((s) => s.isolatedEntityId);
    const agentReplayFocusIds = useTimelineStore((s) => s.agentReplayFocusIds);
    const clusteringEnabled = useTimelineStore((s) => s.clusteringEnabled);

    const pointCollectionRef = useRef<Cesium.BillboardCollection | null>(null);
    const pointMapRef = useRef<Map<string, Cesium.Billboard>>(new Map());
    const renderBatchPointMapRef = useRef<Map<string, Cesium.Billboard>>(new Map());
    const pointRotationScratchRef = useRef(createBillboardScreenHeadingScratch());
    const pointSignatureRef = useRef<Map<string, string>>(new Map());
    const shapeBatchRef = useRef<Map<string, ReplayShapeBatch>>(new Map());
    const renderBatchManagerRef = useRef<ReplayRenderBatchManager | null>(null);
    const shapeMapRef = useRef<Map<string, string[]>>(new Map());
    const targetLayerMapRef = useRef<Map<string, string>>(new Map());
    const layerCountsRef = useRef<Map<string, number>>(new Map());
    const motionTrackMapRef = useRef<Map<string, ReplayMotionTrack>>(new Map());
    const renderBatchMotionTracksByLayerRef = useRef<Map<string, ReplayRenderBatchMotionTrack[]>>(new Map());
    // Per-entity high-water-mark for motion apply (atMs of the state
    // that wrote the current track). Prevents a slow earlier apply
    // from clobbering a fast later apply's fresher track.
    const motionTrackAppliedAtRef = useRef<Map<string, number>>(new Map());
    const replaySatelliteWorkerRef = useRef<Worker | null>(null);
    const replaySatelliteSabRef = useRef<SatellitePositionsSAB | null>(null);
    const replaySatelliteApplySlotsRef = useRef<SatelliteApplySlot[]>([]);
    const replaySatelliteLastTickAtRef = useRef(0);
    const replaySatelliteLastEpochMsRef = useRef<number | null>(null);
    const replaySatelliteItemsRef = useRef<ReplaySatelliteTleItem[]>([]);
    const replayFootprintDsRef = useRef<Cesium.CustomDataSource | null>(null);
    const replayFootprintStatesRef = useRef<Map<string, ReplayFootprintState>>(new Map());
    const replayFootprintConfigsRef = useRef<ReplayFootprintConfig[]>([]);
    const replayFootprintMetaIdsRef = useRef<Set<string>>(new Set());
    const replayFootprintLastUpdateMsRef = useRef(0);
    const replayRenderBatchFootprintsRef = useRef<ReplayRenderBatchFootprint[]>([]);
    const replayMotionSabRef = useRef<SatellitePositionsSAB | null>(null);
    const replayMotionApplySlotsRef = useRef<SatelliteApplySlot[]>([]);
    // Per-entity slot cache. We reuse the same SatelliteApplySlot object
    // (including its Cartesian3 + Cartographic scratches) across cadence
    // reloads instead of throwing them away and minting fresh ones. Over a
    // 33k-fleet replay window that used to be ~200k scratch objects per
    // reload — now it's zero on the steady path.
    const replayMotionSlotByEntityRef = useRef<Map<string, SatelliteApplySlot>>(new Map());
    const replayMotionLastEpochMsRef = useRef<number | null>(null);
    const replayMotionLastAppliedEpochMsRef = useRef<number | null>(null);
    const replayMotionApplyingEpochMsRef = useRef<number | null>(null);
    const replayMotionApplyCursorRef = useRef(0);
    const replayMotionGenerationRef = useRef(0);
    const replayMotionFullSyncAtRef = useRef<Map<string, number>>(new Map());
    const lastAppliedTimeRef = useRef<string | null>(null);
    const lastAppliedSeekVersionRef = useRef<number>(useTimelineStore.getState().replaySeekVersion);
    const lastVisibleTimeRef = useRef<string | null>(null);
    const lastVisibleSeekVersionRef = useRef<number>(0);
    const lastAppliedLayerTimeRef = useRef<Map<string, string>>(new Map());
    const lastBufferedLayerTimeRef = useRef<Map<string, string>>(new Map());
    const pointDeltaRunRef = useRef<Map<string, ReplayPointDeltaRun>>(new Map());
    const replayErrorRef = useRef<string | null>(null);
    const replayDegradedRef = useRef<Record<string, Record<string, number | string | boolean>>>({});
    const runtimePerfRef = useRef<ReplayRuntimePerf>({
        queuedItems: 0,
        lastDrainOps: 0,
        lastDrainMs: 0,
        droppedDrainPasses: 0,
        maxObservedQueue: 0,
        shapeRebuildCount: 0,
        shapeEntityAddCount: 0,
        shapeKindFallbackRebuildCount: 0,
        polygonEntityAddCount: 0,
        polylineEntityAddCount: 0,
        polygonInPlaceMutationCount: 0,
        polylineInPlaceMutationCount: 0,
        shapeSignatureSkipCount: 0,
        error: null,
    });
    const layersKeyRef = useRef<string>('');
    const seekRequestRef = useRef<{ targetMs: number; reason: 'user-seek' | 'mode-change' | 'layers-change' | 'time-change' | 'viewport-change' } | null>(null);
    const replayBusyRef = useRef(false);
    const replayPendingRef = useRef(false);
    const playbackRefreshBusyLayersRef = useRef<Set<string>>(new Set());
    const replayCancelVersionRef = useRef(0);
    const replayOperationIdRef = useRef(0);
    const replayWarmPrimeKeyRef = useRef<string | null>(null);
    const replayWarmPrimePromiseRef = useRef<Promise<void> | null>(null);
    // In-flight detached hydration tasks (warm-prime, deferred). Counter
    // increments on task start, decrements on end/cancel/error. Codex
    // round-6 (2026-04-21) showed playbackRefresh starting on top of
    // still-running hydration → duplicate pipeline/airspace work and
    // multi-second frame_render spikes. Now playbackRefresh waits until
    // the counter is zero.
    const replayHydrationInflightRef = useRef(0);
    const [replayDrainVersion, setReplayDrainVersion] = useState(0);
    const replayViewportKeyRef = useRef<string>('');
    const [replayViewportVersion, setReplayViewportVersion] = useState(0);

    const replaySnapshotHasVisibleContent = () => {
        const totals = renderBatchManagerRef.current?.getTotals();
        if (totals && (totals.features > 0 || totals.points > 0 || totals.shapes > 0)) return true;
        return pointMapRef.current.size > 0 || shapeMapRef.current.size > 0;
    };

    const activeReplayLayers = useMemo(() => {
        return REPLAY_CANONICAL_STORE_KEYS
            .filter((storeKey) => sources[storeKey] && visibility[storeKey])
            .map((storeKey) => REPLAY_LAYER_BY_STORE_KEY.get(storeKey))
            .filter((layerId): layerId is string => Boolean(layerId));
    }, [sources, visibility]);

    const appliedSelectionSets = useMemo(() => {
        const result: Record<string, { mode: string; ids: Set<string>; truncated: boolean; fingerprint: string }> = {};
        for (const [layer, selection] of Object.entries(appliedSelections || {})) {
            const ids = Array.isArray(selection?.itemIds)
                ? selection.itemIds.map((id) => normalizeReplayId(String(id))).filter(Boolean)
                : [];
            const mode = String(selection?.mode || 'only');
            const itemCount = Number(selection?.itemCount ?? ids.length);
            const status = String(selection?.materializationStatus || '').toLowerCase();
            const knownEmptyOnlySelection = mode !== 'exclude'
                && ids.length === 0
                && (
                    selection?.truncated === false
                    || itemCount === 0
                    || status === 'empty'
                    || status === 'materialized'
                );
            if (!selection?.selectionId || (ids.length === 0 && !knownEmptyOnlySelection)) continue;
            result[layer] = {
                mode,
                ids: new Set(ids),
                truncated: Boolean(selection.truncated),
                fingerprint: typeof selection?.itemFingerprint === 'string' && selection.itemFingerprint
                    ? selection.itemFingerprint
                    : fingerprintStrings(ids),
            };
        }
        return result;
    }, [appliedSelections]);

    const appliedSelectionForLayer = (layerId: string) => {
        const storeLayer = toStoreLayerKey(layerId);
        return appliedSelectionSets[layerId] || (storeLayer ? appliedSelectionSets[storeLayer] : undefined) || null;
    };

    const appliedSelectionKey = useMemo(() => Object.entries(appliedSelectionSets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([layer, selection]) => {
            return `${layer}:${selection.mode}:${selection.truncated ? 1 : 0}:${selection.fingerprint}`;
        })
        .join('|'), [appliedSelectionSets]);
    const subtypeVisibilityKey = useMemo(() => Object.entries(subtypeVisibility || {})
        .filter(([, enabled]) => enabled === false)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key]) => key)
        .join('|'), [subtypeVisibility]);
    const sourceVisibilityKey = useMemo(() => Object.entries(sourceVisibility || {})
        .filter(([, enabled]) => enabled === false)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key]) => key)
        .join('|'), [sourceVisibility]);
    const agentReplayFocusSet = useMemo(() => new Set(
        (agentReplayFocusIds || []).map((id) => normalizeReplayId(String(id))).filter(Boolean),
    ), [agentReplayFocusIds]);
    const agentReplayFocusKey = useMemo(() => Array.from(agentReplayFocusSet).sort().join(','), [agentReplayFocusSet]);

    const layersKey = [
        `layers:${activeReplayLayers.join(',')}`,
        `fireCluster:${clusteringEnabled ? 1 : 0}`,
        `sel:${appliedSelectionKey}`,
        `sub:${subtypeVisibilityKey}`,
        `src:${sourceVisibilityKey}`,
        `iso:${isolatedEntityId ? normalizeReplayId(isolatedEntityId) : ''}`,
        `focus:${agentReplayFocusKey}`,
    ].join('|');
    const requestSceneRender = () => {
        if (!viewer || viewer.isDestroyed()) return;
        viewer.scene.requestRender();
    };
    const setReplayError = (message: string | null) => {
        replayErrorRef.current = message;
        runtimePerfRef.current.error = message;
        publishReplayStats();
    };

    const setReplayLayerDegraded = (layerId: string, degraded: Record<string, number | string | boolean> | null | undefined) => {
        if (degraded && Object.keys(degraded).length > 0) {
            replayDegradedRef.current = {
                ...replayDegradedRef.current,
                [layerId]: degraded,
            };
        } else if (replayDegradedRef.current[layerId]) {
            const next = { ...replayDegradedRef.current };
            delete next[layerId];
            replayDegradedRef.current = next;
        }
        publishReplayStats();
    };

    const deleteReplayFootprintMeta = () => {
        replayFootprintMetaIdsRef.current.forEach((id) => satelliteFootprintMetaMap.delete(id));
        replayFootprintMetaIdsRef.current.clear();
    };

    const clearReplayFootprints = () => {
        deleteReplayFootprintMeta();
        replayFootprintStatesRef.current.clear();
        replayFootprintConfigsRef.current = [];
        replayFootprintLastUpdateMsRef.current = 0;
        const ds = replayFootprintDsRef.current;
        if (ds && viewer && !viewer.isDestroyed()) {
            viewer.dataSources.remove(ds);
        }
        replayFootprintDsRef.current = null;
    };

    const getReplayFootprintVisible = () => {
        const state = useTimelineStore.getState();
        return state.mode === 'playback'
            && state.playbackKind === 'historical'
            && state.sources.satelliteFootprints
            && state.visibility.satelliteFootprints;
    };

    const getReplaySatelliteSensor = (item: ReplaySatelliteTleItem) => {
        const entityProps = item.entity_properties && typeof item.entity_properties === 'object' ? item.entity_properties : {};
        const orbitalProps = item.orbital_properties && typeof item.orbital_properties === 'object' ? item.orbital_properties : {};
        const sensor = entityProps.sensor || orbitalProps.sensor || entityProps.reconMeta?.sensor || orbitalProps.reconMeta?.sensor;
        if (!sensor || typeof sensor !== 'object') return null;
        const swathMeters = Number(sensor.swathMeters ?? sensor.sensorSwathMeters ?? sensor.swath_meters ?? sensor.swath);
        if (!Number.isFinite(swathMeters) || swathMeters <= 0) return null;
        const rawType = String(sensor.sensorType || sensor.type || '').toUpperCase();
        const sensorType: SatelliteFootprintMeta['sensorType'] = rawType === 'OPTICAL' || rawType === 'SAR' ? rawType : 'OTHER';
        return {
            sensorName: String(sensor.sensorName || sensor.name || ''),
            sensorType,
            swathMeters,
            source: String(sensor.source || 'spectator-earth'),
        };
    };

    const getReplaySatelliteColor = (subtype: string | null | undefined) => {
        if (subtype === 'military' || subtype === 'recon') return Cesium.Color.RED;
        if (subtype === 'commercial') return Cesium.Color.CYAN;
        return Cesium.Color.LIME;
    };

    const setReplayFootprintMeta = (id: string, meta: SatelliteFootprintMeta) => {
        satelliteFootprintMetaMap.set(id, meta);
        replayFootprintMetaIdsRef.current.add(id);
    };

    const buildReplayFootprints = (items: ReplaySatelliteTleItem[]) => {
        clearReplayFootprints();
        if (!viewer || viewer.isDestroyed()) return;
        replaySatelliteItemsRef.current = items;
        if (!useTimelineStore.getState().sources.satelliteFootprints) return;
        const configs: ReplayFootprintConfig[] = [];
        for (const item of items) {
            const sensor = getReplaySatelliteSensor(item);
            if (!sensor) continue;
            const normalizedTargetId = normalizeReplayId(item.entity_id);
            const safeId = normalizedTargetId.replace(/[^a-zA-Z0-9_-]+/g, '-');
            const subtype = item.subtype || 'civilian';
            configs.push({
                satId: item.entity_id,
                footprintId: `fp-sat-replay-${safeId}`,
                radiusMeters: sensor.swathMeters / 2,
                baseColor: getReplaySatelliteColor(subtype),
                meta: {
                    parentSatId: item.entity_id,
                    satName: item.display_name || normalizedTargetId,
                    subtype,
                    sensorName: sensor.sensorName,
                    sensorType: sensor.sensorType,
                    swathMeters: sensor.swathMeters,
                    source: sensor.source,
                },
            });
        }
        if (configs.length === 0) return;
        const ds = new Cesium.CustomDataSource('replay-sat-footprints');
        ds.show = getReplayFootprintVisible();
        viewer.dataSources.add(ds);
        replayFootprintDsRef.current = ds;
        replayFootprintConfigsRef.current = configs;
        replayFootprintStatesRef.current = new Map();
        updateReplayFootprints(true);
    };

    const buildReplayFootprintsFromRenderBatch = (footprints: ReplayRenderBatchFootprint[]) => {
        clearReplayFootprints();
        if (!viewer || viewer.isDestroyed()) return;
        replaySatelliteItemsRef.current = [];
        if (!useTimelineStore.getState().sources.satelliteFootprints) return;
        const configs: ReplayFootprintConfig[] = footprints.map((fp) => ({
            satId: fp.satId,
            footprintId: fp.footprintId,
            radiusMeters: fp.radiusMeters,
            baseColor: fp.baseColor,
            meta: fp.meta,
        }));
        if (configs.length === 0) return;
        const ds = new Cesium.CustomDataSource('replay-sat-footprints');
        ds.show = getReplayFootprintVisible();
        viewer.dataSources.add(ds);
        replayFootprintDsRef.current = ds;
        replayFootprintConfigsRef.current = configs;
        replayFootprintStatesRef.current = new Map();
        updateReplayFootprints(true);
    };

    function updateReplayFootprints(force = false) {
        const ds = replayFootprintDsRef.current;
        if (!viewer || viewer.isDestroyed() || !ds) return;
        ds.show = getReplayFootprintVisible();
        if (!ds.show) return;
        const nowMs = performance.now();
        if (!force && nowMs - replayFootprintLastUpdateMsRef.current < REPLAY_FOOTPRINT_UPDATE_MS) return;
        replayFootprintLastUpdateMsRef.current = nowMs;

        const states = replayFootprintStatesRef.current;
        const earthRadiusMeters = 6_371_000;
        let updated = false;
        for (const cfg of replayFootprintConfigsRef.current) {
            const sat = pointMapRef.current.get(cfg.satId) || renderBatchPointMapRef.current.get(cfg.satId);
            if (!sat || !sat.show) continue;
            const satPos = sat.position;
            if (!satPos || !Number.isFinite(satPos.x) || !Number.isFinite(satPos.y) || !Number.isFinite(satPos.z)) continue;
            if (Cesium.Cartesian3.equals(satPos, Cesium.Cartesian3.ZERO)) continue;
            const satPosStable = Cesium.Cartesian3.clone(satPos);
            const carto = Cesium.Cartographic.fromCartesian(satPos);
            if (!carto) continue;
            const lat1 = carto.latitude;
            const lon1 = carto.longitude;
            const nadir = Cesium.Cartesian3.fromRadians(lon1, lat1, 0);
            const angDist = cfg.radiusMeters / earthRadiusMeters;
            const sinLat1 = Math.sin(lat1);
            const cosLat1 = Math.cos(lat1);
            const cosAng = Math.cos(angDist);
            const sinAng = Math.sin(angDist);
            let state = states.get(cfg.satId);
            if (!state) {
                const ellipseEntity = ds.entities.add({
                    id: cfg.footprintId,
                    position: new Cesium.ConstantPositionProperty(nadir),
                    ellipse: {
                        semiMinorAxis: cfg.radiusMeters,
                        semiMajorAxis: cfg.radiusMeters,
                        material: new Cesium.ColorMaterialProperty(cfg.baseColor.withAlpha(0.08)),
                        height: 0,
                        outline: true,
                        outlineColor: cfg.baseColor.withAlpha(0.5),
                        outlineWidth: 1,
                    },
                });
                setReplayFootprintMeta(cfg.footprintId, cfg.meta);
                const rayEntities: Cesium.Entity[] = [];
                for (let k = 0; k < REPLAY_FOOTPRINT_RAY_COUNT; k += 1) {
                    const angleRad = (k / REPLAY_FOOTPRINT_RAY_COUNT) * 2 * Math.PI;
                    const lat2 = Math.asin(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(angleRad));
                    const lon2 = lon1 + Math.atan2(
                        Math.sin(angleRad) * sinAng * cosLat1,
                        cosAng - sinLat1 * Math.sin(lat2),
                    );
                    const perimeter = Cesium.Cartesian3.fromRadians(lon2, lat2, 0);
                    const rayId = `beam-sat-replay-${cfg.footprintId.slice('fp-sat-replay-'.length)}#${k}`;
                    const rayEntity = ds.entities.add({
                        id: rayId,
                        polyline: {
                            positions: new Cesium.ConstantProperty([
                                Cesium.Cartesian3.clone(satPosStable),
                                Cesium.Cartesian3.clone(perimeter),
                            ]),
                            width: 1,
                            material: new Cesium.ColorMaterialProperty(cfg.baseColor.withAlpha(0.25)),
                        },
                    });
                    rayEntities.push(rayEntity);
                    setReplayFootprintMeta(rayId, cfg.meta);
                }
                state = {
                    satId: cfg.satId,
                    ellipseEntity,
                    rayEntities,
                    radiusMeters: cfg.radiusMeters,
                };
                states.set(cfg.satId, state);
            }

            const ellipsePos = state.ellipseEntity.position as Cesium.ConstantPositionProperty | undefined;
            if (ellipsePos instanceof Cesium.ConstantPositionProperty) {
                ellipsePos.setValue(nadir);
            } else {
                state.ellipseEntity.position = new Cesium.ConstantPositionProperty(nadir);
            }

            for (let k = 0; k < state.rayEntities.length; k += 1) {
                const angleRad = (k / state.rayEntities.length) * 2 * Math.PI;
                const lat2 = Math.asin(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(angleRad));
                const lon2 = lon1 + Math.atan2(
                    Math.sin(angleRad) * sinAng * cosLat1,
                    cosAng - sinLat1 * Math.sin(lat2),
                );
                const perimeter = Cesium.Cartesian3.fromRadians(lon2, lat2, 0);
                const rayEntity = state.rayEntities[k];
                if (rayEntity.polyline) {
                    const positions = rayEntity.polyline.positions as Cesium.ConstantProperty | undefined;
                    const nextPositions = [
                        Cesium.Cartesian3.clone(satPosStable),
                        Cesium.Cartesian3.clone(perimeter),
                    ];
                    if (positions instanceof Cesium.ConstantProperty) {
                        positions.setValue(nextPositions);
                    } else {
                        rayEntity.polyline.positions = new Cesium.ConstantProperty(nextPositions);
                    }
                }
            }
            updated = true;
        }
        if (updated) requestSceneRender();
    }

    const ensureReplayWorker = () => {
        if (replaySatelliteWorkerRef.current) return replaySatelliteWorkerRef.current;
        const worker = new Worker(new URL('./satellite-worker.ts', import.meta.url));
        worker.onmessage = (event: MessageEvent) => {
            const message = event.data;
            if (message.type === 'ready') {
                return;
            }
            if (message.type === 'positions') {
                if (replaySatelliteSabRef.current) {
                    replaySatelliteSabRef.current.epochMs = Number(message.epochMs) || Date.now();
                }
                replaySatelliteLastEpochMsRef.current = Number(message.epochMs) || null;
                requestSceneRender();
                return;
            }
            if (message.type === 'motion-positions') {
                if ((Number(message.generation) || 0) !== replayMotionGenerationRef.current) return;
                if (replayMotionSabRef.current) {
                    replayMotionSabRef.current.epochMs = Number(message.epochMs) || Date.now();
                }
                replayMotionLastEpochMsRef.current = Number(message.epochMs) || null;
                requestSceneRender();
            }
        };
        replaySatelliteWorkerRef.current = worker;
        return worker;
    };
    const clearReplaySatelliteLayerState = () => {
        if (viewer && !viewer.isDestroyed()) clearSatelliteApplySource(viewer.scene, 'replay');
        clearReplayFootprints();
        replayRenderBatchFootprintsRef.current = [];
        replaySatelliteItemsRef.current = [];
        replaySatelliteSabRef.current = null;
        replaySatelliteApplySlotsRef.current = [];
        replaySatelliteLastTickAtRef.current = 0;
        replaySatelliteLastEpochMsRef.current = null;
    };

    const resetReplayMotionApplyProgress = () => {
        replayMotionApplyingEpochMsRef.current = null;
        replayMotionApplyCursorRef.current = 0;
    };

    const destroyReplaySatelliteWorker = () => {
        if (replaySatelliteWorkerRef.current) {
            replaySatelliteWorkerRef.current.terminate();
            replaySatelliteWorkerRef.current = null;
        }
        clearReplaySatelliteLayerState();
        replayMotionSabRef.current = null;
        replayMotionApplySlotsRef.current = [];
        replayMotionSlotByEntityRef.current.clear();
        renderBatchMotionTracksByLayerRef.current.clear();
        replayMotionLastEpochMsRef.current = null;
        replayMotionLastAppliedEpochMsRef.current = null;
        replayMotionGenerationRef.current += 1;
        resetReplayMotionApplyProgress();
    };
    const waitForRenderTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const updateRuntimeQueueLength = () => {
        runtimePerfRef.current.queuedItems = 0;
    };
    const sameLayerBucket = (layerId: string, leftIso: string, rightIso: string): boolean => {
        const bucketMs = getReplayLayerBucketSeconds(layerId) * 1000;
        const leftMs = new Date(leftIso).getTime();
        const rightMs = new Date(rightIso).getTime();
        if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs) || bucketMs <= 0) return false;
        return Math.floor(leftMs / bucketMs) === Math.floor(rightMs / bucketMs);
    };
    const hasRenderedLayerState = (layerId: string): boolean => {
        const managerCounts = getRenderBatchManager()?.getLayerCounts(layerId);
        if (managerCounts && (managerCounts.features > 0 || managerCounts.points > 0 || managerCounts.shapes > 0)) {
            return true;
        }
        for (const currentLayerId of Array.from(targetLayerMapRef.current.values())) {
            if (currentLayerId === layerId) return true;
        }
        return false;
    };
    const reuseStaticLayerWithinBucket = (layerId: string, atIso: string): boolean => {
        if (!canReuseStaticReplayBucket(layerId)) return false;
        const previousIso = lastAppliedLayerTimeRef.current.get(layerId);
        if (!previousIso || !sameLayerBucket(layerId, previousIso, atIso)) return false;
        if (!hasRenderedLayerState(layerId)) return false;
        lastAppliedLayerTimeRef.current.set(layerId, atIso);
        lastBufferedLayerTimeRef.current.set(layerId, atIso);
        perfLog('replay.static_bucket_reuse', {
            layer: layerId,
            previousIso,
            atIso,
            bucketSeconds: getReplayLayerBucketSeconds(layerId),
        });
        publishReplayStats();
        return true;
    };
    const shouldApplyPointDeltaBeforeFullSync = (layerId: string, atIso: string): boolean => {
        if (!canReplayPointDeltaBeforeFullSync(layerId)) return false;
        const previousIso = lastAppliedLayerTimeRef.current.get(layerId);
        if (!previousIso || previousIso === atIso) return false;
        return hasRenderedLayerState(layerId);
    };
    const publishReplayStats = () => {
        if (typeof window === 'undefined') return;
        const renderTotals = renderBatchManagerRef.current?.getTotals() || {
            features: 0,
            points: 0,
            shapes: 0,
            layerCounts: {} as Record<string, number>,
        };
        const layerCounts = Object.fromEntries(Array.from(layerCountsRef.current.entries()));
        for (const [layerId, count] of Object.entries(renderTotals.layerCounts)) {
            layerCounts[layerId] = (layerCounts[layerId] || 0) + count;
        }
        const samples: ReplayMeta[] = [];
        replayMetaMap.forEach((value) => {
            if (samples.length < 10) samples.push(value);
        });
        replayRenderBatchMetaMap.forEach((value) => {
            if (samples.length < 10) samples.push(value);
        });
        window.__openspyReplayStats = {
            pointCount: pointMapRef.current.size + renderTotals.points,
            shapeCount: shapeMapRef.current.size + renderTotals.shapes,
            layerCounts,
            lastAppliedTime: lastAppliedTimeRef.current,
            lastAppliedSeekVersion: lastAppliedSeekVersionRef.current,
            lastVisibleTime: lastVisibleTimeRef.current,
            lastVisibleSeekVersion: lastVisibleSeekVersionRef.current,
            cancelVersion: replayCancelVersionRef.current,
            layersKey: layersKeyRef.current,
            busy: replayBusyRef.current,
            pending: replayPendingRef.current,
            layerTimes: Object.fromEntries(Array.from(lastAppliedLayerTimeRef.current.entries())),
            bufferedLayerTimes: Object.fromEntries(Array.from(lastBufferedLayerTimeRef.current.entries())),
            motionApplySlots: replayMotionApplySlotsRef.current.length,
            motionEpochMs: replayMotionLastEpochMsRef.current,
            motionLastAppliedEpochMs: replayMotionLastAppliedEpochMsRef.current,
            motionApplyCursor: replayMotionApplyCursorRef.current,
            queueLength: runtimePerfRef.current.queuedItems,
            lastDrainOps: runtimePerfRef.current.lastDrainOps,
            lastDrainMs: runtimePerfRef.current.lastDrainMs,
            droppedDrainPasses: runtimePerfRef.current.droppedDrainPasses,
            maxObservedQueue: runtimePerfRef.current.maxObservedQueue,
            shapeRebuildCount: runtimePerfRef.current.shapeRebuildCount,
            shapeEntityAddCount: runtimePerfRef.current.shapeEntityAddCount,
            shapeKindFallbackRebuildCount: runtimePerfRef.current.shapeKindFallbackRebuildCount,
            polygonEntityAddCount: runtimePerfRef.current.polygonEntityAddCount,
            polylineEntityAddCount: runtimePerfRef.current.polylineEntityAddCount,
            polygonInPlaceMutationCount: runtimePerfRef.current.polygonInPlaceMutationCount,
            polylineInPlaceMutationCount: runtimePerfRef.current.polylineInPlaceMutationCount,
            shapeSignatureSkipCount: runtimePerfRef.current.shapeSignatureSkipCount,
            error: replayErrorRef.current,
            degraded: replayDegradedRef.current,
            samples,
        };
        window.__openspyReplayMetaLookup = (id: string) => replayMetaMap.get(id) || replayRenderBatchMetaMap.get(id) || null;
    };

    const incrementLayerCount = (layerId: string) => {
        layerCountsRef.current.set(layerId, (layerCountsRef.current.get(layerId) || 0) + 1);
    };

    const decrementLayerCount = (layerId: string) => {
        const next = (layerCountsRef.current.get(layerId) || 0) - 1;
        if (next > 0) {
            layerCountsRef.current.set(layerId, next);
        } else {
            layerCountsRef.current.delete(layerId);
        }
    };

    useEffect(() => {
        if (!viewer) return;

        const pointCollection = new Cesium.BillboardCollection({
            scene: viewer.scene,
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        viewer.scene.primitives.add(pointCollection);
        pointCollectionRef.current = pointCollection;
        // Expose for diagnostic scripts
        (window as any).__openspyReplayPoints = pointMapRef.current;
        (window as any).__openspyReplayRenderBatchPoints = renderBatchPointMapRef.current;
        (window as any).__openspyReplayRenderBatchMeta = replayRenderBatchMetaMap;
        (window as any).__openspyReplayLayerOf = targetLayerMapRef.current;

        // Long-task observer: log any task > 100 ms so we can correlate
        // cache-idb / http-done stalls with what is actually blocking the
        // main thread. Uses PerformanceObserver('longtask'). Safari may
        // not support this entry type — wrap in try/catch.
        let longtaskObs: PerformanceObserver | null = null;
        try {
            longtaskObs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.duration < 100) continue;
                    const attrs = (entry as any).attribution?.map((a: any) => ({
                        name: a.name,
                        type: a.entryType,
                        container: a.containerType,
                    })) || [];
                    perfLog('replay.longtask', {
                        startTime: Math.round(entry.startTime),
                        duration: Math.round(entry.duration),
                        name: entry.name,
                        attribution: attrs,
                    });
                }
            });
            longtaskObs.observe({ entryTypes: ['longtask'] });
        } catch (err) {
            console.warn('[ReplayOverlay] longtask observer unavailable:', err);
        }

        // Whole-frame render timing (Codex round-5 step 5).
        // ReplayShapeBatch / Cesium primitive build / suspect.block wrappers
        // measure JS function bodies, but Cesium's async primitive update
        // can extend a render task beyond the wrapper's measure window.
        // preRender→postRender wall time captures everything between.
        let frameStartMs = 0;
        const onPreRender = () => {
            frameStartMs = performance.now();
        };
        const onPostRender = () => {
            if (frameStartMs === 0) return;
            const ms = performance.now() - frameStartMs;
            frameStartMs = 0;
            if (ms > 50) {
                perfLog('replay.frame_render', { ms: Math.round(ms) });
            }
        };
        try {
            viewer.scene.preRender.addEventListener(onPreRender);
            viewer.scene.postRender.addEventListener(onPostRender);
        } catch {}

        return () => {
            try { longtaskObs?.disconnect(); } catch {}
            try {
                if (!viewer.isDestroyed()) {
                    viewer.scene.preRender.removeEventListener(onPreRender);
                    viewer.scene.postRender.removeEventListener(onPostRender);
                }
            } catch {}
            replayMetaMap.clear();
            replayRenderBatchMetaMap.clear();
            pointMapRef.current.clear();
            renderBatchPointMapRef.current.clear();
            pointSignatureRef.current.clear();
            shapeMapRef.current.clear();
            shapeBatchRef.current.forEach((batch) => batch.destroy());
            shapeBatchRef.current.clear();
            renderBatchManagerRef.current?.destroy();
            renderBatchManagerRef.current = null;
            targetLayerMapRef.current.clear();
            layerCountsRef.current.clear();
            motionTrackMapRef.current.clear();
            motionTrackAppliedAtRef.current.clear();
            destroyReplaySatelliteWorker();
            lastAppliedTimeRef.current = null;
            lastAppliedSeekVersionRef.current = useTimelineStore.getState().replaySeekVersion;
            lastVisibleTimeRef.current = null;
            lastVisibleSeekVersionRef.current = 0;
            lastAppliedLayerTimeRef.current.clear();
            lastBufferedLayerTimeRef.current.clear();
            pointDeltaRunRef.current.clear();
            runtimePerfRef.current = {
                queuedItems: 0,
                lastDrainOps: 0,
                lastDrainMs: 0,
                droppedDrainPasses: 0,
                maxObservedQueue: 0,
                shapeRebuildCount: 0,
                shapeEntityAddCount: 0,
                shapeKindFallbackRebuildCount: 0,
                polygonEntityAddCount: 0,
                polylineEntityAddCount: 0,
                polygonInPlaceMutationCount: 0,
                polylineInPlaceMutationCount: 0,
                shapeSignatureSkipCount: 0,
                error: null,
            };
            layersKeyRef.current = '';
            replayBusyRef.current = false;
            replayPendingRef.current = false;
            replayCancelVersionRef.current += 1;
            replayErrorRef.current = null;
            replayDegradedRef.current = {};
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(pointCollection);
            }
            pointCollectionRef.current = null;
        };
    }, [viewer]);

    const clearReplay = () => {
        replayMetaMap.clear();
        replayRenderBatchMetaMap.clear();
        pointMapRef.current.clear();
        renderBatchPointMapRef.current.clear();
        pointSignatureRef.current.clear();
        shapeMapRef.current.clear();
        shapeBatchRef.current.forEach((batch) => batch.destroy());
        shapeBatchRef.current.clear();
        renderBatchManagerRef.current?.clearAll();
        targetLayerMapRef.current.clear();
        layerCountsRef.current.clear();
        motionTrackMapRef.current.clear();
        motionTrackAppliedAtRef.current.clear();
        replayMotionFullSyncAtRef.current.clear();
        destroyReplaySatelliteWorker();
        pointCollectionRef.current?.removeAll();
        lastAppliedLayerTimeRef.current.clear();
        lastBufferedLayerTimeRef.current.clear();
        pointDeltaRunRef.current.clear();
        lastVisibleTimeRef.current = null;
        lastVisibleSeekVersionRef.current = 0;
        runtimePerfRef.current = {
            queuedItems: 0,
            lastDrainOps: 0,
            lastDrainMs: 0,
            droppedDrainPasses: 0,
            maxObservedQueue: 0,
            shapeRebuildCount: 0,
            shapeEntityAddCount: 0,
            shapeKindFallbackRebuildCount: 0,
            polygonEntityAddCount: 0,
            polylineEntityAddCount: 0,
            polygonInPlaceMutationCount: 0,
            polylineInPlaceMutationCount: 0,
            shapeSignatureSkipCount: 0,
            error: null,
        };
        replayErrorRef.current = null;
        replayDegradedRef.current = {};
        publishReplayStats();
    };

    const computeVisible = (targetId: string, layerId: string, subtype: string | null | undefined, sourceId: string | null | undefined) => {
        const normalizedTargetId = normalizeReplayId(targetId);
        const normalizedIsolatedId = isolatedEntityId ? normalizeReplayId(isolatedEntityId) : null;
        if (normalizedIsolatedId && normalizedIsolatedId !== normalizedTargetId) return false;
        const focusedByAgent = agentReplayFocusSet.has(normalizedTargetId);
        const selection = appliedSelectionForLayer(layerId);
        if (selection && !selection.truncated && !focusedByAgent) {
            const selected = selection.ids.has(normalizedTargetId);
            if (selection.mode === 'exclude') {
                if (selected) return false;
            } else if (!selected) {
                return false;
            }
        }
        const storeLayer = toStoreLayerKey(layerId);
        if (!storeLayer) return true;
        if (subtypeVisibility[`${storeLayer}:${subtype || ''}`] === false) return false;
        if (Object.prototype.hasOwnProperty.call(COMPOSITE_LAYER_SOURCES, storeLayer)) {
            const compositeLayer = storeLayer as CompositeLayerCode;
            const normalizedSource = normalizeLayerSourceId(compositeLayer, sourceId);
            if (normalizedSource && sourceVisibility[getLayerSourceVisibilityKey(compositeLayer, normalizedSource)] === false) return false;
        }
        return true;
    };

    const getReplayViewportBbox = (): [number, number, number, number] | undefined => {
        if (!viewer || viewer.isDestroyed()) return undefined;
        const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
        if (!rectangle) return undefined;
        let west = Cesium.Math.toDegrees(rectangle.west);
        let south = Cesium.Math.toDegrees(rectangle.south);
        let east = Cesium.Math.toDegrees(rectangle.east);
        let north = Cesium.Math.toDegrees(rectangle.north);
        if (![west, south, east, north].every(Number.isFinite)) return undefined;
        west = Math.max(-180, Math.min(180, west));
        east = Math.max(-180, Math.min(180, east));
        south = Math.max(-90, Math.min(90, south));
        north = Math.max(-90, Math.min(90, north));
        if (east <= west || north <= south) return undefined;
        if (east - west >= 350 && north - south >= 170) return undefined;
        return [west, south, east, north];
    };

    const getReplayViewportKey = (): string => {
        const bbox = getReplayViewportBbox();
        return bbox ? bbox.map((value) => value.toFixed(3)).join(',') : 'global';
    };

    const invalidateReplayViewportScopedLayers = () => {
        for (const layerId of activeReplayLayers) {
            if (!isReplayRenderBatchLayer(layerId)) continue;
            lastAppliedLayerTimeRef.current.delete(layerId);
            lastBufferedLayerTimeRef.current.delete(layerId);
            pointDeltaRunRef.current.delete(layerId);
        }
    };

    const getRenderBatchManager = () => {
        if (!viewer || viewer.isDestroyed()) return null;
        if (!renderBatchManagerRef.current) {
            renderBatchManagerRef.current = new ReplayRenderBatchManager({
                scene: viewer.scene,
                apiUrl: API_URL,
                resolveVisible: computeVisible,
                onPointAdd: (id, billboard) => {
                    renderBatchPointMapRef.current.set(id, billboard);
                },
                onPointRemove: (id) => {
                    renderBatchPointMapRef.current.delete(id);
                },
            });
        } else {
            renderBatchManagerRef.current.setVisibilityResolver(computeVisible);
        }
        return renderBatchManagerRef.current;
    };

    const getShapeBatch = (layerId: string) => {
        let batch = shapeBatchRef.current.get(layerId);
        if (!batch && viewer && !viewer.isDestroyed()) {
            batch = new ReplayShapeBatch({
                scene: viewer.scene,
                layerKey: layerId,
                onRebuild: () => {
                    runtimePerfRef.current.shapeRebuildCount += 1;
                },
            });
            shapeBatchRef.current.set(layerId, batch);
        }
        return batch ?? null;
    };

    const removeTarget = (targetId: string, suppressStats = false) => {
        const point = pointMapRef.current.get(targetId);
        if (point && pointCollectionRef.current) {
            pointCollectionRef.current.remove(point);
            pointMapRef.current.delete(targetId);
            pointSignatureRef.current.delete(targetId);
        }
        const shapeIds = shapeMapRef.current.get(targetId) || [];
        const previousLayerId = targetLayerMapRef.current.get(targetId);
        if (previousLayerId) {
            const batch = shapeBatchRef.current.get(previousLayerId);
            if (batch) {
                for (const shapeId of shapeIds) batch.remove(shapeId);
            }
        }
        shapeMapRef.current.delete(targetId);
        if (previousLayerId) {
            decrementLayerCount(previousLayerId);
            targetLayerMapRef.current.delete(targetId);
        }
        motionTrackMapRef.current.delete(targetId);
        motionTrackAppliedAtRef.current.delete(targetId);
        replayMetaMap.delete(normalizeReplayId(targetId));
        for (const shapeId of shapeIds) replayMetaMap.delete(shapeId);
        if (!suppressStats) publishReplayStats();
    };

    const clearLegacyLayerState = (layerId: string) => {
        if (layerId === 'satellite') {
            clearReplaySatelliteLayerState();
        }
        const targetIds = Array.from(targetLayerMapRef.current.entries())
            .filter(([, currentLayerId]) => currentLayerId === layerId)
            .map(([targetId]) => targetId);
        for (const targetId of targetIds) removeTarget(targetId, true);
        if (isReplayMovingFixLayer(layerId) && lastAppliedTimeRef.current) {
            syncReplayMotionTracks(lastAppliedTimeRef.current);
        }
        lastAppliedLayerTimeRef.current.delete(layerId);
        lastBufferedLayerTimeRef.current.delete(layerId);
        pointDeltaRunRef.current.delete(layerId);
        updateRuntimeQueueLength();
        publishReplayStats();
    };

    const clearLayer = (layerId: string) => {
        renderBatchManagerRef.current?.clearLayer(layerId);
        clearLegacyLayerState(layerId);
    };

    const applySatelliteTleState = async (
        atIso: string,
        items: ReplaySatelliteTleItem[],
        isCancelled: () => boolean = () => false,
    ): Promise<boolean> => {
        clearLayer('satellite');
        const pointCollection = pointCollectionRef.current;
        if (!pointCollection) return false;
        if (items.length === 0) {
            requestSceneRender();
            publishReplayStats();
            return !isCancelled();
        }

        const tBillboards0 = performance.now();
        const sabState = createSatellitePositionsSAB(items.length);
        replaySatelliteSabRef.current = sabState;
        replaySatelliteApplySlotsRef.current = [];

        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            const targetId = item.entity_id;
            const isRecon = item.subtype === 'recon';
            const icon = pointIconForStyle('satellite', {
                subtype: isRecon ? 'recon' : item.subtype || 'civilian',
                variant: isRecon ? 'recon' : null,
            });
            const billboard = pointCollection.add({
                position: Cesium.Cartesian3.ZERO,
                image: icon,
                scale: pointScaleForStyle('satellite', { subtype: isRecon ? 'recon' : item.subtype || 'civilian', variant: isRecon ? 'recon' : null }),
                color: Cesium.Color.WHITE.withAlpha(pointOpacityForStyle('satellite', { subtype: isRecon ? 'recon' : item.subtype || 'civilian', variant: isRecon ? 'recon' : null })),
                rotation: 0,
                show: false,
                id: targetId,
            });
            pointMapRef.current.set(targetId, billboard);
            sabState.indexById.set(targetId, index);
            // Reusable Cartographic scratch so updateMeta doesn't allocate
            // one fresh per 5000 satellites per frame. Same rationale as the
            // motion slot fix — SatelliteApplyManager emits updateMeta on
            // every epoch change, so a fresh Cartographic for each slot on
            // each apply was a large steady-state allocation source.
            const cartoScratch = new Cesium.Cartographic();
            replaySatelliteApplySlotsRef.current.push({
                index,
                targetId,
                billboard,
                scratch: new Cesium.Cartesian3(),
                cartoScratch,
                lastMetaUpdateMs: 0,
                getVisible: () => {
                    const meta = replayMetaMap.get(normalizeReplayId(targetId));
                    return computeVisible(targetId, 'satellite', meta?.subtype, meta?.source);
                },
                updateMeta: (position) => {
                    const meta = replayMetaMap.get(normalizeReplayId(targetId));
                    if (!meta) return;
                    const carto = Cesium.Cartographic.fromCartesian(position, undefined, cartoScratch);
                    if (!carto) return;
                    meta.lat = Cesium.Math.toDegrees(carto.latitude);
                    meta.lng = Cesium.Math.toDegrees(carto.longitude);
                    meta.alt = carto.height;
                },
            });
            const previousLayerId = targetLayerMapRef.current.get(targetId);
            if (!previousLayerId) {
                incrementLayerCount('satellite');
            } else if (previousLayerId !== 'satellite') {
                decrementLayerCount(previousLayerId);
                incrementLayerCount('satellite');
            }
            targetLayerMapRef.current.set(targetId, 'satellite');
            const normalizedTargetId = normalizeReplayId(targetId);
            const name = item.display_name || normalizedTargetId;
            replayMetaMap.set(normalizedTargetId, {
                id: normalizedTargetId,
                name,
                layer: 'Satellite',
                layerId: 'satellite',
                subtype: item.subtype,
                source: item.source_id,
                lat: 0,
                lng: 0,
                alt: 0,
                description: item.entity_properties?.description || '',
                extra: {
                    entityKind: item.entity_kind,
                    tleObservedAt: item.orbital_observed_at,
                },
            });
        }

        const tBillboards = performance.now() - tBillboards0;
        buildReplayFootprints(items);
        const tInit0 = performance.now();
        const worker = ensureReplayWorker();
        const tSpawn = performance.now() - tInit0;
        worker.postMessage({
            type: 'init',
            sab: sabState.sab,
            satellites: items
                .filter((item) => item.tle_line1 && item.tle_line2)
                .map((item) => ({
                    noradId: Number(item.entity_properties?.norad_id || item.entity_properties?.noradId || item.entity_id.replace(/\D+/g, '')) || 0,
                    name: item.display_name || item.entity_id,
                    tleLine1: item.tle_line1!,
                    tleLine2: item.tle_line2!,
                    type: item.subtype || 'civilian',
                    recon: item.subtype === 'recon',
                })),
        });
        const tInitMessage = performance.now() - tInit0 - tSpawn;
        const atMs = new Date(atIso).getTime();
        replaySatelliteLastTickAtRef.current = atMs;
        const tTick0 = performance.now();
        worker.postMessage({ type: 'tick', currentTimeMs: atMs });
        const tTick = performance.now() - tTick0;
        perfLog('replay.satellite.apply', {
            items: items.length,
            billboardsMs: Math.round(tBillboards),
            workerSpawnMs: Math.round(tSpawn),
            workerInitPostMs: Math.round(tInitMessage),
            workerTickPostMs: Math.round(tTick),
        });
        if (viewer && !viewer.isDestroyed()) {
            setSatelliteApplySource(viewer.scene, 'replay', {
                isActive: () => {
                    const state = useTimelineStore.getState();
                    return state.mode === 'playback' && state.playbackKind === 'historical';
                },
                beforeApply: (currentTimeMs) => {
                    const lastTickAt = replaySatelliteLastTickAtRef.current;
                    if (lastTickAt === 0 || Math.abs(currentTimeMs - lastTickAt) >= 250) {
                        replaySatelliteLastTickAtRef.current = currentTimeMs;
                        replaySatelliteWorkerRef.current?.postMessage({ type: 'tick', currentTimeMs });
                    }
                },
                getState: () => ({
                    sab: replaySatelliteSabRef.current,
                    slots: replaySatelliteApplySlotsRef.current,
                    epochMs: replaySatelliteLastEpochMsRef.current,
                }),
                applyVisibility: true,
                applyMeta: true,
            });
        }
        requestSceneRender();
        publishReplayStats();
        return !isCancelled();
    };

    const syncReplayMotionTracks = (atIso: string) => {
        const entries = Array.from(motionTrackMapRef.current.entries())
            .filter(([targetId]) => pointMapRef.current.has(targetId) || renderBatchPointMapRef.current.has(targetId))
            .sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
        if (entries.length === 0) {
            const generation = replayMotionGenerationRef.current + 1;
            replayMotionGenerationRef.current = generation;
            replayMotionSabRef.current = null;
            replayMotionApplySlotsRef.current = [];
            replayMotionSlotByEntityRef.current.clear();
            replayMotionLastEpochMsRef.current = null;
            replayMotionLastAppliedEpochMsRef.current = null;
            resetReplayMotionApplyProgress();
            replaySatelliteWorkerRef.current?.postMessage({
                type: 'update-tracks',
                generation,
                sab: null,
                tracks: [],
            });
            return;
        }
        const generation = replayMotionGenerationRef.current + 1;
        replayMotionGenerationRef.current = generation;
        const sabState = replayMotionSabRef.current && replayMotionApplySlotsRef.current.length === entries.length
            ? replayMotionSabRef.current
            : createSatellitePositionsSAB(entries.length);
        replayMotionSabRef.current = sabState;
        // Build the new slot array but reuse per-entity slot objects (with
        // their Cartesian3/Cartographic scratches) from the cache. Only the
        // `index` field updates when the fleet shape changes; scratches
        // persist, so the cadence reload no longer churns ~200k allocations.
        const nextSlots: SatelliteApplySlot[] = new Array(entries.length);
        const seenEntities = new Set<string>();
        const slotCache = replayMotionSlotByEntityRef.current;
        const totalSamples = entries.reduce((sum, [, track]) => sum + track.samples.length, 0);
        const trackRows = new Uint32Array(entries.length * 3);
        const sampleAtMs = new Float64Array(totalSamples);
        const samplePositions = new Float32Array(totalSamples * 3);
        let sampleCursor = 0;
        for (let i = 0; i < entries.length; i += 1) {
            const [targetId, track] = entries[i];
            seenEntities.add(targetId);
            const billboard = pointMapRef.current.get(targetId) || renderBatchPointMapRef.current.get(targetId)!;
            let slot = slotCache.get(targetId);
            if (!slot) {
                const cartoScratch = new Cesium.Cartographic();
                const metaId = normalizeReplayId(targetId);
                slot = {
                    index: i,
                    targetId,
                    billboard,
                    scratch: new Cesium.Cartesian3(),
                    cartoScratch,
                    lastMetaUpdateMs: 0,
                    getVisible: () => {
                        const meta = replayMetaMap.get(metaId) || replayRenderBatchMetaMap.get(targetId);
                        return computeVisible(targetId, meta?.layerId || 'aircraft', meta?.subtype, meta?.source);
                    },
                    updateMeta: (position) => {
                        const meta = replayMetaMap.get(metaId) || replayRenderBatchMetaMap.get(targetId);
                        if (!meta) return;
                        const carto = Cesium.Cartographic.fromCartesian(position, undefined, cartoScratch);
                        if (!carto) return;
                        meta.lat = Cesium.Math.toDegrees(carto.latitude);
                        meta.lng = Cesium.Math.toDegrees(carto.longitude);
                        meta.alt = carto.height;
                    },
                };
                slotCache.set(targetId, slot);
            } else {
                slot.index = i;
                slot.billboard = billboard;
            }
            nextSlots[i] = slot;

            const samples = track.samples;
            trackRows[i * 3] = i;
            trackRows[i * 3 + 1] = sampleCursor;
            trackRows[i * 3 + 2] = samples.length;
            for (let j = 0; j < samples.length; j += 1) {
                const sampleOffset = sampleCursor + j;
                sampleAtMs[sampleOffset] = samples[j].atMs;
                samplePositions[sampleOffset * 3] = samples[j].position[0];
                samplePositions[sampleOffset * 3 + 1] = samples[j].position[1];
                samplePositions[sampleOffset * 3 + 2] = samples[j].position[2];
            }
            sampleCursor += samples.length;
        }
        // Evict slot entries for entities that left the window so the cache
        // doesn't grow unbounded over a long replay session.
        if (slotCache.size > seenEntities.size) {
            slotCache.forEach((_, entityId) => {
                if (!seenEntities.has(entityId)) slotCache.delete(entityId);
            });
        }
        replayMotionApplySlotsRef.current = nextSlots;
        // Reset epoch refs so preRender doesn't skip apply on the first
        // motion-tick after rebuild. Without this, when the fleet shape
        // changes but currentIso stays the same, `motion-tick`'s echoed
        // epochMs=atMs equals replayMotionLastAppliedEpochMsRef and the
        // preRender guard (satelliteApplyManager line 130) returns early —
        // new slots never receive their first position and billboards stay
        // wherever they were (often visually off-viewport or stale).
        replayMotionLastEpochMsRef.current = null;
        replayMotionLastAppliedEpochMsRef.current = null;
        resetReplayMotionApplyProgress();
        const worker = ensureReplayWorker();
        worker.postMessage({
            type: 'update-tracks',
            generation,
            sab: sabState.sab,
            trackRows,
            sampleAtMs,
            samplePositions,
        }, [trackRows.buffer, sampleAtMs.buffer, samplePositions.buffer]);
        worker.postMessage({
            type: 'motion-tick',
            generation,
            atMs: new Date(atIso).getTime(),
        });
    };

    const syncReplayMotionTrackArrays = (layerId: string, atIso: string, sourceTracks: ReplayRenderBatchMotionTrack[]) => {
        renderBatchMotionTracksByLayerRef.current.set(layerId, sourceTracks);
        const entries = Array.from(renderBatchMotionTracksByLayerRef.current.values())
            .flat()
            .filter((track) => pointMapRef.current.has(track.targetId) || renderBatchPointMapRef.current.has(track.targetId))
            .sort((left, right) => left.targetId.localeCompare(right.targetId));
        if (entries.length === 0) {
            const generation = replayMotionGenerationRef.current + 1;
            replayMotionGenerationRef.current = generation;
            replayMotionSabRef.current = null;
            replayMotionApplySlotsRef.current = [];
            replayMotionSlotByEntityRef.current.clear();
            replayMotionLastEpochMsRef.current = null;
            replayMotionLastAppliedEpochMsRef.current = null;
            resetReplayMotionApplyProgress();
            renderBatchMotionTracksByLayerRef.current.clear();
            replaySatelliteWorkerRef.current?.postMessage({
                type: 'update-tracks',
                generation,
                sab: null,
                tracks: [],
            });
            return;
        }
        const generation = replayMotionGenerationRef.current + 1;
        replayMotionGenerationRef.current = generation;
        const sabState = replayMotionSabRef.current && replayMotionApplySlotsRef.current.length === entries.length
            ? replayMotionSabRef.current
            : createSatellitePositionsSAB(entries.length);
        replayMotionSabRef.current = sabState;
        const nextSlots: SatelliteApplySlot[] = new Array(entries.length);
        const seenEntities = new Set<string>();
        const slotCache = replayMotionSlotByEntityRef.current;
        const totalSamples = entries.reduce((sum, track) => sum + track.sampleAtMs.length, 0);
        const trackRows = new Uint32Array(entries.length * 3);
        const sampleAtMs = new Float64Array(totalSamples);
        const samplePositions = new Float32Array(totalSamples * 3);
        let sampleCursor = 0;
        for (let i = 0; i < entries.length; i += 1) {
            const track = entries[i];
            const targetId = track.targetId;
            seenEntities.add(targetId);
            const billboard = pointMapRef.current.get(targetId) || renderBatchPointMapRef.current.get(targetId)!;
            let slot = slotCache.get(targetId);
            if (!slot) {
                const cartoScratch = new Cesium.Cartographic();
                slot = {
                    index: i,
                    targetId,
                    billboard,
                    scratch: new Cesium.Cartesian3(),
                    cartoScratch,
                    lastMetaUpdateMs: 0,
                    getVisible: () => {
                        const meta = replayMetaMap.get(targetId) || replayRenderBatchMetaMap.get(targetId);
                        return computeVisible(targetId, meta?.layerId || 'aircraft', meta?.subtype, meta?.source);
                    },
                    updateMeta: (position) => {
                        const meta = replayMetaMap.get(targetId) || replayRenderBatchMetaMap.get(targetId);
                        if (!meta) return;
                        const carto = Cesium.Cartographic.fromCartesian(position, undefined, cartoScratch);
                        if (!carto) return;
                        meta.lat = Cesium.Math.toDegrees(carto.latitude);
                        meta.lng = Cesium.Math.toDegrees(carto.longitude);
                        meta.alt = carto.height;
                    },
                };
                slotCache.set(targetId, slot);
            } else {
                slot.index = i;
                slot.billboard = billboard;
            }
            nextSlots[i] = slot;
            const sampleCount = track.sampleAtMs.length;
            trackRows[i * 3] = i;
            trackRows[i * 3 + 1] = sampleCursor;
            trackRows[i * 3 + 2] = sampleCount;
            sampleAtMs.set(track.sampleAtMs, sampleCursor);
            samplePositions.set(track.samplePositions, sampleCursor * 3);
            sampleCursor += sampleCount;
        }
        if (slotCache.size > seenEntities.size) {
            slotCache.forEach((_, entityId) => {
                if (!seenEntities.has(entityId)) slotCache.delete(entityId);
            });
        }
        replayMotionApplySlotsRef.current = nextSlots;
        replayMotionLastEpochMsRef.current = null;
        replayMotionLastAppliedEpochMsRef.current = null;
        resetReplayMotionApplyProgress();
        const worker = ensureReplayWorker();
        worker.postMessage({
            type: 'update-tracks',
            generation,
            sab: sabState.sab,
            trackRows,
            sampleAtMs,
            samplePositions,
        }, [trackRows.buffer, sampleAtMs.buffer, samplePositions.buffer]);
        worker.postMessage({
            type: 'motion-tick',
            generation,
            atMs: new Date(atIso).getTime(),
        });
    };

    const shouldUseReplayRenderBatch = (layerId: string, options?: { renderChunks?: boolean }) => {
        if (options?.renderChunks === false) return false;
        return isReplayRenderBatchLayer(layerId);
    };

    const applyReplayRenderBatchLayer = async (
        layerId: string,
        atIso: string,
        isCancelled: () => boolean,
        options?: { renderChunks?: boolean },
    ): Promise<boolean | null> => {
        if (!shouldUseReplayRenderBatch(layerId, options)) return null;
        const manager = getRenderBatchManager();
        if (!manager) return null;
        const t0 = performance.now();
        try {
            const result = await manager.applyLayer({
                layerId,
                atIso,
                fromIso: atIso,
                toIso: atIso,
                bbox: getReplayViewportBbox(),
                aggregateFires: layerId === 'fire' ? (clusteringEnabled && !appliedSelectionForLayer(layerId)) : true,
                fetchFeatureRefs: Boolean(appliedSelectionForLayer(layerId)),
                isCancelled,
                beforeCommit: () => clearLegacyLayerState(layerId),
            });
            if (!result.applied || isCancelled()) return false;
            if (layerId === 'satellite') {
                replayRenderBatchFootprintsRef.current = result.footprints;
                if (getReplayFootprintVisible()) {
                    buildReplayFootprintsFromRenderBatch(result.footprints);
                }
            }
            if (isReplayMotionLayer(layerId)) {
                syncReplayMotionTrackArrays(layerId, atIso, result.motionTracks);
                replayMotionFullSyncAtRef.current.set(layerId, new Date(atIso).getTime());
            }
            pointDeltaRunRef.current.delete(layerId);
            setReplayLayerDegraded(layerId, result.degraded);
            perfLog('replay.render_batch.layer', {
                layer: layerId,
                ms: Math.round(performance.now() - t0),
                features: result.featureCount,
                points: result.pointCount,
                shapes: result.shapeCount,
                tracks: result.motionTracks.length,
                footprints: result.footprints.length,
                bytes: result.bytes,
                degraded: result.degraded || null,
            });
            return true;
        } catch (error: any) {
            if (isCancelled()) return false;
            const message = error?.message || String(error);
            console.error('[ReplayOverlay] render batch failed:', layerId, message);
            setReplayError(`Replay render-batch failed for ${layerId}: ${message}`);
            perfLog('replay.render_batch.failed', {
                layer: layerId,
                ms: Math.round(performance.now() - t0),
                error: message,
            });
            return false;
        }
    };

    const applyReplayRenderPointDeltaLayer = async (
        layerId: string,
        atIso: string,
        isCancelled: () => boolean,
        sinceIso?: string | null,
    ): Promise<{ applied: boolean; needsFullSync: boolean } | null> => {
        if (!canReplayPointDelta(layerId)) return null;
        const manager = getRenderBatchManager();
        if (!manager) return null;
        const t0 = performance.now();
        const sinceMs = sinceIso ? new Date(sinceIso).getTime() : Number.NaN;
        const atMs = new Date(atIso).getTime();
        const canUsePartialDelta = Boolean(
            sinceIso
            && isReplayMovingFixLayer(layerId)
            && Number.isFinite(sinceMs)
            && Number.isFinite(atMs)
            && sinceMs < atMs,
        );
        const existingRun = pointDeltaRunRef.current.get(layerId);
        const nextPartialCount = canUsePartialDelta ? (existingRun?.count ?? 0) + 1 : 0;
        const partialSpanMs = canUsePartialDelta ? atMs - (existingRun?.firstSinceMs ?? sinceMs) : 0;
        const usePartialDelta = canUsePartialDelta
            && nextPartialCount <= REPLAY_POINT_DELTA_FULL_SYNC_EVERY
            && partialSpanMs <= REPLAY_POINT_DELTA_MAX_SPAN_MS;
        const checkpointReason = canUsePartialDelta && !usePartialDelta
            ? (nextPartialCount > REPLAY_POINT_DELTA_FULL_SYNC_EVERY ? 'partial_count' : 'partial_span')
            : null;
        try {
            const result = await manager.applyPointDelta({
                layerId,
                atIso,
                sinceIso: usePartialDelta ? sinceIso || undefined : undefined,
                bbox: getReplayViewportBbox(),
                partial: usePartialDelta,
                aggregateFires: layerId === 'fire' ? clusteringEnabled : true,
                isCancelled,
            });
            if (!result.applied || isCancelled()) {
                if (!usePartialDelta || result.needsFullSync) pointDeltaRunRef.current.delete(layerId);
                return { applied: false, needsFullSync: result.needsFullSync };
            }
            lastAppliedLayerTimeRef.current.set(layerId, result.atIso);
            lastBufferedLayerTimeRef.current.set(layerId, result.atIso);
            if (usePartialDelta && !result.needsFullSync) {
                pointDeltaRunRef.current.set(layerId, {
                    count: nextPartialCount,
                    firstSinceMs: existingRun?.firstSinceMs ?? sinceMs,
                });
            } else {
                pointDeltaRunRef.current.delete(layerId);
            }
            if (layerId === 'satellite') updateReplayFootprints(true);
            perfLog('replay.render_delta.layer', {
                layer: layerId,
                ms: Math.round(performance.now() - t0),
                managerMs: result.ms,
                atIso: result.atIso,
                sinceIso: usePartialDelta ? sinceIso : null,
                partial: usePartialDelta,
                checkpointReason,
                partialRunCount: usePartialDelta ? nextPartialCount : 0,
                count: result.count,
                updated: result.updated,
                added: result.added,
                missing: result.missing,
                stale: result.stale,
                needsFullSync: result.needsFullSync,
            });
            publishReplayStats();
            return { applied: true, needsFullSync: result.needsFullSync };
        } catch (error: any) {
            if (isCancelled()) return { applied: false, needsFullSync: false };
            pointDeltaRunRef.current.delete(layerId);
            const message = error?.message || String(error);
            console.warn('[ReplayOverlay] render delta failed; requesting explicit full sync:', layerId, message);
            perfLog('replay.render_delta.failed', {
                layer: layerId,
                ms: Math.round(performance.now() - t0),
                error: message,
            });
            return { applied: false, needsFullSync: true };
        }
    };

    const markVisibleReplayFrame = (atIso: string, seekVersion: number) => {
        lastVisibleTimeRef.current = atIso;
        lastVisibleSeekVersionRef.current = seekVersion;
        if (typeof performance !== 'undefined') {
            performance.mark('replay-seek-visible:end');
            const startMark = performance.getEntriesByName('replay-seek-visible:start').length > 0
                ? 'replay-seek-visible:start'
                : null;
            if (startMark) {
                performance.measure('replay-seek-visible', startMark, 'replay-seek-visible:end');
            }
        }
    };

    const buildShapeDescriptors = (targetId: string, item: ReplayEvent | ReplayAsset): ReplayShapeDescriptor[] => {
        const geometry = item.geometry;
        const fill = fillColorForStyle(item.layer_id, item.subtype);
        const stroke = strokeColorForStyle(item.layer_id, item.subtype);
        const visible = computeVisible(targetId, item.layer_id, item.subtype, item.source_id);
        const normalizedTargetId = normalizeReplayId(targetId);
        const description = item.properties?.description || item.properties?.notes || '';
        const name = getReplayDisplayName(item, normalizedTargetId);
        const descriptors: ReplayShapeDescriptor[] = [];

        if (geometry?.type === 'LineString') {
            const positions = toPolylinePositions(geometry);
            if (positions.length >= 2) {
                descriptors.push({
                    id: normalizedTargetId,
                    logicalId: normalizedTargetId,
                    kind: 'polyline',
                    signature: JSON.stringify({
                        type: 'LineString',
                        coordinates: geometry.coordinates,
                        layer: item.layer_id,
                        subtype: item.subtype || null,
                    }),
                    name,
                    visible,
                    layer: toHudLayerName(item.layer_id),
                    subtype: item.subtype || null,
                    source: item.source_id || null,
                    description,
                    positions,
                    width: item.layer_id === 'pipeline' ? 3 : 2,
                    stroke,
                });
            }
            return descriptors;
        }

        if (geometry?.type === 'MultiLineString') {
            (geometry.coordinates || []).forEach((segment: number[][], index: number) => {
                const positions = toPolylinePositions({ type: 'LineString', coordinates: segment });
                if (positions.length < 2) return;
                descriptors.push({
                    id: `${normalizedTargetId}#${index}`,
                    logicalId: normalizedTargetId,
                    kind: 'polyline',
                    signature: JSON.stringify({
                        type: 'MultiLineString',
                        index,
                        coordinates: segment,
                        layer: item.layer_id,
                        subtype: item.subtype || null,
                    }),
                    name,
                    visible,
                    layer: toHudLayerName(item.layer_id),
                    subtype: item.subtype || null,
                    source: item.source_id || null,
                    description,
                    positions,
                    width: item.layer_id === 'pipeline' ? 3 : 2,
                    stroke,
                });
            });
            return descriptors;
        }

        if (geometry?.type === 'Polygon') {
            const hierarchy = toPolygonHierarchy(geometry);
            if (hierarchy) {
                descriptors.push({
                    id: normalizedTargetId,
                    logicalId: normalizedTargetId,
                    kind: 'polygon',
                    signature: JSON.stringify({
                        type: 'Polygon',
                        coordinates: geometry.coordinates,
                        layer: item.layer_id,
                        subtype: item.subtype || null,
                    }),
                    name,
                    visible,
                    layer: toHudLayerName(item.layer_id),
                    subtype: item.subtype || null,
                    source: item.source_id || null,
                    description,
                    hierarchy,
                    fill,
                    stroke,
                });
            }
            return descriptors;
        }

        if (geometry?.type === 'MultiPolygon') {
            (geometry.coordinates || []).forEach((coords: any, index: number) => {
                const hierarchy = toPolygonHierarchy({ type: 'Polygon', coordinates: coords });
                if (!hierarchy) return;
                descriptors.push({
                    id: `${normalizedTargetId}#${index}`,
                    logicalId: normalizedTargetId,
                    kind: 'polygon',
                    signature: JSON.stringify({
                        type: 'MultiPolygon',
                        index,
                        coordinates: coords,
                        layer: item.layer_id,
                        subtype: item.subtype || null,
                    }),
                    name,
                    visible,
                    layer: toHudLayerName(item.layer_id),
                    subtype: item.subtype || null,
                    source: item.source_id || null,
                    description,
                    hierarchy,
                    fill,
                    stroke,
                });
            });
        }

        return descriptors;
    };

    const upsertPoint = (targetId: string, item: ReplayEntity | ReplayEvent | ReplayAsset) => {
        const pointCollection = pointCollectionRef.current;
        if (!pointCollection) return;
        const lat = Number(item.display_lat);
        const lng = Number(item.display_lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const altitude = Number(('altitude_m' in item ? item.altitude_m : 0) || 0);
        const headingDeg = 'heading_deg' in item && Number.isFinite(item.heading_deg)
            ? Number(item.heading_deg)
            : null;
        const sampleAtMs = 'position_observed_at' in item && item.position_observed_at
            ? new Date(item.position_observed_at).getTime()
            : Number.NaN;

        const icon = pointIconForStyle(item.layer_id, styleLikeForReplayItem(item));
        const opacity = pointOpacityForStyle(item.layer_id, styleLikeForReplayItem(item));
        const visible = computeVisible(targetId, item.layer_id, item.subtype, item.source_id);
        const baseScale = pointScaleForStyle(item.layer_id, styleLikeForReplayItem(item));
        const scale = item.layer_id === 'fire' && 'properties' in item && Number.isFinite(item.properties?.count)
            ? Math.max(baseScale, Math.min(1.8, baseScale + Math.log2(Math.max(1, Number(item.properties?.count))) * 0.12))
            : baseScale;
        const existing = pointMapRef.current.get(targetId);
        const signature = [
            item.layer_id,
            lat,
            lng,
            altitude,
            headingDeg ?? '',
            icon,
            visible ? 1 : 0,
            scale,
            opacity,
        ].join('|');
        const staticPointUnchanged = !isReplayMotionLayer(item.layer_id)
            && Boolean(existing)
            && pointSignatureRef.current.get(targetId) === signature;
        let position: Cesium.Cartesian3 | null = null;
        if (!staticPointUnchanged) {
            position = safeCartesianFromDegrees(lng, lat, altitude);
            if (!position) return;
        }
        const rotation = item.layer_id === 'aircraft' && position && viewer
            ? (screenSpaceRotationForHeading(viewer.scene, position, headingDeg, pointRotationScratchRef.current)
                ?? headingFallbackRotation(headingDeg))
            : headingFallbackRotation(headingDeg);
        if (existing) {
            if (!staticPointUnchanged && position) {
                existing.position = position;
                if (existing.image !== icon) existing.image = icon;
                if (existing.show !== visible) existing.show = visible;
                if (existing.rotation !== rotation) existing.rotation = rotation;
                if (existing.scale !== scale) existing.scale = scale;
                existing.color = Cesium.Color.WHITE.withAlpha(opacity);
            }
        } else {
            if (!position) return;
            const bb = pointCollection.add({
                id: normalizeReplayId(targetId),
                position,
                image: icon,
                scale,
                color: Cesium.Color.WHITE.withAlpha(opacity),
                rotation,
                ...(item.layer_id === 'vessel' ? { alignedAxis: Cesium.Cartesian3.UNIT_Z } : {}),
                show: visible,
            });
            pointMapRef.current.set(targetId, bb);
        }
        pointSignatureRef.current.set(targetId, signature);

        if (isReplayMovingFixLayer(item.layer_id) && Number.isFinite(sampleAtMs)) {
            const movingPosition = position ?? existing?.position;
            if (!movingPosition) return;
            const sample: ReplayMotionSample = {
                atMs: sampleAtMs,
                position: [movingPosition.x, movingPosition.y, movingPosition.z],
            };
            const existingTrack = motionTrackMapRef.current.get(targetId);
            if (!existingTrack) {
                motionTrackMapRef.current.set(targetId, { samples: [sample] });
            } else {
                // Insert sample keeping samples[] ordered by atMs asc; skip
                // duplicates at the same atMs (live pipeline may republish
                // the same observation). Linear scan is fine — typical
                // bucket fits tens of samples.
                const samples = existingTrack.samples;
                let idx = samples.length;
                for (let i = 0; i < samples.length; i += 1) {
                    if (samples[i].atMs === sample.atMs) { idx = -1; break; }
                    if (samples[i].atMs > sample.atMs) { idx = i; break; }
                }
                if (idx >= 0) samples.splice(idx, 0, sample);
            }
        }

        const normalizedTargetId = normalizeReplayId(targetId);
        const meta = deriveReplayMeta(item, normalizedTargetId, replayMetaMap.get(normalizedTargetId));
        if (meta) replayMetaMap.set(meta.id, meta);
        const previousLayerId = targetLayerMapRef.current.get(targetId);
        if (!previousLayerId) {
            incrementLayerCount(item.layer_id);
        } else if (previousLayerId !== item.layer_id) {
            decrementLayerCount(previousLayerId);
            incrementLayerCount(item.layer_id);
        }
        targetLayerMapRef.current.set(targetId, item.layer_id);
    };

    const upsertGeometry = (targetId: string, item: ReplayEvent | ReplayAsset) => {
        const descriptors = buildShapeDescriptors(targetId, item);
        const oldIds = shapeMapRef.current.get(targetId) || [];
        const batch = getShapeBatch(item.layer_id);
        if (!batch) return;
        const nextIds: string[] = [];
        descriptors.forEach((descriptor) => {
            const result = batch.upsert(descriptor.id, descriptor);
            if (result === 'skip') {
                runtimePerfRef.current.shapeSignatureSkipCount += 1;
            } else if (result === 'visibility') {
                if (descriptor.kind === 'polyline') {
                    runtimePerfRef.current.polylineInPlaceMutationCount += 1;
                } else {
                    runtimePerfRef.current.polygonInPlaceMutationCount += 1;
                }
            } else {
                runtimePerfRef.current.shapeEntityAddCount += 1;
                if (descriptor.kind === 'polyline') {
                    runtimePerfRef.current.polylineEntityAddCount += 1;
                } else {
                    runtimePerfRef.current.polygonEntityAddCount += 1;
                }
            }
            nextIds.push(descriptor.id);
            const meta = deriveReplayMeta(item, descriptor.logicalId, replayMetaMap.get(descriptor.logicalId));
            if (meta) {
                replayMetaMap.set(descriptor.id, meta);
                replayMetaMap.set(descriptor.logicalId, meta);
            }
        });

        for (const oldId of oldIds) {
            if (!nextIds.includes(oldId)) {
                batch.remove(oldId);
                replayMetaMap.delete(oldId);
            }
        }

        shapeMapRef.current.set(targetId, nextIds);
        const normalizedTargetId = normalizeReplayId(targetId);
        const meta = deriveReplayMeta(item, normalizedTargetId, replayMetaMap.get(normalizedTargetId));
        if (meta) replayMetaMap.set(meta.id, meta);
        const previousLayerId = targetLayerMapRef.current.get(targetId);
        if (!previousLayerId) {
            incrementLayerCount(item.layer_id);
        } else if (previousLayerId !== item.layer_id) {
            decrementLayerCount(previousLayerId);
            incrementLayerCount(item.layer_id);
        }
        targetLayerMapRef.current.set(targetId, item.layer_id);
    };

    const applyLayerState = async (
        layerId: string,
        state: ReplayStateResponse,
        isCancelled: () => boolean = () => false,
        onProgress?: () => void,
        options?: {
            renderChunks?: boolean;
        },
    ): Promise<boolean> => {
        return withSpan(
            'replay.applyLayerState',
            {
                'replay.layer': layerId,
                'replay.at': state.at,
                'replay.entities': state.entities?.length ?? 0,
                'replay.events': state.events?.length ?? 0,
                'replay.assets': state.assets?.length ?? 0,
            },
            async (span) => {
        if (typeof performance !== 'undefined') {
            performance.mark(`replay-apply-layer:${layerId}:start`);
        }
        // Diagnostic: applyLayerState does flatMap+sort, mass map rebuilds,
        // upsertPoint/upsertGeometry per item. Codex review (2026-04-21)
        // ranked it #3 suspect for main-thread blocks but flagged that
        // maybeYield doesn't actually yield. Threshold 50 ms.
        const tBlockStart = performance.now();
        const existingTargetIds = new Set(
            Array.from(targetLayerMapRef.current.entries())
                .filter(([, currentLayerId]) => currentLayerId === layerId)
                .map(([targetId]) => targetId),
        );
        const nextTargetIds = new Set<string>();
        const chunkSize = getReplayApplyChunkSize(layerId);
        const renderChunks = options?.renderChunks !== false;
        void chunkSize; void renderChunks;
        let signalledProgress = false;
        const signalProgress = () => {
            if (signalledProgress) return;
            signalledProgress = true;
            onProgress?.();
        };
        // No chunked yields: applying 30k entities in one tight loop costs
        // ~80-200 ms on main thread, one frame skip, no perceived lag.
        // Per-N-entries setTimeout(0) yields turn that into seconds because
        // setTimeout is clamped to 4ms and we lose a frame per yield.
        const maybeYield = async (): Promise<boolean> => {
            return !isCancelled();
        };
        for (const entity of state.entities) {
            if (entity.layer_id !== layerId) continue;
            nextTargetIds.add(entity.entity_id);
            upsertPoint(entity.entity_id, entity);
            if (!(await maybeYield())) return false;
        }
        // motionSamples now carries the full ordered trajectory per entity
        // for the current replay window; motion-tick in the worker binary-
        // searches this array for any atMs so movement stays smooth at any
        // playback speed.
        //
        // Race prevention: warm-prime and playback-refresh can both run
        // applyLayerState concurrently for the same moving layer. We commit
        // tracks only if (a) this apply pass isn't superseded and (b) the
        // entity wasn't already written by a NEWER atMs from another pass.
        if (isReplayMovingFixLayer(layerId) && state.motionSamples && state.motionSamples.size > 0 && !isCancelled()) {
            const myAtMs = new Date(state.at).getTime();
            state.motionSamples.forEach((rawSamples, entityId) => {
                const samples: ReplayMotionSample[] = [];
                for (const raw of rawSamples) {
                    const pos = safeCartesianFromDegrees(raw.lng, raw.lat, raw.alt);
                    if (!pos) continue;
                    samples.push({ atMs: raw.atMs, position: [pos.x, pos.y, pos.z] });
                }
                if (samples.length === 0) return;
                const existingStampMs = motionTrackAppliedAtRef.current.get(entityId) ?? Number.NEGATIVE_INFINITY;
                if (myAtMs < existingStampMs) return; // newer write already landed
                motionTrackMapRef.current.set(entityId, { samples });
                motionTrackAppliedAtRef.current.set(entityId, myAtMs);
            });
        }
        for (const event of state.events) {
            if (event.layer_id !== layerId) continue;
            nextTargetIds.add(event.event_id);
            if (isPointGeometry(event.geometry)) upsertPoint(event.event_id, event);
            else upsertGeometry(event.event_id, event);
            if (!(await maybeYield())) return false;
        }
        for (const asset of state.assets) {
            if (asset.layer_id !== layerId) continue;
            nextTargetIds.add(asset.asset_id);
            if (isPointGeometry(asset.geometry)) upsertPoint(asset.asset_id, asset);
            else upsertGeometry(asset.asset_id, asset);
            if (!(await maybeYield())) return false;
        }
        for (const targetId of Array.from(existingTargetIds)) {
            if (nextTargetIds.has(targetId)) continue;
            removeTarget(targetId, true);
            if (!(await maybeYield())) return false;
        }
        requestSceneRender();
        publishReplayStats();
        signalProgress();
        if (typeof performance !== 'undefined') {
            performance.mark(`replay-apply-layer:${layerId}:end`);
            performance.measure(`replay-apply-layer:${layerId}`, `replay-apply-layer:${layerId}:start`, `replay-apply-layer:${layerId}:end`);
        }
        const blockMs = performance.now() - tBlockStart;
        span?.setAttribute('apply.block_ms', Math.round(blockMs));
        span?.setAttribute('apply.existing_targets', existingTargetIds.size);
        span?.setAttribute('apply.next_targets', nextTargetIds.size);
        if (blockMs > 50) {
            perfLog('suspect.block', {
                name: 'useReplayOverlay.applyLayerState',
                ms: Math.round(blockMs),
                layer: layerId,
                entities: state.entities?.length ?? 0,
                events: state.events?.length ?? 0,
                assets: state.assets?.length ?? 0,
                existingTargets: existingTargetIds.size,
                nextTargets: nextTargetIds.size,
            });
        }
        return !isCancelled();
            },
        ) as Promise<boolean>;
    };

    const syncLayerState = async (
        layerId: string,
        atIso: string,
        isCancelled: () => boolean = () => false,
        options?: { renderChunks?: boolean },
    ): Promise<boolean> => {
        return withSpan(
            'replay.syncLayerState',
            {
                'replay.layer': layerId,
                'replay.at': atIso,
                'replay.render_chunks': options?.renderChunks !== false,
            },
            async (span) => {
        if (reuseStaticLayerWithinBucket(layerId, atIso)) {
            span?.setAttribute('sync.static_bucket_reuse', true);
            return true;
        }
        if (shouldApplyPointDeltaBeforeFullSync(layerId, atIso)) {
            const previousIso = lastAppliedLayerTimeRef.current.get(layerId) || null;
            const delta = await applyReplayRenderPointDeltaLayer(layerId, atIso, isCancelled, previousIso);
            if (delta?.applied && !delta.needsFullSync) {
                span?.setAttribute('sync.point_delta', true);
                return true;
            }
            if (isCancelled()) return false;
            span?.setAttribute('sync.point_delta_promoted_full', true);
        }
        const renderBatchApplied = await applyReplayRenderBatchLayer(layerId, atIso, isCancelled, options);
        if (renderBatchApplied === true) {
            lastAppliedLayerTimeRef.current.set(layerId, atIso);
            lastBufferedLayerTimeRef.current.set(layerId, atIso);
            span?.setAttribute('sync.render_batch', true);
            return true;
        }
        if (renderBatchApplied === false) return false;

        const message = `Replay layer ${layerId} is not configured for render-batch hydration`;
        console.error('[ReplayOverlay] unsupported replay layer:', message);
        setReplayError(message);
        perfLog('replay.layer.unsupported', { layer: layerId, atIso });
        return false;
            },
        ) as Promise<boolean>;
    };

    useEffect(() => {
        const pointCollection = pointCollectionRef.current;
        const showReplay = mode === 'playback' && playbackKind === 'historical';
        if (pointCollection) pointCollection.show = showReplay;
        if (!showReplay) {
            replayOperationIdRef.current += 1;
            clearReplay();
            lastAppliedTimeRef.current = null;
            lastAppliedSeekVersionRef.current = useTimelineStore.getState().replaySeekVersion;
            layersKeyRef.current = '';
            setReplayHydrating(false);
        }
        requestSceneRender();
        publishReplayStats();
    }, [mode, playbackKind, setReplayHydrating]);

    useEffect(() => {
        if (!viewer) return;
        const aircraftRotationScratch = createBillboardScreenHeadingScratch();
        let lastAircraftRotationAt = 0;
        const refreshAircraftScreenRotations = (force = false): boolean => {
            const state = useTimelineStore.getState();
            if (state.mode !== 'playback' || state.playbackKind !== 'historical') return false;
            const nowMs = performance.now();
            if (!force && nowMs - lastAircraftRotationAt < REPLAY_AIRCRAFT_SCREEN_ROTATION_INTERVAL_MS) return false;
            lastAircraftRotationAt = nowMs;
            let touched = false;
            pointMapRef.current.forEach((bb, targetId) => {
                if (!bb.show) return;
                const meta = replayMetaMap.get(targetId) || replayMetaMap.get(normalizeReplayId(targetId));
                if (meta?.layerId !== 'aircraft') return;
                touched = applyBillboardScreenSpaceHeading(viewer.scene, bb, meta.heading, aircraftRotationScratch) || touched;
            });
            renderBatchPointMapRef.current.forEach((bb, targetId) => {
                if (!bb.show) return;
                const meta = replayRenderBatchMetaMap.get(targetId);
                if (meta?.layerId !== 'aircraft') return;
                touched = applyBillboardScreenSpaceHeading(viewer.scene, bb, meta.heading, aircraftRotationScratch) || touched;
            });
            return touched;
        };
        const handlePreRender = () => {
            // Codex round-7 instrumentation (2026-04-21): the replay
            // motion preRender loop iterates billboards on main and was
            // uninstrumented. Threshold 50 ms.
            const tStart = performance.now();
            let touched = false;
            shapeBatchRef.current.forEach((batch) => {
                touched = batch.rebuildIfDirty() || touched;
            });
            const state = useTimelineStore.getState();
            let appliedSlots = 0;
            if (state.mode === 'playback' && state.playbackKind === 'historical') {
                const currentMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
                const selectedReplayId = state.selectedEntityId ? normalizeReplayId(state.selectedEntityId) : null;
                const isolatedReplayId = state.isolatedEntityId ? normalizeReplayId(state.isolatedEntityId) : null;
                const needsFocusedMeta = Boolean(selectedReplayId || isolatedReplayId);
                const motionApplyInProgress = replayMotionApplyingEpochMsRef.current !== null;
                if (replayMotionApplySlotsRef.current.length > 0 && replaySatelliteWorkerRef.current && !motionApplyInProgress) {
                    replaySatelliteWorkerRef.current.postMessage({
                        type: 'motion-tick',
                        generation: replayMotionGenerationRef.current,
                        atMs: currentMs,
                    });
                }
                const motionSab = replayMotionSabRef.current;
                const motionEpochMs = replayMotionLastEpochMsRef.current;
                if (motionSab && Number.isFinite(motionEpochMs ?? NaN) && replayMotionLastAppliedEpochMsRef.current !== motionEpochMs) {
                    const view = motionSab.view;
                    const slots = replayMotionApplySlotsRef.current;
                    if (replayMotionApplyingEpochMsRef.current !== motionEpochMs) {
                        replayMotionApplyingEpochMsRef.current = motionEpochMs;
                        replayMotionApplyCursorRef.current = 0;
                    }
                    const nowMs = performance.now();
                    const applyStartMs = nowMs;
                    let cursor = Math.min(replayMotionApplyCursorRef.current, slots.length);
                    let processedSlots = 0;
                    // Throttle updateMeta (lat/lng/alt recompute for hover/details
                    // panels) to ~250ms per slot. This used to fire 60×/s ×
                    // 33k slots = 2M Cartographic allocations/s — the main
                    // contributor alongside Cesium's position-setter clone to
                    // the ~300 MB/s leak that pinned Chrome renderer memory
                    // and froze the UI. Metadata doesn't need 60fps freshness.
                    const META_THROTTLE_MS = 250;
                    while (cursor < slots.length) {
                        const slot = slots[cursor];
                        cursor += 1;
                        processedSlots += 1;
                        const offset = slot.index * 3;
                        const x = view[offset];
                        const y = view[offset + 1];
                        const z = view[offset + 2];
                        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                        // Fast path: write directly into billboard._position /
                        // _actualPosition and flag the collection, bypassing the
                        // public setter which clones every assignment.
                        applyFastBillboardPosition(slot, x, y, z);
                        if (needsFocusedMeta && slot.updateMeta) {
                            const slotReplayId = normalizeReplayId(slot.targetId);
                            if (slotReplayId === selectedReplayId || slotReplayId === isolatedReplayId) {
                                const lastMeta = slot.lastMetaUpdateMs ?? 0;
                                if (nowMs - lastMeta >= META_THROTTLE_MS) {
                                    slot.updateMeta(slot.scratch);
                                    slot.lastMetaUpdateMs = nowMs;
                                }
                            }
                        }
                        appliedSlots += 1;
                        touched = true;
                        if (
                            processedSlots % REPLAY_MOTION_APPLY_CHECK_INTERVAL === 0
                            && performance.now() - applyStartMs >= REPLAY_MOTION_APPLY_BUDGET_MS
                        ) {
                            break;
                        }
                    }
                    replayMotionApplyCursorRef.current = cursor;
                    if (processedSlots > 0) {
                        touched = true;
                    }
                    if (cursor >= slots.length) {
                        replayMotionLastAppliedEpochMsRef.current = motionEpochMs;
                        resetReplayMotionApplyProgress();
                    } else {
                        viewer.scene.requestRender();
                    }
                }
                updateRuntimeQueueLength();
                runtimePerfRef.current.lastDrainOps = 0;
                runtimePerfRef.current.lastDrainMs = 0;
                updateReplayFootprints();
                touched = refreshAircraftScreenRotations() || touched;
            }
            if (touched) {
                viewer.scene.requestRender();
            }
            publishReplayStats();
            const ms = performance.now() - tStart;
            if (ms > 50) {
                perfLog('suspect.block', {
                    name: 'useReplayOverlay.handlePreRender',
                    ms: Math.round(ms),
                    appliedSlots,
                    motionApplySlots: replayMotionApplySlotsRef.current.length,
                    motionApplyCursor: replayMotionApplyCursorRef.current,
                    motionApplyEpochMs: replayMotionApplyingEpochMsRef.current,
                    shapeBatches: shapeBatchRef.current.size,
                });
            }
        };
        viewer.scene.preRender.addEventListener(handlePreRender);
        return () => {
            if (!viewer.isDestroyed()) {
                viewer.scene.preRender.removeEventListener(handlePreRender);
            }
        };
    }, [viewer]);

    useEffect(() => {
        replayCancelVersionRef.current += 1;
    }, [mode, playbackKind, replaySeekVersion, layersKey]);

    useEffect(() => {
        const unsubscribe = useTimelineStore.subscribe((state, prevState) => {
            const historicalNow = state.mode === 'playback' && state.playbackKind === 'historical';
            const historicalBefore = prevState.mode === 'playback' && prevState.playbackKind === 'historical';
            if (historicalNow && !historicalBefore) {
                // Do not start a speculative snapshot just because the
                // slider switched the store from live to playback. The real
                // target arrives as a user-seek on mouseup; starting NOW here
                // leaves an uncancelled backend render competing with it.
                return;
            }
            if (!historicalNow) return;
            if (state.currentTimeUpdate.seq === prevState.currentTimeUpdate.seq) return;
            if (state.currentTimeUpdate.silent) return;
            if (typeof performance !== 'undefined') {
                performance.mark('replay-seek-visible:start');
            }
            seekRequestRef.current = {
                targetMs: state.currentTime.getTime(),
                reason: state.currentTimeUpdate.reason === 'user-seek' ? 'user-seek' : 'time-change',
            };
        });
        return () => {
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        if (mode !== 'playback' || playbackKind !== 'historical') return;
        pointMapRef.current.forEach((bb, targetId) => {
            const meta = replayMetaMap.get(normalizeReplayId(targetId));
            bb.show = !meta || computeVisible(targetId, meta.layerId, meta.subtype, meta.source);
        });
        renderBatchPointMapRef.current.forEach((bb, targetId) => {
            const meta = replayRenderBatchMetaMap.get(targetId);
            const featureId = meta?.extra?.featureId ? String(meta.extra.featureId) : targetId;
            bb.show = !meta || computeVisible(featureId, meta.layerId, meta.subtype, meta.source);
        });
        targetLayerMapRef.current.forEach((layerId, targetId) => {
            const shapeIds = shapeMapRef.current.get(targetId) || [];
            if (shapeIds.length === 0) return;
            const meta = replayMetaMap.get(normalizeReplayId(targetId));
            const visible = computeVisible(targetId, layerId, meta?.subtype, meta?.source);
            const batch = shapeBatchRef.current.get(layerId);
            if (!batch) return;
            for (const shapeId of shapeIds) batch.setVisible(shapeId, visible);
        });
        requestSceneRender();
        publishReplayStats();
    }, [mode, playbackKind, subtypeVisibility, sourceVisibility, appliedSelectionSets, isolatedEntityId, agentReplayFocusSet]);

    useEffect(() => {
        if (mode !== 'playback' || playbackKind !== 'historical') {
            if (replayFootprintDsRef.current) replayFootprintDsRef.current.show = false;
            return;
        }
        if (sources.satelliteFootprints && !replayFootprintDsRef.current && replaySatelliteItemsRef.current.length > 0) {
            buildReplayFootprints(replaySatelliteItemsRef.current);
        }
        if (sources.satelliteFootprints && !replayFootprintDsRef.current && replayRenderBatchFootprintsRef.current.length > 0) {
            buildReplayFootprintsFromRenderBatch(replayRenderBatchFootprintsRef.current);
        }
        if (replayFootprintDsRef.current) {
            replayFootprintDsRef.current.show = getReplayFootprintVisible();
            updateReplayFootprints(true);
        }
        requestSceneRender();
    }, [mode, playbackKind, sources.satelliteFootprints, visibility.satelliteFootprints]);

    useEffect(() => {
        if (!viewer || mode !== 'playback' || playbackKind !== 'historical') {
            replayViewportKeyRef.current = '';
            return;
        }
        if (!activeReplayLayers.some((layerId) => isReplayRenderBatchLayer(layerId))) {
            replayViewportKeyRef.current = getReplayViewportKey();
            return;
        }
        replayViewportKeyRef.current = getReplayViewportKey();

        const refreshForViewportChange = () => {
            if (!viewer || viewer.isDestroyed()) return;
            const nextKey = getReplayViewportKey();
            if (nextKey === replayViewportKeyRef.current) return;
            replayViewportKeyRef.current = nextKey;
            invalidateReplayViewportScopedLayers();
            const currentTime = useTimelineStore.getState().currentTime;
            seekRequestRef.current = {
                targetMs: currentTime.getTime(),
                reason: 'viewport-change',
            };
            if (replayBusyRef.current) replayCancelVersionRef.current += 1;
            setReplayViewportVersion((version) => version + 1);
            publishReplayStats();
        };

        const removeMoveEnd = viewer.camera.moveEnd.addEventListener(refreshForViewportChange);
        return () => {
            removeMoveEnd();
        };
    }, [viewer, mode, playbackKind, activeReplayLayers, layersKey]);

    useEffect(() => {
        perfLog('replay.effect.enter', {
            hasViewer: Boolean(viewer),
            mode,
            playbackKind,
            replaySeekVersion,
            lastAppliedSeekVersion: lastAppliedSeekVersionRef.current,
            activeReplayLayersCount: activeReplayLayers.length,
            activeReplayLayers: activeReplayLayers.slice(0, 15),
            layersKey: layersKey.slice(0, 120),
            layersKeyRef: layersKeyRef.current.slice(0, 120),
            lastAppliedTime: lastAppliedTimeRef.current,
            replayBusy: replayBusyRef.current,
        });
        if (!viewer || mode !== 'playback' || playbackKind !== 'historical') {
            perfLog('replay.effect.exit', {
                reason: 'gate-failed',
                hasViewer: Boolean(viewer),
                mode,
                playbackKind,
            });
            return;
        }
        const stateCurrentTime = useTimelineStore.getState().currentTime;
        const layersChanged = layersKeyRef.current !== layersKey;
        if (!seekRequestRef.current && layersChanged && lastAppliedTimeRef.current) {
            seekRequestRef.current = {
                targetMs: stateCurrentTime.getTime(),
                reason: 'layers-change',
            };
        }
        const explicitSeekRequest = seekRequestRef.current;
        if (activeReplayLayers.length === 0) {
            perfLog('replay.effect.exit', { reason: 'no-active-layers' });
            clearReplay();
            lastAppliedTimeRef.current = null;
            lastAppliedSeekVersionRef.current = replaySeekVersion;
            layersKeyRef.current = '';
            setReplayHydrating(false);
            return;
        }
        let cancelVersion = replayCancelVersionRef.current;
        const operationId = replayOperationIdRef.current + 1;
        const targetMs = explicitSeekRequest?.targetMs ?? stateCurrentTime.getTime();
        const currentTime = new Date(targetMs);
        const currentIso = currentTime.toISOString();
        const previousIso = lastAppliedTimeRef.current;
        const deltaMs = previousIso ? currentTime.getTime() - new Date(previousIso).getTime() : 0;
        const manualSeekRequested = replaySeekVersion !== lastAppliedSeekVersionRef.current || Boolean(explicitSeekRequest);
        const hasHistoricalFrame = Boolean(previousIso);
        if (!hasHistoricalFrame && !manualSeekRequested) {
            perfLog('replay.effect.exit', {
                reason: 'no-seek-no-frame',
                replaySeekVersion,
                lastAppliedSeekVersion: lastAppliedSeekVersionRef.current,
                hasHistoricalFrame,
                previousIso,
            });
            return;
        }
        if (replayBusyRef.current) {
            if (explicitSeekRequest?.reason === 'user-seek') {
                replayCancelVersionRef.current += 1;
                cancelVersion = replayCancelVersionRef.current;
                replayBusyRef.current = false;
                replayPendingRef.current = false;
                publishReplayStats();
            } else {
                replayPendingRef.current = true;
                return;
            }
        }
        if (replayBusyRef.current) {
            replayPendingRef.current = true;
            return;
        }

        const shouldSeek = manualSeekRequested || !previousIso || layersChanged || deltaMs < 0 || deltaMs > 15 * 60 * 1000;
        const sortedReplayLayers = [...activeReplayLayers].sort((a, b) => {
            const aPriority = getReplaySeekPriority(a);
            const bPriority = getReplaySeekPriority(b);
            return aPriority - bPriority;
        });
        const primaryReplayLayers = sortedReplayLayers.filter((layerId) => getReplayHydrationStage(layerId) === 'primary');
        const secondaryReplayLayers = sortedReplayLayers.filter((layerId) => getReplayHydrationStage(layerId) === 'eager');
        const backgroundReplayLayers = sortedReplayLayers.filter((layerId) =>
            getReplayHydrationStage(layerId) === 'background',
        );
        const bootstrapReplayLayers = primaryReplayLayers.length > 0
            ? primaryReplayLayers
            : secondaryReplayLayers.length > 0
                ? secondaryReplayLayers
                : (backgroundReplayLayers.some((layerId) => !shouldRunReplayHydrationInParallel(layerId))
                    ? backgroundReplayLayers.filter((layerId) => !shouldRunReplayHydrationInParallel(layerId)).slice(0, 1)
                    : backgroundReplayLayers.slice(0, 1));
        const deferredReplayLayers = sortedReplayLayers.filter((layerId) => !bootstrapReplayLayers.includes(layerId));
        const eagerlyDeferredReplayLayers = deferredReplayLayers.filter((layerId) => getReplayHydrationStage(layerId) === 'eager');
        const backgroundDeferredReplayLayers = deferredReplayLayers.filter((layerId) =>
            !eagerlyDeferredReplayLayers.includes(layerId),
        );
        const interactiveReplayLayers = bootstrapReplayLayers;
        const isCancelled = () => cancelVersion !== replayCancelVersionRef.current;
        const isCurrentOperation = () => operationId === replayOperationIdRef.current;
        const releaseReplayHydrationIfReady = () => {
            if (!isCurrentOperation() || replayBusyRef.current || replayPendingRef.current) return;
            if (replayHydrationInflightRef.current > 0) return;
            setReplayHydrating(false);
            publishReplayStats();
        };

        const fetchReplay = async () => {
            const tFetchReplayStart = performance.now();
            perfLog('replay.fetch.start', {
                currentIso,
                interactiveCount: interactiveReplayLayers.length,
                interactive: interactiveReplayLayers.slice(0, 4),
                sortedCount: sortedReplayLayers.length,
                cancelVersion,
                currentCancelVersion: replayCancelVersionRef.current,
            });
            setReplayError(null);
            if (isCancelled()) return;
            const fetchLayerState = async (layerId: string, options?: { renderChunks?: boolean }) => {
                if (typeof performance !== 'undefined') {
                    performance.mark(`replay-seek-sync:${layerId}:start`);
                }
                const applied = await syncLayerState(layerId, currentIso, isCancelled, options);
                if (typeof performance !== 'undefined') {
                    performance.mark(`replay-seek-sync:${layerId}:end`);
                    performance.measure(`replay-seek-sync:${layerId}`, `replay-seek-sync:${layerId}:start`, `replay-seek-sync:${layerId}:end`);
                }
                if (!applied || isCancelled()) return false;
                return true;
            };

            if (shouldSeek) {
                setReplayHydrating(true);
                let replayInteractive = false;
                const releaseReplayInteraction = () => {
                    if (replayInteractive) return;
                    lastAppliedTimeRef.current = currentIso;
                    lastAppliedSeekVersionRef.current = replaySeekVersion;
                    layersKeyRef.current = layersKey;
                    // `replayHydrating` gates user playback, so release it as
                    // soon as the first visible replay frame is ready. Deferred
                    // layers continue hydrating in the background and update
                    // the globe incrementally; they must not keep Play locked.
                    setReplayHydrating(false);
                    requestSceneRender();
                    publishReplayStats();
                    replayInteractive = true;
                };
                if (interactiveReplayLayers.length > 0) {
                    if (!previousIso || layersChanged) {
                        clearReplay();
                    }
                    const seekStartedAt = performance.now();
                    perfLog('replay.seek.start', { atIso: currentIso, layers: interactiveReplayLayers });
                    // Parallel fetch+apply. Mark visible as soon as the FIRST
                    // layer applies — don't wait for the slowest (satellites
                    // take 10+s to spawn Worker + parse 5000 TLEs). Aircraft
                    // and vessels appear within ~1-2s.
                    let visibleMarked = false;
                    const results = await Promise.all(interactiveReplayLayers.map(async (layerId) => {
                        const t0 = performance.now();
                        const applied = await fetchLayerState(layerId);
                        const t1 = performance.now();
                        perfLog('replay.layer.ready', { layer: layerId, ms: Math.round(t1 - t0), applied });
                        if (applied && !visibleMarked && !isCancelled()) {
                            visibleMarked = true;
                            markVisibleReplayFrame(currentIso, replaySeekVersion);
                            releaseReplayInteraction();
                            publishReplayStats();
                            perfLog('replay.first_visible', { layer: layerId, ms: Math.round(t1 - seekStartedAt) });
                        }
                        return applied;
                    }));
                    if (isCancelled() || results.some((r) => !r)) {
                        if (!isCancelled()) setReplayHydrating(false);
                        perfLog('replay.hydration_task', {
                            kind: 'primary',
                            phase: 'cancel',
                            ms: Math.round(performance.now() - seekStartedAt),
                            abortedIn: 'interactive',
                        });
                        return;
                    }
                    perfLog('replay.all_primary_visible', { ms: Math.round(performance.now() - seekStartedAt) });
                }
                if (isCancelled()) return;
                releaseReplayInteraction();
                const warmPrimeKey = `${layersKey}|${currentIso}`;
                if (replayWarmPrimeKeyRef.current !== warmPrimeKey) {
                    replayWarmPrimeKeyRef.current = warmPrimeKey;
                    const warmLayers: string[] = [];
                    // Codex round-10 fix: deferred IIFE fires its own
                    // Promise.all of fetchLayerState concurrently with
                    // warm-prime, which starves readonly `get()` callbacks
                    // on the shared IDB objectStore. Empty deferred tiles
                    // (jamming/gfw/outage) ended up with `cache-idb = 12 060 ms`
                    // on cold while primary's same op took 1 784 ms.
                    // Expose the warm-prime completion via a promise so the
                    // deferred IIFE can await it before issuing more get()s.
                    let warmPrimeResolve: () => void = () => {};
                    const warmPrimePromise = new Promise<void>((resolve) => {
                        warmPrimeResolve = resolve;
                    });
                    replayWarmPrimePromiseRef.current = warmPrimePromise;
                    if (warmLayers.length === 0) {
                        warmPrimeResolve();
                    }
                    if (warmLayers.length > 0) {
                        const warmTaskId = `warm-prime|${warmPrimeKey}|${Date.now()}`;
                        perfLog('replay.hydration_task', {
                            kind: 'warm-prime',
                            phase: 'start',
                            taskId: warmTaskId,
                            currentIso,
                            layers: warmLayers,
                        });
                            const warmStart = performance.now();
                            replayHydrationInflightRef.current += 1;
                            void (async () => {
                                for (const layerId of warmLayers) {
                                const applied = await syncLayerState(layerId, currentIso, isCancelled);
                                if (!applied || isCancelled()) {
                                    perfLog('replay.hydration_task', {
                                        kind: 'warm-prime',
                                        phase: 'cancel',
                                        taskId: warmTaskId,
                                        ms: Math.round(performance.now() - warmStart),
                                        abortedAt: layerId,
                                    });
                                    return;
                                }
                            }
                            perfLog('replay.hydration_task', {
                                kind: 'warm-prime',
                                phase: 'end',
                                taskId: warmTaskId,
                                ms: Math.round(performance.now() - warmStart),
                            });
                        })().catch((error: any) => {
                            if (isCancelled()) return false;
                            const message = error?.message || String(error);
                            console.error('[ReplayOverlay] warm prime failed:', message);
                            setReplayError(`Replay warm prime failed: ${message}`);
                            perfLog('replay.hydration_task', {
                                kind: 'warm-prime',
                                phase: 'error',
                                taskId: warmTaskId,
                                ms: Math.round(performance.now() - warmStart),
                                error: message,
                            });
                        }).finally(() => {
                            replayHydrationInflightRef.current = Math.max(0, replayHydrationInflightRef.current - 1);
                            releaseReplayHydrationIfReady();
                            warmPrimeResolve();
                        });
                    } else {
                        warmPrimeResolve();
                    }
                }
                const deferredTaskId = `deferred|${layersKey}|${currentIso}|${Date.now()}`;
                perfLog('replay.hydration_task', {
                    kind: 'deferred',
                    phase: 'start',
                    taskId: deferredTaskId,
                    currentIso,
                    eager: eagerlyDeferredReplayLayers,
                    background: backgroundDeferredReplayLayers.filter((layerId) => !shouldRunReplayHydrationInParallel(layerId)),
                    parallel: backgroundDeferredReplayLayers.filter((layerId) => shouldRunReplayHydrationInParallel(layerId)),
                });
                const deferredStart = performance.now();
                replayHydrationInflightRef.current += 1;
                void (async () => {
                    // Codex round-10 fix (2026-04-21): wait for warm-prime
                    // primary layers to finish their apply before kicking
                    // off eager deferred fetchLayerState calls. Running them
                    // concurrently starved readonly IDB `get()` callbacks on
                    // the shared objectStore — empty-tile deferred layers
                    // (jamming/gfw/outage) hit `cache-idb = 12 060 ms` while
                    // primary's same op took 1 784 ms. Waiting frees the
                    // main thread so deferred get()s' onsuccess can fire.
                    const warmGate = replayWarmPrimePromiseRef.current;
                    if (warmGate) {
                        await warmGate;
                        if (isCancelled()) return;
                    }
                    // Parallel fetch+apply of deferred layers. Sequential
                    // chained awaits with setTimeout(0) yields turned 8 layers
                    // into 8+ seconds of staggered apply spikes.
                    const eagerStart = performance.now();
                    const eagerResults = await Promise.all(eagerlyDeferredReplayLayers.map(async (layerId) => {
                        const t0 = performance.now();
                        const ok = await fetchLayerState(layerId);
                        perfLog('replay.eager_layer', { layer: layerId, ms: Math.round(performance.now() - t0), ok });
                        return ok;
                    }));
                    if (isCancelled() || eagerResults.some((r) => !r)) {
                        if (!isCancelled()) setReplayHydrating(false);
                        perfLog('replay.hydration_task', {
                            kind: 'deferred',
                            phase: 'cancel',
                            taskId: deferredTaskId,
                            ms: Math.round(performance.now() - deferredStart),
                            abortedIn: 'eager',
                        });
                        return;
                    }
                    perfLog('replay.eager_done', { ms: Math.round(performance.now() - eagerStart) });
                    const parallelHydrationLayers = backgroundDeferredReplayLayers.filter((layerId) => shouldRunReplayHydrationInParallel(layerId));
                    let parallelHydrationPromise: Promise<boolean[]> | null = null;
                    if (parallelHydrationLayers.length > 0) {
                        const parallelTaskId = `parallel-hydration|${layersKey}|${currentIso}|${Date.now()}`;
                        perfLog('replay.hydration_task', {
                            kind: 'parallel-hydration',
                            phase: 'start',
                            taskId: parallelTaskId,
                            currentIso,
                            layers: parallelHydrationLayers,
                        });
                        parallelHydrationPromise = Promise.all(parallelHydrationLayers.map(async (layerId) => {
                            const t0 = performance.now();
                            try {
                                const ok = await syncLayerState(layerId, currentIso, isCancelled);
                                if (!ok || isCancelled()) return false;
                                publishReplayStats();
                                perfLog('replay.hydration_task', {
                                    kind: 'parallel-hydration',
                                    phase: 'layer-end',
                                    taskId: parallelTaskId,
                                    layer: layerId,
                                    ms: Math.round(performance.now() - t0),
                                });
                                return true;
                            } catch (error: any) {
                                if (isCancelled()) return false;
                                const message = error?.message || String(error);
                                console.error('[ReplayOverlay] parallel hydration failed:', layerId, message);
                                perfLog('replay.hydration_task', {
                                    kind: 'parallel-hydration',
                                    phase: 'layer-error',
                                    taskId: parallelTaskId,
                                    layer: layerId,
                                    error: message,
                                });
                                return false;
                            }
                        }));
                    }

                    const bgStart = performance.now();
                    const backgroundSerialLayers = backgroundDeferredReplayLayers
                        .filter((layerId) => !shouldRunReplayHydrationInParallel(layerId))
                        .sort((a, b) => {
                            const aPriority = getReplaySeekPriority(a);
                            const bPriority = getReplaySeekPriority(b);
                            return aPriority - bPriority;
                        });

                    const bgResults: boolean[] = [];
                    for (const layerId of backgroundSerialLayers) {
                        if (isCancelled()) { bgResults.push(false); break; }
                        const t0 = performance.now();
                        const ok = await syncLayerState(layerId, currentIso, isCancelled);
                        perfLog('replay.bg_layer', { layer: layerId, ms: Math.round(performance.now() - t0), ok });
                        bgResults.push(ok);
                    }
                    if (parallelHydrationPromise) {
                        const t0 = performance.now();
                        const results = await parallelHydrationPromise;
                        perfLog('replay.bg_parallel_layers', {
                            layers: parallelHydrationLayers,
                            ms: Math.round(performance.now() - t0),
                            ok: results.every(Boolean),
                        });
                        bgResults.push(...results);
                    }
                    if (isCancelled() || bgResults.some((r) => !r)) {
                        // Codex: прежняя ветка не снимала hydrating при
                        // частичном провале bg → Play оставался disabled
                        // навсегда. Снимаем gate только если это не отмена
                        // (на отмену новый seek сам поставит hydrating=true).
                        if (!isCancelled()) setReplayHydrating(false);
                        perfLog('replay.hydration_task', {
                            kind: 'deferred',
                            phase: 'cancel',
                            taskId: deferredTaskId,
                            ms: Math.round(performance.now() - deferredStart),
                            abortedIn: 'background',
                        });
                        return;
                    }
                    perfLog('replay.bg_done', { ms: Math.round(performance.now() - bgStart) });
                    if (isCancelled()) {
                        perfLog('replay.hydration_task', {
                            kind: 'deferred',
                            phase: 'cancel',
                            taskId: deferredTaskId,
                            ms: Math.round(performance.now() - deferredStart),
                            abortedIn: 'post-bg',
                        });
                        return;
                    }
                    const mergedLayerTimes = new Map(lastAppliedLayerTimeRef.current);
                    for (const layerId of sortedReplayLayers) {
                        if (!mergedLayerTimes.has(layerId)) mergedLayerTimes.set(layerId, currentIso);
                    }
                    lastAppliedLayerTimeRef.current = mergedLayerTimes;
                    lastBufferedLayerTimeRef.current = new Map(mergedLayerTimes);
                    publishReplayStats();
                    releaseReplayHydrationIfReady();
                    perfLog('replay.hydration_task', {
                        kind: 'deferred',
                        phase: 'end',
                        taskId: deferredTaskId,
                        ms: Math.round(performance.now() - deferredStart),
                    });
                })().catch((error: any) => {
                    if (isCancelled()) return;
                    const message = error?.message || String(error);
                    console.error('[ReplayOverlay] deferred seek hydration failed:', message);
                    setReplayError(`Replay deferred hydration failed: ${message}`);
                    // Освобождаем Play даже при ошибке bg-гидрации: UI
                    // покажет replayError, но не залочится навсегда.
                    setReplayHydrating(false);
                    perfLog('replay.hydration_task', {
                        kind: 'deferred',
                        phase: 'error',
                        taskId: deferredTaskId,
                        ms: Math.round(performance.now() - deferredStart),
                        error: message,
                    });
                }).finally(() => {
                    replayHydrationInflightRef.current = Math.max(0, replayHydrationInflightRef.current - 1);
                    releaseReplayHydrationIfReady();
                });
                return;
            }
            if (isCancelled()) return;
            lastAppliedTimeRef.current = currentIso;
            layersKeyRef.current = layersKey;
            publishReplayStats();
        };

        replayOperationIdRef.current = operationId;
        replayBusyRef.current = true;
        replayPendingRef.current = false;

        void fetchReplay()
            .catch((error: any) => {
                if (isCancelled()) return;
                const message = error?.message || String(error);
                console.error('[ReplayOverlay] fetch failed:', message);
                setReplayError(`Replay fetch failed: ${message}`);
                setReplayHydrating(false);
            })
            .finally(() => {
                if (seekRequestRef.current?.targetMs === targetMs && seekRequestRef.current?.reason === explicitSeekRequest?.reason) {
                    seekRequestRef.current = null;
                }
                if (!isCurrentOperation()) {
                    publishReplayStats();
                    return;
                }
                if (cancelVersion !== replayCancelVersionRef.current) {
                    replayBusyRef.current = false;
                    if (replayPendingRef.current) {
                        replayPendingRef.current = false;
                        setReplayDrainVersion((version) => version + 1);
                    }
                    releaseReplayHydrationIfReady();
                    publishReplayStats();
                    return;
                }
                replayBusyRef.current = false;
                if (replayPendingRef.current) {
                    replayPendingRef.current = false;
                    setReplayDrainVersion((version) => version + 1);
                }
                releaseReplayHydrationIfReady();
                publishReplayStats();
            });
    }, [viewer, mode, playbackKind, replaySeekVersion, layersKey, activeReplayLayers, replayDrainVersion, replayViewportVersion, setReplayHydrating]);

    useEffect(() => {
        if (!viewer || mode !== 'playback' || playbackKind !== 'historical') return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const tick = () => {
            if (cancelled || viewer.isDestroyed()) return;
            const state = useTimelineStore.getState();
            if (
                state.mode === 'playback'
                && state.playbackKind === 'historical'
                && state.replayHydrating
                && !replayBusyRef.current
                && !replayPendingRef.current
                && replayHydrationInflightRef.current === 0
                && (replaySnapshotHasVisibleContent() || Boolean(lastAppliedTimeRef.current))
            ) {
                setReplayHydrating(false);
                publishReplayStats();
            }
            timer = setTimeout(tick, 500);
        };

        tick();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [viewer, mode, playbackKind, setReplayHydrating]);

    useEffect(() => {
        if (!viewer || mode !== 'playback' || playbackKind !== 'historical') return;
        let cancelled = false;
        const tick = async () => {
            if (cancelled || viewer.isDestroyed()) return;
            const state = useTimelineStore.getState();
            if (state.mode !== 'playback' || state.playbackKind !== 'historical' || !state.isPlaying) return;
            if (replayBusyRef.current) return;
            // Codex round-6 fix: gate playback refresh on detached
            // hydration (warm-prime + deferred). Previously playbackRefresh
            // started on top of still-running hydration, causing duplicate
            // pipeline/airspace work and 5s frame_render spikes from
            // double primitive rebuilds.
            if (replayHydrationInflightRef.current > 0) return;
            const currentMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
            const currentIso = new Date(currentMs).toISOString();
            const tickCancelVersion = replayCancelVersionRef.current;
            const sortedReplayLayers = [...activeReplayLayers].sort((a, b) => {
                const aPriority = getReplayPlaybackPriority(a);
                const bPriority = getReplayPlaybackPriority(b);
                return aPriority - bPriority;
            });
            try {
                // Refresh moving layers first. Event/static layers can lag a
                // tick; they must not start a request burst that delays
                // aircraft/vessel/satellite delta application.
                const dueReplayLayers = sortedReplayLayers.filter((layerId) => {
                    if (playbackRefreshBusyLayersRef.current.has(layerId)) return false;
                    const cadenceMs = getReplayPlaybackRefreshSeconds(layerId) * 1000;
                    const appliedIso = lastAppliedLayerTimeRef.current.get(layerId);
                    const appliedMs = appliedIso ? new Date(appliedIso).getTime() : Number.NEGATIVE_INFINITY;
                    if (currentMs >= appliedMs && currentMs - appliedMs < cadenceMs) return false;
                    return true;
                });
                const criticalDueLayers = dueReplayLayers.filter((layerId) => isReplayCriticalDeltaLayer(layerId));
                const observedCriticalDueLayers = criticalDueLayers.filter((layerId) => isReplayMovingFixLayer(layerId));
                const computedMotionDueLayers = observedCriticalDueLayers.length === 0
                    ? criticalDueLayers.filter((layerId) => !isReplayMovingFixLayer(layerId))
                    : [];
                const criticalBusy = Array.from(playbackRefreshBusyLayersRef.current).some(
                    (layerId) => isReplayCriticalDeltaLayer(layerId),
                );
                const backgroundBusy = Array.from(playbackRefreshBusyLayersRef.current).some(
                    (layerId) => !isReplayCriticalDeltaLayer(layerId),
                );
                const backgroundDueLayers = backgroundBusy || criticalBusy || criticalDueLayers.length > 0
                    ? []
                    : dueReplayLayers
                        .filter((layerId) => !isReplayCriticalDeltaLayer(layerId))
                        .slice(0, 1);
                const layersToRefresh = [...observedCriticalDueLayers, ...computedMotionDueLayers, ...backgroundDueLayers];
                await Promise.all(layersToRefresh.map(async (layerId) => {
                    playbackRefreshBusyLayersRef.current.add(layerId);
                    try {
                        const appliedIso = lastAppliedLayerTimeRef.current.get(layerId);
                        perfLog('replay.playback_refresh', {
                            layer: layerId,
                            currentIso,
                            appliedIso: appliedIso ?? null,
                            clockMultiplier: viewer.clock.multiplier,
                            shouldAnimate: viewer.clock.shouldAnimate,
                        });
                        const isCancelled = () => cancelled || replayCancelVersionRef.current !== tickCancelVersion;
                        const lastMotionFullSyncMs = replayMotionFullSyncAtRef.current.get(layerId) ?? Number.NEGATIVE_INFINITY;
                        const motionModel = isReplayMotionLayer(layerId) ? getReplayMotionModel(layerId) : 'none';
                        const needsMotionFullSync = isReplayMotionLayer(layerId)
                            && (
                                motionModel === 'tle_sgp4'
                                || currentMs - lastMotionFullSyncMs >= getReplayMotionTrackRefreshSeconds(layerId) * 1000
                            );
                        if (needsMotionFullSync) {
                            await syncLayerState(
                                layerId,
                                currentIso,
                                isCancelled,
                            );
                            return;
                        }
                        const delta = await applyReplayRenderPointDeltaLayer(layerId, currentIso, isCancelled, appliedIso);
                        if (!delta?.applied || delta.needsFullSync) {
                            await syncLayerState(
                                layerId,
                                currentIso,
                                isCancelled,
                            );
                        }
                    } finally {
                        playbackRefreshBusyLayersRef.current.delete(layerId);
                    }
                }));
                if (cancelled || replayCancelVersionRef.current !== tickCancelVersion) return;
                lastAppliedTimeRef.current = currentIso;
                publishReplayStats();
            } catch (error: any) {
                if (cancelled || replayCancelVersionRef.current !== tickCancelVersion) return;
                const message = error?.message || String(error);
                console.error('[ReplayOverlay] playback refresh failed:', message);
                setReplayError(`Replay playback refresh failed: ${message}`);
            }
        };
        const interval = setInterval(() => {
            void tick();
        }, 150);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [viewer, mode, playbackKind, activeReplayLayers]);

    // First imperative seam extracted from this god-hook (codex challenge
    // 2026-04-22): replay trails overlay is now an independent effect with
    // its own AbortController, setInterval, and TrailBatcher lifecycle.
    // Behavior is byte-for-byte identical to the previous inline effect.
    useReplayTrailsOverlay({
        viewer,
        mode,
        playbackKind,
        showTrajectories,
        activeReplayLayers,
        layersKey,
        replaySeekVersion,
        cancelVersionRef: replayCancelVersionRef,
    });
}
