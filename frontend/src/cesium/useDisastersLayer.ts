import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { getDisasterIcon } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';
import { getLayerSourceVisibilityKey, normalizeLayerSourceId } from '../lib/source-visibility';

export function useDisastersLayer(viewer: Cesium.Viewer | null) {
    // sources.disasters = fetch disaster events; visibility.disasters = render them
    const isDisasterSourceOn = useTimelineStore(s => s.sources.disasters);
    const isDisasterVisible = useTimelineStore(s => s.visibility.disasters);
    const mode = useTimelineStore(s => s.mode);

    const disastersDsRef = useRef<Cesium.CustomDataSource | null>(null);
    // Bumped each time fetchEvents() completes. Dependent effects (subtype
    // counts + visibility) key off this instead of polling on an interval.
    const [eventsLoadedTick, setEventsLoadedTick] = useState(0);

    // ---- Effect 1: scene lifetime ----
    useEffect(() => {
        if (!viewer) return;
        const ds = new Cesium.CustomDataSource('disasters');
        viewer.dataSources.add(ds);
        disastersDsRef.current = ds;
        return () => {
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
            }
            disastersDsRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: fetch loop ----
    useEffect(() => {
        if (!viewer || !isDisasterSourceOn) return;

        let active = true;

        async function fetchEvents() {
            const ds = disastersDsRef.current;
            if (!ds) return;
            try {
                const res = await axios.get(`${API_URL}/api/disasters`);
                if (!active) return;

                const events = res.data;
                useTimelineStore.getState().setStreamMetric('disasters', { count: events.length, status: 'streaming' });

                // Reconciliation: remove entities that are no longer in the payload
                const currentIds = new Set<string>(events.map((e: any) => e.id));
                const existingEntities = [...ds.entities.values];
                for (const entity of existingEntities) {
                    if (!currentIds.has(entity.id)) {
                        ds.entities.remove(entity);
                    }
                }

                // Chunked build — USGS weekly earthquake feed can
                // contribute 1k+ events. Yield every DISASTER_CHUNK_SIZE
                // to keep input responsive during cold load.
                const DISASTER_CHUNK_SIZE = 200;
                const evList: any[] = events;
                for (let evi = 0; evi < evList.length; evi++) {
                    const ev = evList[evi];
                    // Skip if already loaded (avoid re-creating)
                    if (ds.entities.getById(ev.id)) continue;
                    if (ev.lat == null || ev.lng == null || isNaN(ev.lat) || isNaN(ev.lng)) continue;
                    try {
                        if (ev.type === 'strike') {
                            const position = safeCartesianFromDegrees(ev.lng, ev.lat, 50);
                            if (!position) continue;
                            const alertColor = ev.alertLevel === 'Red' ? Cesium.Color.RED
                                : ev.alertLevel === 'Orange' ? Cesium.Color.ORANGE
                                : Cesium.Color.LIME;

                            const opts: any = {
                                id: ev.id,
                                name: ev.description || ev.eventType,
                                position,
                                properties: new Cesium.PropertyBag({
                                    layer: 'Disaster',
                                    subtype: ev.eventType || 'XX',
                                    alertLevel: ev.alertLevel || 'Green',
                                    source: ev.source || 'GDACS',
                                    description: ev.description || '',
                                }),
                                billboard: {
                                    image: getDisasterIcon(ev.eventType || 'XX', ev.alertLevel || 'Green'),
                                    scale: 1.2,
                                },
                            };

                            // Impact zone ellipse when we know the radius
                            if (ev.radiusKm && ev.radiusKm > 0) {
                                opts.ellipse = {
                                    semiMinorAxis: ev.radiusKm * 1000,
                                    semiMajorAxis: ev.radiusKm * 1000,
                                    material: new Cesium.ColorMaterialProperty(alertColor.withAlpha(0.12)),
                                    height: 50,
                                    outline: true,
                                    outlineColor: alertColor.withAlpha(0.4),
                                    outlineWidth: 1,
                                };
                            }

                            ds.entities.add(opts);
                        } else if (ev.type === 'nofly' && ev.polygon) {
                            const positions = ev.polygon.map((p: number[]) => Cesium.Cartesian3.fromDegrees(p[0], p[1], 0));
                            ds.entities.add({
                                id: ev.id,
                                polygon: {
                                    hierarchy: new Cesium.PolygonHierarchy(positions),
                                    material: Cesium.Color.RED.withAlpha(0.3),
                                    extrudedHeight: 20000,
                                    outline: true,
                                    outlineColor: Cesium.Color.RED
                                }
                            });
                        }
                    } catch (e: any) {
                        console.warn('[Disasters] malformed event skipped:', e?.message || e);
                    }

                    if ((evi + 1) % DISASTER_CHUNK_SIZE === 0 && evi + 1 < evList.length) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        if (!active) return;
                        if (!useTimelineStore.getState().sources.disasters) return;
                    }
                }

                // Signal to dependent effects that entities changed.
                setEventsLoadedTick(t => t + 1);
            } catch (err: any) {
                console.warn('[Disasters] fetch failed:', err.message);
                useTimelineStore.getState().setStreamMetric('disasters', { status: 'error' });
            }
        }

        fetchEvents();
        // Poll every 5 minutes to match backend disaster refresh cadence.
        const pollInterval = setInterval(fetchEvents, 5 * 60 * 1000);

        return () => {
            active = false;
            clearInterval(pollInterval);
            // Keep entities — Effect 1 owns the datasource lifetime.
        };
    }, [viewer, isDisasterSourceOn]);

    // ---- Effect 3: layer visibility ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (disastersDsRef.current) {
            disastersDsRef.current.show = mode !== 'playback' && isDisasterSourceOn && isDisasterVisible;
        }
    }, [isDisasterSourceOn, isDisasterVisible, mode]);

    // ---- Effect 4: per-subtype visibility + counts ----
    // Recount + apply per-subtype visibility (eventType is the subtype here).
    // No setInterval: disaster entities only change on fetchEvents() (every 5
    // minutes) or when the user toggles a filter, so we react to those
    // signals directly instead of scanning every 2s.
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const sourceVisibility = useTimelineStore(s => s.sourceVisibility);
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    useEffect(() => {
        if (!viewer) return;
        const ds = disastersDsRef.current;
        if (!ds) return;
        const counts: Record<string, number> = {};
        const sourceCounts: Record<string, number> = {};
        ds.entities.values.forEach(e => {
            const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'XX';
            const source = normalizeLayerSourceId('disasters', (e.properties as any)?.source?.getValue?.());
            counts[sub] = (counts[sub] || 0) + 1;
            if (source) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
            const subtypeOk = subtypeVisibility[`disasters:${sub}`] !== false;
            const sourceOk = !source || sourceVisibility[getLayerSourceVisibilityKey('disasters', source)] !== false;
            e.show = subtypeOk && sourceOk && (!isolatedEntityId || isolatedEntityId === e.id);
        });
        useTimelineStore.getState().setSubtypeCounts('disasters', counts);
        useTimelineStore.getState().setSourceCounts('disasters', sourceCounts);
    }, [viewer, subtypeVisibility, sourceVisibility, eventsLoadedTick, isolatedEntityId]);

    // ---- Effect 5: source-off scene clear ----
    useEffect(() => {
        if (isDisasterSourceOn) return;
        if (disastersDsRef.current) disastersDsRef.current.entities.removeAll();
        useTimelineStore.getState().setSubtypeCounts('disasters', {});
        useTimelineStore.getState().setSourceCounts('disasters', {});
        useTimelineStore.getState().setStreamMetric('disasters', {
            count: 0,
            status: 'disabled',
        });
    }, [isDisasterSourceOn]);
}
