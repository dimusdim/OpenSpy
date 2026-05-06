import * as Cesium from 'cesium';
import { perfLog } from '@/lib/perf-log';

export type ReplayShapeDescriptor = {
    id: string;
    logicalId: string;
    kind: 'polyline' | 'polygon';
    signature: string;
    name: string;
    visible: boolean;
    layer: string;
    subtype: string | null;
    source: string | null;
    description: string;
    positions?: Cesium.Cartesian3[];
    width?: number;
    stroke?: Cesium.Color;
    hierarchy?: Cesium.PolygonHierarchy;
    fill?: Cesium.Color;
};

type ReplayShapeBatchOptions = {
    scene: Cesium.Scene;
    layerKey: string;
    onRebuild?: () => void;
    minRebuildIntervalMs?: number;
};

type StoredDescriptor = ReplayShapeDescriptor & {
    visible: boolean;
};

function cloneHierarchy(hierarchy: Cesium.PolygonHierarchy | undefined): Cesium.PolygonHierarchy | undefined {
    if (!hierarchy) return undefined;
    const positions = hierarchy.positions.map((position) => Cesium.Cartesian3.clone(position));
    const holes = (hierarchy.holes || []).map((hole) => cloneHierarchy(hole)!);
    return new Cesium.PolygonHierarchy(positions, holes);
}

function cloneDescriptor(descriptor: ReplayShapeDescriptor): StoredDescriptor {
    return {
        ...descriptor,
        positions: descriptor.positions?.map((position) => Cesium.Cartesian3.clone(position)),
        hierarchy: cloneHierarchy(descriptor.hierarchy),
        fill: descriptor.fill ? Cesium.Color.clone(descriptor.fill) : undefined,
        stroke: descriptor.stroke ? Cesium.Color.clone(descriptor.stroke) : undefined,
    };
}

export class ReplayShapeBatch {
    private readonly scene: Cesium.Scene;
    private readonly layerKey: string;
    private readonly onRebuild?: () => void;
    private readonly minRebuildIntervalMs: number;
    private descriptors = new Map<string, StoredDescriptor>();
    private dirty = false;
    private lastRebuildAt = 0;
    private polygonFillPrimitive: Cesium.Primitive | null = null;
    private polygonOutlinePrimitive: Cesium.Primitive | null = null;
    private polylinePrimitive: Cesium.GroundPolylinePrimitive | null = null;

    constructor(options: ReplayShapeBatchOptions) {
        this.scene = options.scene;
        this.layerKey = options.layerKey;
        this.onRebuild = options.onRebuild;
        this.minRebuildIntervalMs = options.minRebuildIntervalMs ?? 100;
    }

    upsert(id: string, descriptor: ReplayShapeDescriptor): 'skip' | 'visibility' | 'dirty' {
        const existing = this.descriptors.get(id);
        if (!existing) {
            this.descriptors.set(id, cloneDescriptor(descriptor));
            this.dirty = true;
            return 'dirty';
        }

        if (existing.signature === descriptor.signature && existing.kind === descriptor.kind) {
            if (existing.visible !== descriptor.visible) {
                existing.visible = descriptor.visible;
                existing.name = descriptor.name;
                existing.layer = descriptor.layer;
                existing.subtype = descriptor.subtype;
                existing.source = descriptor.source;
                existing.description = descriptor.description;
                this.setVisible(id, descriptor.visible);
                return 'visibility';
            }
            return 'skip';
        }

        this.descriptors.set(id, cloneDescriptor(descriptor));
        this.dirty = true;
        return 'dirty';
    }

    remove(id: string): void {
        if (!this.descriptors.delete(id)) return;
        this.dirty = true;
    }

    setVisible(id: string, visible: boolean): void {
        const existing = this.descriptors.get(id);
        if (!existing) return;
        existing.visible = visible;

        const showValue = Cesium.ShowGeometryInstanceAttribute.toValue(visible);
        let updated = false;

        // Async primitives (asynchronous: true in rebuildIfDirty) throw
        // DeveloperError from getGeometryInstanceAttributes until the first
        // update tick flips `ready`. Guard on ready + try/catch to survive
        // visibility toggles during the ~50–200 ms async build window.
        // Falling back to dirty=true re-queues a rebuild so the descriptor's
        // new visibility is baked in via fresh ShowGeometryInstanceAttribute.
        const safeGetAttrs = (
            prim: Cesium.Primitive | Cesium.GroundPolylinePrimitive | null,
        ): any => {
            if (!prim) return null;
            if (!(prim as any).ready) return null;
            try {
                return prim.getGeometryInstanceAttributes(id);
            } catch {
                return null;
            }
        };

        const polygonFillAttrs = safeGetAttrs(this.polygonFillPrimitive);
        if (polygonFillAttrs) {
            polygonFillAttrs.show = showValue;
            updated = true;
        }
        const polygonOutlineAttrs = safeGetAttrs(this.polygonOutlinePrimitive);
        if (polygonOutlineAttrs) {
            polygonOutlineAttrs.show = showValue;
            updated = true;
        }
        const polylineAttrs = safeGetAttrs(this.polylinePrimitive);
        if (polylineAttrs) {
            polylineAttrs.show = showValue;
            updated = true;
        }

        if (!updated) {
            this.dirty = true;
        }
    }

