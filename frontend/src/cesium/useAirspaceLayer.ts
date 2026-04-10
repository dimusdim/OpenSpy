import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

const TYPE_COLORS: Record<number, Cesium.Color> = {
    1: Cesium.Color.RED,        // Restricted
    4: Cesium.Color.ORANGE,     // Danger
    6: Cesium.Color.DARKRED,    // Prohibited
    8: Cesium.Color.YELLOW,     // TFR
};

export function useAirspaceLayer(viewer: Cesium.Viewer | null) {
    const isVisible = useTimelineStore(s => s.layers.airspace);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);

    useEffect(() => {
        if (!viewer) return;
        let active = true;

        const ds = new Cesium.CustomDataSource('airspace');
        viewer.dataSources.add(ds);
        dsRef.current = ds;

        async function fetchAirspace() {
            try {
                const res = await axios.get('http://localhost:3055/api/airspace');
                if (!active) return;

                const zones = res.data;
                useTimelineStore.getState().setStreamMetric('airspace', {
                    count: zones.length,
                    status: zones.length > 0 ? 'streaming' : 'connecting',
                });

                ds.entities.removeAll();

                for (const zone of zones) {
                    if (!zone.geometry || zone.geometry.length === 0) continue;

                    const color = TYPE_COLORS[zone.type] || Cesium.Color.RED;

                    // Use the first ring of the first polygon
                    const ring = zone.geometry[0];
                    if (!ring || ring.length < 3) continue;

                    // ring is [lat, lng][]
                    const positions = ring.map((pt: [number, number]) =>
                        Cesium.Cartesian3.fromDegrees(pt[1], pt[0], 0)
                    );

                    ds.entities.add({
                        id: zone.id,
                        name: `${zone.typeName}: ${zone.name}`,
                        properties: new Cesium.PropertyBag({
                            layer: 'Airspace',
                            subtype: zone.typeName.toLowerCase(),
                            type: zone.type,
                            upperLimit: zone.upperLimit,
                            lowerLimit: zone.lowerLimit,
                        }),
                        polygon: {
                            hierarchy: new Cesium.PolygonHierarchy(positions),
                            material: new Cesium.ColorMaterialProperty(color.withAlpha(0.15)),
                            extrudedHeight: Math.min(zone.upperLimit || 5000, 20000),
                            height: zone.lowerLimit || 0,
                            outline: true,
                            outlineColor: color.withAlpha(0.6),
                            outlineWidth: 1,
                        },
                    });
                }

                // Update subtype counts
                const counts: Record<string, number> = {};
                for (const zone of zones) {
                    const key = (zone.typeName || 'other').toLowerCase();
                    counts[key] = (counts[key] || 0) + 1;
                }
                useTimelineStore.getState().setSubtypeCounts('airspace' as any, counts);
            } catch (err) {
                // Silent fail — will retry next interval
            }
        }

        fetchAirspace();
        const interval = setInterval(fetchAirspace, 60 * 60 * 1000); // refresh every 1h

        return () => {
            active = false;
            clearInterval(interval);
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
            }
        };
    }, [viewer]);

    // Visibility toggle
    useEffect(() => {
        if (dsRef.current) dsRef.current.show = isVisible;
    }, [isVisible]);
}
