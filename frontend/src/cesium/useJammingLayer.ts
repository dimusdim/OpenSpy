import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

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
    // sources.jamming = fetch GPSJam; visibility.jamming = render H3 cells
    const isSourceOn = useTimelineStore(s => s.sources.jamming);
    const isVisible = useTimelineStore(s => s.visibility.jamming);
    const mode = useTimelineStore(s => s.mode);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);

    // ---- Effect 1: scene lifetime ----
    useEffect(() => {
        if (!viewer) return;
        const ds = new Cesium.CustomDataSource('jamming');
        viewer.dataSources.add(ds);
        dsRef.current = ds;
        return () => {
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
            }
            dsRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: fetch loop ----
    useEffect(() => {
        if (!viewer || !isSourceOn) return;
        let active = true;

        const fetchJamming = async () => {
            const ds = dsRef.current;
            if (!ds) return;
            try {
                const { data: zones } = await axios.get<JammingZone[]>(
                    `${API_URL}/api/jamming`,
                    { timeout: 30000 }
                );
                if (!active) return;

                // Always clear first — even on empty payload — so stale
                // jamming cells from the previous poll don't remain on the
                // globe when backend returns [].
                ds.entities.removeAll();

                const counts: Record<string, number> = {};

                if (zones.length === 0) {
                    useTimelineStore.getState().setSubtypeCounts('jamming' as any, counts);
                    useTimelineStore.getState().setStreamMetric('jamming', { count: 0, status: 'streaming' });
                    return;
                }

                // Chunked build — GPSJam typically returns ~1000 extruded
                // H3 polygon zones; building them all synchronously is a
                // noticeable cold-load hitch. Yield every JAMMING_CHUNK_SIZE
                // entities so input stays responsive.
                const JAMMING_CHUNK_SIZE = 150;
                for (let zi = 0; zi < zones.length; zi++) {
                    const z = zones[zi];
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

                    if ((zi + 1) % JAMMING_CHUNK_SIZE === 0 && zi + 1 < zones.length) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        if (!active) return;
                        if (!useTimelineStore.getState().sources.jamming) return;
                    }
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
            // Keep datasource — Effect 1 owns its lifetime.
        };
    }, [viewer, isSourceOn]);

    // ---- Effect 3: layer visibility ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (dsRef.current) dsRef.current.show = mode !== 'playback' && isSourceOn && isVisible;
    }, [isSourceOn, isVisible, mode]);

    // ---- Effect 4: per-subtype visibility ----
    useEffect(() => {
        if (!dsRef.current) return;
        dsRef.current.entities.values.forEach(e => {
            const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'unknown';
            e.show = subtypeVisibility[`jamming:${sub}`] !== false;
        });
    }, [subtypeVisibility]);

    // ---- Effect 5: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        if (dsRef.current) dsRef.current.entities.removeAll();
        useTimelineStore.getState().setSubtypeCounts('jamming', {});
        useTimelineStore.getState().setStreamMetric('jamming', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
