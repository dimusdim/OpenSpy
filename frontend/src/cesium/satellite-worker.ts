// Web Worker for SGP4 satellite propagation.
// Offloads all orbital mechanics from the main thread so we can scale
// to 2000+ satellites without blocking UI.
//
// Messages IN:
//   { type: 'init', satellites: SatInit[] }
//     Parse TLE, build satrec cache. Reply: { type: 'ready', count }
//
//   { type: 'propagate', epochMs: number, windowMinutes: number, stepSeconds: number }
//     Full orbit for trails. Reply: { type: 'orbits', data: OrbitResult[] }
//     Positions as Float64Array (Transferable, zero-copy).
//
//   { type: 'tick', currentTimeMs: number }
//     Single-point propagation for live billboard positions.
//     Reply: { type: 'positions', positions: Float64Array } (Transferable)
//     Layout: [lon0, lat0, alt0, lon1, lat1, alt1, ...]

import * as satelliteJs from 'satellite.js';

interface SatInit {
    noradId: number;
    name: string;
    tleLine1: string;
    tleLine2: string;
    type: string;
    recon?: boolean;
}

interface SatCached {
    noradId: number;
    satrec: satelliteJs.SatRec;
}

let satellites: SatCached[] = [];
let satOrder: number[] = []; // noradId in order, for position buffer mapping

const DEG = 180 / Math.PI;

function propagateOne(satrec: satelliteJs.SatRec, date: Date): [number, number, number] | null {
    const pv = satelliteJs.propagate(satrec, date);
    if (!pv.position || typeof pv.position === 'boolean') return null;
    const gmst = satelliteJs.gstime(date);
    const geo = satelliteJs.eciToGeodetic(pv.position as satelliteJs.EciVec3<number>, gmst);
    return [geo.longitude * DEG, geo.latitude * DEG, geo.height * 1000];
}

self.onmessage = (e: MessageEvent) => {
    const { type } = e.data;

    if (type === 'init') {
        const sats: SatInit[] = e.data.satellites;
        satellites = [];
        satOrder = [];
        for (const s of sats) {
            try {
                const satrec = satelliteJs.twoline2satrec(s.tleLine1, s.tleLine2);
                satellites.push({ noradId: s.noradId, satrec });
                satOrder.push(s.noradId);
            } catch {
                // Skip satellites with bad TLE
            }
        }
        (self as any).postMessage({ type: 'ready', count: satellites.length });
        return;
    }

    if (type === 'propagate') {
        const { epochMs, windowMinutes, stepSeconds } = e.data;
        const startMs = epochMs - (windowMinutes / 2) * 60_000;
        const sampleCount = Math.ceil((windowMinutes * 60) / stepSeconds) + 1;

        const results: { noradId: number; positions: Float64Array; validSamples: number }[] = [];
        const transferables: ArrayBuffer[] = [];

        for (const sat of satellites) {
            const buf = new Float64Array(sampleCount * 3);
            let valid = 0;
            for (let i = 0; i < sampleCount; i++) {
                const t = new Date(startMs + i * stepSeconds * 1000);
                const pos = propagateOne(sat.satrec, t);
                if (pos) {
                    buf[i * 3] = pos[0];
                    buf[i * 3 + 1] = pos[1];
                    buf[i * 3 + 2] = pos[2];
                    valid++;
                }
            }
            results.push({ noradId: sat.noradId, positions: buf, validSamples: valid });
            transferables.push(buf.buffer);
        }

        (self as any).postMessage({ type: 'orbits', results, sampleCount }, transferables);
        return;
    }

    if (type === 'tick') {
        const t = new Date(e.data.currentTimeMs);
        const buf = new Float64Array(satellites.length * 3);

        for (let i = 0; i < satellites.length; i++) {
            const pos = propagateOne(satellites[i].satrec, t);
            if (pos) {
                buf[i * 3] = pos[0];
                buf[i * 3 + 1] = pos[1];
                buf[i * 3 + 2] = pos[2];
            } else {
                // NaN signals "no valid position" — main thread skips these
                buf[i * 3] = NaN;
            }
        }

        (self as any).postMessage(
            { type: 'positions', positions: buf, order: satOrder },
            [buf.buffer]
        );
    }
};
