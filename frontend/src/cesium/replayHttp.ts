import axios, { type AxiosRequestConfig } from 'axios';

const REPLAY_HTTP_TIMEOUT_MS = 45_000;
const REPLAY_HTTP_RETRIES = 2;

export type ReplayHttpStatus = {
    state: 'idle' | 'retrying' | 'recovered' | 'failed';
    url: string;
    attempt: number;
    retries: number;
    retryAfterMs?: number | null;
    message?: string | null;
    updatedAt: string;
};

export function publishReplayHttpStatus(status: ReplayHttpStatus): void {
    if (typeof window === 'undefined') return;
    (window as any).__openspyReplayHttpStatus = status;
    window.dispatchEvent(new CustomEvent('openspy:replay-http-status', { detail: status }));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableReplayError(error: any): boolean {
    const status = Number(error?.response?.status || 0);
    if (status === 408 || status === 429 || status >= 500) return true;
    const code = String(error?.code || '').toUpperCase();
    return ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_NETWORK'].includes(code);
}

function parseRetryAfterMs(value: unknown): number | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw == null) return null;
    const text = String(raw).trim();
    if (!text) return null;
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, seconds * 1000);
    const dateMs = Date.parse(text);
    if (!Number.isFinite(dateMs)) return null;
    return Math.min(120_000, Math.max(0, dateMs - Date.now()));
}

async function replayHttpRequest<T>(
    method: 'get' | 'post',
    url: string,
    data: unknown,
    config: AxiosRequestConfig,
    retries: number,
): Promise<T> {
    let lastError: any = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const requestConfig = {
                timeout: REPLAY_HTTP_TIMEOUT_MS,
                ...config,
            };
            const response = method === 'post'
                ? await axios.post<T>(url, data, requestConfig)
                : await axios.get<T>(url, requestConfig);
            if (attempt > 0) {
                publishReplayHttpStatus({
                    state: 'recovered',
                    url,
                    attempt,
                    retries,
                    updatedAt: new Date().toISOString(),
                });
            }
            return response.data;
        } catch (error: any) {
            lastError = error;
            if (attempt >= retries || !isRetryableReplayError(error)) break;
            const retryAfterMs = parseRetryAfterMs(error?.response?.headers?.['retry-after']);
            publishReplayHttpStatus({
                state: 'retrying',
                url,
                attempt: attempt + 1,
                retries,
                retryAfterMs,
                message: error?.message || String(error),
                updatedAt: new Date().toISOString(),
            });
            await sleep(retryAfterMs ?? (250 * (attempt + 1) * (attempt + 1)));
        }
    }
    publishReplayHttpStatus({
        state: 'failed',
        url,
        attempt: retries,
        retries,
        message: lastError?.message || String(lastError),
        updatedAt: new Date().toISOString(),
    });
    throw lastError;
}

export async function replayHttpGet<T>(url: string, config: AxiosRequestConfig = {}, retries = REPLAY_HTTP_RETRIES): Promise<T> {
    return replayHttpRequest<T>('get', url, undefined, config, retries);
}

export async function replayHttpPost<T>(url: string, data: unknown, config: AxiosRequestConfig = {}, retries = REPLAY_HTTP_RETRIES): Promise<T> {
    return replayHttpRequest<T>('post', url, data, config, retries);
}
