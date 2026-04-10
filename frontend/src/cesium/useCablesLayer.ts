import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// Submarine internet cables from TeleGeography. GeoJSON with LineStrings
// running along the ocean floor. Rendered as polylines clamped to ground.
export function useCablesLayer(viewer: Cesium.Viewer | null) {
    const isVisible = useTimelineStore(s => s.layers.cables);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);
    const loadedRef = useRef(false);

    useEffect(() => {
        if (!viewer || loadedRef.current) return;
        loadedRef.current = true;

        const ds = new Cesium.CustomDataSource('cables');
        viewer.dataSources.add(ds);
        dsRef.current = ds;

        async function fetchCables() {
            try {
                const res = await axios.get('http://localhost:3055/api/cables');
                const geojson = res.data;
                if (!geojson?.features?.length) return;

                for (const feature of geojson.features) {
                    const coords = feature.geometry?.coordinates;
                    const name = feature.properties?.name || feature.properties?.cable_id || 'Cable';
                    if (!coords?.length) continue;

                    // GeoJSON can be LineString or MultiLineString
                    const lines = feature.geometry.type === 'MultiLineString'
                        ? coords : [coords];

                    for (const line of lines) {
                        if (!line || line.length < 2) continue;
                        const degreesFlat: number[] = [];
                        for (const pt of line) {
                            degreesFlat.push(pt[0], pt[1]);
                        }

                        ds.entities.add({
                            name,
                            polyline: {
                                positions: Cesium.Cartesian3.fromDegreesArray(degreesFlat),
                                width: 2,
                                material: Cesium.Color.DEEPSKYBLUE.withAlpha(0.4),
                                clampToGround: true,
                            },
                            properties: new Cesium.PropertyBag({
                                layer: 'Cable',
                                subtype: 'submarine',
                                source: 'TeleGeography',
                                description: name,
                            }),
                        });
                    }
                }

                useTimelineStore.getState().setStreamMetric('cables', {
                    count: ds.entities.values.length,
                    status: 'streaming',
                });
                console.log(`[Cables] Loaded ${ds.entities.values.length} cable segments`);
            } catch (err) {
                console.warn('[Cables] Fetch failed:', err);
            }
        }

        fetchCables();

        return () => {
            loadedRef.current = false;
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
            }
        };
    }, [viewer]);

    useEffect(() => {
        if (dsRef.current) dsRef.current.show = isVisible;
    }, [isVisible]);
}
