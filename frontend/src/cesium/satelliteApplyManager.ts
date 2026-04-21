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

function applyFastBillboardPosition(slot: SatelliteApplySlot, x: number, y: number, z: number) {
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
    private readonly lastAppliedEpochMs = new Map<string, number>();
    private readonly removeCallback: Cesium.Event.RemoveCallback;

    constructor(private readonly scene: Cesium.Scene) {
        this.removeCallback = scene.preRender.addEventListener(this.handlePreRender);
    }

    setSource(key: string, source: SatelliteApplySource | null) {
        if (!source) {
            this.sources.delete(key);
            this.lastAppliedEpochMs.delete(key);
            return;
        }
        this.sources.set(key, source);
    }

    destroy() {
        this.removeCallback();
        this.sources.clear();
        this.lastAppliedEpochMs.clear();
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
        if (this.lastAppliedEpochMs.get(sourceKey) === epochMs) return;

        const markName = source.measureName;
        const applyVisibility = source.applyVisibility === true;
        const applyMeta = source.applyMeta === true;
        if (markName) performance.mark(`${markName}:start`);

        const view = sab.view;
        let appliedCount = 0;
        for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
            const slot = slots[slotIndex];
            const offset = slot.index * 3;
            const x = view[offset];
            const y = view[offset + 1];
            const z = view[offset + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            applyFastBillboardPosition(slot, x, y, z);
            if (applyVisibility && slot.getVisible) slot.billboard.show = slot.getVisible();
            if (applyMeta) slot.updateMeta?.(slot.scratch);
            appliedCount += 1;
        }

        this.lastAppliedEpochMs.set(sourceKey, epochMs!);
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
                applyVisibility,
                applyMeta,
            });
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
