import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// Webcam icon — small camera SVG rendered as a data URI for BillboardCollection.
const WEBCAM_ICON = `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>` +
    `<circle cx="12" cy="13" r="4" fill="#22d3ee" fill-opacity="0.3"/>` +
    `</svg>`
);

// Metadata per webcam, keyed by billboard id string.
export interface WebcamMeta {
    id: string;
    name: string;
    lat: number;
    lng: number;
    url: string;
    source: string;
    quality?: string;
    country?: string;
}

// Global registry so Globe.tsx picking + EntityHUD can look up webcam metadata.
export const webcamMetaMap = new Map<string, WebcamMeta>();

export function useWebcamsLayer(viewer: Cesium.Viewer | null) {
    const isVisible = useTimelineStore(s => s.layers.webcams ?? true);
    const collectionRef = useRef<Cesium.BillboardCollection | null>(null);

    useEffect(() => {
        if (!viewer) return;

        const billboards = new Cesium.BillboardCollection({ scene: viewer.scene });
        viewer.scene.primitives.add(billboards);
        collectionRef.current = billboards;

        let active = true;

        async function fetchWebcams() {
            try {
                const res = await axios.get('http://localhost:3055/api/webcams');
                if (!active || !Array.isArray(res.data)) return;

                billboards.removeAll();
                webcamMetaMap.clear();

                for (const cam of res.data) {
                    if (!cam.lat || !cam.lng || !cam.url) continue;

                    const camId = `webcam-${cam.id}`;

                    billboards.add({
                        position: Cesium.Cartesian3.fromDegrees(cam.lng, cam.lat, 50),
                        image: WEBCAM_ICON,
                        scale: 0.5,
                        id: camId,
                        // Only show when camera is within 500 km — avoids 7K+ icons at global zoom
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    });

                    webcamMetaMap.set(camId, {
                        id: cam.id,
                        name: cam.name,
                        lat: cam.lat,
                        lng: cam.lng,
                        url: cam.url,
                        source: cam.source,
                        quality: cam.quality,
                        country: cam.country,
                    });
                }

                useTimelineStore.getState().setStreamMetric('webcams', {
                    count: billboards.length,
                    status: 'streaming',
                });
                console.log(`[Webcams] Rendered ${billboards.length} cameras via BillboardCollection`);
            } catch (err) {
                console.warn('[Webcams] Fetch failed:', err);
                useTimelineStore.getState().setStreamMetric('webcams', {
                    status: 'error',
                });
            }
        }

        fetchWebcams();
        // Re-fetch every hour (matches backend refresh)
        const interval = setInterval(fetchWebcams, 60 * 60_000);

        return () => {
            active = false;
            clearInterval(interval);
            webcamMetaMap.clear();
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(billboards);
            }
        };
    }, [viewer]);

    useEffect(() => {
        if (collectionRef.current) collectionRef.current.show = isVisible;
    }, [isVisible]);
}
