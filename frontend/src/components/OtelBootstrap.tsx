'use client';

// Side-effect import — initializes the browser OTEL SDK on mount.
// Kept in a tiny client component because the rest of the app tree may
// be split between server and client rendering, and the SDK must run
// in the browser (it relies on window, IndexedDB-free, performance APIs).
import { useEffect } from 'react';

export function OtelBootstrap() {
    useEffect(() => {
        // Dynamic import so SSR doesn't try to evaluate the SDK.
        void import('@/lib/otel').catch((err) => {
            console.warn('[otel-bootstrap] failed:', err);
        });
    }, []);
    return null;
}
