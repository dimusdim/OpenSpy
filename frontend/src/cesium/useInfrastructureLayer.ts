import { useEffect, useRef, useCallback } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// ---------------------------------------------------------------------------
// SVG billboard icons per infrastructure type
// ---------------------------------------------------------------------------

const svgUri = (body: string) =>
  `data:image/svg+xml,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );

const ICONS: Record<string, string> = {
  // Yellow lightning bolt — power plant
  power_plant: svgUri(
    `<polygon points="13,2 3,14 12,14 11,22 21,10 12,10" fill="#eab308" stroke="#000" stroke-width="1"/>`
  ),
  // Red factory — refinery
  refinery: svgUri(
    `<rect x="4" y="12" width="16" height="10" fill="#ef4444" stroke="#000" stroke-width="1" rx="1"/>` +
    `<rect x="6" y="6" width="3" height="6" fill="#ef4444" stroke="#000" stroke-width="1"/>` +
    `<rect x="11" y="8" width="3" height="4" fill="#ef4444" stroke="#000" stroke-width="1"/>` +
    `<line x1="7.5" y1="2" x2="7.5" y2="6" stroke="#666" stroke-width="1.5"/>` +
    `<line x1="12.5" y1="4" x2="12.5" y2="8" stroke="#666" stroke-width="1.5"/>`
  ),
  // Blue water drop — desalination
  desalination: svgUri(
    `<path d="M12 2 C12 2 5 12 5 16 a7 7 0 0 0 14 0 C19 12 12 2 12 2 Z" fill="#3b82f6" stroke="#000" stroke-width="1"/>`
  ),
  // Gray shield — military
  military: svgUri(
    `<path d="M12 2 L4 6 V12 C4 17 8 21 12 22 C16 21 20 17 20 12 V6 Z" fill="#6b7280" stroke="#000" stroke-width="1"/>` +
    `<path d="M9 12 L11 14 L15 10" stroke="#fff" stroke-width="2" fill="none"/>`
  ),
  // Orange circle with zap — power substation (OpenInfraMap)
  power_substation: svgUri(
    `<circle cx="12" cy="12" r="9" fill="#f97316" fill-opacity="0.8" stroke="#000" stroke-width="1"/>` +
    `<polygon points="13,5 8,13 11,13 10,19 16,11 13,11" fill="#fff" stroke="none"/>`
  ),
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useInfrastructureLayer(viewer: Cesium.Viewer | null) {
  const isVisible = useTimelineStore((s) => s.layers.infrastructure);
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBboxRef = useRef<string>('');
  const subtypeVisibility = useTimelineStore((s) => s.subtypeVisibility);

  // Camera-move callback: fetch infrastructure for current viewport
  const fetchForViewport = useCallback(async (v: Cesium.Viewer) => {
    if (v.isDestroyed()) return;

    // Check zoom level — only fetch NEW data when zoomed in, but keep existing
    const cameraHeight = v.camera.positionCartographic.height;
    if (cameraHeight > 2_000_000) {
      // Too far — don't fetch new data but keep existing (no removeAll)
      return;
    }

    // Compute visible bbox
    const rect = v.camera.computeViewRectangle();
    if (!rect) return;

    const south = Cesium.Math.toDegrees(rect.south);
    const west = Cesium.Math.toDegrees(rect.west);
    const north = Cesium.Math.toDegrees(rect.north);
    const east = Cesium.Math.toDegrees(rect.east);

    // Skip if same tile (1-degree grid)
    const bboxKey = `${Math.floor(south)},${Math.floor(west)},${Math.ceil(north)},${Math.ceil(east)}`;
    if (bboxKey === lastBboxRef.current) return;
    lastBboxRef.current = bboxKey;

    try {
      useTimelineStore.getState().setStreamMetric('infrastructure', {
        status: 'connecting',
        speed: 'loading...',
      });

      const res = await axios.get(
        `http://localhost:3055/api/infrastructure?bbox=${south},${west},${north},${east}`,
        { timeout: 35_000 }
      );

      if (v.isDestroyed()) return;
      let records: any[] = res.data ?? [];
      const ds = dsRef.current;
      if (!ds) return;

      for (const rec of records) {
        // Skip if already loaded (don't recreate — prevents flickering)
        if (ds.entities.getById(rec.id)) continue;
        ds.entities.add({
          id: rec.id,
          name: rec.name,
          position: Cesium.Cartesian3.fromDegrees(rec.lng, rec.lat, 50),
          billboard: {
            image: ICONS[rec.type] || ICONS.military,
            scale: 0.9,
          },
          properties: new Cesium.PropertyBag({
            layer: 'Infrastructure',
            subtype: rec.type,
            infraSubtype: rec.subtype || '',
            source: 'OpenStreetMap',
            description: rec.name,
          }),
        });
      }

      // Also fetch OpenInfraMap power infrastructure for same viewport
      try {
        const pwrRes = await axios.get(
          `http://localhost:3055/api/power-infra?bbox=${west},${south},${east},${north}`,
          { timeout: 35_000 }
        );
        const pwrRecords: any[] = pwrRes.data ?? [];
        for (const rec of pwrRecords) {
          if (ds.entities.getById(rec.id)) continue; // skip existing
          if (rec.type === 'power_line' && rec.coordinates && rec.coordinates.length >= 2) {
            const positions = rec.coordinates.map((c: [number, number]) =>
              Cesium.Cartesian3.fromDegrees(c[1], c[0], 50)
            );
            ds.entities.add({
              id: rec.id,
              name: rec.name,
              polyline: {
                positions,
                width: 2,
                material: new Cesium.ColorMaterialProperty(
                  Cesium.Color.ORANGE.withAlpha(0.6)
                ),
                clampToGround: true,
              },
              properties: new Cesium.PropertyBag({
                layer: 'Infrastructure',
                subtype: 'power_line',
                infraSubtype: rec.voltage || '',
                source: 'OpenInfraMap',
                description: `${rec.name}${rec.voltage ? ' (' + rec.voltage + ')' : ''}`,
              }),
            });
          } else {
            // Render power plants and substations as markers
            ds.entities.add({
              id: rec.id,
              name: rec.name,
              position: Cesium.Cartesian3.fromDegrees(rec.lng, rec.lat, 50),
              billboard: {
                image: rec.type === 'power_substation'
                  ? ICONS.power_substation
                  : ICONS.power_plant,
                scale: 0.85,
                  },
              properties: new Cesium.PropertyBag({
                layer: 'Infrastructure',
                subtype: rec.type,
                infraSubtype: rec.source || '',
                source: 'OpenInfraMap',
                description: `${rec.name}${rec.source ? ' (' + rec.source + ')' : ''}`,
              }),
            });
          }
        }
        records = records.concat(pwrRecords);
      } catch (pwrErr) {
        console.warn('[Infrastructure] OpenInfraMap fetch failed (non-fatal):', pwrErr);
      }

      useTimelineStore.getState().setStreamMetric('infrastructure', {
        count: records.length,
        status: 'streaming',
        speed: '-',
      });
    } catch (err) {
      console.warn('[Infrastructure] Fetch failed:', err);
      useTimelineStore.getState().setStreamMetric('infrastructure', {
        status: 'error',
        speed: 'failed',
      });
    }
  }, []);

  // Setup datasource and camera listener
  useEffect(() => {
    if (!viewer) return;

    const ds = new Cesium.CustomDataSource('infrastructure');
    viewer.dataSources.add(ds);
    dsRef.current = ds;

    // Debounced camera move handler
    const onCameraChange = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchForViewport(viewer), 2000);
    };

    viewer.camera.changed.addEventListener(onCameraChange);
    // Also trigger initial fetch
    onCameraChange();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (viewer && !viewer.isDestroyed()) {
        viewer.camera.changed.removeEventListener(onCameraChange);
        viewer.dataSources.remove(ds);
      }
      dsRef.current = null;
      lastBboxRef.current = '';
    };
  }, [viewer, fetchForViewport]);

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
      const show = subtypeVisibility[`infrastructure:${sub}`] !== false;
      e.show = show;
    });
    useTimelineStore.getState().setSubtypeCounts('infrastructure', counts);
  }, [subtypeVisibility, isVisible]);
}
