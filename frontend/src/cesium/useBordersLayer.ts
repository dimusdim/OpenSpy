import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { useTimelineStore } from '../store/useTimelineStore';

// NaturalEarth 110m boundary lines (~40KB). Free, no key, real data.
const BOUNDARIES_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_boundary_lines_land.geojson';

// Wall height for border segments (metres). Visible at global zoom,
// not absurdly tall at city zoom. Semi-transparent.
const WALL_HEIGHT = 80_000;

export function useBordersLayer(viewer: Cesium.Viewer | null) {
    const isVisible = useTimelineStore(s => s.layers.labels);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);
    const loadedRef = useRef(false);

    useEffect(() => {
        if (!viewer || loadedRef.current) return;
        loadedRef.current = true;

        const ds = new Cesium.CustomDataSource('borders');
        viewer.dataSources.add(ds);
        dsRef.current = ds;

        // --- Country border walls ---
        fetch(BOUNDARIES_URL)
            .then(r => r.json())
            .then(geojson => {
                if (viewer.isDestroyed()) return;
                for (const feature of geojson.features) {
                    const geom = feature.geometry;
                    if (!geom) continue;

                    const lines = geom.type === 'MultiLineString'
                        ? geom.coordinates
                        : [geom.coordinates];

                    for (const coords of lines) {
                        if (!coords || coords.length < 2) continue;

                        const degreesFlat: number[] = [];
                        for (const [lng, lat] of coords) {
                            degreesFlat.push(lng, lat);
                        }

                        const positions = Cesium.Cartesian3.fromDegreesArray(degreesFlat);
                        const maxHeights = new Array(positions.length).fill(WALL_HEIGHT);
                        const minHeights = new Array(positions.length).fill(0);

                        ds.entities.add({
                            wall: {
                                positions,
                                maximumHeights: maxHeights,
                                minimumHeights: minHeights,
                                material: Cesium.Color.CYAN.withAlpha(0.12),
                                outline: true,
                                outlineColor: Cesium.Color.CYAN.withAlpha(0.4),
                                outlineWidth: 1,
                            },
                        });
                    }
                }
                console.log(`[Borders] Loaded ${ds.entities.values.length} border wall segments`);
                useTimelineStore.getState().setStreamMetric('labels', {
                    count: ds.entities.values.length,
                    status: 'streaming',
                });
            })
            .catch(err => console.warn('[Borders] Failed to load:', err));

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
