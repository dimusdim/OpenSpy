import axios from 'axios';
import { decode } from '@msgpack/msgpack';
import { withSpan } from '../lib/otel';

// Fall-back decode still uses @msgpack/msgpack on the main thread; the
// Web Worker path below handles the hot loads.

export type ReplayManifestTileEntry = {
    layerId: string;
    z: number;
    x: number;
    y: number;
    tBucket: string;
    contentHash: string;
    itemCount: number;
    bytes: number;
    url: string;
};

export type ReplayManifestLayer = {
    layerId: string;
    bucketSeconds: number;
    zoom: number;
    tiles: ReplayManifestTileEntry[];
};

export type ReplayManifest = {
    from: string;
    to: string;
    layers: Record<string, ReplayManifestLayer>;
};

export type ReplayTilePayload = {
    version: 1;
    layerId: string;
    z: number;
    x: number;
    y: number;
    tBucket: string;
    bucketSeconds: number;
    bbox: [number, number, number, number];
    snapshotAt: string;
    bucketTo: string;
    snapshot: {
        entities: any[];
        events: any[];
        assets: any[];
    };
    items: any[];
};

type CachedTileRecord = {
    key: string;
    contentHash: string;
    payload: ReplayTilePayload;
    updatedAt: number;
    bytes?: number;
};

const DB_NAME = 'openspy-replay-tiles';
const STORE_NAME = 'tiles';

function mark(name: string) {
    if (typeof performance === 'undefined') return;
    performance.mark(`${name}:start`);
}

function measure(name: string) {
    if (typeof performance === 'undefined') return;
    performance.mark(`${name}:end`);
    performance.measure(name, `${name}:start`, `${name}:end`);
}

function tileKey(entry: Pick<ReplayManifestTileEntry, 'layerId' | 'z' | 'x' | 'y' | 'tBucket'>): string {
    return `${entry.layerId}:${entry.z}:${entry.x}:${entry.y}:${entry.tBucket}`;
}

// Codex round-10 (2026-04-21) finding: aircraft/vessel put-done = 10.5–11.6 s
// was the dominant cold-seek main-thread blocker, not applyLayerState or
// Cesium render. Root cause — `store.put(record)` does a synchronous
// structured-clone of the whole decoded payload on the calling thread
// before the write is queued; 15-MB payloads with thousands of nested
// Cartesian arrays end up as 6 s single longtasks. Fix: skip IDB persist
// for payloads above a size threshold (memLRU still serves in-tab) and
// serialise the remaining writes through a single drain loop with yields
// so a heavy writer can't block readonly gets on the same objectStore.
const IDB_PUT_ITEM_THRESHOLD = 4000;
const IDB_PUT_YIELD_MS = 0;

export class ReplayTileCache {
    private readonly memLRU = new Map<string, CachedTileRecord>();
    private memBytes = 0;
    private dbPromise: Promise<IDBDatabase | null> | null = null;
    // Dedup in-flight network fetches per-URL. Without this, a background
    // prefetch and a foreground seek may both POST the same URLs, doubling
    // work and saturating the localhost socket so both end up slow.
    private readonly inFlight = new Map<string, Promise<ReplayTilePayload | null>>();
    // Single-writer IDB drain queue — see rationale above.
    private idbWriteQueue: Array<{ entry: ReplayManifestTileEntry; record: CachedTileRecord }> = [];
    private idbDrainRunning = false;

    // Pool of msgpack-decode workers. One shared worker caused queue
    // starvation: a 2 MB cable bundle sat 28 s behind a 95 MB aircraft
    // decode and a 124 MB vessel decode running on the same worker.
    // A pool of 2 gives aircraft + vessel the parallelism they need
    // without paying for more threads than physical cores can help with.
    private static readonly DECODE_POOL_SIZE = 2;
    // Pending entry: keeps ack/send timestamps so we can split the total
    // decode-await latency into:
    //   workerCpuMs — real msgpack decode CPU inside the worker (sent in ack)
    //   ackTransitMs — (ack receive on main) - (send time) - workerCpuMs
    //                  = queue + main-thread starvation while ack travels
    //   cloneMs     — (payload receive) - (ack receive)
    //                  = structured clone deserialise of the big payload
    // Codex round-5 review (2026-04-21) flagged that `decode-done` was a
    // single grossly aggregated number; this split lets us actually attribute
    // the multi-second longtasks.
    private readonly workerSlots: Array<{
        worker: Worker;
        pending: Map<number, {
            resolve: (v: any) => void;
            reject: (e: Error) => void;
            sendTimeMs: number;
            ackTimeMs: number | null;
            ackWorkerCpuMs: number | null;
            ackEstItems: number | null;
            onPhase?: (phase: string, ms: number, extra?: Record<string, any>) => void;
        }>;
    } | null> = new Array(ReplayTileCache.DECODE_POOL_SIZE).fill(null);
    private decodeNonce = 0;

