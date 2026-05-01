import { useCallback, useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { WIFI_ICONS } from '../icons/map-icons';
import { getViewerHeightAboveGroundMetersMostDetailed } from './position-utils';

type WifiSecurity = 'open' | 'encrypted' | 'unknown';

type WifiRecord = {
    id?: string;
    lat?: number;
    lng?: number;
    security?: string | null;
    lastSeen?: string | null;
    source?: string | null;
};

type WifiCompleteness = {
    status?: 'pending' | 'fetching' | 'partial' | 'complete' | 'rate_limited' | 'error';
    fetchedCount?: number;
    totalResults?: number | null;
    pageCount?: number;
    nextFetchAfter?: string | null;
    note?: string;
};

export interface WifiMeta {
    id: string;
    name: string;
    lat: number;
    lng: number;
    security: WifiSecurity;
    lastSeen: string | null;
    layer: 'Wi-Fi Network';
    source: 'WiGLE';
    description: string;
}

export const wifiMetaMap = new Map<string, WifiMeta>();

type WifiDebugWindow = Window & {
    __openspyWifiMetaMap?: typeof wifiMetaMap;
    __openspyWifiDebug?: Record<string, unknown>;
};

const TILE_DEG = 0.001;
const MAX_LOADED_TILES = 120;
const MAX_TILES_PER_VIEWPORT = 4;
const FETCH_CONCURRENCY = 1;
const WIFI_FETCH_TIMEOUT_MS = 25_000;
const WIFI_AGL_CUTOFF_METERS = 300;
const WIFI_TERRAIN_HEIGHT_RETRY_MS = 1_500;
const WIFI_RATE_LIMIT_COOLDOWN_MS = 60_000;
const WIFI_ERROR_COOLDOWN_MS = 15_000;

type TileState = {
    collection: Cesium.BillboardCollection;
    ids: string[];
};

type WifiTileCell = [number, number, number, number];
type LoadTileFn = (cell: WifiTileCell, generation: number, allowRefresh?: boolean) => Promise<void>;
type PreparedWifiRecord = {
    id: string;
    lat: number;
    lng: number;
    security: WifiSecurity;
    meta: WifiMeta;
};

function emptyCounts(): Record<WifiSecurity, number> {
    return { open: 0, encrypted: 0, unknown: 0 };
}

function normalizeSecurity(value: unknown): WifiSecurity {
    if (value === 'open' || value === 'encrypted') return value;
    return 'unknown';
}

function cellKey(south: number, west: number): string {
    return `${south.toFixed(3)},${west.toFixed(3)}`;
}

function wrapLngDelta(a: number, b: number): number {
    const d = Math.abs(a - b);
    return Math.min(d, 360 - d);
}

function cellsForViewport(
    south: number,
    west: number,
    north: number,
    east: number,
): Array<[number, number, number, number]> {
    if (east < west) {
        return [
            ...cellsForViewport(south, west, north, 180),
            ...cellsForViewport(south, -180, north, east),
        ];
    }
    if (east <= west || north <= south) return [];

    const clampedS = Math.max(-90, Math.floor(south / TILE_DEG) * TILE_DEG);
    const clampedW = Math.max(-180, Math.floor(west / TILE_DEG) * TILE_DEG);
    const clampedN = Math.min(90, Math.ceil(north / TILE_DEG) * TILE_DEG);
    const clampedE = Math.min(180, Math.ceil(east / TILE_DEG) * TILE_DEG);

    const out: Array<[number, number, number, number]> = [];
    for (let s = clampedS; s < clampedN; s += TILE_DEG) {
        for (let w = clampedW; w < clampedE; w += TILE_DEG) {
            const n = Math.min(90, s + TILE_DEG);
            const e = Math.min(180, w + TILE_DEG);
            if (s >= 90 || w >= 180) continue;
            out.push([s, w, n, e]);
        }
    }
    return out;
}

function formatLastSeen(value: string | null): string {
    if (!value) return 'last seen unknown';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'last seen unknown';
    return `last seen ${date.toISOString().slice(0, 10)}`;
}

function setWifiDebug(patch: Record<string, unknown>): void {
    if (typeof window === 'undefined') return;
    const debugWindow = window as WifiDebugWindow;
    debugWindow.__openspyWifiDebug = {
        ...(debugWindow.__openspyWifiDebug || {}),
        ...patch,
        updatedAt: new Date().toISOString(),
    };
}

export function useWifiLayer(viewer: Cesium.Viewer | null) {
    const gateReleased = useSecondaryLoadGate();
    const isSourceOn = useTimelineStore((s) => s.sources.wifi);
    const isVisible = useTimelineStore((s) => s.visibility.wifi);
    const mode = useTimelineStore((s) => s.mode);
    const playbackKind = useTimelineStore((s) => s.playbackKind);
    const subtypeVisibility = useTimelineStore((s) => s.subtypeVisibility);
    const isolatedEntityId = useTimelineStore((s) => s.isolatedEntityId);
    const metricStatus = useTimelineStore((s) => s.streamMetrics.wifi?.status);

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tilesRef = useRef<Map<string, TileState>>(new Map());
    const inFlightCellsRef = useRef<Set<string>>(new Set());
    const refreshTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const terrainRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const loadTileRef = useRef<LoadTileFn | null>(null);
    const scheduleViewportLoadRef = useRef<(() => void) | null>(null);
    const genRef = useRef(0);
    const activeRef = useRef(true);
    const heightGateOpenRef = useRef(false);
    const cooldownUntilRef = useRef(0);
    const metricStatusRef = useRef(metricStatus);
    const aggregateCountsRef = useRef<Record<WifiSecurity, number>>(emptyCounts());

    useEffect(() => {
        metricStatusRef.current = metricStatus;
    }, [metricStatus]);

    const clearRefreshTimer = useCallback((key: string) => {
        const timer = refreshTimersRef.current.get(key);
        if (timer) clearTimeout(timer);
        refreshTimersRef.current.delete(key);
    }, []);

    const clearTerrainRetry = useCallback(() => {
        if (terrainRetryRef.current) clearTimeout(terrainRetryRef.current);
        terrainRetryRef.current = null;
    }, []);

    const removeTile = useCallback((key: string, targetViewer?: Cesium.Viewer | null) => {
        const v = targetViewer || viewer;
        const tile = tilesRef.current.get(key);
        if (!tile) return;
        if (v && !v.isDestroyed()) {
            v.scene.primitives.remove(tile.collection);
        }
        for (const id of tile.ids) {
            const meta = wifiMetaMap.get(id);
            if (meta) aggregateCountsRef.current[meta.security] = Math.max(0, aggregateCountsRef.current[meta.security] - 1);
            wifiMetaMap.delete(id);
        }
        tilesRef.current.delete(key);
        clearRefreshTimer(key);
    }, [clearRefreshTimer, viewer]);

    const clearTiles = useCallback((targetViewer?: Cesium.Viewer | null) => {
        for (const tile of Array.from(tilesRef.current.values())) {
            const v = targetViewer || viewer;
            if (v && !v.isDestroyed()) {
                v.scene.primitives.remove(tile.collection);
            }
            for (const id of tile.ids) {
                wifiMetaMap.delete(id);
            }
        }
        for (const timer of Array.from(refreshTimersRef.current.values())) {
            clearTimeout(timer);
        }
        clearTerrainRetry();
        refreshTimersRef.current.clear();
        tilesRef.current.clear();
        inFlightCellsRef.current.clear();
        aggregateCountsRef.current = emptyCounts();
        useTimelineStore.getState().setSubtypeCounts('wifi', aggregateCountsRef.current);
        useTimelineStore.getState().setStreamMetric('wifi', {
            count: 0,
        });
    }, [clearTerrainRetry, viewer]);

    const applyVisibility = useCallback(() => {
        const showLayer = heightGateOpenRef.current && isSourceOn && isVisible && !(mode === 'playback' && playbackKind === 'historical');
        for (const tile of Array.from(tilesRef.current.values())) {
            tile.collection.show = showLayer;
            for (let i = 0; i < tile.collection.length; i++) {
                const billboard = tile.collection.get(i);
                const id = String(billboard.id || '');
                const meta = wifiMetaMap.get(id);
                const subtypeOn = meta ? subtypeVisibility[`wifi:${meta.security}`] !== false : true;
                billboard.show = showLayer && subtypeOn && (!isolatedEntityId || isolatedEntityId === id);
            }
        }
        viewer?.scene.requestRender();
    }, [isSourceOn, isVisible, isolatedEntityId, mode, playbackKind, subtypeVisibility, viewer]);

    const evictIfNeeded = useCallback(() => {
        while (tilesRef.current.size > MAX_LOADED_TILES) {
            const firstKey = tilesRef.current.keys().next().value as string | undefined;
            if (!firstKey) break;
            const tile = tilesRef.current.get(firstKey);
            if (!tile) break;
            removeTile(firstKey, viewer);
        }
        useTimelineStore.getState().setSubtypeCounts('wifi', aggregateCountsRef.current);
    }, [removeTile, viewer]);

    const scheduleTileRefresh = useCallback((key: string, cell: WifiTileCell, generation: number, nextFetchAfter?: string | null) => {
        clearRefreshTimer(key);
        const nextAtMs = nextFetchAfter ? Date.parse(nextFetchAfter) : NaN;
        const delayMs = Number.isFinite(nextAtMs)
            ? Math.max(2_000, nextAtMs - Date.now() + 750)
            : 5_000;
        const timer = setTimeout(() => {
            refreshTimersRef.current.delete(key);
            if (!activeRef.current || generation !== genRef.current) return;
            void loadTileRef.current?.(cell, generation, true);
        }, delayMs);
        refreshTimersRef.current.set(key, timer);
    }, [clearRefreshTimer]);

    const scheduleTerrainHeightRetry = useCallback(() => {
        clearTerrainRetry();
        terrainRetryRef.current = setTimeout(() => {
            terrainRetryRef.current = null;
            scheduleViewportLoadRef.current?.();
        }, WIFI_TERRAIN_HEIGHT_RETRY_MS);
    }, [clearTerrainRetry]);

    const loadTile = useCallback<LoadTileFn>(async (cell, generation, allowRefresh = false) => {
        if (!viewer || viewer.isDestroyed() || !activeRef.current) return;
        if (!heightGateOpenRef.current) return;
        const [south, west, north, east] = cell;
        const key = cellKey(south, west);
        if ((!allowRefresh && tilesRef.current.has(key)) || inFlightCellsRef.current.has(key)) return;
        inFlightCellsRef.current.add(key);
        try {
            setWifiDebug({ phase: 'fetch-start', bbox: `${south},${west},${north},${east}`, allowRefresh });
            const response = await axios.get(`${API_URL}/api/wifi`, {
                params: { bbox: `${south},${west},${north},${east}` },
                timeout: WIFI_FETCH_TIMEOUT_MS,
            });
            if (generation !== genRef.current || viewer.isDestroyed() || !activeRef.current) return;
            const records: WifiRecord[] = Array.isArray(response.data?.data) ? response.data.data : [];
            const prepared: PreparedWifiRecord[] = [];
            for (const record of records) {
                const id = String(record.id || '');
                const lat = Number(record.lat);
                const lng = Number(record.lng);
                if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
                const security = normalizeSecurity(record.security);
                prepared.push({
                    id,
                    lat,
                    lng,
                    security,
                    meta: {
                        id,
                        name: 'Wi-Fi Network',
                        lat,
                        lng,
                        security,
                        lastSeen: record.lastSeen || null,
                        layer: 'Wi-Fi Network',
                        source: 'WiGLE',
                        description: `WiGLE observation, ${formatLastSeen(record.lastSeen || null)}`,
                    },
                });
            }
            const nextIds = prepared.map((record) => record.id);
            const nextIdSet = new Set(nextIds);
            setWifiDebug({
                phase: 'fetch-success',
                bbox: `${south},${west},${north},${east}`,
                records: prepared.length,
                completeness: response.data?.completeness || null,
            });
            const completeness: WifiCompleteness = response.data?.completeness || {};
            const completenessStatus = completeness.status;
            const incomplete = response.data?.complete === false || response.data?.truncated === true;
            const metricStatus = completenessStatus === 'rate_limited'
                ? 'rate-limited'
                : completenessStatus === 'error'
                    ? 'error'
                    : incomplete
                        ? 'warning'
                        : 'streaming';
            const updateMetricAndRefresh = () => {
                useTimelineStore.getState().setSubtypeCounts('wifi', aggregateCountsRef.current);
                useTimelineStore.getState().setStreamMetric('wifi', {
                    count: wifiMetaMap.size,
                    status: metricStatus,
                    note: completeness.note || (incomplete
                        ? `WiGLE cached ${response.data?.fetchedCount ?? prepared.length}/${response.data?.totalResults ?? 'unknown'} records`
                        : undefined),
                });
                if (incomplete && completenessStatus !== 'error') {
                    scheduleTileRefresh(key, cell, generation, completeness.nextFetchAfter || null);
                } else {
                    clearRefreshTimer(key);
                }
            };
            const existingTile = tilesRef.current.get(key);
            if (existingTile && existingTile.ids.every((id) => nextIdSet.has(id))) {
                const existingIdSet = new Set(existingTile.ids);
                const appendedCount = Math.max(0, nextIds.length - existingTile.ids.length);
                for (const preparedRecord of prepared) {
                    const previous = wifiMetaMap.get(preparedRecord.id);
                    if (previous && previous.security !== preparedRecord.security) {
                        aggregateCountsRef.current[previous.security] = Math.max(0, aggregateCountsRef.current[previous.security] - 1);
                        aggregateCountsRef.current[preparedRecord.security] += 1;
                        for (let i = 0; i < existingTile.collection.length; i++) {
                            const billboard = existingTile.collection.get(i);
                            if (String(billboard.id || '') === preparedRecord.id) {
                                billboard.image = WIFI_ICONS[preparedRecord.security] || WIFI_ICONS.unknown;
                                break;
                            }
                        }
                    }
                    wifiMetaMap.set(preparedRecord.id, preparedRecord.meta);
                    if (!existingIdSet.has(preparedRecord.id)) {
                        existingIdSet.add(preparedRecord.id);
                        aggregateCountsRef.current[preparedRecord.security] += 1;
                        existingTile.ids.push(preparedRecord.id);
                        existingTile.collection.add({
                            id: preparedRecord.id,
                            image: WIFI_ICONS[preparedRecord.security] || WIFI_ICONS.unknown,
                            position: Cesium.Cartesian3.fromDegrees(preparedRecord.lng, preparedRecord.lat, 0),
                            scale: 0.78,
                            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                            show: isSourceOn && isVisible && subtypeVisibility[`wifi:${preparedRecord.security}`] !== false,
                        });
                    }
                }
                setWifiDebug({
                    phase: appendedCount > 0 ? 'fetch-appended' : 'fetch-unchanged',
                    bbox: `${south},${west},${north},${east}`,
                    records: prepared.length,
                    completeness: response.data?.completeness || null,
                });
                applyVisibility();
                updateMetricAndRefresh();
                viewer.scene.requestRender();
                return;
            }
            removeTile(key, viewer);
            const collection = new Cesium.BillboardCollection({
                scene: viewer.scene,
                blendOption: Cesium.BlendOption.TRANSLUCENT,
            });
            for (const preparedRecord of prepared) {
                wifiMetaMap.set(preparedRecord.id, preparedRecord.meta);
                aggregateCountsRef.current[preparedRecord.security] += 1;
                collection.add({
                    id: preparedRecord.id,
                    image: WIFI_ICONS[preparedRecord.security] || WIFI_ICONS.unknown,
                    position: Cesium.Cartesian3.fromDegrees(preparedRecord.lng, preparedRecord.lat, 0),
                    scale: 0.78,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    show: isSourceOn && isVisible && subtypeVisibility[`wifi:${preparedRecord.security}`] !== false,
                });
            }
            viewer.scene.primitives.add(collection);
            tilesRef.current.set(key, { collection, ids: nextIds });
            evictIfNeeded();
            applyVisibility();
            updateMetricAndRefresh();
        } catch (error: unknown) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            cooldownUntilRef.current = Date.now() + (status === 429 ? WIFI_RATE_LIMIT_COOLDOWN_MS : WIFI_ERROR_COOLDOWN_MS);
            const responseError = axios.isAxiosError(error) && typeof error.response?.data?.error === 'string'
                ? error.response.data.error
                : null;
            const message = error instanceof Error ? error.message : 'Wi-Fi fetch failed';
            useTimelineStore.getState().setStreamMetric('wifi', {
                status: status === 503 ? 'auth-missing' : status === 429 ? 'rate-limited' : 'error',
                note: responseError || message,
            });
            setWifiDebug({ phase: 'fetch-error', status, message: responseError || message });
        } finally {
            inFlightCellsRef.current.delete(key);
        }
    }, [applyVisibility, clearRefreshTimer, evictIfNeeded, isSourceOn, isVisible, removeTile, scheduleTileRefresh, subtypeVisibility, viewer]);

    loadTileRef.current = loadTile;

    const scheduleViewportLoad = useCallback(() => {
        if (!viewer || viewer.isDestroyed()) return;
        const currentViewer: Cesium.Viewer = viewer;
        clearTerrainRetry();
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            if (currentViewer.isDestroyed() || !activeRef.current) return;
            const historicalReplay = mode === 'playback' && playbackKind === 'historical';
            const currentMetricStatus = metricStatusRef.current;
            if (!gateReleased || !isSourceOn || historicalReplay || currentMetricStatus === 'auth-missing') {
                heightGateOpenRef.current = false;
                applyVisibility();
                if (historicalReplay) {
                    useTimelineStore.getState().setStreamMetric('wifi', { status: 'disabled', note: 'Live-only viewport layer' });
                }
                setWifiDebug({
                    phase: 'gate-blocked',
                    gateReleased,
                    isSourceOn,
                    historicalReplay,
                    currentMetricStatus,
                });
                return;
            }
            if (Date.now() < cooldownUntilRef.current) {
                useTimelineStore.getState().setStreamMetric('wifi', {
                    status: currentMetricStatus === 'rate-limited' ? 'rate-limited' : 'warning',
                    note: 'WiGLE query cooldown active',
                });
                setWifiDebug({ phase: 'cooldown', cooldownUntil: new Date(cooldownUntilRef.current).toISOString() });
                return;
            }
            const heightAboveGroundMeters = await getViewerHeightAboveGroundMetersMostDetailed(currentViewer);
            if (currentViewer.isDestroyed() || !activeRef.current) return;
            if (heightAboveGroundMeters == null) {
                heightGateOpenRef.current = false;
                applyVisibility();
                useTimelineStore.getState().setStreamMetric('wifi', {
                    status: 'disabled',
                    note: 'Waiting for terrain height before Wi-Fi query',
                });
                setWifiDebug({ phase: 'height-unavailable' });
                scheduleTerrainHeightRetry();
                return;
            }
            if (heightAboveGroundMeters > WIFI_AGL_CUTOFF_METERS) {
                heightGateOpenRef.current = false;
                applyVisibility();
                useTimelineStore.getState().setStreamMetric('wifi', {
                    status: 'disabled',
                    note: `Zoom below ${WIFI_AGL_CUTOFF_METERS} m above ground to query Wi-Fi observations`,
                });
                setWifiDebug({ phase: 'height-above-cutoff', heightAboveGroundMeters });
                return;
            }
            heightGateOpenRef.current = true;
            applyVisibility();
            const rect = currentViewer.camera.computeViewRectangle(currentViewer.scene.globe.ellipsoid);
            if (!rect) {
                setWifiDebug({ phase: 'no-view-rectangle', heightAboveGroundMeters });
                return;
            }
            const south = Cesium.Math.toDegrees(rect.south);
            const north = Cesium.Math.toDegrees(rect.north);
            const west = Cesium.Math.toDegrees(rect.west);
            const east = Cesium.Math.toDegrees(rect.east);
            const center = Cesium.Cartographic.fromCartesian(currentViewer.camera.positionWC);
            const centerLat = Cesium.Math.toDegrees(center.latitude);
            const centerLng = Cesium.Math.toDegrees(center.longitude);
            const cells = cellsForViewport(south, west, north, east)
                .filter(([s, w]) => {
                    const key = cellKey(s, w);
                    return !tilesRef.current.has(key) && !inFlightCellsRef.current.has(key);
                })
                .sort((a, b) => {
                    const acLat = (a[0] + a[2]) / 2;
                    const acLng = (a[1] + a[3]) / 2;
                    const bcLat = (b[0] + b[2]) / 2;
                    const bcLng = (b[1] + b[3]) / 2;
                    return (Math.abs(acLat - centerLat) + wrapLngDelta(acLng, centerLng)) -
                        (Math.abs(bcLat - centerLat) + wrapLngDelta(bcLng, centerLng));
                })
                .slice(0, MAX_TILES_PER_VIEWPORT);
            setWifiDebug({ phase: 'cells-ready', heightAboveGroundMeters, cells: cells.length, south, west, north, east });
            if (cells.length === 0) return;
            const generation = genRef.current;
            let cursor = 0;
            const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, cells.length) }, async () => {
                while (cursor < cells.length && generation === genRef.current) {
                    const cell = cells[cursor++];
                    await loadTile(cell, generation);
                }
            });
            void Promise.all(workers);
        }, 350);
    }, [applyVisibility, clearTerrainRetry, gateReleased, isSourceOn, loadTile, mode, playbackKind, scheduleTerrainHeightRetry, viewer]);

    scheduleViewportLoadRef.current = scheduleViewportLoad;

    useEffect(() => {
        if (typeof window !== 'undefined') {
            (window as WifiDebugWindow).__openspyWifiMetaMap = wifiMetaMap;
            setWifiDebug({ phase: 'mounted' });
        }
        return () => {
            if (typeof window !== 'undefined') {
                delete (window as WifiDebugWindow).__openspyWifiMetaMap;
                delete (window as WifiDebugWindow).__openspyWifiDebug;
            }
        };
    }, []);

    useEffect(() => {
        if (!viewer) return;
        activeRef.current = true;
        const moveEnd = () => scheduleViewportLoad();
        viewer.camera.moveEnd.addEventListener(moveEnd);
        scheduleViewportLoad();
        return () => {
            activeRef.current = false;
            viewer.camera.moveEnd.removeEventListener(moveEnd);
            if (debounceRef.current) clearTimeout(debounceRef.current);
            clearTiles(viewer);
        };
    }, [clearTiles, scheduleViewportLoad, viewer]);

    useEffect(() => {
        if (!isSourceOn || (mode === 'playback' && playbackKind === 'historical')) {
            genRef.current += 1;
            clearTiles(viewer);
            useTimelineStore.getState().setStreamMetric('wifi', {
                count: 0,
                status: 'disabled',
                note: mode === 'playback' && playbackKind === 'historical' ? 'Live-only viewport layer' : undefined,
            });
        } else {
            scheduleViewportLoad();
        }
    }, [clearTiles, isSourceOn, mode, playbackKind, scheduleViewportLoad, viewer]);

    useEffect(() => {
        applyVisibility();
    }, [applyVisibility]);
}
