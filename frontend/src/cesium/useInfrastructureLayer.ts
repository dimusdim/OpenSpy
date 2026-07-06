import { useEffect, useRef, useCallback } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import type { PowerGridEffectPreset } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { perfLog } from '../lib/perf-log';
import { getIconOpacity, getIconScale, getInfraIcon } from '../icons/map-icons';
import { getViewerAltitudeMeters } from './position-utils';

const POWER_LINE_COLOR = Cesium.Color.ORANGE.withAlpha(0.85);

function createPowerLineAppearance(effect: PowerGridEffectPreset): Cesium.Appearance {
  if (effect === 'off') {
    return new Cesium.PolylineColorAppearance();
  }

  const palette =
    effect === 'electric-flow'
      ? {
          base: Cesium.Color.fromCssColorString('#0d3b66').withAlpha(0.20),
          core: Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.95),
          hot: Cesium.Color.fromCssColorString('#e0f2fe').withAlpha(1.00),
          speed: 0.030,
          repeat: 18.0,
        }
      : effect === 'ember-pulse'
        ? {
            base: Cesium.Color.fromCssColorString('#5a2500').withAlpha(0.24),
            core: Cesium.Color.fromCssColorString('#fb923c').withAlpha(0.92),
            hot: Cesium.Color.fromCssColorString('#fde68a').withAlpha(1.00),
            speed: 0.022,
            repeat: 12.0,
          }
        : {
            base: Cesium.Color.fromCssColorString('#02111f').withAlpha(0.24),
            core: Cesium.Color.fromCssColorString('#60a5fa').withAlpha(0.96),
            hot: Cesium.Color.fromCssColorString('#ffffff').withAlpha(1.00),
            speed: 0.050,
            repeat: 22.0,
          };

  const material = new Cesium.Material({
    translucent: true,
    fabric: {
      type: `OpenSpyPowerLine${effect.replace(/-/g, '')}`,
      uniforms: {
        baseColor: palette.base,
        coreColor: palette.core,
        hotColor: palette.hot,
        speed: palette.speed,
        repeat: palette.repeat,
      },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput)
        {
          czm_material material = czm_getDefaultMaterial(materialInput);
          float phase = fract(materialInput.st.s * repeat - czm_frameNumber * speed);
          float current = 1.0 - smoothstep(0.055, 0.18, abs(phase - 0.5));
          float spark = 1.0 - smoothstep(0.010, 0.070, abs(fract(materialInput.st.s * repeat * 2.7 + czm_frameNumber * speed * 1.6) - 0.5));
          float side = 1.0 - smoothstep(0.30, 0.50, abs(materialInput.st.t - 0.5));
          float pulse = 0.62 + 0.38 * sin(czm_frameNumber * speed * 7.0 + materialInput.st.s * 20.0);
          vec3 glow = mix(baseColor.rgb, coreColor.rgb, current * side);
          glow = mix(glow, hotColor.rgb, spark * current * side * 0.65);
          material.diffuse = glow;
          material.alpha = max(baseColor.a, coreColor.a * current * side * pulse);
          return material;
        }
      `,
    },
  });

  return new Cesium.PolylineMaterialAppearance({
    material,
    translucent: true,
  } as any);
}

// ---------------------------------------------------------------------------
// Metadata + exports for picking/HUD
// ---------------------------------------------------------------------------

export interface InfraMeta {
  id: string;
  name: string;
  // Anchor lat/lng for HUD positioning + flyTo.
  lat: number;
  lng: number;
  // Subtype drives legend grouping + per-subtype visibility filter.
  subtype:
    | 'power_plant'
    | 'refinery'
    | 'desalination'
    | 'military'
    | 'power_substation'
    | 'power_line'
    | 'communication_tower'
    | 'aerodrome'
    | 'dam';
  layer: 'Infrastructure';
  source: 'OpenStreetMap' | 'Overture Maps';
  description: string;
}

// logicalId -> meta. Stable across tiles (MEDIUM 6 fix): a single logical
// infrastructure object keeps one meta record regardless of how many
// 2°×2° tiles currently reference it. A refcount (below) controls when
// the meta + aggregate count contribution get removed.
export const infraMetaMap = new Map<string, InfraMeta>();

// Per-tile billboard/line ids are unique across tiles — they embed the
// tile key so two neighbouring tiles referencing the same logical id
// each own their own GeometryInstance / Billboard record. Globe.tsx
// picking strips the tile prefix via infraInstanceToLogical to resolve
// back to the underlying logical object.
export const infraInstanceToLogical = new Map<string, string>();

// Refcount per logical id. Incremented on every tile that loads the
// object, decremented on tile evict. When a count drops to zero the
// logical meta (and its contribution to the aggregate counts) is
// removed. Handles the previous bug where a single-logical object in
// overlapping tiles would vanish from the metaMap the first time any
// tile containing it got evicted.
const infraLogicalRefCount = new Map<string, number>();

/**
 * Resolve a per-tile billboard / polyline instance id back to the logical
 * infrastructure object id. Safe on plain logical ids (returns them
 * unchanged). Used by Globe.tsx picking.
 */
export function infraStripInstanceId(instanceId: string): string {
  return infraInstanceToLogical.get(instanceId) ?? instanceId;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

// LRU cap on loaded tiles. Each tile is a 2°×2° cell (= 4 sq.deg,
// matching the backend MAX_BBOX_AREA_SQDEG constraint). Each fully
// populated tile owns up to 3 scene primitives (mainBillboards,
// powerBillboards, powerLinePrimitive) so this cap × 3 is the worst-
// case infrastructure primitive count in the scene. We sit at 80 so
// the worst-case is ~240 primitives — a level Cesium's frustum culler
// handles smoothly during globe rotation. The previous 200 cap allowed
// ~600 primitives which visibly dragged draw-call batching once the
// user had panned across a couple of continents.
const MAX_LOADED_TILES = 80;

// 2°×2° tile size. Derived from backend's MAX_BBOX_AREA_SQDEG = 4 (the
// Overpass-proxy limit) — 2° × 2° = 4 sq.deg, the largest single-call
// bbox the backend will accept. Keeping this symbolic avoids drifting
// apart if backend ever raises the limit.
const TILE_DEG = 2;

// Max concurrent /api/infrastructure + /api/power-infra requests. Overpass
// rate-limits at ~2 rps per IP so we keep this conservative. Note each
// tile issues TWO parallel HTTP calls (main + power), so 4 tiles in flight
// = up to 8 concurrent HTTP requests.
const FETCH_CONCURRENCY = 4;

// Hard cap on tiles kicked off per viewport change. Prevents an overview
// zoom from flooding the queue with thousands of cells — we always
// prioritise closest-to-centre and wait for the user to pan for the rest.
//
// Lowered from 80 to 20 so each rotation only queues up 20 new tile
// fetches instead of 80. That matters because every fetched tile adds
// 2-3 fresh scene primitives, and at 80 tiles per rotation Cesium's
// primitive churn (add/remove on LRU evict, frustum culling reset)
// dominates the frame budget during continuous rotation. At 20 per
// rotation + 80 MAX_LOADED_TILES, the user still sees infrastructure
// streaming in visibly, just slower to saturate.
const MAX_TILES_PER_VIEWPORT = 20;

// Unified HTTP timeout for the two Overpass-backed endpoints. The backend
// Overpass client itself allows up to ~65s on cold cache, so the frontend
// must not abort earlier — otherwise every cold-cache tile would surface
// as "failed" even though the backend was still working.
const INFRA_FETCH_TIMEOUT_MS = 70_000;

// Camera altitude above which infrastructure icons are hidden.
// Below this altitude, tiles load and billboards appear.
const INFRA_ALTITUDE_CUTOFF_KM = 200;

const INFRA_SUBTYPES: InfraMeta['subtype'][] = [
  'power_plant',
  'refinery',
  'desalination',
  'military',
  'power_substation',
  'power_line',
  'communication_tower',
  'aerodrome',
  'dam',
];

function emptyCounts(): Record<string, number> {
  return INFRA_SUBTYPES.reduce<Record<string, number>>((acc, sub) => {
    acc[sub] = 0;
    return acc;
  }, {});
}

/**
 * Per-tile render state. One BillboardCollection per source so a partial
 * failure doesn't block the other source's primitives. Eviction drops all
 * three refs from the scene plus every per-tile instance id from
 * infraInstanceToLogical; the logical meta survives until its refcount
 * drops to zero.
 */
type TileState = {
  main: boolean;
  power: boolean;
  mainBillboards: Cesium.BillboardCollection | null;
  powerBillboards: Cesium.BillboardCollection | null;
  powerLinePrimitive: Cesium.GroundPolylinePrimitive | null;
  // Per-tile instance ids this tile owns (tileKey-prefixed). These map
  // 1:1 to Cesium billboards / polyline instances inside the tile's own
  // primitives.
  instanceIds: string[];
  // Count of NEW logical ids this tile contributed to the aggregate
  // count — used to undo the contribution on eviction without double-
  // counting across overlapping tiles.
  newLogicalsBySubtype: Record<string, number>;
};

// Build the deterministic key for a 2°×2° tile, anchored at the floor
// of its SW corner. Lat/lng are snapped to multiples of TILE_DEG so every
// camera position that overlaps the cell produces the same key and the
// cache hits instead of refetching.
function cellKey(south: number, west: number): string {
  return `${south},${west}`;
}

/**
 * Wrap-aware delta between two longitudes, in degrees. Produces the
 * smaller of |a-b| and 360-|a-b|, so a camera at lng +179 is "closer"
 * to a tile centred at lng -179 than to one at lng 140, even though the
 * naive |a-b| would say otherwise. Used by the priority sort so the
 * cells nearest to the camera over the antimeridian load first.
 */
function wrapLngDelta(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 360 - d);
}

// Enumerate all 2°×2° cells that intersect a viewport rectangle. Handles
// antimeridian crossings (east < west) by splitting into two sub-rects.
// Returns raw [s, w, n, e] quadruples clamped to the global WGS-84 range.
function cellsForViewport(
  south: number,
  west: number,
  north: number,
  east: number
): Array<[number, number, number, number]> {
  if (east < west) {
    // Viewport crosses the antimeridian (e.g. Pacific camera). Split
    // into [west .. 180] and [-180 .. east] and recurse.
    return [
      ...cellsForViewport(south, west, north, 180),
      ...cellsForViewport(south, -180, north, east),
    ];
  }
  if (east <= west || north <= south) return [];

  const clampedS = Math.max(-90, Math.floor(south / TILE_DEG) * TILE_DEG);
  const clampedW = Math.max(-180, Math.floor(west / TILE_DEG) * TILE_DEG);
  const clampedN = Math.min(90, Math.ceil(north / TILE_DEG) * TILE_DEG);
  const clampedE = Math.min(180, Math.ceil(east / TILE_DEG) * TILE_DEG);

  const out: Array<[number, number, number, number]> = [];
  for (let s = clampedS; s < clampedN; s += TILE_DEG) {
    for (let w = clampedW; w < clampedE; w += TILE_DEG) {
      const n = Math.min(90, s + TILE_DEG);
      const e = Math.min(180, w + TILE_DEG);
      if (s >= 90 || w >= 180) continue;
      out.push([s, w, n, e]);
    }
  }
  return out;
}

export function useInfrastructureLayer(viewer: Cesium.Viewer | null) {
  // sources.infrastructure = camera-driven viewport fetches to Overpass.
  // visibility.infrastructure = render the loaded tile billboards/lines.
  const isSourceOn = useTimelineStore((s) => s.sources.infrastructure);
  const isVisible = useTimelineStore((s) => s.visibility.infrastructure);
  const mode = useTimelineStore((s) => s.mode);
  const subtypeVisibility = useTimelineStore((s) => s.subtypeVisibility);
  const isolatedEntityId = useTimelineStore((s) => s.isolatedEntityId);
  const powerGridEffect = useTimelineStore((s) => s.powerGridEffect);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tilesRef = useRef<Map<string, TileState>>(new Map());
  // Cells with fetches currently in flight.
  const inFlightCellsRef = useRef<Set<string>>(new Set());
  // Generation counter. Bumped on source-off so any in-flight tile
  // fetches that are mid-Promise.allSettled bail at the gen check
  // instead of writing stale primitives to a cleared tile cache.
  const genRef = useRef(0);
  // Aggregate counts across all loaded tiles — updated only when new
  // LOGICAL objects arrive (first reference) or their refcount drops to
  // zero (last reference). Avoids over-counting objects that live in
  // multiple tiles.
  const aggregateCountsRef = useRef<Record<string, number>>(emptyCounts());
  // Ready-gate polling timers for power_line primitives. Tracked so unmount
  // can cancel pending callbacks before the primitives get removed.
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // Active flag for in-flight fetches — flipped false on viewer unmount
  // so late responses don't touch a destroyed scene.
  const activeRef = useRef(false);
  const fetchTileRef = useRef<((v: Cesium.Viewer, south: number, west: number, north: number, east: number) => Promise<void>) | null>(null);

  // Apply current subtype visibility to all billboards + power lines in a
  // tile. Called on tile load (with current store state) and on subtype
  // visibility change (over every loaded tile).
  const applyTileVisibility = useCallback(
    (tile: TileState, vis: Record<string, boolean>, soloId: string | null = null) => {
      const isSubShown = (sub: string) => vis[`infrastructure:${sub}`] !== false;

      const applyBillboard = (bb: Cesium.Billboard) => {
        const logicalId = infraInstanceToLogical.get(bb.id as string) ?? (bb.id as string);
        const meta = infraMetaMap.get(logicalId);
        if (!meta) return;
        const subtypeOk = isSubShown(meta.subtype);
        const soloOk = !soloId || soloId === logicalId;
        bb.show = subtypeOk && soloOk;
      };
      if (tile.mainBillboards) {
        for (let i = 0; i < tile.mainBillboards.length; i++) {
          applyBillboard(tile.mainBillboards.get(i));
        }
      }
      if (tile.powerBillboards) {
        for (let i = 0; i < tile.powerBillboards.length; i++) {
          applyBillboard(tile.powerBillboards.get(i));
        }
      }

      // Power lines: all share subtype 'power_line'.
      if (tile.powerLinePrimitive && tile.powerLinePrimitive.ready) {
        const subtypeVisible = isSubShown('power_line');
        for (const instanceId of tile.instanceIds) {
          const logicalId = infraInstanceToLogical.get(instanceId) ?? instanceId;
          const meta = infraMetaMap.get(logicalId);
          if (meta?.subtype !== 'power_line') continue;
          const soloOk = !soloId || soloId === logicalId;
          const showValue = Cesium.ShowGeometryInstanceAttribute.toValue(subtypeVisible && soloOk);
          const attrs = tile.powerLinePrimitive.getGeometryInstanceAttributes(instanceId);
          if (attrs) (attrs as any).show = showValue;
        }
      }
    },
    []
  );

  // Evict a tile: drop primitives from scene, decrement refcounts, remove
  // logical meta entries only when refcount reaches zero, clear any
  // selection anchored on an evicted logical.
  const evictTile = useCallback(
    (v: Cesium.Viewer, bboxKey: string) => {
      const tile = tilesRef.current.get(bboxKey);
      if (!tile) return;

      const selectedId = useTimelineStore.getState().selectedEntityId;

      // Walk the tile's own instance ids, resolving each to its logical
      // counterpart. Decrement the refcount; when the last tile holding
      // a logical object goes away, drop the meta + subtract from
      // aggregate counts (but only by the "new logical" contribution of
      // THIS tile, not the count of instance ids, so overlapping tiles
      // stay consistent).
      for (const instanceId of tile.instanceIds) {
        const logicalId = infraInstanceToLogical.get(instanceId);
        infraInstanceToLogical.delete(instanceId);
        if (!logicalId) continue;
        const prev = infraLogicalRefCount.get(logicalId) ?? 0;
        const next = prev - 1;
        if (next <= 0) {
          infraLogicalRefCount.delete(logicalId);
          if (selectedId === logicalId) {
            useTimelineStore.getState().setSelectedEntityId(null);
          }
          infraMetaMap.delete(logicalId);
        } else {
          infraLogicalRefCount.set(logicalId, next);
        }
      }

      // Undo this tile's contribution to the aggregate counts using the
      // per-tile "new logicals" tally, which was recorded only for
      // logical ids that this tile was the first to load. Other tiles
      // that also reference the same logical do NOT have it in their
      // newLogicalsBySubtype, so they won't decrement it again on evict.
      for (const sub of INFRA_SUBTYPES) {
        aggregateCountsRef.current[sub] = Math.max(
          0,
          (aggregateCountsRef.current[sub] || 0) - (tile.newLogicalsBySubtype[sub] || 0)
        );
      }
      useTimelineStore.getState().setSubtypeCounts('infrastructure', {
        ...aggregateCountsRef.current,
      });

      if (!v.isDestroyed()) {
        if (tile.mainBillboards) v.scene.primitives.remove(tile.mainBillboards);
        if (tile.powerBillboards) v.scene.primitives.remove(tile.powerBillboards);
        if (tile.powerLinePrimitive) {
          v.scene.groundPrimitives.remove(tile.powerLinePrimitive);
        }
      }

      tilesRef.current.delete(bboxKey);
    },
    []
  );

  // Fetch and materialise a single 2°×2° tile.
  const fetchTile = useCallback(
    async (v: Cesium.Viewer, south: number, west: number, north: number, east: number) => {
      const key = cellKey(south, west);
      if (v.isDestroyed() || !activeRef.current) return;
      if (inFlightCellsRef.current.has(key)) return;

      // Capture the source-generation at fetch start. A source-off-clear
      // bumps genRef, so any late response arriving on the stale gen
      // bails before touching tilesRef / infraMetaMap / the scene.
      const myGen = genRef.current;

      const existing = tilesRef.current.get(key);
      const mainAlreadyLoaded = existing?.main === true;
      const powerAlreadyLoaded = existing?.power === true;
      if (existing && mainAlreadyLoaded && powerAlreadyLoaded) {
        // LRU touch — re-insert at end so eviction picks oldest correctly.
        tilesRef.current.delete(key);
        tilesRef.current.set(key, existing);
        return;
      }

      inFlightCellsRef.current.add(key);

      // Start from existing tile state (partial retry) or a fresh one.
      const tile: TileState = existing ?? {
        main: false,
        power: false,
        mainBillboards: null,
        powerBillboards: null,
        powerLinePrimitive: null,
        instanceIds: [],
        newLogicalsBySubtype: emptyCounts(),
      };

      const shouldAbort = () => {
        if (v.isDestroyed() || !activeRef.current) return true;
        if (myGen !== genRef.current) return true;
        if (!useTimelineStore.getState().sources.infrastructure) return true;
        return false;
      };

      const publishTileState = (schedulePowerReadyGate = false) => {
        tilesRef.current.delete(key);
        tilesRef.current.set(key, tile);

        applyTileVisibility(
          tile,
          useTimelineStore.getState().subtypeVisibility,
          useTimelineStore.getState().isolatedEntityId,
        );

        if (schedulePowerReadyGate && tile.powerLinePrimitive && !tile.powerLinePrimitive.ready) {
          const prim = tile.powerLinePrimitive;
          const waitReady = (firedTimerId?: ReturnType<typeof setTimeout>) => {
            if (firedTimerId !== undefined) {
              pendingTimersRef.current.delete(firedTimerId);
            }
            if (!tilesRef.current.has(key)) return;
            if (!prim.ready) {
              const t = setTimeout(() => waitReady(t), 50);
              pendingTimersRef.current.add(t);
              return;
            }
            applyTileVisibility(
              tile,
              useTimelineStore.getState().subtypeVisibility,
              useTimelineStore.getState().isolatedEntityId,
            );
          };
          waitReady();
        }

        useTimelineStore.getState().setStreamMetric('infrastructure', {
          count: infraMetaMap.size,
          status: tile.main || tile.power ? 'streaming' : 'error',
          speed: tile.main || tile.power ? '-' : 'failed',
        });
        useTimelineStore.getState().setSubtypeCounts('infrastructure', {
          ...aggregateCountsRef.current,
        });
        v.scene.requestRender();
      };

      /**
       * Register a logical infrastructure record as belonging to this
       * tile. Creates (or reuses) the meta entry, increments the
       * refcount, builds a per-tile instance id that embeds the tile key,
       * and records the contribution to the tile's newLogicals tally
       * ONLY when this is the first reference to the logical id anywhere
       * (so eviction later subtracts it exactly once).
       *
       * Returns the per-tile instance id to be used as the Cesium
       * primitive id for this record.
       */
      const registerLogical = (
        logicalId: string,
        meta: InfraMeta
      ): string => {
        const prevRef = infraLogicalRefCount.get(logicalId) ?? 0;
        const isNewLogical = prevRef === 0;
        infraLogicalRefCount.set(logicalId, prevRef + 1);
        if (isNewLogical) {
          infraMetaMap.set(logicalId, meta);
          aggregateCountsRef.current[meta.subtype] =
            (aggregateCountsRef.current[meta.subtype] || 0) + 1;
          tile.newLogicalsBySubtype[meta.subtype] =
            (tile.newLogicalsBySubtype[meta.subtype] || 0) + 1;
        }
        const instanceId = `${key}:${logicalId}`;
        infraInstanceToLogical.set(instanceId, logicalId);
        tile.instanceIds.push(instanceId);
        return instanceId;
      };

      // Both endpoints use the OpenSpy bbox contract:
      // west,south,east,north.
      const tMain0 = performance.now();
      const tPower0 = performance.now();
      const mainReq = mainAlreadyLoaded
        ? Promise.resolve<any>(null)
        : axios.get(
            `${API_URL}/api/infrastructure?bbox=${west},${south},${east},${north}`,
            { timeout: INFRA_FETCH_TIMEOUT_MS }
          ).then((r) => { perfLog('infra.main_fetch', { ms: Math.round(performance.now() - tMain0), records: (r.data?.data || r.data || []).length, timedOut: r.data?.overpassTimedOut === true, bbox: [west, south, east, north] }); return r; });
      const powerReq = powerAlreadyLoaded
        ? Promise.resolve<any>(null)
        : axios.get(
            `${API_URL}/api/power-infra?bbox=${west},${south},${east},${north}`,
            { timeout: INFRA_FETCH_TIMEOUT_MS }
          ).then((r) => { perfLog('infra.power_fetch', { ms: Math.round(performance.now() - tPower0), records: (r.data?.data || r.data || []).length, timedOut: r.data?.overpassTimedOut === true, bbox: [west, south, east, north] }); return r; });

      // --- Source 1: /api/infrastructure (plants/refineries/military) ----
      const mainResult = await Promise.allSettled([mainReq]).then((results) => results[0]);
      if (shouldAbort()) {
        inFlightCellsRef.current.delete(key);
        return;
      }
      if (!mainAlreadyLoaded) {
        if (mainResult.status === 'fulfilled' && mainResult.value) {
          try {
            const mainBody = mainResult.value.data ?? {};
            const records: any[] = Array.isArray(mainBody) ? mainBody : (mainBody.data ?? []);
            const mainOverpassTimedOut: boolean = mainBody.overpassTimedOut === true;
            if (records.length > 0) {
              const collection = new Cesium.BillboardCollection({
                scene: v.scene,
                blendOption: Cesium.BlendOption.TRANSLUCENT,
              });
              for (let ri = 0; ri < records.length; ri++) {
                const rec = records[ri];
                const subtype = (rec.type || 'military') as InfraMeta['subtype'];
                const isOverture = typeof rec.id === 'string' && rec.id.startsWith('overture-');
                const meta: InfraMeta = {
                  id: rec.id,
                  name: rec.name || rec.type,
                  lat: rec.lat,
                  lng: rec.lng,
                  subtype,
                  layer: 'Infrastructure',
                  source: isOverture ? 'Overture Maps' : 'OpenStreetMap',
                  description: rec.name || rec.type,
                };
                const instanceId = registerLogical(rec.id, meta);
                collection.add({
                  position: Cesium.Cartesian3.fromDegrees(rec.lng, rec.lat, 0),
                  image: getInfraIcon(subtype),
                  scale: getIconScale('infrastructure', subtype, 0.9),
                  color: Cesium.Color.WHITE.withAlpha(getIconOpacity('infrastructure', subtype)),
                  id: instanceId,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                });

              }
              collection.show = (useTimelineStore.getState().sources.infrastructure && useTimelineStore.getState().visibility.infrastructure);
              v.scene.primitives.add(collection);
              tile.mainBillboards = collection;
            }
            // Only mark as "done" if Overpass actually responded. When
            // overpass timed out AND we got zero records, skip marking
            // so the tile will be refetched on next viewport change.
            if (!mainOverpassTimedOut || records.length > 0) {
              tile.main = true;
            }
          } catch (mainErr) {
            console.warn('[Infrastructure] main parse failed:', mainErr);
          }
        } else if (mainResult.status === 'rejected') {
          console.warn('[Infrastructure] /api/infrastructure failed (non-fatal):', mainResult.reason?.message || mainResult.reason);
        }
      }
      publishTileState(false);

      // --- Source 2: /api/power-infra (substations/plants/power lines) ---
      const powerResult = await Promise.allSettled([powerReq]).then((results) => results[0]);
      if (shouldAbort()) {
        inFlightCellsRef.current.delete(key);
        return;
      }
      if (!powerAlreadyLoaded) {
        if (powerResult.status === 'fulfilled' && powerResult.value) {
          try {
            const powerBody = powerResult.value.data ?? {};
            const powerRecords: any[] = Array.isArray(powerBody) ? powerBody : (powerBody.data ?? []);
            const powerOverpassTimedOut: boolean = powerBody.overpassTimedOut === true;
            const powerBillboardCollection = tile.powerBillboards
              ? null
              : new Cesium.BillboardCollection({
                  scene: v.scene,
                  blendOption: Cesium.BlendOption.TRANSLUCENT,
                });
            const powerLineInstances: Cesium.GeometryInstance[] = [];
            let hasPowerLineGeometry = false;

            for (let pri = 0; pri < powerRecords.length; pri++) {
              const rec = powerRecords[pri];
              if (
                rec.type === 'power_line' &&
                rec.coordinates &&
                rec.coordinates.length >= 2
              ) {
                hasPowerLineGeometry = true;
                if (tile.powerLinePrimitive) continue;
                // Backend sends coords as [lat, lng]. Flatten to lng,lat for Cesium.
                const degreesFlat: number[] = [];
                for (const pt of rec.coordinates as [number, number][]) {
                  degreesFlat.push(pt[1], pt[0]);
                }
                if (degreesFlat.length < 4) continue;

                const mid = rec.coordinates[Math.floor(rec.coordinates.length / 2)] as [number, number];

                const meta: InfraMeta = {
                  id: rec.id,
                  name: rec.name || 'Power line',
                  lat: mid[0],
                  lng: mid[1],
                  subtype: 'power_line',
                  layer: 'Infrastructure',
                  source: typeof rec.id === 'string' && rec.id.startsWith('overture-')
                    ? 'Overture Maps'
                    : 'OpenStreetMap',
                  description: `${rec.name || 'Power line'}${rec.voltage ? ' (' + rec.voltage + 'V)' : ''}`,
                };
                const instanceId = registerLogical(rec.id, meta);

                powerLineInstances.push(new Cesium.GeometryInstance({
                  geometry: new Cesium.GroundPolylineGeometry({
                    positions: Cesium.Cartesian3.fromDegreesArray(degreesFlat),
                    width: 4.0,
                  }),
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(POWER_LINE_COLOR),
                    show: new Cesium.ShowGeometryInstanceAttribute(true),
                  },
                  id: instanceId,
                }));
              } else if (rec.type === 'power_substation' || rec.type === 'power_plant') {
                if (!powerBillboardCollection) continue;
                const subtype = rec.type as InfraMeta['subtype'];
                const meta: InfraMeta = {
                  id: rec.id,
                  name: rec.name || subtype,
                  lat: rec.lat,
                  lng: rec.lng,
                  subtype,
                  layer: 'Infrastructure',
                  source: typeof rec.id === 'string' && rec.id.startsWith('overture-')
                    ? 'Overture Maps'
                    : 'OpenStreetMap',
                  description: `${rec.name || subtype}${rec.source ? ' (' + rec.source + ')' : ''}`,
                };
                const instanceId = registerLogical(rec.id, meta);
                powerBillboardCollection.add({
                  position: Cesium.Cartesian3.fromDegrees(rec.lng, rec.lat, 0),
                  image: subtype === 'power_substation' ? getInfraIcon('power_substation') : getInfraIcon('power_plant'),
                  scale: getIconScale('infrastructure', subtype === 'power_substation' ? 'power_substation' : 'power_plant', 0.85),
                  color: Cesium.Color.WHITE.withAlpha(getIconOpacity('infrastructure', subtype === 'power_substation' ? 'power_substation' : 'power_plant')),
                  id: instanceId,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                });
              }

            }

            if (powerBillboardCollection && powerBillboardCollection.length > 0) {
              powerBillboardCollection.show = (useTimelineStore.getState().sources.infrastructure && useTimelineStore.getState().visibility.infrastructure);
              v.scene.primitives.add(powerBillboardCollection);
              tile.powerBillboards = powerBillboardCollection;
            }

            if (powerLineInstances.length > 0) {
              const linePrim = new Cesium.GroundPolylinePrimitive({
                geometryInstances: powerLineInstances,
                appearance: createPowerLineAppearance(useTimelineStore.getState().powerGridEffect),
                releaseGeometryInstances: false,
              });
              linePrim.show = (useTimelineStore.getState().sources.infrastructure && useTimelineStore.getState().visibility.infrastructure);
              v.scene.groundPrimitives.add(linePrim);
              tile.powerLinePrimitive = linePrim;
            }
            // Only mark as complete once the line-capable source has
            // answered. Overture provides power point centroids, but power
            // lines still come from Overpass; if Overpass times out and the
            // response only has points, keep the tile retryable. The retry
            // path skips already-added point billboards and adds only lines.
            if (!powerOverpassTimedOut || hasPowerLineGeometry) {
              tile.power = true;
            } else {
              const retryTimer = setTimeout(() => {
                pendingTimersRef.current.delete(retryTimer);
                if (v.isDestroyed() || !activeRef.current) return;
                const current = tilesRef.current.get(key);
                if (!current || current.power) return;
                void fetchTileRef.current?.(v, south, west, north, east);
              }, 12_000);
              pendingTimersRef.current.add(retryTimer);
            }
          } catch (powerErr) {
            console.warn('[Infrastructure] power parse failed:', powerErr);
          }
        } else if (powerResult.status === 'rejected') {
          console.warn('[Infrastructure] /api/power-infra failed (non-fatal):', powerResult.reason?.message || powerResult.reason);
        }
      }

      inFlightCellsRef.current.delete(key);
      publishTileState(true);

      // LRU eviction. Skips in-flight cells so a tile that's mid-fetch
      // can't get dropped out from under itself.
      while (tilesRef.current.size > MAX_LOADED_TILES) {
        let oldestKey: string | undefined;
        const iter = tilesRef.current.keys();
        let step = iter.next();
        while (!step.done) {
          if (!inFlightCellsRef.current.has(step.value)) {
            oldestKey = step.value;
            break;
          }
          step = iter.next();
        }
        if (oldestKey === undefined) break;
        evictTile(v, oldestKey);
      }
    },
    [applyTileVisibility, evictTile]
  );
  fetchTileRef.current = fetchTile;

  // Camera-move callback: enumerate the 2°×2° cells that overlap the
  // current viewport, prioritise by proximity to the camera centre, cap
  // at MAX_TILES_PER_VIEWPORT, and dispatch fetches with a concurrency
  // limit.
  const fetchForViewport = useCallback(
    async (v: Cesium.Viewer) => {
      if (v.isDestroyed() || !activeRef.current) return;
      if (!useTimelineStore.getState().sources.infrastructure) return;

      // Altitude gate: at globe-scale zoom (>5000 km) the viewport
      // rectangle spans a continent or more, which at 2°×2° tile size
      // enumerates thousands of cells and queues hundreds of backend
      // fetches per rotation. Infrastructure is a detail-level layer —
      // individual plants/substations aren't legible at overview zoom
      // anyway — so above the gate we skip NEW fetches and keep
      // whatever's already in the tile cache visible. The user can
      // zoom in to see details; rotation at globe zoom stays responsive.
      const camHeightMeters = getViewerAltitudeMeters(v);
      if (camHeightMeters == null) return;
      const camHeightKm = camHeightMeters / 1000;
      if (camHeightKm > INFRA_ALTITUDE_CUTOFF_KM) {
        useTimelineStore.getState().setInfraViewportPct(-1);
        useTimelineStore.getState().setStreamMetric('infrastructure', {
          status: 'streaming',
          speed: 'zoom in',
        });
        return;
      }

      const rect = v.camera.computeViewRectangle();
      if (!rect) return;

      const south = Cesium.Math.toDegrees(rect.south);
      const west = Cesium.Math.toDegrees(rect.west);
      const north = Cesium.Math.toDegrees(rect.north);
      const east = Cesium.Math.toDegrees(rect.east);

      const cells = cellsForViewport(south, west, north, east);
      if (cells.length === 0) return;

      const camCarto = v.camera.positionCartographic;
      const camLat = Cesium.Math.toDegrees(camCarto.latitude);
      const camLng = Cesium.Math.toDegrees(camCarto.longitude);
      const withDist = cells.map(([s, w, n, e]) => {
        const cLat = (s + n) / 2;
        const cLng = (w + e) / 2;
        const dLat = cLat - camLat;
        const dLng = wrapLngDelta(cLng, camLng);
        return { s, w, n, e, d: dLat * dLat + dLng * dLng };
      });
      withDist.sort((a, b) => a.d - b.d);
      const capped = withDist.slice(0, MAX_TILES_PER_VIEWPORT);

      // Viewport progress: loaded / total tiles in view
      const totalViewport = capped.length;
      let loadedViewport = 0;
      const todo: typeof capped = [];
      for (const cell of capped) {
        const key = cellKey(cell.s, cell.w);
        const existing = tilesRef.current.get(key);
        if (existing && existing.main && existing.power) {
          loadedViewport++;
          tilesRef.current.delete(key);
          tilesRef.current.set(key, existing);
        } else if (!inFlightCellsRef.current.has(key)) {
          todo.push(cell);
        }
      }

      const pct = totalViewport > 0 ? Math.round((loadedViewport / totalViewport) * 100) : 100;
      useTimelineStore.getState().setInfraViewportPct(pct);

      if (todo.length === 0) return;

      useTimelineStore.getState().setStreamMetric('infrastructure', {
        status: 'connecting',
        speed: 'loading...',
      });

      // Bounded-concurrency dispatcher.
      let cursor = 0;
      const worker = async () => {
        while (true) {
          if (v.isDestroyed() || !activeRef.current) return;
          const idx = cursor++;
          if (idx >= todo.length) return;
          const cell = todo[idx];
          await fetchTile(v, cell.s, cell.w, cell.n, cell.e);
        }
      };
      const workers: Promise<void>[] = [];
      for (let i = 0; i < Math.min(FETCH_CONCURRENCY, todo.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
    },
    [fetchTile]
  );

  // ---- Effect 1: scene lifetime ----
  // Holds the tile LRU across source toggles. Cleanup only runs on viewer
  // unmount: we evict every loaded tile, clear all maps, and cancel
  // pending ready-gate polls.
  useEffect(() => {
    if (!viewer) return;
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      pendingTimersRef.current.forEach((t) => clearTimeout(t));
      pendingTimersRef.current.clear();
      if (!viewer.isDestroyed()) {
        const keys = Array.from(tilesRef.current.keys());
        for (const key of keys) evictTile(viewer, key);
      }
      tilesRef.current.clear();
      inFlightCellsRef.current.clear();
      aggregateCountsRef.current = emptyCounts();
      infraMetaMap.clear();
      infraInstanceToLogical.clear();
      infraLogicalRefCount.clear();
    };
  }, [viewer, evictTile]);

  // ---- Effect 2: camera listener + fetch lifetime ----
  // Attaches the moveEnd listener while the source is on. Cleanup clears
  // the listener + debounce, but does NOT evict tiles: previously loaded
  // data stays visible when the source flips off, and flipping it back
  // on reseeds the viewport against the existing LRU.
  useEffect(() => {
    if (!viewer || !isSourceOn || mode === 'playback') return;

    const v = viewer;
    // moveEnd fires once per settled camera pan/zoom — cleaner than
    // camera.changed which streams during the motion itself. Short
    // debounce (250 ms) to coalesce two moveEnd events fired back-to-back
    // when a user bumps the wheel twice in quick succession.
    const onCameraMoveEnd = () => {
      // Hide/show all infrastructure based on altitude
      const altMeters = getViewerAltitudeMeters(v);
      if (altMeters == null) return;
      const altKm = altMeters / 1000;
      const shouldShow = altKm <= INFRA_ALTITUDE_CUTOFF_KM
          && useTimelineStore.getState().sources.infrastructure
          && useTimelineStore.getState().visibility.infrastructure
          && useTimelineStore.getState().mode !== 'playback';
      tilesRef.current.forEach((tile) => {
        if (tile.mainBillboards) tile.mainBillboards.show = shouldShow;
        if (tile.powerBillboards) tile.powerBillboards.show = shouldShow;
        if (tile.powerLinePrimitive) tile.powerLinePrimitive.show = shouldShow;
      });

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchForViewport(v), 250);
    };

    v.camera.moveEnd.addEventListener(onCameraMoveEnd);
    // Keep a small defer so the globe reaches a stable first frame before
    // infrastructure kicks in, but don't artificially hide cached Overture
    // icons for almost a second after open.
    const INFRA_INITIAL_FETCH_DELAY_MS = 100;
    const initialFetchTimer = setTimeout(() => {
      if (v.isDestroyed() || !activeRef.current) return;
      if (!useTimelineStore.getState().sources.infrastructure) return;
      fetchForViewport(v);
    }, INFRA_INITIAL_FETCH_DELAY_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      clearTimeout(initialFetchTimer);
      if (!v.isDestroyed()) {
        v.camera.moveEnd.removeEventListener(onCameraMoveEnd);
      }
    };
  }, [viewer, isSourceOn, mode, fetchForViewport]);

  // ---- Effect 3: layer visibility toggle ----
  // Effective show = sources && visibility for every loaded tile.
  useEffect(() => {
    const show = mode !== 'playback' && isSourceOn && isVisible;
    tilesRef.current.forEach((tile) => {
      if (tile.mainBillboards) tile.mainBillboards.show = show;
      if (tile.powerBillboards) tile.powerBillboards.show = show;
      if (tile.powerLinePrimitive) tile.powerLinePrimitive.show = show;
    });
  }, [isSourceOn, isVisible, mode]);

  // ---- Effect 3a: animated power-line shader mode ----
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    tilesRef.current.forEach((tile) => {
      if (tile.powerLinePrimitive) {
        tile.powerLinePrimitive.appearance = createPowerLineAppearance(powerGridEffect);
      }
    });
    viewer.scene.requestRender();
  }, [viewer, powerGridEffect]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || powerGridEffect === 'off') return;

    // The animated power-line appearance advances with czm_frameNumber, so it
    // needs a periodic render nudge under requestRenderMode. 66ms (~15fps)
    // keeps the flow visible while halving the wasted work vs the old
    // 33ms/30fps loop, and the pulse pauses while the tab is hidden.
    const RENDER_PULSE_MS = 66;
    let interval: number | null = null;
    const tick = () => {
      if (!viewer.isDestroyed()) viewer.scene.requestRender();
    };
    const start = () => {
      if (interval === null) interval = window.setInterval(tick, RENDER_PULSE_MS);
    };
    const stop = () => {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const syncToVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') stop();
      else start();
    };
    syncToVisibility();
    document.addEventListener('visibilitychange', syncToVisibility);
    return () => {
      document.removeEventListener('visibilitychange', syncToVisibility);
      stop();
    };
  }, [viewer, powerGridEffect]);

  // ---- Effect 4: per-subtype visibility + Solo isolation ----
  useEffect(() => {
    tilesRef.current.forEach((tile) => {
      applyTileVisibility(tile, subtypeVisibility, isolatedEntityId);
    });
  }, [subtypeVisibility, isolatedEntityId, applyTileVisibility]);

  // ---- Effect 5: source-off scene clear ----
  // On source-off, evict every loaded tile + reset the in-memory maps
  // so the next source-on re-runs Effect 2 against an empty cache and
  // fetches fresh tiles for the current viewport. Matches the user's
  // deterministic pipeline expectation (source off = nothing visible,
  // source on = current data, no cached snapshot from before).
  //
  // Bumps `genRef` first so any in-flight fetchTile that's already past
  // Promise.allSettled bails at its gen check instead of writing stale
  // primitives into the just-cleared tile cache.
  useEffect(() => {
    if (isSourceOn) return;
    genRef.current++;
    if (!viewer || viewer.isDestroyed()) return;
    const keys = Array.from(tilesRef.current.keys());
    for (const key of keys) evictTile(viewer, key);
    tilesRef.current.clear();
    inFlightCellsRef.current.clear();
    aggregateCountsRef.current = emptyCounts();
    infraMetaMap.clear();
    infraInstanceToLogical.clear();
    infraLogicalRefCount.clear();
    useTimelineStore.getState().setSubtypeCounts('infrastructure', emptyCounts());
    useTimelineStore.getState().setStreamMetric('infrastructure', {
      count: 0,
      speed: '-',
    });
  }, [isSourceOn, viewer, evictTile]);
}
