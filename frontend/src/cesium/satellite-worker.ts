// Web Worker for SGP4 satellite propagation.
// Offloads all orbital mechanics from the main thread so we can scale
// to 2000+ satellites without blocking UI.
//
// Messages IN:
//   { type: 'init', satellites: SatInit[] }
//     Parse TLE, build satrec cache. Reply: { type: 'ready', count }
//
//   { type: 'propagate', epochMs: number, windowMinutes: number, stepSeconds: number, noradIds?: number[] }
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

// MotionTrack carries the full trajectory for one entity inside the current
// replay window. Previously we stored only (previous, next) — a single pair
// of samples around the initial atMs — which meant at high playback speeds
// atMs would quickly overtake nextAtMs and the worker would freeze the
// position on `next` until the next cadence refresh on the main thread.
// That showed up as "aircraft don't move" at 30× playback because the
// aircraft refresh cadence was 90 virtual seconds (~3 s real) while the
// trajectory's next sample was typically only 20–60 s away.
//
// The array form lets motion-tick do a binary search for the surrounding
// samples at any atMs in the window, so movement is smooth at any speed
// and cadence only needs to fire when the window shifts.
interface MotionTrack {
    index: number;
    targetId: string;
    // Flat, ordered-ascending. sampleAtMs[i] corresponds to
    // samplePositions[i*3 + {0,1,2}] = [x, y, z] in ECF metres.
    sampleAtMs: Float64Array;
    samplePositions: Float32Array;
}

let satellites: SatCached[] = [];
let satOrder: number[] = []; // noradId in order, for position buffer mapping
let positionsView: Float32Array | null = null;
let motionView: Float32Array | null = null;
let motionTracks: MotionTrack[] = [];

const DEG = 180 / Math.PI;

function propagateOne(satrec: satelliteJs.SatRec, date: Date): [number, number, number] | null {
    const pv = satelliteJs.propagate(satrec, date);
    if (!pv.position || typeof pv.position === 'boolean') return null;
    const gmst = satelliteJs.gstime(date);
    const geo = satelliteJs.eciToGeodetic(pv.position as satelliteJs.EciVec3<number>, gmst);
    return [geo.longitude * DEG, geo.latitude * DEG, geo.height * 1000];
}

function propagateOneEcf(satrec: satelliteJs.SatRec, date: Date): [number, number, number] | null {
    const pv = satelliteJs.propagate(satrec, date);
    if (!pv.position || typeof pv.position === 'boolean') return null;
    const gmst = satelliteJs.gstime(date);
    const geo = satelliteJs.eciToGeodetic(pv.position as satelliteJs.EciVec3<number>, gmst);
    const ecf = satelliteJs.geodeticToEcf(geo);
    if (!Number.isFinite(ecf.x) || !Number.isFinite(ecf.y) || !Number.isFinite(ecf.z)) return null;
    return [ecf.x * 1000, ecf.y * 1000, ecf.z * 1000];
}

function writeSabPosition(index: number, value: [number, number, number] | null) {
    if (!positionsView) return;
    const offset = index * 3;
    if (!value) {
        positionsView[offset] = NaN;
        positionsView[offset + 1] = NaN;
        positionsView[offset + 2] = NaN;
        return;
    }
    positionsView[offset] = value[0];
    positionsView[offset + 1] = value[1];
    positionsView[offset + 2] = value[2];
}

function writeMotionPosition(index: number, value: [number, number, number] | null) {
    if (!motionView) return;
    const offset = index * 3;
    if (!value) {
        motionView[offset] = NaN;
        motionView[offset + 1] = NaN;
        motionView[offset + 2] = NaN;
        return;
    }
    motionView[offset] = value[0];
    motionView[offset + 1] = value[1];
    motionView[offset + 2] = value[2];
}

