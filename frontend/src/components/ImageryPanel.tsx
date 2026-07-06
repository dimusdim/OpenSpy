'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { Image as ImageIcon, Layers, Loader2, Search, SlidersHorizontal, X } from 'lucide-react';
import { API_URL } from '../lib/config';
import { clearOpenSpyImageryLayers, showOpenSpyImageryCompare, showOpenSpyImageryLayer } from '../lib/imageryOverlay';
import { useTimelineStore } from '../store/useTimelineStore';

type ImagerySource = 'nasa_gibs' | 'copernicus';

type ImageryScene = {
    scene_id?: string;
    provider?: string;
    source?: string;
    collection?: string;
    datetime?: string | null;
    date?: string;
    requested_layer?: string;
    layer_id?: string;
    cloud_cover?: number | null;
    bbox?: number[];
    bbox_order?: string;
    render_supported?: boolean;
    render_unsupported_reason?: string | null;
    render?: Record<string, unknown> | null;
    action_payloads?: {
        show_layer?: { payload: Record<string, unknown> };
        show_scene?: { payload: Record<string, unknown> };
    };
};

type TimelineSnapshot = {
    visibility: ReturnType<typeof useTimelineStore.getState>['visibility'];
    subtypeVisibility: ReturnType<typeof useTimelineStore.getState>['subtypeVisibility'];
    tileMode: ReturnType<typeof useTimelineStore.getState>['tileMode'];
    showTrajectories: boolean;
    activeFilter: ReturnType<typeof useTimelineStore.getState>['activeFilter'];
    activePreset: ReturnType<typeof useTimelineStore.getState>['activePreset'];
};

const MAX_IMAGERY_AOI_SPAN_DEG = 4.5;
const MAX_IMAGERY_AOI_AREA_DEG2 = 25;

// The last right-click seed nonce we searched. Module-scoped so it survives the
// panel unmount/remount that happens when the left dock is toggled — reopening
// the panel must not re-fire a search for a stale point.
let lastConsumedSeedNonce: number | null = null;

function clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function boundedBboxAround(lat: number, lng: number): [number, number, number, number] {
    const safeLat = clampNumber(lat, -85, 85);
    const safeLng = clampNumber(lng, -180, 180);
    const half = MAX_IMAGERY_AOI_SPAN_DEG / 2;
    return [
        clampNumber(safeLng - half, -180, 180),
        clampNumber(safeLat - half, -90, 90),
        clampNumber(safeLng + half, -180, 180),
        clampNumber(safeLat + half, -90, 90),
    ];
}

function getViewer(): Cesium.Viewer | null {
    if (typeof window === 'undefined') return null;
    return (window as Window & { viewerContext?: Cesium.Viewer }).viewerContext || null;
}

function currentViewBbox(): [number, number, number, number] | null {
    const viewer = getViewer();
    const rectangle = viewer?.camera?.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid);
    if (rectangle) {
        const west = clampNumber(Cesium.Math.toDegrees(rectangle.west), -180, 180);
        const south = clampNumber(Cesium.Math.toDegrees(rectangle.south), -90, 90);
        const east = clampNumber(Cesium.Math.toDegrees(rectangle.east), -180, 180);
        const north = clampNumber(Cesium.Math.toDegrees(rectangle.north), -90, 90);
        const latSpan = north - south;
        const lngSpan = east - west;
        const area = latSpan * lngSpan;
        if (latSpan > 0 && lngSpan > 0 && area > 0 && area <= MAX_IMAGERY_AOI_AREA_DEG2) {
            return [west, south, east, north];
        }
    }

    const canvas = viewer?.scene?.canvas;
    const ellipsoid = viewer?.scene?.globe?.ellipsoid;
    const screenCenter = canvas
        ? new Cesium.Cartesian2(
            Math.max(1, canvas.clientWidth || canvas.width || 1) / 2,
            Math.max(1, canvas.clientHeight || canvas.height || 1) / 2,
        )
        : null;
    const ground = screenCenter && ellipsoid ? viewer?.camera?.pickEllipsoid(screenCenter, ellipsoid) : null;
    const cartographic = ground && ellipsoid
        ? Cesium.Cartographic.fromCartesian(ground, ellipsoid)
        : viewer?.camera?.positionCartographic;
    if (!cartographic) return null;
    return boundedBboxAround(
        Cesium.Math.toDegrees(cartographic.latitude),
        Cesium.Math.toDegrees(cartographic.longitude),
    );
}

