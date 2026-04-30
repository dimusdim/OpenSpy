export type RetryWithBackoffOptions = {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterMs?: number;
    label?: string;
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(error: any): number | null {
    const retryAfter = error?.response?.headers?.['retry-after'];
    if (!retryAfter) return null;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const parsedDate = Date.parse(String(retryAfter));
    if (Number.isFinite(parsedDate)) return Math.max(0, parsedDate - Date.now());
    return null;
}

function isRetryable(error: any): boolean {
    const status = Number(error?.response?.status || 0);
    if (status === 408 || status === 429 || status >= 500) return true;
    const code = String(error?.code || '').toUpperCase();
    return ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR_NETWORK'].includes(code);
}

export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    options: RetryWithBackoffOptions = {},
): Promise<T> {
    const maxAttempts = Math.max(1, options.maxAttempts || 3);
    const baseDelayMs = Math.max(100, options.baseDelayMs || 500);
    const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs || 15_000);
    const jitterMs = Math.max(0, options.jitterMs || 250);
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            if (attempt >= maxAttempts || !isRetryable(error)) break;
            const retryAfter = retryAfterMs(error);
            const backoff = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
            const delay = retryAfter ?? (backoff + Math.round(Math.random() * jitterMs));
            if (options.label) {
                console.warn(`[${options.label}] retry ${attempt}/${maxAttempts - 1} after ${Math.round(delay)}ms: ${error?.message || error}`);
            }
            await sleep(delay);
        }
    }

    throw lastError;
}
