import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { io, Socket } from 'socket.io-client';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { perfLog } from '../lib/perf-log';
import { getAviIcon, getShipIcon, DARK_VESSEL_ICON } from '../icons/map-icons';
import { getViewerAltitudeMeters, safeCartesianFromDegrees } from './position-utils';
import { TrailBatcher } from './TrailBatcher';

declare global {
    interface Window {
        __openspyLiveStats?: {
            aircraftBillboards: number;
            vesselBillboards: number;
            darkVessels: number;
            queuedUpdate: boolean;
            processingUpdate: boolean;
            lastUpdateReceivedAt: string | null;
            lastProcessStartedAt: string | null;
            lastProcessFinishedAt: string | null;
            lastProcessMs: number;
            renderMode?: 'raw' | 'cluster';
            gridDegrees?: number | null;
            aircraftRenderedMarkers?: number;
            vesselRenderedMarkers?: number;
        };
    }
}

const getAviSVG = getAviIcon;

const getShipSVG = getShipIcon;

const LIVE_APPLY_BUDGET_MS = 8;
const LIVE_APPLY_YIELD_EVERY = 500;

function yieldToBrowser(): Promise<void> {
    return new Promise(resolve => {
        // Do not wait for browser "idle" here. In the full Cesium/WebGL
        // live scene there may be no reliable idle period while imagery,
        // satellites and billboards are settling, and requestIdleCallback can
        // starve the initial aircraft/vessel materialization. A macrotask
        // yield keeps input/rendering responsive without blocking completion.
        setTimeout(resolve, 0);
    });
}

// Metadata stored per aircraft for picking and EntityHUD.
interface AircraftMeta {
    id: string;         // equals icao24 (primary key)
    icao24: string;
    callsign?: string;  // loaded on demand for HUD/details
    origin?: string;
    type: string;
    speed: number;
    heading: number;
    lat: number;
    lng: number;
    alt: number;
    // New fields from OpenSky state vector
    squawk?: string | null;
    verticalRate?: number | null; // m/s
    onGround?: boolean;
    lastContact?: number | null;  // unix timestamp
    aggregated?: boolean;
    count?: number;
}

// Global registry so Globe.tsx picking can look up aircraft metadata by billboard.
// Key = billboard reference (set as billboard.id), value = metadata.
export const aircraftMetaMap = new Map<string, AircraftMeta>();

interface VesselMeta {
    id: string;
    name?: string | null;
    type: string;
    lat: number;
    lng: number;
    speed: number;
    heading: number;
    callSign?: string | null;
    imo?: string | null;
    navigationStatus?: string | null;
    destination?: string | null;
    eta?: string | null;
    rateOfTurn?: number | null;
    draught?: number | null;
    vesselLength?: number | null;
    beam?: number | null;
    cog?: number | null;
    aggregated?: boolean;
    count?: number;
}

export const vesselMetaMap = new Map<string, VesselMeta>();

function getLiveClusterGridDegrees(altitudeMeters: number | null): number | null {
    if (altitudeMeters == null) return 5.0;
    if (altitudeMeters >= 12_000_000) return 10.0;
    if (altitudeMeters >= 6_000_000) return 5.0;
    if (altitudeMeters >= 2_500_000) return 2.5;
    return null;
}

function liveClusterCoordinate(value: number, min: number, max: number, gridDegrees: number): number {
    const cell = Math.floor((value - min) / gridDegrees);
    return Math.max(min, Math.min(max, min + cell * gridDegrees + gridDegrees / 2));
}

function liveClusterPixelSize(count: number): number {
    return Math.max(7, Math.min(24, 6 + Math.log2(Math.max(1, count)) * 2.4));
}

function isFiniteLatLng(lat: unknown, lng: unknown): boolean {
    return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
}