function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString();
}

type SortBy = 'date' | 'cloud' | 'resolution';

function sceneTimeValue(scene: ImageryScene): number {
    const time = new Date(scene.datetime || scene.date || 0).getTime();
    return Number.isFinite(time) ? time : 0;
}

function sceneCloudValue(scene: ImageryScene): number {
    return scene.cloud_cover == null ? Number.POSITIVE_INFINITY : Number(scene.cloud_cover);
}

function sceneResolutionValue(scene: ImageryScene): number {
    const raw = (scene as Record<string, unknown>).resolution
        ?? (scene as Record<string, unknown>).gsd
        ?? (scene as Record<string, unknown>).samp_res
        ?? (scene as Record<string, unknown>).sample_resolution;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : Number.POSITIVE_INFINITY;
}

// Sort a copy of the scenes for display. Date is the default (newest first);
// cloud (clearest first) and resolution (finest first) are also offered.
// Missing values sort to the bottom.
function sortScenes(scenes: ImageryScene[], sortBy: SortBy): ImageryScene[] {
    const copy = [...scenes];
    if (sortBy === 'cloud') {
        copy.sort((a, b) => sceneCloudValue(a) - sceneCloudValue(b));
    } else if (sortBy === 'resolution') {
        copy.sort((a, b) => sceneResolutionValue(a) - sceneResolutionValue(b));
    } else {
        copy.sort((a, b) => sceneTimeValue(b) - sceneTimeValue(a));
    }
    return copy;
}

function sceneLabel(scene: ImageryScene): string {
    const date = String(scene.datetime || scene.date || '').slice(0, 10) || 'latest';
    const provider = scene.provider || (scene.source === 'copernicus' ? 'Copernicus' : 'NASA GIBS');
    const cloud = scene.cloud_cover == null ? '' : ` · ${Math.round(Number(scene.cloud_cover))}% cloud`;
    const layer = scene.collection || scene.requested_layer || scene.layer_id || '';
    return `${provider} ${date}${layer ? ` · ${layer}` : ''}${cloud}`;
}

function sceneKey(scene: ImageryScene | null, index: number): string | null {
    if (!scene) return null;
    return scene.scene_id || `${scene.source || scene.provider || 'imagery'}:${scene.datetime || scene.date || 'latest'}:${index}`;
}

function sceneActionPayload(scene: ImageryScene, fallback: Record<string, unknown>): Record<string, unknown> {
    return scene.action_payloads?.show_scene?.payload
        || scene.action_payloads?.show_layer?.payload
        || {
            source: scene.source || fallback.source,
            scene,
            bbox: scene.bbox,
            bbox_order: scene.bbox_order,
            collection: scene.collection,
            layer: fallback.layer,
            opacity: fallback.opacity,
        };
}

function normalizeSceneBbox(raw: unknown, order?: string | null): [number, number, number, number] | null {
    const bbox = Array.isArray(raw) ? raw.map(Number) : null;
    if (!bbox || bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) return null;
    const normalizedOrder = String(order || 'west,south,east,north').toLowerCase();
    const [a, b, c, d] = bbox;
    return normalizedOrder.includes('south,west,north,east')
        ? [b, a, d, c]
        : [a, b, c, d];
}

function flyToImageryPayload(viewer: Cesium.Viewer, payload: Record<string, unknown>) {
    const scene = payload.scene && typeof payload.scene === 'object'
        ? payload.scene as Record<string, unknown>
        : null;
    const render = scene?.render && typeof scene.render === 'object'
        ? scene.render as Record<string, unknown>
        : null;
    const bbox = normalizeSceneBbox(
        payload.bbox || scene?.bbox || render?.bbox,
        String(payload.bbox_order || scene?.bbox_order || render?.bbox_order || 'west,south,east,north'),
    );
    if (!bbox) return;
    const [west, south, east, north] = bbox;
    viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
        duration: 0.8,
    });
}

function offsetIsoDate(value: string | undefined | null, days: number): string {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return isoDaysAgo(days);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString();
}

