// Dedicated Web Worker for msgpack decoding of replay tiles.
// The main thread previously decoded 30–80 MB msgpack payloads in
// `ReplayTileCache`, blocking the event loop (vessel tilesMs=81297,
// aircraft tilesMs=26814 in telemetry). Moving decode off the main
// thread keeps UI responsive and lets the worker decode in parallel
// with network I/O.

import { decode } from '@msgpack/msgpack';

type DecodeSingleReq = {
    type: 'decode-single';
    nonce: number;
    buffer: ArrayBuffer;
};

type DecodeBundleReq = {
    type: 'decode-bundle';
    nonce: number;
    buffer: ArrayBuffer;
};

type Req = DecodeSingleReq | DecodeBundleReq;

type DecodeSingleResp = {
    type: 'decoded-single';
    nonce: number;
    payload: any;
    workerCpuMs: number;
    payloadKind: 'single';
    estItems: number;
};

type DecodeBundleResp = {
    type: 'decoded-bundle';
    nonce: number;
    entries: Array<{ url: string; payload: any | null }>;
    workerCpuMs: number;
    payloadKind: 'bundle';
    estItems: number;
};

type ErrorResp = {
    type: 'error';
    nonce: number;
    message: string;
};

// Diagnostic: lightweight ack message posted IMMEDIATELY after decode
// finishes inside the worker, BEFORE the big payload postMessage. Lets the
// main thread distinguish (a) worker-CPU + queue time vs (b) structured-clone
// deserialise time of the big payload. Round-5 Codex review (2026-04-21)
// pointed out my prior decode-done metric was tautologically correlated
// with longtasks because it included main-thread starvation.
type DecodedReadyAck = {
    type: 'decoded-ready';
    nonce: number;
    workerCpuMs: number;
    payloadKind: 'single' | 'bundle';
    estItems: number;
};

type Resp = DecodeSingleResp | DecodeBundleResp | ErrorResp | DecodedReadyAck;

function postResp(resp: Resp) {
    (self as any).postMessage(resp);
}

(self as any).onmessage = (event: MessageEvent<Req>) => {
    const req = event.data;
    const { type, nonce } = req;
    const tStart = performance.now();
    try {
        if (type === 'decode-single') {
            const payload = decode(new Uint8Array(req.buffer));
            const workerCpuMs = performance.now() - tStart;
            // Estimate item count for diagnostic — single tile payload may
            // be a snapshot/items shape; this is best-effort.
            const items = (payload as any)?.items?.length ?? 0;
            postResp({ type: 'decoded-ready', nonce, workerCpuMs, payloadKind: 'single', estItems: items });
            postResp({ type: 'decoded-single', nonce, payload, workerCpuMs, payloadKind: 'single', estItems: items });
            return;
        }
        if (type === 'decode-bundle') {
            const buf = new Uint8Array(req.buffer);
            const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            let off = 0;
            const count = view.getUint32(off, true); off += 4;
            const entries: Array<{ url: string; payload: any | null }> = [];
            const decoder = new TextDecoder('utf-8');
            let totalItems = 0;
            for (let n = 0; n < count; n += 1) {
                const keyLen = view.getUint32(off, true); off += 4;
                const url = decoder.decode(buf.subarray(off, off + keyLen));
                off += keyLen;
                const payloadLen = view.getUint32(off, true); off += 4;
                if (payloadLen === 0) {
                    entries.push({ url, payload: null });
                    continue;
                }
                const payloadBytes = buf.subarray(off, off + payloadLen);
                off += payloadLen;
                const payload = decode(payloadBytes);
                totalItems += (payload as any)?.items?.length ?? 0;
                totalItems += (payload as any)?.snapshot?.assets?.length ?? 0;
                entries.push({ url, payload });
            }
            const workerCpuMs = performance.now() - tStart;
            postResp({ type: 'decoded-ready', nonce, workerCpuMs, payloadKind: 'bundle', estItems: totalItems });
            postResp({ type: 'decoded-bundle', nonce, entries, workerCpuMs, payloadKind: 'bundle', estItems: totalItems });
            return;
        }
    } catch (error: any) {
        postResp({ type: 'error', nonce, message: error?.message || String(error) });
    }
};
