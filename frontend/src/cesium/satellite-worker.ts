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
let motionTrackRows: Uint32Array | null = null;
let motionSampleAtMs: Float64Array | null = null;
let motionSamplePositions: Float32Array | null = null;
let motionGeneration = 0;

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

function writeInterpolatedMotionPosition(
    outputIndex: number,
    times: Float64Array,
    positions: Float32Array,
    sampleStart: number,
    sampleCount: number,
    atMs: number,
    scratch: [number, number, number],
) {
    if (sampleCount <= 0) {
        writeMotionPosition(outputIndex, null);
        return;
    }
    if (sampleCount === 1 || atMs <= times[sampleStart]) {
        const o = sampleStart * 3;
        scratch[0] = positions[o];
        scratch[1] = positions[o + 1];
        scratch[2] = positions[o + 2];
        writeMotionPosition(outputIndex, scratch);
        return;
    }
    const last = sampleStart + sampleCount - 1;
    if (atMs >= times[last]) {
        const o = last * 3;
        scratch[0] = positions[o];
        scratch[1] = positions[o + 1];
        scratch[2] = positions[o + 2];
        writeMotionPosition(outputIndex, scratch);
        return;
    }
    let lo = sampleStart;
    let hi = last;
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
    scratch[0] = positions[oPrev] + (positions[oNext] - positions[oPrev]) * t;
    scratch[1] = positions[oPrev + 1] + (positions[oNext + 1] - positions[oPrev + 1]) * t;
    scratch[2] = positions[oPrev + 2] + (positions[oNext + 2] - positions[oPrev + 2]) * t;
    writeMotionPosition(outputIndex, scratch);
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
        motionTrackRows = e.data.trackRows instanceof Uint32Array ? e.data.trackRows : null;
        motionSampleAtMs = e.data.sampleAtMs instanceof Float64Array ? e.data.sampleAtMs : null;
        motionSamplePositions = e.data.samplePositions instanceof Float32Array ? e.data.samplePositions : null;
        motionTracks = motionTrackRows ? [] : (Array.isArray(e.data.tracks) ? e.data.tracks : []);
        motionGeneration = Number(e.data.generation) || 0;
        return;
    }

    if (type === 'motion-tick') {
        const generation = Number(e.data.generation) || 0;
        const atMs = Number(e.data.atMs);
        if (generation !== motionGeneration) {
            (self as any).postMessage({ type: 'motion-positions-stale', epochMs: atMs, count: 0, generation });
            return;
        }
        if (!Number.isFinite(atMs)) {
            (self as any).postMessage({ type: 'motion-positions', epochMs: Date.now(), count: 0, generation });
            return;
        }
        const scratch: [number, number, number] = [0, 0, 0];
        if (motionTrackRows && motionSampleAtMs && motionSamplePositions) {
            const rowCount = motionTrackRows.length / 3;
            for (let i = 0; i < rowCount; i += 1) {
                const offset = i * 3;
                writeInterpolatedMotionPosition(
                    motionTrackRows[offset],
                    motionSampleAtMs,
                    motionSamplePositions,
                    motionTrackRows[offset + 1],
                    motionTrackRows[offset + 2],
                    atMs,
                    scratch,
                );
            }
            (self as any).postMessage({ type: 'motion-positions', epochMs: atMs, count: rowCount, generation });
            return;
        }
        for (let i = 0; i < motionTracks.length; i += 1) {
            const track = motionTracks[i];
            const times = track.sampleAtMs;
            const pos = track.samplePositions;
            writeInterpolatedMotionPosition(track.index, times, pos, 0, times.length, atMs, scratch);
        }
        (self as any).postMessage({ type: 'motion-positions', epochMs: atMs, count: motionTracks.length, generation });
    }
};