function copernicusCollectionForLayer(layer: string): string {
    return layer === 'radar_vv' ? 'sentinel-1-grd' : 'sentinel-2-l2a';
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

export function ImageryToggle({ onClick }: { onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            title="Fresh satellite imagery"
            className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-black/80 px-3 py-2 font-mono text-xs text-zinc-500 shadow-2xl backdrop-blur-xl transition-colors hover:border-zinc-700 hover:text-zinc-300"
        >
            <ImageIcon size={14} />
            <span>Imagery</span>
        </button>
    );
}

export function ImageryContextBadge() {
    const context = useTimelineStore((state) => state.activeImageryOverlay);
    const mode = useTimelineStore((state) => state.mode);
    const currentTime = useTimelineStore((state) => state.currentTime);
    if (!context) return null;

    const replayDate = currentTime?.toISOString?.().slice(0, 10) || 'unknown';
    const replayMismatch = mode === 'playback' && context.acquisitionLabel !== replayDate;

    return (
        <div className="rounded-md border border-cyan-900/70 bg-black/80 px-3 py-2 text-[11px] leading-relaxed text-zinc-400 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center gap-1.5 font-mono uppercase tracking-wider text-cyan-200">
                <ImageIcon size={13} />
                <span>Imagery context</span>
            </div>
            <div className="mt-1 truncate text-zinc-200" title={context.label}>
                {context.label}
            </div>
            <div className={replayMismatch ? 'mt-1 text-amber-200' : 'mt-1 text-zinc-500'}>
                {mode === 'playback'
                    ? `Replay time: ${replayDate}. Imagery stays at ${context.acquisitionLabel}.`
                    : `Imagery date: ${context.acquisitionLabel}. Replay-independent overlay.`}
            </div>
        </div>
    );
}

export default function ImageryPanel({ isOpen, onClose, embedded = false, seedPoint = null }: { isOpen: boolean; onClose: () => void; embedded?: boolean; seedPoint?: { lat: number; lng: number; nonce: number } | null }) {
    const tileMode = useTimelineStore((state) => state.tileMode);
    const setTileMode = useTimelineStore((state) => state.setTileMode);
    const [source, setSource] = useState<ImagerySource>('nasa_gibs');
    const [layer, setLayer] = useState('viirs_true_color');
    const [days, setDays] = useState(7);
    const [maxCloudCover, setMaxCloudCover] = useState(40);
    const [opacity, setOpacity] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [scenes, setScenes] = useState<ImageryScene[]>([]);
    const [sortBy, setSortBy] = useState<SortBy>('date');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [activeAction, setActiveAction] = useState<{ mode: 'single' | 'compare'; key: string } | null>(null);
    const focusRestoreRef = useRef<TimelineSnapshot | null>(null);
    const displayScenes = useMemo(() => sortScenes(scenes, sortBy), [scenes, sortBy]);
    const selectedScene = displayScenes[selectedIndex] || null;
    const selectedSceneKey = sceneKey(selectedScene, selectedIndex);
    const copernicusRadar = source === 'copernicus' && layer === 'radar_vv';
    const providerNote = useMemo(() => (
        source === 'copernicus'
            ? 'Sentinel search uses backend-owned credentials and cached bounded renders. Sentinel-1 radar works through clouds but is not a natural-color photo.'
            : 'NASA GIBS is public daily context imagery; no key is required.'
    ), [source]);

    useEffect(() => {
        setScenes([]);
        setSelectedIndex(0);
        setActiveAction(null);
        setError(null);
        setNotice(null);
    }, [source, layer]);

    // Re-selecting the top item keeps selection meaningful after a re-sort.
    useEffect(() => {
        setSelectedIndex(0);
    }, [sortBy]);

    const imageryBaseSwitchPayload = () => ({ switchBase: true, switch_base: true });

    const enterImageryFocus = (label: string) => {
        const timeline = useTimelineStore.getState();
        if (!focusRestoreRef.current) {
            focusRestoreRef.current = {
                visibility: { ...timeline.visibility },
                subtypeVisibility: { ...timeline.subtypeVisibility },
                tileMode: timeline.tileMode,
                showTrajectories: timeline.showTrajectories,
                activeFilter: timeline.activeFilter,
                activePreset: timeline.activePreset,
            };
        }
        const hiddenVisibility = Object.keys(timeline.visibility).reduce((next, key) => {
            next[key as keyof typeof timeline.visibility] = false;
            return next;
        }, { ...timeline.visibility });
        useTimelineStore.setState({
            visibility: hiddenVisibility,
            showTrajectories: false,
            tileMode: 'modis',
            activeFilter: { type: 'solo', label },
            activePreset: null,
        });
    };

    const restoreImageryFocus = () => {
        const snapshot = focusRestoreRef.current;
        focusRestoreRef.current = null;
        if (!snapshot) return;
        useTimelineStore.setState({
            visibility: snapshot.visibility,
            subtypeVisibility: snapshot.subtypeVisibility,
            tileMode: snapshot.tileMode,
            showTrajectories: snapshot.showTrajectories,
            activeFilter: snapshot.activeFilter,
            activePreset: snapshot.activePreset,
        });
    };

    // runSearch performs the actual backend scene search. Options let callers
    // (the right-click "imagery here" seed) override the AOI bbox, source,
    // layer and window without waiting for React state to settle.
    const runSearch = async (opts?: {
        bbox?: [number, number, number, number];
        source?: ImagerySource;
        layer?: string;
        days?: number;
    }) => {
        const useSource = opts?.source ?? source;
        const useLayer = opts?.layer ?? layer;
        const useDays = opts?.days ?? days;
        setLoading(true);
        setError(null);
        setNotice(null);
        setScenes([]);
        setSelectedIndex(0);
        try {
            const bbox = opts?.bbox ?? currentViewBbox();
            if (!bbox) throw new Error('Map camera is not ready for imagery search');
            const operation = useSource === 'copernicus' ? 'copernicus-sentinel-imagery' : 'imagery-search-latest';
            const body = {
                operation,
                args: useSource === 'copernicus'
                    ? {
                        bbox: bbox.join(','),
                        from: isoDaysAgo(useDays),
                        to: new Date().toISOString(),
                        collection: copernicusCollectionForLayer(useLayer),
                        layer: useLayer,
                        max_cloud_cover: maxCloudCover,
                        limit: 5,
                        opacity,
                    }
                    : {
                        bbox: bbox.join(','),
                        layer: useLayer,
                        opacity,
                    },
            };
            const response = await fetch(`${API_URL}/api/agent-tools/source-fetch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await response.json();
            if (!response.ok || json.status === 'error') {
                throw new Error(json.error?.message || `Imagery search failed with status ${json.status || response.status}`);
            }
            if (json.status !== 'ok') {
                throw new Error(json.warnings?.[0] || `Imagery source is ${json.status}`);
            }
            const found: ImageryScene[] = Array.isArray(json.data?.scenes)
                ? json.data.scenes
                : json.data?.scene ? [json.data.scene] : [];
            setScenes(found);
            setSelectedIndex(0);
            if (found.length === 0) setError('No scenes returned for the current view and time window.');
        } catch (err: unknown) {
            setError(errorMessage(err, 'Imagery search failed'));
        } finally {
            setLoading(false);
        }
    };

    const search = () => runSearch();

    // Right-click "imagery here": when a new seed point arrives, aim the search
    // at a small bbox around it, force fresh Sentinel scenes (dated + sortable),
    // and reflect that in the UI controls. The nonce guard prevents re-firing
    // on unrelated re-renders.
    useEffect(() => {
        if (!isOpen || !seedPoint) return;
        if (lastConsumedSeedNonce === seedPoint.nonce) return;
        lastConsumedSeedNonce = seedPoint.nonce;
        const seedBbox = boundedBboxAround(seedPoint.lat, seedPoint.lng);
        setSource('copernicus');
        setLayer('true_color');
        setDays(14);
        setSortBy('date');
        void runSearch({ bbox: seedBbox, source: 'copernicus', layer: 'true_color', days: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, seedPoint?.nonce]);

    const showSelected = () => {
        if (!selectedScene) return;
        const viewer = getViewer();
        if (!viewer) {
            setError('Cesium viewer is not ready');
            return;
        }
        const payload = sceneActionPayload(selectedScene, { source, layer, opacity });
        try {
            if (source === 'copernicus' && selectedScene.render_supported === false && !selectedScene.action_payloads?.show_scene?.payload) {
                throw new Error(selectedScene.render_unsupported_reason || 'This Copernicus scene is metadata-only and cannot be rendered yet.');
            }
            setError(null);
            showOpenSpyImageryLayer(viewer, { ...payload, ...imageryBaseSwitchPayload(), opacity });
            flyToImageryPayload(viewer, payload);
            const key = selectedSceneKey || sceneLabel(selectedScene);
            enterImageryFocus(`Imagery: ${sceneLabel(selectedScene)}`);
            setActiveAction({ mode: 'single', key });
            setNotice('Satellite imagery focus is active. Other map layers, clouds, trajectories and 3D tiles are hidden until Clear.');
        } catch (err: unknown) {
            setError(errorMessage(err, 'Failed to show imagery'));
        }
    };

    const compareSelected = () => {
        if (!selectedScene) return;
        const viewer = getViewer();
        if (!viewer) {
            setError('Cesium viewer is not ready');
            return;
        }
        const baseSwitchPayload = imageryBaseSwitchPayload();
        const after = { ...sceneActionPayload(selectedScene, { source, layer, opacity }), ...baseSwitchPayload };
        if (source === 'copernicus' && selectedScene.render_supported === false && !selectedScene.action_payloads?.show_scene?.payload) {
            setError(selectedScene.render_unsupported_reason || 'This Copernicus scene is metadata-only and cannot be rendered yet.');
            return;
        }
        const fallbackBefore = source === 'nasa_gibs'
            ? {
                ...after,
                scene: { ...selectedScene },
                date: offsetIsoDate(selectedScene.datetime || selectedScene.date, Math.max(1, Math.min(days, 7))).slice(0, 10),
                time: offsetIsoDate(selectedScene.datetime || selectedScene.date, Math.max(1, Math.min(days, 7))),
            }
            : null;
        const beforeScene = displayScenes[selectedIndex + 1] || displayScenes.find((_, index) => index !== selectedIndex) || null;
        const before = beforeScene
            ? { ...sceneActionPayload(beforeScene, { source, layer, opacity: 0.4 }), ...baseSwitchPayload }
            : fallbackBefore;
        if (!before) {
            setError('No second scene is available for comparison.');
            return;
        }
        try {
            setError(null);
            showOpenSpyImageryCompare(viewer, {
                before: { ...before, opacity: 0.42 },
                after: { ...after, opacity },
                ...baseSwitchPayload,
            });
            flyToImageryPayload(viewer, after);
            const key = selectedSceneKey || sceneLabel(selectedScene);
            enterImageryFocus(`Imagery compare: ${sceneLabel(selectedScene)}`);
            setActiveAction({ mode: 'compare', key });
            setNotice('Satellite imagery comparison is active. Other map layers, clouds, trajectories and 3D tiles are hidden until Clear.');
        } catch (err: unknown) {
            setError(errorMessage(err, 'Failed to compare imagery'));
        }
    };

    const clear = () => {
        const viewer = getViewer();
        if (!viewer) return;
        clearOpenSpyImageryLayers(viewer);
        restoreImageryFocus();
        setActiveAction(null);
        setNotice(null);
        viewer.scene.requestRender();
    };

    if (!isOpen) return null;

    return (
        <div className={embedded ? 'flex h-full min-h-0 flex-col text-zinc-200' : 'fixed inset-0 z-40 pointer-events-none'}>
            <div className={embedded
                ? 'flex h-full min-h-0 flex-col overflow-hidden bg-transparent text-zinc-200'
                : 'absolute right-[21rem] top-4 max-h-[calc(100vh-2rem)] w-[23rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-zinc-800 bg-[#131315]/95 text-zinc-200 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur-xl pointer-events-auto'}
            >
                <div className={embedded ? 'hidden' : 'flex items-center justify-between border-b border-zinc-800 px-3 py-2.5'}>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-zinc-300">
                            <Layers size={14} className="text-cyan-300" />
                            <span>Imagery</span>
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-zinc-600">
                            Current map view · {scenes.length > 0 ? `${scenes.length} scenes` : 'no scene selected'}
                        </div>
                    </div>
                    <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Close imagery panel">
                        <X size={15} />
                    </button>
                </div>

                <div className={embedded ? 'min-h-0 flex-1 overflow-y-auto text-xs' : 'max-h-[calc(100vh-5rem)] overflow-y-auto text-xs'}>
                    <div className="border-b border-zinc-800 p-3">
                        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Source</div>
                        <div className="flex overflow-hidden rounded border border-zinc-800">
                        <button
                            onClick={() => { setSource('nasa_gibs'); setLayer('viirs_true_color'); }}
                                className={`flex-1 border-r border-zinc-800 px-3 py-2 text-center font-mono text-[11px] transition-colors ${source === 'nasa_gibs' ? 'bg-cyan-950/40 text-cyan-200' : 'bg-black/25 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'}`}
                        >
                            NASA GIBS
                        </button>
                        <button
                            onClick={() => { setSource('copernicus'); setLayer('true_color'); }}
                                className={`flex-1 px-3 py-2 text-center font-mono text-[11px] transition-colors ${source === 'copernicus' ? 'bg-cyan-950/40 text-cyan-200' : 'bg-black/25 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'}`}
                        >
                            Copernicus
                        </button>
                        </div>
                    </div>

                    <div className="space-y-3 border-b border-zinc-800 p-3">
                        <label className="block">
                            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">Layer</span>
                            <select
                                value={layer}
                                onChange={(event) => setLayer(event.target.value)}
                                className="h-9 w-full rounded border border-zinc-800 bg-black/35 px-2 text-zinc-200 outline-none focus:border-cyan-700"
                            >
                                {source === 'nasa_gibs' ? (
                                    <>
                                        <option value="viirs_true_color">VIIRS true color</option>
                                        <option value="viirs_noaa20_true_color">VIIRS NOAA-20 true color</option>
                                        <option value="viirs_noaa21_true_color">VIIRS NOAA-21 true color</option>
                                        <option value="modis_true_color">MODIS Terra true color</option>
                                        <option value="aqua_true_color">MODIS Aqua true color</option>
                                    </>
                                ) : (
                                    <>
                                        <option value="true_color">Sentinel-2 true color</option>
                                        <option value="false_color">Sentinel-2 false color</option>
                                        <option value="radar_vv">Sentinel-1 radar VV</option>
                                    </>
                                )}
                            </select>
                        </label>

                        <div className="grid grid-cols-3 gap-2">
                            <label>
                                <span className="mb-1 block font-mono text-[10px] text-zinc-500">Days</span>
                                <input type="number" min={1} max={14} value={days} onChange={(event) => setDays(Number(event.target.value) || 1)} disabled={source !== 'copernicus'} className="h-9 w-full rounded border border-zinc-800 bg-black/35 px-2 text-zinc-200 outline-none focus:border-cyan-700 disabled:text-zinc-700" />
                            </label>
                            <label>
                                <span className="mb-1 block font-mono text-[10px] text-zinc-500">Cloud %</span>
                                <input type="number" min={0} max={100} value={maxCloudCover} onChange={(event) => setMaxCloudCover(Number(event.target.value) || 0)} disabled={source !== 'copernicus' || copernicusRadar} className="h-9 w-full rounded border border-zinc-800 bg-black/35 px-2 text-zinc-200 outline-none focus:border-cyan-700 disabled:text-zinc-700" />
                            </label>
                            <label>
                                <span className="mb-1 flex items-center gap-1 font-mono text-[10px] text-zinc-500"><SlidersHorizontal size={12} /> Opacity</span>
                                <input type="number" min={0.1} max={1} step={0.05} value={opacity} onChange={(event) => setOpacity(Number(event.target.value) || 0.72)} className="h-9 w-full rounded border border-zinc-800 bg-black/35 px-2 text-zinc-200 outline-none focus:border-cyan-700" />
                            </label>
                        </div>
                    </div>

                    <div className="space-y-2 border-b border-zinc-800 p-3">
                    <div className="rounded border border-zinc-800 bg-zinc-950/70 px-2 py-2 text-[11px] leading-relaxed text-zinc-500">
                        {providerNote}
                    </div>

                    <div className="rounded border border-cyan-900/50 bg-cyan-950/20 px-2 py-2 text-[11px] leading-relaxed text-cyan-100/80">
                        <div>Show opens a focused satellite-imagery view: MODIS surface on, other map layers off, selected scene overlaid on the current AOI.</div>
                        {tileMode !== 'modis' && (
                            <button onClick={() => setTileMode('modis')} className="mt-2 rounded border border-cyan-800/60 bg-black/30 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-cyan-100 hover:bg-cyan-900/30">
                                Preview MODIS surface
                            </button>
                        )}
                    </div>

                    {activeAction && (
                        <div className="rounded border border-cyan-700/70 bg-cyan-950/35 px-2 py-2 text-[11px] leading-relaxed text-cyan-100">
                            Active: {activeAction.mode === 'compare' ? 'comparison' : 'shown scene'}.
                        </div>
                    )}

                    <div className="flex gap-2">
                        <button onClick={search} disabled={loading} className="flex flex-1 items-center justify-center gap-2 rounded border border-cyan-700/70 bg-cyan-950/40 px-3 py-2 text-cyan-100 hover:bg-cyan-900/50 disabled:opacity-50">
                            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                            <span>Find latest</span>
                        </button>
                        <button
                            onClick={showSelected}
                            disabled={!selectedScene || (source === 'copernicus' && selectedScene.render_supported === false)}
                            className={`rounded border px-3 py-2 transition-colors disabled:opacity-40 ${
                                activeAction?.mode === 'single' && activeAction.key === selectedSceneKey
                                    ? 'border-cyan-500 bg-cyan-800/50 text-cyan-50 shadow-[0_0_0_1px_rgba(34,211,238,0.25)]'
                                    : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
                            }`}
                        >
                            {activeAction?.mode === 'single' && activeAction.key === selectedSceneKey ? 'Shown' : 'Show'}
                        </button>
                        <button
                            onClick={compareSelected}
                            disabled={!selectedScene || (source === 'copernicus' && selectedScene.render_supported === false)}
                            className={`rounded border px-3 py-2 transition-colors disabled:opacity-40 ${
                                activeAction?.mode === 'compare' && activeAction.key === selectedSceneKey
                                    ? 'border-purple-500 bg-purple-800/50 text-purple-50 shadow-[0_0_0_1px_rgba(168,85,247,0.25)]'
                                    : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
                            }`}
                        >
                            {activeAction?.mode === 'compare' && activeAction.key === selectedSceneKey ? 'Comparing' : 'Compare'}
                        </button>
                        <button onClick={clear} className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-400 hover:text-zinc-100">
                            Clear
                        </button>
                    </div>
                    </div>

                    <div className="space-y-2 p-3">
                    {error && <div className="rounded border border-red-900/70 bg-red-950/40 px-2 py-2 text-red-200">{error}</div>}
                    {notice && <div className="rounded border border-cyan-900/70 bg-cyan-950/30 px-2 py-2 text-cyan-100">{notice}</div>}

                    {selectedScene && (
                        <div className="rounded border border-zinc-800 bg-zinc-950/70 px-2 py-2 text-[11px] leading-relaxed text-zinc-500">
                            <div className="font-medium text-zinc-200">{sceneLabel(selectedScene)}</div>
                            {selectedScene.scene_id && <div className="truncate">Scene: {selectedScene.scene_id}</div>}
                            {selectedScene.bbox && <div>Rendered for the current map view.</div>}
                            {selectedScene.render_supported === false && (
                                <div className="mt-1 text-amber-200">{selectedScene.render_unsupported_reason || 'Metadata-only scene.'}</div>
                            )}
                        </div>
                    )}

                    {scenes.length > 0 && (
                        <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">Sort</span>
                            <div className="flex flex-1 overflow-hidden rounded border border-zinc-800">
                                {([
                                    { key: 'date', label: 'Newest' },
                                    { key: 'cloud', label: 'Clearest' },
                                    { key: 'resolution', label: 'Finest' },
                                ] as const).map(({ key, label }) => (
                                    <button
                                        key={key}
                                        onClick={() => setSortBy(key)}
                                        className={`flex-1 border-r border-zinc-800 px-2 py-1 text-center font-mono text-[10px] uppercase tracking-wider transition-colors last:border-r-0 ${sortBy === key ? 'bg-cyan-950/40 text-cyan-200' : 'bg-black/25 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'}`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {scenes.length > 0 && (
                        <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
                            {displayScenes.map((scene, index) => (
                                <button
                                    key={scene.scene_id || index}
                                    onClick={() => setSelectedIndex(index)}
                                    className={`w-full rounded border px-2 py-2 text-left leading-snug transition-colors ${index === selectedIndex ? 'border-cyan-700/70 bg-cyan-950/30 text-cyan-100' : 'border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'}`}
                                >
                                    {sceneLabel(scene)}
                                </button>
                            ))}
                        </div>
                    )}
                    </div>
                </div>
            </div>
        </div>
    );
}