self.onmessage = (e: MessageEvent) => {
    const { type } = e.data;

    if (type === 'init') {
        const sats: SatInit[] = e.data.satellites;
        const sab: SharedArrayBuffer | undefined = e.data.sab;
        satellites = [];
        satOrder = [];
        positionsView = sab ? new Float32Array(sab) : null;
        for (const s of sats) {
            try {
                const satrec = satelliteJs.twoline2satrec(s.tleLine1, s.tleLine2);
                satellites.push({ noradId: s.noradId, satrec });
                satOrder.push(s.noradId);
            } catch (error) {
                console.error('[satellite-worker] invalid TLE skipped', s.noradId, error);
            }
        }
        (self as any).postMessage({ type: 'ready', count: satellites.length });
        return;
    }

    if (type === 'propagate') {
        const { epochMs, windowMinutes, stepSeconds, nonce } = e.data;
        const requestedIds = Array.isArray(e.data.noradIds)
            ? new Set<number>(e.data.noradIds.map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id)))
            : null;
        const startMs = epochMs - (windowMinutes / 2) * 60_000;
        const sampleCount = Math.ceil((windowMinutes * 60) / stepSeconds) + 1;

        const results: { noradId: number; positions: Float64Array; validSamples: number }[] = [];
        const transferables: ArrayBuffer[] = [];

        const selected = requestedIds
            ? satellites.filter((sat) => requestedIds.has(sat.noradId))
            : satellites;
        for (const sat of selected) {
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

        (self as any).postMessage({ type: 'orbits', results, sampleCount, nonce }, transferables);
        return;
    }

    if (type === 'tick') {
        const t = new Date(e.data.currentTimeMs);
        for (let i = 0; i < satellites.length; i++) {
            writeSabPosition(i, propagateOneEcf(satellites[i].satrec, t));
        }
        (self as any).postMessage({ type: 'positions', epochMs: t.getTime(), count: satellites.length, order: satOrder });
        return;
    }

    if (type === 'update-tracks') {
        const sab: SharedArrayBuffer | null | undefined = e.data.sab;
        motionView = sab ? new Float32Array(sab) : null;
        motionTracks = Array.isArray(e.data.tracks) ? e.data.tracks : [];
        return;
    }

    if (type === 'motion-tick') {
        const atMs = Number(e.data.atMs);
        if (!Number.isFinite(atMs)) {
            (self as any).postMessage({ type: 'motion-positions', epochMs: Date.now(), count: 0 });
            return;
        }
        const scratch: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < motionTracks.length; i += 1) {
            const track = motionTracks[i];
            const times = track.sampleAtMs;
            const pos = track.samplePositions;
            const n = times.length;
            if (n === 0) {
                writeMotionPosition(track.index, null);
                continue;
            }
            if (n === 1 || atMs <= times[0]) {
                scratch[0] = pos[0];
                scratch[1] = pos[1];
                scratch[2] = pos[2];
                writeMotionPosition(track.index, scratch);
                continue;
            }
            if (atMs >= times[n - 1]) {
                const o = (n - 1) * 3;
                scratch[0] = pos[o];
                scratch[1] = pos[o + 1];
                scratch[2] = pos[o + 2];
                writeMotionPosition(track.index, scratch);
                continue;
            }
            // Binary search for the greatest index `lo` where times[lo] <= atMs.
            let lo = 0;
            let hi = n - 1;
            while (lo + 1 < hi) {
                const mid = (lo + hi) >>> 1;
                if (times[mid] <= atMs) lo = mid;
                else hi = mid;
            }
            const tPrev = times[lo];
            const tNext = times[lo + 1];
            const denom = tNext - tPrev;
            const t = denom > 0 ? (atMs - tPrev) / denom : 0;
            const oPrev = lo * 3;
            const oNext = (lo + 1) * 3;
            scratch[0] = pos[oPrev] + (pos[oNext] - pos[oPrev]) * t;
            scratch[1] = pos[oPrev + 1] + (pos[oNext + 1] - pos[oPrev + 1]) * t;
            scratch[2] = pos[oPrev + 2] + (pos[oNext + 2] - pos[oPrev + 2]) * t;
            writeMotionPosition(track.index, scratch);
        }
        (self as any).postMessage({ type: 'motion-positions', epochMs: atMs, count: motionTracks.length });
    }
};
