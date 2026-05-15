import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { getIconOpacity, getIconScale, getMapIcon } from '../icons/map-icons';

// Metadata per webcam, keyed by billboard id string.
export interface WebcamMeta {
    id: string;
    name: string;
    lat: number;
    lng: number;
    source: string;
    coordinateQuality?: string;
    upstreamStatus?: string;
}

// Global registry so Globe.tsx picking + EntityHUD can look up webcam metadata.
export const webcamMetaMap = new Map<string, WebcamMeta>();

export function useWebcamsLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.webcams);
    const isVisible = useTimelineStore(s => s.visibility.webcams);
    const mode = useTimelineStore(s => s.mode);
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    const secondaryReleased = useSecondaryLoadGate();
    const collectionRef = useRef<Cesium.BillboardCollection | null>(null);

    // ---- Effect 1: scene lifetime ----
    useEffect(() => {
        if (!viewer) return;
        const billboards = new Cesium.BillboardCollection({
            scene: viewer.scene,
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
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
        if (!viewer || !isSourceOn || mode === 'playback' || !secondaryReleased) return;
        let active = true;

        async function fetchWebcams() {
            const billboards = collectionRef.current;
            if (!billboards) return;
            try {
                const res = await axios.get(`${API_URL}/api/webcams`);
                if (!active || !Array.isArray(res.data)) return;

                billboards.removeAll();
                webcamMetaMap.clear();

                const cams: any[] = res.data;
                for (let ci = 0; ci < cams.length; ci++) {
                    const cam = cams[ci];
                    if (!cam.lat || !cam.lng) continue;
                    const camId = `webcam-${cam.id}`;

                    billboards.add({
                        position: Cesium.Cartesian3.fromDegrees(cam.lng, cam.lat, 50),
                        image: getMapIcon('webcams', 'default'),
                        scale: getIconScale('webcams', 'default', 0.5),
                        color: Cesium.Color.WHITE.withAlpha(getIconOpacity('webcams', 'default')),
                        id: camId,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    });

                    webcamMetaMap.set(camId, {
                        id: cam.id,
                        name: cam.name,
                        lat: cam.lat,
                        lng: cam.lng,
                        source: cam.source,
                        coordinateQuality: cam.coordinateQuality,
                        upstreamStatus: cam.upstreamStatus,
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
            // Keep billboards — Effect 1 owns their lifetime.
        };
    }, [viewer, isSourceOn, mode, secondaryReleased]);

    // ---- Effect 3: layer visibility ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (collectionRef.current) collectionRef.current.show = mode !== 'playback' && isSourceOn && isVisible;
    }, [isSourceOn, isVisible, mode]);

    // ---- Effect 4: solo filter (isolatedEntityId) ----
    useEffect(() => {
        const col = collectionRef.current;
        if (!col) return;
        for (let i = 0; i < col.length; i++) {
            const bb = col.get(i);
            bb.show = !isolatedEntityId || isolatedEntityId === bb.id;
        }
    }, [isolatedEntityId]);

    // ---- Effect 5: source-off scene clear ----
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
