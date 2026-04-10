import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// GPSJam.org H3 hex data — real GNSS interference detected from ADS-B NIC values.
// Colour encodes interference ratio: high (>=50%) = red, medium (20-50%) = orange, low (<20%) = yellow.
const INTENSITY_COLORS: Record<string, Cesium.Color> = {
    high:   Cesium.Color.RED.withAlpha(0.25),
    medium: Cesium.Color.ORANGE.withAlpha(0.20),
    low:    Cesium.Color.YELLOW.withAlpha(0.15),
};
const INTENSITY_OUTLINE: Record<string, Cesium.Color> = {
    high:   Cesium.Color.RED.withAlpha(0.8),
    medium: Cesium.Color.ORANGE.withAlpha(0.6),
    low:    Cesium.Color.YELLOW.withAlpha(0.4),
};

interface JammingZone {
    id: string;
    lat: number;
    lng: number;
    boundary: [number, number][];
    countGood: number;
    countBad: number;
    ratio: number;
    intensity: 'high' | 'medium' | 'low';
    h3Index: string;
}

export function useJammingLayer(viewer: Cesium.Viewer | null) {
    const isVisible = useTimelineStore(s => s.layers.jamming);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);

    // Fetch jamming data from backend REST API
    useEffect(() => {
        if (!viewer) return;
        let active = true;

        const ds = new Cesium.CustomDataSource('jamming');
        viewer.dataSources.add(ds);
        dsRef.current = ds;

        const fetchJamming = async () => {
            try {
                const { data: zones } = await axios.get<JammingZone[]>(
                    'http://localhost:3055/api/jamming',
                    { timeout: 30000 }
                );
                if (!active || zones.length === 0) return;

                // Clear previous entities
                ds.entities.removeAll();

                const counts: Record<string, number> = {};

                for (const z of zones) {
                    counts[z.intensity] = (counts[z.intensity] || 0) + 1;

                    const fill = INTENSITY_COLORS[z.intensity] || INTENSITY_COLORS.medium;
                    const outline = INTENSITY_OUTLINE[z.intensity] || INTENSITY_OUTLINE.medium;

                    // H3 boundary is [lat, lng][], Cesium needs flat [lng, lat, lng, lat, ...]
                    const positions = z.boundary.map(([lat, lng]) =>
                        Cesium.Cartesian3.fromDegrees(lng, lat)
                    );

                    // Extrude height by intensity so zones are visible above 3D tiles
                    const extrudeHeight =
                        z.intensity === 'high' ? 80_000 :
                        z.intensity === 'medium' ? 40_000 : 15_000;

                    ds.entities.add({
                        id: z.id,
                        name: `GNSS Interference (${(z.ratio * 100).toFixed(0)}% affected)`,
                        position: Cesium.Cartesian3.fromDegrees(z.lng, z.lat, extrudeHeight / 2),
                        properties: new Cesium.PropertyBag({
                            layer: 'Jamming',
                            subtype: z.intensity,
                            source: 'GPSJam.org (ADS-B NIC)',
                            description: `${z.countBad} of ${z.countGood + z.countBad} aircraft reported degraded GPS in this cell. Ratio: ${(z.ratio * 100).toFixed(1)}%`,
                        }),
                        polygon: {
                            hierarchy: new Cesium.PolygonHierarchy(positions),
                            material: new Cesium.ColorMaterialProperty(fill),
                            height: 0,
                            extrudedHeight: extrudeHeight,
                            outline: true,
                            outlineColor: outline,
                            outlineWidth: 1,
                        },
                    });
                }

                useTimelineStore.getState().setSubtypeCounts('jamming', counts);
                useTimelineStore.getState().setStreamMetric('jamming', {
                    count: zones.length,
                    status: 'streaming',
                    source: 'GPSJam.org',
                    type: 'ADS-B NIC analysis',
                    poll: '6h',
                    upstream: '24h',
                });

                console.log(`[Jamming] Rendered ${zones.length} interference zones (${counts.high || 0} high, ${counts.medium || 0} medium, ${counts.low || 0} low)`);
            } catch (err: any) {
                console.warn('[Jamming] Failed to fetch:', err.message);
                useTimelineStore.getState().setStreamMetric('jamming', {
                    count: 0,
                    status: 'error',
                    source: 'GPSJam.org',
                });
            }
        };

        fetchJamming();
        // Re-fetch every 6 hours
        const interval = setInterval(fetchJamming, 6 * 3600 * 1000);

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

    // Per-subtype visibility (intensity = subtype)
    useEffect(() => {
        if (!dsRef.current) return;
        dsRef.current.entities.values.forEach(e => {
            const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'unknown';
            e.show = subtypeVisibility[`jamming:${sub}`] !== false;
        });
    }, [subtypeVisibility]);
}
