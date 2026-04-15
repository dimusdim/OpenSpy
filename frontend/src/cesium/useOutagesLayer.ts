import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { OUTAGE_ICON_CRITICAL, OUTAGE_ICON_WARNING } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';

// Subset of country centroids for mapping Cloudflare location codes to coordinates.
const COUNTRY_CENTROIDS_MINI: Record<string, [number, number]> = {
    AF: [33.9, 67.7], AL: [41.2, 20.2], DZ: [28.0, 1.7], AO: [-11.2, 17.9],
    AR: [-38.4, -63.6], AM: [40.1, 44.5], AU: [-25.3, 133.8], AT: [47.5, 14.6],
    AZ: [40.1, 47.6], BD: [23.7, 90.4], BY: [53.7, 27.9], BE: [50.5, 4.5],
    BR: [-14.2, -51.9], BG: [42.7, 25.5], KH: [12.6, 105.0], CM: [7.4, 12.4],
    CA: [56.1, -106.3], CL: [-35.7, -71.5], CN: [35.9, 104.2], CO: [4.6, -74.3],
    CD: [-4.0, 21.8], CU: [21.5, -78.0], CZ: [49.8, 15.5], DK: [56.3, 9.5],
    EG: [26.8, 30.8], ET: [9.1, 40.5], FI: [61.9, 25.7], FR: [46.2, 2.2],
    DE: [51.2, 10.5], GH: [7.9, -1.0], GR: [39.1, 21.8], HU: [47.2, 19.5],
    IN: [20.6, 79.0], ID: [-0.8, 113.9], IR: [32.4, 53.7], IQ: [33.2, 43.7],
    IE: [53.4, -8.2], IL: [31.0, 34.9], IT: [41.9, 12.6], JP: [36.2, 138.3],
    KZ: [48.0, 68.0], KE: [-0.0, 37.9], KP: [40.3, 127.5], KR: [35.9, 127.8],
    LB: [33.9, 35.9], LY: [26.3, 17.2], MY: [4.2, 101.9], MX: [23.6, -102.6],
    MM: [21.9, 96.0], NG: [9.1, 8.7], NO: [60.5, 8.5], PK: [30.4, 69.3],
    PH: [12.9, 121.8], PL: [51.9, 19.1], PT: [39.4, -8.2], RO: [45.9, 25.0],
    RU: [61.5, 105.3], SA: [23.9, 45.1], RS: [44.0, 21.0], SG: [1.4, 103.8],
    ZA: [-30.6, 22.9], ES: [40.5, -3.7], SD: [12.9, 30.2], SE: [60.1, 18.6],
    CH: [46.8, 8.2], SY: [34.8, 39.0], TW: [23.7, 121.0], TH: [15.9, 100.9],
    TR: [39.0, 35.2], UA: [48.4, 31.2], AE: [23.4, 53.8], GB: [55.4, -3.4],
    US: [37.1, -95.7], UZ: [41.4, 64.6], VE: [6.4, -66.6], VN: [14.1, 108.3],
    YE: [15.6, 48.5], ZM: [-13.1, 28.0], ZW: [-19.0, 29.2], PS: [32.0, 35.2],
};

