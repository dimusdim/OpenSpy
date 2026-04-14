import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

/**
 * TomTom Traffic Flow raster overlay.
 *
 * Proxied through the backend so the API key stays server-side.
 * Only shown when the camera is below ~100 km altitude (close zoom)
 * AND the `traffic` layer is toggled on in the store.
 *
 * The imagery uses UrlTemplateImageryProvider pointing at the backend
 * raster proxy endpoint: /api/traffic/raster/{z}/{x}/{y}
 *
 * Lifecycle split (HIGH 1 fix): imagery layers are a special case —
 * Cesium's ImageryLayer stops issuing tile requests to the backend iff
 * `layer.show = false`, so source-off and visibility-off collapse to the
 * same mechanism for imagery. We still create/remove the layer only on
 * viewer mount/unmount; toggles just flip `layer.show` through the tick
 * listener that also enforces the altitude gate.
 */
export function useTrafficLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.traffic);
    const isVisible = useTimelineStore(s => s.visibility.traffic);
    const layerRef = useRef<Cesium.ImageryLayer | null>(null);
    const tickRef = useRef<Cesium.Event.RemoveCallback | null>(null);

    // ---- Effect 1: scene lifetime ----
    // Creates the ImageryLayer once per viewer. The show flag starts off
    // and is driven entirely by the tick listener below, which reads both
    // source and visibility fresh from the store every frame.
    useEffect(() => {
        if (!viewer) return;

        const provider = new Cesium.UrlTemplateImageryProvider({
            url: `${API_URL}/api/traffic/raster/{z}/{x}/{y}`,
            minimumLevel: 0,
            // Cap at 14 — TomTom free tier rate-limits aggressively, and at
            // higher zoom Cesium requests too many tiles per frame. Level 14
            // is roughly city-block detail, enough for traffic visualization.
            maximumLevel: 14,
            credit: 'TomTom Traffic Flow',
        });

        const layer = viewer.imageryLayers.addImageryProvider(provider);
        layer.alpha = 0.6;
        layer.show = false; // controlled by tick listener + store flag
        layerRef.current = layer;

        // Report metrics
        useTimelineStore.getState().setStreamMetric('traffic', {
            count: 0,
            status: 'streaming',
            speed: 'tiles on demand',
        });

        // Camera height check — hide traffic layer when zoomed out > 100 km.
        // Only push to the Zustand store when something observable actually
        // changed, otherwise we rerender LayerManager on every clock tick.
        let lastShouldShow: boolean | null = null;
        let lastStoreVisible: boolean | null = null;
        let lastHeightBucket: number | null = null;
        const onTick = () => {
            if (!layerRef.current || viewer.isDestroyed()) return;
            const carto = viewer.camera.positionCartographic;
            const heightKm = carto.height / 1000;
            // Fresh read — traffic layer is both source- and visibility-gated.
            // If the Legend hides it, or the LayerManager stops the source, we
            // must keep the tile layer invisible so Cesium stops issuing tile
            // requests to TomTom.
            const storeState = useTimelineStore.getState();
            const storeVisible = storeState.sources.traffic && storeState.visibility.traffic;
            const shouldShow = storeVisible && heightKm < 100;
            layerRef.current.show = shouldShow;

            // Bucket the altitude so the "alt N km" label only changes once per km,
            // and we can compare cheaply to detect real changes.
            const heightBucket = Math.round(heightKm);
            const changed =
                lastShouldShow !== shouldShow ||
                lastStoreVisible !== storeVisible ||
                lastHeightBucket !== heightBucket;
            if (!changed) return;
            lastShouldShow = shouldShow;
            lastStoreVisible = storeVisible;
            lastHeightBucket = heightBucket;

            useTimelineStore.getState().setStreamMetric('traffic', {
                count: shouldShow ? 1 : 0,
                status: storeVisible ? 'streaming' : 'connecting',
                speed: shouldShow ? `alt ${heightBucket} km` : heightKm >= 100 ? 'zoom in (<100 km)' : 'off',
            });
        };

        const removeCallback = viewer.clock.onTick.addEventListener(onTick);
        tickRef.current = removeCallback;

        return () => {
            if (tickRef.current) tickRef.current();
            tickRef.current = null;
            if (viewer && !viewer.isDestroyed() && layerRef.current) {
                viewer.imageryLayers.remove(layerRef.current);
            }
            layerRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: react to store toggle changes immediately ----
    // The onTick handler picks this up too, but flipping `show` here avoids
    // a one-frame flash where the old value is still active.
    useEffect(() => {
        if (!layerRef.current || !viewer || viewer.isDestroyed()) return;
        const carto = viewer.camera.positionCartographic;
        const heightKm = carto.height / 1000;
        const shouldShow = isSourceOn && isVisible && heightKm < 100;
        layerRef.current.show = shouldShow;
        console.log(`[Traffic] toggle: source=${isSourceOn} vis=${isVisible} alt=${Math.round(heightKm)}km globe.show=${viewer.scene.globe.show} → layer.show=${shouldShow}`);
    }, [isSourceOn, isVisible, viewer]);
}
