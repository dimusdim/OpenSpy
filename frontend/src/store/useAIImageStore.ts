import { create } from 'zustand';
import { API_URL } from '../lib/config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ViewportData {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
    tileMode: 'google' | 'osm' | 'modis';
}

export type AIContextSourceId =
    | 'infrastructure'
    | 'aircraft'
    | 'vessels'
    | 'pipelines'
    | 'fires'
    | 'cables'
    | 'airspace'
    | 'webcams'
    | 'wifi'
    | 'satellites'
    | 'replay';

export const AI_CONTEXT_SOURCES: AIContextSourceId[] = [
    'infrastructure',
    'aircraft',
    'vessels',
    'pipelines',
    'fires',
    'cables',
    'airspace',
    'webcams',
    'wifi',
    'satellites',
    'replay',
];

export type AIContextMode = 'none' | 'optional' | 'required';
export type AIContextSearchCenter = 'cameraPosition' | 'viewportGroundTarget';

export interface AIContextObject {
    id: string;
    sourceId: AIContextSourceId;
    sourceLabel: string;
    name: string;
    type: string;
    subtype?: string | null;
    lat: number;
    lng: number;
    alt?: number | null;
    distanceM: number;
    description?: string | null;
    fields?: Record<string, string | number | boolean | null>;
}

export interface AIContextSnapshot {
    mode: AIContextMode;
    center: { lat: number; lng: number };
    searchCenter: AIContextSearchCenter;
    radiusM: number;
    selected: AIContextObject[];
    candidatesCount: number;
    excludedCount: number;
    generatedAt: string;
}

/** A generation preset — each becomes a capture button in the panel. */
export interface Preset {
    id: string;
    name: string;
    prompt: string;
    model: string;
    contextMode?: AIContextMode;
    searchCenter?: AIContextSearchCenter;
    searchRadiusM?: number;
    contextSources?: AIContextSourceId[];
    maxContextObjects?: number;
    injectCameraContext?: boolean;
    includeSourceInContext?: boolean;
}

/** Gallery entry — lives client-side; may be pending, completed, or errored. */
export interface GalleryEntry {
    /** Stable client-side key (never changes once created). */
    id: string;
    /** Backend record ID — set when generation completes. */
    serverId?: string;
    timestamp: string;
    presetName: string;
    prompt: string;
    model: string;
    viewport: ViewportData;
    status: 'pending' | 'completed' | 'error';
    /** Base64 data-URL of the Cesium canvas — kept while pending, cleared after. */
    localScreenshot?: string;
    /** Backend filenames — populated on completion. */
    originalFile?: string;
    generatedFile?: string;
    contextSnapshot?: AIContextSnapshot;
    error?: string;
}

export const AI_CONTEXT_OBJECT_LIST_LIMIT = 6;
export const MAX_AI_CONTEXT_OBJECTS = AI_CONTEXT_OBJECT_LIST_LIMIT;

export const AI_CONTEXT_DEFAULTS = {
    contextMode: 'optional' as AIContextMode,
    searchCenter: 'cameraPosition' as AIContextSearchCenter,
    searchRadiusM: 200,
    contextSources: [...AI_CONTEXT_SOURCES],
    maxContextObjects: AI_CONTEXT_OBJECT_LIST_LIMIT,
    injectCameraContext: true,
    includeSourceInContext: true,
};

export interface ExcludedContextObject {
    sourceId: AIContextSourceId;
    lastSeenAt: number;
}

const EXCLUDED_CAP_PER_PRESET = 500;

// ---------------------------------------------------------------------------
// Presets persistence (localStorage)
// ---------------------------------------------------------------------------

const PRESETS_KEY = 'ai-vision-presets';
const PRESETS_API = `${API_URL}/api/ai-image/presets`;
const PRESETS_DEBOUNCE_MS = 500;

const DEFAULT_PRESETS: Preset[] = [
    {
        id: 'blueprint',
        name: '3D Blueprint',
        prompt:
            'Transform this satellite/aerial view into a 3D wireframe blueprint illustration. ' +
            'Use clean cyan lines on dark background, technical drawing style with depth and ' +
            'perspective preserved. High-tech command center visualization aesthetic.',
        model: 'google/gemini-3.1-flash-image-preview',
    },
    {
        id: 'enhance',
        name: 'Restore & Enhance',
        prompt:
            'Enhance this satellite/aerial image. Increase resolution and sharpen features. ' +
            'Restore fine details, improve clarity. Maintain original color palette and geographic accuracy.',
        model: 'google/gemini-3.1-flash-image-preview',
    },
    {
        id: 'flux-max',
        name: 'FLUX Enhance',
        prompt:
            'Create a high-fidelity enhanced version of this satellite/aerial view. ' +
            'Maximize detail and clarity while preserving geographic accuracy.',
        model: 'black-forest-labs/flux.2-max',
    },
    {
        id: 'flux-tactical',
        name: 'FLUX Tactical',
        prompt:
            'Transform this aerial/satellite view into a military tactical operations map. ' +
            'Neon green HUD overlay on dark background, grid coordinates, threat zones highlighted in red, ' +
            'friendly zones in blue, terrain contour lines, elevation markers. ' +
            'Style of a real-time command center display with data readouts and targeting reticles.',
        model: 'black-forest-labs/flux.2-max',
    },
];

