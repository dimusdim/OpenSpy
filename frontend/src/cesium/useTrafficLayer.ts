import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { useTimelineStore } from '../store/useTimelineStore';

/**
 * TomTom Traffic Flow raster overlay.
 *
 * Proxied through the backend so the API key stays server-side.
 * Only shown when the camera is below ~100 km altitude (close zoom)
 * AND the `traffic` layer is toggled on in the store.
 *
 * The imagery uses UrlTemplateImageryProvider pointing at the backend
 * raster proxy endpoint: /api/traffic/raster/{z}/{x}/{y}
 */
export function useTrafficLayer(viewer: Cesium.Viewer | null) {
    const isVisible = useTimelineStore(s => s.layers.traffic);
    const layerRef = useRef<Cesium.ImageryLayer | null>(null);
    const tickRef = useRef<Cesium.Event.RemoveCallback | null>(null);

    // Create the imagery layer once
    useEffect(() => {
        if (!viewer) return;

        const provider = new Cesium.UrlTemplateImageryProvider({
            url: 'http://localhost:3055/api/traffic/raster/{z}/{x}/{y}',
            minimumLevel: 0,
            maximumLevel: 18,
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

        // Camera height check — hide traffic layer when zoomed out > 100 km
        const onTick = () => {
            if (!layerRef.current || viewer.isDestroyed()) return;
            const carto = viewer.camera.positionCartographic;
            const heightKm = carto.height / 1000;
            const storeVisible = useTimelineStore.getState().layers.traffic;
            const shouldShow = storeVisible && heightKm < 100;
            layerRef.current.show = shouldShow;

            useTimelineStore.getState().setStreamMetric('traffic', {
                count: shouldShow ? 1 : 0,
                status: storeVisible ? 'streaming' : 'connecting',
                speed: shouldShow ? `alt ${Math.round(heightKm)} km` : heightKm >= 100 ? 'zoom in (<100 km)' : 'off',
            });
        };

        const removeCallback = viewer.clock.onTick.addEventListener(onTick);
        tickRef.current = removeCallback;

        return () => {
            if (tickRef.current) tickRef.current();
            if (viewer && !viewer.isDestroyed() && layerRef.current) {
                viewer.imageryLayers.remove(layerRef.current);
                layerRef.current = null;
            }
        };
    }, [viewer]);

    // React to store toggle changes immediately
    useEffect(() => {
        if (!layerRef.current || !viewer || viewer.isDestroyed()) return;
        // The onTick handler above will pick up the new isVisible value
        // on the next frame. Force an immediate update for responsiveness:
        const carto = viewer.camera.positionCartographic;
        const heightKm = carto.height / 1000;
        layerRef.current.show = isVisible && heightKm < 100;
    }, [isVisible, viewer]);
}
