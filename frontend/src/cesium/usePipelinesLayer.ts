import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// Oil & gas pipelines from OSM Overpass, rendered as polylines.
// Fetched once and cached in the backend for 24h.

export function usePipelinesLayer(viewer: Cesium.Viewer | null) {
  const isVisible = useTimelineStore((s) => s.layers.pipelines);
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);
  const loadedRef = useRef(false);
  const subtypeVisibility = useTimelineStore((s) => s.subtypeVisibility);

  useEffect(() => {
    if (!viewer || loadedRef.current) return;
    loadedRef.current = true;

    const ds = new Cesium.CustomDataSource('pipelines');
    viewer.dataSources.add(ds);
    dsRef.current = ds;

    async function fetchPipelines() {
      try {
        useTimelineStore.getState().setStreamMetric('pipelines', {
          status: 'connecting',
          speed: 'loading...',
        });

        const res = await axios.get('http://localhost:3055/api/pipelines', {
          timeout: 150_000, // Overpass can be very slow for global queries
        });
        const records: any[] = res.data ?? [];
        if (!records.length) {
          useTimelineStore.getState().setStreamMetric('pipelines', {
            count: 0,
            status: 'streaming',
            speed: 'no data',
          });
          return;
        }

        for (const rec of records) {
          if (!rec.coordinates?.length || rec.coordinates.length < 2) continue;

          // coordinates are [lat, lng][] from backend — convert to Cartesian3
          // Raised 200m above surface to avoid z-fighting with terrain
          const positions = rec.coordinates.map((pt: number[]) =>
            Cesium.Cartesian3.fromDegrees(pt[1], pt[0], 50)
          );

          const color =
            rec.substance === 'oil'
              ? Cesium.Color.RED.withAlpha(0.6)
              : Cesium.Color.DODGERBLUE.withAlpha(0.6);

          ds.entities.add({
            id: rec.id,
            name: rec.name,
            polyline: {
              positions,
              width: 2,
              material: color,
            },
            properties: new Cesium.PropertyBag({
              layer: 'Pipeline',
              subtype: rec.substance,
              source: 'OpenStreetMap',
              description: rec.name,
            }),
          });
        }

        useTimelineStore.getState().setStreamMetric('pipelines', {
          count: ds.entities.values.length,
          status: 'streaming',
          speed: '-',
        });
        console.log(
          `[Pipelines] Loaded ${ds.entities.values.length} pipeline segments`
        );
      } catch (err) {
        console.warn('[Pipelines] Fetch failed:', err);
        useTimelineStore.getState().setStreamMetric('pipelines', {
          status: 'error',
          speed: 'failed',
        });
      }
    }

    fetchPipelines();

    return () => {
      loadedRef.current = false;
      if (viewer && !viewer.isDestroyed()) {
        viewer.dataSources.remove(ds);
      }
      dsRef.current = null;
    };
  }, [viewer]);

  // Visibility toggle
  useEffect(() => {
    if (dsRef.current) dsRef.current.show = isVisible;
  }, [isVisible]);

  // Per-subtype visibility + counts
  useEffect(() => {
    const ds = dsRef.current;
    if (!ds) return;
    const counts: Record<string, number> = {};
    ds.entities.values.forEach((e) => {
      const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'unknown';
      counts[sub] = (counts[sub] || 0) + 1;
      const show = subtypeVisibility[`pipelines:${sub}`] !== false;
      e.show = show;
    });
    useTimelineStore.getState().setSubtypeCounts('pipelines', counts);
  }, [subtypeVisibility, isVisible]);
}