function loadPresets(): Preset[] {
    if (typeof window === 'undefined') return DEFAULT_PRESETS;
    try {
        const raw = localStorage.getItem(PRESETS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                // Merge: add any default presets missing from saved set
                const savedIds = new Set(parsed.map((p: Preset) => p.id));
                const missing = DEFAULT_PRESETS.filter((d) => !savedIds.has(d.id));
                if (missing.length > 0) {
                    const merged = [...parsed, ...missing];
                    savePresets(merged);
                    return merged;
                }
                return parsed;
            }
        }
    } catch { /* ignore */ }
    return DEFAULT_PRESETS;
}

function savePresets(presets: Preset[]): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

interface ServerPresetsPayload {
    schemaVersion?: number;
    presets?: Preset[];
}

async function fetchPresetsFromServer(): Promise<Preset[] | null> {
    if (typeof window === 'undefined') return null;
    try {
        const res = await fetch(PRESETS_API);
        if (!res.ok) return null;
        const body: ServerPresetsPayload = await res.json();
        return Array.isArray(body?.presets) ? body.presets : null;
    } catch {
        return null;
    }
}

async function uploadPresetsToServer(presets: Preset[]): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    try {
        const res = await fetch(PRESETS_API, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schemaVersion: 1, presets }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

let saveRemoteTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedUploadPresets(presets: Preset[]): void {
    if (saveRemoteTimer) clearTimeout(saveRemoteTimer);
    saveRemoteTimer = setTimeout(() => {
        saveRemoteTimer = null;
        void uploadPresetsToServer(presets);
    }, PRESETS_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AIImageStore {
    isActive: boolean;
    hideObjects: boolean;
    autoFullscreen: boolean;
    gallery: GalleryEntry[];
    presets: Preset[];
    /** Entry shown fullscreen with before/after slider (null = hidden). */
    fullscreenEntry: GalleryEntry | null;
    /** Opacity of the generated overlay in fullscreen comparison (0–100). */
    overlayOpacity: number;

    setActive: (active: boolean) => void;
    setHideObjects: (hide: boolean) => void;
    setAutoFullscreen: (auto: boolean) => void;
    setOverlayOpacity: (pct: number) => void;
    setGallery: (gallery: GalleryEntry[]) => void;
    /** Add a pending entry (screenshot captured, generation in flight). */
    addPending: (entry: GalleryEntry) => void;
    /** Mark entry as completed with backend data. */
    completeEntry: (clientId: string, server: { id: string; originalFile: string; generatedFile: string; contextSnapshot?: AIContextSnapshot }) => void;
    /** Mark entry as failed. */
    failEntry: (clientId: string, error: string) => void;
    removeEntry: (clientId: string) => void;
    setFullscreenEntry: (entry: GalleryEntry | null) => void;

    // Preset CRUD
    addPreset: (preset: Preset) => void;
    updatePreset: (id: string, updates: Partial<Omit<Preset, 'id'>>) => void;
    removePreset: (id: string) => void;
    reorderPresets: (presets: Preset[]) => void;
    syncPresetsFromServer: () => Promise<void>;

    excludedContextObjects: Record<string, Record<string, ExcludedContextObject>>;
    toggleExcludedContextObject: (presetId: string, objectId: string, sourceId: AIContextSourceId) => void;
    clearExcludedContextObjects: (presetId: string) => void;
    bumpExcludedContextObjectsSeen: (
        presetId: string,
        seen: Array<{ id: string; sourceId: AIContextSourceId }>,
    ) => void;
}

export const useAIImageStore = create<AIImageStore>((set, get) => ({
    isActive: false,
    hideObjects: true,
    autoFullscreen: false,
    gallery: [],
    presets: loadPresets(),
    fullscreenEntry: null,
    overlayOpacity: typeof window !== 'undefined'
        ? Number(localStorage.getItem('ai-vision-overlay-opacity') ?? '100')
        : 100,

    setActive: (isActive) => set({ isActive }),
    setHideObjects: (hideObjects) => set({ hideObjects }),
    setAutoFullscreen: (autoFullscreen) => set({ autoFullscreen }),
    setOverlayOpacity: (overlayOpacity) => {
        set({ overlayOpacity });
        if (typeof window !== 'undefined') {
            localStorage.setItem('ai-vision-overlay-opacity', String(overlayOpacity));
        }
    },

    setGallery: (gallery) => set({ gallery }),

    addPending: (entry) =>
        set((s) => ({ gallery: [entry, ...s.gallery] })),

    completeEntry: (clientId, server) =>
        set((s) => ({
            gallery: s.gallery.map((e) =>
                e.id === clientId
                    ? {
                          ...e,
                          serverId: server.id,
                          originalFile: server.originalFile,
                          generatedFile: server.generatedFile,
                          contextSnapshot: server.contextSnapshot ?? e.contextSnapshot,
                          status: 'completed' as const,
                          localScreenshot: undefined, // free memory
                      }
                    : e,
            ),
        })),

    failEntry: (clientId, error) =>
        set((s) => ({
            gallery: s.gallery.map((e) =>
                e.id === clientId
                    ? { ...e, status: 'error' as const, error }
                    : e,
            ),
        })),

    removeEntry: (clientId) =>
        set((s) => ({ gallery: s.gallery.filter((e) => e.id !== clientId) })),

    setFullscreenEntry: (fullscreenEntry) => set({ fullscreenEntry }),

    // --- Presets ---
    addPreset: (preset) => {
        const next = [...get().presets, preset];
        savePresets(next);
        debouncedUploadPresets(next);
        set({ presets: next });
    },
    updatePreset: (id, updates) => {
        const next = get().presets.map((p) =>
            p.id === id ? { ...p, ...updates } : p,
        );
        savePresets(next);
        debouncedUploadPresets(next);
        set({ presets: next });
    },
    removePreset: (id) => {
        const next = get().presets.filter((p) => p.id !== id);
        savePresets(next);
        debouncedUploadPresets(next);
        set({ presets: next });
    },
    reorderPresets: (presets) => {
        savePresets(presets);
        debouncedUploadPresets(presets);
        set({ presets });
    },
    syncPresetsFromServer: async () => {
        const fromServer = await fetchPresetsFromServer();
        if (fromServer && fromServer.length > 0) {
            savePresets(fromServer);
            set({ presets: fromServer });
            return;
        }
        if (fromServer === null) return;

        const local = get().presets;
        const isJustDefaults =
            local.length === DEFAULT_PRESETS.length &&
            local.every((p, i) => p.id === DEFAULT_PRESETS[i]?.id && p.prompt === DEFAULT_PRESETS[i]?.prompt);
        if (!isJustDefaults && local.length > 0) {
            void uploadPresetsToServer(local);
        }
    },

    excludedContextObjects: {},
    toggleExcludedContextObject: (presetId, objectId, sourceId) =>
        set((s) => {
            const forPreset = { ...(s.excludedContextObjects[presetId] ?? {}) };
            if (forPreset[objectId]) {
                delete forPreset[objectId];
            } else {
                forPreset[objectId] = { sourceId, lastSeenAt: Date.now() };
            }
            return {
                excludedContextObjects: {
                    ...s.excludedContextObjects,
                    [presetId]: forPreset,
                },
            };
        }),
    clearExcludedContextObjects: (presetId) =>
        set((s) => {
            if (!s.excludedContextObjects[presetId]) return s;
            const next = { ...s.excludedContextObjects };
            delete next[presetId];
            return { excludedContextObjects: next };
        }),
    bumpExcludedContextObjectsSeen: (presetId, seen) =>
        set((s) => {
            const forPreset = s.excludedContextObjects[presetId];
            if (!forPreset || seen.length === 0) return s;
            const now = Date.now();
            let changed = false;
            const next: Record<string, ExcludedContextObject> = { ...forPreset };
            for (const { id } of seen) {
                if (!next[id]) continue;
                next[id] = { ...next[id], lastSeenAt: now };
                changed = true;
            }
            if (!changed) return s;
            const keys = Object.keys(next);
            if (keys.length > EXCLUDED_CAP_PER_PRESET) {
                keys.sort((a, b) => next[a].lastSeenAt - next[b].lastSeenAt);
                for (let i = 0; i < keys.length - EXCLUDED_CAP_PER_PRESET; i++) {
                    delete next[keys[i]];
                }
            }
            return {
                excludedContextObjects: {
                    ...s.excludedContextObjects,
                    [presetId]: next,
                },
            };
        }),
}));

if (typeof window !== 'undefined') {
    queueMicrotask(() => {
        void useAIImageStore.getState().syncPresetsFromServer();
    });
}
