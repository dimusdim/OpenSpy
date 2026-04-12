import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

// Webcam icon — enhanced camera SVG rendered as a data URI for BillboardCollection.
const WEBCAM_ICON = `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><rect x="6" y="16" width="28" height="20" rx="3" fill="#0e7490" stroke="#155e75" stroke-width="1"/><line x1="6" y1="22" x2="34" y2="22" stroke="#155e75" stroke-width="0.4"/><rect x="8" y="24" width="10" height="3" rx="0.5" fill="#164e63" stroke="#0e7490" stroke-width="0.3"/><circle cx="30" cy="19" r="1.5" fill="#ef4444" stroke="#991b1b" stroke-width="0.4"/><circle cx="38" cy="26" r="8" fill="#164e63" stroke="#22d3ee" stroke-width="1"/><circle cx="38" cy="26" r="6" fill="#0c4a6e" stroke="#06b6d4" stroke-width="0.6"/><circle cx="38" cy="26" r="3.5" fill="#155e75" stroke="#22d3ee" stroke-width="0.5"/><circle cx="38" cy="26" r="1.5" fill="#22d3ee" opacity="0.6"/><circle cx="36" cy="24" r="1" fill="white" opacity="0.2"/><circle cx="38" cy="26" r="7" fill="none" stroke="#67e8f9" stroke-width="0.3" opacity="0.4"/><rect x="10" y="10" width="12" height="6" rx="2" fill="#155e75" stroke="#0e7490" stroke-width="0.8"/><rect x="12" y="11" width="4" height="4" rx="1" fill="#0c4a6e" stroke="#22d3ee" stroke-width="0.4"/><rect x="13" y="12" width="2" height="2" rx="0.5" fill="#67e8f9" opacity="0.4"/><rect x="24" y="8" width="4" height="8" rx="1.5" fill="#164e63" stroke="#0e7490" stroke-width="0.6"/><rect x="17" y="36" width="6" height="3" rx="0.5" fill="#164e63" stroke="#155e75" stroke-width="0.5"/><line x1="20" y1="39" x2="20" y2="42" stroke="#155e75" stroke-width="1"/><circle cx="9" cy="19" r="0.8" fill="#22d3ee" opacity="0.8"/></svg>`
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
    playerUrl?: string;  // Windy embed player URL
    imageUrl?: string;   // Windy preview image URL
}

// Global registry so Globe.tsx picking + EntityHUD can look up webcam metadata.
export const webcamMetaMap = new Map<string, WebcamMeta>();

export function useWebcamsLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.webcams);
    const isVisible = useTimelineStore(s => s.visibility.webcams);
    const collectionRef = useRef<Cesium.BillboardCollection | null>(null);

    // ---- Effect 1: scene lifetime ----
    useEffect(() => {
        if (!viewer) return;
        const billboards = new Cesium.BillboardCollection({ scene: viewer.scene });
        viewer.scene.primitives.add(billboards);
        collectionRef.current = billboards;
        return () => {
            webcamMetaMap.clear();
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(billboards);
            }
            collectionRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: fetch loop ----
    useEffect(() => {
        if (!viewer || !isSourceOn) return;
        let active = true;

        async function fetchWebcams() {
            const billboards = collectionRef.current;
            if (!billboards) return;
            try {
                const res = await axios.get(`${API_URL}/api/webcams`);
                if (!active || !Array.isArray(res.data)) return;

                billboards.removeAll();
                webcamMetaMap.clear();

                // Chunked — ~1000 webcams x billboard.add is lighter
                // than fires/airspace but still contributes to cold-load
                // input lag. Yield periodically.
                const WEBCAMS_CHUNK_SIZE = 250;
                const cams: any[] = res.data;
                for (let ci = 0; ci < cams.length; ci++) {
                    const cam = cams[ci];
                    if (!cam.lat || !cam.lng) continue;
                    // Skip cameras with no URL and no image
                    if (!cam.url && !cam.imageUrl) continue;

                    const camId = `webcam-${cam.id}`;

                    billboards.add({
                        position: Cesium.Cartesian3.fromDegrees(cam.lng, cam.lat, 50),
                        image: WEBCAM_ICON,
                        scale: 0.5,
                        id: camId,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    });

                    webcamMetaMap.set(camId, {
                        id: cam.id,
                        name: cam.name,
                        lat: cam.lat,
                        lng: cam.lng,
                        url: cam.url || '',
                        source: cam.source,
                        quality: cam.quality,
                        country: cam.country,
                        playerUrl: cam.playerUrl,
                        imageUrl: cam.imageUrl,
                    });

                    if ((ci + 1) % WEBCAMS_CHUNK_SIZE === 0 && ci + 1 < cams.length) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        if (!active) return;
                        if (collectionRef.current !== billboards) return;
                        if (!useTimelineStore.getState().sources.webcams) return;
                    }
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
            // Keep billboards — Effect 1 owns their lifetime.
        };
    }, [viewer, isSourceOn]);

    // ---- Effect 3: layer visibility ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (collectionRef.current) collectionRef.current.show = isSourceOn && isVisible;
    }, [isSourceOn, isVisible]);

    // ---- Effect 4: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        const col = collectionRef.current;
        if (col) col.removeAll();
        webcamMetaMap.clear();
        useTimelineStore.getState().setStreamMetric('webcams', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
