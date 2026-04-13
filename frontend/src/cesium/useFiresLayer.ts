import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { FIRE_DOT_HIGH, FIRE_DOT_MEDIUM, FIRE_DOT_LOW } from '../icons/map-icons';

// NASA FIRMS active fire hotspots rendered via BillboardCollection with
// HeightReference.CLAMP_TO_GROUND. Billboards latch onto the Google 3D
// Tileset / globe terrain at render time (Globe.tsx enables
// `enableCollision` on the tileset for this to work).
//
// ### Viewport cull strategy
//
// Cull uses `billboard.show = false/true`, NOT add/remove. Why:
//
// The earlier iteration tried a remove-and-re-add rebuild on every
// camera move, reasoning that CLAMP_TO_GROUND height listeners are
// expensive and pruning the collection to the visible subset would
// reduce listener churn. In practice the rebuild itself is O(N) with
// a huge per-billboard constant — each `collection.add()` on a clamped
// billboard registers a fresh HeightReferenceListener, and
// `collection.removeAll()` disposes the previous ones. On a 60k FIRMS
// payload this stalled the main thread for several hundred milliseconds
// on every settled pan at global zoom, which froze the UI and made the
// earth fail to render.
//
// The cheaper approach is a simple `show` flag mutation: O(N) tight
// loop with no listener churn, no GPU buffer rebuild. Cesium's internal
// clamping pipeline already honours `billboard.show` when deciding
// whether to run its per-tile update work, so hiding most billboards
// at close zoom still cuts the per-tile clamp cost without paying the
// rebuild tax.
//
// Tradeoff: every billboard retains its HeightReferenceListener for
// the whole viewer lifetime. Cesium handles tens of thousands of
// listeners fine at global zoom where tile updates are rare; at close
// zoom tile streaming is busier but most fires are hidden by the
// viewport cull so only the visible subset pays the update cost.

// Metadata for picking — stores fire info per billboard ID.
export interface FireMeta { lat: number; lng: number; frp: number; brightness: number; confidence: string; subtype: 'high' | 'medium' | 'low'; daynight: string; acqTime: string; fireType: number; }
export const fireMetaMap = new Map<string, FireMeta>();

function frpSubtype(frp: number): 'high' | 'medium' | 'low' {
    if (frp > 100) return 'high';
    if (frp > 30) return 'medium';
    return 'low';
}

function dotForSubtype(sub: 'high' | 'medium' | 'low'): string {
    return sub === 'high' ? FIRE_DOT_HIGH : sub === 'medium' ? FIRE_DOT_MEDIUM : FIRE_DOT_LOW;
}

// Pixel size of the dot billboard. FRP-scaled so high-energy fires read
// bigger on the map, but clamped so a single megaflare doesn't eat the
// screen at close zoom.
function scaleForFrp(frp: number): number {
    return Math.max(0.25, Math.min(0.85, 0.25 + Math.log2(Math.max(1, frp)) * 0.07));
}

// Debounce on camera.moveEnd so a continuous pan gesture fires ONE cull
// at the end instead of dozens during the motion. 150 ms is short enough
// to feel instant after a settle, long enough to coalesce Cesium's own
// multi-moveEnd burst when tile loading nudges the camera.
const CAMERA_CULL_DEBOUNCE_MS = 150;

// How many billboards to add to the collection per synchronous chunk
// before yielding to the browser. Each CLAMP_TO_GROUND billboard.add
// registers a HeightReferenceListener, so 60k fires in a single pass
// is a multi-second main-thread stall that freezes pointer events.
// Chunking to ~1000 per ~1 frame keeps interaction smooth while the
// layer populates incrementally.
const FIRES_CHUNK_SIZE = 1000;

