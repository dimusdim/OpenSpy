import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
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
const JAMMING_FETCH_TIMEOUT_MS = 60_000;
const JAMMING_RETRY_DELAYS_MS = [2_000, 8_000, 20_000, 45_000];

interface JammingZone {
    id: string;
    lat: number;
    lng: number;
    boundary: [number, number][];
    intensity: 'high' | 'medium' | 'low';
}

export function useJammingLayer(viewer: Cesium.Viewer | null) {
    // sources.jamming = fetch GPSJam; visibility.jamming = render H3 cells
    const isSourceOn = useTimelineStore(s => s.sources.jamming);
    const isVisible = useTimelineStore(s => s.visibility.jamming);
    const mode = useTimelineStore(s => s.mode);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const secondaryReleased = useSecondaryLoadGate();
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
        if (!viewer || !isSourceOn || !secondaryReleased) return;
        let active = true;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const fetchJamming = async (attempt = 0) => {
            const ds = dsRef.current;
            if (!ds) return;
            try {
                const { data: zones } = await axios.get<JammingZone[]>(
                    `${API_URL}/api/jamming`,
                    { timeout: JAMMING_FETCH_TIMEOUT_MS }
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
                        name: `GNSS Interference (${z.intensity})`,
                        position: Cesium.Cartesian3.fromDegrees(z.lng, z.lat, extrudeHeight / 2),
                        properties: new Cesium.PropertyBag({
                            layer: 'Jamming',
                            subtype: z.intensity,
                            source: 'GPSJam.org (ADS-B NIC)',
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
                if (!active) return;
                const delayMs = JAMMING_RETRY_DELAYS_MS[attempt];
                if (delayMs != null) {
                    useTimelineStore.getState().setStreamMetric('jamming', {
                        status: 'connecting',
                        source: 'GPSJam.org',
                        note: `Fetch retry ${attempt + 1}/${JAMMING_RETRY_DELAYS_MS.length} after ${err?.message || 'request failure'}`,
                    });
                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        void fetchJamming(attempt + 1);
                    }, delayMs);
                    return;
                }

                console.warn('[Jamming] Failed to fetch after retries:', err?.message || err);
                useTimelineStore.getState().setStreamMetric('jamming', {
                    count: 0,
                    status: 'error',
                    source: 'GPSJam.org',
                    note: err?.message || 'request failure',
                });
            }
        };

        fetchJamming();
        // Re-fetch every 6 hours
        const interval = setInterval(fetchJamming, 6 * 3600 * 1000);

        return () => {
            active = false;
            if (retryTimer) clearTimeout(retryTimer);
            clearInterval(interval);
            // Keep datasource — Effect 1 owns its lifetime.
        };
    }, [viewer, isSourceOn, secondaryReleased]);

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
