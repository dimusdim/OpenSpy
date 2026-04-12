import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { io, Socket } from 'socket.io-client';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

// Wraps an inline SVG body in a data URI (32x32 aircraft icons).
const svgUri = (body: string) => `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" stroke="black" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
);

// Wraps a complete SVG string in a data URI (used for enhanced vessel icons).
const svgDataUri = (svgContent: string) => `data:image/svg+xml,` + encodeURIComponent(svgContent);

// Aircraft icons — pre-built data URIs, reused for all billboards of same type.
const AVI_ICONS: Record<string, string> = {
    airliner: svgUri(`<path d="M12 2 L10 11 L2 14 L2 16 L10 14 L10 20 L7 22 L7 23 L12 22 L17 23 L17 22 L14 20 L14 14 L22 16 L22 14 L14 11 Z" fill="#ffffff"/>`),
    military: svgUri(`<path d="M12 2 L8 13 L2 18 L2 20 L9 17 L9 21 L7 22 L7 23 L12 22 L17 23 L17 22 L15 21 L15 17 L22 20 L22 18 L16 13 Z" fill="#facc15"/>`),
    light:    svgUri(`<circle cx="12" cy="12" r="2" fill="#60a5fa"/><path d="M12 4 L11 11 L4 12 L4 13 L11 13 L11 19 L9 20 L9 21 L12 20 L15 21 L15 20 L13 19 L13 13 L20 13 L20 12 L13 11 Z" fill="#60a5fa"/>`),
    general:  svgUri(`<path d="M12 2 L10 11 L2 14 L2 16 L10 14 L10 20 L7 22 L7 23 L12 22 L17 23 L17 22 L14 20 L14 14 L22 16 L22 14 L14 11 Z" fill="#e5e7eb"/>`),
};
const getAviSVG = (type: string) => AVI_ICONS[type] || AVI_ICONS.general;

// Vessel icons — enhanced top-down ship silhouettes (32x32 output, 48x48 viewBox).
const VESSEL_ICONS: Record<string, string> = {
    cargo:     svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><path d="M24 3 C24 3 19 5 17 9 L15 38 C15 42 19 45 24 45 C29 45 33 42 33 38 L31 9 C29 5 24 3 24 3 Z" fill="#d1d5db" stroke="#6b7280" stroke-width="1"/><rect x="17" y="12" width="14" height="24" rx="1.5" fill="#e5e7eb" stroke="#9ca3af" stroke-width="0.6"/><rect x="18" y="13" width="5" height="4.5" rx="0.5" fill="#f97316" stroke="#9a3412" stroke-width="0.4"/><rect x="25" y="13" width="5" height="4.5" rx="0.5" fill="#3b82f6" stroke="#1e40af" stroke-width="0.4"/><rect x="18" y="18.5" width="5" height="4.5" rx="0.5" fill="#22c55e" stroke="#166534" stroke-width="0.4"/><rect x="25" y="18.5" width="5" height="4.5" rx="0.5" fill="#ef4444" stroke="#991b1b" stroke-width="0.4"/><rect x="18" y="24" width="5" height="4.5" rx="0.5" fill="#8b5cf6" stroke="#5b21b6" stroke-width="0.4"/><rect x="25" y="24" width="5" height="4.5" rx="0.5" fill="#f97316" stroke="#9a3412" stroke-width="0.4"/><rect x="18" y="29.5" width="5" height="4.5" rx="0.5" fill="#3b82f6" stroke="#1e40af" stroke-width="0.4"/><rect x="25" y="29.5" width="5" height="4.5" rx="0.5" fill="#22c55e" stroke="#166534" stroke-width="0.4"/><rect x="20" y="35" width="8" height="5" rx="1" fill="#374151" stroke="#1f2937" stroke-width="0.6"/><rect x="21" y="36" width="1.5" height="1.2" rx="0.2" fill="#67e8f9" opacity="0.7"/><rect x="23.25" y="36" width="1.5" height="1.2" rx="0.2" fill="#67e8f9" opacity="0.7"/><rect x="25.5" y="36" width="1.5" height="1.2" rx="0.2" fill="#67e8f9" opacity="0.7"/><line x1="21" y1="13" x2="21" y2="10" stroke="#6b7280" stroke-width="0.8"/><line x1="19" y1="10" x2="23" y2="10" stroke="#6b7280" stroke-width="0.8"/><line x1="27" y1="13" x2="27" y2="10" stroke="#6b7280" stroke-width="0.8"/><line x1="25" y1="10" x2="29" y2="10" stroke="#6b7280" stroke-width="0.8"/><line x1="22" y1="7" x2="26" y2="7" stroke="#9ca3af" stroke-width="0.8" stroke-linecap="round"/></svg>`),
    tanker:    svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><path d="M24 3 C24 3 18 6 16 10 L14 38 C14 42 18 45 24 45 C30 45 34 42 34 38 L32 10 C30 6 24 3 24 3 Z" fill="#dc2626" stroke="#991b1b" stroke-width="1"/><rect x="17" y="14" width="14" height="22" rx="2" fill="#ef4444" stroke="#991b1b" stroke-width="0.7"/><rect x="19" y="30" width="10" height="6" rx="1" fill="#1e293b" stroke="#0f172a" stroke-width="0.7"/><rect x="20" y="31" width="2" height="1.5" rx="0.3" fill="#67e8f9" opacity="0.8"/><rect x="23" y="31" width="2" height="1.5" rx="0.3" fill="#67e8f9" opacity="0.8"/><rect x="26" y="31" width="2" height="1.5" rx="0.3" fill="#67e8f9" opacity="0.8"/><circle cx="21" cy="17" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/><circle cx="27" cy="17" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/><circle cx="21" cy="22" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/><circle cx="27" cy="22" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/><circle cx="21" cy="27" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/><circle cx="27" cy="27" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/><line x1="24" y1="14" x2="24" y2="30" stroke="#991b1b" stroke-width="1" stroke-dasharray="2 1"/><line x1="22" y1="8" x2="26" y2="8" stroke="#fca5a5" stroke-width="1" stroke-linecap="round"/><line x1="21" y1="10" x2="27" y2="10" stroke="#fca5a5" stroke-width="0.7" stroke-linecap="round"/><line x1="24" y1="30" x2="24" y2="27" stroke="#475569" stroke-width="0.8"/><circle cx="24" cy="26.5" r="0.6" fill="#67e8f9"/><path d="M20 43 Q24 46 28 43" fill="none" stroke="white" stroke-width="0.5" opacity="0.3"/></svg>`),
    passenger: svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><path d="M24 3 C24 3 18 6 16 10 L14 38 C14 42 18 45 24 45 C30 45 34 42 34 38 L32 10 C30 6 24 3 24 3 Z" fill="#f8fafc" stroke="#2563eb" stroke-width="1.2"/><path d="M24 43 C19 43 16 41 15 38 L17 38 C18 40 20 41 24 41 C28 41 30 40 31 38 L33 38 C32 41 29 43 24 43 Z" fill="#2563eb" opacity="0.6"/><rect x="17" y="10" width="14" height="28" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-width="0.5"/><rect x="17.5" y="13" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="17.5" y="15.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="17.5" y="18" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="17.5" y="20.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="17.5" y="23" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="17.5" y="25.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="17.5" y="28" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="29.3" y="13" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="29.3" y="15.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="29.3" y="18" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="29.3" y="20.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="29.3" y="23" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="29.3" y="25.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="29.3" y="28" width="1.2" height="1" rx="0.2" fill="#fef08a"/><rect x="20" y="14" width="8" height="5" rx="1.5" fill="#bfdbfe" stroke="#2563eb" stroke-width="0.5"/><rect x="21" y="15" width="6" height="3" rx="1" fill="#93c5fd" stroke="#3b82f6" stroke-width="0.3"/><rect x="22" y="22" width="4" height="3" rx="0.5" fill="#1e40af" stroke="#1e3a5f" stroke-width="0.5"/><line x1="22" y1="23.5" x2="26" y2="23.5" stroke="#f8fafc" stroke-width="0.6"/><rect x="20" y="8" width="8" height="4" rx="1" fill="#1e3a5f" stroke="#1e40af" stroke-width="0.6"/><rect x="21" y="9" width="1.5" height="1" rx="0.2" fill="#fef08a" opacity="0.9"/><rect x="23.25" y="9" width="1.5" height="1" rx="0.2" fill="#fef08a" opacity="0.9"/><rect x="25.5" y="9" width="1.5" height="1" rx="0.2" fill="#fef08a" opacity="0.9"/><rect x="20" y="30" width="8" height="6" rx="1" fill="#e2e8f0" stroke="#94a3b8" stroke-width="0.4"/><circle cx="24" cy="33" r="2.5" fill="none" stroke="#2563eb" stroke-width="0.5"/><text x="24" y="34" text-anchor="middle" font-size="3" fill="#2563eb" font-family="sans-serif">H</text><line x1="22" y1="6" x2="26" y2="6" stroke="#2563eb" stroke-width="0.8" stroke-linecap="round"/></svg>`),
    fishing:   svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><path d="M24 5 C24 5 20 7 19 10 L17 38 C17 41 20 44 24 44 C28 44 31 41 31 38 L29 10 C28 7 24 5 24 5 Z" fill="#84cc16" stroke="#4d7c0f" stroke-width="1"/><rect x="19" y="12" width="10" height="24" rx="1.5" fill="#a3e635" stroke="#65a30d" stroke-width="0.5"/><rect x="21" y="12" width="6" height="5" rx="1" fill="#365314" stroke="#1a2e05" stroke-width="0.6"/><rect x="22" y="13" width="1.2" height="1" rx="0.2" fill="#67e8f9" opacity="0.7"/><rect x="24.4" y="13" width="1.2" height="1" rx="0.2" fill="#67e8f9" opacity="0.7"/><line x1="24" y1="18" x2="24" y2="14" stroke="#4d7c0f" stroke-width="1.2"/><line x1="24" y1="14" x2="32" y2="10" stroke="#4d7c0f" stroke-width="1"/><line x1="32" y1="10" x2="32" y2="14" stroke="#65a30d" stroke-width="0.5" stroke-dasharray="1 1"/><path d="M20 28 Q24 32 28 28" fill="none" stroke="#4d7c0f" stroke-width="0.6" stroke-dasharray="1.5 1"/><path d="M20 31 Q24 35 28 31" fill="none" stroke="#4d7c0f" stroke-width="0.6" stroke-dasharray="1.5 1"/><path d="M20 34 Q24 38 28 34" fill="none" stroke="#4d7c0f" stroke-width="0.6" stroke-dasharray="1.5 1"/><circle cx="22" cy="25" r="1.8" fill="#65a30d" stroke="#4d7c0f" stroke-width="0.5"/><circle cx="26" cy="25" r="1.8" fill="#65a30d" stroke="#4d7c0f" stroke-width="0.5"/><line x1="20.2" y1="25" x2="23.8" y2="25" stroke="#4d7c0f" stroke-width="0.3"/><line x1="24.2" y1="25" x2="27.8" y2="25" stroke="#4d7c0f" stroke-width="0.3"/><line x1="24" y1="18" x2="24" y2="22" stroke="#4d7c0f" stroke-width="0.8"/><circle cx="24" cy="18" r="0.5" fill="#a3e635"/></svg>`),
    military:  svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><path d="M24 2 C24 2 21 4 20 7 L18 12 L16 36 C16 40 19 44 24 44 C29 44 32 40 32 36 L30 12 L28 7 C27 4 24 2 24 2 Z" fill="#475569" stroke="#334155" stroke-width="1"/><path d="M20 10 L18 36 C18 39 20 42 24 42 C28 42 30 39 30 36 L28 10 Z" fill="#64748b" stroke="#475569" stroke-width="0.5"/><circle cx="24" cy="11" r="2.5" fill="#334155" stroke="#1e293b" stroke-width="0.6"/><line x1="24" y1="11" x2="24" y2="5" stroke="#334155" stroke-width="1.5" stroke-linecap="round"/><rect x="20" y="17" width="8" height="8" rx="1" fill="#334155" stroke="#1e293b" stroke-width="0.6"/><rect x="21" y="18" width="1.2" height="0.8" rx="0.2" fill="#67e8f9" opacity="0.6"/><rect x="23.4" y="18" width="1.2" height="0.8" rx="0.2" fill="#67e8f9" opacity="0.6"/><rect x="25.8" y="18" width="1.2" height="0.8" rx="0.2" fill="#67e8f9" opacity="0.6"/><line x1="24" y1="17" x2="24" y2="14" stroke="#94a3b8" stroke-width="0.8"/><line x1="21" y1="14.5" x2="27" y2="14.5" stroke="#94a3b8" stroke-width="0.6"/><rect x="22" y="14" width="4" height="1" rx="0.3" fill="#94a3b8" stroke="#64748b" stroke-width="0.3"/><rect x="21" y="26" width="2.5" height="2.5" rx="0.3" fill="#1e293b" stroke="#475569" stroke-width="0.4"/><rect x="24.5" y="26" width="2.5" height="2.5" rx="0.3" fill="#1e293b" stroke="#475569" stroke-width="0.4"/><rect x="21" y="29.5" width="2.5" height="2.5" rx="0.3" fill="#1e293b" stroke="#475569" stroke-width="0.4"/><rect x="24.5" y="29.5" width="2.5" height="2.5" rx="0.3" fill="#1e293b" stroke="#475569" stroke-width="0.4"/><circle cx="24" cy="35" r="1.8" fill="#334155" stroke="#1e293b" stroke-width="0.5"/><line x1="24" y1="35" x2="24" y2="38" stroke="#334155" stroke-width="1" stroke-linecap="round"/><rect x="20" y="37" width="8" height="4" rx="0.5" fill="#475569" stroke="#334155" stroke-width="0.4"/><circle cx="24" cy="39" r="1.5" fill="none" stroke="#94a3b8" stroke-width="0.4"/><rect x="22" y="22" width="1.5" height="2" rx="0.3" fill="#1e293b"/><rect x="24.5" y="22" width="1.5" height="2" rx="0.3" fill="#1e293b"/></svg>`),
    unknown:   svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><path d="M24 5 C24 5 20 7 18 11 L16 37 C16 41 19 44 24 44 C29 44 32 41 32 37 L30 11 C28 7 24 5 24 5 Z" fill="#9ca3af" stroke="#6b7280" stroke-width="1"/><rect x="19" y="13" width="10" height="22" rx="1.5" fill="#d1d5db" stroke="#9ca3af" stroke-width="0.5"/><rect x="21" y="30" width="6" height="4" rx="1" fill="#4b5563" stroke="#374151" stroke-width="0.6"/><rect x="22" y="31" width="1.2" height="1" rx="0.2" fill="#67e8f9" opacity="0.5"/><rect x="24.4" y="31" width="1.2" height="1" rx="0.2" fill="#67e8f9" opacity="0.5"/><rect x="20" y="15" width="8" height="5" rx="0.5" fill="#b5b5b5" stroke="#9ca3af" stroke-width="0.4"/><rect x="20" y="22" width="8" height="5" rx="0.5" fill="#b5b5b5" stroke="#9ca3af" stroke-width="0.4"/><line x1="24" y1="30" x2="24" y2="27" stroke="#6b7280" stroke-width="0.8"/><text x="24" y="20" text-anchor="middle" font-size="5" fill="#4b5563" font-family="sans-serif" font-weight="bold">?</text></svg>`),
};
const getShipSVG = (type: string) => VESSEL_ICONS[type] || VESSEL_ICONS.unknown;

// Dark vessel icon: ominous ship silhouette with red warning badge from dark-vessel.svg
const DARK_VESSEL_ICON = `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 48 48"><path d="M24 4 C24 4 20 7 18 10 L16 36 C16 40 19 43 24 43 C29 43 32 40 32 36 L30 10 C28 7 24 4 24 4 Z" fill="#1f2937" stroke="#dc2626" stroke-width="1.2"/><path d="M20 12 L18 36 C18 39 20 41 24 41 C28 41 30 39 30 36 L28 12 Z" fill="#374151" stroke="#1f2937" stroke-width="0.5"/><rect x="20" y="18" width="8" height="7" rx="1" fill="#111827" stroke="#1f2937" stroke-width="0.6"/><rect x="21" y="19.5" width="1.5" height="0.8" rx="0.2" fill="#374151" opacity="0.5"/><rect x="23.25" y="19.5" width="1.5" height="0.8" rx="0.2" fill="#374151" opacity="0.5"/><rect x="25.5" y="19.5" width="1.5" height="0.8" rx="0.2" fill="#374151" opacity="0.5"/><line x1="24" y1="18" x2="24" y2="15" stroke="#4b5563" stroke-width="0.8"/><line x1="22" y1="8" x2="26" y2="8" stroke="#6b7280" stroke-width="0.8" stroke-linecap="round"/><rect x="20" y="33" width="8" height="5" rx="0.5" fill="#111827" stroke="#1f2937" stroke-width="0.4"/><circle cx="21.5" cy="28" r="1.8" fill="#111827" stroke="#374151" stroke-width="0.4"/><circle cx="26.5" cy="28" r="1.8" fill="#111827" stroke="#374151" stroke-width="0.4"/><circle cx="35" cy="10" r="7" fill="#ef4444" stroke="#991b1b" stroke-width="1"/><rect x="33.5" y="5.5" width="3" height="5.5" rx="1.5" fill="#fff"/><circle cx="35" cy="13.5" r="1.3" fill="#fff"/></svg>`
);

