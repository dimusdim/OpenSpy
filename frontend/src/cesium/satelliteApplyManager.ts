import * as Cesium from 'cesium';
import { useTimelineStore } from '../store/useTimelineStore';
import { perfLog } from '../lib/perf-log';
import type { SatellitePositionsSAB } from './satellitePositionsSAB';

const PINNED_CESIUM_VERSION = '1.140.0';
const RUNTIME_CESIUM_VERSION = (Cesium as unknown as { VERSION?: string }).VERSION ?? null;

if (RUNTIME_CESIUM_VERSION !== PINNED_CESIUM_VERSION) {
    throw new Error(
        `[satelliteApplyManager] Cesium version mismatch: expected ${PINNED_CESIUM_VERSION}, got ${RUNTIME_CESIUM_VERSION}. ` +
        'Fast billboard path depends on private Cesium internals and must be revalidated on upgrade.',
    );
}

export type SatelliteApplySlot = {
    index: number;
    targetId: string;
    billboard: Cesium.Billboard;
    scratch: Cesium.Cartesian3;
    // Optional per-slot Cartographic scratch. When present, updateMeta should
    // pass it as the 3rd arg to Cesium.Cartographic.fromCartesian to avoid
    // allocating a fresh Cartographic per billboard per frame.
    cartoScratch?: Cesium.Cartographic;
    // Wall-clock timestamp of the last updateMeta invocation. Used by callers
    // that throttle lat/lng recomputation (metadata doesn't need 60fps freshness).
    lastMetaUpdateMs?: number;
    getVisible?: () => boolean;
    updateMeta?: (position: Cesium.Cartesian3) => void;
};

type SatelliteApplySource = {
    getState: () => {
        sab: SatellitePositionsSAB | null;
        slots: SatelliteApplySlot[];
        epochMs: number | null;
    };
    isActive: () => boolean;
    beforeApply?: (currentTimeMs: number) => void;
    measureName?: string | null;
    applyVisibility?: boolean;
    applyMeta?: boolean;
};

type ApplyProgress = {
    epochMs: number;
    cursor: number;
    completed: boolean;
};

type MutableBillboard = Cesium.Billboard & {
    // Cesium 1.140.0 private layout: if upgrading, revalidate billboard internals before using fast path.
    _position?: Cesium.Cartesian3;
    // Cesium 1.140.0 private layout: mirrors _position for unclamped billboards.
    _actualPosition?: Cesium.Cartesian3;
    // Cesium 1.140.0 private layout: when set, public setter path must be used instead.
    _clampedPosition?: Cesium.Cartesian3;
    // Cesium 1.140.0 private layout: private collection callback used by makeDirty().
    _billboardCollection?: {
        _updateBillboard?: (billboard: Cesium.Billboard, propertyChanged: number) => void;
    };
    // Cesium 1.140.0 private layout: dirty bit consumed by BillboardCollection update path.
    _dirty?: boolean;
};

// Cesium 1.140.0 private constant: typings omit it, but runtime exposes POSITION_INDEX for dirty updates.
const BILLBOARD_POSITION_INDEX = (Cesium.Billboard as unknown as { POSITION_INDEX?: number }).POSITION_INDEX ?? 1;

export function applyFastBillboardPosition(slot: SatelliteApplySlot, x: number, y: number, z: number) {
    const billboard = slot.billboard as MutableBillboard;
    const position = billboard._position;
    const actualPosition = billboard._actualPosition;
    if (!position || !actualPosition || billboard._clampedPosition) {
        slot.scratch.x = x;
        slot.scratch.y = y;
        slot.scratch.z = z;
        slot.billboard.position = slot.scratch;
        return;
    }
    if (position.x === x && position.y === y && position.z === z) return;
    position.x = x;
    position.y = y;
    position.z = z;
    actualPosition.x = x;
    actualPosition.y = y;
    actualPosition.z = z;
    billboard._billboardCollection?._updateBillboard?.(billboard, BILLBOARD_POSITION_INDEX);
    billboard._dirty = true;
    slot.scratch.x = x;
    slot.scratch.y = y;
    slot.scratch.z = z;
}

class SatelliteApplyManager {
    private readonly sources = new Map<string, SatelliteApplySource>();
    private readonly applyProgress = new Map<string, ApplyProgress>();
    private readonly removeCallback: Cesium.Event.RemoveCallback;

    constructor(private readonly scene: Cesium.Scene) {
        this.removeCallback = scene.preRender.addEventListener(this.handlePreRender);
    }

    setSource(key: string, source: SatelliteApplySource | null) {
        if (!source) {
            this.sources.delete(key);
            this.applyProgress.delete(key);
            return;
        }
        this.sources.set(key, source);
    }

    destroy() {
        this.removeCallback();
        this.sources.clear();
        this.applyProgress.clear();
    }

