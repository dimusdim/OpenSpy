'use client';

import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    useAIImageStore,
    GalleryEntry,
    Preset,
    AI_CONTEXT_DEFAULTS,
    type AIContextObject,
    type AIContextSnapshot,
    type AIImageGeneratedGeometry,
    type AIImageModelCapabilities,
    type AIImageSourceGeometry,
} from '../store/useAIImageStore';
import { useTimelineStore } from '../store/useTimelineStore';
import {
    captureScreenshot,
    flyToViewport,
    ViewportSnapshot,
} from '../utils/cesiumScreenshot';
import {
    Sparkles,
    X,
    Camera,
    Loader2,
    Eye,
    EyeOff,
    MapPin,
    Download,
    Trash2,
    ArrowRight,
    Plus,
    Pencil,
    Maximize2,
    AlertCircle,
    RotateCcw,
    Crosshair,
    Target,
    SlidersHorizontal,
} from 'lucide-react';
import * as Cesium from 'cesium';
import {
    useAIImageNearbyContext,
    type AIContextLookupResult,
} from '../cesium/useAIImageNearbyContext';
import {
    AI_CONTEXT_PLACEHOLDERS,
    formatContextObjectCard,
    resolveAIImagePrompt,
    type AIImageCameraContext,
} from '../lib/ai-prompt-context';
import { formatDistance } from '../lib/ai-context-sources';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3055';
const GLOBAL_CONTEXT_PRESET_ID = '__ai_vision_global_context__';

type ViewerWindow = Window & {
    viewerContext?: Cesium.Viewer;
};

type GalleryApiRecord = {
    id: string;
    timestamp: string;
    presetName?: string;
    prompt?: string;
    model?: string;
    viewport: GalleryEntry['viewport'];
    originalFile?: string;
    generatedFile?: string;
    sourceGeometry?: AIImageSourceGeometry;
    generatedGeometry?: AIImageGeneratedGeometry;
    contextSnapshot?: AIContextSnapshot;
};

type GenerateApiRecord = {
    id: string;
    originalFile: string;
    generatedFile: string;
    sourceGeometry?: AIImageSourceGeometry;
    generatedGeometry?: AIImageGeneratedGeometry;
    contextSnapshot?: AIContextSnapshot;
};

async function fetchModelCapabilities(model: string): Promise<AIImageModelCapabilities> {
    const res = await fetch(`${API_URL}/api/ai-image/model-capabilities?model=${encodeURIComponent(model)}`);
    if (!res.ok) throw new Error(`Model capabilities failed: HTTP ${res.status}`);
    return res.json() as Promise<AIImageModelCapabilities>;
}

function getGlobalViewer(): Cesium.Viewer | undefined {
    return (window as ViewerWindow).viewerContext;
}

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
}

// ===========================================================================
// Toggle button (always visible in right column)
// ===========================================================================