    private spawnSlot(slotIdx: number): typeof this.workerSlots[number] {
        if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
        try {
            const worker = new Worker(
                new URL('./replay-tile-decode-worker.ts', import.meta.url),
                { type: 'module' },
            );
            type WaiterEntry = {
                resolve: (v: any) => void;
                reject: (e: Error) => void;
                sendTimeMs: number;
                ackTimeMs: number | null;
                ackWorkerCpuMs: number | null;
                ackEstItems: number | null;
                onPhase?: (phase: string, ms: number, extra?: Record<string, any>) => void;
            };
            const pending: Map<number, WaiterEntry> = new Map();
            const slot = { worker, pending };
            worker.onmessage = (event: MessageEvent<any>) => {
                const { type, nonce } = event.data || {};
                const waiter = pending.get(nonce);
                if (!waiter) return;
                if (type === 'error') {
                    pending.delete(nonce);
                    waiter.reject(new Error(event.data.message || 'decode error'));
                    return;
                }
                if (type === 'decoded-ready') {
                    // Lightweight ack: record timestamps for clone-vs-cpu split.
                    const now = performance.now();
                    waiter.ackTimeMs = now;
                    waiter.ackWorkerCpuMs = event.data.workerCpuMs ?? 0;
                    waiter.ackEstItems = event.data.estItems ?? 0;
                    if (waiter.onPhase) {
                        const sinceSend = now - waiter.sendTimeMs;
                        waiter.onPhase('worker-ack', sinceSend, {
                            workerCpuMs: Math.round(event.data.workerCpuMs ?? 0),
                            payloadKind: event.data.payloadKind,
                            estItems: event.data.estItems ?? 0,
                            // sinceSend - workerCpuMs ≈ queue + main-thread starvation
                            ackTransitMs: Math.round(sinceSend - (event.data.workerCpuMs ?? 0)),
                        });
                    }
                    return;
                }
                pending.delete(nonce);
                if (waiter.onPhase) {
                    const now = performance.now();
                    if (waiter.ackTimeMs != null) {
                        // structured-clone deserialise of big payload
                        waiter.onPhase('payload-clone', now - waiter.ackTimeMs);
                    }
                    waiter.onPhase('payload-receive', now - waiter.sendTimeMs);
                }
                waiter.resolve(event.data);
            };
            // A worker crash (unhandled error inside the worker) leaves
            // all pending decodes hanging forever. Reject them, drop
            // the slot, and let the next call respawn.
            worker.onerror = (event) => {
                console.error(`[ReplayTileCache] decode worker #${slotIdx} crashed:`, event.message);
                const err = new Error(event.message || 'decode worker crashed');
                pending.forEach((w: WaiterEntry) => w.reject(err));
                pending.clear();
                try { worker.terminate(); } catch {}
                this.workerSlots[slotIdx] = null;
            };
            this.workerSlots[slotIdx] = slot;
            return slot;
        } catch (error) {
            console.warn(`[ReplayTileCache] could not spawn decode worker #${slotIdx}:`, error);
            this.workerSlots[slotIdx] = null;
            return null;
        }
    }

    // Pick the least-busy slot (by pending count), spawning lazily.
    private pickSlot(): typeof this.workerSlots[number] {
        let best: typeof this.workerSlots[number] = null;
        let bestPending = Number.POSITIVE_INFINITY;
        for (let i = 0; i < this.workerSlots.length; i += 1) {
            const slot = this.workerSlots[i] || this.spawnSlot(i);
            if (!slot) continue;
            const load = slot.pending.size;
            if (load < bestPending) {
                bestPending = load;
                best = slot;
            }
        }
        return best;
    }

    private nextNonce(): number {
        this.decodeNonce = (this.decodeNonce + 1) | 0;
        return this.decodeNonce;
    }

    private async decodeInWorker(
        type: 'decode-single' | 'decode-bundle',
        buffer: ArrayBuffer,
        onPhase?: (phase: string, ms: number, extra?: Record<string, any>) => void,
    ): Promise<any> {
        return withSpan(
            'replay.decodeInWorker',
            {
                'decode.type': type,
                'decode.bytes': buffer.byteLength,
            },
            (span) => this.decodeInWorkerImpl(type, buffer, onPhase, span ?? null),
        ) as Promise<any>;
    }

