import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { useTimelineStore } from '../store/useTimelineStore';

// NaturalEarth 110m boundary lines (~40KB). Free, no key, real data.
const BOUNDARIES_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_boundary_lines_land.geojson';

// Wall height for border segments (metres). Visible at global zoom,
// not absurdly tall at city zoom. Semi-transparent.
const WALL_HEIGHT = 80_000;

export function useBordersLayer(viewer: Cesium.Viewer | null) {
    // sources.labels = fetch boundaries; visibility.labels = show rendered walls
    const isSourceOn = useTimelineStore(s => s.sources.labels);
    const isVisible = useTimelineStore(s => s.visibility.labels);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);
    // One-shot: borders are static NaturalEarth data. On source-off
    // we clear everything (see Effect 4) and re-fetch fresh on the
    // next source-on. `loadPromiseRef` is a parallel-fetch sentinel
    // with a self-check in finally; `genRef` invalidates in-flight
    // fetches whose source flipped off during load.
    const loadedRef = useRef(false);
    const loadPromiseRef = useRef<Promise<void> | null>(null);
    const genRef = useRef(0);

    // ---- Effect 1: scene lifetime ----
    useEffect(() => {
        if (!viewer) return;
        const ds = new Cesium.CustomDataSource('borders');
        viewer.dataSources.add(ds);
        dsRef.current = ds;
        return () => {
            if (!viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
            }
            dsRef.current = null;
            loadedRef.current = false;
            loadPromiseRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: single-flight fetch gate ----
    useEffect(() => {
        if (!viewer || !isSourceOn) return;
        if (loadedRef.current) return;
        if (loadPromiseRef.current) return;

        const myGen = ++genRef.current;
        const self: { promise?: Promise<void> } = {};
        self.promise = (async () => {
            try {
                const response = await fetch(BOUNDARIES_URL);
                const geojson = await response.json();
                if (viewer.isDestroyed()) return;
                if (myGen !== genRef.current) return;
                if (!useTimelineStore.getState().sources.labels) return;
                const ds = dsRef.current;
                if (!ds) return;

                // Belt-and-braces: if the datasource already has borders
                // (from a retry that somehow bypassed the sentinel), clear
                // them before the fill so we can't double-add.
                ds.entities.removeAll();

                let segIdx = 0;
                for (const feature of geojson.features) {
                    const geom = feature.geometry;
                    if (!geom) continue;

                    // NaturalEarth boundary features describe the line between
                    // two countries; properties.adm0_left / adm0_right hold the
                    // neighbouring country names.
                    const props = feature.properties ?? {};
                    const left = props.adm0_left || props.ADM0_LEFT || '';
                    const right = props.adm0_right || props.ADM0_RIGHT || '';
                    const borderName = (left && right)
                        ? `${left} — ${right}`
                        : (left || right || 'International Border');

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

                        const midIdx = Math.floor(coords.length / 2);
                        const [midLng, midLat] = coords[midIdx];
                        const anchor = Cesium.Cartesian3.fromDegrees(midLng, midLat, WALL_HEIGHT / 2);

                        const id = `border-${segIdx++}`;
                        ds.entities.add({
                            id,
                            name: borderName,
                            position: anchor,
                            properties: new Cesium.PropertyBag({
                                layer: 'Border',
                                subtype: 'country',
                                source: 'NaturalEarth',
                                description: borderName,
                            }),
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
                loadedRef.current = true;
                ds.show =
                    useTimelineStore.getState().sources.labels &&
                    useTimelineStore.getState().visibility.labels;
                console.log(`[Borders] Loaded ${ds.entities.values.length} border wall segments`);
                useTimelineStore.getState().setStreamMetric('labels', {
                    count: ds.entities.values.length,
                    status: 'streaming',
                });
            } catch (err: any) {
                console.warn('[Borders] Failed to load:', err?.message || err);
                useTimelineStore.getState().setStreamMetric('labels', { status: 'error' });
            } finally {
                if (loadPromiseRef.current === self.promise) {
                    loadPromiseRef.current = null;
                }
            }
        })();
        loadPromiseRef.current = self.promise;

        // NO cleanup — one-shot is allowed to finish.
    }, [viewer, isSourceOn]);

    // ---- Effect 3: visibility toggle ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (dsRef.current) dsRef.current.show = isSourceOn && isVisible;
    }, [isSourceOn, isVisible]);

    // ---- Effect 4: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        const ds = dsRef.current;
        if (ds) ds.entities.removeAll();
        loadedRef.current = false;
        loadPromiseRef.current = null;
        genRef.current++;
        useTimelineStore.getState().setStreamMetric('labels', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