export function AIImageToggle() {
    const isActive = useAIImageStore((s) => s.isActive);
    const setActive = useAIImageStore((s) => s.setActive);

    return (
        <button
            onClick={() => setActive(!isActive)}
            title="AI Vision — generate illustrations from globe view"
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono rounded-lg border shadow-2xl backdrop-blur-xl transition-colors ${
                isActive
                    ? 'bg-purple-600/30 text-purple-300 border-purple-700/50'
                    : 'bg-black/80 text-zinc-500 hover:text-zinc-300 border-zinc-800'
            }`}
        >
            <Sparkles size={14} />
            <span>AI Vision</span>
        </button>
    );
}

// ===========================================================================
// Generated-over-source fullscreen overlay
// ===========================================================================

function ImageOverlayComparison({
    entry,
    beforeSrc,
    afterSrc,
    onClose,
}: {
    entry: GalleryEntry;
    beforeSrc: string;
    afterSrc: string;
    onClose: () => void;
}) {
    const overlayOpacity = useAIImageStore((s) => s.overlayOpacity);
    const setOverlayOpacity = useAIImageStore((s) => s.setOverlayOpacity);
    const [windowSize, setWindowSize] = useState(() => ({
        width: typeof window !== 'undefined' ? window.innerWidth : 1280,
        height: typeof window !== 'undefined' ? window.innerHeight : 720,
    }));

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    useEffect(() => {
        const onResize = () => {
            setWindowSize({ width: window.innerWidth, height: window.innerHeight });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const opacityFraction = overlayOpacity / 100;
    const geometry = entry.sourceGeometry;
    const overlayStyle = (() => {
        if (!geometry) return null;
        const capture = geometry.capture;
        const visible = geometry.visibleRect;
        if (
            capture.width <= 0 ||
            capture.height <= 0 ||
            visible.width <= 0 ||
            visible.height <= 0
        ) {
            return null;
        }
        const scale = Math.min(windowSize.width / visible.width, windowSize.height / visible.height);
        const frameWidth = capture.width * scale;
        const frameHeight = capture.height * scale;
        const visibleCenterX = (visible.x + visible.width / 2) * scale;
        const visibleCenterY = (visible.y + visible.height / 2) * scale;
        return {
            left: windowSize.width / 2 - visibleCenterX,
            top: windowSize.height / 2 - visibleCenterY,
            width: frameWidth,
            height: frameHeight,
        };
    })();

    return (
        <div className="fixed inset-0 z-[9500] bg-black select-none">
            {overlayStyle ? (
                <div
                    className="absolute overflow-hidden"
                    data-ai-image-compare-frame="true"
                    style={overlayStyle}
                >
                    <img
                        src={beforeSrc}
                        alt="Source"
                        className="absolute inset-0 h-full w-full object-fill"
                        draggable={false}
                    />
                    <img
                        src={afterSrc}
                        alt="Generated"
                        className="absolute inset-0 h-full w-full object-fill"
                        style={{ opacity: opacityFraction }}
                        draggable={false}
                    />
                </div>
            ) : (
                <>
                    <img
                        src={beforeSrc}
                        alt="Source"
                        className="absolute inset-0 h-full w-full object-contain object-center"
                        draggable={false}
                    />
                    <img
                        src={afterSrc}
                        alt="Generated"
                        className="absolute inset-0 h-full w-full object-contain object-center"
                        style={{ opacity: opacityFraction }}
                        draggable={false}
                    />
                </>
            )}

            {/* Labels */}
            <span className="absolute left-4 top-4 z-20 px-2 py-1 text-[11px] font-mono text-white/70 bg-black/50 rounded pointer-events-none">
                Source
            </span>
            <span className="absolute left-20 top-4 z-20 px-2 py-1 text-[11px] font-mono text-purple-200/80 bg-purple-950/60 rounded pointer-events-none">
                Result {overlayOpacity}%
            </span>

            <button
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                className="absolute right-4 top-4 z-20 flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono text-zinc-300 bg-black/70 hover:bg-black/90 rounded-lg border border-zinc-700 transition-colors cursor-pointer"
            >
                <X size={14} />
                Close
            </button>

            <div className="absolute bottom-5 left-1/2 z-20 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-zinc-700 bg-black/75 backdrop-blur-xl px-3 py-2">
                <div className="flex items-center gap-3">
                    <SlidersHorizontal size={14} className="text-purple-300 shrink-0" />
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={overlayOpacity}
                        onChange={(e) => setOverlayOpacity(Number(e.target.value))}
                        className="w-full accent-purple-500"
                        aria-label="Generated image opacity"
                    />
                    <span className="w-10 text-right text-[11px] font-mono text-zinc-300">
                        {overlayOpacity}%
                    </span>
                </div>
            </div>
        </div>
    );
}

// ===========================================================================
// Fullscreen overlay — single image or comparison slider
// ===========================================================================

function FullscreenOverlay() {
    const entry = useAIImageStore((s) => s.fullscreenEntry);
    const setEntry = useAIImageStore((s) => s.setFullscreenEntry);

    useEffect(() => {
        if (!entry) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setEntry(null);
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [entry, setEntry]);

    if (!entry || typeof document === 'undefined') return null;

    const originalSrc =
        entry.localScreenshot ||
        (entry.originalFile
            ? `${API_URL}/api/ai-image/files/originals/${entry.originalFile}`
            : null);
    const generatedSrc = entry.generatedFile
        ? `${API_URL}/api/ai-image/files/generated/${entry.generatedFile}`
        : null;

    // Both available → comparison slider
    if (originalSrc && generatedSrc) {
        return createPortal(
            <ImageOverlayComparison
                entry={entry}
                beforeSrc={originalSrc}
                afterSrc={generatedSrc}
                onClose={() => setEntry(null)}
            />,
            document.body,
        );
    }

    // Single image fullscreen
    const src = generatedSrc || originalSrc;
    if (!src) return null;

    return createPortal(
        <div className="fixed inset-0 z-[9500] bg-black">
            <img
                src={src}
                alt="Fullscreen"
                className="h-full w-full object-contain object-center"
            />
            <button
                onClick={() => setEntry(null)}
                className="absolute top-4 right-4 flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono text-zinc-300 bg-black/70 hover:bg-black/90 rounded-lg border border-zinc-700 transition-colors z-10"
            >
                <X size={14} />
                Close
            </button>
        </div>,
        document.body,
    );
}

// ===========================================================================
// Context menu (right-click on gallery item)
// ===========================================================================

function ContextMenu({
    x,
    y,
    entry,
    onClose,
}: {
    x: number;
    y: number;
    entry: GalleryEntry;
    onClose: () => void;
}) {
    const removeEntry = useAIImageStore((s) => s.removeEntry);
    const setFullscreenEntry = useAIImageStore((s) => s.setFullscreenEntry);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node))
                onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    const style: React.CSSProperties = {
        left: Math.min(x, window.innerWidth - 200),
        top: Math.min(y, window.innerHeight - 180),
    };

    return (
        <div
            ref={menuRef}
            className="fixed z-[9999] bg-zinc-900/95 backdrop-blur-xl border border-zinc-700 rounded-lg shadow-2xl py-1 min-w-[180px]"
            style={style}
        >
            <button
                onClick={() => { flyToViewport(entry.viewport as ViewportSnapshot); onClose(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-zinc-300 hover:bg-cyan-600/20 hover:text-cyan-300 transition-colors"
            >
                <MapPin size={13} />
                Go to Location
            </button>
            {entry.status === 'completed' && (
                <>
                    <button
                        onClick={() => { setFullscreenEntry(entry); onClose(); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-zinc-300 hover:bg-cyan-600/20 hover:text-cyan-300 transition-colors"
                    >
                        <Maximize2 size={13} />
                        Compare Fullscreen
                    </button>
                    <button
                        onClick={() => {
                            if (entry.generatedFile) {
                                const a = document.createElement('a');
                                a.href = `${API_URL}/api/ai-image/files/generated/${entry.generatedFile}`;
                                a.download = entry.generatedFile;
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                            }
                            onClose();
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-zinc-300 hover:bg-cyan-600/20 hover:text-cyan-300 transition-colors"
                    >
                        <Download size={13} />
                        Download
                    </button>
                </>
            )}
            <div className="border-t border-zinc-700 my-1" />
            <button
                onClick={async () => {
                    if (entry.serverId) {
                        try {
                            await fetch(`${API_URL}/api/ai-image/${entry.serverId}`, { method: 'DELETE' });
                        } catch { /* ignore */ }
                    }
                    removeEntry(entry.id);
                    onClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-red-400 hover:bg-red-600/20 hover:text-red-300 transition-colors"
            >
                <Trash2 size={13} />
                Delete
            </button>
        </div>
    );
}

// ===========================================================================
// Gallery item — expanded card with inline info + click → fullscreen
// ===========================================================================

function GalleryItem({
    entry,
    onContextMenu,
}: {
    entry: GalleryEntry;
    onContextMenu: (e: React.MouseEvent) => void;
}) {
    const setFullscreenEntry = useAIImageStore((s) => s.setFullscreenEntry);
    const removeEntry = useAIImageStore((s) => s.removeEntry);

    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (entry.serverId) {
            try {
                await fetch(`${API_URL}/api/ai-image/${entry.serverId}`, { method: 'DELETE' });
            } catch { /* ignore */ }
        }
        removeEntry(entry.id);
    };

    const ts = new Date(entry.timestamp);
    const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = ts.toLocaleDateString([], { month: 'short', day: 'numeric' });

    const originalSrc =
        entry.localScreenshot ||
        (entry.originalFile
            ? `${API_URL}/api/ai-image/files/originals/${entry.originalFile}`
            : null);

    const generatedSrc = entry.generatedFile
        ? `${API_URL}/api/ai-image/files/generated/${entry.generatedFile}`
        : null;

    return (
        <div
            onContextMenu={onContextMenu}
            className={`group/card relative rounded-lg border transition-colors overflow-hidden bg-zinc-900/40 ${
                entry.status === 'error'
                    ? 'border-red-800/50'
                    : entry.status === 'pending'
                      ? 'border-yellow-800/30'
                      : 'border-zinc-800'
            }`}
        >
            {/* Hover delete button */}
            <button
                onClick={handleDelete}
                title="Delete this pair"
                className="absolute top-1 right-1 z-10 p-1 rounded bg-black/60 hover:bg-red-900/80 text-zinc-500 hover:text-red-300 opacity-0 group-hover/card:opacity-100 transition-all"
            >
                <Trash2 size={11} />
            </button>

            {/* Image pair */}
            <div className="flex gap-0.5 p-1">
                {/* Source */}
                <div
                    className="relative flex-1 aspect-video rounded overflow-hidden cursor-pointer hover:ring-1 hover:ring-cyan-500/40 transition-all"
                    onClick={() => originalSrc && setFullscreenEntry(entry)}
                    title="Click to view fullscreen"
                >
                    {originalSrc ? (
                        <img src={originalSrc} alt="Source" className="w-full h-full object-cover" />
                    ) : (
                        <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
                            <Camera size={14} className="text-zinc-600" />
                        </div>
                    )}
                    <span className="absolute top-0.5 left-0.5 px-1 py-px text-[8px] font-mono bg-black/70 text-zinc-400 rounded">
                        SRC
                    </span>
                </div>

                <div className="flex items-center px-0.5 shrink-0">
                    <ArrowRight size={10} className="text-purple-500/60" />
                </div>

                {/* Generated / spinner / error */}
                <div
                    className={`relative flex-1 aspect-video rounded overflow-hidden ${
                        entry.status === 'completed' && generatedSrc
                            ? 'cursor-pointer hover:ring-1 hover:ring-purple-500/40 transition-all'
                            : ''
                    }`}
                    onClick={() => entry.status === 'completed' && setFullscreenEntry(entry)}
                    title={entry.status === 'completed' ? 'Click to compare fullscreen' : undefined}
                >
                    {entry.status === 'completed' && generatedSrc ? (
                        <>
                            <img src={generatedSrc} alt="Result" className="w-full h-full object-cover" loading="lazy" />
                            <span className="absolute top-0.5 left-0.5 px-1 py-px text-[8px] font-mono bg-purple-900/70 text-purple-300 rounded">
                                GEN
                            </span>
                        </>
                    ) : entry.status === 'pending' ? (
                        <div className="w-full h-full bg-zinc-800/80 flex flex-col items-center justify-center gap-1">
                            <Loader2 size={16} className="animate-spin text-purple-400/70" />
                            <span className="text-[8px] font-mono text-purple-400/50">generating</span>
                        </div>
                    ) : (
                        <div className="w-full h-full bg-red-950/30 flex flex-col items-center justify-center gap-1">
                            <AlertCircle size={14} className="text-red-500/70" />
                            <span className="text-[8px] font-mono text-red-400/60 px-1 text-center truncate w-full">
                                {entry.error || 'error'}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* Info + actions */}
            <div className="px-1.5 pb-1.5 pt-0.5 space-y-0.5">
                <div className="flex items-center justify-between">
                    <span className="text-[9px] font-mono text-zinc-600">
                        {dateStr} {timeStr}
                    </span>
                    <span className="text-[9px] font-mono text-purple-500/60 truncate max-w-[100px]">
                        {entry.presetName}
                    </span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-[9px] font-mono text-zinc-700">
                        {entry.viewport.latitude.toFixed(3)}°, {entry.viewport.longitude.toFixed(3)}°
                        <span className="text-zinc-800 ml-1">
                            {(entry.viewport.height / 1000).toFixed(0)}km
                        </span>
                        {entry.contextSnapshot && (
                            <span className="text-purple-500/60 ml-1">
                                ctx {entry.contextSnapshot.selected.length}
                            </span>
                        )}
                    </span>
                    <button
                        onClick={(e) => { e.stopPropagation(); flyToViewport(entry.viewport as ViewportSnapshot); }}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono text-cyan-500 hover:text-cyan-300 hover:bg-cyan-600/15 rounded transition-colors"
                    >
                        <MapPin size={9} />
                        Go to
                    </button>
                </div>
            </div>
        </div>
    );
}

// ===========================================================================
// Nearby context UI for AI Vision presets
// ===========================================================================

function ContextStatusBadge({
    nearby,
    radiusM,
    required,
}: {
    nearby: AIContextLookupResult;
    radiusM: number;
    required: boolean;
}) {
    if (nearby.status === 'inactive') return null;
    if (nearby.refreshing) {
        const pending = nearby.pendingSourceLabels.length > 0
            ? nearby.pendingSourceLabels.join(', ')
            : 'camera';
        return (
            <span
                title={`Updating context: ${pending}`}
                className="inline-flex items-center gap-1 text-[9px] font-mono text-purple-300/90"
            >
                <Loader2 size={9} className="animate-spin" /> updating
            </span>
        );
    }
    if (nearby.status === 'noTarget') {
        return (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-amber-400/80">
                <AlertCircle size={9} /> no target
            </span>
        );
    }
    if (nearby.status === 'empty') {
        return (
            <span className={`inline-flex items-center gap-1 text-[9px] font-mono ${required ? 'text-red-400/80' : 'text-zinc-500'}`}>
                <Crosshair size={9} /> 0 in {formatDistance(radiusM)}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-[9px] font-mono text-emerald-400/90">
            <Target size={9} /> {nearby.selected.length}/{nearby.candidates.length} in {formatDistance(radiusM)}
        </span>
    );
}

function ContextObjectChip({
    object,
    excluded,
    primary,
    includeSource,
    onToggle,
}: {
    object: AIContextObject;
    excluded: boolean;
    primary: boolean;
    includeSource: boolean;
    onToggle: () => void;
}) {
    const title = useMemo(
        () => formatContextObjectCard(object, includeSource),
        [object, includeSource],
    );
    return (
        <button
            type="button"
            onClick={onToggle}
            title={title}
            className={`group inline-flex items-center gap-1 max-w-[130px] px-1.5 py-0.5 text-[9px] font-mono rounded border transition-colors ${
                excluded
                    ? 'bg-zinc-900/60 text-zinc-500 border-zinc-800 line-through hover:text-zinc-400'
                    : primary
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-600/45 hover:bg-emerald-500/25'
                        : 'bg-purple-600/15 text-purple-300 border-purple-700/40 hover:bg-purple-600/25'
            }`}
        >
            <span className="truncate">{object.name}</span>
            <X size={8} className={excluded ? 'opacity-50' : 'opacity-70 group-hover:opacity-100'} />
        </button>
    );
}

function ContextChipStrip({
    presetId,
    nearby,
    includeSource,
}: {
    presetId: string;
    nearby: AIContextLookupResult;
    includeSource: boolean;
}) {
    const excludedMap = useAIImageStore((s) => s.excludedContextObjects[presetId]) ?? {};
    const toggleExcluded = useAIImageStore((s) => s.toggleExcludedContextObject);
    const clearExcluded = useAIImageStore((s) => s.clearExcludedContextObjects);
    const activeCandidates = nearby.selected.filter((object) => !excludedMap[object.id]);
    const hasExcluded = Object.keys(excludedMap).length > 0;
    if (nearby.candidates.length === 0) return null;

    return (
        <div className="flex flex-wrap items-center gap-1 max-h-24 overflow-y-auto">
            {activeCandidates.map((object, index) => (
                <ContextObjectChip
                    key={`${presetId}-${object.id}`}
                    object={object}
                    excluded={false}
                    primary={index === 0}
                    includeSource={includeSource}
                    onToggle={() => toggleExcluded(presetId, object.id, object.sourceId)}
                />
            ))}
            {hasExcluded && (
                <button
                    type="button"
                    onClick={() => clearExcluded(presetId)}
                    title="Clear removed objects"
                    className="inline-flex items-center gap-0.5 text-[9px] font-mono text-zinc-500 hover:text-zinc-300"
                >
                    <RotateCcw size={9} /> reset
                </button>
            )}
        </div>
    );
}

function GlobalContextPanel({
    nearby,
}: {
    nearby: AIContextLookupResult;
}) {
    return (
        <div className="px-3 py-2 border-b border-zinc-800 shrink-0 space-y-1">
            <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-zinc-400">
                    <Target size={11} className="text-purple-400" />
                    Prompt context
                </span>
                <ContextStatusBadge
                    nearby={nearby}
                    radiusM={AI_CONTEXT_DEFAULTS.searchRadiusM}
                    required={false}
                />
            </div>
            <ContextChipStrip
                presetId={GLOBAL_CONTEXT_PRESET_ID}
                nearby={nearby}
                includeSource={AI_CONTEXT_DEFAULTS.includeSourceInContext}
            />
        </div>
    );
}

function PromptEditor({
    preset,
    onUpdate,
}: {
    preset: Preset;
    onUpdate: (updates: Partial<Omit<Preset, 'id'>>) => void;
}) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const insertToken = useCallback((token: string) => {
        const textarea = textareaRef.current;
        const current = preset.prompt ?? '';
        if (!textarea) {
            onUpdate({ prompt: `${current}${token}` });
            return;
        }
        const start = textarea.selectionStart ?? current.length;
        const end = textarea.selectionEnd ?? current.length;
        const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
        onUpdate({ prompt: next });
        requestAnimationFrame(() => {
            if (!textareaRef.current) return;
            textareaRef.current.focus();
            const pos = start + token.length;
            textareaRef.current.setSelectionRange(pos, pos);
        });
    }, [onUpdate, preset.prompt]);

    return (
        <label className="block">
            <span className="text-[9px] font-mono text-zinc-600">Prompt</span>
            <textarea
                ref={textareaRef}
                value={preset.prompt}
                onChange={(e) => onUpdate({ prompt: e.target.value })}
                rows={4}
                className="w-full bg-zinc-900 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300 px-1.5 py-1 resize-none focus:outline-none focus:border-purple-600/50"
            />
            <div className="mt-1 flex flex-wrap gap-1">
                <span className="text-[9px] font-mono text-zinc-600">Insert:</span>
                {AI_CONTEXT_PLACEHOLDERS.map((placeholder) => (
                    <button
                        key={placeholder.token}
                        type="button"
                        onClick={() => insertToken(placeholder.token)}
                        title={`${placeholder.description}: ${placeholder.token}`}
                        className="text-[9px] font-mono text-purple-300/80 hover:text-purple-200 bg-purple-600/10 hover:bg-purple-600/20 border border-purple-700/30 rounded px-1 py-0.5"
                    >
                        {placeholder.label}
                    </button>
                ))}
            </div>
        </label>
    );
}

// ===========================================================================
// Preset row — capture button + inline edit
// ===========================================================================

function PresetRow({
    preset,
    viewer,
    contextSnapshot,
    onCapture,
}: {
    preset: Preset;
    viewer: Cesium.Viewer | null;
    contextSnapshot: AIContextSnapshot | null;
    onCapture: (resolvedPrompt: string, contextSnapshot: AIContextSnapshot | null) => void;
}) {
    const updatePreset = useAIImageStore((s) => s.updatePreset);
    const removePreset = useAIImageStore((s) => s.removePreset);
    const [editing, setEditing] = useState(false);

    const promptUsesContext = /\{\{ctx\.[\w.]+\}\}/.test(preset.prompt);

    const buildPrompt = useCallback(() => {
        const camera = getCameraContext(viewer);
        return resolveAIImagePrompt(
            preset.prompt,
            contextSnapshot,
            camera,
            {
                includeSource: AI_CONTEXT_DEFAULTS.includeSourceInContext,
                injectCamera: AI_CONTEXT_DEFAULTS.injectCameraContext,
            },
        ).resolvedPrompt;
    }, [viewer, preset.prompt, contextSnapshot]);

    const previewPrompt = useMemo(() => buildPrompt(), [buildPrompt]);

    return (
        <div>
            <div className="flex items-center gap-1">
                <button
                    onClick={() => {
                        onCapture(buildPrompt(), promptUsesContext ? contextSnapshot : null);
                    }}
                    title={previewPrompt.slice(0, 900)}
                    className="flex-1 flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-mono text-purple-300 bg-purple-600/15 hover:bg-purple-600/25 active:bg-purple-600/35 border border-purple-700/40 rounded-md transition-colors truncate"
                >
                    <Camera size={12} className="shrink-0" />
                    <span className="truncate">{preset.name}</span>
                    {promptUsesContext && contextSnapshot?.selected.length ? (
                        <span className="ml-auto text-[9px] text-purple-300/70">
                            ctx
                        </span>
                    ) : null}
                </button>
                <button
                    type="button"
                    title={previewPrompt}
                    className="p-1.5 rounded-md border border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700 transition-colors"
                >
                    <Eye size={11} />
                </button>
                <button
                    onClick={() => setEditing(!editing)}
                    title="Edit preset"
                    className={`p-1.5 rounded-md border transition-colors ${
                        editing
                            ? 'bg-purple-600/20 border-purple-700/50 text-purple-300'
                            : 'border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700'
                    }`}
                >
                    <Pencil size={11} />
                </button>
            </div>

            {editing && (
                <div className="mt-1.5 ml-1 space-y-1.5 border-l-2 border-purple-800/30 pl-2">
                    <label className="block">
                        <span className="text-[9px] font-mono text-zinc-600">Name</span>
                        <input
                            value={preset.name}
                            onChange={(e) => updatePreset(preset.id, { name: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300 px-1.5 py-1 focus:outline-none focus:border-purple-600/50"
                        />
                    </label>
                    <label className="block">
                        <span className="text-[9px] font-mono text-zinc-600">Model</span>
                        <div className="flex gap-1">
                            <input
                                list={`models-${preset.id}`}
                                value={preset.model}
                                onChange={(e) => updatePreset(preset.id, { model: e.target.value })}
                                className="flex-1 bg-zinc-900 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300 px-1.5 py-1 focus:outline-none focus:border-purple-600/50"
                                placeholder="model id"
                            />
                            <datalist id={`models-${preset.id}`}>
                                <option value="google/gemini-3.1-flash-image-preview">Nano Banana 2</option>
                                <option value="google/gemini-3-pro-image-preview">Nano Banana Pro</option>
                                <option value="openai/gpt-5.4-image-2">GPT-5.4 Image 2</option>
                                <option value="openai/gpt-5-image">GPT-5 Image</option>
                                <option value="openai/gpt-5-image-mini">GPT-5 Image Mini</option>
                            </datalist>
                        </div>
                    </label>
                    <PromptEditor preset={preset} onUpdate={(updates) => updatePreset(preset.id, updates)} />
                    <button
                        onClick={() => removePreset(preset.id)}
                        className="flex items-center gap-1 text-[9px] font-mono text-red-500/70 hover:text-red-400 transition-colors"
                    >
                        <Trash2 size={9} />
                        Delete Preset
                    </button>
                </div>
            )}
        </div>
    );
}

function getCameraContext(viewer: Cesium.Viewer | null): AIImageCameraContext {
    if (!viewer || viewer.isDestroyed()) {
        return { lat: 0, lng: 0, height: 0, heading: 0, pitch: 0 };
    }
    const cart = viewer.camera.positionCartographic;
    return {
        lat: Cesium.Math.toDegrees(cart.latitude),
        lng: Cesium.Math.toDegrees(cart.longitude),
        height: cart.height,
        heading: Cesium.Math.toDegrees(viewer.camera.heading),
        pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
    };
}

// ===========================================================================
// Main panel
// ===========================================================================

export default function AIImagePanel({ embedded = false }: { embedded?: boolean }) {
    const isActive = useAIImageStore((s) => s.isActive);
    const setActive = useAIImageStore((s) => s.setActive);
    const hideObjects = useAIImageStore((s) => s.hideObjects);
    const setHideObjects = useAIImageStore((s) => s.setHideObjects);
    const autoFullscreen = useAIImageStore((s) => s.autoFullscreen);
    const setAutoFullscreen = useAIImageStore((s) => s.setAutoFullscreen);
    const gallery = useAIImageStore((s) => s.gallery);
    const setGallery = useAIImageStore((s) => s.setGallery);
    const addPending = useAIImageStore((s) => s.addPending);
    const completeEntry = useAIImageStore((s) => s.completeEntry);
    const failEntry = useAIImageStore((s) => s.failEntry);
    const setFullscreenEntry = useAIImageStore((s) => s.setFullscreenEntry);
    const presets = useAIImageStore((s) => s.presets);
    const addPreset = useAIImageStore((s) => s.addPreset);
    const tileMode = useTimelineStore((s) => s.tileMode);

    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        entry: GalleryEntry;
    } | null>(null);
    const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);

    const savedShowStates = useRef<Map<string, boolean>>(new Map());
    const savedPrimStates = useRef<Map<number, boolean>>(new Map());
    const savedGroundPrimStates = useRef<Map<number, boolean>>(new Map());
    const contextPreset = useMemo<Preset>(() => ({
        id: GLOBAL_CONTEXT_PRESET_ID,
        name: 'Prompt Context',
        prompt: '',
        model: '',
        ...AI_CONTEXT_DEFAULTS,
    }), []);
    const nearbyContext = useAIImageNearbyContext(contextPreset, viewer);

    useEffect(() => {
        if (!isActive) {
            setViewer(null);
            return;
        }
        const grabViewer = () => {
            const candidate = getGlobalViewer();
            if (candidate && !candidate.isDestroyed()) {
                setViewer((prev) => (prev === candidate ? prev : candidate));
            }
        };
        grabViewer();
        const timer = setInterval(grabViewer, 500);
        return () => clearInterval(timer);
    }, [isActive]);

    // --- Load gallery from backend on activation ---
    useEffect(() => {
        if (!isActive) return;
        fetch(`${API_URL}/api/ai-image/gallery`)
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((data) => {
                if (!Array.isArray(data)) return;
                const entries: GalleryEntry[] = (data as GalleryApiRecord[]).map((rec) => ({
                    id: rec.id,
                    serverId: rec.id,
                    timestamp: rec.timestamp,
                    presetName: rec.presetName || '',
                    prompt: rec.prompt || '',
                    model: rec.model || '',
                    viewport: rec.viewport,
                    status: 'completed' as const,
                    originalFile: rec.originalFile,
                    generatedFile: rec.generatedFile,
                    sourceGeometry: rec.sourceGeometry,
                    generatedGeometry: rec.generatedGeometry,
                    contextSnapshot: rec.contextSnapshot,
                }));
                const pending = useAIImageStore
                    .getState()
                    .gallery.filter((e) => e.status === 'pending');
                setGallery([...pending, ...entries]);
            })
            .catch((err) =>
                console.error('[AIImage] Gallery load failed:', err),
            );
    }, [isActive, setGallery]);

    // --- Hide / show all objects (DataSources + Primitives + GroundPrimitives) ---
    const hideAll = useCallback((viewer: Cesium.Viewer) => {
        // DataSources (most layers)
        savedShowStates.current.clear();
        for (let i = 0; i < viewer.dataSources.length; i++) {
            const ds = viewer.dataSources.get(i);
            savedShowStates.current.set(ds.name, ds.show);
            ds.show = false;
        }
        // scene.primitives (infrastructure BillboardCollections, pipelines, etc.)
        // Skip index 0 — that's the 3D tileset (Google/OSM) we want to keep visible
        savedPrimStates.current.clear();
        for (let i = 0; i < viewer.scene.primitives.length; i++) {
            const prim = viewer.scene.primitives.get(i);
            savedPrimStates.current.set(i, prim.show);
            // Keep 3D tilesets visible (Cesium3DTileset has 'asset' property)
            if (prim && typeof prim.asset !== 'undefined') continue;
            prim.show = false;
        }
        // groundPrimitives (power lines, cable polylines)
        savedGroundPrimStates.current.clear();
        for (let i = 0; i < viewer.scene.groundPrimitives.length; i++) {
            const prim = viewer.scene.groundPrimitives.get(i);
            savedGroundPrimStates.current.set(i, prim.show);
            prim.show = false;
        }
        viewer.scene.requestRender();
    }, []);

    const restoreAll = useCallback((viewer: Cesium.Viewer) => {
        if (savedShowStates.current.size > 0) {
            for (let i = 0; i < viewer.dataSources.length; i++) {
                const ds = viewer.dataSources.get(i);
                ds.show = savedShowStates.current.get(ds.name) ?? true;
            }
            savedShowStates.current.clear();
        }
        if (savedPrimStates.current.size > 0) {
            for (let i = 0; i < viewer.scene.primitives.length; i++) {
                const prim = viewer.scene.primitives.get(i);
                const saved = savedPrimStates.current.get(i);
                if (saved !== undefined) prim.show = saved;
            }
            savedPrimStates.current.clear();
        }
        if (savedGroundPrimStates.current.size > 0) {
            for (let i = 0; i < viewer.scene.groundPrimitives.length; i++) {
                const prim = viewer.scene.groundPrimitives.get(i);
                const saved = savedGroundPrimStates.current.get(i);
                if (saved !== undefined) prim.show = saved;
            }
            savedGroundPrimStates.current.clear();
        }
        viewer.scene.requestRender();
    }, []);

    useEffect(() => {
        const viewer = getGlobalViewer();
        if (!viewer || viewer.isDestroyed()) return;
        if (hideObjects && isActive) {
            hideAll(viewer);
        } else {
            restoreAll(viewer);
        }
    }, [hideObjects, isActive, hideAll, restoreAll]);

    // --- Restore on deactivate ---
    useEffect(() => {
        if (isActive) return;
        const viewer = getGlobalViewer();
        if (!viewer || viewer.isDestroyed()) return;
        restoreAll(viewer);
    }, [isActive, restoreAll]);

    // --- Capture with a preset (fire-and-forget, parallel) ---
    const captureWithPreset = useCallback(
        async (
            preset: Preset,
            resolvedPrompt: string,
            contextSnapshot: AIContextSnapshot | null,
        ) => {
            const clientId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

            let screenshot: string;
            let viewport: ViewportSnapshot;
            let sourceGeometry: AIImageSourceGeometry;
            let capabilities: AIImageModelCapabilities;
            try {
                capabilities = await fetchModelCapabilities(preset.model);
                const result = await captureScreenshot({
                    supportedAspectRatios: capabilities.supportedAspectRatios,
                });
                screenshot = result.dataUrl;
                viewport = result.viewport;
                sourceGeometry = result.sourceGeometry;
            } catch (err: unknown) {
                console.error('[AIImage] Screenshot failed:', err);
                return;
            }

            const entry: GalleryEntry = {
                id: clientId,
                timestamp: new Date().toISOString(),
                presetName: preset.name,
                prompt: resolvedPrompt,
                model: preset.model,
                viewport: { ...viewport, tileMode },
                status: 'pending',
                localScreenshot: screenshot,
                sourceGeometry,
                contextSnapshot: contextSnapshot ?? undefined,
            };
            addPending(entry);

            try {
                const response = await fetch(
                    `${API_URL}/api/ai-image/generate`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            screenshot,
                            viewport: { ...viewport, tileMode },
                            prompt: resolvedPrompt,
                            model: preset.model,
                            presetName: preset.name,
                            requestedAspectRatio: sourceGeometry.requestedAspectRatio,
                            sourceGeometry,
                            contextSnapshot,
                        }),
                    },
                );

                if (!response.ok) {
                    const body = await response.json().catch(() => ({})) as { error?: unknown };
                    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
                }

                const record = await response.json() as GenerateApiRecord;
                completeEntry(clientId, record);

                // Auto-fullscreen: show comparison slider
                if (useAIImageStore.getState().autoFullscreen) {
                    // Build a complete entry for fullscreen
                    const completed: GalleryEntry = {
                        ...entry,
                        serverId: record.id,
                        originalFile: record.originalFile,
                        generatedFile: record.generatedFile,
                        sourceGeometry: record.sourceGeometry ?? sourceGeometry,
                        generatedGeometry: record.generatedGeometry,
                        contextSnapshot: record.contextSnapshot ?? contextSnapshot ?? undefined,
                        status: 'completed',
                        localScreenshot: undefined,
                    };
                    setFullscreenEntry(completed);
                }
            } catch (err: unknown) {
                console.error('[AIImage] Generate failed:', err);
                failEntry(clientId, errorMessage(err, 'Generation failed'));
            }
        },
        [tileMode, addPending, completeEntry, failEntry, setFullscreenEntry],
    );

    const handleAddPreset = useCallback(() => {
        addPreset({
            id: `preset_${Date.now()}`,
            name: 'New Preset',
            prompt: 'Describe the desired image transformation…',
            model: 'google/gemini-3.1-flash-image-preview',
        });
    }, [addPreset]);

    const handleContextMenu = useCallback(
        (e: React.MouseEvent, entry: GalleryEntry) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, entry });
        },
        [],
    );

    if (!isActive) return null;

    return (
        <>
            <div className={embedded
                ? 'relative z-auto h-full min-h-0 w-full overflow-y-auto bg-transparent'
                : 'absolute top-4 right-4 z-20 w-80 max-h-[calc(100vh-32px)] overflow-y-auto bg-black/80 backdrop-blur-xl border border-zinc-800 rounded-lg shadow-2xl'}
            >
                {/* Header */}
                <div className={embedded ? 'hidden' : 'flex items-center justify-between px-3 py-2.5 border-b border-zinc-800 shrink-0'}>
                    <div className="flex items-center gap-2">
                        <Sparkles size={14} className="text-purple-400" />
                        <span className="text-xs font-mono font-semibold text-purple-300">
                            AI Vision
                        </span>
                    </div>
                    <button
                        onClick={() => setActive(false)}
                        className="text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                        <X size={14} />
                    </button>
                </div>

                <GlobalContextPanel nearby={nearbyContext} />

                {/* Preset buttons — vertical stack with edit icons */}
                <div className="px-3 py-2 border-b border-zinc-800 shrink-0 space-y-1.5">
                    {presets.map((preset) => (
                        <PresetRow
                            key={preset.id}
                            preset={preset}
                            viewer={viewer}
                            contextSnapshot={nearbyContext.snapshot}
                            onCapture={(resolvedPrompt, contextSnapshot) =>
                                captureWithPreset(preset, resolvedPrompt, contextSnapshot)
                            }
                        />
                    ))}
                    <button
                        onClick={handleAddPreset}
                        className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-mono text-zinc-500 hover:text-purple-300 border border-dashed border-zinc-700 hover:border-purple-700/50 rounded-md transition-colors"
                    >
                        <Plus size={10} />
                        Add Preset
                    </button>
                </div>

                {/* Options */}
                <div className="px-3 py-2 border-b border-zinc-800 space-y-1.5 shrink-0">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={hideObjects}
                            onChange={(e) => setHideObjects(e.target.checked)}
                            className="sr-only peer"
                        />
                        <div className="w-3.5 h-3.5 rounded border border-zinc-700 bg-zinc-900 peer-checked:bg-purple-600/40 peer-checked:border-purple-500 flex items-center justify-center transition-colors">
                            {hideObjects && (
                                <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                                    <path d="M2 5L4 7L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-purple-300" />
                                </svg>
                            )}
                        </div>
                        <span className="text-[10px] font-mono text-zinc-400 flex items-center gap-1">
                            {hideObjects ? <EyeOff size={11} /> : <Eye size={11} />}
                            Hide All Objects
                        </span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={autoFullscreen}
                            onChange={(e) => setAutoFullscreen(e.target.checked)}
                            className="sr-only peer"
                        />
                        <div className="w-3.5 h-3.5 rounded border border-zinc-700 bg-zinc-900 peer-checked:bg-purple-600/40 peer-checked:border-purple-500 flex items-center justify-center transition-colors">
                            {autoFullscreen && (
                                <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                                    <path d="M2 5L4 7L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-purple-300" />
                                </svg>
                            )}
                        </div>
                        <span className="text-[10px] font-mono text-zinc-400 flex items-center gap-1">
                            <Maximize2 size={11} />
                            Auto Compare on Generate
                        </span>
                    </label>
                </div>

                {/* Gallery */}
                <div className="min-h-0">
                    <div className="px-3 py-2">
                        <p className="text-[10px] font-mono text-zinc-600 mb-2">
                            Gallery ({gallery.length} capture{gallery.length !== 1 ? 's' : ''})
                        </p>
                        {gallery.length === 0 ? (
                            <p className="text-[10px] font-mono text-zinc-700 text-center py-8">
                                No images yet.
                                <br />
                                Navigate the globe and press a preset button.
                            </p>
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                {gallery.map((entry) => (
                                    <GalleryItem
                                        key={entry.id}
                                        entry={entry}
                                        onContextMenu={(e) => handleContextMenu(e, entry)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    entry={contextMenu.entry}
                    onClose={() => setContextMenu(null)}
                />
            )}

            <FullscreenOverlay />
        </>
    );
}