    private async decodeInWorkerImpl(
        type: 'decode-single' | 'decode-bundle',
        buffer: ArrayBuffer,
        onPhase: ((phase: string, ms: number, extra?: Record<string, any>) => void) | undefined,
        span: import('@opentelemetry/api').Span | null,
    ): Promise<any> {
        const slot = this.pickSlot();
        if (span) {
            const queueDepth = this.workerSlots.reduce((acc, s) => acc + (s?.pending.size || 0), 0);
            span.setAttribute('worker.queue_depth', queueDepth);
            span.setAttribute('worker.has_slot', !!slot);
        }
        if (!slot) {
            // Fallback: decode on main thread.
            if (type === 'decode-single') {
                return { type: 'decoded-single', payload: decode(new Uint8Array(buffer)) };
            }
            // Bundle path: parse framing + decode each entry on main thread.
            const buf = new Uint8Array(buffer);
            const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            let off = 0;
            const count = view.getUint32(off, true); off += 4;
            const entries: Array<{ url: string; payload: any | null }> = [];
            const decoder = new TextDecoder('utf-8');
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
                entries.push({ url, payload: decode(payloadBytes) });
            }
            return { type: 'decoded-bundle', entries };
        }
        const nonce = this.nextNonce();
        return new Promise<any>((resolve, reject) => {
            const sendTimeMs = performance.now();
            slot.pending.set(nonce, {
                resolve,
                reject,
                sendTimeMs,
                ackTimeMs: null,
                ackWorkerCpuMs: null,
                ackEstItems: null,
                onPhase,
            });
            try {
                // Transfer the ArrayBuffer to the worker — avoids the
                // structured-clone copy on every send.
                slot.worker.postMessage({ type, nonce, buffer }, [buffer]);
            } catch (error: any) {
                slot.pending.delete(nonce);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    constructor(
        private readonly apiUrl: string,
        private readonly maxMemEntries = 100,
        private readonly maxMemBytes = 160 * 1024 * 1024,
    ) {
        // Prewarm IndexedDB open. On cold-after-wipe we observed
        // `cache-open-db = 7 040 ms` inside fetchTilesBundle — 7 seconds
        // blocked the first seek before any HTTP even started. Opening
        // the DB here during construction (fire-and-forget) lets the
        // browser do the work while the page hydrates; by the time a
        // user triggers a seek the `dbPromise` is usually resolved.
        if (typeof indexedDB !== 'undefined') {
            void this.openDb().catch(() => {
                // openDb already logs on failure.
            });
        }
    }

    private async openDb(): Promise<IDBDatabase | null> {
        if (typeof indexedDB === 'undefined') return null;
        if (this.dbPromise) return this.dbPromise;
        this.dbPromise = new Promise<IDBDatabase | null>((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        }).catch((error) => {
            console.error('[ReplayTileCache] openDb failed:', error);
            throw error;
        });
        return this.dbPromise;
    }

    private recordBytes(record: CachedTileRecord): number {
        const bytes = Number(record.bytes);
        return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    }

    private estimatePayloadBytes(entry: ReplayManifestTileEntry, payload: ReplayTilePayload): number {
        if (Number.isFinite(entry.bytes) && entry.bytes > 0) return entry.bytes;
        const itemCount =
            (payload.items?.length || 0) +
            (payload.snapshot?.entities?.length || 0) +
            (payload.snapshot?.events?.length || 0) +
            (payload.snapshot?.assets?.length || 0);
        return Math.max(1024, itemCount * 512);
    }

    private deleteMem(key: string): void {
        const existing = this.memLRU.get(key);
        if (!existing) return;
        this.memBytes = Math.max(0, this.memBytes - this.recordBytes(existing));
        this.memLRU.delete(key);
    }

    private touchMem(record: CachedTileRecord) {
        this.deleteMem(record.key);
        this.memLRU.set(record.key, record);
        this.memBytes += this.recordBytes(record);
        while (
            this.memLRU.size > this.maxMemEntries ||
            (this.memLRU.size > 1 && this.memBytes > this.maxMemBytes)
        ) {
            const oldest = this.memLRU.keys().next().value;
            if (!oldest) break;
            this.deleteMem(oldest);
        }
    }

    async get(entry: ReplayManifestTileEntry): Promise<ReplayTilePayload | null> {
        const key = tileKey(entry);
        const mem = this.memLRU.get(key);
        if (mem && mem.contentHash === entry.contentHash) {
            this.touchMem(mem);
            return mem.payload;
        }

        const db = await this.openDb();
        if (!db) return null;
        const payload = await new Promise<CachedTileRecord | null>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => resolve((request.result as CachedTileRecord) || null);
            request.onerror = () => reject(request.error);
        }).catch((error) => {
            console.error('[ReplayTileCache] get failed:', error);
            throw error;
        });
        if (!payload || payload.contentHash !== entry.contentHash) return null;
        payload.bytes = payload.bytes ?? this.estimatePayloadBytes(entry, payload.payload);
        this.touchMem(payload);
        return payload.payload;
    }

    async put(entry: ReplayManifestTileEntry, payload: ReplayTilePayload): Promise<void> {
        mark('replay-tile-put');
        const key = tileKey(entry);
        const record: CachedTileRecord = {
            key,
            contentHash: entry.contentHash,
            payload,
            updatedAt: Date.now(),
            bytes: this.estimatePayloadBytes(entry, payload),
        };
        this.touchMem(record);

        const itemCount =
            (payload.items?.length || 0) +
            (payload.snapshot?.entities?.length || 0) +
            (payload.snapshot?.events?.length || 0) +
            (payload.snapshot?.assets?.length || 0);
        if (itemCount > IDB_PUT_ITEM_THRESHOLD) {
            // Large payload — skip IDB persist entirely. The synchronous
            // structured-clone inside `store.put(record)` was the 6-s
            // longtask; memLRU continues to serve this tile for the
            // lifetime of the tab, which covers the common hot-path.
            measure('replay-tile-put');
            return;
        }

        this.idbWriteQueue.push({ entry, record });
        this.scheduleIdbDrain();
        measure('replay-tile-put');
    }

    private scheduleIdbDrain(): void {
        if (this.idbDrainRunning) return;
        this.idbDrainRunning = true;
        // setTimeout(0) defers the first drain off the calling microtask
        // so the caller's critical path (payload return → apply) runs first.
        setTimeout(() => {
            this.drainIdbQueue().catch((err) => {
                console.error('[ReplayTileCache] drain failed:', err);
            });
        }, 0);
    }

    private async drainIdbQueue(): Promise<void> {
        try {
            while (this.idbWriteQueue.length > 0) {
                const item = this.idbWriteQueue.shift();
                if (!item) break;
                const db = await this.openDb();
                if (!db) continue;
                await new Promise<void>((resolve) => {
                    try {
                        const tx = db.transaction(STORE_NAME, 'readwrite');
                        const store = tx.objectStore(STORE_NAME);
                        const request = store.put(item.record);
                        request.onsuccess = () => resolve();
                        request.onerror = () => {
                            console.error('[ReplayTileCache] drained put failed:', request.error);
                            resolve();
                        };
                    } catch (err) {
                        console.error('[ReplayTileCache] drained put threw:', err);
                        resolve();
                    }
                });
                // Yield between writes so readonly gets on the same
                // objectStore can interleave — prevents a queue of writes
                // from starving cache-idb lookups.
                if (IDB_PUT_YIELD_MS > 0) {
                    await new Promise((r) => setTimeout(r, IDB_PUT_YIELD_MS));
                } else {
                    await new Promise((r) => setTimeout(r, 0));
                }
            }
        } finally {
            this.idbDrainRunning = false;
        }
    }

    async fetchTile(entry: ReplayManifestTileEntry): Promise<ReplayTilePayload> {
        const cached = await this.get(entry);
        if (cached) return cached;
        const response = await axios.get<ArrayBuffer>(`${this.apiUrl}${entry.url}`, {
            responseType: 'arraybuffer',
        });
        mark('replay-tile-decode');
        const decoded = await this.decodeInWorker('decode-single', response.data, undefined);
        const payload = decoded.payload as ReplayTilePayload;
        measure('replay-tile-decode');
        await this.put(entry, payload);
        return payload;
    }

    // Optional phased timing callback for diagnosis. Each phase is
    // reported once per fetchTilesBundle call with wall-clock ms since the
    // previous phase (or entry for the first phase). Extra reports queue
    // depth at http-start so we can tell worker-pool starvation from HTTP
    // concurrency waits.
    //
    // Phases:
    //   cache-check       — memLRU + IndexedDB lookup for all entries
    //   http-start        — just before axios.post (only if bundle POST happens)
    //   http-done         — after axios.post resolves (bytes received)
    //   worker-queue-wait — ms spent waiting for a worker slot before decode
    //   decode-done       — after msgpack decode (in worker or fallback)
    //   put-done          — after IndexedDB put of all payloads
    //   bundle-done       — total wall time of fetchTilesBundle
    async fetchTilesBundle(
        entries: ReplayManifestTileEntry[],
        onPhase?: (phase: string, ms: number, extra?: Record<string, any>) => void,
    ): Promise<ReplayTilePayload[]> {
        if (entries.length === 0) return [];
        const layerScope = entries[0]?.layerId || 'unknown';
        return withSpan(
            'replay.fetchTilesBundle',
            {
                'replay.layer_scope': layerScope,
                'replay.tiles': entries.length,
            },
            (span) => this.fetchTilesBundleImpl(entries, onPhase, span ?? null),
        ) as Promise<ReplayTilePayload[]>;
    }

    private async fetchTilesBundleImpl(
        entries: ReplayManifestTileEntry[],
        onPhase: ((phase: string, ms: number, extra?: Record<string, any>) => void) | undefined,
        span: import('@opentelemetry/api').Span | null,
    ): Promise<ReplayTilePayload[]> {
        const tEntry = performance.now();
        const results = new Array<ReplayTilePayload | null>(entries.length).fill(null);
        // Split cache-check into sub-phases so we can tell whether main
        // thread is blocked vs IndexedDB is slow vs memLRU misses.
        const tMemStart = performance.now();
        const memHits = entries.map((e) => {
            const key = `${e.layerId}:${e.z}:${e.x}:${e.y}:${e.tBucket}`;
            const rec = this.memLRU.get(key);
            return rec && rec.contentHash === e.contentHash ? rec.payload : null;
        });
        onPhase?.('cache-mem', performance.now() - tMemStart, {
            hits: memHits.filter(Boolean).length,
            total: entries.length,
        });

        // Codex round-10 follow-up (2026-04-21): IDB readonly `get()`
        // onsuccess callbacks wait in the event loop while the main
        // thread runs heavy sync work (page init, Cesium bootstrap,
        // decode payload-clone, applyLayerState). On cold start with
        // empty IDB the wait was 10–12 s — pure wasted time because
        // the cache is empty anyway. Strategy: race the IDB lookup
        // against a short timeout; whichever wins is treated as the
        // cache result. Budget kept small (300 ms) so cold-start
        // primary layers don't stall.
        const tOpenDbStart = performance.now();
        const db = await this.openDb();
        void db;
        onPhase?.('cache-open-db', performance.now() - tOpenDbStart);
        const tIdbStart = performance.now();
        const IDB_LOOKUP_BUDGET_MS = 300;
        const idbLookup = Promise.all(entries.map((e, i) => memHits[i] ? Promise.resolve(memHits[i]) : this.get(e)));
        let cacheChecks: Array<ReplayTilePayload | null>;
        let timedOut = false;
        const raced = await Promise.race([
            idbLookup.then((v) => ({ kind: 'idb' as const, v })),
            new Promise<{ kind: 'timeout' }>((r) => setTimeout(() => r({ kind: 'timeout' }), IDB_LOOKUP_BUDGET_MS)),
        ]);
        if (raced.kind === 'idb') {
            cacheChecks = raced.v;
            onPhase?.('cache-idb', performance.now() - tIdbStart, { entries: entries.length });
        } else {
            timedOut = true;
            cacheChecks = memHits;
            onPhase?.('cache-idb-timeout', performance.now() - tIdbStart, { entries: entries.length, budgetMs: IDB_LOOKUP_BUDGET_MS });
            // Allow late IDB to still populate memLRU so subsequent
            // seeks benefit. Don't block anyone on this.
            void idbLookup.then(() => {}).catch(() => {});
        }
        void timedOut;
        onPhase?.('cache-check', performance.now() - tEntry, { entries: entries.length });
        const missingIdx: number[] = [];
        for (let i = 0; i < entries.length; i += 1) {
            if (cacheChecks[i]) results[i] = cacheChecks[i];
            else missingIdx.push(i);
        }

        if (missingIdx.length > 0) {
            // Hand each missing URL to its in-flight promise (or start one
            // and register it). Multiple callers asking for overlapping
            // URLs share the same network round-trip.
            const trulyNew: number[] = [];
            const trulyNewUrls: string[] = [];
            const sharedPromises: Array<Promise<ReplayTilePayload | null>> = [];
            const sharedTargets: number[] = [];
            for (const idx of missingIdx) {
                const url = entries[idx].url;
                const existing = this.inFlight.get(url);
                if (existing) {
                    sharedPromises.push(existing);
                    sharedTargets.push(idx);
                } else {
                    trulyNew.push(idx);
                    trulyNewUrls.push(url);
                }
            }

            if (trulyNewUrls.length > 0) {
                const requestPromise = (async () => {
                    const tHttpStart = performance.now();
                    // Queue depth at the moment we're about to ask a worker.
                    // Lets us tell whether the wait is HTTP or worker pool.
                    const queueDepth = this.workerSlots.reduce((acc, slot) => acc + (slot?.pending.size || 0), 0);
                    onPhase?.('http-start', tHttpStart - tEntry, { urls: trulyNewUrls.length, queueDepth });
                    const response = await axios.post<ArrayBuffer>(
                        `${this.apiUrl}/api/replay/tile-bundle`,
                        { urls: trulyNewUrls },
                        { responseType: 'arraybuffer' },
                    );
                    const tHttpDone = performance.now();
                    onPhase?.('http-done', tHttpDone - tHttpStart, { bytes: response.data.byteLength });
                    // Offload framing + msgpack decode to a worker —
                    // previously this loop decoded 30–80 MB on the main
                    // thread and blocked live ingest + UI for seconds.
                    const tDecodeStart = performance.now();
                    const decoded = await this.decodeInWorker('decode-bundle', response.data, onPhase);
                    const tDecodeDone = performance.now();
                    onPhase?.('decode-done', tDecodeDone - tDecodeStart);
                    const perUrl = new Map<string, ReplayTilePayload | null>();
                    for (const entry of decoded.entries as Array<{ url: string; payload: any | null }>) {
                        perUrl.set(entry.url, (entry.payload as ReplayTilePayload | null) || null);
                    }
                    return perUrl;
                })();
                // Register one shared promise per URL that resolves when the
                // bundle resolves. Each per-URL promise yields that URL's payload.
                for (let k = 0; k < trulyNewUrls.length; k += 1) {
                    const url = trulyNewUrls[k];
                    const targetIdx = trulyNew[k];
                    const perUrlPromise = requestPromise.then((perUrl) => {
                        const payload = perUrl.get(url) || null;
                        if (payload) {
                            // Time IndexedDB put (Codex round-5 noted this
                            // phase was promised in comments but never emitted
                            // and may hold readonly transactions on the
                            // objectStore through transaction-level locking).
                            const tPutStart = performance.now();
                            void this.put(entries[targetIdx], payload)
                                .then(() => {
                                    onPhase?.('put-done', performance.now() - tPutStart, { url });
                                })
                                .catch((err) => {
                                    console.error('[ReplayTileCache] cache put failed:', err);
                                });
                        }
                        return payload;
                    }).finally(() => {
                        // Only clear if we're still the registered promise
                        if (this.inFlight.get(url) === perUrlPromise) {
                            this.inFlight.delete(url);
                        }
                    });
                    this.inFlight.set(url, perUrlPromise);
                    sharedPromises.push(perUrlPromise);
                    sharedTargets.push(targetIdx);
                }
            }

            const tAllStart = performance.now();
            const resolved = await Promise.all(sharedPromises);
            onPhase?.('await-all', performance.now() - tAllStart, {
                shared: sharedPromises.length,
                trulyNew: trulyNewUrls.length,
            });
            for (let i = 0; i < resolved.length; i += 1) {
                results[sharedTargets[i]] = resolved[i];
            }
        }
        const bundleDoneMs = performance.now() - tEntry;
        onPhase?.('bundle-done', bundleDoneMs);
        const final = results.filter((p): p is ReplayTilePayload => p != null);
        if (span) {
            span.setAttribute('bundle.done_ms', Math.round(bundleDoneMs));
            span.setAttribute('bundle.payloads', final.length);
        }
        return final;
    }

    async prefetch(manifest: ReplayManifest, options?: { skipLayers?: string[] }): Promise<void> {
        const skip = new Set(options?.skipLayers || []);
        const entries = Object.values(manifest.layers)
            .filter((l) => !skip.has(l.layerId))
            .flatMap((layer) => layer.tiles);
        const batchSize = 500;
        for (let index = 0; index < entries.length; index += batchSize) {
            const slice = entries.slice(index, index + batchSize);
            await this.fetchTilesBundle(slice);
        }
    }
}
