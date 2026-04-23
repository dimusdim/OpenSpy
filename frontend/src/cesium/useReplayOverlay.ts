import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { perfLog } from '../lib/perf-log';
import { withSpan } from '../lib/otel';
import { getAviIcon, getConflictIcon, getDisasterIcon, getMapIcon, getOutageIcon, getSatIcon, getShipIcon, svgUri } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';
import { getLayerSourceVisibilityKey, normalizeLayerSourceId } from '../lib/source-visibility';
import { ReplayShapeBatch, type ReplayShapeDescriptor } from './replayShapeBatch';
import { ReplayTileCache, type ReplayManifest, type ReplayTilePayload } from './replayTileCache';
import { createSatellitePositionsSAB, type SatellitePositionsSAB } from './satellitePositionsSAB';
import { clearSatelliteApplySource, setSatelliteApplySource, type SatelliteApplySlot } from './satelliteApplyManager';
import { useReplayTrailsOverlay } from './useReplayTrailsOverlay';

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
    // Reduced to just the two samples the motion worker needs:
    // `prev` (latest observation ≤ atMs) and `next` (earliest > atMs).
    // Keeping the full per-entity array would be O(window × fleet
    // size) — tens of MB on long replays / dense vessel manifests.
    motionSamples?: Map<string, { prev?: ReplayMotionSampleRaw; next?: ReplayMotionSampleRaw }>;
};

type ReplayWindowItem =
    | {
        at: string;
        family: 'entity';
        op: 'upsert';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        item: ReplayEntity;
    }
    | {
        at: string;
        family: 'entity';
        op: 'remove';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        entity_id: string;
        reason: string;
    }
    | {
        at: string;
        family: 'event';
        op: 'upsert';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        item: ReplayEvent;
    }
    | {
        at: string;
        family: 'event';
        op: 'remove';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        event_id: string;
        reason: string;
    }
    | {
        at: string;
        family: 'asset';
        op: 'upsert';
        target_id: string;
        layer_id: string;
        source_id: string | null;
        item: ReplayAsset;
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

type ReplaySatelliteTleResponse = {
    mode: 'historical-replay';
    replay_kind: 'satellite-tle';
    at: string;
    count: number;
    items: ReplaySatelliteTleItem[];
};

type ReplayMotionSample = {
    atMs: number;
    position: [number, number, number];
};

type ReplayMotionTrack = {
    previous: ReplayMotionSample;
    next: ReplayMotionSample | null;
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
            samples: ReplayMeta[];
        };
        __openspyReplayMetaLookup?: (id: string) => ReplayMeta | null;
    }
}

const REPLAY_LAYER_MAP = {
    aviation: 'aircraft',
    maritime: 'vessel',
    satellites: 'satellite',
    disasters: 'disasters',
    fires: 'fire',
    jamming: 'jamming',
    cables: 'cable',
    pipelines: 'pipeline',
    outages: 'outage',
    conflicts: 'conflict',
    airspace: 'airspace',
    gfw: 'gfw',
} as const;

const REPLAY_CANONICAL_STORE_KEYS = Object.keys(REPLAY_LAYER_MAP) as Array<keyof typeof REPLAY_LAYER_MAP>;
const REPLAY_SEEK_LAYER_PRIORITY: Record<string, number> = {
    satellite: 0,
    aircraft: 1,
    vessel: 2,
    disasters: 3,
    fire: 4,
    outage: 5,
    jamming: 6,
    gfw: 7,
    conflict: 8,
    cable: 9,
    pipeline: 10,
    airspace: 11,
};
// Codex round-7 fix (2026-04-21): satellite removed from primary set.
// Satellite TLE path is ~19 MB JSON + 5k billboard rebuild on main thread,
// gating `replayHydrating=false` for 20+ seconds even after vessel/aircraft
// are visually painted. The TimelinePlayer disables controls while
// replayHydrating is true, so users couldn't scrub even though the screen
// looked ready. Satellite is now demoted to deferred-eager — appears soon
// after, but doesn't block interaction.
const REPLAY_SEEK_PRIMARY_LAYERS = ['aircraft', 'vessel'] as const;
const REPLAY_SEEK_SECONDARY_LAYERS = ['disasters', 'fire', 'outage', 'jamming', 'gfw', 'conflict'] as const;
const REPLAY_PLAY_LAYER_CADENCE_SECONDS: Record<string, number> = {
    aircraft: 90,
    vessel: 10,
    satellite: 1,
    disasters: 300,
    fire: 300,
    jamming: 300,
    cable: 900,
    pipeline: 900,
    outage: 300,
    conflict: 300,
    airspace: 1800,
    gfw: 1800,
};
const REPLAY_LAYER_LIMITS: Partial<Record<string, number>> = {
    satellite: 5000,
    fire: 50000,
};
const REPLAY_APPLY_CHUNK_SIZE: Partial<Record<string, number>> = {
    satellite: 500,
    aircraft: 400,
    vessel: 300,
    disasters: 500,
    outage: 500,
    jamming: 500,
    fire: 500,
    airspace: 100,
    pipeline: 150,
    cable: 150,
    conflict: 250,
};
const REPLAY_PLAY_LAYER_PRIORITY: Record<string, number> = {
    satellite: 0,
    vessel: 1,
    aircraft: 2,
    disasters: 3,
    fire: 4,
    outage: 5,
    jamming: 6,
    gfw: 7,
    conflict: 8,
    cable: 9,
    pipeline: 10,
    airspace: 11,
};
const REPLAY_MOVING_LAYERS = new Set<string>(['aircraft', 'vessel']);
const REPLAY_POINT_ICON_DEFAULT = svgUri('<circle cx="12" cy="12" r="6" fill="#06b6d4"/>');
const REPLAY_JAM_HIGH = svgUri('<circle cx="12" cy="12" r="7" fill="#ef4444"/>');
const REPLAY_JAM_MEDIUM = svgUri('<circle cx="12" cy="12" r="7" fill="#f97316"/>');
const REPLAY_JAM_LOW = svgUri('<circle cx="12" cy="12" r="7" fill="#eab308"/>');
const REPLAY_FIRE_HIGH = svgUri('<circle cx="12" cy="12" r="7" fill="#ef4444"/>');
const REPLAY_FIRE_MEDIUM = svgUri('<circle cx="12" cy="12" r="7" fill="#f97316"/>');
const REPLAY_FIRE_LOW = svgUri('<circle cx="12" cy="12" r="7" fill="#eab308"/>');

function toHudLayerName(layerId: string): string {
    switch (layerId) {
        case 'aircraft': return 'Aircraft';
        case 'vessel': return 'Vessel';
        case 'satellite': return 'Satellite';
        case 'disasters': return 'Disaster';
        case 'fire': return 'Fire';
        case 'jamming': return 'Jamming';
        case 'cable': return 'Cable';
        case 'pipeline': return 'Pipeline';
        case 'outage': return 'Outage';
        case 'conflict': return 'Conflict';
        case 'airspace': return 'Airspace';
        case 'gfw': return 'GFW';
        default: return layerId;
    }
}

function toStoreLayerKey(layerId: string): keyof typeof REPLAY_LAYER_MAP | null {
    for (const [storeKey, replayLayerId] of Object.entries(REPLAY_LAYER_MAP)) {
        if (replayLayerId === layerId) return storeKey as keyof typeof REPLAY_LAYER_MAP;
    }
    return null;
}

function normalizeReplayId(id: string): string {
    return id.startsWith('sat-') ? id.replace(/^sat-/, 'satellite:') : id;
}

function getPointIcon(layerId: string, subtype: string | null | undefined, item: any): string {
    if (layerId === 'aircraft') return getAviIcon(subtype || 'general');
    if (layerId === 'vessel') return getShipIcon(subtype || 'unknown');
    if (layerId === 'satellite') {
        const isRecon = subtype === 'recon' || Boolean(item?.entity_properties?.recon) || Boolean(item?.entity_properties?.reconMeta);
        return getSatIcon(subtype || 'civilian', isRecon);
    }
    if (layerId === 'disasters') {
        const alert = item?.properties?.alertLevel || item?.properties?.alert_level || 'Green';
        return getDisasterIcon(subtype || 'EQ', alert);
    }
    if (layerId === 'conflict') return getConflictIcon(item?.properties?.event_type || subtype || 'violence');
    if (layerId === 'outage') return getOutageIcon(subtype || 'warning');
    if (layerId === 'fire') {
        if (item?.properties?.aggregated) {
            if (subtype === 'high') return REPLAY_FIRE_HIGH;
            if (subtype === 'medium') return REPLAY_FIRE_MEDIUM;
            return REPLAY_FIRE_LOW;
        }
        return getMapIcon('fires', subtype || 'high') || REPLAY_POINT_ICON_DEFAULT;
    }
    if (layerId === 'gfw') return getMapIcon('gfw', 'default') || REPLAY_POINT_ICON_DEFAULT;
    if (layerId === 'jamming') {
        if (subtype === 'high') return REPLAY_JAM_HIGH;
        if (subtype === 'medium') return REPLAY_JAM_MEDIUM;
        return REPLAY_JAM_LOW;
    }
    return REPLAY_POINT_ICON_DEFAULT;
}

