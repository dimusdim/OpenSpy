'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSatellitesLayer, satelliteFootprintMetaMap, satelliteMetaMap } from '../cesium/useSatellitesLayer';
import { useDynamicLayers, aircraftMetaMap } from '../cesium/useDynamicLayers';
import { useOsintLayer } from '../cesium/useOsintLayer';
import { useJammingLayer } from '../cesium/useJammingLayer';
import { useBordersLayer } from '../cesium/useBordersLayer';
import { useFiresLayer, fireMetaMap } from '../cesium/useFiresLayer';
import { useCablesLayer, cableMetaMap, cableInstanceToLogical } from '../cesium/useCablesLayer';
import { useWebcamsLayer, webcamMetaMap } from '../cesium/useWebcamsLayer';
import { useInfrastructureLayer, infraMetaMap, infraStripInstanceId } from '../cesium/useInfrastructureLayer';
import { usePipelinesLayer, pipelineMetaMap } from '../cesium/usePipelinesLayer';
import { useOutagesLayer } from '../cesium/useOutagesLayer';
import { useTrafficLayer } from '../cesium/useTrafficLayer';
import { useConflictsLayer } from '../cesium/useConflictsLayer';
import { useAirspaceLayer, airspaceMetaMap, airspaceInstanceToLogical } from '../cesium/useAirspaceLayer';
import { useGFWLayer } from '../cesium/useGFWLayer';

if (typeof window !== 'undefined') {
    (window as any).CESIUM_BASE_URL = '/cesium';
}