    private readonly handlePreRender = (_scene: Cesium.Scene, time: Cesium.JulianDate) => {
        const state = useTimelineStore.getState();
        const sourceKey = state.mode === 'playback' && state.playbackKind === 'historical'
            ? 'replay'
            : 'live';
        const source = this.sources.get(sourceKey);
        if (!source || !source.isActive()) return;

        // Diagnostic: this preRender callback iterates ~18k satellite slots
        // and mutates billboards on main thread. Codex review (2026-04-21)
        // ranked it as #2 suspect for 7-10 s longtasks. Threshold 50 ms.
        const tStart = performance.now();

        const currentTimeMs = Cesium.JulianDate.toDate(time).getTime();
        source.beforeApply?.(currentTimeMs);

        const { sab, slots, epochMs } = source.getState();
        if (!sab || !Number.isFinite(epochMs ?? NaN)) return;
        const epoch = epochMs!;
        let progress = this.applyProgress.get(sourceKey);
        if (!progress || progress.epochMs !== epoch) {
            progress = {
                epochMs: epoch,
                cursor: 0,
                completed: false,
            };
            this.applyProgress.set(sourceKey, progress);
        }
        if (progress.completed) return;

        const markName = source.measureName;
        const applyVisibility = source.applyVisibility === true;
        const applyMeta = source.applyMeta === true;
        if (markName) performance.mark(`${markName}:start`);

        const view = sab.view;
        let appliedCount = 0;
        const nowMs = performance.now();
        // Throttle updateMeta to ~250 ms per slot. `updateMeta` recomputes
        // lat/lng/alt for hover/details panels via Cesium.Cartographic.
        // Before throttling, 5000 satellite slots (and 30k motion slots)
        // paid that cost on every epoch update — a large main-thread cost
        // even after the cartoScratch fix removed the per-slot allocation.
        // Hover panels don't need 60 fps metadata freshness.
        const META_THROTTLE_MS = 250;
        // Keep satellite position application below one frame slice. The full
        // catalog can be ~20k billboards; applying it in fewer, longer chunks
        // makes globe rotation stutter even when average FPS still looks OK.
        const APPLY_BUDGET_MS = 6;
        const APPLY_CHECK_EVERY = 128;
        const startCursor = progress.cursor;
        for (let slotIndex = progress.cursor; slotIndex < slots.length; slotIndex += 1) {
            const slot = slots[slotIndex];
            progress.cursor = slotIndex + 1;
            const offset = slot.index * 3;
            const x = view[offset];
            const y = view[offset + 1];
            const z = view[offset + 2];
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                applyFastBillboardPosition(slot, x, y, z);
                if (applyVisibility && slot.getVisible) slot.billboard.show = slot.getVisible();
                if (applyMeta && slot.updateMeta) {
                    const lastMeta = slot.lastMetaUpdateMs ?? 0;
                    if (nowMs - lastMeta >= META_THROTTLE_MS) {
                        slot.updateMeta(slot.scratch);
                        slot.lastMetaUpdateMs = nowMs;
                    }
                }
                appliedCount += 1;
            }
            if ((slotIndex + 1) % APPLY_CHECK_EVERY === 0 && performance.now() - tStart >= APPLY_BUDGET_MS) {
                break;
            }
        }

        progress.completed = progress.cursor >= slots.length;
        if (markName) {
            performance.mark(`${markName}:end`);
            performance.measure(markName, `${markName}:start`, `${markName}:end`);
        }
        const ms = performance.now() - tStart;
        if (ms > 50) {
            perfLog('suspect.block', {
                name: 'SatelliteApplyManager.handlePreRender',
                ms: Math.round(ms),
                sourceKey,
                slots: slots.length,
                applied: appliedCount,
                cursor: progress.cursor,
                startedAt: startCursor,
                completed: progress.completed,
                applyVisibility,
                applyMeta,
            });
        }
        if (typeof window !== 'undefined') {
            (window as any).__openspySatelliteApplyStats = {
                sourceKey,
                epochMs: epoch,
                slots: slots.length,
                cursor: progress.cursor,
                completed: progress.completed,
                appliedLastPass: appliedCount,
                lastPassMs: Math.round(ms),
            };
        }
        if (!progress.completed) {
            this.scene.requestRender();
        }
    };
}

const managerByScene = new WeakMap<Cesium.Scene, SatelliteApplyManager>();

export function setSatelliteApplySource(
    scene: Cesium.Scene,
    key: 'live' | 'replay',
    source: SatelliteApplySource | null,
) {
    let manager = managerByScene.get(scene);
    if (!manager && source) {
        manager = new SatelliteApplyManager(scene);
        managerByScene.set(scene, manager);
    }
    manager?.setSource(key, source);
}

export function clearSatelliteApplySource(scene: Cesium.Scene, key: 'live' | 'replay') {
    const manager = managerByScene.get(scene);
    manager?.setSource(key, null);
}

export function destroySatelliteApplyManager(scene: Cesium.Scene) {
    const manager = managerByScene.get(scene);
    if (!manager) return;
    manager.destroy();
    managerByScene.delete(scene);
}
