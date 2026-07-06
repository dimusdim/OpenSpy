'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, Loader2, MapPin, X } from 'lucide-react';
import { useTimelineStore } from '../store/useTimelineStore';

type Readout = {
    status: 'loading' | 'result';
    lat: number;
    lng: number;
    date?: string;
    resolution?: string;
    source?: string;
    summary?: string;
};

// Small, dismissible corner card that surfaces the Esri World Imagery capture
// date / resolution / source for the last left-clicked point while the Esri
// base map is active. Driven entirely by the `openspy:esri-identify` custom
// event dispatched from Globe.tsx (status: loading | result | empty). Empty
// results are ignored silently, per spec.
export default function EsriDateReadout() {
    const tileMode = useTimelineStore((s) => s.tileMode);
    const [readout, setReadout] = useState<Readout | null>(null);

    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent).detail as {
                status: 'loading' | 'result' | 'empty';
                lat: number;
                lng: number;
                date?: string;
                resolution?: string;
                source?: string;
                summary?: string;
            } | undefined;
            if (!detail) return;
            if (detail.status === 'empty') return; // fail silently
            setReadout({
                status: detail.status,
                lat: detail.lat,
                lng: detail.lng,
                date: detail.date,
                resolution: detail.resolution,
                source: detail.source,
                summary: detail.summary,
            });
        };
        document.addEventListener('openspy:esri-identify', handler);
        return () => document.removeEventListener('openspy:esri-identify', handler);
    }, []);

    // Auto-hide when the user leaves Esri mode — the readout is Esri-specific.
    useEffect(() => {
        if (tileMode !== 'esri') setReadout(null);
    }, [tileMode]);

    if (!readout || tileMode !== 'esri') return null;

    const coord = `${readout.lat.toFixed(4)}, ${readout.lng.toFixed(4)}`;

    return (
        <div className="pointer-events-auto mb-2 w-64 rounded-md border border-cyan-900/70 bg-black/85 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-300 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-mono uppercase tracking-wider text-cyan-200">
                    <CalendarClock size={13} />
                    <span>Imagery date</span>
                </div>
                <button
                    onClick={() => setReadout(null)}
                    className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                    title="Dismiss"
                >
                    <X size={13} />
                </button>
            </div>

            {readout.status === 'loading' ? (
                <div className="mt-1.5 flex items-center gap-2 text-zinc-500">
                    <Loader2 size={13} className="animate-spin" />
                    <span>Reading capture metadata…</span>
                </div>
            ) : (
                <div className="mt-1.5 space-y-1">
                    {readout.date && (
                        <div className="text-sm font-medium text-zinc-100">{readout.date}</div>
                    )}
                    {readout.resolution && (
                        <div className="text-zinc-400">Resolution: <span className="text-zinc-200">{readout.resolution}</span></div>
                    )}
                    {readout.source && (
                        <div className="truncate text-zinc-400" title={readout.source}>Source: <span className="text-zinc-200">{readout.source}</span></div>
                    )}
                    {!readout.date && readout.summary && (
                        <div className="text-zinc-200">{readout.summary}</div>
                    )}
                    {readout.date && readout.summary && readout.summary !== readout.date && (
                        <div className="truncate text-[10px] text-zinc-500" title={readout.summary}>{readout.summary}</div>
                    )}
                </div>
            )}

            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-600">
                <MapPin size={11} />
                <span>{coord}</span>
            </div>
        </div>
    );
}
