import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { getAviIcon, getConflictIcon, getDisasterIcon, getMapIcon, getOutageIcon, getSatIcon, getShipIcon, svgUri } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';
import { getLayerSourceVisibilityKey, normalizeLayerSourceId } from '../lib/source-visibility';

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

type ReplayStateResponse = {
    at: string;
    entities: ReplayEntity[];
    events: ReplayEvent[];
    assets: ReplayAsset[];
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

type ReplayWindowResponse = {
    from: string;
    to: string;
    items: ReplayWindowItem[];
};

type ReplayShapeDescriptor = {
    id: string;
    kind: 'polyline' | 'polygon';
    signature: string;
    name: string;
    visible: boolean;
    layer: string;
    subtype: string | null;
    source: string | null;
    description: string;
    positions?: Cesium.Cartesian3[];
    width?: number;
    stroke?: Cesium.Color;
    hierarchy?: Cesium.PolygonHierarchy;
    fill?: Cesium.Color;
};

type ReplayMotionSample = {
    atMs: number;
    position: Cesium.Cartesian3;
};

type ReplayMotionTrack = {
    previous: ReplayMotionSample;
    next: ReplayMotionSample | null;
    scratch: Cesium.Cartesian3;
};

type ReplayWindowQueueState = {
    items: ReplayWindowItem[];
    head: number;
};

type ReplayRuntimePerf = {
    queuedItems: number;
    lastDrainOps: number;
    lastDrainMs: number;
    droppedDrainPasses: number;
    maxObservedQueue: number;
    shapeEntityAddCount: number;
    shapeKindFallbackRebuildCount: number;
    polygonEntityAddCount: number;
    polylineEntityAddCount: number;
    polygonInPlaceMutationCount: number;
    polylineInPlaceMutationCount: number;
    shapeSignatureSkipCount: number;
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
            shapeEntityAddCount: number;
            shapeKindFallbackRebuildCount: number;
            polygonEntityAddCount: number;
            polylineEntityAddCount: number;
            polygonInPlaceMutationCount: number;
            polylineInPlaceMutationCount: number;
            shapeSignatureSkipCount: number;
            samples: ReplayMeta[];
        };
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
const REPLAY_SEEK_PRIMARY_LAYERS = ['satellite'] as const;
const REPLAY_SEEK_SECONDARY_LAYERS = ['aircraft', 'vessel', 'disasters', 'fire', 'outage', 'jamming', 'gfw', 'conflict'] as const;
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
const REPLAY_MOVING_LAYERS = new Set<string>(['satellite', 'aircraft', 'vessel']);
const REPLAY_BBOX_SCOPED_LAYERS = new Set<string>(['airspace', 'pipeline', 'cable']);

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
    const currentTime = useTimelineStore((s) => s.currentTime);
    const replaySeekVersion = useTimelineStore((s) => s.replaySeekVersion);
    const setReplayHydrating = useTimelineStore((s) => s.setReplayHydrating);
    const sources = useTimelineStore((s) => s.sources);
    const visibility = useTimelineStore((s) => s.visibility);
    const subtypeVisibility = useTimelineStore((s) => s.subtypeVisibility);
    const sourceVisibility = useTimelineStore((s) => s.sourceVisibility);
    const isolatedEntityId = useTimelineStore((s) => s.isolatedEntityId);
    const satelliteRenderLimit = useTimelineStore((s) => s.satelliteRenderLimit);

    const pointCollectionRef = useRef<Cesium.BillboardCollection | null>(null);
    const pointMapRef = useRef<Map<string, Cesium.Billboard>>(new Map());
    const shapeDsRef = useRef<Cesium.CustomDataSource | null>(null);
    const shapeMapRef = useRef<Map<string, string[]>>(new Map());
    const shapeSignatureMapRef = useRef<Map<string, string[]>>(new Map());
    const targetLayerMapRef = useRef<Map<string, string>>(new Map());
    const layerCountsRef = useRef<Map<string, number>>(new Map());
    const motionTrackMapRef = useRef<Map<string, ReplayMotionTrack>>(new Map());
    const windowQueueRef = useRef<ReplayWindowQueueState>({
        items: [],
        head: 0,
    });
    const lastAppliedTimeRef = useRef<string | null>(null);
    const lastAppliedSeekVersionRef = useRef<number>(useTimelineStore.getState().replaySeekVersion);
    const lastAppliedLayerTimeRef = useRef<Map<string, string>>(new Map());
    const lastBufferedLayerTimeRef = useRef<Map<string, string>>(new Map());
    const windowFetchInFlightRef = useRef<Set<string>>(new Set());
    const lastWindowFetchRequestedAtRef = useRef<Map<string, number>>(new Map());
    const runtimePerfRef = useRef<ReplayRuntimePerf>({
        queuedItems: 0,
        lastDrainOps: 0,
        lastDrainMs: 0,
        droppedDrainPasses: 0,
        maxObservedQueue: 0,
        shapeEntityAddCount: 0,
        shapeKindFallbackRebuildCount: 0,
        polygonEntityAddCount: 0,
        polylineEntityAddCount: 0,
        polygonInPlaceMutationCount: 0,
        polylineInPlaceMutationCount: 0,
        shapeSignatureSkipCount: 0,
    });
    const layersKeyRef = useRef<string>('');
    const replayBusyRef = useRef(false);
    const replayPendingRef = useRef(false);
    const replayCancelVersionRef = useRef(0);
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
    const getReplayLayerLimit = (layerId: string): number | null => {
        if (layerId === 'satellite') {
            return satelliteRenderLimit ?? REPLAY_LAYER_LIMITS.satellite ?? null;
        }
        return REPLAY_LAYER_LIMITS[layerId] ?? null;
    };
    const getReplayApplyChunkSize = (layerId: string): number => REPLAY_APPLY_CHUNK_SIZE[layerId] ?? 500;
    const waitForRenderTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const getWindowQueueLength = () => {
        const queue = windowQueueRef.current;
        return Math.max(0, queue.items.length - queue.head);
    };
    const compactWindowQueue = () => {
        const queue = windowQueueRef.current;
        if (queue.head === 0) return queue.items;
        queue.items = queue.items.slice(queue.head);
        queue.head = 0;
        return queue.items;
    };
    const updateRuntimeQueueLength = () => {
        runtimePerfRef.current.queuedItems = getWindowQueueLength();
    };
    const getReplayBboxParam = (layerId?: string): string | null => {
        // World-scale replay must stay camera-independent for moving and
        // point/event layers. Otherwise the user only sees the square
        // that happened to be in view during seek, and playback freezes
        // once objects leave that bbox. Keep viewport scoping only for
        // the heaviest shape-dominant families until they get their own
        // explicit replay tiling/streaming path.
        if (!layerId || !REPLAY_BBOX_SCOPED_LAYERS.has(layerId)) return null;
        if (!viewer || viewer.isDestroyed()) return null;
        const rect = viewer.camera.computeViewRectangle();
        if (!rect) return null;
        const south = Cesium.Math.toDegrees(rect.south);
        const west = Cesium.Math.toDegrees(rect.west);
        const north = Cesium.Math.toDegrees(rect.north);
        const east = Cesium.Math.toDegrees(rect.east);
        if (![south, west, north, east].every(Number.isFinite)) return null;
        // Skip antimeridian-crossing rectangles for now; backend bbox parser
        // expects south,west,north,east with west < east.
        if (east <= west || north <= south) return null;
        return `${south},${west},${north},${east}`;
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
            shapeEntityAddCount: runtimePerfRef.current.shapeEntityAddCount,
            shapeKindFallbackRebuildCount: runtimePerfRef.current.shapeKindFallbackRebuildCount,
            polygonEntityAddCount: runtimePerfRef.current.polygonEntityAddCount,
            polylineEntityAddCount: runtimePerfRef.current.polylineEntityAddCount,
            polygonInPlaceMutationCount: runtimePerfRef.current.polygonInPlaceMutationCount,
            polylineInPlaceMutationCount: runtimePerfRef.current.polylineInPlaceMutationCount,
            shapeSignatureSkipCount: runtimePerfRef.current.shapeSignatureSkipCount,
            samples,
        };
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

        const shapeDs = new Cesium.CustomDataSource('replay-overlay');
        viewer.dataSources.add(shapeDs);
        shapeDsRef.current = shapeDs;

        return () => {
            replayMetaMap.clear();
            pointMapRef.current.clear();
            shapeMapRef.current.clear();
            shapeSignatureMapRef.current.clear();
            targetLayerMapRef.current.clear();
            layerCountsRef.current.clear();
            motionTrackMapRef.current.clear();
            windowQueueRef.current = { items: [], head: 0 };
            lastAppliedTimeRef.current = null;
            lastAppliedSeekVersionRef.current = useTimelineStore.getState().replaySeekVersion;
            lastAppliedLayerTimeRef.current.clear();
            lastBufferedLayerTimeRef.current.clear();
            windowFetchInFlightRef.current.clear();
            runtimePerfRef.current = {
                queuedItems: 0,
                lastDrainOps: 0,
                lastDrainMs: 0,
                droppedDrainPasses: 0,
                maxObservedQueue: 0,
                shapeEntityAddCount: 0,
                shapeKindFallbackRebuildCount: 0,
                polygonEntityAddCount: 0,
                polylineEntityAddCount: 0,
                polygonInPlaceMutationCount: 0,
                polylineInPlaceMutationCount: 0,
                shapeSignatureSkipCount: 0,
            };
            layersKeyRef.current = '';
            replayBusyRef.current = false;
            replayPendingRef.current = false;
            replayCancelVersionRef.current += 1;
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(pointCollection);
                viewer.dataSources.remove(shapeDs);
            }
            pointCollectionRef.current = null;
            shapeDsRef.current = null;
        };
    }, [viewer]);

    const clearReplay = () => {
        replayMetaMap.clear();
        pointMapRef.current.clear();
        shapeMapRef.current.clear();
        shapeSignatureMapRef.current.clear();
        targetLayerMapRef.current.clear();
        layerCountsRef.current.clear();
        motionTrackMapRef.current.clear();
        windowQueueRef.current = { items: [], head: 0 };
        pointCollectionRef.current?.removeAll();
        shapeDsRef.current?.entities.removeAll();
        lastAppliedLayerTimeRef.current.clear();
        lastBufferedLayerTimeRef.current.clear();
        windowFetchInFlightRef.current.clear();
        runtimePerfRef.current = {
            queuedItems: 0,
            lastDrainOps: 0,
            lastDrainMs: 0,
            droppedDrainPasses: 0,
            maxObservedQueue: 0,
            shapeEntityAddCount: 0,
            shapeKindFallbackRebuildCount: 0,
            polygonEntityAddCount: 0,
            polylineEntityAddCount: 0,
            polygonInPlaceMutationCount: 0,
            polylineInPlaceMutationCount: 0,
            shapeSignatureSkipCount: 0,
        };
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

    const removeTarget = (targetId: string, suppressStats = false) => {
        const point = pointMapRef.current.get(targetId);
        if (point && pointCollectionRef.current) {
            pointCollectionRef.current.remove(point);
            pointMapRef.current.delete(targetId);
        }
        const shapeIds = shapeMapRef.current.get(targetId) || [];
        if (shapeDsRef.current) {
            for (const shapeId of shapeIds) shapeDsRef.current.entities.removeById(shapeId);
        }
        shapeMapRef.current.delete(targetId);
        shapeSignatureMapRef.current.delete(targetId);
        const previousLayerId = targetLayerMapRef.current.get(targetId);
        if (previousLayerId) {
            decrementLayerCount(previousLayerId);
            targetLayerMapRef.current.delete(targetId);
        }
        motionTrackMapRef.current.delete(targetId);
        replayMetaMap.delete(normalizeReplayId(targetId));
        if (!suppressStats) publishReplayStats();
    };

    const clearLayer = (layerId: string) => {
        const targetIds = Array.from(targetLayerMapRef.current.entries())
            .filter(([, currentLayerId]) => currentLayerId === layerId)
            .map(([targetId]) => targetId);
        for (const targetId of targetIds) removeTarget(targetId, true);
        const filteredItems = compactWindowQueue().filter((item) => item.layer_id !== layerId);
        windowQueueRef.current = {
            items: filteredItems,
            head: 0,
        };
        lastAppliedLayerTimeRef.current.delete(layerId);
        lastBufferedLayerTimeRef.current.delete(layerId);
        windowFetchInFlightRef.current.delete(layerId);
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

    const enqueueWindowItems = (items: ReplayWindowItem[]) => {
        if (items.length === 0) return;
        const queueItems = compactWindowQueue();
        queueItems.push(...items);
        queueItems.sort(compareReplayWindowItems);
        updateRuntimeQueueLength();
        runtimePerfRef.current.maxObservedQueue = Math.max(runtimePerfRef.current.maxObservedQueue, getWindowQueueLength());
        publishReplayStats();
    };

    const applyWindowItem = (item: ReplayWindowItem) => {
        if (item.op === 'remove') {
            removeTarget(item.target_id);
        } else if (item.family === 'entity') {
            upsertPoint(item.target_id, item.item);
        } else if (item.family === 'event') {
            if (isPointGeometry(item.item.geometry)) upsertPoint(item.target_id, item.item);
            else upsertGeometry(item.target_id, item.item);
        } else if (item.family === 'asset') {
            if (isPointGeometry(item.item.geometry)) upsertPoint(item.target_id, item.item);
            else upsertGeometry(item.target_id, item.item);
        }
        lastAppliedLayerTimeRef.current.set(item.layer_id, item.at);
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

    const ensureShapeProperties = (entity: Cesium.Entity, descriptor: ReplayShapeDescriptor) => {
        entity.name = descriptor.name;
        entity.show = descriptor.visible;
        entity.properties = new Cesium.PropertyBag({
            layer: descriptor.layer,
            subtype: descriptor.subtype,
            source: descriptor.source,
            description: descriptor.description,
        });
    };

    const upsertPoint = (targetId: string, item: ReplayEntity | ReplayEvent | ReplayAsset) => {
        const pointCollection = pointCollectionRef.current;
        if (!pointCollection) return;
        const lat = Number(item.display_lat);
        const lng = Number(item.display_lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const altitude = Number(('altitude_m' in item ? item.altitude_m : 0) || 0);
        const position = safeCartesianFromDegrees(lng, lat, altitude);
        if (!position) return;
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
        if (existing) {
            existing.position = position;
            if (existing.image !== icon) existing.image = icon;
            if (existing.show !== visible) existing.show = visible;
            if (existing.rotation !== rotation) existing.rotation = rotation;
            if (existing.scale !== scale) existing.scale = scale;
        } else {
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

        if (item.layer_id === 'satellite' && Number.isFinite(sampleAtMs)) {
            const sample: ReplayMotionSample = {
                atMs: sampleAtMs,
                position: Cesium.Cartesian3.clone(position),
            };
            const existingTrack = motionTrackMapRef.current.get(targetId);
            if (!existingTrack) {
                motionTrackMapRef.current.set(targetId, {
                    previous: sample,
                    next: null,
                    scratch: Cesium.Cartesian3.clone(position),
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
        const ds = shapeDsRef.current;
        if (!ds) return;
        const descriptors = buildShapeDescriptors(targetId, item);
        const oldIds = shapeMapRef.current.get(targetId) || [];
        const oldSignatures = shapeSignatureMapRef.current.get(targetId) || [];
        const nextIds: string[] = [];
        const nextSignatures: string[] = [];

        descriptors.forEach((descriptor, index) => {
            let entity = ds.entities.getById(descriptor.id);
            const sameSignature = oldSignatures[index] === descriptor.signature;

            if (!entity) {
                if (descriptor.kind === 'polyline') {
                    runtimePerfRef.current.shapeEntityAddCount += 1;
                    runtimePerfRef.current.polylineEntityAddCount += 1;
                    entity = ds.entities.add({
                        id: descriptor.id,
                        name: descriptor.name,
                        show: descriptor.visible,
                        polyline: {
                            positions: descriptor.positions!,
                            width: descriptor.width!,
                            material: descriptor.stroke!,
                        },
                    });
                } else {
                    runtimePerfRef.current.shapeEntityAddCount += 1;
                    runtimePerfRef.current.polygonEntityAddCount += 1;
                    entity = ds.entities.add({
                        id: descriptor.id,
                        name: descriptor.name,
                        show: descriptor.visible,
                        polygon: {
                            hierarchy: descriptor.hierarchy!,
                            material: descriptor.fill!,
                            outline: true,
                            outlineColor: descriptor.stroke!,
                        },
                    });
                }
                ensureShapeProperties(entity, descriptor);
            } else {
                if (!sameSignature) {
                    if (descriptor.kind === 'polyline' && entity.polyline) {
                        runtimePerfRef.current.polylineInPlaceMutationCount += 1;
                        entity.polyline.positions = new Cesium.ConstantProperty(descriptor.positions!);
                        entity.polyline.width = new Cesium.ConstantProperty(descriptor.width!);
                        entity.polyline.material = new Cesium.ColorMaterialProperty(descriptor.stroke!);
                    } else if (descriptor.kind === 'polygon' && entity.polygon) {
                        runtimePerfRef.current.polygonInPlaceMutationCount += 1;
                        entity.polygon.hierarchy = new Cesium.ConstantProperty(descriptor.hierarchy!);
                        entity.polygon.material = new Cesium.ColorMaterialProperty(descriptor.fill!);
                        entity.polygon.outline = new Cesium.ConstantProperty(true);
                        entity.polygon.outlineColor = new Cesium.ConstantProperty(descriptor.stroke!);
                    } else {
                        runtimePerfRef.current.shapeKindFallbackRebuildCount += 1;
                        ds.entities.remove(entity);
                        entity = descriptor.kind === 'polyline'
                            ? ds.entities.add({
                                id: descriptor.id,
                                name: descriptor.name,
                                show: descriptor.visible,
                                polyline: {
                                    positions: descriptor.positions!,
                                    width: descriptor.width!,
                                    material: descriptor.stroke!,
                                },
                            })
                            : ds.entities.add({
                                id: descriptor.id,
                                name: descriptor.name,
                                show: descriptor.visible,
                                polygon: {
                                    hierarchy: descriptor.hierarchy!,
                                    material: descriptor.fill!,
                                    outline: true,
                                    outlineColor: descriptor.stroke!,
                                },
                            });
                        runtimePerfRef.current.shapeEntityAddCount += 1;
                        if (descriptor.kind === 'polyline') {
                            runtimePerfRef.current.polylineEntityAddCount += 1;
                        } else {
                            runtimePerfRef.current.polygonEntityAddCount += 1;
                        }
                    }
                    ensureShapeProperties(entity, descriptor);
                } else {
                    runtimePerfRef.current.shapeSignatureSkipCount += 1;
                    if (entity.show !== descriptor.visible) {
                        entity.show = descriptor.visible;
                    }
                }
            }

            nextIds.push(descriptor.id);
            nextSignatures.push(descriptor.signature);
        });

        for (const oldId of oldIds) {
            if (!nextIds.includes(oldId)) ds.entities.removeById(oldId);
        }

        shapeMapRef.current.set(targetId, nextIds);
        shapeSignatureMapRef.current.set(targetId, nextSignatures);
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

    const applyState = (state: ReplayStateResponse) => {
        clearReplay();
        for (const entity of state.entities) {
            upsertPoint(entity.entity_id, entity);
        }
        for (const event of state.events) {
            if (isPointGeometry(event.geometry)) upsertPoint(event.event_id, event);
            else upsertGeometry(event.event_id, event);
        }
        for (const asset of state.assets) {
            if (isPointGeometry(asset.geometry)) upsertPoint(asset.asset_id, asset);
            else upsertGeometry(asset.asset_id, asset);
        }
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
        clearLayer(layerId);
        const chunkSize = getReplayApplyChunkSize(layerId);
        const renderChunks = options?.renderChunks !== false;
        let processed = 0;
        let signalledProgress = false;
        const signalProgress = () => {
            if (signalledProgress) return;
            signalledProgress = true;
            onProgress?.();
        };
        const maybeYield = async (): Promise<boolean> => {
            processed += 1;
            if (processed % chunkSize !== 0) return true;
            if (renderChunks) {
                requestSceneRender();
                publishReplayStats();
                signalProgress();
            }
            await waitForRenderTurn();
            return !isCancelled();
        };
        for (const entity of state.entities) {
            if (entity.layer_id !== layerId) continue;
            upsertPoint(entity.entity_id, entity);
            if (!(await maybeYield())) return false;
        }
        for (const event of state.events) {
            if (event.layer_id !== layerId) continue;
            if (isPointGeometry(event.geometry)) upsertPoint(event.event_id, event);
            else upsertGeometry(event.event_id, event);
            if (!(await maybeYield())) return false;
        }
        for (const asset of state.assets) {
            if (asset.layer_id !== layerId) continue;
            if (isPointGeometry(asset.geometry)) upsertPoint(asset.asset_id, asset);
            else upsertGeometry(asset.asset_id, asset);
            if (!(await maybeYield())) return false;
        }
        requestSceneRender();
        publishReplayStats();
        signalProgress();
        return !isCancelled();
    };

    const applyWindow = (windowData: ReplayWindowResponse) => {
        for (const item of windowData.items) {
            if (item.op === 'remove') {
                removeTarget(item.target_id);
                continue;
            }
            if (item.family === 'entity') upsertPoint(item.target_id, item.item);
            else if (item.family === 'event') {
                if (isPointGeometry(item.item.geometry)) upsertPoint(item.target_id, item.item);
                else upsertGeometry(item.target_id, item.item);
            } else if (item.family === 'asset') {
                if (isPointGeometry(item.item.geometry)) upsertPoint(item.target_id, item.item);
                else upsertGeometry(item.target_id, item.item);
            }
        }
        requestSceneRender();
        publishReplayStats();
    };

    const getPlaybackBufferSeconds = (layerId: string, speedMultiplier: number): number => {
        const realAheadSeconds = 2;
        const requestedHistorySeconds = Math.max(1, Math.ceil(realAheadSeconds * Math.max(1, speedMultiplier)));
        if (layerId === 'satellite') return Math.min(6, Math.max(2, Math.ceil(Math.max(1, speedMultiplier))));
        if (layerId === 'aircraft') return Math.min(600, Math.max(90, requestedHistorySeconds));
        if (layerId === 'vessel') return Math.min(120, Math.max(20, requestedHistorySeconds));
        return Math.min(1800, Math.max(REPLAY_PLAY_LAYER_CADENCE_SECONDS[layerId] || 60, requestedHistorySeconds));
    };

    const getPlaybackFetchPollMs = (layerId: string, speedMultiplier: number) => {
        if (layerId === 'satellite') return speedMultiplier >= 10 ? 200 : speedMultiplier >= 4 ? 300 : 500;
        if (layerId === 'vessel') return 1000;
        if (layerId === 'aircraft') return 2000;
        const cadenceSeconds = REPLAY_PLAY_LAYER_CADENCE_SECONDS[layerId] || 60;
        return Math.max(2000, Math.min(15_000, cadenceSeconds * 500));
    };

    const getWindowStepSeconds = (layerId: string, windowSeconds: number) => {
        const cadenceSeconds = REPLAY_PLAY_LAYER_CADENCE_SECONDS[layerId] || 60;
        void windowSeconds;
        if (layerId === 'satellite') return 1;
        return Math.max(1, Math.min(300, cadenceSeconds));
    };

    const fetchLayerWindowIntoQueue = async (
        layerId: string,
        fromIso: string,
        toIso: string,
        isCancelled: () => boolean = () => false,
    ) => {
        if (windowFetchInFlightRef.current.has(layerId)) return;
        lastWindowFetchRequestedAtRef.current.set(layerId, Date.now());
        windowFetchInFlightRef.current.add(layerId);
        try {
            const windowSeconds = Math.max(1, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000));
            const params = new URLSearchParams({
                from: fromIso,
                to: toIso,
                layers: layerId,
                stepSeconds: String(getWindowStepSeconds(layerId, windowSeconds)),
            });
            const bbox = getReplayBboxParam(layerId);
            if (bbox) params.set('bbox', bbox);
            const layerLimit = getReplayLayerLimit(layerId);
            if (layerLimit != null) {
                params.set('limit', String(layerLimit));
            }
            const res = await axios.get<ReplayWindowResponse>(`${API_URL}/api/replay/window?${params.toString()}`);
            if (isCancelled()) return;
            enqueueWindowItems(res.data.items);
            lastBufferedLayerTimeRef.current.set(layerId, toIso);
            publishReplayStats();
        } catch (err: any) {
            if (isCancelled()) return;
            const message = err?.message || String(err);
            console.warn(`[ReplayOverlay] layer playback window failed for ${layerId}:`, message);
        } finally {
            windowFetchInFlightRef.current.delete(layerId);
        }
    };

    useEffect(() => {
        const pointCollection = pointCollectionRef.current;
        const ds = shapeDsRef.current;
        const showReplay = mode === 'playback' && playbackKind === 'historical';
        if (pointCollection) pointCollection.show = showReplay;
        if (ds) ds.show = showReplay;
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
            const state = useTimelineStore.getState();
            if (state.mode !== 'playback' || state.playbackKind !== 'historical' || !state.isPlaying) return;
            const currentMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
            let touched = false;
            const drainStartedAt = performance.now();
            const drainBudgetMs = 8;
            let drainedOps = 0;
            const queue = windowQueueRef.current;
            const latestMovingByTarget = new Map<string, ReplayWindowItem>();
            while (queue.head < queue.items.length) {
                if (performance.now() - drainStartedAt > drainBudgetMs) {
                    runtimePerfRef.current.droppedDrainPasses += 1;
                    break;
                }
                const nextItem = queue.items[queue.head];
                const nextAtMs = new Date(nextItem.at).getTime();
                if (!Number.isFinite(nextAtMs) || nextAtMs > currentMs) break;
                queue.head += 1;
                if (nextItem.family === 'entity' && nextItem.op === 'upsert' && REPLAY_MOVING_LAYERS.has(nextItem.layer_id)) {
                    latestMovingByTarget.set(nextItem.target_id, nextItem);
                } else {
                    applyWindowItem(nextItem);
                    touched = true;
                }
                drainedOps += 1;
            }
            if (latestMovingByTarget.size > 0) {
                const pendingMovingItems = Array.from(latestMovingByTarget.values());
                let movingIndex = 0;
                for (; movingIndex < pendingMovingItems.length; movingIndex += 1) {
                    if (performance.now() - drainStartedAt > drainBudgetMs) {
                        runtimePerfRef.current.droppedDrainPasses += 1;
                        break;
                    }
                    const item = pendingMovingItems[movingIndex];
                    applyWindowItem(item);
                    drainedOps += 1;
                }
                if (movingIndex < pendingMovingItems.length) {
                    const remainingMovingItems = pendingMovingItems.slice(movingIndex);
                    const remainingQueuedItems = queue.items.slice(queue.head);
                    queue.items = remainingMovingItems.concat(remainingQueuedItems);
                    queue.head = 0;
                }
                touched = movingIndex > 0 || touched;
            }
            if (queue.head === queue.items.length) {
                queue.items = [];
                queue.head = 0;
            } else if (queue.head >= 2048 && queue.head * 2 >= queue.items.length) {
                compactWindowQueue();
            }
            updateRuntimeQueueLength();
            runtimePerfRef.current.lastDrainOps = drainedOps;
            runtimePerfRef.current.lastDrainMs = performance.now() - drainStartedAt;
            motionTrackMapRef.current.forEach((track, targetId) => {
                const billboard = pointMapRef.current.get(targetId);
                if (!billboard) return;
                if (!track.next) return;
                let position: Cesium.Cartesian3 | null = null;
                const spanMs = track.next.atMs - track.previous.atMs;
                if (spanMs > 0 && currentMs > track.previous.atMs && currentMs < track.next.atMs) {
                    const t = (currentMs - track.previous.atMs) / spanMs;
                    position = Cesium.Cartesian3.lerp(track.previous.position, track.next.position, t, track.scratch);
                } else if (currentMs >= track.next.atMs) {
                    track.previous = track.next;
                    track.next = null;
                    position = track.previous.position;
                }
                if (!position) return;
                billboard.position = position;
                touched = true;
            });
            if (touched) {
                viewer.scene.requestRender();
            }
            publishReplayStats();
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
        if (mode !== 'playback' || playbackKind !== 'historical') return;
        pointMapRef.current.forEach((bb, targetId) => {
            const meta = replayMetaMap.get(normalizeReplayId(targetId));
            bb.show = !meta || computeVisible(targetId, meta.layerId, meta.subtype, meta.source);
        });
        if (shapeDsRef.current) {
            shapeDsRef.current.entities.values.forEach((entity) => {
                const props: any = entity.properties;
                const layerName = props?.layer?.getValue?.();
                const subtype = props?.subtype?.getValue?.();
                const source = props?.source?.getValue?.();
                const logicalId = String(entity.id).split('#')[0];
                const layerId = Object.entries(REPLAY_LAYER_MAP).find(([, replayLayerId]) => toHudLayerName(replayLayerId) === layerName)?.[1];
                if (!layerId) return;
                entity.show = computeVisible(logicalId, layerId, subtype, source);
            });
        }
        requestSceneRender();
        publishReplayStats();
    }, [mode, playbackKind, subtypeVisibility, sourceVisibility, isolatedEntityId]);

    useEffect(() => {
        if (!viewer || mode !== 'playback' || playbackKind !== 'historical') return;
        if (activeReplayLayers.length === 0) {
            clearReplay();
            lastAppliedTimeRef.current = null;
            lastAppliedSeekVersionRef.current = replaySeekVersion;
            layersKeyRef.current = '';
            setReplayHydrating(false);
            return;
        }
        const cancelVersion = replayCancelVersionRef.current;
        const currentIso = currentTime.toISOString();
        const previousIso = lastAppliedTimeRef.current;
        const layersChanged = layersKeyRef.current !== layersKey;
        const deltaMs = previousIso ? currentTime.getTime() - new Date(previousIso).getTime() : 0;
        const manualSeekRequested = replaySeekVersion !== lastAppliedSeekVersionRef.current;
        const hasHistoricalFrame = Boolean(previousIso);
        if (!hasHistoricalFrame && !manualSeekRequested) {
            return;
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
            const loadLayerState = async (layerId: string): Promise<ReplayStateResponse | null> => {
                try {
                    const params = new URLSearchParams({
                        at: currentIso,
                        layers: layerId,
                    });
                    const bbox = getReplayBboxParam(layerId);
                    if (bbox) params.set('bbox', bbox);
                    const layerLimit = getReplayLayerLimit(layerId);
                    if (layerLimit != null) {
                        params.set('limit', String(layerLimit));
                    }
                    const res = await axios.get<ReplayStateResponse>(`${API_URL}/api/replay/state?${params.toString()}`);
                    if (isCancelled()) return null;
                    return res.data;
                } catch (err: any) {
                    if (isCancelled()) return null;
                    const message = err?.message || String(err);
                    console.warn(`[ReplayOverlay] layer seek failed for ${layerId}:`, message);
                    return null;
                }
            };

                const fetchLayerState = async (layerId: string) => {
                const state = await loadLayerState(layerId);
                if (!state || isCancelled()) return;
                const applied = await applyLayerState(layerId, state, isCancelled);
                if (!applied || isCancelled()) return;
                lastAppliedLayerTimeRef.current.set(layerId, currentIso);
                lastBufferedLayerTimeRef.current.set(layerId, currentIso);
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
                    const bootstrapResults = await Promise.all(
                        interactiveReplayLayers.map(async (layerId) => ({
                            layerId,
                            state: await loadLayerState(layerId),
                        })),
                    );
                    if (isCancelled()) return;
                    const readyBootstrapLayers = bootstrapResults.filter((result) => Boolean(result.state));
                    if (readyBootstrapLayers.length > 0) {
                        clearReplay();
                        for (const result of readyBootstrapLayers) {
                            if (!result.state) continue;
                            const applied = await applyLayerState(result.layerId, result.state, isCancelled);
                            if (!applied || isCancelled()) return;
                            lastAppliedLayerTimeRef.current.set(result.layerId, currentIso);
                            lastBufferedLayerTimeRef.current.set(result.layerId, currentIso);
                            await waitForRenderTurn();
                        }
                    }
                }
                const bootstrapWindowPrefetches = sortedReplayLayers
                    .filter((layerId) => REPLAY_MOVING_LAYERS.has(layerId))
                    .map((layerId) => {
                        const currentMs = new Date(currentIso).getTime();
                        const state = useTimelineStore.getState();
                        const targetAheadSeconds = getPlaybackBufferSeconds(layerId, state.speedMultiplier);
                        return fetchLayerWindowIntoQueue(
                            layerId,
                            currentIso,
                            new Date(currentMs + targetAheadSeconds * 1000).toISOString(),
                            isCancelled,
                        ).then(() => layerId);
                    });
                if (bootstrapWindowPrefetches.length > 0) {
                    await Promise.race([
                        Promise.any(bootstrapWindowPrefetches).catch(() => undefined),
                        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
                    ]);
                    void Promise.allSettled(bootstrapWindowPrefetches).then(() => {
                        if (isCancelled()) return;
                        publishReplayStats();
                    });
                }
                if (isCancelled()) return;
                // Historical playback becomes interactive only after the
                // primary moving frame is consistent AND the first moving
                // window has had a fair chance to arrive. Do not stall the
                // entire UI on the slowest moving layer fetch.
                releaseReplayInteraction();
                void (async () => {
                    for (const layerId of eagerlyDeferredReplayLayers) {
                        await fetchLayerState(layerId);
                        if (isCancelled()) return;
                        const state = useTimelineStore.getState();
                        if (state.isPlaying) {
                            const bufferedFromIso = lastBufferedLayerTimeRef.current.get(layerId) || currentIso;
                            const playbackIso = state.currentTime.toISOString();
                            if (new Date(playbackIso).getTime() > new Date(bufferedFromIso).getTime()) {
                                await fetchLayerWindowIntoQueue(
                                    layerId,
                                    bufferedFromIso,
                                    playbackIso,
                                    isCancelled,
                                );
                                if (isCancelled()) return;
                            }
                        }
                        await waitForRenderTurn();
                    }
                    for (const layerId of backgroundDeferredReplayLayers) {
                        await fetchLayerState(layerId);
                        if (isCancelled()) return;
                        const state = useTimelineStore.getState();
                        if (state.isPlaying) {
                            const bufferedFromIso = lastBufferedLayerTimeRef.current.get(layerId) || currentIso;
                            const playbackIso = state.currentTime.toISOString();
                            if (new Date(playbackIso).getTime() > new Date(bufferedFromIso).getTime()) {
                                await fetchLayerWindowIntoQueue(
                                    layerId,
                                    bufferedFromIso,
                                    playbackIso,
                                    isCancelled,
                                );
                                if (isCancelled()) return;
                            }
                        }
                        await waitForRenderTurn();
                    }
                    if (isCancelled()) return;
                    const mergedLayerTimes = new Map(lastAppliedLayerTimeRef.current);
                    for (const layerId of sortedReplayLayers) {
                        if (!mergedLayerTimes.has(layerId)) mergedLayerTimes.set(layerId, currentIso);
                    }
                    lastAppliedLayerTimeRef.current = mergedLayerTimes;
                    lastBufferedLayerTimeRef.current = new Map(mergedLayerTimes);
                    publishReplayStats();
                })().catch((err: any) => {
                    if (isCancelled()) return;
                    console.warn('[ReplayOverlay] deferred seek hydration failed:', err?.message || err);
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
            .catch((err: any) => {
                if (isCancelled()) return;
                console.warn('[ReplayOverlay] fetch failed:', err?.message || err);
                setReplayHydrating(false);
            })
            .finally(() => {
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
    }, [viewer, mode, playbackKind, currentTime, replaySeekVersion, layersKey, activeReplayLayers, satelliteRenderLimit, replayDrainVersion, setReplayHydrating]);

    useEffect(() => {
        if (!viewer || mode !== 'playback' || playbackKind !== 'historical') return;
        let cancelled = false;
        const cancelVersion = replayCancelVersionRef.current;
        const tick = () => {
            if (cancelled || viewer.isDestroyed()) return;
            const state = useTimelineStore.getState();
            if (state.mode !== 'playback' || state.playbackKind !== 'historical' || !state.isPlaying) return;
            const frameAnchorIso = lastAppliedTimeRef.current;
            if (!frameAnchorIso) return;
            const currentMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
            const sortedReplayLayers = [...activeReplayLayers].sort((a, b) => {
                const aPriority = REPLAY_PLAY_LAYER_PRIORITY[a] ?? Number.MAX_SAFE_INTEGER;
                const bPriority = REPLAY_PLAY_LAYER_PRIORITY[b] ?? Number.MAX_SAFE_INTEGER;
                return aPriority - bPriority;
            });
            for (const layerId of sortedReplayLayers) {
                const appliedIso = lastAppliedLayerTimeRef.current.get(layerId) || frameAnchorIso;
                const bufferedIso = lastBufferedLayerTimeRef.current.get(layerId) || appliedIso;
                const bufferedAheadSeconds = (new Date(bufferedIso).getTime() - currentMs) / 1000;
                const targetAheadSeconds = getPlaybackBufferSeconds(layerId, state.speedMultiplier);
                if (bufferedAheadSeconds >= targetAheadSeconds * 0.5) continue;
                const lastRequestedAt = lastWindowFetchRequestedAtRef.current.get(layerId) || 0;
                const minPollMs = getPlaybackFetchPollMs(layerId, state.speedMultiplier);
                if (Date.now() - lastRequestedAt < minPollMs) continue;
                const fromMs = new Date(bufferedIso).getTime();
                const toMs = Math.max(currentMs, fromMs) + targetAheadSeconds * 1000;
                void fetchLayerWindowIntoQueue(
                    layerId,
                    bufferedIso,
                    new Date(toMs).toISOString(),
                    () => cancelled || replayCancelVersionRef.current !== cancelVersion,
                );
            }
        };
        const interval = setInterval(tick, 150);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [viewer, mode, playbackKind, activeReplayLayers]);
}
