import { create } from 'zustand';

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

/** A generation preset — each becomes a capture button in the panel. */
export interface Preset {
    id: string;
    name: string;
    prompt: string;
    model: string;
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
    error?: string;
}

// ---------------------------------------------------------------------------
// Presets persistence (localStorage)
// ---------------------------------------------------------------------------

const PRESETS_KEY = 'ai-vision-presets';

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
    completeEntry: (clientId: string, server: { id: string; originalFile: string; generatedFile: string }) => void;
    /** Mark entry as failed. */
    failEntry: (clientId: string, error: string) => void;
    removeEntry: (clientId: string) => void;
    setFullscreenEntry: (entry: GalleryEntry | null) => void;

    // Preset CRUD
    addPreset: (preset: Preset) => void;
    updatePreset: (id: string, updates: Partial<Omit<Preset, 'id'>>) => void;
    removePreset: (id: string) => void;
    reorderPresets: (presets: Preset[]) => void;
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
        set({ presets: next });
    },
    updatePreset: (id, updates) => {
        const next = get().presets.map((p) =>
            p.id === id ? { ...p, ...updates } : p,
        );
        savePresets(next);
        set({ presets: next });
    },
    removePreset: (id) => {
        const next = get().presets.filter((p) => p.id !== id);
        savePresets(next);
        set({ presets: next });
    },
    reorderPresets: (presets) => {
        savePresets(presets);
        set({ presets });
    },
}));
