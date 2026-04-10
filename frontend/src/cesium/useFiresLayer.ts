import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// NASA FIRMS active fire hotspots rendered via PointPrimitiveCollection —
// GPU-batched, handles 66K+ points in a single draw call. Entity API would
// choke at this volume (66K per-frame property evaluations).

// Metadata for picking — stores fire info per point ID
export interface FireMeta { lat: number; lng: number; frp: number; brightness: number; confidence: string; }
export const fireMetaMap = new Map<string, FireMeta>();

export function useFiresLayer(viewer: Cesium.Viewer | null) {
    const isVisible = useTimelineStore(s => s.layers.fires ?? true);
    const collectionRef = useRef<Cesium.PointPrimitiveCollection | null>(null);

    useEffect(() => {
        if (!viewer) return;

        const collection = new Cesium.PointPrimitiveCollection();
        viewer.scene.primitives.add(collection);
        collectionRef.current = collection;

        let active = true;

        async function fetchFires() {
            try {
                const res = await axios.get('http://localhost:3055/api/fires');
                if (!active || !res.data?.length) return;

                collection.removeAll();
                fireMetaMap.clear();
                for (const f of res.data) {
                    const frp = f.frp || 1;
                    const pixelSize = Math.max(2, Math.min(8, 1.5 + Math.log2(frp)));
                    const color = frp > 100 ? Cesium.Color.RED
                        : frp > 30 ? Cesium.Color.ORANGE
                        : Cesium.Color.YELLOW;
                    const fireId = f.id || `fire-${f.lat}-${f.lng}`;

                    collection.add({
                        position: Cesium.Cartesian3.fromDegrees(f.lng, f.lat, 50),
                        color,
                        pixelSize,
                        id: fireId,
                    });
                    fireMetaMap.set(fireId, {
                        lat: f.lat, lng: f.lng,
                        frp, brightness: f.brightness || 0,
                        confidence: f.confidence || '',
                    });
                }

                useTimelineStore.getState().setStreamMetric('fires', {
                    count: collection.length,
                    status: 'streaming',
                });
                console.log(`[Fires] Rendered ${collection.length} hotspots via PointPrimitiveCollection`);
            } catch (err) {
                console.warn('[Fires] Fetch failed:', err);
            }
        }

        fetchFires();
        const interval = setInterval(fetchFires, 30 * 60_000);

        return () => {
            active = false;
            clearInterval(interval);
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(collection);
            }
        };
    }, [viewer]);

    useEffect(() => {
        if (collectionRef.current) collectionRef.current.show = isVisible;
    }, [isVisible]);
}
