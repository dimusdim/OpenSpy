'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSatellitesLayer } from '../cesium/useSatellitesLayer';
import { useDynamicLayers, aircraftMetaMap } from '../cesium/useDynamicLayers';
import { useOsintLayer } from '../cesium/useOsintLayer';
import { useJammingLayer } from '../cesium/useJammingLayer';
import { useBordersLayer } from '../cesium/useBordersLayer';
import { useFiresLayer, fireMetaMap } from '../cesium/useFiresLayer';
import { useCablesLayer } from '../cesium/useCablesLayer';
import { useWebcamsLayer, webcamMetaMap } from '../cesium/useWebcamsLayer';
import { useInfrastructureLayer } from '../cesium/useInfrastructureLayer';
import { usePipelinesLayer } from '../cesium/usePipelinesLayer';
import { useOutagesLayer } from '../cesium/useOutagesLayer';
import { useTrafficLayer } from '../cesium/useTrafficLayer';
import { useConflictsLayer } from '../cesium/useConflictsLayer';
import { useAirspaceLayer } from '../cesium/useAirspaceLayer';
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
                    });
                    return;
                }

                // Aircraft billboard
                const acMeta = aircraftMetaMap.get(pickedObject.id);
                if (acMeta) {
                    useTimelineStore.getState().setSelectedEntityId(pickedObject.id, {
                        name: `Flight ${acMeta.id}`,
                        id: pickedObject.id,
                        type: 'Aircraft',
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
            }

            // Case 2: Entity API object (satellite, vessel, osint, jamming)
            if (pickedObject.id && pickedObject.id instanceof Cesium.Entity) {
                const entity = pickedObject.id;
                const eid = entity.id ?? '';
                const metadata = {
                    name: entity.name,
                    id: eid,
                    type: eid.startsWith('sat-') ? 'Satellite'
                        : eid.startsWith('jam-') ? 'Jamming'
                        : eid.startsWith('gdacs-') || eid.startsWith('usgs-') || eid.startsWith('eonet-') ? 'OSINT'
                        : eid.startsWith('infra-') ? 'Infrastructure'
                        : eid.startsWith('pipe-') ? 'Pipeline'
                        : eid.startsWith('outage-') || eid.startsWith('cf-') ? 'Outage'
                        : eid.startsWith('dark-') ? 'Dark Vessel'
                        : eid.startsWith('conflict-') || eid.startsWith('acled-') ? 'Conflict'
                        : eid.startsWith('airspace-') ? 'Airspace'
                        : eid.startsWith('gfw-') ? 'GFW Event'
                        : 'Vessel'
                };
                useTimelineStore.getState().setSelectedEntityId(entity.id, metadata);
                return;
            }

            useTimelineStore.getState().setSelectedEntityId(null);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Map touchpad controls better for zooming and panning
        v.scene.screenSpaceCameraController.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH];
        v.scene.screenSpaceCameraController.tiltEventTypes = [Cesium.CameraEventType.PINCH, Cesium.CameraEventType.RIGHT_DRAG];

        // Sync Clock with Mode
        v.clock.onTick.addEventListener((clock) => {
             const mode = useTimelineStore.getState().mode;
             if (mode === 'live') {
                 // Force to current system time
                 clock.currentTime = Cesium.JulianDate.fromDate(new Date());
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
                duration: 2.0
            });
        };
        document.addEventListener('fly-to', handleFlyTo);

        (window as any).viewerContext = v;
        // Publish viewer through React state so layer hooks see it and re-run.
        setViewer(v);

        return () => {
            document.removeEventListener('timeline-ctrl', handleTimelineCtrl);
            document.removeEventListener('fly-to', handleFlyTo);
            if (!v.isDestroyed()) {
                v.destroy();
            }
            setViewer(null);
        };
    }, []);

    // --- NASA GIBS MODIS cloud overlay (today's imagery) ---
    // Free, no auth, WMTS tiles. Updates daily. Shows real cloud coverage.
    const showClouds = useTimelineStore(s => s.layers.clouds ?? false);
    const gibsLayerRef = useRef<Cesium.ImageryLayer | null>(null);

    useEffect(() => {
        if (!viewer) return;
        // Build today's date string for GIBS TIME parameter
        const today = new Date().toISOString().split('T')[0];
        // Bake today's date directly into the URL — avoids the `times`/`clock`
        // coupling that WebMapTileServiceImageryProvider enforces.
        const provider = new Cesium.UrlTemplateImageryProvider({
            url: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${today}/250m/{z}/{y}/{x}.jpg`,
            tilingScheme: new Cesium.GeographicTilingScheme(),
            maximumLevel: 8,
            credit: 'NASA GIBS',
        });
        const layer = viewer.imageryLayers.addImageryProvider(provider);
        layer.alpha = 0.5;
        layer.show = showClouds;
        gibsLayerRef.current = layer;

        // Track tile loading metrics for LayerManager
        const metricsInterval = setInterval(() => {
            if (viewer.isDestroyed()) return;
            // Cesium doesn't expose per-layer tile counts directly, but
            // the globe's tileLoadProgressEvent gives total pending tiles.
            // For a simple "loaded" indicator we check if the provider is ready.
            const tilesLoaded = (provider as any)._tilingScheme ? 'ready' : 'loading';
            useTimelineStore.getState().setStreamMetric('clouds', {
                count: layer.show ? 1 : 0,
                status: layer.show ? 'streaming' : 'connecting',
                speed: tilesLoaded === 'ready' ? `${today}` : 'loading...',
            });
        }, 5000);

        return () => {
            clearInterval(metricsInterval);
            if (viewer && !viewer.isDestroyed() && gibsLayerRef.current) {
                viewer.imageryLayers.remove(gibsLayerRef.current);
                gibsLayerRef.current = null;
            }
        };
    }, [viewer]);

    useEffect(() => {
        if (gibsLayerRef.current) gibsLayerRef.current.show = showClouds;
    }, [showClouds]);

    // --- NASA GIBS MODIS True Color satellite imagery overlay ---
    // Full true-color Earth imagery from MODIS Terra, daily update.
    const showSatImagery = useTimelineStore(s => s.layers.satellite_imagery ?? false);
    const satImageryLayerRef = useRef<Cesium.ImageryLayer | null>(null);

    useEffect(() => {
        if (!viewer) return;
        const today = new Date().toISOString().split('T')[0];
        const provider = new Cesium.UrlTemplateImageryProvider({
            url: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${today}/250m/{z}/{y}/{x}.jpg`,
            tilingScheme: new Cesium.GeographicTilingScheme(),
            maximumLevel: 8,
            credit: 'NASA GIBS MODIS',
        });
        const layer = viewer.imageryLayers.addImageryProvider(provider);
        layer.alpha = 0.85;
        layer.show = showSatImagery;
        satImageryLayerRef.current = layer;

        const metricsInterval = setInterval(() => {
            if (viewer.isDestroyed()) return;
            const tilesLoaded = (provider as any)._tilingScheme ? 'ready' : 'loading';
            useTimelineStore.getState().setStreamMetric('satellite_imagery', {
                count: layer.show ? 1 : 0,
                status: layer.show ? 'streaming' : 'connecting',
                speed: tilesLoaded === 'ready' ? `${today}` : 'loading...',
            });
        }, 5000);

        return () => {
            clearInterval(metricsInterval);
            if (viewer && !viewer.isDestroyed() && satImageryLayerRef.current) {
                viewer.imageryLayers.remove(satImageryLayerRef.current);
                satImageryLayerRef.current = null;
            }
        };
    }, [viewer]);

    useEffect(() => {
        if (satImageryLayerRef.current) satImageryLayerRef.current.show = showSatImagery;
    }, [showSatImagery]);

    // --- 3D geometry layer: toggle between Google Photorealistic and OSM ---
    // Both tilesets are loaded lazily on first selection and kept in memory.
    // Switching just flips `.show` — no re-download needed.
    const tileMode = useTimelineStore(s => s.tileMode);
    const googleTileRef = useRef<Cesium.Cesium3DTileset | null>(null);
    const osmTileRef = useRef<Cesium.Cesium3DTileset | null>(null);
    const terrainLoadedRef = useRef(false);

    useEffect(() => {
        if (!viewer) return;
        let active = true;

        async function ensureGoogle() {
            if (googleTileRef.current) return; // already loaded
            try {
                const url = "https://tile.googleapis.com/v1/3dtiles/root.json?key=GOOGLE_MAPS_KEY_FROM_ENV";
                const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
                    // LOD optimization: higher = less detail = faster rendering.
                    // Default is 16. 24 gives ~2x fewer tile requests at close zoom.
                    maximumScreenSpaceError: 24,
                    // Skip intermediate LOD levels — jump straight to the target,
                    // avoids rendering multiple LOD layers during zoom transitions.
                    skipLevelOfDetail: true,
                } as any);
                tileset.cacheBytes = 512 * 1024 * 1024; // 512 MB tile cache
                if (!active || viewer!.isDestroyed()) return;
                tileset.show = tileMode === 'google';
                viewer!.scene.primitives.add(tileset);
                googleTileRef.current = tileset;
                console.log('[Globe] Google Photorealistic 3D Tiles loaded (cached)');
            } catch (err) {
                console.warn('[Globe] Google 3D Tiles failed, falling back to OSM:', err);
                useTimelineStore.getState().setTileMode('osm');
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

        // Load whichever is needed, then apply visibility + imagery
        (async () => {
            if (tileMode === 'google') {
                await ensureGoogle();
            } else {
                await ensureOsm();
            }
            if (viewer!.isDestroyed()) return;

            // Apply show flags (both refs may be non-null after first switch)
            if (googleTileRef.current) googleTileRef.current.show = tileMode === 'google';
            if (osmTileRef.current)    osmTileRef.current.show    = tileMode === 'osm';

            // Google mode hides the globe (tiles replace it entirely).
            // OSM mode keeps it for terrain + satellite imagery.
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
