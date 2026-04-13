'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

/**
 * Polls /api/status on a 30s interval and propagates backend health into
 * the Zustand streamMetrics. Extracted from LayerManager so it runs
 * regardless of which UI panels are open.
 *
 * Returns `{ backendReachable, retrying, retry }` for any component that
 * wants to show a backend-unreachable banner.
 */
export function useStatusPoller() {
    const [backendReachable, setBackendReachable] = useState<boolean | null>(null);
    const [retrying, setRetrying] = useState(true);
    const [retryNonce, setRetryNonce] = useState(0);

    const retry = useCallback(() => setRetryNonce(n => n + 1), []);

    useEffect(() => {
        let attempts = 0;
        const MAX_ATTEMPTS = 24; // 2 min @ 5s
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;

        setRetrying(true);

        const doFetch = () => {
            if (cancelled) return;
            fetch(`${API_URL}/api/status`)
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.json();
                })
                .then((status: Record<string, { status: string; count?: number; note?: string }>) => {
                    if (cancelled) return;
                    setBackendReachable(true);
                    setRetrying(false);
                    attempts = 0; // reset on success
                    const { setStreamMetric } = useTimelineStore.getState();
                    const known = ['connecting', 'streaming', 'error', 'auth-missing', 'disabled', 'degraded', 'limited', 'warning', 'rate-limited'];
                    for (const [layer, info] of Object.entries(status)) {
                        const patch: Partial<{ status: string; note: string }> = {};
                        if (known.includes(info.status)) patch.status = info.status;
                        if (info.note !== undefined) patch.note = info.note;
                        if (Object.keys(patch).length > 0) {
                            setStreamMetric(layer, patch as any);
                        }
                    }

                    // Start periodic polling once initial connection succeeds
                    if (!pollTimer) {
                        pollTimer = setInterval(doFetch, 30_000);
                    }
                })
                .catch(() => {
                    if (cancelled) return;
                    setBackendReachable(false);
                    attempts++;
                    if (attempts < MAX_ATTEMPTS) {
                        retryTimer = setTimeout(doFetch, 5000);
                    } else {
                        setRetrying(false);
                    }
                });
        };

        doFetch();

        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            if (pollTimer) clearInterval(pollTimer);
        };
    }, [retryNonce]);

    return { backendReachable, retrying, retry };
}
