'use client';

import { useEffect, useMemo, useState } from 'react';
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
    render?: Record<string, any> | null;
    action_payloads?: {
        show_layer?: { payload: Record<string, any> };
        show_scene?: { payload: Record<string, any> };
    };
};

const MAX_IMAGERY_AOI_SPAN_DEG = 4.5;
const MAX_IMAGERY_AOI_AREA_DEG2 = 25;

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
    return (window as any).viewerContext || null;
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

function sceneLabel(scene: ImageryScene): string {
    const date = String(scene.datetime || scene.date || '').slice(0, 10) || 'latest';
    const provider = scene.provider || (scene.source === 'copernicus' ? 'Copernicus' : 'NASA GIBS');
    const cloud = scene.cloud_cover == null ? '' : ` · ${Math.round(Number(scene.cloud_cover))}% cloud`;
    const layer = scene.collection || scene.requested_layer || scene.layer_id || '';
    return `${provider} ${date}${layer ? ` · ${layer}` : ''}${cloud}`;
}

function sceneActionPayload(scene: ImageryScene, fallback: Record<string, any>): Record<string, any> {
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

function offsetIsoDate(value: string | undefined | null, days: number): string {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return isoDaysAgo(days);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString();
}

function copernicusCollectionForLayer(layer: string): string {
    return layer === 'radar_vv' ? 'sentinel-1-grd' : 'sentinel-2-l2a';
}

export function ImageryToggle({ onClick }: { onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            title="Fresh satellite imagery"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-mono rounded-lg border shadow-2xl backdrop-blur-xl transition-colors bg-black/80 text-zinc-500 hover:text-zinc-300 border-zinc-800"
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
        <div className="rounded-lg border border-cyan-900/70 bg-black/80 px-3 py-2 text-[11px] leading-relaxed text-zinc-400 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center gap-1.5 font-mono uppercase text-cyan-200">
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

export default function ImageryPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const setTileMode = useTimelineStore((state) => state.setTileMode);
    const [source, setSource] = useState<ImagerySource>('nasa_gibs');
    const [layer, setLayer] = useState('viirs_true_color');
    const [days, setDays] = useState(7);
    const [maxCloudCover, setMaxCloudCover] = useState(40);
    const [opacity, setOpacity] = useState(0.72);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [scenes, setScenes] = useState<ImageryScene[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const selectedScene = scenes[selectedIndex] || null;
    const copernicusRadar = source === 'copernicus' && layer === 'radar_vv';
    const providerNote = useMemo(() => (
        source === 'copernicus'
            ? 'Sentinel search uses backend-owned credentials and cached bounded renders. Sentinel-1 radar works through clouds but is not a natural-color photo.'
            : 'NASA GIBS is public daily context imagery; no key is required.'
    ), [source]);

    useEffect(() => {
        setScenes([]);
        setSelectedIndex(0);
        setError(null);
    }, [source, layer]);

    if (!isOpen) return null;

    const search = async () => {
        setLoading(true);
        setError(null);
        setScenes([]);
        setSelectedIndex(0);
        try {
            const bbox = currentViewBbox();
            if (!bbox) throw new Error('Map camera is not ready for imagery search');
            const operation = source === 'copernicus' ? 'copernicus-sentinel-imagery' : 'imagery-search-latest';
            const body = {
                operation,
                args: source === 'copernicus'
                    ? {
                        bbox: bbox.join(','),
                        from: isoDaysAgo(days),
                        to: new Date().toISOString(),
                        collection: copernicusCollectionForLayer(layer),
                        layer,
                        max_cloud_cover: maxCloudCover,
                        limit: 5,
                        opacity,
                    }
                    : {
                        bbox: bbox.join(','),
                        layer,
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
            const found = Array.isArray(json.data?.scenes)
                ? json.data.scenes
                : json.data?.scene ? [json.data.scene] : [];
            setScenes(found);
            setSelectedIndex(0);
            if (found.length === 0) setError('No scenes returned for the current view and time window.');
        } catch (err: any) {
            setError(err?.message || 'Imagery search failed');
        } finally {
            setLoading(false);
        }
    };

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
            showOpenSpyImageryLayer(viewer, { ...payload, switchBase: false, switch_base: false, opacity });
        } catch (err: any) {
            setError(err?.message || 'Failed to show imagery');
        }
    };

    const compareSelected = () => {
        if (!selectedScene) return;
        const viewer = getViewer();
        if (!viewer) {
            setError('Cesium viewer is not ready');
            return;
        }
        const after = { ...sceneActionPayload(selectedScene, { source, layer, opacity }), switchBase: false, switch_base: false };
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
        const beforeScene = scenes[selectedIndex + 1] || scenes.find((_, index) => index !== selectedIndex) || null;
        const before = beforeScene
            ? { ...sceneActionPayload(beforeScene, { source, layer, opacity: 0.4 }), switchBase: false, switch_base: false }
            : fallbackBefore;
        if (!before) {
            setError('No second scene is available for comparison.');
            return;
        }
        try {
            showOpenSpyImageryCompare(viewer, {
                before: { ...before, opacity: 0.42 },
                after: { ...after, opacity },
            });
        } catch (err: any) {
            setError(err?.message || 'Failed to compare imagery');
        }
    };

    const clear = () => {
        const viewer = getViewer();
        if (!viewer) return;
        clearOpenSpyImageryLayers(viewer);
        viewer.scene.requestRender();
    };

    return (
        <div className="fixed inset-0 z-40 pointer-events-none">
            <div className="absolute top-4 right-[21rem] w-[22rem] max-w-[calc(100vw-2rem)] pointer-events-auto rounded-lg border border-zinc-800 bg-black/90 backdrop-blur-xl shadow-2xl text-zinc-200">
                <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                    <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wide text-zinc-400">
                        <Layers size={14} />
                        <span>Imagery</span>
                    </div>
                    <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" title="Close imagery panel">
                        <X size={15} />
                    </button>
                </div>

                <div className="space-y-3 p-3 text-xs">
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => { setSource('nasa_gibs'); setLayer('viirs_true_color'); }}
                            className={`rounded border px-2 py-2 text-left ${source === 'nasa_gibs' ? 'border-cyan-500 bg-cyan-950/40 text-cyan-100' : 'border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:text-zinc-200'}`}
                        >
                            NASA GIBS
                        </button>
                        <button
                            onClick={() => { setSource('copernicus'); setLayer('true_color'); }}
                            className={`rounded border px-2 py-2 text-left ${source === 'copernicus' ? 'border-cyan-500 bg-cyan-950/40 text-cyan-100' : 'border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:text-zinc-200'}`}
                        >
                            Copernicus
                        </button>
                    </div>

                    <label className="block">
                        <span className="mb-1 block text-zinc-500">Layer</span>
                        <select
                            value={layer}
                            onChange={(event) => setLayer(event.target.value)}
                            className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-zinc-200 outline-none focus:border-cyan-600"
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
                            <span className="mb-1 block text-zinc-500">Days</span>
                            <input type="number" min={1} max={14} value={days} onChange={(event) => setDays(Number(event.target.value) || 1)} disabled={source !== 'copernicus'} className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-zinc-200 outline-none focus:border-cyan-600 disabled:text-zinc-700" />
                        </label>
                        <label>
                            <span className="mb-1 block text-zinc-500">Cloud %</span>
                            <input type="number" min={0} max={100} value={maxCloudCover} onChange={(event) => setMaxCloudCover(Number(event.target.value) || 0)} disabled={source !== 'copernicus' || copernicusRadar} className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-zinc-200 outline-none focus:border-cyan-600 disabled:text-zinc-700" />
                        </label>
                        <label>
                            <span className="mb-1 flex items-center gap-1 text-zinc-500"><SlidersHorizontal size={12} /> Opacity</span>
                            <input type="number" min={0.1} max={1} step={0.05} value={opacity} onChange={(event) => setOpacity(Number(event.target.value) || 0.72)} className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-zinc-200 outline-none focus:border-cyan-600" />
                        </label>
                    </div>

                    <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-2 text-[11px] leading-relaxed text-zinc-500">
                        {providerNote}
                    </div>

                    <div className="flex gap-2">
                        <button onClick={search} disabled={loading} className="flex flex-1 items-center justify-center gap-2 rounded border border-cyan-700 bg-cyan-950/40 px-3 py-2 text-cyan-100 hover:bg-cyan-900/50 disabled:opacity-50">
                            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                            <span>Find latest</span>
                        </button>
                        <button onClick={showSelected} disabled={!selectedScene || (source === 'copernicus' && selectedScene.render_supported === false)} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
                            Show
                        </button>
                        <button onClick={compareSelected} disabled={!selectedScene || (source === 'copernicus' && selectedScene.render_supported === false)} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
                            Compare
                        </button>
                        <button onClick={clear} className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-400 hover:text-zinc-100">
                            Clear
                        </button>
                    </div>

                    {source === 'nasa_gibs' && (
                        <button onClick={() => setTileMode('modis')} className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-400 hover:text-zinc-100">
                            Set MODIS as base imagery
                        </button>
                    )}

                    {error && <div className="rounded border border-red-900/70 bg-red-950/40 px-2 py-2 text-red-200">{error}</div>}

                    {selectedScene && (
                        <div className="rounded border border-zinc-800 bg-zinc-950/70 px-2 py-2 text-[11px] leading-relaxed text-zinc-500">
                            <div className="text-zinc-300">{sceneLabel(selectedScene)}</div>
                            {selectedScene.scene_id && <div className="truncate">Scene: {selectedScene.scene_id}</div>}
                            {selectedScene.bbox && <div>AOI render is bounded to the current view.</div>}
                            {selectedScene.render_supported === false && (
                                <div className="mt-1 text-amber-200">{selectedScene.render_unsupported_reason || 'Metadata-only scene.'}</div>
                            )}
                        </div>
                    )}

                    {scenes.length > 0 && (
                        <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
                            {scenes.map((scene, index) => (
                                <button
                                    key={scene.scene_id || index}
                                    onClick={() => setSelectedIndex(index)}
                                    className={`w-full rounded border px-2 py-2 text-left leading-snug ${index === selectedIndex ? 'border-cyan-600 bg-cyan-950/30 text-cyan-100' : 'border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:text-zinc-200'}`}
                                >
                                    {sceneLabel(scene)}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