export default function Globe() {
    // viewer is in state (not ref) so layer hooks re-run their useEffect once
    // it becomes available — using useRef alone never re-renders the component
    // and layer hooks would stay stuck on `viewer === null` until some unrelated
    // store update triggered a re-render (the "click Live to see anything" bug).
    const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        if (viewer) return;

        const v = new Cesium.Viewer(containerRef.current, {
            animation: false,
            timeline: false,
            baseLayerPicker: false,
            geocoder: false,
            homeButton: false,
            sceneModePicker: false,
            navigationHelpButton: false,
            fullscreenButton: false,
            infoBox: false,
            selectionIndicator: false,
            requestRenderMode: true,
            baseLayer: Cesium.ImageryLayer.fromProviderAsync(
                Cesium.createWorldImageryAsync({
                    style: Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
                })
            )
        });

        // Rate-limit clock-driven renders to ~1 Hz.
        //
        // `requestRenderMode: true` above is the Cesium pattern for "only
        // render when something changed", but the default
        // `scene.maximumRenderTimeChange = 0` means ANY change in
        // simulation time counts as a change — so with `shouldAnimate=true`
        // the clock advances every animation frame and Cesium re-enters
        // the full render pipeline (entity visualizer updates, path
        // rebuilds, sampled property interpolation for every one of
        // ~4500 dynamic entities) at 60 Hz. That's the primary drag-time
        // main-thread sink identified in the root-cause audit.
        //
        // Setting this to 1.0 means: Cesium requests a new render only
        // when simulation time has advanced by >=1 second since the last
        // frame. Camera movements (drag, zoom, tilt) still trigger
        // immediate renders via their own requestRender calls, so the
        // globe stays interactive — rotation still feels smooth — we
        // just stop re-evaluating every dynamic property 60 times a
        // second when nothing the user cares about has changed.
        //
        // Satellites visibly step forward once a second instead of
        // smoothly interpolating; at orbital speeds the visual drift is
        // sub-pixel at global zoom and a few pixels at city zoom, well
        // below the perceptual threshold for a situational-awareness
        // overlay.
        v.scene.maximumRenderTimeChange = 1.0;

        // Invalidate render when visibility state changes. In
        // requestRenderMode Cesium only redraws on camera/clock/data
        // changes — store-driven toggles (Legend, filters, Solo) don't
        // trigger a scene change, so the globe stays visually stale.
        let prevVis = {} as any, prevSub = {} as any, prevFilter = null as any, prevTrails = false;
        const unsub = useTimelineStore.subscribe((state) => {
            if (state.visibility !== prevVis ||
                state.subtypeVisibility !== prevSub ||
                state.activeFilter !== prevFilter ||
                state.showTrajectories !== prevTrails) {
                prevVis = state.visibility;
                prevSub = state.subtypeVisibility;
                prevFilter = state.activeFilter;
                prevTrails = state.showTrajectories;
                v.scene.requestRender();
            }
        });

        // 3D geometry (Google / OSM) is loaded reactively by a separate
        // useEffect that watches `tileMode`. We no longer load here.

        // Enable real lighting (sun/stars) for realistic space view
        v.scene.globe.enableLighting = true;
        // Remove default double-click entity tracking behavior
        v.cesiumWidget.screenSpaceEventHandler.removeInputAction(
            Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
        );
        v.cesiumWidget.screenSpaceEventHandler.removeInputAction(
            Cesium.ScreenSpaceEventType.LEFT_CLICK // We override default selection
        );

        // Custom picking logic — handles both Entity API objects (satellites,
        // maritime, osint, jamming) and BillboardCollection primitives (aircraft).
        v.cesiumWidget.screenSpaceEventHandler.setInputAction((click: any) => {
            const pickedObject = v.scene.pick(click.position);
            if (!Cesium.defined(pickedObject)) {
                useTimelineStore.getState().setSelectedEntityId(null);
                return;
            }

            // Case 1: BillboardCollection billboard (aircraft or webcam) —
            // pickedObject.id is a plain string set in billboard.add({ id: ... }).
            if (typeof pickedObject.id === 'string') {
                // Webcam billboard
                const wcMeta = webcamMetaMap.get(pickedObject.id);
                if (wcMeta) {
                    useTimelineStore.getState().setSelectedEntityId(pickedObject.id, {
                        name: wcMeta.name,
                        id: pickedObject.id,
                        type: 'Webcam',
                        url: wcMeta.url,
                        source: wcMeta.source,
                        country: wcMeta.country,
                        imageUrl: wcMeta.imageUrl,
                        playerUrl: wcMeta.playerUrl,
                    });
                    return;
                }

                // Aircraft billboard
                const acMeta = aircraftMetaMap.get(pickedObject.id);
                if (acMeta) {
                    // Show callsign in header, fall back to icao24 if empty
                    const displayName = acMeta.callsign && acMeta.callsign !== acMeta.icao24
                        ? `Flight ${acMeta.callsign}`
                        : `Aircraft ${acMeta.icao24.toUpperCase()}`;
                    useTimelineStore.getState().setSelectedEntityId(pickedObject.id, {
                        name: displayName,
                        id: pickedObject.id,
                        type: 'Aircraft',
                    });
                    return;
                }

                // Satellite billboard (BillboardCollection)
                const satMeta = satelliteMetaMap.get(pickedObject.id);
                if (satMeta) {
                    useTimelineStore.getState().setSelectedEntityId(pickedObject.id, {
                        name: satMeta.name,
                        id: pickedObject.id,
                        type: 'Satellite',
                        subtype: satMeta.subtype,
                        noradId: satMeta.noradId,
                        ...(satMeta.reconMeta ? { country: satMeta.reconMeta.country, sensorType: satMeta.reconMeta.sensorType, resolution: satMeta.reconMeta.resolution } : {}),
                        ...(satMeta.sensor ? { sensor: satMeta.sensor } : {}),
                    });
                    return;
                }

                // Fire point (PointPrimitiveCollection)
                const fireMeta = fireMetaMap.get(pickedObject.id);
                if (fireMeta) {
                    const level = fireMeta.frp > 100 ? 'High' : fireMeta.frp > 30 ? 'Medium' : 'Low';
                    useTimelineStore.getState().setSelectedEntityId(pickedObject.id, {
                        name: `Fire (${level} FRP: ${fireMeta.frp.toFixed(1)} MW)`,
                        id: pickedObject.id,
                        type: 'Fire',
                    });
                    return;
                }

                // Submarine cable (GroundPolylinePrimitive). Multipart cables
                // come back with an instance id like "cable-foo#2" — map it
                // back to the logical id before the metaMap lookup.
                const cableLogicalId = cableInstanceToLogical.get(pickedObject.id) ?? pickedObject.id;
                const cableMeta = cableMetaMap.get(cableLogicalId);
                if (cableMeta) {
                    useTimelineStore.getState().setSelectedEntityId(cableLogicalId, {
                        name: cableMeta.name,
                        id: cableLogicalId,
                        type: 'Cable',
                    });
                    return;
                }

                // Pipeline (Primitive + PolylineGeometry). Single-part — no
                // instance-id suffix so logicalId is the pick id directly.
                const pipelineMeta = pipelineMetaMap.get(pickedObject.id);
                if (pipelineMeta) {
                    useTimelineStore.getState().setSelectedEntityId(pickedObject.id, {
                        name: pipelineMeta.name,
                        id: pickedObject.id,
                        type: 'Pipeline',
                    });
                    return;
                }

                // Airspace zone (dual Primitive: fill + outline). Pick id is
                // a part id like "airspace-42#0#fill"; strip the suffix via
                // the instance→logical map before the metaMap lookup.
                const airspaceLogicalId = airspaceInstanceToLogical.get(pickedObject.id) ?? pickedObject.id;
                const airspaceMeta = airspaceMetaMap.get(airspaceLogicalId);
                if (airspaceMeta) {
                    useTimelineStore.getState().setSelectedEntityId(airspaceLogicalId, {
                        name: `${airspaceMeta.typeName}: ${airspaceMeta.name}`,
                        id: airspaceLogicalId,
                        type: 'Airspace',
                    });
                    return;
                }

                // Infrastructure (plants, refineries, military, substations,
                // power lines). Per-tile instance ids embed the tile key
                // (MEDIUM 6 dedup), so strip the tile prefix via
                // infraStripInstanceId before looking up the logical meta.
                const infraLogicalId = infraStripInstanceId(pickedObject.id);
                const infraMeta = infraMetaMap.get(infraLogicalId);
                if (infraMeta) {
                    useTimelineStore.getState().setSelectedEntityId(infraLogicalId, {
                        name: infraMeta.name,
                        id: infraLogicalId,
                        type: 'Infrastructure',
                    });
                    return;
                }
            }

            // Case 2: Entity API object (satellite, vessel, osint, jamming,
            // border, infrastructure, pipeline, cable, airspace, …)
            if (pickedObject.id && pickedObject.id instanceof Cesium.Entity) {
                const entity = pickedObject.id;
                const eid = entity.id ?? '';

                // Satellite footprint overlay — fp-* and beam-* ids live in
                // the sat-footprints datasource and reference a parent
                // satellite via satelliteFootprintMetaMap. Resolve to the
                // parent sat so the HUD shows the correct satellite with
                // the footprint annotation, not the footprint entity
                // itself (which has no Legend layer of its own).
                if (eid.startsWith('fp-sat-') || eid.startsWith('beam-sat-')) {
                    const fpMeta = satelliteFootprintMetaMap.get(eid);
                    if (fpMeta) {
                        useTimelineStore.getState().setSelectedEntityId(fpMeta.parentSatId, {
                            name: fpMeta.satName,
                            id: fpMeta.parentSatId,
                            type: 'Satellite',
                            // Annotate the card with the sensor source so
                            // the HUD can render the "Projected —
                            // Spectator Earth" block.
                            footprint: {
                                sensorName: fpMeta.sensorName,
                                sensorType: fpMeta.sensorType,
                                swathMeters: fpMeta.swathMeters,
                                source: fpMeta.source,
                                projected: true,
                            },
                        });
                        return;
                    }
                }

                // Prefer the authoritative `layer` stashed in entity.properties
                // by the layer hooks — single source of truth, survives arbitrary
                // id shapes (cables have no prefix, pwr-* is new, etc.).
                const props = entity.properties as Cesium.PropertyBag | undefined;
                let layerName: string | undefined;
                try {
                    const raw = (props as any)?.layer;
                    layerName = typeof raw?.getValue === 'function' ? raw.getValue() : raw;
                } catch {
                    layerName = undefined;
                }

                if (layerName) {
                    useTimelineStore.getState().setSelectedEntityId(eid, {
                        name: entity.name || eid,
                        id: eid,
                        type: layerName,
                    });
                    return;
                }

                // Fallback: id-prefix heuristics for entities whose layer hook
                // hasn't been migrated to set properties.layer yet.
                const metadata = {
                    name: entity.name,
                    id: eid,
                    type: eid.startsWith('sat-') ? 'Satellite'
                        : eid.startsWith('jam-') ? 'Jamming'
                        : eid.startsWith('gdacs-') || eid.startsWith('usgs-') || eid.startsWith('eonet-') ? 'OSINT'
                        : eid.startsWith('infra-') ? 'Infrastructure'
                        : eid.startsWith('pipe-') ? 'Pipeline'
                        : eid.startsWith('pwr-') ? 'Infrastructure'
                        : eid.startsWith('cable-') ? 'Cable'
                        : eid.startsWith('border-') ? 'Border'
                        : eid.startsWith('outage-') || eid.startsWith('cf-') ? 'Outage'
                        : eid.startsWith('dark-') ? 'AIS Signal Lost'
                        : eid.startsWith('conflict-') || eid.startsWith('acled-') ? 'Conflict'
                        : eid.startsWith('airspace-') ? 'Airspace'
                        : eid.startsWith('gfw-') ? 'GFW Event'
                        : 'Vessel'
                };
                useTimelineStore.getState().setSelectedEntityId(eid, metadata);
                return;
            }

            useTimelineStore.getState().setSelectedEntityId(null);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Map touchpad controls better for zooming and panning
        v.scene.screenSpaceCameraController.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH];
        v.scene.screenSpaceCameraController.tiltEventTypes = [Cesium.CameraEventType.PINCH, Cesium.CameraEventType.RIGHT_DRAG];

        // --- Globe-centred navigation ---
        //
        // The only camera control we change from Cesium defaults is
        // `enableTranslate` (middle-click / two-finger pan that drags
        // the globe under the cursor). That gesture is what drifts the
        // earth off-centre; disabling it leaves the user with the
        // default left-drag-spin and wheel-zoom, both of which orbit /
        // scale around the globe's centre in 3D mode.
        //
        // Previously this effect also installed a `lookAtTransform` lock
        // at `Cartesian3.ZERO`. That hard-froze Cesium's mouse handlers
        // (no input response even after textures + orbits had loaded)
        // because `Cartesian3.ZERO` is the literal centre of the Earth
        // and the ENU frame there is degenerate. Default Cesium controls
        // already orbit around the globe's centre for left-drag in 3D
        // mode, so the transform lock wasn't needed — removing it
        // restores input responsiveness.
        v.scene.screenSpaceCameraController.enableTranslate = false;

        // Push viewer clock → Zustand store (throttled to 1 Hz) so
        // TimelinePlayer sees the real Cesium time. We do NOT force-
        // clamp `clock.currentTime = now()` here anymore: with
        // `clockStep = SYSTEM_CLOCK_MULTIPLIER` + `multiplier = 1.0`
        // (set below) Cesium naturally tracks wall-clock in live mode.
        //
        // The old code rewrote currentTime on every animation tick,
        // which meant the simulation time always changed by a tiny
        // increment → `scene.maximumRenderTimeChange` saw a change every
        // frame → Cesium entered the full dynamic render pipeline at
        // 60 Hz, nullifying the whole `requestRenderMode` benefit.
        // Removing the forced clamp is exactly what makes the rate
        // limiter work.
        let lastStoreSync = 0;
        v.clock.onTick.addEventListener((clock) => {
             const now = performance.now();
             if (now - lastStoreSync >= 1000) {
                 lastStoreSync = now;
                 const currentDate = Cesium.JulianDate.toDate(clock.currentTime);
                 const storeTime = useTimelineStore.getState().currentTime;
                 if (Math.abs(storeTime.getTime() - currentDate.getTime()) > 750) {
                     useTimelineStore.getState().setCurrentTime(currentDate);
                 }
             }
        });

        // Setting default epoch
        const start = Cesium.JulianDate.fromDate(new Date());
        v.clock.currentTime = start;
        v.clock.clockRange = Cesium.ClockRange.UNBOUNDED;
        v.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
        v.clock.multiplier = 1.0;
        v.clock.shouldAnimate = true;

        const handleTimelineCtrl = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail.action === 'play') v.clock.shouldAnimate = true;
            if (detail.action === 'pause') v.clock.shouldAnimate = false;
            if (detail.action === 'speed') v.clock.multiplier = detail.value;
            if (detail.action === 'seek' && detail.time) {
                v.clock.currentTime = Cesium.JulianDate.fromIso8601(detail.time);
            }
        };
        document.addEventListener('timeline-ctrl', handleTimelineCtrl);

        const handleFlyTo = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            v.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(detail.lng, detail.lat, detail.height || 15000),
                duration: 2.0,
            });
        };
        document.addEventListener('fly-to', handleFlyTo);

        (window as any).viewerContext = v;
        // Publish viewer through React state so layer hooks see it and re-run.
        setViewer(v);

        return () => {
            unsub();
            document.removeEventListener('timeline-ctrl', handleTimelineCtrl);
            document.removeEventListener('fly-to', handleFlyTo);
            if (!v.isDestroyed()) {
                v.destroy();
            }
            setViewer(null);
        };
    }, []);

    // --- NASA GIBS Cloud Fraction as a transparent shell at ~8km ---
    // Rather than paint the MODIS Cloud Fraction product flat on the globe
    // surface (the old WMTS+ImageryLayer approach), we wrap a single
    // equirectangular PNG around a transparent ellipsoid entity whose
    // radii are WGS84 + 8km. Visually this floats the clouds above the
    // terrain with proper parallax, so mountains/buildings read as being
    // under the cloud deck instead of being painted over by it.
    //
    // The GIBS WMS GetMap endpoint returns the whole world as a single
    // PNG with PNG alpha — transparent where there are no clouds — so
    // ImageMaterialProperty + equirectangular projection on an ellipsoid
    // gets us a proper cloud shell with one HTTP fetch.
    const showClouds = useTimelineStore(s => s.sources.clouds && s.visibility.clouds);
    const cloudPrimRef = useRef<Cesium.Primitive | null>(null);

    useEffect(() => {
        if (!viewer) return;
        // GIBS cloud products lag ~1 day, so use yesterday's date
        const cloudDate = new Date(Date.now() - 86400_000).toISOString().split('T')[0];
        const cloudImageUrl =
            'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi' +
            '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
            '&LAYERS=MODIS_Terra_Cloud_Fraction_Day' +
            '&STYLES=&FORMAT=image/png&TRANSPARENT=true' +
            '&BBOX=-90,-180,90,180&SRS=EPSG:4326' +
            '&WIDTH=2048&HEIGHT=1024' +
            `&TIME=${cloudDate}`;

        // WGS84 semi-major / semi-minor radii + 8 km shell.
        const CLOUD_ALT = 8000;
        const semiMajor = 6378137 + CLOUD_ALT;
        const semiMinor = 6356752.3142 + CLOUD_ALT;

        // Use a Primitive + EllipsoidGeometry directly: gives us proper ECEF
        // alignment without ENU-at-origin issues that Entity.position=ZERO
        // can introduce. EllipsoidSurfaceAppearance handles equirectangular
        // texture mapping over the sphere surface.
        const ellipsoidGeom = new Cesium.EllipsoidGeometry({
            radii: new Cesium.Cartesian3(semiMajor, semiMajor, semiMinor),
            vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
        });
        const geomInstance = new Cesium.GeometryInstance({
            geometry: ellipsoidGeom,
            id: 'cloud-shell',
        });
        const appearance = new Cesium.EllipsoidSurfaceAppearance({
            material: new Cesium.Material({
                fabric: {
                    type: 'Image',
                    uniforms: {
                        image: cloudImageUrl,
                        color: new Cesium.Color(1.0, 1.0, 1.0, 0.55),
                    },
                },
                translucent: true,
            }),
            translucent: true,
        });
        const cloudPrim = new Cesium.Primitive({
            geometryInstances: geomInstance,
            appearance,
            asynchronous: false,
        });
        cloudPrim.show = showClouds;
        viewer.scene.primitives.add(cloudPrim);
        cloudPrimRef.current = cloudPrim;
        viewer.scene.requestRender();
        console.log(`[Clouds] Shell primitive added (radii ${semiMajor}m, alt ${CLOUD_ALT}m, date ${cloudDate})`);

        // Track metric status for the Legend.
        const metricsInterval = setInterval(() => {
            if (viewer.isDestroyed()) return;
            useTimelineStore.getState().setStreamMetric('clouds', {
                count: cloudPrim.show ? 1 : 0,
                status: cloudPrim.show ? 'streaming' : 'connecting',
                speed: cloudDate,
            });
        }, 5000);

        return () => {
            clearInterval(metricsInterval);
            if (viewer && !viewer.isDestroyed() && cloudPrimRef.current) {
                viewer.scene.primitives.remove(cloudPrimRef.current);
                cloudPrimRef.current = null;
            }
        };
    }, [viewer]);

    useEffect(() => {
        if (cloudPrimRef.current && viewer) {
            cloudPrimRef.current.show = showClouds;
            viewer.scene.requestRender();
        }
    }, [showClouds, viewer]);

    // --- Base globe imagery / 3D geometry: Google | OSM | MODIS ---
    // Google and OSM tilesets are loaded lazily on first selection and
    // kept in memory — switching just flips `.show`, no re-download.
    // MODIS mode swaps the globe's base imagery layer for NASA GIBS MODIS
    // True Color (WMTS), no 3D tileset involved. When switching away from
    // MODIS we restore the default Cesium Ion aerial base layer.
    const tileMode = useTimelineStore(s => s.tileMode);
    const googleTileRef = useRef<Cesium.Cesium3DTileset | null>(null);
    const osmTileRef = useRef<Cesium.Cesium3DTileset | null>(null);
    const terrainLoadedRef = useRef(false);
    // MODIS True Color base layer + stashed default Ion aerial, used to
    // swap/restore the globe's bottom imagery layer as tileMode changes.
    const modisBaseLayerRef = useRef<Cesium.ImageryLayer | null>(null);
    const defaultBaseLayerRef = useRef<Cesium.ImageryLayer | null>(null);

    useEffect(() => {
        if (!viewer) return;
        let active = true;

        async function ensureGoogle() {
            if (googleTileRef.current) return; // already loaded
            const googleKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
            if (!googleKey) {
                console.warn('[Globe] NEXT_PUBLIC_GOOGLE_MAPS_KEY not set — falling back to OSM');
                // Use setState directly to avoid triggering saveSettingsToServer —
                // this is a runtime fallback, not a user preference change.
                useTimelineStore.setState({ tileMode: 'osm' });
                return;
            }
            try {
                const url = `https://tile.googleapis.com/v1/3dtiles/root.json?key=${googleKey}`;
                const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
                    // LOD optimization: higher = less detail = faster rendering.
                    //
                    // In-browser profiling (measured April 2026) showed Google
                    // Photorealistic 3D Tiles cost ~6.4 ms per frame at SSE=24
                    // and dropped the interactive FPS from 44 to ~11. At SSE=48
                    // Cesium draws roughly half as many tiles per frame, which
                    // brings rotation back toward the 30-45 FPS range on
                    // mid-range hardware without visibly degrading the
                    // photorealistic look at typical command-centre zoom
                    // levels (we rarely sit at a single building for long).
                    maximumScreenSpaceError: 16,
                    // Skip intermediate LOD levels — jump straight to the target,
                    // avoids rendering multiple LOD layers during zoom transitions.
                    skipLevelOfDetail: true,
                    // Collision was enabled so CLAMP_TO_GROUND billboards could
                    // latch onto the photo mesh, but the same profiling showed
                    // the clamp-collision resolver running on every frame over
                    // every clamp-registered billboard (fires, infrastructure,
                    // cables) is a separate main-thread sink on top of the
                    // tileset render cost. Off = those markers fall to the
                    // ellipsoid/terrain surface (still geolocated correctly),
                    // which is a reasonable trade for a responsive globe.
                    enableCollision: false,
                } as any);
                // Cap the tile cache. The prior 512 MB setting let Cesium
                // retain a lot of mesh data across rotations, which showed
                // up in profiling as heap oscillation between ~420 and 999
                // MB with 150-200 ms GC pauses. 128 MB still keeps the
                // currently-visible scene in cache but prevents the heap
                // from ballooning into the "force major GC" band.
                tileset.cacheBytes = 128 * 1024 * 1024;
                if (!active || viewer!.isDestroyed()) return;
                tileset.show = tileMode === 'google';
                viewer!.scene.primitives.add(tileset);
                googleTileRef.current = tileset;
                console.log('[Globe] Google Photorealistic 3D Tiles loaded (cached)');
            } catch (err) {
                console.warn('[Globe] Google 3D Tiles failed, falling back to OSM:', err);
                // Use setState directly to avoid triggering saveSettingsToServer —
                // this is a runtime fallback, not a user preference change.
                useTimelineStore.setState({ tileMode: 'osm' });
            }
        }

        async function ensureOsm() {
            if (osmTileRef.current) return; // already loaded
            try {
                if (!terrainLoadedRef.current) {
                    viewer!.terrainProvider = await Cesium.createWorldTerrainAsync();
                    terrainLoadedRef.current = true;
                }
                const buildings = await Cesium.createOsmBuildingsAsync();
                if (!active || viewer!.isDestroyed()) return;
                buildings.show = tileMode === 'osm';
                viewer!.scene.primitives.add(buildings);
                osmTileRef.current = buildings;
                console.log('[Globe] OSM 3D Buildings loaded (cached)');
            } catch (err) {
                console.warn('[Globe] OSM Buildings failed:', err);
            }
        }

        // Swap the globe's base imagery to NASA GIBS MODIS True Color.
        // Stashes the original Cesium Ion aerial in defaultBaseLayerRef so
        // restoreDefaultBase() can put it back when switching away. The
        // MODIS layer is inserted at index 0 so cloud/other overlays sit
        // above it just as they did above the Ion aerial.
        function applyModis() {
            if (viewer!.isDestroyed()) return;
            if (modisBaseLayerRef.current) return; // already applied

            const layers = viewer!.imageryLayers;
            if (layers.length > 0 && !defaultBaseLayerRef.current) {
                defaultBaseLayerRef.current = layers.get(0);
                // Remove without destroying so we can re-insert on switch-away.
                layers.remove(defaultBaseLayerRef.current, false);
            }

            // UTC yesterday — GIBS warns that today's date often returns empty
            // areas (MODIS Terra orbits once per day, mosaic isn't complete).
            const now = new Date();
            const utcYesterday = new Date(
                Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)
            ).toISOString().slice(0, 10);
            // Use the EPSG:3857 (Web Mercator) endpoint with GoogleMapsCompatible
            // tile matrix — it aligns with Cesium's WebMercatorTilingScheme out
            // of the box. The EPSG:4326 endpoint uses a NASA-padded matrix
            // layout (-180,90 → 396,-198) that doesn't match Cesium's default
            // GeographicTilingScheme, causing visible offsets.
            const provider = new Cesium.WebMapTileServiceImageryProvider({
                url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${utcYesterday}/GoogleMapsCompatible_Level9/{TileMatrix}/{TileRow}/{TileCol}.jpg`,
                layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
                style: 'default',
                tileMatrixSetID: 'GoogleMapsCompatible_Level9',
                tilingScheme: new Cesium.WebMercatorTilingScheme(),
                tileWidth: 256,
                tileHeight: 256,
                maximumLevel: 9,
                format: 'image/jpeg',
                credit: 'NASA GIBS MODIS',
            });
            // Insert at index 0 — this is the base imagery, not an overlay.
            const layer = layers.addImageryProvider(provider, 0);
            modisBaseLayerRef.current = layer;
            console.log('[Globe] MODIS True Color base imagery applied');
        }

        // Remove the MODIS base layer (destroying its provider) and
        // re-insert the stashed default Ion aerial at index 0.
        function restoreDefaultBase() {
            if (viewer!.isDestroyed()) return;
            const layers = viewer!.imageryLayers;
            if (modisBaseLayerRef.current) {
                layers.remove(modisBaseLayerRef.current, true); // destroy
                modisBaseLayerRef.current = null;
            }
            if (defaultBaseLayerRef.current) {
                layers.add(defaultBaseLayerRef.current, 0);
                defaultBaseLayerRef.current = null;
            }
        }

        // Load whichever is needed, then apply visibility + imagery
        (async () => {
            if (tileMode === 'google') {
                await ensureGoogle();
            } else if (tileMode === 'osm') {
                await ensureOsm();
            }
            // modis mode needs no async tileset load — base imagery swap is sync.
            if (viewer!.isDestroyed()) return;

            // Apply show flags (refs may be non-null after first switch)
            if (googleTileRef.current) googleTileRef.current.show = tileMode === 'google';
            if (osmTileRef.current)    osmTileRef.current.show    = tileMode === 'osm';

            // MODIS base-imagery swap: apply when entering modis, restore otherwise.
            if (tileMode === 'modis') {
                applyModis();
            } else {
                restoreDefaultBase();
            }

            // Globe surface visibility:
            //   google → hidden (3D photo mesh covers everything)
            //   osm    → visible (terrain + aerial imagery beneath buildings)
            //   modis  → visible (MODIS true-color imagery IS the globe surface)
            if (!viewer!.isDestroyed()) {
                viewer!.scene.globe.show = tileMode !== 'google';
            }
        })();

        return () => { active = false; };
    }, [viewer, tileMode]);

    // Add render layers
    useSatellitesLayer(viewer);
    useDynamicLayers(viewer);
    useOsintLayer(viewer);
    useJammingLayer(viewer);
    useBordersLayer(viewer);
    useFiresLayer(viewer);
    useCablesLayer(viewer);
    useWebcamsLayer(viewer);
    useInfrastructureLayer(viewer);
    usePipelinesLayer(viewer);
    useOutagesLayer(viewer);
    useTrafficLayer(viewer);
    useConflictsLayer(viewer);
    useAirspaceLayer(viewer);
    useGFWLayer(viewer);

    return (
        <div ref={containerRef} className="absolute inset-0 w-full h-full" />
    );
}