export function useDynamicLayers(viewer: Cesium.Viewer | null) {
    // Visibility + subtype filters are reactive because they only touch
    // already-rendered entities. Source flags are NOT in any deps —
    // handlers read them fresh per message, so toggling a source does not
    // tear down the socket (MEDIUM 2 fix).
    const isAviationVisible = useTimelineStore(s => s.visibility.aviation);
    const isMaritimeVisible = useTimelineStore(s => s.visibility.maritime);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const mode = useTimelineStore(s => s.mode);
    const showTrajectories = useTimelineStore(s => s.showTrajectories);
    const requestSceneRender = () => {
        if (!viewer || viewer.isDestroyed()) return;
        viewer.scene.requestRender();
    };

    // Aviation: BillboardCollection (GPU-batched, 1 draw call for 11K billboards)
    const aviBillboardsRef = useRef<Cesium.BillboardCollection | null>(null);
    const aviBillboardMap = useRef<Map<string, Cesium.Billboard>>(new Map());
    const aviClusterPointsRef = useRef<Cesium.PointPrimitiveCollection | null>(null);

    // Maritime: BillboardCollection. The old Entity+SampledPositionProperty path
    // did not scale well and was the weakest live renderer left in the scene.
    const maritimeBillboardsRef = useRef<Cesium.BillboardCollection | null>(null);
    const maritimeBillboardMap = useRef<Map<string, Cesium.Billboard>>(new Map());
    const maritimeClusterPointsRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
    const aviClusterIdsRef = useRef<Set<string>>(new Set());
    const maritimeClusterIdsRef = useRef<Set<string>>(new Set());
    const liveRenderModeRef = useRef<'raw' | 'cluster'>('raw');
    const liveClusterGridDegreesRef = useRef<number | null>(null);
    const refreshLivePresentationRef = useRef<(() => void) | null>(null);
    // Dark vessels: separate datasource for AIS-dark flagged vessels
    const darkVesselDsRef = useRef<Cesium.CustomDataSource | null>(null);
    const socketRef = useRef<Socket | null>(null);

    // Last-seen timestamps per entity. Kept in refs (not local consts)
    // so the zustand subscribe below can reset them on re-enable —
    // otherwise frozen records from a prior "off" period would get
    // instantly stale-evicted the moment the source came back on.
    const aviLastSeenRef = useRef<Map<string, number>>(new Map());
    const marLastSeenRef = useRef<Map<string, number>>(new Map());
    // Per-source "source-on moment". staleCleanup uses `max(lastSeen,
    // sourceOnAt)` as the freshness baseline, so an entity whose
    // lastSeen is stale but whose source just came back on is NOT
    // considered stale until STALE_TTL elapses since re-enable. This
    // closes the async-useEffect race Codex flagged: even if the
    // interval tick fires before React commits the freeze-reset effect,
    // the sourceOnAt fallback still protects the frozen snapshot.
    const aviSourceOnAtRef = useRef<number>(0);
    const marSourceOnAtRef = useRef<number>(0);
    // Aviation + maritime source flags are read fresh from the store
    // inside the socket message handler AND the staleCleanup interval
    // (see Effect 1 below), not selected at the hook level. Selecting
    // them here would tear down the socket on every toggle — the
    // MEDIUM 2 property Codex flagged — so we reach into the store
    // directly. Freeze-reset on re-enable is handled by Effect 0's
    // zustand subscribe, which fires synchronously with the flip.

    // ---- Effect 0: atomic freeze reset via zustand.subscribe ----
    //
    // The earlier version did this inside a passive `useEffect` triggered
    // on the `isAviationSourceOn`/`isMaritimeSourceOn` hook selector. That
    // fired AFTER React commit, so a staleCleanup tick that ran in the
    // window between the store update and the React commit could evict
    // frozen records before the reset landed. `useTimelineStore.subscribe`
    // fires synchronously with the store write, so the bump happens in
    // the same microtask — no race window.
    //
    // We additionally write `aviSourceOnAtRef` / `marSourceOnAtRef` so
    // even if the subscribe handler somehow missed a flip (e.g. during
    // a store reset on HMR), the staleCleanup interval uses
    // `max(lastSeen, sourceOnAt)` as a safety net.
    useEffect(() => {
        const unsub = useTimelineStore.subscribe((state, prevState) => {
            const now = Date.now();
            if (state.sources.aviation && !prevState.sources.aviation) {
                aviSourceOnAtRef.current = now;
                aviLastSeenRef.current.forEach((_, id) =>
                    aviLastSeenRef.current.set(id, now)
                );
            }
            if (state.sources.maritime && !prevState.sources.maritime) {
                marSourceOnAtRef.current = now;
                marLastSeenRef.current.forEach((_, id) =>
                    marLastSeenRef.current.set(id, now)
                );
            }
        });
        return unsub;
    }, []);

    // ---- Effect 1: scene + socket lifetime ----
    // Opens the socket once per viewer. Source toggles only gate INSIDE
    // the message handlers (via fresh store reads). That way switching
    // aviation off in the LayerManager doesn't disconnect the socket from
    // maritime, and switching it back on doesn't pay a reconnect penalty.
    useEffect(() => {
        if (!viewer) return;
        let active = true;

        // --- Aviation: BillboardCollection ---
        const aviBillboards = new Cesium.BillboardCollection({
            scene: viewer.scene,
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        viewer.scene.primitives.add(aviBillboards);
        aviBillboardsRef.current = aviBillboards;
        const billboardMap = new Map<string, Cesium.Billboard>();
        aviBillboardMap.current = billboardMap;
        const aviClusterPoints = new Cesium.PointPrimitiveCollection({
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        viewer.scene.primitives.add(aviClusterPoints);
        aviClusterPointsRef.current = aviClusterPoints;

        // --- Maritime: BillboardCollection ---
        const maritimeBillboards = new Cesium.BillboardCollection({
            scene: viewer.scene,
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        viewer.scene.primitives.add(maritimeBillboards);
        maritimeBillboardsRef.current = maritimeBillboards;
        const vesselBillboardMap = new Map<string, Cesium.Billboard>();
        maritimeBillboardMap.current = vesselBillboardMap;
        const maritimeClusterPoints = new Cesium.PointPrimitiveCollection({
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        viewer.scene.primitives.add(maritimeClusterPoints);
        maritimeClusterPointsRef.current = maritimeClusterPoints;

        // --- Dark vessels: AIS-silent vessels flagged by backend ---
        const darkVesselDs = new Cesium.CustomDataSource('dark-vessels');
        viewer.dataSources.add(darkVesselDs);
        darkVesselDsRef.current = darkVesselDs;

        // --- Live trails: dedicated TrailBatcher (AD-3) ---
        // satellite-live shard is intentionally omitted from this iteration:
        // satellite positions are computed client-side in useSatellitesLayer
        // from TLEs and don't flow through this socket handler. Adding a
        // satellite-live shard here without a producer would create dead
        // state. Left for a follow-up that plumbs TLE-derived positions
        // into TrailBatcher from useSatellitesLayer.
        const liveBatcher = new TrailBatcher(viewer, {
            shardKeys: ['aircraft-live', 'vessel-live'],
            maxSamplesPerTrail: 200,
            trailLengthSeconds: 1800,
        });

        // websocket-only: under COEP: credentialless the polling fallback can
        // get stuck silently (handshake succeeds, no events delivered).
        // WebSocket handshake works because backend emits CORP on the
        // upgrade response (see io.engine 'headers' listener in backend).
        const socket = io(API_URL, { transports: ['websocket'] });
        socketRef.current = socket;

        // Surface socket connection state into stream metrics so LayerManager
        // shows "error" instead of stale "streaming" when the backend drops.
        // Every write is gated on the current source flag so a flipped-off
        // source stays on "disabled" instead of being silently overwritten
        // by connect / disconnect / speed-tick handlers.
        socket.on('connect', () => {
            const src = useTimelineStore.getState().sources;
            if (src.aviation) useTimelineStore.getState().setStreamMetric('aviation', { status: 'streaming' });
            if (src.maritime) useTimelineStore.getState().setStreamMetric('maritime', { status: 'streaming' });
        });
        socket.on('disconnect', () => {
            const src = useTimelineStore.getState().sources;
            if (src.aviation) useTimelineStore.getState().setStreamMetric('aviation', { status: 'error' });
            if (src.maritime) useTimelineStore.getState().setStreamMetric('maritime', { status: 'error' });
        });
        socket.on('connect_error', (err) => {
            console.warn('[Socket] connect_error:', err.message);
            const src = useTimelineStore.getState().sources;
            if (src.aviation) useTimelineStore.getState().setStreamMetric('aviation', { status: 'error' });
            if (src.maritime) useTimelineStore.getState().setStreamMetric('maritime', { status: 'error' });
        });

        let aviMsgs = 0;
        let marMsgs = 0;

        const speedInterval = setInterval(() => {
            if (!active) return;
            const src = useTimelineStore.getState().sources;
            if (src.aviation) {
                useTimelineStore.getState().setStreamMetric('aviation', { speed: `${aviMsgs} Kbps` });
            }
            if (src.maritime) {
                useTimelineStore.getState().setStreamMetric('maritime', { speed: `${marMsgs} msgs/s` });
            }
            aviMsgs = 0;
            marMsgs = 0;
        }, 10_000);

        // Track last-seen timestamps for stale cleanup — lifted to
        // component-level refs so the source-flag watcher effect can
        // refresh them on re-enable (see freeze semantics below).
        const aviLastSeen = aviLastSeenRef.current;
        const marLastSeen = marLastSeenRef.current;
        const STALE_TTL = 5 * 60 * 1000; // 5 minutes

        // Periodic stale cleanup (every 30s).
        //
        // Freeze semantics: when a source is OFF, we intentionally skip
        // eviction for its entities so the "frozen snapshot" of last-
        // known positions stays visible. Task 5's contract: toggling a
        // source off stops NEW data from streaming in, but NEVER deletes
        // already-rendered objects.
        //
        // The per-entity freshness floor is `max(lastSeen, sourceOnAt)`
        // where sourceOnAt is the moment the source last flipped from
        // off to on (set synchronously by the zustand subscribe above).
        // This guarantees that even if the subscribe handler's bump and
        // this tick race, an entity that was alive at the moment of
        // re-enable keeps its full STALE_TTL grace period measured from
        // re-enable instead of from its pre-freeze lastSeen.
        const staleCleanup = setInterval(() => {
            if (useTimelineStore.getState().mode === 'playback') return;
            const now = Date.now();
            liveBatcher.tickClock(now / 1000);
            const sources = useTimelineStore.getState().sources;

            // Aviation eviction — only runs when the source is actively
            // streaming fresh updates. If aviation is off, leave the
            // billboards frozen in place.
            if (sources.aviation) {
                const floor = aviSourceOnAtRef.current;
                aviLastSeen.forEach((ts, id) => {
                    const effective = ts > floor ? ts : floor;
                    if (now - effective > STALE_TTL) {
                        const bb = billboardMap.get(id);
                        if (bb) {
                            aviBillboards.remove(bb);
                            billboardMap.delete(id);
                        }
                        aircraftMetaMap.delete(id);
                        aviLastSeen.delete(id);
                        liveBatcher.removeTrail(id, 'aircraft-live');
                    }
                });
            }

            // Maritime eviction — same freeze rule + same floor.
            if (sources.maritime) {
                const floor = marSourceOnAtRef.current;
                marLastSeen.forEach((ts, id) => {
                    const effective = ts > floor ? ts : floor;
                    if (now - effective > STALE_TTL) {
                        const bb = vesselBillboardMap.get(id);
                        if (bb) {
                            maritimeBillboards.remove(bb);
                            vesselBillboardMap.delete(id);
                        }
                        vesselMetaMap.delete(id);
                        marLastSeen.delete(id);
                        liveBatcher.removeTrail(id, 'vessel-live');
                    }
                });
            }
        }, 30_000);

        let processingLiveUpdate = false;
        let queuedLiveUpdate: any | null = null;
        let lastUpdateReceivedAt: string | null = null;
        let lastProcessStartedAt: string | null = null;
        let lastProcessFinishedAt: string | null = null;
        let lastProcessMs = 0;

        // Expose for diagnostic scripts to sample positions of specific
        // billboards across time (e.g. checking whether playback advances).
        (window as any).__openspyAircraftBillboards = billboardMap;
        (window as any).__openspyVesselBillboards = vesselBillboardMap;

        const publishLiveStats = () => {
            window.__openspyLiveStats = {
                aircraftBillboards: billboardMap.size,
                vesselBillboards: vesselBillboardMap.size,
                darkVessels: darkVesselDs.entities.values.length,
                queuedUpdate: Boolean(queuedLiveUpdate),
                processingUpdate: processingLiveUpdate,
                lastUpdateReceivedAt,
                lastProcessStartedAt,
                lastProcessFinishedAt,
                lastProcessMs,
                renderMode: liveRenderModeRef.current,
                gridDegrees: liveClusterGridDegreesRef.current,
                aircraftRenderedMarkers: liveRenderModeRef.current === 'cluster' ? aviClusterPoints.length : billboardMap.size,
                vesselRenderedMarkers: liveRenderModeRef.current === 'cluster' ? maritimeClusterPoints.length : vesselBillboardMap.size,
            };
        };

        const clearLiveClusterMeta = () => {
            aviClusterIdsRef.current.forEach((id) => aircraftMetaMap.delete(id));
            maritimeClusterIdsRef.current.forEach((id) => vesselMetaMap.delete(id));
            aviClusterIdsRef.current.clear();
            maritimeClusterIdsRef.current.clear();
        };

        const recordMatches = (layer: 'aviation' | 'maritime', id: string, subtype: string): boolean => {
            const state = useTimelineStore.getState();
            const subtypeOk = state.subtypeVisibility[`${layer}:${subtype}`] !== false;
            const soloOk = !state.isolatedEntityId || state.isolatedEntityId === id;
            return subtypeOk && soloOk;
        };

        const rebuildAircraftClusters = (gridDegrees: number) => {
            aviClusterIdsRef.current.forEach((id) => aircraftMetaMap.delete(id));
            aviClusterIdsRef.current.clear();
            aviClusterPoints.removeAll();
            const clusters = new Map<string, {
                latSum: number;
                lngSum: number;
                altSum: number;
                speedSum: number;
                count: number;
                type: string;
            }>();
            aircraftMetaMap.forEach((meta, id) => {
                if (meta.aggregated || !isFiniteLatLng(meta.lat, meta.lng)) return;
                if (!recordMatches('aviation', id, meta.type)) return;
                const latCell = liveClusterCoordinate(meta.lat, -90, 90, gridDegrees);
                const lngCell = liveClusterCoordinate(meta.lng, -180, 180, gridDegrees);
                const key = `${lngCell.toFixed(3)}:${latCell.toFixed(3)}`;
                const existing = clusters.get(key);
                if (existing) {
                    existing.latSum += meta.lat;
                    existing.lngSum += meta.lng;
                    existing.altSum += Number(meta.alt) || 0;
                    existing.speedSum += Number(meta.speed) || 0;
                    existing.count += 1;
                    return;
                }
                clusters.set(key, {
                    latSum: meta.lat,
                    lngSum: meta.lng,
                    altSum: Number(meta.alt) || 0,
                    speedSum: Number(meta.speed) || 0,
                    count: 1,
                    type: meta.type,
                });
            });
            clusters.forEach((cluster, key) => {
                const id = `aircraft-cluster-${key.replace(/[^a-z0-9:-]/gi, '_')}`;
                const lat = cluster.latSum / cluster.count;
                const lng = cluster.lngSum / cluster.count;
                const position = safeCartesianFromDegrees(lng, lat, 0);
                if (!position) return;
                aviClusterPoints.add({
                    id,
                    position,
                    color: Cesium.Color.CYAN.withAlpha(0.88),
                    outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
                    outlineWidth: 1,
                    pixelSize: liveClusterPixelSize(cluster.count),
                });
                aircraftMetaMap.set(id, {
                    id,
                    icao24: '',
                    type: cluster.count > 1 ? 'cluster' : cluster.type,
                    speed: cluster.speedSum / cluster.count,
                    heading: 0,
                    lat,
                    lng,
                    alt: cluster.altSum / cluster.count,
                    aggregated: true,
                    count: cluster.count,
                });
                aviClusterIdsRef.current.add(id);
            });
        };

        const rebuildVesselClusters = (gridDegrees: number) => {
            maritimeClusterIdsRef.current.forEach((id) => vesselMetaMap.delete(id));
            maritimeClusterIdsRef.current.clear();
            maritimeClusterPoints.removeAll();
            const clusters = new Map<string, {
                latSum: number;
                lngSum: number;
                speedSum: number;
                count: number;
                type: string;
            }>();
            vesselMetaMap.forEach((meta, id) => {
                if (meta.aggregated || !isFiniteLatLng(meta.lat, meta.lng)) return;
                if (!recordMatches('maritime', id, meta.type)) return;
                const latCell = liveClusterCoordinate(meta.lat, -90, 90, gridDegrees);
                const lngCell = liveClusterCoordinate(meta.lng, -180, 180, gridDegrees);
                const key = `${lngCell.toFixed(3)}:${latCell.toFixed(3)}`;
                const existing = clusters.get(key);
                if (existing) {
                    existing.latSum += meta.lat;
                    existing.lngSum += meta.lng;
                    existing.speedSum += Number(meta.speed) || 0;
                    existing.count += 1;
                    return;
                }
                clusters.set(key, {
                    latSum: meta.lat,
                    lngSum: meta.lng,
                    speedSum: Number(meta.speed) || 0,
                    count: 1,
                    type: meta.type,
                });
            });
            clusters.forEach((cluster, key) => {
                const id = `vessel-cluster-${key.replace(/[^a-z0-9:-]/gi, '_')}`;
                const lat = cluster.latSum / cluster.count;
                const lng = cluster.lngSum / cluster.count;
                const position = safeCartesianFromDegrees(lng, lat, 0);
                if (!position) return;
                maritimeClusterPoints.add({
                    id,
                    position,
                    color: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.88),
                    outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
                    outlineWidth: 1,
                    pixelSize: liveClusterPixelSize(cluster.count),
                });
                vesselMetaMap.set(id, {
                    id,
                    name: `Vessel cluster (${cluster.count})`,
                    type: cluster.count > 1 ? 'cluster' : cluster.type,
                    lat,
                    lng,
                    speed: cluster.speedSum / cluster.count,
                    heading: 0,
                    aggregated: true,
                    count: cluster.count,
                });
                maritimeClusterIdsRef.current.add(id);
            });
        };

        const refreshLivePresentation = () => {
            if (!viewer || viewer.isDestroyed()) return;
            const state = useTimelineStore.getState();
            const liveVisible = state.mode !== 'playback';
            const gridDegrees = state.clusteringEnabled && !state.isolatedEntityId
                ? getLiveClusterGridDegrees(getViewerAltitudeMeters(viewer))
                : null;
            liveRenderModeRef.current = gridDegrees == null ? 'raw' : 'cluster';
            liveClusterGridDegreesRef.current = gridDegrees;
            if (gridDegrees == null) {
                clearLiveClusterMeta();
                aviClusterPoints.removeAll();
                maritimeClusterPoints.removeAll();
                aviBillboards.show = state.sources.aviation && state.visibility.aviation && liveVisible;
                maritimeBillboards.show = state.sources.maritime && state.visibility.maritime && liveVisible;
                aviClusterPoints.show = false;
                maritimeClusterPoints.show = false;
            } else {
                rebuildAircraftClusters(gridDegrees);
                rebuildVesselClusters(gridDegrees);
                aviBillboards.show = false;
                maritimeBillboards.show = false;
                aviClusterPoints.show = state.sources.aviation && state.visibility.aviation && liveVisible;
                maritimeClusterPoints.show = state.sources.maritime && state.visibility.maritime && liveVisible;
            }
            darkVesselDs.show = state.sources.maritime && state.visibility.maritime && liveVisible;
            publishLiveStats();
            viewer.scene.requestRender();
        };
        refreshLivePresentationRef.current = refreshLivePresentation;

        let clusterRefreshTimer: ReturnType<typeof setTimeout> | null = null;
        const onCameraMoveEnd = () => {
            if (clusterRefreshTimer) clearTimeout(clusterRefreshTimer);
            clusterRefreshTimer = setTimeout(() => {
                clusterRefreshTimer = null;
                refreshLivePresentationRef.current?.();
            }, 120);
        };
        const removeMoveEnd = viewer.camera.moveEnd.addEventListener(onCameraMoveEnd);

        const processLiveUpdate = async (data: any) => {
            if (!active) return;
            const processStartedAt = performance.now();
            lastProcessStartedAt = new Date().toISOString();
            publishLiveStats();
            const now = Date.now();
            liveBatcher.tickClock(now / 1000);
            const initialState = useTimelineStore.getState();
            if (initialState.mode === 'playback') return;
            // Sources + subtype filters are re-read from the store on
            // every yield boundary so a mid-chunk source-off flip is
            // seen by the resumed handler.
            let currentSubtypeVisibility = initialState.subtypeVisibility;
            let currentSources = initialState.sources;
            let lastYieldAt = performance.now();
            const refreshState = (): boolean => {
                if (!active) return false;
                const freshState = useTimelineStore.getState();
                if (freshState.mode === 'playback') return false;
                currentSubtypeVisibility = freshState.subtypeVisibility;
                currentSources = freshState.sources;
                return true;
            };
            let lastLivePhase: 'aviation' | 'maritime' | 'dark-vessels' | null = null;
            let lastLiveIndex = 0;
            const publishLiveProgress = (phase: typeof lastLivePhase, index: number) => {
                lastLivePhase = phase;
                lastLiveIndex = index;
                lastProcessMs = performance.now() - processStartedAt;
                publishLiveStats();
                (window as any).__openspyLiveApplyProgress = {
                    phase: lastLivePhase,
                    index: lastLiveIndex,
                    lastProcessMs,
                    aircraftBillboards: billboardMap.size,
                    vesselBillboards: vesselBillboardMap.size,
                };
            };
            const yieldIfNeeded = async (index: number): Promise<boolean> => {
                if (index % LIVE_APPLY_YIELD_EVERY !== 0) return refreshState();
                const nowMs = performance.now();
                if (nowMs - lastYieldAt < LIVE_APPLY_BUDGET_MS) return refreshState();
                publishLiveProgress(lastLivePhase, index);
                await yieldToBrowser();
                lastYieldAt = performance.now();
                return refreshState();
            };

            // ---- Aviation via BillboardCollection ----
            if (data.aircrafts && currentSources.aviation) {
                // Approximate payload size in KB without stringifying the
                // whole array on every socket message. An OpenSky aircraft
                // record serialises to ~200 bytes (icao24, callsign, origin,
                // lat/lng/alt/heading/type/speed). data.aircrafts.length * 0.2
                // is close enough for a ticker display and costs O(1).
                aviMsgs += Math.round(data.aircrafts.length * 0.2);

                const aircrafts = data.aircrafts as any[];
                for (let ai = 0; ai < aircrafts.length; ai++) {
                    lastLivePhase = 'aviation';
                    lastLiveIndex = ai;
                    if (!(await yieldIfNeeded(ai))) return;
                    if (!currentSources.aviation) break;
                    const ac = aircrafts[ai];
                    const pos = Cesium.Cartesian3.fromDegrees(ac.lng, ac.lat, ac.alt * 0.3048);
                    const rotation = Cesium.Math.toRadians(-(ac.heading || 0));

                    aviLastSeen.set(ac.id, now);

                    let bb = billboardMap.get(ac.id);
                    if (!bb) {
                        const show = currentSubtypeVisibility[`aviation:${ac.type}`] !== false;
                        bb = aviBillboards.add({
                            position: pos,
                            image: getAviSVG(ac.type),
                            scale: 0.7,
                            rotation,
                            id: ac.id,
                            show,
                        });
                        billboardMap.set(ac.id, bb);
                    } else {
                        bb.position = pos;
                        bb.rotation = rotation;
                    }

                    // Append live trail sample (aircraft altitude in feet → meters).
                    // Gated on `showTrajectories` — at 7K aircraft + 22K vessels
                    // per broadcast the PolylineCollection-backed MVP TrailBatcher
                    // drops ~20% FPS without this guard. Custom-Primitive follow-up
                    // will lift the cap.
                    if (useTimelineStore.getState().showTrajectories
                        && Number.isFinite(ac.lng) && Number.isFinite(ac.lat)) {
                        liveBatcher.upsertTrail('aircraft-live', ac.id, [[
                            ac.lng,
                            ac.lat,
                            Number.isFinite(ac.alt) ? ac.alt * 0.3048 : null,
                            Math.floor(now / 1000),
                        ]]);
                    }

                    aircraftMetaMap.set(ac.id, {
                        id: ac.id,
                        icao24: ac.icao24 || '',
                        type: ac.type,
                        speed: ac.speed,
                        heading: ac.heading,
                        lat: ac.lat,
                        lng: ac.lng,
                        alt: ac.alt,
                    });
                }
            }

            if (!refreshState()) return;

            // Server-computed counts → store (no client forEach).
            // Gate each write on the CURRENT source flag so a flipped-off
            // aviation/maritime row doesn't get repopulated by the next
            // live-update that happens to be in flight.
            if (data.meta) {
                if (currentSources.aviation) {
                    useTimelineStore.getState().setStreamMetric('aviation', {
                        count: data.meta.aviationTotal,
                        status: 'streaming'
                    });
                    useTimelineStore.getState().setSubtypeCounts('aviation', data.meta.aviationCounts || {});
                }
                if (currentSources.maritime) {
                    useTimelineStore.getState().setSubtypeCounts('maritime', data.meta.maritimeCounts || {});
                }
            }

            // ---- Maritime via Entity API ----
            // Chunked the same way as aviation. The retained vessel set
            // can grow to ~2000, so a full sync pass here also hitches
            // the main thread on each live-update.
            if (!currentSources.maritime) return; // Maritime source disabled — drop vessels + dark vessels
            marMsgs += data.vessels.length;

            const vessels: any[] = data.vessels;
            for (let vi = 0; vi < vessels.length; vi++) {
                lastLivePhase = 'maritime';
                lastLiveIndex = vi;
                if (!(await yieldIfNeeded(vi))) return;
                if (!currentSources.maritime) break;
                const v = vessels[vi];
                marLastSeen.set(v.id, now);
                const pos = Cesium.Cartesian3.fromDegrees(v.lng, v.lat, 0);
                const rotation = Cesium.Math.toRadians(-(v.heading || 0));
                const showVessel = currentSubtypeVisibility[`maritime:${v.type}`] !== false;
                let bb = vesselBillboardMap.get(v.id);
                if (!bb) {
                    bb = maritimeBillboards.add({
                        position: pos,
                        image: getShipSVG(v.type),
                        scale: 0.7,
                        rotation,
                        alignedAxis: Cesium.Cartesian3.UNIT_Z,
                        id: v.id,
                        show: showVessel,
                    });
                    vesselBillboardMap.set(v.id, bb);
                } else {
                    bb.position = pos;
                    bb.rotation = rotation;
                    const prevMeta = vesselMetaMap.get(v.id);
                    if (v.type !== 'unknown' && prevMeta?.type !== v.type) {
                        bb.image = getShipSVG(v.type);
                    }
                    bb.show = showVessel;
                }

                if (useTimelineStore.getState().showTrajectories
                    && Number.isFinite(v.lng) && Number.isFinite(v.lat)) {
                    liveBatcher.upsertTrail('vessel-live', v.id, [[
                        v.lng,
                        v.lat,
                        null,
                        Math.floor(now / 1000),
                    ]]);
                }

                vesselMetaMap.set(v.id, {
                    id: v.id,
                    name: v.name || null,
                    type: v.type || 'unknown',
                    lat: v.lat,
                    lng: v.lng,
                    speed: v.speed || 0,
                    heading: v.heading || 0,
                    cog: v.cog ?? null,
                });
            }

            if (data.meta && currentSources.maritime) {
                const darkCount = data.meta.darkVesselCount || 0;
                useTimelineStore.getState().setStreamMetric('maritime', {
                    count: data.meta.maritimeTotal + darkCount,
                    status: data.meta.maritimeTotal > 0 ? 'streaming' : 'connecting'
                });
            }

            // ---- Dark vessels via Entity API ----
            if (data.darkVessels && Array.isArray(data.darkVessels)) {
                // Track which dark vessels are in the current payload
                const currentDarkIds = new Set<string>();
                for (const dv of data.darkVessels) {
                    const darkId = `dark-${dv.id}`;
                    currentDarkIds.add(darkId);

                    let entity = darkVesselDs.entities.getById(darkId);
                    if (!entity) {
                        if (dv.lat == null || dv.lng == null || isNaN(dv.lat) || isNaN(dv.lng)) continue;
                        const position = safeCartesianFromDegrees(dv.lng, dv.lat, 0);
                        if (!position) continue;
                        const darkSinceDate = new Date(dv.darkSince);
                        const darkMinutes = Math.round((Date.now() - dv.darkSince) / 60000);
                        darkVesselDs.entities.add({
                            id: darkId,
                            name: `AIS Lost: ${dv.id} (${darkMinutes}m silent)`,
                            position,
                            properties: new Cesium.PropertyBag({
                                layer: 'AIS Signal Lost',
                                subtype: dv.type || 'unknown',
                                speed: dv.speed,
                                heading: dv.heading || 0,
                                lastSeen: new Date(dv.lastSeen).toISOString(),
                                darkSince: darkSinceDate.toISOString(),
                            }),
                            billboard: {
                                image: DARK_VESSEL_ICON,
                                scale: 1.1,
                            },
                            // Red pulsing ellipse around last known position
                            ellipse: {
                                semiMinorAxis: 50_000,
                                semiMajorAxis: 50_000,
                                material: new Cesium.ColorMaterialProperty(Cesium.Color.RED.withAlpha(0.08)),
                                height: 0,
                                outline: true,
                                outlineColor: Cesium.Color.RED.withAlpha(0.3),
                                outlineWidth: 1,
                            },
                        });
                    } else {
                        // Update name with current dark duration
                        const darkMinutes = Math.round((Date.now() - dv.darkSince) / 60000);
                        entity.name = `AIS Lost: ${dv.id} (${darkMinutes}m silent)`;
                    }
                }

                // Remove entities that are no longer dark (vessel reappeared)
                const toRemove: string[] = [];
                darkVesselDs.entities.values.forEach(e => {
                    if (!currentDarkIds.has(e.id)) toRemove.push(e.id);
                });
                for (const id of toRemove) darkVesselDs.entities.removeById(id);
            }

            lastProcessMs = performance.now() - processStartedAt;
            lastProcessFinishedAt = new Date().toISOString();
            refreshLivePresentationRef.current?.();
            publishLiveStats();
        };

        const drainLiveUpdates = async () => {
            if (processingLiveUpdate) return;
            processingLiveUpdate = true;
            publishLiveStats();
            try {
                while (active && queuedLiveUpdate) {
                    const next = queuedLiveUpdate;
                    queuedLiveUpdate = null;
                    publishLiveStats();
                    const t0 = performance.now();
                    await processLiveUpdate(next);
                    const took = performance.now() - t0;
                    if (took > 30) {
                        perfLog('live.update_applied', { ms: Math.round(took), aircrafts: next.aircrafts?.length ?? 0, vessels: next.vessels?.length ?? 0 });
                    }
                }
            } finally {
                processingLiveUpdate = false;
                publishLiveStats();
            }
        };

        socket.on('live-update', (data: any) => {
            if (!active) return;
            lastUpdateReceivedAt = new Date().toISOString();
            queuedLiveUpdate = data;
            publishLiveStats();
            void drainLiveUpdates();
        });

        // Bootstrap snapshot via REST: socket can't reliably carry the full
        // 5–10 MB initial payload (browser drops frames over ~1 MB or under
        // burst). Periodic incremental updates still come via socket.
        //
        // Codex round-11 fix (2026-04-21): on page load in playback mode,
        // the `/api/live/snapshot` fetch overlaps the replay cold seek and
        // its `await res.json()` (with a multi-MB graph of aircraft+vessel
        // entities) blocks the main thread for 1.3–6 s — exactly the window
        // in which replay's `setTimeout(300)` budget got starved and the
        // 73 MB bundle POST competed with snapshot delivery on the same
        // single-threaded Node server. Skip the bootstrap entirely while
        // in playback and wire an abort signal so an in-flight snapshot
        // can be cancelled when the user seeks into replay mid-load.
        const snapshotAbort = new AbortController();
        const currentMode = useTimelineStore.getState().mode;
        // Codex round-11: debug flag to validate the live-snapshot-blocks-replay
        // hypothesis by short-circuiting the snapshot entirely.
        const OPENSPY_DISABLE_LIVE_BOOTSTRAP = typeof window !== 'undefined'
            && (window as any).__OPENSPY_DISABLE_LIVE_BOOTSTRAP === true;
        const shouldSkipBootstrap = currentMode === 'playback' || OPENSPY_DISABLE_LIVE_BOOTSTRAP;
        const unsubscribeModeAbort = useTimelineStore.subscribe((state, prev) => {
            if (state.mode === 'playback' && prev.mode !== 'playback') {
                snapshotAbort.abort();
                // Hide live-mode trail shards during historical playback so
                // only the replay TrailBatcher paints its own shard.
                liveBatcher.setShardVisible('aircraft-live', false);
                liveBatcher.setShardVisible('vessel-live', false);
            } else if (state.mode !== 'playback' && prev.mode === 'playback') {
                liveBatcher.setShardVisible('aircraft-live', true);
                liveBatcher.setShardVisible('vessel-live', true);
            }
        });
        if (shouldSkipBootstrap) {
            perfLog('live.snapshot_skipped', { reason: 'playback-at-mount' });
        } else {
            void (async () => {
                const t0 = performance.now();
                try {
                    const res = await fetch(`${API_URL}/api/live/snapshot`, { signal: snapshotAbort.signal });
                    if (!res.ok) throw new Error(`snapshot ${res.status}`);
                    const data = await res.json();
                    const tFetch = performance.now() - t0;
                    perfLog('live.snapshot_fetched', { ms: Math.round(tFetch), aircrafts: data.aircrafts?.length || 0, vessels: data.vessels?.length || 0 });
                    if (!active) return;
                    if (useTimelineStore.getState().mode === 'playback') {
                        perfLog('live.snapshot_discarded', { reason: 'playback-after-fetch' });
                        return;
                    }
                    lastUpdateReceivedAt = new Date().toISOString();
                    queuedLiveUpdate = data;
                    publishLiveStats();
                    void drainLiveUpdates();
                } catch (err: any) {
                    if (err?.name === 'AbortError') {
                        perfLog('live.snapshot_aborted', { ms: Math.round(performance.now() - t0) });
                        return;
                    }
                    console.error('[Live] bootstrap snapshot fetch failed:', err);
                }
            })();
        }

        return () => {
            active = false;
            snapshotAbort.abort();
            unsubscribeModeAbort();
            if (clusterRefreshTimer) clearTimeout(clusterRefreshTimer);
            removeMoveEnd();
            clearInterval(speedInterval);
            clearInterval(staleCleanup);
            socket.disconnect();
            socketRef.current = null;
            clearLiveClusterMeta();
            aircraftMetaMap.clear();
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(aviBillboards);
                viewer.scene.primitives.remove(aviClusterPoints);
                viewer.scene.primitives.remove(maritimeBillboards);
                viewer.scene.primitives.remove(maritimeClusterPoints);
                viewer.dataSources.remove(darkVesselDs);
            }
            liveBatcher.dispose();
            aviBillboardsRef.current = null;
            aviClusterPointsRef.current = null;
            maritimeBillboardsRef.current = null;
            maritimeClusterPointsRef.current = null;
            maritimeBillboardMap.current.clear();
            vesselMetaMap.clear();
            darkVesselDsRef.current = null;
            refreshLivePresentationRef.current = null;
            delete window.__openspyLiveStats;
        };
    }, [viewer]);

    // ---- Effect 2: visibility toggles ----
    // Historical replay uses a separate overlay, so canonical live layers
    // must be fully hidden in playback to avoid rendering live + history
    // on top of each other.
    const aviSourceOnSel = useTimelineStore(s => s.sources.aviation);
    const marSourceOnSel = useTimelineStore(s => s.sources.maritime);
    const clusteringEnabled = useTimelineStore(s => s.clusteringEnabled);
    useEffect(() => {
        refreshLivePresentationRef.current?.();
    }, [aviSourceOnSel, marSourceOnSel, isAviationVisible, isMaritimeVisible, mode, clusteringEnabled]);

    // ---- Effect 0a: source-off scene clear ----
    // When the user turns aviation / maritime OFF, drop the existing
    // billboards / entities so that re-enabling starts from an empty
    // scene and the next live-update repopulates with fresh data.
    // This matches the user's mental model: source off = no data on
    // screen; source on = current data rendered.
    useEffect(() => {
        if (!aviSourceOnSel) {
            const bbs = aviBillboardsRef.current;
            if (bbs) bbs.removeAll();
            if (aviClusterPointsRef.current) aviClusterPointsRef.current.removeAll();
            aviBillboardMap.current.clear();
            aviClusterIdsRef.current.forEach((id) => aircraftMetaMap.delete(id));
            aviClusterIdsRef.current.clear();
            aviLastSeenRef.current.clear();
            aircraftMetaMap.clear();
            useTimelineStore.getState().setSubtypeCounts('aviation', {});
            useTimelineStore.getState().setStreamMetric('aviation', {
                count: 0,
                status: 'disabled',
                speed: '-',
            });
            requestSceneRender();
        }
    }, [aviSourceOnSel]);
    useEffect(() => {
        if (!marSourceOnSel) {
            const dvs = darkVesselDsRef.current;
            const bbs = maritimeBillboardsRef.current;
            if (bbs) bbs.removeAll();
            if (maritimeClusterPointsRef.current) maritimeClusterPointsRef.current.removeAll();
            if (dvs) dvs.entities.removeAll();
            maritimeBillboardMap.current.clear();
            maritimeClusterIdsRef.current.forEach((id) => vesselMetaMap.delete(id));
            maritimeClusterIdsRef.current.clear();
            vesselMetaMap.clear();
            marLastSeenRef.current.clear();
            useTimelineStore.getState().setSubtypeCounts('maritime', {});
            useTimelineStore.getState().setStreamMetric('maritime', {
                count: 0,
                status: 'disabled',
                speed: '-',
            });
            requestSceneRender();
        }
    }, [marSourceOnSel]);

    // ---- Effect 3: vessel trails toggle ----
    // Live maritime now uses billboard batching instead of Entity.path, so
    // this becomes a no-op. Historical/replay movement remains supported via
    // the replay overlay. We keep the effect boundary to preserve the public
    // store contract while removing the hot Entity path visualizer cost.
    useEffect(() => {
        void showTrajectories;
        requestSceneRender();
    }, [showTrajectories]);

    // ---- Effect 4: per-subtype visibility + entity isolation (aviation + maritime + dark) ----
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    useEffect(() => {
        // Aviation subtype filtering + Solo isolation
        aviBillboardMap.current.forEach((bb, id) => {
            const meta = aircraftMetaMap.get(id);
            if (!meta) return;
            const subtypeOk = subtypeVisibility[`aviation:${meta.type}`] !== false;
            const soloOk = !isolatedEntityId || isolatedEntityId === id;
            bb.show = subtypeOk && soloOk;
        });

        // Maritime subtype filtering + Solo isolation
        maritimeBillboardMap.current.forEach((bb, id) => {
            const meta = vesselMetaMap.get(id);
            if (!meta) return;
            const subtypeOk = subtypeVisibility[`maritime:${meta.type}`] !== false;
            const soloOk = !isolatedEntityId || isolatedEntityId === id;
            bb.show = subtypeOk && soloOk;
        });

        // Dark vessel filtering (follows maritime visibility)
        if (darkVesselDsRef.current) {
            darkVesselDsRef.current.entities.values.forEach(e => {
                const soloOk = !isolatedEntityId || isolatedEntityId === e.id;
                e.show = soloOk;
            });
        }
        refreshLivePresentationRef.current?.();
    }, [subtypeVisibility, isolatedEntityId]);
}