    rebuildIfDirty(now = performance.now()): boolean {
        if (!this.dirty) return false;
        if (now - this.lastRebuildAt < this.minRebuildIntervalMs) return false;

        // Diagnostic instrumentation: rebuildIfDirty fires from preRender and
        // historically does synchronous Primitive construction with
        // asynchronous:false. Codex review (2026-04-21) flagged it as a likely
        // source of longtasks during replay hydration.
        // Threshold 50 ms = above one frame budget at 60 FPS but below the
        // longtask threshold (100 ms) so we catch borderline cases.
        const tStart = performance.now();
        let descriptorCount = 0;
        try {
            descriptorCount = this.descriptors.size;
        } catch {}

        const polygonFillInstances: Cesium.GeometryInstance[] = [];
        const polygonOutlineInstances: Cesium.GeometryInstance[] = [];
        const polylineInstances: Cesium.GeometryInstance[] = [];

        this.descriptors.forEach((descriptor, id) => {
            if (descriptor.kind === 'polygon' && descriptor.hierarchy && descriptor.fill && descriptor.stroke) {
                polygonFillInstances.push(new Cesium.GeometryInstance({
                    id,
                    geometry: new Cesium.PolygonGeometry({
                        polygonHierarchy: descriptor.hierarchy,
                        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                    }),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(descriptor.fill),
                        show: new Cesium.ShowGeometryInstanceAttribute(descriptor.visible),
                    },
                }));
                polygonOutlineInstances.push(new Cesium.GeometryInstance({
                    id,
                    geometry: new Cesium.PolygonOutlineGeometry({
                        polygonHierarchy: descriptor.hierarchy,
                    }),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(descriptor.stroke),
                        show: new Cesium.ShowGeometryInstanceAttribute(descriptor.visible),
                    },
                }));
                return;
            }

            if (descriptor.kind === 'polyline' && descriptor.positions && descriptor.stroke) {
                polylineInstances.push(new Cesium.GeometryInstance({
                    id,
                    geometry: new Cesium.GroundPolylineGeometry({
                        positions: descriptor.positions,
                        width: descriptor.width ?? 2,
                    }),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(descriptor.stroke),
                        show: new Cesium.ShowGeometryInstanceAttribute(descriptor.visible),
                    },
                }));
            }
        });

        const nextPolygonFill = polygonFillInstances.length > 0
            ? new Cesium.Primitive({
                geometryInstances: polygonFillInstances,
                appearance: new Cesium.PerInstanceColorAppearance({
                    translucent: true,
                    closed: false,
                }),
                // Build geometry off the main thread in Cesium's worker pool.
                // Before this change: a single airspace rebuild with ~10k
                // polygon instances produced a 5.7s synchronous longtask in
                // `CesiumPrimitive.update` on the main thread — the largest
                // source of "browser freezes" observed in replay after the
                // billboard fast-path + scratch fixes. Trade-off: the first
                // render tick after rebuild may show the shape batch as
                // still-building (invisible for ~50–200 ms); acceptable for
                // airspace/pipeline/cable which already fade in.
                asynchronous: true,
                // Let Cesium drop the CPU-side GeometryInstance array after
                // the first GPU build. Codex flagged per-rebuild persistence
                // of these arrays (hundreds of polygon/polyline instances
                // for airspace/pipeline/cable) as an episodic memory spike
                // source during replay window reloads.
                releaseGeometryInstances: true,
            })
            : null;
        const nextPolygonOutline = polygonOutlineInstances.length > 0
            ? new Cesium.Primitive({
                geometryInstances: polygonOutlineInstances,
                appearance: new Cesium.PerInstanceColorAppearance({
                    translucent: true,
                    flat: true,
                }),
                // Build geometry off the main thread in Cesium's worker pool.
                // Before this change: a single airspace rebuild with ~10k
                // polygon instances produced a 5.7s synchronous longtask in
                // `CesiumPrimitive.update` on the main thread — the largest
                // source of "browser freezes" observed in replay after the
                // billboard fast-path + scratch fixes. Trade-off: the first
                // render tick after rebuild may show the shape batch as
                // still-building (invisible for ~50–200 ms); acceptable for
                // airspace/pipeline/cable which already fade in.
                asynchronous: true,
                // Let Cesium drop the CPU-side GeometryInstance array after
                // the first GPU build. Codex flagged per-rebuild persistence
                // of these arrays (hundreds of polygon/polyline instances
                // for airspace/pipeline/cable) as an episodic memory spike
                // source during replay window reloads.
                releaseGeometryInstances: true,
            })
            : null;
        const nextPolyline = polylineInstances.length > 0
            ? new Cesium.GroundPolylinePrimitive({
                geometryInstances: polylineInstances,
                appearance: new Cesium.PolylineColorAppearance(),
                // Build geometry off the main thread in Cesium's worker pool.
                // Before this change: a single airspace rebuild with ~10k
                // polygon instances produced a 5.7s synchronous longtask in
                // `CesiumPrimitive.update` on the main thread — the largest
                // source of "browser freezes" observed in replay after the
                // billboard fast-path + scratch fixes. Trade-off: the first
                // render tick after rebuild may show the shape batch as
                // still-building (invisible for ~50–200 ms); acceptable for
                // airspace/pipeline/cable which already fade in.
                asynchronous: true,
                // Let Cesium drop the CPU-side GeometryInstance array after
                // the first GPU build. Codex flagged per-rebuild persistence
                // of these arrays (hundreds of polygon/polyline instances
                // for airspace/pipeline/cable) as an episodic memory spike
                // source during replay window reloads.
                releaseGeometryInstances: true,
            })
            : null;

        // Codex round-7 instrumentation hook: wrap the new primitives'
        // .update() so we can attribute the multi-second frame_render
        // spikes that fire AFTER rebuildIfDirty returns. Cesium calls
        // .update(frameState) every frame as part of the render loop;
        // for primitives with `asynchronous: false`, the first update
        // does the synchronous geometry build on main thread.
        const wrapPrimitiveUpdate = (prim: Cesium.Primitive | Cesium.GroundPolylinePrimitive | null, kind: string) => {
            if (!prim) return;
            const original = (prim as any).update?.bind(prim);
            if (typeof original !== 'function') return;
            (prim as any).update = function patchedUpdate(this: any, frameState: any) {
                const tStart = performance.now();
                const result = original(frameState);
                const ms = performance.now() - tStart;
                if (ms > 50) {
                    perfLog('suspect.block', {
                        name: 'CesiumPrimitive.update',
                        ms: Math.round(ms),
                        kind,
                        layerKey: (prim as any)?.__layerKey ?? null,
                        ready: (prim as any).ready ?? null,
                    });
                }
                return result;
            };
            (prim as any).__layerKey = this.layerKey;
        };
        wrapPrimitiveUpdate(nextPolygonFill, 'polygon-fill');
        wrapPrimitiveUpdate(nextPolygonOutline, 'polygon-outline');
        wrapPrimitiveUpdate(nextPolyline, 'polyline');

        if (nextPolygonFill) this.scene.primitives.add(nextPolygonFill);
        if (nextPolygonOutline) this.scene.primitives.add(nextPolygonOutline);
        if (nextPolyline) this.scene.groundPrimitives.add(nextPolyline);

        if (this.polygonFillPrimitive) this.scene.primitives.remove(this.polygonFillPrimitive);
        if (this.polygonOutlinePrimitive) this.scene.primitives.remove(this.polygonOutlinePrimitive);
        if (this.polylinePrimitive) this.scene.groundPrimitives.remove(this.polylinePrimitive);

        this.polygonFillPrimitive = nextPolygonFill;
        this.polygonOutlinePrimitive = nextPolygonOutline;
        this.polylinePrimitive = nextPolyline;
        this.dirty = false;
        this.lastRebuildAt = now;
        this.onRebuild?.();
        const ms = performance.now() - tStart;
        if (ms > 50) {
            perfLog('suspect.block', {
                name: 'ReplayShapeBatch.rebuildIfDirty',
                ms: Math.round(ms),
                layerKey: this.layerKey,
                descriptors: descriptorCount,
                polygonFill: polygonFillInstances.length,
                polygonOutline: polygonOutlineInstances.length,
                polyline: polylineInstances.length,
                stack: new Error().stack?.split('\n').slice(1, 6).join('\n'),
            });
        }
        return true;
    }

    destroy(): void {
        if (this.polygonFillPrimitive) {
            this.scene.primitives.remove(this.polygonFillPrimitive);
            this.polygonFillPrimitive = null;
        }
        if (this.polygonOutlinePrimitive) {
            this.scene.primitives.remove(this.polygonOutlinePrimitive);
            this.polygonOutlinePrimitive = null;
        }
        if (this.polylinePrimitive) {
            this.scene.groundPrimitives.remove(this.polylinePrimitive);
            this.polylinePrimitive = null;
        }
        this.descriptors.clear();
        this.dirty = false;
    }

    get size(): number {
        return this.descriptors.size;
    }

    get label(): string {
        return this.layerKey;
    }
}