// Metadata stored per aircraft for picking and EntityHUD.
interface AircraftMeta {
    id: string;         // equals icao24 (primary key)
    icao24: string;
    callsign: string;   // display name, can be empty or repeated across airframes
    origin: string;
    type: string;
    speed: number;
    heading: number;
    lat: number;
    lng: number;
    alt: number;
}

// Global registry so Globe.tsx picking can look up aircraft metadata by billboard.
// Key = billboard reference (set as billboard.id), value = metadata.
export const aircraftMetaMap = new Map<string, AircraftMeta>();

// Shared "far past" Julian date used as the start of the sample-prune
// TimeInterval below. Year 1900 is well before any realistic AIS data so
// it reliably covers every historical sample in a vessel's
// SampledPositionProperty. Built once and reused to avoid allocating a
// new JulianDate on every vessel update.
const PRUNE_INTERVAL_START = Cesium.JulianDate.fromIso8601('1900-01-01T00:00:00Z');

export function useDynamicLayers(viewer: Cesium.Viewer | null) {
    // Visibility + subtype filters are reactive because they only touch
    // already-rendered entities. Source flags are NOT in any deps —
    // handlers read them fresh per message, so toggling a source does not
    // tear down the socket (MEDIUM 2 fix).
    const isAviationVisible = useTimelineStore(s => s.visibility.aviation);
    const isMaritimeVisible = useTimelineStore(s => s.visibility.maritime);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const mode = useTimelineStore(s => s.mode);
    const currentTime = useTimelineStore(s => s.currentTime);
    const showTrajectories = useTimelineStore(s => s.showTrajectories);

    // Aviation: BillboardCollection (GPU-batched, 1 draw call for 11K billboards)
    const aviBillboardsRef = useRef<Cesium.BillboardCollection | null>(null);
    const aviBillboardMap = useRef<Map<string, Cesium.Billboard>>(new Map());

    // Maritime: still Entity API (only ~300-500 vessels, perf is fine)
    const maritimeDsRef = useRef<Cesium.CustomDataSource | null>(null);
    // Dark vessels: separate datasource for AIS-dark flagged vessels
    const darkVesselDsRef = useRef<Cesium.CustomDataSource | null>(null);
    const socketRef = useRef<Socket | null>(null);

    // Last-seen timestamps per entity. Kept in refs (not local consts)
    // so the zustand subscribe below can reset them on re-enable —
    // otherwise frozen records from a prior "off" period would get
    // instantly stale-evicted the moment the source came back on.
    const aviLastSeenRef = useRef<Map<string, number>>(new Map());
    const marLastSeenRef = useRef<Map<string, number>>(new Map());
    // Per-source "source-on moment". staleCleanup uses `max(lastSeen,
    // sourceOnAt)` as the freshness baseline, so an entity whose
    // lastSeen is stale but whose source just came back on is NOT
    // considered stale until STALE_TTL elapses since re-enable. This
    // closes the async-useEffect race Codex flagged: even if the
    // interval tick fires before React commits the freeze-reset effect,
    // the sourceOnAt fallback still protects the frozen snapshot.
    const aviSourceOnAtRef = useRef<number>(0);
    const marSourceOnAtRef = useRef<number>(0);
    // Aviation + maritime source flags are read fresh from the store
    // inside the socket message handler AND the staleCleanup interval
    // (see Effect 1 below), not selected at the hook level. Selecting
    // them here would tear down the socket on every toggle — the
    // MEDIUM 2 property Codex flagged — so we reach into the store
    // directly. Freeze-reset on re-enable is handled by Effect 0's
    // zustand subscribe, which fires synchronously with the flip.

    // ---- Effect 0: atomic freeze reset via zustand.subscribe ----
    //
    // The earlier version did this inside a passive `useEffect` triggered
    // on the `isAviationSourceOn`/`isMaritimeSourceOn` hook selector. That
    // fired AFTER React commit, so a staleCleanup tick that ran in the
    // window between the store update and the React commit could evict
    // frozen records before the reset landed. `useTimelineStore.subscribe`
    // fires synchronously with the store write, so the bump happens in
    // the same microtask — no race window.
    //
    // We additionally write `aviSourceOnAtRef` / `marSourceOnAtRef` so
    // even if the subscribe handler somehow missed a flip (e.g. during
    // a store reset on HMR), the staleCleanup interval uses
    // `max(lastSeen, sourceOnAt)` as a safety net.
    useEffect(() => {
        const unsub = useTimelineStore.subscribe((state, prevState) => {
            const now = Date.now();
            if (state.sources.aviation && !prevState.sources.aviation) {
                aviSourceOnAtRef.current = now;
                aviLastSeenRef.current.forEach((_, id) =>
                    aviLastSeenRef.current.set(id, now)
                );
            }
            if (state.sources.maritime && !prevState.sources.maritime) {
                marSourceOnAtRef.current = now;
                marLastSeenRef.current.forEach((_, id) =>
                    marLastSeenRef.current.set(id, now)
                );
            }
        });
        return unsub;
    }, []);

    // ---- Effect 1: scene + socket lifetime ----
    // Opens the socket once per viewer. Source toggles only gate INSIDE
    // the message handlers (via fresh store reads). That way switching
    // aviation off in the LayerManager doesn't disconnect the socket from
    // maritime, and switching it back on doesn't pay a reconnect penalty.
    useEffect(() => {
        if (!viewer) return;
        let active = true;

        // --- Aviation: BillboardCollection ---
        const aviBillboards = new Cesium.BillboardCollection({ scene: viewer.scene });
        viewer.scene.primitives.add(aviBillboards);
        aviBillboardsRef.current = aviBillboards;
        const billboardMap = new Map<string, Cesium.Billboard>();
        aviBillboardMap.current = billboardMap;

        // --- Maritime: Entity API (small count, clustering useful) ---
        const maritimeDs = new Cesium.CustomDataSource('maritime');
        viewer.dataSources.add(maritimeDs);
        maritimeDsRef.current = maritimeDs;

        // --- Dark vessels: AIS-silent vessels flagged by backend ---
        const darkVesselDs = new Cesium.CustomDataSource('dark-vessels');
        viewer.dataSources.add(darkVesselDs);
        darkVesselDsRef.current = darkVesselDs;

        const socket = io(API_URL);
        socketRef.current = socket;

        // Surface socket connection state into stream metrics so LayerManager
        // shows "error" instead of stale "streaming" when the backend drops.
        // Every write is gated on the current source flag so a flipped-off
        // source stays on "disabled" instead of being silently overwritten
        // by connect / disconnect / speed-tick handlers.
        socket.on('connect', () => {
            const src = useTimelineStore.getState().sources;
            if (src.aviation) useTimelineStore.getState().setStreamMetric('aviation', { status: 'streaming' });
            if (src.maritime) useTimelineStore.getState().setStreamMetric('maritime', { status: 'streaming' });
        });
        socket.on('disconnect', () => {
            const src = useTimelineStore.getState().sources;
            if (src.aviation) useTimelineStore.getState().setStreamMetric('aviation', { status: 'error' });
            if (src.maritime) useTimelineStore.getState().setStreamMetric('maritime', { status: 'error' });
        });
        socket.on('connect_error', (err) => {
            console.warn('[Socket] connect_error:', err.message);
            const src = useTimelineStore.getState().sources;
            if (src.aviation) useTimelineStore.getState().setStreamMetric('aviation', { status: 'error' });
            if (src.maritime) useTimelineStore.getState().setStreamMetric('maritime', { status: 'error' });
        });

        let aviMsgs = 0;
        let marMsgs = 0;

        const speedInterval = setInterval(() => {
            if (!active) return;
            const src = useTimelineStore.getState().sources;
            if (src.aviation) {
                useTimelineStore.getState().setStreamMetric('aviation', { speed: `${aviMsgs} Kbps` });
            }
            if (src.maritime) {
                useTimelineStore.getState().setStreamMetric('maritime', { speed: `${marMsgs} msgs/s` });
            }
            aviMsgs = 0;
            marMsgs = 0;
        }, 10_000);

        // Track last-seen timestamps for stale cleanup — lifted to
        // component-level refs so the source-flag watcher effect can
        // refresh them on re-enable (see freeze semantics below).
        const aviLastSeen = aviLastSeenRef.current;
        const marLastSeen = marLastSeenRef.current;
        const STALE_TTL = 5 * 60 * 1000; // 5 minutes

        // Periodic stale cleanup (every 30s).
        //
        // Freeze semantics: when a source is OFF, we intentionally skip
        // eviction for its entities so the "frozen snapshot" of last-
        // known positions stays visible. Task 5's contract: toggling a
        // source off stops NEW data from streaming in, but NEVER deletes
        // already-rendered objects.
        //
        // The per-entity freshness floor is `max(lastSeen, sourceOnAt)`
        // where sourceOnAt is the moment the source last flipped from
        // off to on (set synchronously by the zustand subscribe above).
        // This guarantees that even if the subscribe handler's bump and
        // this tick race, an entity that was alive at the moment of
        // re-enable keeps its full STALE_TTL grace period measured from
        // re-enable instead of from its pre-freeze lastSeen.
        const staleCleanup = setInterval(() => {
            const now = Date.now();
            const sources = useTimelineStore.getState().sources;

            // Aviation eviction — only runs when the source is actively
            // streaming fresh updates. If aviation is off, leave the
            // billboards frozen in place.
            if (sources.aviation) {
                const floor = aviSourceOnAtRef.current;
                aviLastSeen.forEach((ts, id) => {
                    const effective = ts > floor ? ts : floor;
                    if (now - effective > STALE_TTL) {
                        const bb = billboardMap.get(id);
                        if (bb) {
                            aviBillboards.remove(bb);
                            billboardMap.delete(id);
                        }
                        aircraftMetaMap.delete(id);
                        aviLastSeen.delete(id);
                    }
                });
            }

            // Maritime eviction — same freeze rule + same floor.
            if (sources.maritime) {
                const floor = marSourceOnAtRef.current;
                marLastSeen.forEach((ts, id) => {
                    const effective = ts > floor ? ts : floor;
                    if (now - effective > STALE_TTL) {
                        maritimeDs.entities.removeById(id);
                        marLastSeen.delete(id);
                    }
                });
            }
        }, 30_000);

        // How many aircraft / vessels to process synchronously before
        // yielding to the browser. Each simulator-update message carries
        // the full ~11k aircraft world snapshot; processing that in a
        // single sync loop is a 100-300ms main-thread spike that makes
        // the globe feel laggy on every tick. Chunked with yields keeps
        // pointer events responsive even during a fresh world update.
        const AVI_CHUNK_SIZE = 1500;

        // Message sequence counter. Bumped on every simulator-update
        // arrival; each async handler captures `mySeq` at start and
        // bails after any yield if a newer message has come in. This
        // prevents stale resumed handlers from writing positions older
        // than the latest snapshot when socket.io delivers two updates
        // before the first one's chunked loop drains.
        let messageSeq = 0;

        socket.on('simulator-update', async (data: any) => {
            if (!active) return;
            const mySeq = ++messageSeq;
            const now = Date.now();
            // Sources + subtype filters are re-read from the store on
            // every yield boundary so a mid-chunk source-off flip is
            // seen by the resumed handler (instead of overwriting the
            // source-off-clear effect with stale positions from the
            // in-flight payload).
            let currentSubtypeVisibility = useTimelineStore.getState().subtypeVisibility;
            let currentSources = useTimelineStore.getState().sources;
            const refreshStateIfFresh = (): boolean => {
                if (!active || mySeq !== messageSeq) return false;
                currentSubtypeVisibility = useTimelineStore.getState().subtypeVisibility;
                currentSources = useTimelineStore.getState().sources;
                return true;
            };

            // ---- Aviation via BillboardCollection ----
            if (data.aircrafts && currentSources.aviation) {
                // Approximate payload size in KB without stringifying the
                // whole array on every socket message. An OpenSky aircraft
                // record serialises to ~200 bytes (icao24, callsign, origin,
                // lat/lng/alt/heading/type/speed). data.aircrafts.length * 0.2
                // is close enough for a ticker display and costs O(1).
                aviMsgs += Math.round(data.aircrafts.length * 0.2);

                const aircrafts = data.aircrafts as any[];
                for (let ai = 0; ai < aircrafts.length; ai++) {
                    const ac = aircrafts[ai];
                    const pos = Cesium.Cartesian3.fromDegrees(ac.lng, ac.lat, ac.alt * 0.3048);
                    const rotation = Cesium.Math.toRadians(-(ac.heading || 0));

                    aviLastSeen.set(ac.id, now);

                    let bb = billboardMap.get(ac.id);
                    if (!bb) {
                        // Apply subtype visibility filter to new billboards so
                        // late-arriving aircraft respect the current LayerManager toggles.
                        const show = currentSubtypeVisibility[`aviation:${ac.type}`] !== false;
                        bb = aviBillboards.add({
                            position: pos,
                            image: getAviSVG(ac.type),
                            scale: 0.7,
                            rotation,
                            id: ac.id,
                            show,
                        });
                        billboardMap.set(ac.id, bb);
                    } else {
                        bb.position = pos;
                        bb.rotation = rotation;
                    }

                    aircraftMetaMap.set(ac.id, {
                        id: ac.id,
                        icao24: ac.icao24 || '',
                        callsign: ac.callsign || ac.icao24 || '',
                        origin: ac.origin || '',
                        type: ac.type,
                        speed: ac.speed,
                        heading: ac.heading,
                        lat: ac.lat,
                        lng: ac.lng,
                        alt: ac.alt,
                    });

                    // Yield every AVI_CHUNK_SIZE aircraft so input events
                    // (drag / zoom / click) get a chance between chunks.
                    if ((ai + 1) % AVI_CHUNK_SIZE === 0 && ai + 1 < aircrafts.length) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        if (!refreshStateIfFresh()) return;
                        // Source may have flipped off during the yield.
                        if (!currentSources.aviation) break;
                    }
                }
            }

            if (!refreshStateIfFresh()) return;

            // Server-computed counts → store (no client forEach).
            // Gate each write on the CURRENT source flag so a flipped-off
            // aviation/maritime row doesn't get repopulated by the next
            // simulator-update that happens to be in flight.
            if (data.meta) {
                if (currentSources.aviation) {
                    useTimelineStore.getState().setStreamMetric('aviation', {
                        count: data.meta.aviationTotal,
                        status: 'streaming'
                    });
                    useTimelineStore.getState().setSubtypeCounts('aviation', data.meta.aviationCounts || {});
                }
                if (currentSources.maritime) {
                    useTimelineStore.getState().setSubtypeCounts('maritime', data.meta.maritimeCounts || {});
                }
            }

            // ---- Maritime via Entity API ----
            // Chunked the same way as aviation. The retained vessel set
            // can grow to ~2000, so a full sync pass here also hitches
            // the main thread on each simulator-update.
            if (!currentSources.maritime) return; // Maritime source disabled — drop vessels + dark vessels
            marMsgs += data.vessels.length;

            const MARITIME_CHUNK_SIZE = 500;
            const vessels: any[] = data.vessels;
            for (let vi = 0; vi < vessels.length; vi++) {
                const v = vessels[vi];
                marLastSeen.set(v.id, now);
                let entity = maritimeDs.entities.getById(v.id);
                const pos = Cesium.Cartesian3.fromDegrees(v.lng, v.lat, 0);
                const rotation = Cesium.Math.toRadians(-(v.heading || 0));

                if (!entity) {
                    const positionProperty = new Cesium.SampledPositionProperty();
                    positionProperty.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
                    positionProperty.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
                    // Apply subtype visibility filter to new vessels so
                    // late-arriving ships respect the current LayerManager toggles.
                    const showVessel = currentSubtypeVisibility[`maritime:${v.type}`] !== false;
                    // Respect the trajectories toggle at creation time — without
                    // this, freshly spawned vessels would flash in their wake
                    // even when the user had hidden trails globally.
                    const initialShowTrails = useTimelineStore.getState().showTrajectories;
                    entity = maritimeDs.entities.add({
                        id: v.id,
                        name: `Ship ${v.id}`,
                        position: positionProperty as any,
                        show: showVessel,
                        properties: new Cesium.PropertyBag({
                            layer: 'Vessel',
                            subtype: v.type,
                            speed: v.speed,
                            heading: v.heading || 0,
                        }),
                        billboard: {
                            image: getShipSVG(v.type),
                            scale: 0.7,
                            rotation,
                            alignedAxis: Cesium.Cartesian3.UNIT_Z,
                        },
                        // Vessel wake — last 30 min of accumulated positions.
                        // Plain ColorMaterialProperty instead of PolylineGlow
                        // which uses a heavy custom shader; on 500+ vessels
                        // glow was a material perf kit for a small visual win.
                        path: {
                            leadTime: 0,
                            trailTime: 1800,
                            width: 1.5,
                            material: new Cesium.ColorMaterialProperty(
                                Cesium.Color.CYAN.withAlpha(0.4)
                            ),
                            show: new Cesium.ConstantProperty(initialShowTrails),
                        },
                    });
                } else {
                    // Mutate existing ConstantProperty values in place via
                    // `setValue()` rather than allocating a new property
                    // on every socket tick. With 500-2000 vessels this
                    // dropped GC pressure noticeably — each vessel update
                    // used to churn 3-5 fresh property objects per message,
                    // and the simulator fires every few seconds.
                    if (entity.billboard?.rotation instanceof Cesium.ConstantProperty) {
                        entity.billboard.rotation.setValue(rotation);
                    } else if (entity.billboard) {
                        entity.billboard.rotation = new Cesium.ConstantProperty(rotation);
                    }
                    // Update type if known
                    if (entity.properties && v.type !== 'unknown') {
                        const subProp = (entity.properties as any).subtype;
                        if (subProp instanceof Cesium.ConstantProperty) {
                            subProp.setValue(v.type);
                        } else {
                            (entity.properties as any).subtype = new Cesium.ConstantProperty(v.type);
                        }
                        if (entity.billboard?.image instanceof Cesium.ConstantProperty) {
                            entity.billboard.image.setValue(getShipSVG(v.type));
                        } else if (entity.billboard) {
                            entity.billboard.image = new Cesium.ConstantProperty(getShipSVG(v.type));
                        }
                    }
                    // Update speed/heading properties for EntityHUD
                    if (entity.properties) {
                        const speedProp = (entity.properties as any).speed;
                        if (speedProp instanceof Cesium.ConstantProperty) {
                            speedProp.setValue(v.speed || 0);
                        } else {
                            (entity.properties as any).speed = new Cesium.ConstantProperty(v.speed || 0);
                        }
                        const headingProp = (entity.properties as any).heading;
                        if (headingProp instanceof Cesium.ConstantProperty) {
                            headingProp.setValue(v.heading || 0);
                        } else {
                            (entity.properties as any).heading = new Cesium.ConstantProperty(v.heading || 0);
                        }
                    }
                }

                const positionProperty = entity.position as Cesium.SampledPositionProperty;
                const prev = positionProperty.getValue(viewer.clock.currentTime);
                if (!prev || !Cesium.Cartesian3.equalsEpsilon(prev, pos, 0, 1.0)) {
                    positionProperty.addSample(viewer.clock.currentTime, pos);
                }
                // Prune samples older than the visible wake window
                // (trailTime + a small grace) on EVERY update, not just
                // position-change ticks. Without this, a long session
                // accumulates samples forever — addSample is append-only,
                // `trailTime` only bounds what's drawn, not what's
                // stored, so path visualiser cost grows linearly with
                // session duration even though the visible trail stays
                // the same length.
                //
                // The prune must run outside the position-change branch
                // because stationary/moored vessels stop calling
                // addSample but still hold whatever history they
                // accumulated before they stopped. Running it every
                // update amortises the cleanup across the whole fleet
                // on each simulator tick.
                const trailWindowSec = 1800; // matches path.trailTime
                const graceSec = 60;
                const cutoff = Cesium.JulianDate.addSeconds(
                    viewer.clock.currentTime,
                    -(trailWindowSec + graceSec),
                    new Cesium.JulianDate()
                );
                // Wide-open start so we remove EVERY sample before the
                // cutoff. Cesium's TimeInterval uses inclusive bounds
                // by default which is exactly what we want here.
                positionProperty.removeSamples(new Cesium.TimeInterval({
                    start: PRUNE_INTERVAL_START,
                    stop: cutoff,
                }));

                if ((vi + 1) % MARITIME_CHUNK_SIZE === 0 && vi + 1 < vessels.length) {
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                    if (!refreshStateIfFresh()) return;
                    if (!currentSources.maritime) return;
                }
            }

            if (data.meta && currentSources.maritime) {
                const darkCount = data.meta.darkVesselCount || 0;
                useTimelineStore.getState().setStreamMetric('maritime', {
                    count: data.meta.maritimeTotal + darkCount,
                    status: data.meta.maritimeTotal > 0 ? 'streaming' : 'connecting'
                });
            }

            // ---- Dark vessels via Entity API ----
            if (data.darkVessels && Array.isArray(data.darkVessels)) {
                // Track which dark vessels are in the current payload
                const currentDarkIds = new Set<string>();
                for (const dv of data.darkVessels) {
                    const darkId = `dark-${dv.id}`;
                    currentDarkIds.add(darkId);

                    let entity = darkVesselDs.entities.getById(darkId);
                    if (!entity) {
                        const darkSinceDate = new Date(dv.darkSince);
                        const darkMinutes = Math.round((Date.now() - dv.darkSince) / 60000);
                        darkVesselDs.entities.add({
                            id: darkId,
                            name: `Dark Vessel ${dv.id} (${darkMinutes}m silent)`,
                            position: Cesium.Cartesian3.fromDegrees(dv.lng, dv.lat, 0),
                            properties: new Cesium.PropertyBag({
                                layer: 'Dark Vessel',
                                subtype: dv.type || 'unknown',
                                speed: dv.speed,
                                heading: dv.heading || 0,
                                lastSeen: new Date(dv.lastSeen).toISOString(),
                                darkSince: darkSinceDate.toISOString(),
                            }),
                            billboard: {
                                image: DARK_VESSEL_ICON,
                                scale: 1.1,
                            },
                            // Red pulsing ellipse around last known position
                            ellipse: {
                                semiMinorAxis: 50_000,
                                semiMajorAxis: 50_000,
                                material: new Cesium.ColorMaterialProperty(Cesium.Color.RED.withAlpha(0.08)),
                                height: 0,
                                outline: true,
                                outlineColor: Cesium.Color.RED.withAlpha(0.3),
                                outlineWidth: 1,
                            },
                        });
                    } else {
                        // Update name with current dark duration
                        const darkMinutes = Math.round((Date.now() - dv.darkSince) / 60000);
                        entity.name = `Dark Vessel ${dv.id} (${darkMinutes}m silent)`;
                    }
                }

                // Remove entities that are no longer dark (vessel reappeared)
                const toRemove: string[] = [];
                darkVesselDs.entities.values.forEach(e => {
                    if (!currentDarkIds.has(e.id)) toRemove.push(e.id);
                });
                for (const id of toRemove) darkVesselDs.entities.removeById(id);
            }
        });

        return () => {
            active = false;
            clearInterval(speedInterval);
            clearInterval(staleCleanup);
            socket.disconnect();
            socketRef.current = null;
            aircraftMetaMap.clear();
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(aviBillboards);
                viewer.dataSources.remove(maritimeDs);
                viewer.dataSources.remove(darkVesselDs);
            }
            aviBillboardsRef.current = null;
            maritimeDsRef.current = null;
            darkVesselDsRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: visibility toggles ----
    // Effective show = source && visibility && !deepHistory. Source-off
    // hides the aircraft / vessel layers AND (via fresh-read inside the
    // socket handler) stops adding new entities. The scene clear on
    // source-off is handled in Effect 0a below.
    const aviSourceOnSel = useTimelineStore(s => s.sources.aviation);
    const marSourceOnSel = useTimelineStore(s => s.sources.maritime);
    useEffect(() => {
        const isDeepHistory = mode === 'playback' && (Date.now() - currentTime.getTime() > 10 * 60 * 1000);
        if (aviBillboardsRef.current) aviBillboardsRef.current.show = aviSourceOnSel && isAviationVisible && !isDeepHistory;
        if (maritimeDsRef.current) maritimeDsRef.current.show = marSourceOnSel && isMaritimeVisible && !isDeepHistory;
        if (darkVesselDsRef.current) darkVesselDsRef.current.show = marSourceOnSel && isMaritimeVisible && !isDeepHistory;
    }, [aviSourceOnSel, marSourceOnSel, isAviationVisible, isMaritimeVisible, mode, currentTime]);

    // ---- Effect 0a: source-off scene clear ----
    // When the user turns aviation / maritime OFF, drop the existing
    // billboards / entities so that re-enabling starts from an empty
    // scene and the next simulator-update repopulates with fresh data.
    // This matches the user's mental model: source off = no data on
    // screen; source on = current data rendered.
    useEffect(() => {
        if (!aviSourceOnSel) {
            const bbs = aviBillboardsRef.current;
            if (bbs) bbs.removeAll();
            aviBillboardMap.current.clear();
            aviLastSeenRef.current.clear();
            aircraftMetaMap.clear();
            useTimelineStore.getState().setSubtypeCounts('aviation', {});
            useTimelineStore.getState().setStreamMetric('aviation', {
                count: 0,
                status: 'disabled',
                speed: '-',
            });
        }
    }, [aviSourceOnSel]);
    useEffect(() => {
        if (!marSourceOnSel) {
            const mds = maritimeDsRef.current;
            const dvs = darkVesselDsRef.current;
            if (mds) mds.entities.removeAll();
            if (dvs) dvs.entities.removeAll();
            marLastSeenRef.current.clear();
            useTimelineStore.getState().setSubtypeCounts('maritime', {});
            useTimelineStore.getState().setStreamMetric('maritime', {
                count: 0,
                status: 'disabled',
                speed: '-',
            });
        }
    }, [marSourceOnSel]);

    // ---- Effect 3: vessel trails toggle ----
    // Flips every existing vessel's `path.show` on any state change —
    // constant property, no per-frame cost when the flag is steady.
    useEffect(() => {
        const ds = maritimeDsRef.current;
        if (!ds) return;
        const constant = new Cesium.ConstantProperty(showTrajectories);
        ds.entities.values.forEach(e => {
            if (e.path) e.path.show = constant;
        });
    }, [showTrajectories]);

    // ---- Effect 4: per-subtype visibility (aviation + maritime) ----
    useEffect(() => {
        const hasAviationFilters = Object.keys(subtypeVisibility).some(k => k.startsWith('aviation:'));
        if (hasAviationFilters) {
            aviBillboardMap.current.forEach((bb, id) => {
                const meta = aircraftMetaMap.get(id);
                if (meta) {
                    bb.show = subtypeVisibility[`aviation:${meta.type}`] !== false;
                }
            });
        }

        const hasMaritimeFilters = Object.keys(subtypeVisibility).some(k => k.startsWith('maritime:'));
        if (hasMaritimeFilters && maritimeDsRef.current) {
            maritimeDsRef.current.entities.values.forEach(e => {
                const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'unknown';
                e.show = subtypeVisibility[`maritime:${sub}`] !== false;
            });
        }
    }, [subtypeVisibility]);
}