function getFillColor(layerId: string, subtype: string | null | undefined): Cesium.Color {
    switch (layerId) {
        case 'airspace':
            return Cesium.Color.RED.withAlpha(0.16);
        case 'conflict':
            return Cesium.Color.ORANGE.withAlpha(0.12);
        case 'disasters':
            return Cesium.Color.CYAN.withAlpha(0.12);
        case 'pipeline':
            return subtype === 'gas' ? Cesium.Color.CYAN.withAlpha(0.8) : Cesium.Color.ORANGE.withAlpha(0.8);
        case 'cable':
            return Cesium.Color.DEEPSKYBLUE.withAlpha(0.4);
        default:
            return Cesium.Color.CYAN.withAlpha(0.15);
    }
}

function getStrokeColor(layerId: string, subtype: string | null | undefined): Cesium.Color {
    switch (layerId) {
        case 'airspace':
            return Cesium.Color.RED.withAlpha(0.7);
        case 'pipeline':
            return subtype === 'gas' ? Cesium.Color.CYAN : Cesium.Color.ORANGE;
        case 'cable':
            return Cesium.Color.DEEPSKYBLUE;
        case 'conflict':
            return Cesium.Color.ORANGE;
        default:
            return Cesium.Color.CYAN;
    }
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
    const isolatedEntityId = useTimelineStore((s) => s.isolatedEntityId);
    const satelliteRenderLimit = useTimelineStore((s) => s.satelliteRenderLimit);

    const pointCollectionRef = useRef<Cesium.BillboardCollection | null>(null);
    const pointMapRef = useRef<Map<string, Cesium.Billboard>>(new Map());
    const pointSignatureRef = useRef<Map<string, string>>(new Map());
    const shapeBatchRef = useRef<Map<string, ReplayShapeBatch>>(new Map());
    const shapeMapRef = useRef<Map<string, string[]>>(new Map());
    const targetLayerMapRef = useRef<Map<string, string>>(new Map());
    const layerCountsRef = useRef<Map<string, number>>(new Map());
    const motionTrackMapRef = useRef<Map<string, ReplayMotionTrack>>(new Map());
    // Per-entity high-water-mark for motion apply (atMs of the state
    // that wrote the current track). Prevents a slow earlier apply
    // from clobbering a fast later apply's fresher track.
    const motionTrackAppliedAtRef = useRef<Map<string, number>>(new Map());
    const tileCacheRef = useRef<ReplayTileCache | null>(null);
    const manifestCacheRef = useRef<Map<string, ReplayManifest>>(new Map());
    // When a manifest was fetched from the server, in ms. Used to expire
    // hot-bucket manifests per-layer so fresh position_fixes land on the
    // client instead of being pinned by a stale content_hash.
    const manifestFetchedAtRef = useRef<Map<string, number>>(new Map());
    const manifestFlightRef = useRef<Map<string, Promise<ReplayManifest>>>(new Map());
    const replaySatelliteWorkerRef = useRef<Worker | null>(null);
    const replaySatelliteSabRef = useRef<SatellitePositionsSAB | null>(null);
    const replaySatelliteApplySlotsRef = useRef<SatelliteApplySlot[]>([]);
    const replaySatelliteLastTickAtRef = useRef(0);
    const replaySatelliteLastEpochMsRef = useRef<number | null>(null);
    const replayMotionSabRef = useRef<SatellitePositionsSAB | null>(null);
    const replayMotionApplySlotsRef = useRef<SatelliteApplySlot[]>([]);
    const replayMotionLastEpochMsRef = useRef<number | null>(null);
    const replayMotionLastAppliedEpochMsRef = useRef<number | null>(null);
    const lastAppliedTimeRef = useRef<string | null>(null);
    const lastAppliedSeekVersionRef = useRef<number>(useTimelineStore.getState().replaySeekVersion);
    const lastVisibleTimeRef = useRef<string | null>(null);
    const lastVisibleSeekVersionRef = useRef<number>(0);
    const lastAppliedLayerTimeRef = useRef<Map<string, string>>(new Map());
    const lastBufferedLayerTimeRef = useRef<Map<string, string>>(new Map());
    const replayErrorRef = useRef<string | null>(null);
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
    const seekRequestRef = useRef<{ targetMs: number; reason: 'user-seek' | 'mode-change' | 'layers-change' } | null>(null);
    const replayBusyRef = useRef(false);
    const replayPendingRef = useRef(false);
    const playbackRefreshBusyRef = useRef(false);
    const replayCancelVersionRef = useRef(0);
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

    const activeReplayLayers = useMemo(() => {
        return REPLAY_CANONICAL_STORE_KEYS
            .filter((storeKey) => sources[storeKey] && visibility[storeKey])
            .map((storeKey) => REPLAY_LAYER_MAP[storeKey]);
    }, [sources, visibility]);

    const layersKey = activeReplayLayers.join(',');
    const requestSceneRender = () => {
        if (!viewer || viewer.isDestroyed()) return;
        viewer.scene.requestRender();
    };
    const setReplayError = (message: string | null) => {
        replayErrorRef.current = message;
        runtimePerfRef.current.error = message;
        publishReplayStats();
    };
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
    const destroyReplaySatelliteWorker = () => {
        if (replaySatelliteWorkerRef.current) {
            replaySatelliteWorkerRef.current.terminate();
            replaySatelliteWorkerRef.current = null;
        }
        if (viewer && !viewer.isDestroyed()) clearSatelliteApplySource(viewer.scene, 'replay');
        replaySatelliteSabRef.current = null;
        replaySatelliteApplySlotsRef.current = [];
        replaySatelliteLastTickAtRef.current = 0;
        replaySatelliteLastEpochMsRef.current = null;
        replayMotionSabRef.current = null;
        replayMotionApplySlotsRef.current = [];
        replayMotionLastEpochMsRef.current = null;
        replayMotionLastAppliedEpochMsRef.current = null;
    };
    if (!tileCacheRef.current) {
        tileCacheRef.current = new ReplayTileCache(API_URL);
    }
    const getReplayLayerLimit = (layerId: string): number | null => {
        if (layerId === 'satellite') {
            return satelliteRenderLimit ?? REPLAY_LAYER_LIMITS.satellite ?? null;
        }
        return REPLAY_LAYER_LIMITS[layerId] ?? null;
    };
    const getReplayApplyChunkSize = (layerId: string): number => REPLAY_APPLY_CHUNK_SIZE[layerId] ?? 500;
    const waitForRenderTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const updateRuntimeQueueLength = () => {
        runtimePerfRef.current.queuedItems = 0;
    };
    const getLayerBucketSeconds = (layerId: string) => {
        switch (layerId) {
            case 'aircraft':
            case 'vessel':
                return 10 * 60;
            case 'conflict':
            case 'disasters':
            case 'outage':
            case 'jamming':
            case 'fire':
            case 'gfw':
                return 60 * 60;
            case 'airspace':
            case 'pipeline':
            case 'cable':
                return 24 * 60 * 60;
            default:
                return 60 * 60;
        }
    };
    // Per-layer TTL must mirror backend getHotBucketTtlSeconds — this is
    // how long a cached manifest for a layer can be reused while its
    // current bucket is still open. null = "layer data doesn't move, so
    // an open bucket is fine to cache indefinitely" (e.g. airspace).
    const getLayerHotTtlMs = (layerId: string): number | null => {
        switch (layerId) {
            case 'aircraft':
            case 'vessel':
                return 15 * 1000;
            case 'conflict':
            case 'disasters':
            case 'outage':
            case 'jamming':
            case 'fire':
            case 'gfw':
                return 60 * 1000;
            case 'airspace':
            case 'pipeline':
            case 'cable':
                return null;
            default:
                return 60 * 1000;
        }
    };
    const getGroupedManifestRange = (layerIds: string[], centerIso: string, paddingBuckets = 1) => {
        const centerMs = new Date(centerIso).getTime();
        let fromMs = centerMs;
        let toMs = centerMs;
        for (const layerId of layerIds) {
            const bucketMs = getLayerBucketSeconds(layerId) * 1000;
            const bucketStartMs = Math.floor(centerMs / bucketMs) * bucketMs;
            // Codex round-6 fix (2026-04-21): for daily-bucket static
            // layers (airspace/pipeline/cable/borders/infrastructure),
            // padding=1 expands a single seek into 4 daily tiles =
            // 90+ MB of msgpack work that rebuildStateFromTilePayloads
            // immediately discards (snapshots > atMs). Force padding=0
            // for these — the current bucket already contains the
            // whole-day snapshot.
            // Trade-off: cross-midnight playback now needs an extra
            // bucket fetch when the clock crosses 00:00 UTC. That cost
            // is one bucket per day per layer, infinitely cheaper than
            // the 4× overfetch on every seek.
            const effectivePadding = bucketMs >= 24 * 3600 * 1000 ? 0 : paddingBuckets;
            fromMs = Math.min(fromMs, bucketStartMs - effectivePadding * bucketMs);
            toMs = Math.max(toMs, bucketStartMs + (effectivePadding + 1) * bucketMs);
        }
        // Codex round-7 fix (2026-04-21): backend bucketRange() is closed/
        // inclusive (`while (t <= toMs)` in replay-tile-builder.service.ts:194),
        // so a half-open frontend window like [bucketStart, bucketStart+1*bucket)
        // becomes 2 buckets server-side because the upper bound EXACTLY equals
        // the next bucket start. Subtracting 1 ms from toMs converts the
        // window to truly half-open and shrinks 2→1 (static), 4→3 (moving)
        // without touching backend semantics (used in hot-bucket detection
        // and build paths).
        return {
            fromIso: new Date(fromMs).toISOString(),
            toIso: new Date(toMs - 1).toISOString(),
        };
    };
    const getManifestCacheKey = (layerIds: string[], fromIso: string, toIso: string) =>
        `${fromIso}|${toIso}|${[...layerIds].sort().join(',')}|z0|global`;
    // Reject the cached manifest if the requested window overlaps any
    // open bucket of a hot-TTL layer AND the cache is older than that
    // TTL. This is the client-side half of the backend hot-bucket
    // freshness policy — backend rebuilds the tile with a new
    // content_hash, so a cached manifest pointing at the old hash
    // would keep the client on stale tile URLs.
    const isManifestStaleForHotBuckets = (
        layerIds: string[],
        fetchedAtMs: number,
        requestedFromMs: number,
        requestedToMs: number,
    ): boolean => {
        const nowMs = Date.now();
        for (const layerId of layerIds) {
            const ttlMs = getLayerHotTtlMs(layerId);
            if (ttlMs === null) continue;
            const bucketMs = getLayerBucketSeconds(layerId) * 1000;
            const startMs = Math.floor(requestedFromMs / bucketMs) * bucketMs;
            for (let t = startMs; t <= requestedToMs; t += bucketMs) {
                const bucketEndMs = t + bucketMs;
                if (bucketEndMs > nowMs) {
                    // open bucket inside requested window
                    if (nowMs - fetchedAtMs > ttlMs) return true;
                }
            }
        }
        return false;
    };
    const findCachedManifest = (layerIds: string[], fromIso: string, toIso: string): ReplayManifest | null => {
        const requestedLayersKey = [...layerIds].sort().join(',');
        const requestedFromMs = new Date(fromIso).getTime();
        const requestedToMs = new Date(toIso).getTime();
        for (const [cacheKey, manifest] of Array.from(manifestCacheRef.current.entries())) {
            const keyParts = cacheKey.split('|');
            const cachedLayersKey = keyParts[2] || '';
            if (cachedLayersKey !== requestedLayersKey) continue;
            const manifestFromMs = new Date(manifest.from).getTime();
            const manifestToMs = new Date(manifest.to).getTime();
            if (manifestFromMs <= requestedFromMs && manifestToMs >= requestedToMs) {
                const fetchedAtMs = manifestFetchedAtRef.current.get(cacheKey) ?? 0;
                if (isManifestStaleForHotBuckets(layerIds, fetchedAtMs, requestedFromMs, requestedToMs)) {
                    // evict and skip
                    manifestCacheRef.current.delete(cacheKey);
                    manifestFetchedAtRef.current.delete(cacheKey);
                    continue;
                }
                return manifest;
            }
        }
        return null;
    };
    const scheduleIdlePrefetch = (task: () => void) => {
        if (typeof window === 'undefined') return;
        if ('requestIdleCallback' in window) {
            (window as any).requestIdleCallback(() => task(), { timeout: 250 });
            return;
        }
        globalThis.setTimeout(task, 0);
    };
    const fetchManifestForGroup = async (groupLayers: string[], centerIso: string, paddingBuckets: number): Promise<ReplayManifest> => {
        const range = getGroupedManifestRange(groupLayers, centerIso, paddingBuckets);
        const cached = findCachedManifest(groupLayers, range.fromIso, range.toIso);
        if (cached) return cached;
        const cacheKey = getManifestCacheKey(groupLayers, range.fromIso, range.toIso);
        const inFlight = manifestFlightRef.current.get(cacheKey);
        if (inFlight) return inFlight;
        const promise = (async () => {
            try {
                const params = new URLSearchParams({
                    from: range.fromIso,
                    to: range.toIso,
                    layers: groupLayers.join(','),
                    z: '0',
                });
                const response = await axios.get<ReplayManifest>(`${API_URL}/api/replay/manifest?${params.toString()}`);
                // Diagnostic: log actual tile count per layer in this manifest.
                // Codex round-5 (2026-04-21) suspected padded windows produce
                // 4 daily global tiles for static layers (airspace/pipeline/cable)
                // even though rebuildStateFromTilePayloads drops snapshots > atMs.
                try {
                    const tileBreakdown: Record<string, { tiles: number; bytes: number }> = {};
                    for (const layerId of Object.keys(response.data.layers || {})) {
                        const layer = response.data.layers[layerId];
                        tileBreakdown[layerId] = {
                            tiles: layer.tiles?.length ?? 0,
                            bytes: layer.tiles?.reduce((acc, t) => acc + (t.bytes || 0), 0) ?? 0,
                        };
                    }
                    perfLog('replay.manifest_buckets', {
                        cacheKey,
                        from: response.data.from,
                        to: response.data.to,
                        layers: groupLayers,
                        breakdown: tileBreakdown,
                    });
                } catch {}
                manifestCacheRef.current.set(cacheKey, response.data);
                manifestFetchedAtRef.current.set(cacheKey, Date.now());
                // LRU-trim: a long session with many seeks accumulates
                // manifests indefinitely. 32 entries covers typical
                // scrubbing without unbounded growth; eviction order
                // is insertion order (Map preserves it), which is a
                // close-enough approximation of LRU for our churn.
                const MAX_MANIFEST_CACHE = 32;
                while (manifestCacheRef.current.size > MAX_MANIFEST_CACHE) {
                    const oldest = manifestCacheRef.current.keys().next().value;
                    if (!oldest) break;
                    manifestCacheRef.current.delete(oldest);
                    manifestFetchedAtRef.current.delete(oldest);
                }
                // No background prefetch from manifest. Codex round-6 review
                // (2026-04-21) showed that even tiny event-layer prefetches
                // started at manifest-fetch time put bytes on the wire BEFORE
                // first_visible, contributing to overlap with foreground
                // hydration. The deferred-hydration pipeline already fetches
                // these layers explicitly later; manifest stays a pure planning
                // step now.
                for (const layerId of groupLayers) {
                    lastBufferedLayerTimeRef.current.set(layerId, response.data.to);
                }
                return response.data;
            } catch (error: any) {
                const message = error?.message || String(error);
                console.error('[ReplayOverlay] grouped manifest failed:', message);
                setReplayError(`Replay manifest failed: ${message}`);
                throw error;
            } finally {
                manifestFlightRef.current.delete(cacheKey);
            }
        })();
        manifestFlightRef.current.set(cacheKey, promise);
        return promise;
    };

    const getWindowManifest = async (layerIds: string[], centerIso: string, paddingBuckets = 1): Promise<ReplayManifest> => {
        const normalizedLayers = Array.from(new Set(layerIds.filter((layerId) => layerId !== 'satellite')));
        if (normalizedLayers.length === 0) {
            return {
                from: centerIso,
                to: centerIso,
                layers: {},
            };
        }
        // Group layers by bucketSeconds — otherwise a 24h-bucket layer
        // (airspace/cable/pipeline) inflates the window for 10-min-bucket
        // layers (aircraft/vessel) into a 3-day request with 200+ tiles.
        const groups = new Map<number, string[]>();
        for (const layerId of normalizedLayers) {
            const bs = getLayerBucketSeconds(layerId);
            const arr = groups.get(bs) || [];
            arr.push(layerId);
            groups.set(bs, arr);
        }
        const groupManifests = await Promise.all(
            Array.from(groups.values()).map((g) => fetchManifestForGroup(g.slice().sort(), centerIso, paddingBuckets)),
        );
        const merged: ReplayManifest = {
            from: groupManifests[0]?.from || centerIso,
            to: groupManifests[0]?.to || centerIso,
            layers: {},
        };
        let fromMs = Number.POSITIVE_INFINITY;
        let toMs = Number.NEGATIVE_INFINITY;
        for (const m of groupManifests) {
            const fm = new Date(m.from).getTime();
            const tm = new Date(m.to).getTime();
            if (fm < fromMs) fromMs = fm;
            if (tm > toMs) toMs = tm;
            for (const [k, v] of Object.entries(m.layers)) {
                merged.layers[k] = v;
            }
        }
        if (Number.isFinite(fromMs)) merged.from = new Date(fromMs).toISOString();
        if (Number.isFinite(toMs)) merged.to = new Date(toMs).toISOString();
        updateRuntimeQueueLength();
        publishReplayStats();
        return merged;
    };
    const scheduleManifestPrefetch = (layerIds: string[], centerIso: string) => {
        const normalizedLayers = layerIds.filter((layerId) => layerId !== 'satellite');
        if (normalizedLayers.length === 0) return;
        scheduleIdlePrefetch(() => {
            void getWindowManifest(normalizedLayers, centerIso).catch((error: any) => {
                const message = error?.message || String(error);
                console.error('[ReplayOverlay] manifest prefetch failed:', message);
            });
        });
    };
    const publishReplayStats = () => {
        if (typeof window === 'undefined') return;
        const layerCounts = Object.fromEntries(Array.from(layerCountsRef.current.entries()));
        const samples: ReplayMeta[] = [];
        replayMetaMap.forEach((value) => {
            if (samples.length < 10) samples.push(value);
        });
        window.__openspyReplayStats = {
            pointCount: pointMapRef.current.size,
            shapeCount: shapeMapRef.current.size,
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
            samples,
        };
        window.__openspyReplayMetaLookup = (id: string) => replayMetaMap.get(id) || null;
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
            pointMapRef.current.clear();
            pointSignatureRef.current.clear();
            shapeMapRef.current.clear();
            shapeBatchRef.current.forEach((batch) => batch.destroy());
            shapeBatchRef.current.clear();
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
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(pointCollection);
            }
            pointCollectionRef.current = null;
        };
    }, [viewer]);

    const clearReplay = () => {
        replayMetaMap.clear();
        pointMapRef.current.clear();
        pointSignatureRef.current.clear();
        shapeMapRef.current.clear();
        shapeBatchRef.current.forEach((batch) => batch.destroy());
        shapeBatchRef.current.clear();
        targetLayerMapRef.current.clear();
        layerCountsRef.current.clear();
        motionTrackMapRef.current.clear();
        motionTrackAppliedAtRef.current.clear();
        destroyReplaySatelliteWorker();
        pointCollectionRef.current?.removeAll();
        lastAppliedLayerTimeRef.current.clear();
        lastBufferedLayerTimeRef.current.clear();
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
        publishReplayStats();
    };

    const computeVisible = (targetId: string, layerId: string, subtype: string | null | undefined, sourceId: string | null | undefined) => {
        const normalizedTargetId = normalizeReplayId(targetId);
        const normalizedIsolatedId = isolatedEntityId ? normalizeReplayId(isolatedEntityId) : null;
        if (normalizedIsolatedId && normalizedIsolatedId !== normalizedTargetId) return false;
        const storeLayer = toStoreLayerKey(layerId);
        if (!storeLayer) return true;
        if (subtypeVisibility[`${storeLayer}:${subtype || ''}`] === false) return false;
        if (storeLayer === 'disasters') {
            const normalizedSource = normalizeLayerSourceId('disasters', sourceId);
            if (normalizedSource && sourceVisibility[getLayerSourceVisibilityKey('disasters', normalizedSource)] === false) return false;
        }
        if (storeLayer === 'conflicts') {
            const normalizedSource = normalizeLayerSourceId('conflicts', sourceId);
            if (normalizedSource && sourceVisibility[getLayerSourceVisibilityKey('conflicts', normalizedSource)] === false) return false;
        }
        if (storeLayer === 'outages') {
            const normalizedSource = normalizeLayerSourceId('outages', sourceId);
            if (normalizedSource && sourceVisibility[getLayerSourceVisibilityKey('outages', normalizedSource)] === false) return false;
        }
        return true;
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

    const clearLayer = (layerId: string) => {
        if (layerId === 'satellite') {
            destroyReplaySatelliteWorker();
        }
        const targetIds = Array.from(targetLayerMapRef.current.entries())
            .filter(([, currentLayerId]) => currentLayerId === layerId)
            .map(([targetId]) => targetId);
        for (const targetId of targetIds) removeTarget(targetId, true);
        if (REPLAY_MOVING_LAYERS.has(layerId) && lastAppliedTimeRef.current) {
            syncReplayMotionTracks(lastAppliedTimeRef.current);
        }
        lastAppliedLayerTimeRef.current.delete(layerId);
        lastBufferedLayerTimeRef.current.delete(layerId);
        updateRuntimeQueueLength();
        publishReplayStats();
    };

    const compareReplayWindowItems = (left: ReplayWindowItem, right: ReplayWindowItem) => {
        const leftAt = new Date(left.at).getTime();
        const rightAt = new Date(right.at).getTime();
        if (leftAt !== rightAt) return leftAt - rightAt;
        const leftPriority = REPLAY_PLAY_LAYER_PRIORITY[left.layer_id] ?? Number.MAX_SAFE_INTEGER;
        const rightPriority = REPLAY_PLAY_LAYER_PRIORITY[right.layer_id] ?? Number.MAX_SAFE_INTEGER;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        return left.target_id.localeCompare(right.target_id);
    };

    const getTilePayloadsForLayer = async (manifest: ReplayManifest, layerId: string): Promise<ReplayTilePayload[]> => {
        const layer = manifest?.layers?.[layerId];
        if (!layer || layer.tiles.length === 0) return [];
        return withSpan(
            'replay.getTilePayloadsForLayer',
            {
                'replay.layer': layerId,
                'replay.tiles': layer.tiles.length,
                'replay.manifest_from': manifest.from,
                'replay.manifest_to': manifest.to,
            },
            async (span) => {
                if (typeof performance !== 'undefined') {
                    performance.mark(`replay-tile-read:${layerId}:start`);
                }
                const payloads = await tileCacheRef.current!.fetchTilesBundle(layer.tiles, (phase, ms, extra) => {
                    perfLog('replay.tile_bundle_phase', {
                        layer: layerId,
                        phase,
                        ms: Math.round(ms),
                        ...(extra || {}),
                    });
                    span?.addEvent(`tile_bundle.${phase}`, {
                        'phase.ms': Math.round(ms),
                        ...(extra ? Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && typeof v !== 'object')) : {}),
                    });
                });
                const sortedPayloads = payloads.sort((left, right) => {
                    if (left.tBucket !== right.tBucket) return new Date(left.tBucket).getTime() - new Date(right.tBucket).getTime();
                    if (left.x !== right.x) return left.x - right.x;
                    return left.y - right.y;
                });
                if (typeof performance !== 'undefined') {
                    performance.mark(`replay-tile-read:${layerId}:end`);
                    performance.measure(`replay-tile-read:${layerId}`, `replay-tile-read:${layerId}:start`, `replay-tile-read:${layerId}:end`);
                }
                span?.setAttribute('replay.payloads', sortedPayloads.length);
                return sortedPayloads;
            },
        ) as Promise<ReplayTilePayload[]>;
    };

    const loadSatelliteTleState = async (atIso: string): Promise<ReplaySatelliteTleResponse> => {
        try {
            const params = new URLSearchParams({ at: atIso });
            const layerLimit = getReplayLayerLimit('satellite');
            if (layerLimit != null) {
                params.set('limit', String(layerLimit));
            }
            const response = await axios.get<ReplaySatelliteTleResponse>(`${API_URL}/api/replay/satellite-tle?${params.toString()}`);
            return response.data;
        } catch (error: any) {
            const message = error?.message || String(error);
            console.error('[ReplayOverlay] satellite TLE seek failed:', message);
            setReplayError(`Replay satellite load failed: ${message}`);
            throw error;
        }
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
            const icon = getSatIcon(isRecon ? 'military' : item.subtype || 'civilian', isRecon);
            const billboard = pointCollection.add({
                position: Cesium.Cartesian3.ZERO,
                image: icon,
                scale: isRecon ? 1.8 : 1.4,
                rotation: 0,
                show: false,
                id: targetId,
            });
            pointMapRef.current.set(targetId, billboard);
            sabState.indexById.set(targetId, index);
            replaySatelliteApplySlotsRef.current.push({
                index,
                targetId,
                billboard,
                scratch: new Cesium.Cartesian3(),
                getVisible: () => {
                    const meta = replayMetaMap.get(normalizeReplayId(targetId));
                    return computeVisible(targetId, 'satellite', meta?.subtype, meta?.source);
                },
                updateMeta: (position) => {
                    const meta = replayMetaMap.get(normalizeReplayId(targetId));
                    if (!meta) return;
                    const carto = Cesium.Cartographic.fromCartesian(position);
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
            .filter(([targetId]) => pointMapRef.current.has(targetId))
            .sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
        if (entries.length === 0) {
            replayMotionSabRef.current = null;
            replayMotionApplySlotsRef.current = [];
            replayMotionLastEpochMsRef.current = null;
            replayMotionLastAppliedEpochMsRef.current = null;
            replaySatelliteWorkerRef.current?.postMessage({
                type: 'update-tracks',
                sab: null,
                tracks: [],
            });
            return;
        }
        const sabState = replayMotionSabRef.current && replayMotionApplySlotsRef.current.length === entries.length
            ? replayMotionSabRef.current
            : createSatellitePositionsSAB(entries.length);
        replayMotionSabRef.current = sabState;
        replayMotionApplySlotsRef.current = [];
        const tracks = entries.map(([targetId, track], index) => {
            const billboard = pointMapRef.current.get(targetId)!;
            const metaId = normalizeReplayId(targetId);
            replayMotionApplySlotsRef.current.push({
                index,
                targetId,
                billboard,
                scratch: new Cesium.Cartesian3(),
                getVisible: () => {
                    const meta = replayMetaMap.get(metaId);
                    return computeVisible(targetId, meta?.layerId || 'aircraft', meta?.subtype, meta?.source);
                },
                updateMeta: (position) => {
                    const meta = replayMetaMap.get(metaId);
                    if (!meta) return;
                    const carto = Cesium.Cartographic.fromCartesian(position);
                    if (!carto) return;
                    meta.lat = Cesium.Math.toDegrees(carto.latitude);
                    meta.lng = Cesium.Math.toDegrees(carto.longitude);
                    meta.alt = carto.height;
                },
            });
            return {
                index,
                targetId,
                previousAtMs: track.previous.atMs,
                previous: track.previous.position,
                nextAtMs: track.next?.atMs ?? null,
                next: track.next?.position ?? null,
            };
        });
        const worker = ensureReplayWorker();
        worker.postMessage({
            type: 'update-tracks',
            sab: sabState.sab,
            tracks,
        });
        worker.postMessage({
            type: 'motion-tick',
            atMs: new Date(atIso).getTime(),
        });
    };

    const rebuildStateFromTilePayloads = (
        atIso: string,
        payloads: ReplayTilePayload[],
    ): ReplayStateResponse => {
        if (typeof performance !== 'undefined') {
            performance.mark('replay-rebuild-state:start');
        }
        const entityMap = new Map<string, ReplayEntity>();
        const eventMap = new Map<string, ReplayEvent>();
        const assetMap = new Map<string, ReplayAsset>();
        const atMs = new Date(atIso).getTime();

        // Use snapshots ONLY from payloads whose snapshotAt <= atMs.
        // Sort so the latest valid snapshot wins for any given entity.
        // Earlier code blindly merged all snapshots, so a 17:50 snapshot
        // (positions from the future) overwrote a 17:20 baseline when
        // seeking to 17:30 — making playback show frozen "future" coords
        // and never advance.
        const validSnapshots = payloads
            .filter((p) => {
                const snapMs = p.snapshotAt ? new Date(p.snapshotAt).getTime() : Number.NaN;
                return Number.isFinite(snapMs) && snapMs <= atMs;
            })
            .sort((a, b) => new Date(a.snapshotAt).getTime() - new Date(b.snapshotAt).getTime());
        for (const payload of validSnapshots) {
            for (const entity of payload.snapshot.entities || []) entityMap.set(entity.entity_id, entity as ReplayEntity);
            for (const event of payload.snapshot.events || []) eventMap.set(event.event_id, event as ReplayEvent);
            for (const asset of payload.snapshot.assets || []) assetMap.set(asset.asset_id, asset as ReplayAsset);
        }

        const items = payloads
            .flatMap((payload) => payload.items || [])
            .sort(compareReplayWindowItems);

        // Keep only the two samples the motion worker uses: `prev`
        // (latest atMs ≤ atMs) and `next` (earliest atMs > atMs).
        // This is O(1) memory per entity instead of keeping the whole
        // window's samples; for dense fleets that was approaching tens
        // of MB on long replays.
        const motionSamples = new Map<string, { prev?: ReplayMotionSampleRaw; next?: ReplayMotionSampleRaw }>();
        const tryAddMotionSample = (
            entityId: string,
            sample: ReplayMotionSampleRaw,
        ) => {
            let slot = motionSamples.get(entityId);
            if (!slot) {
                slot = {};
                motionSamples.set(entityId, slot);
            }
            if (sample.atMs <= atMs) {
                if (!slot.prev || sample.atMs > slot.prev.atMs) slot.prev = sample;
            } else {
                if (!slot.next || sample.atMs < slot.next.atMs) slot.next = sample;
            }
        };

        for (const item of items) {
            if (item.family === 'entity' && item.op === 'upsert' && REPLAY_MOVING_LAYERS.has(item.layer_id)) {
                const ent = (item as any).item as ReplayEntity;
                const poIso = (ent as any).position_observed_at || (item as any).at;
                const poMs = poIso ? new Date(poIso).getTime() : Number.NaN;
                const lat = Number((ent as any).display_lat);
                const lng = Number((ent as any).display_lng);
                const alt = Number((ent as any).altitude_m ?? 0) || 0;
                if (Number.isFinite(poMs) && Number.isFinite(lat) && Number.isFinite(lng)) {
                    tryAddMotionSample(ent.entity_id, { atMs: poMs, lat, lng, alt });
                }
            }
            if (new Date(item.at).getTime() > atMs) continue;
            if (item.family === 'entity') {
                if (item.op === 'remove') entityMap.delete(item.entity_id);
                else entityMap.set(item.item.entity_id, item.item as ReplayEntity);
                continue;
            }
            if (item.family === 'event') {
                if (item.op === 'remove') eventMap.delete(item.event_id);
                else eventMap.set(item.item.event_id, item.item as ReplayEvent);
                continue;
            }
            assetMap.set(item.item.asset_id, item.item as ReplayAsset);
        }

        // Also treat snapshot entities as motion samples — this is
        // critical when a tile has no items (just a snapshot) because
        // that's still a valid historical position observation.
        for (const payload of validSnapshots) {
            for (const ent of payload.snapshot.entities || []) {
                if (!REPLAY_MOVING_LAYERS.has((ent as any).layer_id)) continue;
                const poIso = (ent as any).position_observed_at;
                const poMs = poIso ? new Date(poIso).getTime() : Number.NaN;
                const lat = Number((ent as any).display_lat);
                const lng = Number((ent as any).display_lng);
                const alt = Number((ent as any).altitude_m ?? 0) || 0;
                if (!Number.isFinite(poMs) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
                tryAddMotionSample((ent as any).entity_id, { atMs: poMs, lat, lng, alt });
            }
        }

        const state = {
            at: atIso,
            entities: Array.from(entityMap.values()),
            events: Array.from(eventMap.values()),
            assets: Array.from(assetMap.values()),
            motionSamples,
        };
        if (typeof performance !== 'undefined') {
            performance.mark('replay-rebuild-state:end');
            performance.measure('replay-rebuild-state', 'replay-rebuild-state:start', 'replay-rebuild-state:end');
        }
        return state;
    };

        const loadLayerStateFromTiles = async (
        layerId: string,
        atIso: string,
        manifest: ReplayManifest,
    ): Promise<ReplayStateResponse> => {
        const tNet = performance.now();
        const payloads = await getTilePayloadsForLayer(manifest, layerId);
        const tNetEnd = performance.now();
        const state = rebuildStateFromTilePayloads(atIso, payloads);
        const tBuild = performance.now();
        const itemCount = payloads.reduce((acc, p) => acc + (p.items?.length || 0), 0);
        const snapshotEntities = payloads.reduce((acc, p) => acc + (p.snapshot?.entities?.length || 0), 0);
        const snapshotEvents = payloads.reduce((acc, p) => acc + (p.snapshot?.events?.length || 0), 0);
        const snapshotAssets = payloads.reduce((acc, p) => acc + (p.snapshot?.assets?.length || 0), 0);
        perfLog('replay.layer.sub_stages', {
            layer: layerId,
            tilesMs: Math.round(tNetEnd - tNet),
            rebuildMs: Math.round(tBuild - tNetEnd),
            tileCount: payloads.length,
            items: itemCount,
            snapshotEntities,
            snapshotEvents,
            snapshotAssets,
            rebuiltEntities: state.entities.length,
            rebuiltEvents: state.events.length,
            rebuiltAssets: state.assets.length,
        });
        return state;
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
        const fill = getFillColor(item.layer_id, item.subtype);
        const stroke = getStrokeColor(item.layer_id, item.subtype);
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
        const rotation = headingDeg != null ? Cesium.Math.toRadians(-headingDeg) : 0;
        const sampleAtMs = 'position_observed_at' in item && item.position_observed_at
            ? new Date(item.position_observed_at).getTime()
            : Number.NaN;

        const icon = getPointIcon(item.layer_id, item.subtype, item);
        const visible = computeVisible(targetId, item.layer_id, item.subtype, item.source_id);
        const scale = item.layer_id === 'satellite'
            ? 1.4
            : item.layer_id === 'aircraft'
                ? 1.0
                : item.layer_id === 'fire' && 'properties' in item && Number.isFinite(item.properties?.count)
                    ? Math.max(1.0, Math.min(1.8, 1.0 + Math.log2(Math.max(1, Number(item.properties?.count))) * 0.12))
                    : 1.1;
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
        ].join('|');
        const staticPointUnchanged = !REPLAY_MOVING_LAYERS.has(item.layer_id)
            && Boolean(existing)
            && pointSignatureRef.current.get(targetId) === signature;
        let position: Cesium.Cartesian3 | null = null;
        if (!staticPointUnchanged) {
            position = safeCartesianFromDegrees(lng, lat, altitude);
            if (!position) return;
        }
        if (existing) {
            if (!staticPointUnchanged && position) {
                existing.position = position;
                if (existing.image !== icon) existing.image = icon;
                if (existing.show !== visible) existing.show = visible;
                if (existing.rotation !== rotation) existing.rotation = rotation;
                if (existing.scale !== scale) existing.scale = scale;
            }
        } else {
            if (!position) return;
            const bb = pointCollection.add({
                id: normalizeReplayId(targetId),
                position,
                image: icon,
                scale,
                rotation,
                ...(item.layer_id === 'vessel' ? { alignedAxis: Cesium.Cartesian3.UNIT_Z } : {}),
                show: visible,
            });
            pointMapRef.current.set(targetId, bb);
        }
        pointSignatureRef.current.set(targetId, signature);

        if (REPLAY_MOVING_LAYERS.has(item.layer_id) && Number.isFinite(sampleAtMs)) {
            const movingPosition = position ?? existing?.position;
            if (!movingPosition) return;
            const sample: ReplayMotionSample = {
                atMs: sampleAtMs,
                position: [movingPosition.x, movingPosition.y, movingPosition.z],
            };
            const existingTrack = motionTrackMapRef.current.get(targetId);
            if (!existingTrack) {
                motionTrackMapRef.current.set(targetId, {
                    previous: sample,
                    next: null,
                });
            } else if (sample.atMs <= existingTrack.previous.atMs) {
                existingTrack.previous = sample;
                if (existingTrack.next && existingTrack.next.atMs <= sample.atMs) {
                    existingTrack.next = null;
                }
            } else if (!existingTrack.next || sample.atMs >= existingTrack.next.atMs) {
                existingTrack.previous = existingTrack.next || existingTrack.previous;
                existingTrack.next = sample;
            } else {
                existingTrack.next = sample;
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
        // motionSamples now carries only {prev, next} per entity —
        // exactly what the motion worker needs to interpolate.
        //
        // Race prevention: warm-prime and playback-refresh can both
        // run applyLayerState concurrently for the same moving layer,
        // and each mutates the shared motionTrackMapRef. We commit the
        // motion tracks only if (a) this apply pass hasn't been
        // superseded (isCancelled returns false) and (b) the target
        // entity hasn't already been written by a NEWER atMs from
        // another pass. The per-entity check prevents a slower
        // earlier seek from overwriting a faster later seek's tracks.
        if (REPLAY_MOVING_LAYERS.has(layerId) && state.motionSamples && state.motionSamples.size > 0 && !isCancelled()) {
            const myAtMs = new Date(state.at).getTime();
            state.motionSamples.forEach((slot, entityId) => {
                const toSample = (raw: ReplayMotionSampleRaw): ReplayMotionSample | null => {
                    const pos = safeCartesianFromDegrees(raw.lng, raw.lat, raw.alt);
                    if (!pos) return null;
                    return { atMs: raw.atMs, position: [pos.x, pos.y, pos.z] };
                };
                const prevS = slot.prev ? toSample(slot.prev) : null;
                const nextS = slot.next ? toSample(slot.next) : null;
                if (!prevS && !nextS) return;
                const previous = prevS || nextS!;
                const next = prevS && nextS ? nextS : null;
                const existingStampMs = motionTrackAppliedAtRef.current.get(entityId) ?? Number.NEGATIVE_INFINITY;
                if (myAtMs < existingStampMs) return; // newer write already landed
                motionTrackMapRef.current.set(entityId, { previous, next });
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
        manifest: ReplayManifest,
        isCancelled: () => boolean = () => false,
        options?: { renderChunks?: boolean },
    ): Promise<boolean> => {
        return withSpan(
            'replay.syncLayerState',
            {
                'replay.layer': layerId,
                'replay.at': atIso,
                'replay.manifest_from': manifest.from,
                'replay.manifest_to': manifest.to,
                'replay.render_chunks': options?.renderChunks !== false,
            },
            async (span) => {
        if (layerId === 'satellite') {
            const tHttp0 = performance.now();
            const tleState = await loadSatelliteTleState(atIso);
            const tHttp = performance.now() - tHttp0;
            if (isCancelled()) return false;
            const tApply0 = performance.now();
            const applied = await applySatelliteTleState(atIso, tleState.items, isCancelled);
            const tApply = performance.now() - tApply0;
            perfLog('replay.satellite.stages', {
                httpMs: Math.round(tHttp),
                applyMs: Math.round(tApply),
                items: tleState.items?.length ?? 0,
            });
            if (!applied || isCancelled()) return false;
            lastAppliedLayerTimeRef.current.set(layerId, atIso);
            lastBufferedLayerTimeRef.current.set(layerId, atIso);
            return true;
        }
        const tFetchStart = performance.now();
        const state = await loadLayerStateFromTiles(layerId, atIso, manifest);
        const tFetched = performance.now();
        const cancelledAfterFetch = isCancelled();
        if (REPLAY_MOVING_LAYERS.has(layerId)) {
            perfLog('replay.sync.after_fetch', {
                layer: layerId, atIso, entities: state.entities.length, cancelled: cancelledAfterFetch,
            });
        }
        if (cancelledAfterFetch) return false;
        const applied = await applyLayerState(layerId, state, isCancelled, undefined, options);
        const tApplied = performance.now();
        perfLog('replay.layer.stages', {
            layer: layerId,
            tilesAndRebuildMs: Math.round(tFetched - tFetchStart),
            applyMs: Math.round(tApplied - tFetched),
            entities: state.entities.length,
            events: state.events.length,
            assets: state.assets.length,
        });
        const cancelledAfterApply = isCancelled();
        if (REPLAY_MOVING_LAYERS.has(layerId)) {
            perfLog('replay.sync.after_apply', {
                layer: layerId, atIso, applied, cancelled: cancelledAfterApply,
            });
        }
        if (!applied || cancelledAfterApply) return false;
        if (REPLAY_MOVING_LAYERS.has(layerId)) {
            syncReplayMotionTracks(atIso);
            const trackCount = motionTrackMapRef.current.size;
            let withNext = 0;
            motionTrackMapRef.current.forEach((t) => { if (t.next) withNext += 1; });
            perfLog('replay.sync.motion_tracks', { layer: layerId, atIso, tracks: trackCount, withNext });
        }
        lastAppliedLayerTimeRef.current.set(layerId, atIso);
        lastBufferedLayerTimeRef.current.set(layerId, manifest.to);
        span?.setAttribute('sync.fetch_ms', Math.round(tFetched - tFetchStart));
        span?.setAttribute('sync.apply_ms', Math.round(tApplied - tFetched));
        return true;
            },
        ) as Promise<boolean>;
    };

    useEffect(() => {
        const pointCollection = pointCollectionRef.current;
        const showReplay = mode === 'playback' && playbackKind === 'historical';
        if (pointCollection) pointCollection.show = showReplay;
        if (!showReplay) {
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
                if (replayMotionApplySlotsRef.current.length > 0 && replaySatelliteWorkerRef.current) {
                    replaySatelliteWorkerRef.current.postMessage({
                        type: 'motion-tick',
                        atMs: currentMs,
                    });
                }
                const motionSab = replayMotionSabRef.current;
                const motionEpochMs = replayMotionLastEpochMsRef.current;
                if (motionSab && Number.isFinite(motionEpochMs ?? NaN) && replayMotionLastAppliedEpochMsRef.current !== motionEpochMs) {
                    const view = motionSab.view;
                    for (const slot of replayMotionApplySlotsRef.current) {
                        const offset = slot.index * 3;
                        if (!Number.isFinite(view[offset]) || !Number.isFinite(view[offset + 1]) || !Number.isFinite(view[offset + 2])) continue;
                        slot.scratch.x = view[offset];
                        slot.scratch.y = view[offset + 1];
                        slot.scratch.z = view[offset + 2];
                        slot.billboard.position = slot.scratch;
                        slot.billboard.show = slot.getVisible?.() ?? true;
                        slot.updateMeta?.(slot.scratch);
                        appliedSlots += 1;
                        touched = true;
                    }
                    replayMotionLastAppliedEpochMsRef.current = motionEpochMs;
                }
                updateRuntimeQueueLength();
                runtimePerfRef.current.lastDrainOps = 0;
                runtimePerfRef.current.lastDrainMs = 0;
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
    }, [mode, playbackKind, replaySeekVersion, layersKey, satelliteRenderLimit]);

    useEffect(() => {
        const unsubscribe = useTimelineStore.subscribe((state, prevState) => {
            const historicalNow = state.mode === 'playback' && state.playbackKind === 'historical';
            const historicalBefore = prevState.mode === 'playback' && prevState.playbackKind === 'historical';
            if (historicalNow && !historicalBefore) {
                seekRequestRef.current = {
                    targetMs: state.currentTime.getTime(),
                    reason: 'mode-change',
                };
                return;
            }
            if (!historicalNow) return;
            if (state.currentTimeUpdate.seq === prevState.currentTimeUpdate.seq) return;
            if (state.currentTimeUpdate.silent) return;
            if (state.currentTimeUpdate.reason !== 'user-seek') return;
            if (typeof performance !== 'undefined') {
                performance.mark('replay-seek-visible:start');
            }
            seekRequestRef.current = {
                targetMs: state.currentTime.getTime(),
                reason: 'user-seek',
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
    }, [mode, playbackKind, subtypeVisibility, sourceVisibility, isolatedEntityId]);

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
        const cancelVersion = replayCancelVersionRef.current;
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
            const aPriority = REPLAY_SEEK_LAYER_PRIORITY[a] ?? Number.MAX_SAFE_INTEGER;
            const bPriority = REPLAY_SEEK_LAYER_PRIORITY[b] ?? Number.MAX_SAFE_INTEGER;
            return aPriority - bPriority;
        });
        const primaryReplayLayers = sortedReplayLayers.filter((layerId) =>
            REPLAY_SEEK_PRIMARY_LAYERS.includes(layerId as typeof REPLAY_SEEK_PRIMARY_LAYERS[number]),
        );
        const secondaryReplayLayers = sortedReplayLayers.filter((layerId) =>
            REPLAY_SEEK_SECONDARY_LAYERS.includes(layerId as typeof REPLAY_SEEK_SECONDARY_LAYERS[number]),
        );
        const backgroundReplayLayers = sortedReplayLayers.filter((layerId) =>
            !primaryReplayLayers.includes(layerId) && !secondaryReplayLayers.includes(layerId),
        );
        const bootstrapReplayLayers = primaryReplayLayers.length > 0
            ? primaryReplayLayers
            : secondaryReplayLayers.length > 0
                ? secondaryReplayLayers
                : backgroundReplayLayers.slice(0, 1);
        const deferredReplayLayers = sortedReplayLayers.filter((layerId) => !bootstrapReplayLayers.includes(layerId));
        const eagerlyDeferredReplayLayers = deferredReplayLayers.filter((layerId) =>
            secondaryReplayLayers.includes(layerId as typeof REPLAY_SEEK_SECONDARY_LAYERS[number]),
        );
        const backgroundDeferredReplayLayers = deferredReplayLayers.filter((layerId) =>
            !eagerlyDeferredReplayLayers.includes(layerId),
        );
        const interactiveReplayLayers = bootstrapReplayLayers;
        const isCancelled = () => cancelVersion !== replayCancelVersionRef.current;

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
            if (typeof performance !== 'undefined') {
                performance.mark('replay-seek-manifest:start');
            }
            // Codex round-11 fix (2026-04-21): primary first_visible only
            // needs the current 10-minute bucket for aircraft/vessel — not
            // prev+current+next (3 tiles, 73 MB aircraft / 92 MB vessel).
            // Fetch a narrow padding=0 manifest for primary foreground,
            // and the normal padding=1 manifest for warm-prime + deferred
            // so motion-interpolation and neighbor-bucket data still
            // populate after first visible. Backend reports a single
            // aircraft tile as 23 MB / 21 ms vs three tiles as 73 MB /
            // 2 718 ms in the same cold run — so this cuts primary HTTP
            // from ~3.3 s to ~0.5 s and decode/clone proportionally.
            const primaryManifestPromise = getWindowManifest(interactiveReplayLayers, currentIso, 0);
            const fullManifestPromise = getWindowManifest(sortedReplayLayers, currentIso);
            const primaryManifest = await primaryManifestPromise;
            perfLog('replay.fetch.primary_manifest_done', {
                ms: Math.round(performance.now() - tFetchReplayStart),
                layerKeys: Object.keys(primaryManifest.layers).slice(0, 8),
                cancelled: isCancelled(),
            });
            if (typeof performance !== 'undefined') {
                performance.mark('replay-seek-manifest:end');
                performance.measure('replay-seek-manifest', 'replay-seek-manifest:start', 'replay-seek-manifest:end');
            }
            if (isCancelled()) return;
            const manifest = await fullManifestPromise;
            perfLog('replay.fetch.full_manifest_done', {
                ms: Math.round(performance.now() - tFetchReplayStart),
                layerKeys: Object.keys(manifest.layers).slice(0, 8),
                cancelled: isCancelled(),
            });
            if (isCancelled()) return;
            scheduleManifestPrefetch(sortedReplayLayers, currentIso);
            perfLog('replay.fetch.after_prefetch_schedule', { shouldSeek, interactiveCount: interactiveReplayLayers.length });
            const fetchLayerState = async (layerId: string, options?: { renderChunks?: boolean; usePrimaryManifest?: boolean }) => {
                if (typeof performance !== 'undefined') {
                    performance.mark(`replay-seek-sync:${layerId}:start`);
                }
                const useManifest = options?.usePrimaryManifest && primaryManifest.layers[layerId]
                    ? primaryManifest
                    : manifest;
                const applied = await syncLayerState(layerId, currentIso, useManifest, isCancelled, options);
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
                        const applied = await fetchLayerState(layerId, { usePrimaryManifest: true });
                        const t1 = performance.now();
                        perfLog('replay.layer.ready', { layer: layerId, ms: Math.round(t1 - t0), applied });
                        if (applied && !visibleMarked && !isCancelled()) {
                            visibleMarked = true;
                            markVisibleReplayFrame(currentIso, replaySeekVersion);
                            publishReplayStats();
                            perfLog('replay.first_visible', { layer: layerId, ms: Math.round(t1 - seekStartedAt) });
                        }
                        return applied;
                    }));
                    if (isCancelled() || results.some((r) => !r)) return;
                    perfLog('replay.all_primary_visible', { ms: Math.round(performance.now() - seekStartedAt) });
                }
                if (isCancelled()) return;
                releaseReplayInteraction();
                const warmPrimeKey = `${layersKey}|${currentIso}`;
                if (replayWarmPrimeKeyRef.current !== warmPrimeKey) {
                    replayWarmPrimeKeyRef.current = warmPrimeKey;
                    // Codex round-6 fix: warm-prime previously re-applied
                    // satellite for the same currentIso (rebuilding 5k+
                    // billboards). Filter satellite out — the foreground
                    // already applied it.
                    const warmLayers = interactiveReplayLayers.filter((l) => l !== 'satellite');
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
                                const applied = await syncLayerState(layerId, currentIso, manifest, isCancelled, { renderChunks: false });
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
                            if (isCancelled()) return;
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
                    background: backgroundDeferredReplayLayers,
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
                        const ok = await fetchLayerState(layerId, { renderChunks: false });
                        perfLog('replay.eager_layer', { layer: layerId, ms: Math.round(performance.now() - t0), ok });
                        return ok;
                    }));
                    if (isCancelled() || eagerResults.some((r) => !r)) return;
                    perfLog('replay.eager_done', { ms: Math.round(performance.now() - eagerStart) });
                    const bgStart = performance.now();
                    // 2026-04-23 hybrid: fetch+decode bg layers in PARALLEL
                    // (network/worker bound — no contention), then apply
                    // small-first SEQUENTIAL (main thread polygon rebuild
                    // contends). Removes serial HTTP wait while keeping
                    // Cesium primitive build isolated so airspace/pipeline
                    // don't dog-pile each other with 5s longtasks.
                    const bgLayersBySize = [...backgroundDeferredReplayLayers].sort((a, b) => {
                        const aBytes = (manifest.layers[a]?.tiles ?? []).reduce((s, t) => s + (t.bytes || 0), 0);
                        const bBytes = (manifest.layers[b]?.tiles ?? []).reduce((s, t) => s + (t.bytes || 0), 0);
                        return aBytes - bBytes;
                    });
                    const bgFetchT0 = performance.now();
                    // Kick off all fetches in parallel — as each resolves its
                    // state is held awaiting sequential apply.
                    const fetchPromises = new Map<string, Promise<{ kind: 'satellite'; items: ReplaySatelliteTleItem[] } | { kind: 'tile'; state: ReplayStateResponse } | null>>();
                    for (const layerId of bgLayersBySize) {
                        if (layerId === 'satellite') {
                            fetchPromises.set(layerId, (async () => {
                                const t0 = performance.now();
                                try {
                                    const tle = await loadSatelliteTleState(currentIso);
                                    perfLog('replay.bg_fetch', { layer: layerId, ms: Math.round(performance.now() - t0), items: tle.items?.length ?? 0 });
                                    return { kind: 'satellite' as const, items: tle.items || [] };
                                } catch { return null; }
                            })());
                        } else {
                            fetchPromises.set(layerId, (async () => {
                                const t0 = performance.now();
                                try {
                                    const state = await loadLayerStateFromTiles(layerId, currentIso, manifest);
                                    perfLog('replay.bg_fetch', { layer: layerId, ms: Math.round(performance.now() - t0), entities: state.entities.length, events: state.events.length, assets: state.assets.length });
                                    return { kind: 'tile' as const, state };
                                } catch { return null; }
                            })());
                        }
                    }
                    perfLog('replay.bg_fetch_parallel_kickoff', { layers: bgLayersBySize, kickoffMs: Math.round(performance.now() - bgFetchT0) });

                    const bgResults: boolean[] = [];
                    for (const layerId of bgLayersBySize) {
                        if (isCancelled()) { bgResults.push(false); break; }
                        const t0 = performance.now();
                        const fetched = await fetchPromises.get(layerId)!;
                        if (!fetched) { bgResults.push(false); continue; }
                        let ok = false;
                        if (fetched.kind === 'satellite') {
                            ok = await applySatelliteTleState(currentIso, fetched.items, isCancelled);
                            if (ok) {
                                lastAppliedLayerTimeRef.current.set(layerId, currentIso);
                                lastBufferedLayerTimeRef.current.set(layerId, currentIso);
                            }
                        } else {
                            ok = await applyLayerState(layerId, fetched.state, isCancelled, undefined, { renderChunks: false });
                            if (ok && !isCancelled()) {
                                lastAppliedLayerTimeRef.current.set(layerId, currentIso);
                                lastBufferedLayerTimeRef.current.set(layerId, manifest.to);
                                if (REPLAY_MOVING_LAYERS.has(layerId)) syncReplayMotionTracks(currentIso);
                            }
                        }
                        perfLog('replay.bg_layer', { layer: layerId, ms: Math.round(performance.now() - t0), ok });
                        bgResults.push(ok);
                    }
                    if (isCancelled() || bgResults.some((r) => !r)) {
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
                    perfLog('replay.hydration_task', {
                        kind: 'deferred',
                        phase: 'error',
                        taskId: deferredTaskId,
                        ms: Math.round(performance.now() - deferredStart),
                        error: message,
                    });
                }).finally(() => {
                    replayHydrationInflightRef.current = Math.max(0, replayHydrationInflightRef.current - 1);
                });
                return;
            }
            if (isCancelled()) return;
            lastAppliedTimeRef.current = currentIso;
            layersKeyRef.current = layersKey;
            publishReplayStats();
        };

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
                if (cancelVersion !== replayCancelVersionRef.current) {
                    replayBusyRef.current = false;
                    if (replayPendingRef.current) {
                        replayPendingRef.current = false;
                        setReplayDrainVersion((version) => version + 1);
                    }
                    publishReplayStats();
                    return;
                }
                replayBusyRef.current = false;
                if (replayPendingRef.current) {
                    replayPendingRef.current = false;
                    setReplayDrainVersion((version) => version + 1);
                }
                publishReplayStats();
            });
    }, [viewer, mode, playbackKind, replaySeekVersion, layersKey, activeReplayLayers, satelliteRenderLimit, replayDrainVersion, setReplayHydrating]);

    useEffect(() => {
        if (!viewer || mode !== 'playback' || playbackKind !== 'historical') return;
        let cancelled = false;
        const cancelVersion = replayCancelVersionRef.current;
        const tick = async () => {
            if (cancelled || viewer.isDestroyed()) return;
            const state = useTimelineStore.getState();
            if (state.mode !== 'playback' || state.playbackKind !== 'historical' || !state.isPlaying) return;
            if (playbackRefreshBusyRef.current || replayBusyRef.current) return;
            // Codex round-6 fix: gate playback refresh on detached
            // hydration (warm-prime + deferred). Previously playbackRefresh
            // started on top of still-running hydration, causing duplicate
            // pipeline/airspace work and 5s frame_render spikes from
            // double primitive rebuilds.
            if (replayHydrationInflightRef.current > 0) return;
            const currentMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
            const currentIso = new Date(currentMs).toISOString();
            const sortedReplayLayers = [...activeReplayLayers].sort((a, b) => {
                const aPriority = REPLAY_PLAY_LAYER_PRIORITY[a] ?? Number.MAX_SAFE_INTEGER;
                const bPriority = REPLAY_PLAY_LAYER_PRIORITY[b] ?? Number.MAX_SAFE_INTEGER;
                return aPriority - bPriority;
            });
            scheduleManifestPrefetch(sortedReplayLayers, currentIso);
            playbackRefreshBusyRef.current = true;
            try {
                const manifest = await getWindowManifest(sortedReplayLayers, currentIso);
                // Refresh layers in PARALLEL — sequential await chained one
                // slow layer (pipeline at 24h bucket = 45 sec) blocking
                // aircraft/vessel motion entirely. Each layer is independent.
                await Promise.all(sortedReplayLayers.map(async (layerId) => {
                    if (layerId === 'satellite') return;
                    const cadenceMs = (REPLAY_PLAY_LAYER_CADENCE_SECONDS[layerId] || 60) * 1000;
                    const appliedIso = lastAppliedLayerTimeRef.current.get(layerId);
                    const appliedMs = appliedIso ? new Date(appliedIso).getTime() : Number.NEGATIVE_INFINITY;
                    if (currentMs - appliedMs < cadenceMs) return;
                    perfLog('replay.playback_refresh', {
                        layer: layerId,
                        currentIso,
                        appliedIso: appliedIso ?? null,
                        clockMultiplier: viewer.clock.multiplier,
                        shouldAnimate: viewer.clock.shouldAnimate,
                    });
                    await syncLayerState(
                        layerId,
                        currentIso,
                        manifest,
                        () => cancelled || replayCancelVersionRef.current !== cancelVersion,
                        { renderChunks: false },
                    );
                }));
                if (cancelled || replayCancelVersionRef.current !== cancelVersion) return;
                lastAppliedTimeRef.current = currentIso;
                publishReplayStats();
            } catch (error: any) {
                if (cancelled || replayCancelVersionRef.current !== cancelVersion) return;
                const message = error?.message || String(error);
                console.error('[ReplayOverlay] playback refresh failed:', message);
                setReplayError(`Replay playback refresh failed: ${message}`);
            } finally {
                playbackRefreshBusyRef.current = false;
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
