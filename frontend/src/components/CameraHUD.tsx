'use client';

import { useEffect, useRef, useState } from 'react';
import { useTimelineStore } from '../store/useTimelineStore';
import { getViewerAltitudeMeters } from '../cesium/position-utils';

const INFRA_CUTOFF_KM = 200;

export default function CameraHUD() {
    const [altText, setAltText] = useState('—');
    const infraPct = useTimelineStore(s => s.infraViewportPct);
    const rafRef = useRef(0);

    useEffect(() => {
        let lastUpdate = 0;
        const tick = () => {
            rafRef.current = requestAnimationFrame(tick);
            const now = performance.now();
            if (now - lastUpdate < 250) return;
            lastUpdate = now;

            const v = (window as any).viewerContext;
            if (!v || v.isDestroyed?.()) return;

            const h = getViewerAltitudeMeters(v);
            if (h == null || !Number.isFinite(h)) return;

            const km = h / 1000;
            if (km >= 1000) setAltText(`${(km / 1000).toFixed(1)}k km`);
            else if (km >= 1) setAltText(`${km.toFixed(1)} km`);
            else setAltText(`${Math.round(h)} m`);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, []);

    // infraPct: -1 = above cutoff, 0-100 = loading progress
    const showProgress = infraPct >= 0 && infraPct < 100;
    const loaded = infraPct === 100;

    return (
        <div className="absolute bottom-4 left-4 z-20 pointer-events-none select-none flex flex-col gap-1 items-start">
            {/* Altitude */}
            <div className="text-white/80 text-xs font-mono tabular-nums bg-black/40 backdrop-blur-sm rounded px-2 py-1">
                ALT {altText}
            </div>

            {/* Hint: always visible */}
            <div className="text-[10px] text-white/40 bg-black/30 backdrop-blur-sm rounded px-2 py-0.5">
                Infrastructure icons below {INFRA_CUTOFF_KM} km
            </div>

            {/* Progress bar: only when below cutoff and not fully loaded */}
            {showProgress && (
                <div className="flex items-center gap-1.5 bg-black/40 backdrop-blur-sm rounded px-2 py-0.5">
                    <div className="w-20 h-1.5 bg-white/20 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-cyan-400 rounded-full transition-all duration-300"
                            style={{ width: `${infraPct}%` }}
                        />
                    </div>
                    <span className="text-[10px] font-mono text-white/60">{infraPct}%</span>
                </div>
            )}

            {/* Loaded indicator */}
            {loaded && (
                <div className="text-[10px] text-emerald-400/70 bg-black/30 backdrop-blur-sm rounded px-2 py-0.5">
                    tiles loaded
                </div>
            )}
        </div>
    );
}
