export interface SatellitePositionsSAB {
    sab: SharedArrayBuffer;
    view: Float32Array;
    indexById: Map<string, number>;
    epochMs: number;
}

export function createSatellitePositionsSAB(maxSats: number): SatellitePositionsSAB {
    const sab = new SharedArrayBuffer(maxSats * 3 * Float32Array.BYTES_PER_ELEMENT);
    return {
        sab,
        view: new Float32Array(sab),
        indexById: new Map(),
        epochMs: 0,
    };
}
