import { API_URL, PERF_CONSOLE_ENABLED } from './config';
import {
    recordFrameRender,
    recordSuspectBlock,
    recordPrimitiveUpdate,
    recordLongtask,
    recordHydrationTask,
} from './otel';

type Event = Record<string, any> & { event: string };

const queue: Event[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 1000;
const FLUSH_MAX_BATCH = 50;

function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

async function flush() {
    flushTimer = null;
    if (queue.length === 0) return;
    const batch = queue.splice(0, FLUSH_MAX_BATCH);
    try {
        await fetch(`${API_URL}/api/perf-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch),
            keepalive: true,
        });
    } catch {
        // best-effort; drop on failure
    }
    if (queue.length > 0) scheduleFlush();
}

// Mirror selected events into OTEL metrics. JSONL fan-out below stays
// as a redundant fallback so existing diagnostic scripts keep working
// while we migrate dashboards/alerts to Jaeger/Prometheus.
function exportToOtel(event: string, data: Record<string, any>): void {
    try {
        switch (event) {
            case 'replay.frame_render':
                if (typeof data.ms === 'number') recordFrameRender(data.ms);
                return;
            case 'suspect.block':
                if (typeof data.ms === 'number') recordSuspectBlock(data.name || 'unknown', data.ms, data);
                if (data.name === 'CesiumPrimitive.update' && typeof data.ms === 'number') {
                    recordPrimitiveUpdate(data.kind || 'unknown', data.layerKey || 'unknown', data.ms);
                }
                return;
            case 'replay.longtask':
                if (typeof data.duration === 'number') recordLongtask(data.duration);
                return;
            case 'replay.hydration_task':
                if (typeof data.ms === 'number') recordHydrationTask(data.kind || 'unknown', data.ms, data.phase || 'unknown');
                return;
        }
    } catch (err) {
        // OTEL must never break the JSONL fallback.
        if (typeof console !== 'undefined') console.warn('[perf-log] OTEL export failed:', err);
    }
}

export function perfLog(event: string, data: Record<string, any> = {}): void {
    const enriched: Event = { event, source: 'frontend', ts: new Date().toISOString(), ...data };
    queue.push(enriched);
    if (queue.length >= FLUSH_MAX_BATCH) {
        void flush();
    } else {
        scheduleFlush();
    }
    exportToOtel(event, data);
    const runtimeConsoleEnabled =
        typeof window !== 'undefined' && (window as any).__OPENSPY_PERF_CONSOLE === true;
    if ((PERF_CONSOLE_ENABLED || runtimeConsoleEnabled) && typeof console !== 'undefined') {
        const tag = `[perf:${event}]`;
        console.log(tag, data);
    }
}
