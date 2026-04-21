import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { io, Socket } from 'socket.io-client';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { perfLog } from '../lib/perf-log';
import { getAviIcon, getShipIcon, DARK_VESSEL_ICON } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';

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
        };
    }
}

const getAviSVG = getAviIcon;

const getShipSVG = getShipIcon;

// Metadata stored per aircraft for picking and EntityHUD.
interface AircraftMeta {
    id: string;         // equals icao24 (primary key)
    icao24: string;
    callsign: string;   // display name, can be empty or repeated across airframes
    origin: string;
    type: string;
    speed: number;
    heading: number;
    lat: number;
    lng: number;
    alt: number;
    // New fields from OpenSky state vector
    squawk: string | null;
    verticalRate: number | null;  // m/s
    onGround: boolean;
    lastContact: number | null;   // unix timestamp
}

// Global registry so Globe.tsx picking can look up aircraft metadata by billboard.
// Key = billboard reference (set as billboard.id), value = metadata.
export const aircraftMetaMap = new Map<string, AircraftMeta>();

interface VesselMeta {
    id: string;
    name: string;
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
}

export const vesselMetaMap = new Map<string, VesselMeta>();

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

    // Maritime: BillboardCollection. The old Entity+SampledPositionProperty path
    // did not scale well and was the weakest live renderer left in the scene.
    const maritimeBillboardsRef = useRef<Cesium.BillboardCollection | null>(null);
    const maritimeBillboardMap = useRef<Map<string, Cesium.Billboard>>(new Map());
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

        // --- Maritime: BillboardCollection ---
        const maritimeBillboards = new Cesium.BillboardCollection({
            scene: viewer.scene,
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        viewer.scene.primitives.add(maritimeBillboards);
        maritimeBillboardsRef.current = maritimeBillboards;
        const vesselBillboardMap = new Map<string, Cesium.Billboard>();
        maritimeBillboardMap.current = vesselBillboardMap;

        // --- Dark vessels: AIS-silent vessels flagged by backend ---
        const darkVesselDs = new Cesium.CustomDataSource('dark-vessels');
        viewer.dataSources.add(darkVesselDs);
        darkVesselDsRef.current = darkVesselDs;

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
            };
        };

        const processLiveUpdate = async (data: any) => {
            if (!active) return;
            const processStartedAt = performance.now();
            lastProcessStartedAt = new Date().toISOString();
            publishLiveStats();
            const now = Date.now();
            const initialState = useTimelineStore.getState();
            if (initialState.mode === 'playback') return;
            // Sources + subtype filters are re-read from the store on
            // every yield boundary so a mid-chunk source-off flip is
            // seen by the resumed handler.
            let currentSubtypeVisibility = initialState.subtypeVisibility;
            let currentSources = initialState.sources;
            const refreshState = (): boolean => {
                if (!active) return false;
                const freshState = useTimelineStore.getState();
                if (freshState.mode === 'playback') return false;
                currentSubtypeVisibility = freshState.subtypeVisibility;
                currentSources = freshState.sources;
                return true;
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

                    aircraftMetaMap.set(ac.id, {
                        id: ac.id,
                        icao24: ac.icao24 || '',
                        callsign: ac.callsign || ac.icao24 || '',
                        origin: ac.origin || '',
                        type: ac.type,
                        speed: ac.speed,
                        heading: ac.heading,
                        lat: ac.lat,
                        lng: ac.lng,
                        alt: ac.alt,
                        squawk: ac.squawk || null,
                        verticalRate: ac.verticalRate ?? null,
                        onGround: ac.onGround === true,
                        lastContact: ac.lastContact || null,
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
                    if (v.type !== 'unknown') {
                        bb.image = getShipSVG(v.type);
                    }
                    bb.show = showVessel;
                }

                vesselMetaMap.set(v.id, {
                    id: v.id,
                    name: v.name || `Ship ${v.id}`,
                    type: v.type || 'unknown',
                    lat: v.lat,
                    lng: v.lng,
                    speed: v.speed || 0,
                    heading: v.heading || 0,
                    callSign: v.callSign || null,
                    imo: v.imo || null,
                    navigationStatus: v.navigationStatus || null,
                    destination: v.destination || null,
                    eta: v.eta || null,
                    rateOfTurn: v.rateOfTurn ?? null,
                    draught: v.draught ?? null,
                    vesselLength: v.length ?? null,
                    beam: v.beam ?? null,
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

            requestSceneRender();
            lastProcessMs = performance.now() - processStartedAt;
            lastProcessFinishedAt = new Date().toISOString();
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
            clearInterval(speedInterval);
            clearInterval(staleCleanup);
            socket.disconnect();
            socketRef.current = null;
            aircraftMetaMap.clear();
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(aviBillboards);
                viewer.scene.primitives.remove(maritimeBillboards);
                viewer.dataSources.remove(darkVesselDs);
            }
            aviBillboardsRef.current = null;
            maritimeBillboardsRef.current = null;
            maritimeBillboardMap.current.clear();
            vesselMetaMap.clear();
            darkVesselDsRef.current = null;
            delete window.__openspyLiveStats;
        };
    }, [viewer]);

    // ---- Effect 2: visibility toggles ----
    // Historical replay uses a separate overlay, so canonical live layers
    // must be fully hidden in playback to avoid rendering live + history
    // on top of each other.
    const aviSourceOnSel = useTimelineStore(s => s.sources.aviation);
    const marSourceOnSel = useTimelineStore(s => s.sources.maritime);
    useEffect(() => {
        const liveVisible = mode !== 'playback';
        if (aviBillboardsRef.current) aviBillboardsRef.current.show = aviSourceOnSel && isAviationVisible && liveVisible;
        if (maritimeBillboardsRef.current) maritimeBillboardsRef.current.show = marSourceOnSel && isMaritimeVisible && liveVisible;
        if (darkVesselDsRef.current) darkVesselDsRef.current.show = marSourceOnSel && isMaritimeVisible && liveVisible;
        requestSceneRender();
    }, [aviSourceOnSel, marSourceOnSel, isAviationVisible, isMaritimeVisible, mode]);

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
            aviBillboardMap.current.clear();
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
            if (dvs) dvs.entities.removeAll();
            maritimeBillboardMap.current.clear();
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
        requestSceneRender();
    }, [subtypeVisibility, isolatedEntityId]);
}