export function useFiresLayer(viewer: Cesium.Viewer | null) {
    // sources.fires → whether we fetch FIRMS data.
    // visibility.fires → whether the rendered billboards are shown.
    const isSourceOn = useTimelineStore(s => s.sources.fires);
    const isVisible = useTimelineStore(s => s.visibility.fires);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const collectionRef = useRef<Cesium.BillboardCollection | null>(null);
    // Shared cull function so both the fetch success path and the
    // subtype visibility effect can re-run it without re-deriving the
    // viewport rect independently.
    const cullRef = useRef<(() => void) | null>(null);

    // ---- Effect 1: scene lifetime ----
    useEffect(() => {
        if (!viewer) return;

        const collection = new Cesium.BillboardCollection({ scene: viewer.scene });
        viewer.scene.primitives.add(collection);
        collectionRef.current = collection;

        /**
         * Walk every billboard in the collection and decide whether it
         * should be visible under the combined (viewport × subtype)
         * filter. Writes to `billboard.show`; never calls add/remove so
         * the GPU buffer stays stable and HeightReferenceListener churn
         * stays zero.
         *
         * Perf: ~60k fires, tight loop of Map.get + two comparisons +
         * one assignment per billboard. Measured at ~5–10 ms on a
         * mid-range laptop, well under a frame budget. The old
         * remove-and-re-add approach was 20–50× slower.
         */
        const cullForViewport = () => {
            const col = collectionRef.current;
            if (!col || viewer.isDestroyed()) return;

            const subVis = useTimelineStore.getState().subtypeVisibility;
            const isSubShown = (sub: string) =>
                subVis[`fires:${sub}`] !== false;

            const rect = viewer.camera.computeViewRectangle();
            if (!rect) {
                // Off-globe / oblique view: fall back to subtype gating.
                // Happens when the camera points out into space.
                for (let i = 0; i < col.length; i++) {
                    const bb = col.get(i);
                    const meta = fireMetaMap.get(bb.id as string);
                    bb.show = !!meta && isSubShown(meta.subtype);
                }
                return;
            }

            const south = Cesium.Math.toDegrees(rect.south);
            const north = Cesium.Math.toDegrees(rect.north);
            const west = Cesium.Math.toDegrees(rect.west);
            const east = Cesium.Math.toDegrees(rect.east);
            const crossAM = east < west;

            for (let i = 0; i < col.length; i++) {
                const bb = col.get(i);
                const meta = fireMetaMap.get(bb.id as string);
                if (!meta) {
                    bb.show = false;
                    continue;
                }
                if (!isSubShown(meta.subtype)) {
                    bb.show = false;
                    continue;
                }
                const inLat = meta.lat >= south && meta.lat <= north;
                const inLng = crossAM
                    ? meta.lng >= west || meta.lng <= east
                    : meta.lng >= west && meta.lng <= east;
                bb.show = inLat && inLng;
            }
        };

        cullRef.current = cullForViewport;

        // Debounced camera cull — coalesces bursts of moveEnd events.
        let cullTimer: ReturnType<typeof setTimeout> | null = null;
        const onCameraMoveEnd = () => {
            if (cullTimer) clearTimeout(cullTimer);
            cullTimer = setTimeout(() => {
                cullTimer = null;
                cullForViewport();
            }, CAMERA_CULL_DEBOUNCE_MS);
        };
        const removeMoveEnd = viewer.camera.moveEnd.addEventListener(onCameraMoveEnd);

        return () => {
            if (cullTimer) clearTimeout(cullTimer);
            removeMoveEnd();
            cullRef.current = null;
            if (!viewer.isDestroyed()) {
                viewer.scene.primitives.remove(collection);
            }
            collectionRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: fetch lifetime ----
    useEffect(() => {
        if (!viewer || !isSourceOn) return;

        let active = true;

        async function fetchFires() {
            const collection = collectionRef.current;
            if (!collection) return;
            try {
                const res = await axios.get(`${API_URL}/api/fires`);
                if (!active) return;

                // Always clear + reset counts, even on empty payload, so
                // stale fires from the previous poll don't linger on the
                // globe when the backend returns [].
                collection.removeAll();
                fireMetaMap.clear();
                const counts: Record<string, number> = { high: 0, medium: 0, low: 0 };

                if (!res.data?.length) {
                    useTimelineStore.getState().setSubtypeCounts('fires' as any, counts);
                    useTimelineStore.getState().setStreamMetric('fires', { count: 0, status: 'streaming' });
                    return;
                }

                // Chunked build — FIRMS often returns 60k+ hotspots and
                // each CLAMP_TO_GROUND billboard.add registers a fresh
                // height listener. Running the whole set in one sync
                // pass stalls the main thread long enough to freeze
                // pointer events, so we yield to the browser every
                // FIRES_CHUNK_SIZE records. Result: user sees fires
                // stream in incrementally while drag/zoom/click stay
                // responsive.
                const records: any[] = res.data;
                for (let i = 0; i < records.length; i++) {
                    if (!active) return;
                    const f = records[i];
                    const frp = f.frp || 1;
                    const fireId = f.id || `fire-${f.lat}-${f.lng}`;
                    const subtype = frpSubtype(frp);

                    collection.add({
                        // Real ground-level position. CLAMP_TO_GROUND will
                        // project this onto terrain/3D-tile surface at
                        // render time, so the literal 0 m is fine.
                        position: Cesium.Cartesian3.fromDegrees(f.lng, f.lat, 0),
                        image: dotForSubtype(subtype),
                        scale: scaleForFrp(frp),
                        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        id: fireId,
                    });
                    fireMetaMap.set(fireId, {
                        lat: f.lat, lng: f.lng,
                        frp, brightness: f.brightness || 0,
                        confidence: f.confidence || '',
                        subtype,
                        daynight: f.daynight || '',
                        acqTime: f.acqTime || '',
                        fireType: f.fireType ?? 0,
                    });
                    counts[subtype]++;

                    // Yield once per chunk so the browser can process
                    // input events (click, drag, wheel) instead of
                    // waiting for the whole 60k loop to drain.
                    if ((i + 1) % FIRES_CHUNK_SIZE === 0 && i + 1 < records.length) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        if (!active) return;
                        // Cesium collection may have been destroyed during
                        // the yield (viewer unmount / source-off clear).
                        if (collectionRef.current !== collection) return;
                    }
                }

                useTimelineStore.getState().setStreamMetric('fires', {
                    count: collection.length,
                    status: 'streaming',
                });
                useTimelineStore.getState().setSubtypeCounts('fires' as any, counts);

                // Apply current viewport + subtype cull to the freshly
                // populated collection so offscreen fires start hidden.
                cullRef.current?.();

                // Respect Legend visibility freshly.
                collection.show =
                    useTimelineStore.getState().sources.fires &&
                    useTimelineStore.getState().visibility.fires;

                console.log(`[Fires] Rendered ${collection.length} hotspots via BillboardCollection (chunked ${FIRES_CHUNK_SIZE}/batch)`);
            } catch (err: any) {
                console.warn('[Fires] Fetch failed:', err?.message || err);
                useTimelineStore.getState().setStreamMetric('fires', { status: 'error' });
            }
        }

        fetchFires();
        const interval = setInterval(fetchFires, 30 * 60_000);

        return () => {
            active = false;
            clearInterval(interval);
            // Do NOT touch the collection — Effect 1 owns its lifetime so
            // frozen fire data survives source-off.
        };
    }, [viewer, isSourceOn]);

    // ---- Effect 3: layer visibility toggle ----
    // Effective visibility = sources AND visibility. Source off hides
    // the collection AND stops the fetch loop (Effect 2); visibility
    // off only hides but lets the fetch continue.
    useEffect(() => {
        if (collectionRef.current) collectionRef.current.show = isSourceOn && isVisible;
    }, [isSourceOn, isVisible]);

    // ---- Effect 4: per-subtype visibility ----
    // Delegates to the cull so subtype + viewport gates stay consistent.
    useEffect(() => {
        cullRef.current?.();
    }, [subtypeVisibility]);

    // ---- Effect 5: source-off scene clear ----
    // When the user turns the fires source off we drop every billboard
    // so the globe is empty of hotspots. The next source-on re-runs
    // Effect 2 and the next fetch repopulates with fresh data. Legend
    // subtype counts are wiped too so the right-panel row doesn't keep
    // showing pre-toggle numbers against an empty scene.
    useEffect(() => {
        if (isSourceOn) return;
        const col = collectionRef.current;
        if (col) col.removeAll();
        fireMetaMap.clear();
        useTimelineStore.getState().setSubtypeCounts('fires' as any, {});
        useTimelineStore.getState().setStreamMetric('fires', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
