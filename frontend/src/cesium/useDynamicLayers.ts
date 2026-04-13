import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { io, Socket } from 'socket.io-client';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { getAviIcon, getShipIcon, DARK_VESSEL_ICON } from '../icons/map-icons';

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

// Shared "far past" Julian date used as the start of the sample-prune
// TimeInterval below. Year 1900 is well before any realistic AIS data so
// it reliably covers every historical sample in a vessel's
// SampledPositionProperty. Built once and reused to avoid allocating a
// new JulianDate on every vessel update.
const PRUNE_INTERVAL_START = Cesium.JulianDate.fromIso8601('1900-01-01T00:00:00Z');

export function useDynamicLayers(viewer: Cesium.Viewer | null) {
    // Visibility + subtype filters are reactive because they only touch
    // already-rendered entities. Source flags are NOT in any deps —
    // handlers read them fresh per message, so toggling a source does not
    // tear down the socket (MEDIUM 2 fix).
    const isAviationVisible = useTimelineStore(s => s.visibility.aviation);
    const isMaritimeVisible = useTimelineStore(s => s.visibility.maritime);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const mode = useTimelineStore(s => s.mode);
    const currentTime = useTimelineStore(s => s.currentTime);
    const showTrajectories = useTimelineStore(s => s.showTrajectories);

    // Aviation: BillboardCollection (GPU-batched, 1 draw call for 11K billboards)
    const aviBillboardsRef = useRef<Cesium.BillboardCollection | null>(null);
    const aviBillboardMap = useRef<Map<string, Cesium.Billboard>>(new Map());

    // Maritime: still Entity API (only ~300-500 vessels, perf is fine)
    const maritimeDsRef = useRef<Cesium.CustomDataSource | null>(null);
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
        const aviBillboards = new Cesium.BillboardCollection({ scene: viewer.scene });
        viewer.scene.primitives.add(aviBillboards);
        aviBillboardsRef.current = aviBillboards;
        const billboardMap = new Map<string, Cesium.Billboard>();
        aviBillboardMap.current = billboardMap;

        // --- Maritime: Entity API (small count, clustering useful) ---
        const maritimeDs = new Cesium.CustomDataSource('maritime');
        viewer.dataSources.add(maritimeDs);
        maritimeDsRef.current = maritimeDs;

        // --- Dark vessels: AIS-silent vessels flagged by backend ---
        const darkVesselDs = new Cesium.CustomDataSource('dark-vessels');
        viewer.dataSources.add(darkVesselDs);
        darkVesselDsRef.current = darkVesselDs;

        const socket = io(API_URL);
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
                        maritimeDs.entities.removeById(id);
                        marLastSeen.delete(id);
                    }
                });
            }
        }, 30_000);

        // How many aircraft / vessels to process synchronously before
        // yielding to the browser. Each simulator-update message carries
        // the full ~11k aircraft world snapshot; processing that in a
        // single sync loop is a 100-300ms main-thread spike that makes
        // the globe feel laggy on every tick. Chunked with yields keeps
        // pointer events responsive even during a fresh world update.
        const AVI_CHUNK_SIZE = 1500;

        // Message sequence counter. Bumped on every simulator-update
        // arrival; each async handler captures `mySeq` at start and
        // bails after any yield if a newer message has come in. This
        // prevents stale resumed handlers from writing positions older
        // than the latest snapshot when socket.io delivers two updates
        // before the first one's chunked loop drains.
        let messageSeq = 0;

        socket.on('simulator-update', async (data: any) => {
            if (!active) return;
            const mySeq = ++messageSeq;
            const now = Date.now();
            // Sources + subtype filters are re-read from the store on
            // every yield boundary so a mid-chunk source-off flip is
            // seen by the resumed handler (instead of overwriting the
            // source-off-clear effect with stale positions from the
            // in-flight payload).
            let currentSubtypeVisibility = useTimelineStore.getState().subtypeVisibility;
            let currentSources = useTimelineStore.getState().sources;
            const refreshStateIfFresh = (): boolean => {
                if (!active || mySeq !== messageSeq) return false;
                currentSubtypeVisibility = useTimelineStore.getState().subtypeVisibility;
                currentSources = useTimelineStore.getState().sources;
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
                        // Apply subtype visibility filter to new billboards so
                        // late-arriving aircraft respect the current LayerManager toggles.
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

                    // Yield every AVI_CHUNK_SIZE aircraft so input events
                    // (drag / zoom / click) get a chance between chunks.
                    if ((ai + 1) % AVI_CHUNK_SIZE === 0 && ai + 1 < aircrafts.length) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        if (!refreshStateIfFresh()) return;
                        // Source may have flipped off during the yield.
                        if (!currentSources.aviation) break;
                    }
                }
            }

            if (!refreshStateIfFresh()) return;

            // Server-computed counts → store (no client forEach).
            // Gate each write on the CURRENT source flag so a flipped-off
            // aviation/maritime row doesn't get repopulated by the next
            // simulator-update that happens to be in flight.
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
            // the main thread on each simulator-update.
            if (!currentSources.maritime) return; // Maritime source disabled — drop vessels + dark vessels
            marMsgs += data.vessels.length;

            const MARITIME_CHUNK_SIZE = 500;
            const vessels: any[] = data.vessels;
            for (let vi = 0; vi < vessels.length; vi++) {
                const v = vessels[vi];
                marLastSeen.set(v.id, now);
                let entity = maritimeDs.entities.getById(v.id);
                const pos = Cesium.Cartesian3.fromDegrees(v.lng, v.lat, 0);
                const rotation = Cesium.Math.toRadians(-(v.heading || 0));

                if (!entity) {
                    const positionProperty = new Cesium.SampledPositionProperty();
                    positionProperty.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
                    positionProperty.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
                    // Apply subtype visibility filter to new vessels so
                    // late-arriving ships respect the current LayerManager toggles.
                    const showVessel = currentSubtypeVisibility[`maritime:${v.type}`] !== false;
                    // Respect the trajectories toggle at creation time — without
                    // this, freshly spawned vessels would flash in their wake
                    // even when the user had hidden trails globally.
                    const initialShowTrails = useTimelineStore.getState().showTrajectories;
                    entity = maritimeDs.entities.add({
                        id: v.id,
                        name: v.name || `Ship ${v.id}`,
                        position: positionProperty as any,
                        show: showVessel,
                        properties: new Cesium.PropertyBag({
                            layer: 'Vessel',
                            subtype: v.type,
                            speed: v.speed,
                            heading: v.heading || 0,
                            // New AIS fields
                            vesselName: v.name || null,
                            callSign: v.callSign || null,
                            imo: v.imo || null,
                            navigationStatus: v.navigationStatus || null,
                            destination: v.destination || null,
                            eta: v.eta || null,
                            rateOfTurn: v.rateOfTurn ?? null,
                            draught: v.draught || null,
                            vesselLength: v.length || null,
                            beam: v.beam || null,
                            cog: v.cog ?? null,
                        }),
                        billboard: {
                            image: getShipSVG(v.type),
                            scale: 0.7,
                            rotation,
                            alignedAxis: Cesium.Cartesian3.UNIT_Z,
                        },
                        // Vessel wake — last 30 min of accumulated positions.
                        // Plain ColorMaterialProperty instead of PolylineGlow
                        // which uses a heavy custom shader; on 500+ vessels
                        // glow was a material perf kit for a small visual win.
                        path: {
                            leadTime: 0,
                            trailTime: 1800,
                            width: 1.5,
                            material: new Cesium.ColorMaterialProperty(
                                Cesium.Color.CYAN.withAlpha(0.4)
                            ),
                            show: new Cesium.ConstantProperty(initialShowTrails),
                        },
                    });
                } else {
                    // Mutate existing ConstantProperty values in place via
                    // `setValue()` rather than allocating a new property
                    // on every socket tick. With 500-2000 vessels this
                    // dropped GC pressure noticeably — each vessel update
                    // used to churn 3-5 fresh property objects per message,
                    // and the simulator fires every few seconds.
                    if (entity.billboard?.rotation instanceof Cesium.ConstantProperty) {
                        entity.billboard.rotation.setValue(rotation);
                    } else if (entity.billboard) {
                        entity.billboard.rotation = new Cesium.ConstantProperty(rotation);
                    }
                    // Update type if known
                    if (entity.properties && v.type !== 'unknown') {
                        const subProp = (entity.properties as any).subtype;
                        if (subProp instanceof Cesium.ConstantProperty) {
                            subProp.setValue(v.type);
                        } else {
                            (entity.properties as any).subtype = new Cesium.ConstantProperty(v.type);
                        }
                        if (entity.billboard?.image instanceof Cesium.ConstantProperty) {
                            entity.billboard.image.setValue(getShipSVG(v.type));
                        } else if (entity.billboard) {
                            entity.billboard.image = new Cesium.ConstantProperty(getShipSVG(v.type));
                        }
                    }
                    // Update speed/heading properties for EntityHUD
                    if (entity.properties) {
                        const speedProp = (entity.properties as any).speed;
                        if (speedProp instanceof Cesium.ConstantProperty) {
                            speedProp.setValue(v.speed || 0);
                        } else {
                            (entity.properties as any).speed = new Cesium.ConstantProperty(v.speed || 0);
                        }
                        const headingProp = (entity.properties as any).heading;
                        if (headingProp instanceof Cesium.ConstantProperty) {
                            headingProp.setValue(v.heading || 0);
                        } else {
                            (entity.properties as any).heading = new Cesium.ConstantProperty(v.heading || 0);
                        }
                        // Update AIS enriched fields from backend
                        const aisFields: Record<string, any> = {
                            vesselName: v.name || null,
                            callSign: v.callSign || null,
                            imo: v.imo || null,
                            navigationStatus: v.navigationStatus || null,
                            destination: v.destination || null,
                            eta: v.eta || null,
                            rateOfTurn: v.rateOfTurn ?? null,
                            draught: v.draught || null,
                            vesselLength: v.length || null,
                            beam: v.beam || null,
                            cog: v.cog ?? null,
                        };
                        for (const [key, val] of Object.entries(aisFields)) {
                            const prop = (entity.properties as any)[key];
                            if (prop instanceof Cesium.ConstantProperty) {
                                prop.setValue(val);
                            } else {
                                (entity.properties as any)[key] = new Cesium.ConstantProperty(val);
                            }
                        }
                    }
                    // Update entity name
                    if (v.name) entity.name = v.name;
                }

                const positionProperty = entity.position as Cesium.SampledPositionProperty;
                const prev = positionProperty.getValue(viewer.clock.currentTime);
                if (!prev || !Cesium.Cartesian3.equalsEpsilon(prev, pos, 0, 1.0)) {
                    positionProperty.addSample(viewer.clock.currentTime, pos);
                }
                // Prune samples older than the visible wake window
                // (trailTime + a small grace) on EVERY update, not just
                // position-change ticks. Without this, a long session
                // accumulates samples forever — addSample is append-only,
                // `trailTime` only bounds what's drawn, not what's
                // stored, so path visualiser cost grows linearly with
                // session duration even though the visible trail stays
                // the same length.
                //
                // The prune must run outside the position-change branch
                // because stationary/moored vessels stop calling
                // addSample but still hold whatever history they
                // accumulated before they stopped. Running it every
                // update amortises the cleanup across the whole fleet
                // on each simulator tick.
                const trailWindowSec = 1800; // matches path.trailTime
                const graceSec = 60;
                const cutoff = Cesium.JulianDate.addSeconds(
                    viewer.clock.currentTime,
                    -(trailWindowSec + graceSec),
                    new Cesium.JulianDate()
                );
                // Wide-open start so we remove EVERY sample before the
                // cutoff. Cesium's TimeInterval uses inclusive bounds
                // by default which is exactly what we want here.
                positionProperty.removeSamples(new Cesium.TimeInterval({
                    start: PRUNE_INTERVAL_START,
                    stop: cutoff,
                }));

                if ((vi + 1) % MARITIME_CHUNK_SIZE === 0 && vi + 1 < vessels.length) {
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                    if (!refreshStateIfFresh()) return;
                    if (!currentSources.maritime) return;
                }
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
                        const darkSinceDate = new Date(dv.darkSince);
                        const darkMinutes = Math.round((Date.now() - dv.darkSince) / 60000);
                        darkVesselDs.entities.add({
                            id: darkId,
                            name: `AIS Lost: ${dv.id} (${darkMinutes}m silent)`,
                            position: Cesium.Cartesian3.fromDegrees(dv.lng, dv.lat, 0),
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
        });

        return () => {
            active = false;
            clearInterval(speedInterval);
            clearInterval(staleCleanup);
            socket.disconnect();
            socketRef.current = null;
            aircraftMetaMap.clear();
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(aviBillboards);
                viewer.dataSources.remove(maritimeDs);
                viewer.dataSources.remove(darkVesselDs);
            }
            aviBillboardsRef.current = null;
            maritimeDsRef.current = null;
            darkVesselDsRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: visibility toggles ----
    // Effective show = source && visibility && !deepHistory. Source-off
    // hides the aircraft / vessel layers AND (via fresh-read inside the
    // socket handler) stops adding new entities. The scene clear on
    // source-off is handled in Effect 0a below.
    const aviSourceOnSel = useTimelineStore(s => s.sources.aviation);
    const marSourceOnSel = useTimelineStore(s => s.sources.maritime);
    useEffect(() => {
        const isDeepHistory = mode === 'playback' && (Date.now() - currentTime.getTime() > 10 * 60 * 1000);
        if (aviBillboardsRef.current) aviBillboardsRef.current.show = aviSourceOnSel && isAviationVisible && !isDeepHistory;
        if (maritimeDsRef.current) maritimeDsRef.current.show = marSourceOnSel && isMaritimeVisible && !isDeepHistory;
        if (darkVesselDsRef.current) darkVesselDsRef.current.show = marSourceOnSel && isMaritimeVisible && !isDeepHistory;
    }, [aviSourceOnSel, marSourceOnSel, isAviationVisible, isMaritimeVisible, mode, currentTime]);

    // ---- Effect 0a: source-off scene clear ----
    // When the user turns aviation / maritime OFF, drop the existing
    // billboards / entities so that re-enabling starts from an empty
    // scene and the next simulator-update repopulates with fresh data.
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
        }
    }, [aviSourceOnSel]);
    useEffect(() => {
        if (!marSourceOnSel) {
            const mds = maritimeDsRef.current;
            const dvs = darkVesselDsRef.current;
            if (mds) mds.entities.removeAll();
            if (dvs) dvs.entities.removeAll();
            marLastSeenRef.current.clear();
            useTimelineStore.getState().setSubtypeCounts('maritime', {});
            useTimelineStore.getState().setStreamMetric('maritime', {
                count: 0,
                status: 'disabled',
                speed: '-',
            });
        }
    }, [marSourceOnSel]);

    // ---- Effect 3: vessel trails toggle ----
    // Flips every existing vessel's `path.show` on any state change —
    // constant property, no per-frame cost when the flag is steady.
    useEffect(() => {
        const ds = maritimeDsRef.current;
        if (!ds) return;
        const constant = new Cesium.ConstantProperty(showTrajectories);
        ds.entities.values.forEach(e => {
            if (e.path) e.path.show = constant;
        });
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
        if (maritimeDsRef.current) {
            maritimeDsRef.current.entities.values.forEach(e => {
                const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'unknown';
                const subtypeOk = subtypeVisibility[`maritime:${sub}`] !== false;
                const soloOk = !isolatedEntityId || isolatedEntityId === e.id;
                e.show = subtypeOk && soloOk;
            });
        }

        // Dark vessel filtering (follows maritime visibility)
        if (darkVesselDsRef.current) {
            darkVesselDsRef.current.entities.values.forEach(e => {
                const soloOk = !isolatedEntityId || isolatedEntityId === e.id;
                e.show = soloOk;
            });
        }
    }, [subtypeVisibility, isolatedEntityId]);
}
