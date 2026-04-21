import fs from 'fs';
import path from 'path';

const LOG_PATH = path.resolve(__dirname, '../../var/perf-events.jsonl');
const MAX_BYTES = 50 * 1024 * 1024;

let initialized = false;

function ensureFile(): void {
    if (initialized) return;
    initialized = true;
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    try {
        const st = fs.statSync(LOG_PATH);
        if (st.size > MAX_BYTES) {
            fs.renameSync(LOG_PATH, LOG_PATH + '.1');
        }
    } catch {
        // file does not exist yet
    }
}

export function logPerfEvent(event: string, data: Record<string, any>): void {
    try {
        ensureFile();
        const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n';
        fs.appendFile(LOG_PATH, line, () => {});
    } catch {
        // never throw from a logger
    }
}

export function logPerfEventFromClient(payload: any): void {
    if (!payload || typeof payload !== 'object') return;
    const event = typeof payload.event === 'string' ? payload.event : 'client';
    const { event: _e, ts: _ts, ...rest } = payload;
    logPerfEvent(event, { source: payload.source || 'client', ...rest });
}