export function useOutagesLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.outages);
    const isVisible = useTimelineStore(s => s.visibility.outages);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);

    // ---- Effect 1: scene lifetime ----
    useEffect(() => {
        if (!viewer) return;
        const ds = new Cesium.CustomDataSource('outages');
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

        async function fetchOutages() {
            const ds = dsRef.current;
            if (!ds) return;
            try {
                // Fetch both IODA and Cloudflare outage data in parallel
                const [iodaRes, cfRes] = await Promise.allSettled([
                    axios.get(`${API_URL}/api/outages`),
                    axios.get(`${API_URL}/api/cloudflare-outages`),
                ]);
                if (!active) return;

                const outages = iodaRes.status === 'fulfilled' ? iodaRes.value.data : [];
                const cfOutages = cfRes.status === 'fulfilled' ? cfRes.value.data : [];

                const totalCount = outages.length + cfOutages.length;
                useTimelineStore.getState().setStreamMetric('outages', {
                    count: totalCount,
                    status: totalCount > 0 ? 'streaming' : 'connecting',
                });

                // Rebuild entities (outage count is small, full rebuild is fine)
                ds.entities.removeAll();

                // --- IODA outages (country-level, have lat/lng) ---
                for (const o of outages) {
                    const position = safeCartesianFromDegrees(o.lng, o.lat, 50);
                    if (!position) continue;
                    const isCritical = o.level === 'critical';
                    const color = isCritical ? Cesium.Color.RED : Cesium.Color.ORANGE;

                    ds.entities.add({
                        id: `outage-${o.countryCode}`,
                        name: `${o.country} Internet Outage (${o.level}) [IODA]`,
                        position,
                        properties: new Cesium.PropertyBag({
                            layer: 'Outage',
                            subtype: o.level,
                            datasource: o.datasource,
                            source: 'IODA',
                            country: o.country,
                            countryCode: o.countryCode,
                            startTime: o.startTime,
                        }),
                        billboard: {
                            image: isCritical ? OUTAGE_ICON_CRITICAL : OUTAGE_ICON_WARNING,
                            scale: isCritical ? 1.4 : 1.1,
                        },
                        // Pulsing ellipse around country centroid
                        ellipse: {
                            semiMinorAxis: isCritical ? 300_000 : 200_000, // 300km / 200km
                            semiMajorAxis: isCritical ? 300_000 : 200_000,
                            material: new Cesium.ColorMaterialProperty(color.withAlpha(0.1)),
                            height: 0,
                            outline: true,
                            outlineColor: color.withAlpha(0.4),
                            outlineWidth: 1,
                        },
                        label: {
                            text: o.countryCode,
                            font: '11px monospace',
                            fillColor: Cesium.Color.WHITE,
                            outlineColor: Cesium.Color.BLACK,
                            outlineWidth: 2,
                            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                            pixelOffset: new Cesium.Cartesian2(0, 22),
                        },
                    });
                }

                // --- Cloudflare Radar outages (ASN-level, use location codes) ---
                // Cloudflare outages don't have lat/lng directly, but they have
                // location codes. We map common country codes to centroids.
                for (const cf of cfOutages) {
                    // Try to get a location from the locations array
                    const locCode = (cf.locations && cf.locations.length > 0)
                        ? cf.locations[0].toUpperCase()
                        : '';
                    // Use the same IODA centroid table from the outages layer if available
                    // For now, place at a small offset from the existing IODA markers
                    // Cloudflare outages are shown as warning-level markers with CF source tag
                    const centroid = COUNTRY_CENTROIDS_MINI[locCode];
                    if (!centroid && !locCode) continue; // skip if no location

                    const lat = centroid ? centroid[0] : 0;
                    const lng = centroid ? centroid[1] : 0;
                    if (lat === 0 && lng === 0 && !centroid) continue;
                    const position = safeCartesianFromDegrees(lng + 0.5, lat + 0.5, 50);
                    if (!position) continue;

                    ds.entities.add({
                        id: cf.id,
                        name: `${cf.asnName || `ASN ${cf.asn}`} Outage [Cloudflare]`,
                        position, // slight offset
                        properties: new Cesium.PropertyBag({
                            layer: 'Outage',
                            subtype: 'warning',
                            datasource: 'cloudflare-radar',
                            source: 'Cloudflare',
                            asnName: cf.asnName || '',
                            asn: cf.asn || 0,
                            outageType: cf.outageType || '',
                            outageCause: cf.outageCause || '',
                            startDate: cf.startDate || '',
                            endDate: cf.endDate || '',
                        }),
                        billboard: {
                            image: OUTAGE_ICON_WARNING,
                            scale: 1.0,
                        },
                        ellipse: {
                            semiMinorAxis: 150_000,
                            semiMajorAxis: 150_000,
                            material: new Cesium.ColorMaterialProperty(Cesium.Color.ORANGE.withAlpha(0.07)),
                            height: 0,
                            outline: true,
                            outlineColor: Cesium.Color.ORANGE.withAlpha(0.3),
                            outlineWidth: 1,
                        },
                        label: {
                            text: locCode || 'CF',
                            font: '10px monospace',
                            fillColor: Cesium.Color.LIGHTYELLOW,
                            outlineColor: Cesium.Color.BLACK,
                            outlineWidth: 2,
                            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                            pixelOffset: new Cesium.Cartesian2(0, 22),
                        },
                    });
                }

                // Update subtype counts for Legend
                const counts: Record<string, number> = {};
                for (const o of outages) {
                    counts[o.level] = (counts[o.level] || 0) + 1;
                }
                // Cloudflare outages count as warning
                counts['warning'] = (counts['warning'] || 0) + cfOutages.length;
                useTimelineStore.getState().setSubtypeCounts('outages' as any, counts);
            } catch (err: any) {
                // Log but don't bail — the 5-min poll will retry. Surface the
                // error to the stream-metric store so LayerManager can flag it.
                console.warn('[Outages] fetch failed:', err?.message || err);
                useTimelineStore.getState().setStreamMetric('outages', { status: 'error' });
            }
        }

        fetchOutages();
        const interval = setInterval(fetchOutages, 5 * 60 * 1000); // every 5 min

        return () => {
            active = false;
            clearInterval(interval);
            // Keep datasource — Effect 1 owns its lifetime.
        };
    }, [viewer, isSourceOn]);

    // ---- Effect 3: layer visibility ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (dsRef.current) dsRef.current.show = isSourceOn && isVisible;
    }, [isSourceOn, isVisible]);

    // ---- Effect 4: per-subtype visibility ----
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    useEffect(() => {
        if (!dsRef.current) return;
        dsRef.current.entities.values.forEach(e => {
            const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'warning';
            const subtypeOk = subtypeVisibility[`outages:${sub}`] !== false;
            e.show = subtypeOk && (!isolatedEntityId || isolatedEntityId === e.id);
        });
    }, [subtypeVisibility, isolatedEntityId]);

    // ---- Effect 5: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        if (dsRef.current) dsRef.current.entities.removeAll();
        useTimelineStore.getState().setSubtypeCounts('outages' as any, {});
        useTimelineStore.getState().setStreamMetric('outages', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
