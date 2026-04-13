// ---------------------------------------------------------------------------
// map-icons.ts — Centralized SVG icon definitions for all map layers
// ---------------------------------------------------------------------------
// Every inline SVG that was previously defined at the top of individual layer
// hooks is collected here. Layer hooks should import from this module instead
// of defining icons inline.
//
// Public API:
//   - Named icon constants (AVI_ICONS, VESSEL_ICONS, etc.)
//   - getMapIcon(layer, subtype) — universal lookup
//   - getOsintIcon(eventType, alertLevel) — parametric OSINT builder
//   - getFireDot(rgb) — parametric fire dot builder
//   - svgUri(path, color?) — 32×32 viewBox-24 helper
//   - svgDataUri(svg) — complete SVG data URI helper
// ---------------------------------------------------------------------------

// ========================== Shared helpers ==================================

/**
 * Wraps an inline SVG body fragment in a data URI.
 * Produces a 32×32 icon with a 24×24 viewBox, black stroke — the standard
 * format used by aircraft icons and (with the optional `color` override)
 * other layers.
 */
export function svgUri(body: string, color?: string): string {
  const stroke = color ?? 'black';
  return (
    `data:image/svg+xml,` +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" ` +
      `stroke="${stroke}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
    )
  );
}

/**
 * Wraps a complete SVG string (including the outer `<svg>` tag) in a data URI.
 * Used for vessels (48×48 viewBox) and other icons that need full control of
 * dimensions, viewBox, strokes, etc.
 */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml,` + encodeURIComponent(svg);
}

// ======================== Aircraft icons ====================================
// 32×32 output, 24×24 viewBox, black stroke

export const AVI_ICONS: Record<string, string> = {
  airliner: svgUri(
    `<path d="M12 2 L10 11 L2 14 L2 16 L10 14 L10 20 L7 22 L7 23 L12 22 L17 23 L17 22 L14 20 L14 14 L22 16 L22 14 L14 11 Z" fill="#ffffff"/>`,
  ),
  military: svgUri(
    `<path d="M12 2 L8 13 L2 18 L2 20 L9 17 L9 21 L7 22 L7 23 L12 22 L17 23 L17 22 L15 21 L15 17 L22 20 L22 18 L16 13 Z" fill="#facc15"/>`,
  ),
  light: svgUri(
    `<circle cx="12" cy="12" r="2" fill="#60a5fa"/><path d="M12 4 L11 11 L4 12 L4 13 L11 13 L11 19 L9 20 L9 21 L12 20 L15 21 L15 20 L13 19 L13 13 L20 13 L20 12 L13 11 Z" fill="#60a5fa"/>`,
  ),
  general: svgUri(
    `<path d="M12 2 L10 11 L2 14 L2 16 L10 14 L10 20 L7 22 L7 23 L12 22 L17 23 L17 22 L14 20 L14 14 L22 16 L22 14 L14 11 Z" fill="#e5e7eb"/>`,
  ),
};

/** Resolve an aircraft type to its icon data URI. Falls back to `general`. */
export function getAviIcon(type: string): string {
  return AVI_ICONS[type] || AVI_ICONS.general;
}

// ======================== Vessel icons ======================================
// 32×32 output, 48×48 viewBox — full SVG via svgDataUri

export const VESSEL_ICONS: Record<string, string> = {
  cargo: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<path d="M24 3 C24 3 19 5 17 9 L15 38 C15 42 19 45 24 45 C29 45 33 42 33 38 L31 9 C29 5 24 3 24 3 Z" fill="#d1d5db" stroke="#6b7280" stroke-width="1"/>` +
    `<rect x="17" y="12" width="14" height="24" rx="1.5" fill="#e5e7eb" stroke="#9ca3af" stroke-width="0.6"/>` +
    `<rect x="18" y="13" width="5" height="4.5" rx="0.5" fill="#f97316" stroke="#9a3412" stroke-width="0.4"/>` +
    `<rect x="25" y="13" width="5" height="4.5" rx="0.5" fill="#3b82f6" stroke="#1e40af" stroke-width="0.4"/>` +
    `<rect x="18" y="18.5" width="5" height="4.5" rx="0.5" fill="#22c55e" stroke="#166534" stroke-width="0.4"/>` +
    `<rect x="25" y="18.5" width="5" height="4.5" rx="0.5" fill="#ef4444" stroke="#991b1b" stroke-width="0.4"/>` +
    `<rect x="18" y="24" width="5" height="4.5" rx="0.5" fill="#8b5cf6" stroke="#5b21b6" stroke-width="0.4"/>` +
    `<rect x="25" y="24" width="5" height="4.5" rx="0.5" fill="#f97316" stroke="#9a3412" stroke-width="0.4"/>` +
    `<rect x="18" y="29.5" width="5" height="4.5" rx="0.5" fill="#3b82f6" stroke="#1e40af" stroke-width="0.4"/>` +
    `<rect x="25" y="29.5" width="5" height="4.5" rx="0.5" fill="#22c55e" stroke="#166534" stroke-width="0.4"/>` +
    `<rect x="20" y="35" width="8" height="5" rx="1" fill="#374151" stroke="#1f2937" stroke-width="0.6"/>` +
    `<rect x="21" y="36" width="1.5" height="1.2" rx="0.2" fill="#67e8f9" opacity="0.7"/>` +
    `<rect x="23.25" y="36" width="1.5" height="1.2" rx="0.2" fill="#67e8f9" opacity="0.7"/>` +
    `<rect x="25.5" y="36" width="1.5" height="1.2" rx="0.2" fill="#67e8f9" opacity="0.7"/>` +
    `<line x1="21" y1="13" x2="21" y2="10" stroke="#6b7280" stroke-width="0.8"/>` +
    `<line x1="19" y1="10" x2="23" y2="10" stroke="#6b7280" stroke-width="0.8"/>` +
    `<line x1="27" y1="13" x2="27" y2="10" stroke="#6b7280" stroke-width="0.8"/>` +
    `<line x1="25" y1="10" x2="29" y2="10" stroke="#6b7280" stroke-width="0.8"/>` +
    `<line x1="22" y1="7" x2="26" y2="7" stroke="#9ca3af" stroke-width="0.8" stroke-linecap="round"/>` +
    `</svg>`,
  ),

  tanker: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<path d="M24 3 C24 3 18 6 16 10 L14 38 C14 42 18 45 24 45 C30 45 34 42 34 38 L32 10 C30 6 24 3 24 3 Z" fill="#dc2626" stroke="#991b1b" stroke-width="1"/>` +
    `<rect x="17" y="14" width="14" height="22" rx="2" fill="#ef4444" stroke="#991b1b" stroke-width="0.7"/>` +
    `<rect x="19" y="30" width="10" height="6" rx="1" fill="#1e293b" stroke="#0f172a" stroke-width="0.7"/>` +
    `<rect x="20" y="31" width="2" height="1.5" rx="0.3" fill="#67e8f9" opacity="0.8"/>` +
    `<rect x="23" y="31" width="2" height="1.5" rx="0.3" fill="#67e8f9" opacity="0.8"/>` +
    `<rect x="26" y="31" width="2" height="1.5" rx="0.3" fill="#67e8f9" opacity="0.8"/>` +
    `<circle cx="21" cy="17" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/>` +
    `<circle cx="27" cy="17" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/>` +
    `<circle cx="21" cy="22" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/>` +
    `<circle cx="27" cy="22" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/>` +
    `<circle cx="21" cy="27" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/>` +
    `<circle cx="27" cy="27" r="2.2" fill="#b91c1c" stroke="#991b1b" stroke-width="0.5"/>` +
    `<line x1="24" y1="14" x2="24" y2="30" stroke="#991b1b" stroke-width="1" stroke-dasharray="2 1"/>` +
    `<line x1="22" y1="8" x2="26" y2="8" stroke="#fca5a5" stroke-width="1" stroke-linecap="round"/>` +
    `<line x1="21" y1="10" x2="27" y2="10" stroke="#fca5a5" stroke-width="0.7" stroke-linecap="round"/>` +
    `<line x1="24" y1="30" x2="24" y2="27" stroke="#475569" stroke-width="0.8"/>` +
    `<circle cx="24" cy="26.5" r="0.6" fill="#67e8f9"/>` +
    `<path d="M20 43 Q24 46 28 43" fill="none" stroke="white" stroke-width="0.5" opacity="0.3"/>` +
    `</svg>`,
  ),

  passenger: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<path d="M24 3 C24 3 18 6 16 10 L14 38 C14 42 18 45 24 45 C30 45 34 42 34 38 L32 10 C30 6 24 3 24 3 Z" fill="#f8fafc" stroke="#2563eb" stroke-width="1.2"/>` +
    `<path d="M24 43 C19 43 16 41 15 38 L17 38 C18 40 20 41 24 41 C28 41 30 40 31 38 L33 38 C32 41 29 43 24 43 Z" fill="#2563eb" opacity="0.6"/>` +
    `<rect x="17" y="10" width="14" height="28" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-width="0.5"/>` +
    `<rect x="17.5" y="13" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="17.5" y="15.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="17.5" y="18" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="17.5" y="20.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="17.5" y="23" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="17.5" y="25.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="17.5" y="28" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="29.3" y="13" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="29.3" y="15.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="29.3" y="18" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="29.3" y="20.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="29.3" y="23" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="29.3" y="25.5" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="29.3" y="28" width="1.2" height="1" rx="0.2" fill="#fef08a"/>` +
    `<rect x="20" y="14" width="8" height="5" rx="1.5" fill="#bfdbfe" stroke="#2563eb" stroke-width="0.5"/>` +
    `<rect x="21" y="15" width="6" height="3" rx="1" fill="#93c5fd" stroke="#3b82f6" stroke-width="0.3"/>` +
    `<rect x="22" y="22" width="4" height="3" rx="0.5" fill="#1e40af" stroke="#1e3a5f" stroke-width="0.5"/>` +
    `<line x1="22" y1="23.5" x2="26" y2="23.5" stroke="#f8fafc" stroke-width="0.6"/>` +
    `<rect x="20" y="8" width="8" height="4" rx="1" fill="#1e3a5f" stroke="#1e40af" stroke-width="0.6"/>` +
    `<rect x="21" y="9" width="1.5" height="1" rx="0.2" fill="#fef08a" opacity="0.9"/>` +
    `<rect x="23.25" y="9" width="1.5" height="1" rx="0.2" fill="#fef08a" opacity="0.9"/>` +
    `<rect x="25.5" y="9" width="1.5" height="1" rx="0.2" fill="#fef08a" opacity="0.9"/>` +
    `<rect x="20" y="30" width="8" height="6" rx="1" fill="#e2e8f0" stroke="#94a3b8" stroke-width="0.4"/>` +
    `<circle cx="24" cy="33" r="2.5" fill="none" stroke="#2563eb" stroke-width="0.5"/>` +
    `<text x="24" y="34" text-anchor="middle" font-size="3" fill="#2563eb" font-family="sans-serif">H</text>` +
    `<line x1="22" y1="6" x2="26" y2="6" stroke="#2563eb" stroke-width="0.8" stroke-linecap="round"/>` +
    `</svg>`,
  ),

  fishing: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<path d="M24 5 C24 5 20 7 19 10 L17 38 C17 41 20 44 24 44 C28 44 31 41 31 38 L29 10 C28 7 24 5 24 5 Z" fill="#84cc16" stroke="#4d7c0f" stroke-width="1"/>` +
    `<rect x="19" y="12" width="10" height="24" rx="1.5" fill="#a3e635" stroke="#65a30d" stroke-width="0.5"/>` +
    `<rect x="21" y="12" width="6" height="5" rx="1" fill="#365314" stroke="#1a2e05" stroke-width="0.6"/>` +
    `<rect x="22" y="13" width="1.2" height="1" rx="0.2" fill="#67e8f9" opacity="0.7"/>` +
    `<rect x="24.4" y="13" width="1.2" height="1" rx="0.2" fill="#67e8f9" opacity="0.7"/>` +
    `<line x1="24" y1="18" x2="24" y2="14" stroke="#4d7c0f" stroke-width="1.2"/>` +
    `<line x1="24" y1="14" x2="32" y2="10" stroke="#4d7c0f" stroke-width="1"/>` +
    `<line x1="32" y1="10" x2="32" y2="14" stroke="#65a30d" stroke-width="0.5" stroke-dasharray="1 1"/>` +
    `<path d="M20 28 Q24 32 28 28" fill="none" stroke="#4d7c0f" stroke-width="0.6" stroke-dasharray="1.5 1"/>` +
    `<path d="M20 31 Q24 35 28 31" fill="none" stroke="#4d7c0f" stroke-width="0.6" stroke-dasharray="1.5 1"/>` +
    `<path d="M20 34 Q24 38 28 34" fill="none" stroke="#4d7c0f" stroke-width="0.6" stroke-dasharray="1.5 1"/>` +
    `<circle cx="22" cy="25" r="1.8" fill="#65a30d" stroke="#4d7c0f" stroke-width="0.5"/>` +
    `<circle cx="26" cy="25" r="1.8" fill="#65a30d" stroke="#4d7c0f" stroke-width="0.5"/>` +
    `<line x1="20.2" y1="25" x2="23.8" y2="25" stroke="#4d7c0f" stroke-width="0.3"/>` +
    `<line x1="24.2" y1="25" x2="27.8" y2="25" stroke="#4d7c0f" stroke-width="0.3"/>` +
    `<line x1="24" y1="18" x2="24" y2="22" stroke="#4d7c0f" stroke-width="0.8"/>` +
    `<circle cx="24" cy="18" r="0.5" fill="#a3e635"/>` +
    `</svg>`,
  ),

  military: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<path d="M24 2 C24 2 21 4 20 7 L18 12 L16 36 C16 40 19 44 24 44 C29 44 32 40 32 36 L30 12 L28 7 C27 4 24 2 24 2 Z" fill="#475569" stroke="#334155" stroke-width="1"/>` +
    `<path d="M20 10 L18 36 C18 39 20 42 24 42 C28 42 30 39 30 36 L28 10 Z" fill="#64748b" stroke="#475569" stroke-width="0.5"/>` +
    `<circle cx="24" cy="11" r="2.5" fill="#334155" stroke="#1e293b" stroke-width="0.6"/>` +
    `<line x1="24" y1="11" x2="24" y2="5" stroke="#334155" stroke-width="1.5" stroke-linecap="round"/>` +
    `<rect x="20" y="17" width="8" height="8" rx="1" fill="#334155" stroke="#1e293b" stroke-width="0.6"/>` +
    `<rect x="21" y="18" width="1.2" height="0.8" rx="0.2" fill="#67e8f9" opacity="0.6"/>` +
    `<rect x="23.4" y="18" width="1.2" height="0.8" rx="0.2" fill="#67e8f9" opacity="0.6"/>` +
    `<rect x="25.8" y="18" width="1.2" height="0.8" rx="0.2" fill="#67e8f9" opacity="0.6"/>` +
    `<line x1="24" y1="17" x2="24" y2="14" stroke="#94a3b8" stroke-width="0.8"/>` +
    `<line x1="21" y1="14.5" x2="27" y2="14.5" stroke="#94a3b8" stroke-width="0.6"/>` +
    `<rect x="22" y="14" width="4" height="1" rx="0.3" fill="#94a3b8" stroke="#64748b" stroke-width="0.3"/>` +
    `<rect x="21" y="26" width="2.5" height="2.5" rx="0.3" fill="#1e293b" stroke="#475569" stroke-width="0.4"/>` +
    `<rect x="24.5" y="26" width="2.5" height="2.5" rx="0.3" fill="#1e293b" stroke="#475569" stroke-width="0.4"/>` +
    `<rect x="21" y="29.5" width="2.5" height="2.5" rx="0.3" fill="#1e293b" stroke="#475569" stroke-width="0.4"/>` +
    `<rect x="24.5" y="29.5" width="2.5" height="2.5" rx="0.3" fill="#1e293b" stroke="#475569" stroke-width="0.4"/>` +
    `<circle cx="24" cy="35" r="1.8" fill="#334155" stroke="#1e293b" stroke-width="0.5"/>` +
    `<line x1="24" y1="35" x2="24" y2="38" stroke="#334155" stroke-width="1" stroke-linecap="round"/>` +
    `<rect x="20" y="37" width="8" height="4" rx="0.5" fill="#475569" stroke="#334155" stroke-width="0.4"/>` +
    `<circle cx="24" cy="39" r="1.5" fill="none" stroke="#94a3b8" stroke-width="0.4"/>` +
    `<rect x="22" y="22" width="1.5" height="2" rx="0.3" fill="#1e293b"/>` +
    `<rect x="24.5" y="22" width="1.5" height="2" rx="0.3" fill="#1e293b"/>` +
    `</svg>`,
  ),

  unknown: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<path d="M24 5 C24 5 20 7 18 11 L16 37 C16 41 19 44 24 44 C29 44 32 41 32 37 L30 11 C28 7 24 5 24 5 Z" fill="#9ca3af" stroke="#6b7280" stroke-width="1"/>` +
    `<rect x="19" y="13" width="10" height="22" rx="1.5" fill="#d1d5db" stroke="#9ca3af" stroke-width="0.5"/>` +
    `<rect x="21" y="30" width="6" height="4" rx="1" fill="#4b5563" stroke="#374151" stroke-width="0.6"/>` +
    `<rect x="22" y="31" width="1.2" height="1" rx="0.2" fill="#67e8f9" opacity="0.5"/>` +
    `<rect x="24.4" y="31" width="1.2" height="1" rx="0.2" fill="#67e8f9" opacity="0.5"/>` +
    `<rect x="20" y="15" width="8" height="5" rx="0.5" fill="#b5b5b5" stroke="#9ca3af" stroke-width="0.4"/>` +
    `<rect x="20" y="22" width="8" height="5" rx="0.5" fill="#b5b5b5" stroke="#9ca3af" stroke-width="0.4"/>` +
    `<line x1="24" y1="30" x2="24" y2="27" stroke="#6b7280" stroke-width="0.8"/>` +
    `<text x="24" y="20" text-anchor="middle" font-size="5" fill="#4b5563" font-family="sans-serif" font-weight="bold">?</text>` +
    `</svg>`,
  ),
};

/** Resolve a vessel type to its icon data URI. Falls back to `unknown`. */
export function getShipIcon(type: string): string {
  return VESSEL_ICONS[type] || VESSEL_ICONS.unknown;
}

// ====================== Dark vessel icon ====================================
// 36×36, 48×48 viewBox — ominous silhouette with red warning badge

export const DARK_VESSEL_ICON: string =
  `data:image/svg+xml,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 48 48">` +
    `<path d="M24 4 C24 4 20 7 18 10 L16 36 C16 40 19 43 24 43 C29 43 32 40 32 36 L30 10 C28 7 24 4 24 4 Z" fill="#1f2937" stroke="#dc2626" stroke-width="1.2"/>` +
    `<path d="M20 12 L18 36 C18 39 20 41 24 41 C28 41 30 39 30 36 L28 12 Z" fill="#374151" stroke="#1f2937" stroke-width="0.5"/>` +
    `<rect x="20" y="18" width="8" height="7" rx="1" fill="#111827" stroke="#1f2937" stroke-width="0.6"/>` +
    `<rect x="21" y="19.5" width="1.5" height="0.8" rx="0.2" fill="#374151" opacity="0.5"/>` +
    `<rect x="23.25" y="19.5" width="1.5" height="0.8" rx="0.2" fill="#374151" opacity="0.5"/>` +
    `<rect x="25.5" y="19.5" width="1.5" height="0.8" rx="0.2" fill="#374151" opacity="0.5"/>` +
    `<line x1="24" y1="18" x2="24" y2="15" stroke="#4b5563" stroke-width="0.8"/>` +
    `<line x1="22" y1="8" x2="26" y2="8" stroke="#6b7280" stroke-width="0.8" stroke-linecap="round"/>` +
    `<rect x="20" y="33" width="8" height="5" rx="0.5" fill="#111827" stroke="#1f2937" stroke-width="0.4"/>` +
    `<circle cx="21.5" cy="28" r="1.8" fill="#111827" stroke="#374151" stroke-width="0.4"/>` +
    `<circle cx="26.5" cy="28" r="1.8" fill="#111827" stroke="#374151" stroke-width="0.4"/>` +
    `<circle cx="35" cy="10" r="7" fill="#ef4444" stroke="#991b1b" stroke-width="1"/>` +
    `<rect x="33.5" y="5.5" width="3" height="5.5" rx="1.5" fill="#fff"/>` +
    `<circle cx="35" cy="13.5" r="1.3" fill="#fff"/>` +
    `</svg>`,
  );

// ======================== Satellite icons ===================================
// 32×32 output, 24×24 viewBox

export const SAT_ICONS: Record<string, string> = {
  military: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">` +
    `<polygon points="10,6 14,6 15,8 15,16 14,18 10,18 9,16 9,8" fill="#ef4444" stroke="#000000" stroke-width="1.2"/>` +
    `<line x1="9" y1="10" x2="15" y2="10" stroke="#000000" stroke-width="0.5" opacity="0.6"/>` +
    `<line x1="9" y1="14" x2="15" y2="14" stroke="#000000" stroke-width="0.5" opacity="0.6"/>` +
    `<rect x="1" y="9" width="7" height="6" rx="0.5" fill="#ef4444" stroke="#000000" stroke-width="1"/>` +
    `<line x1="3.3" y1="9" x2="3.3" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="5.6" y1="9" x2="5.6" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="1" y1="12" x2="8" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<rect x="16" y="9" width="7" height="6" rx="0.5" fill="#ef4444" stroke="#000000" stroke-width="1"/>` +
    `<line x1="18.3" y1="9" x2="18.3" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="20.6" y1="9" x2="20.6" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="16" y1="12" x2="23" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<circle cx="12" cy="12" r="2" fill="#000000" stroke="#000000" stroke-width="0.6" opacity="0.7"/>` +
    `<circle cx="12" cy="12" r="1" fill="#ffffff" opacity="0.9"/>` +
    `<rect x="10.5" y="3.5" width="3" height="2" rx="0.5" fill="#ef4444" stroke="#000000" stroke-width="0.8"/>` +
    `<line x1="12" y1="6" x2="12" y2="5.5" stroke="#000000" stroke-width="0.6"/>` +
    `<polygon points="11,18 13,18 13.5,20 10.5,20" fill="#ef4444" stroke="#000000" stroke-width="0.6" opacity="0.8"/>` +
    `</svg>`,
  ),

  commercial: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">` +
    `<rect x="9" y="8" width="6" height="8" rx="1" fill="#06b6d4" stroke="#000000" stroke-width="1.2"/>` +
    `<line x1="9" y1="10.5" x2="15" y2="10.5" stroke="#000000" stroke-width="0.4" opacity="0.6"/>` +
    `<line x1="9" y1="13.5" x2="15" y2="13.5" stroke="#000000" stroke-width="0.4" opacity="0.6"/>` +
    `<rect x="0.5" y="8.5" width="7.5" height="7" rx="0.5" fill="#06b6d4" stroke="#000000" stroke-width="1"/>` +
    `<line x1="2.5" y1="8.5" x2="2.5" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="4.5" y1="8.5" x2="4.5" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="6.5" y1="8.5" x2="6.5" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="0.5" y1="12" x2="8" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<rect x="16" y="8.5" width="7.5" height="7" rx="0.5" fill="#06b6d4" stroke="#000000" stroke-width="1"/>` +
    `<line x1="18" y1="8.5" x2="18" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="20" y1="8.5" x2="20" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="22" y1="8.5" x2="22" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="16" y1="12" x2="23.5" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="12" y1="8" x2="12" y2="4.5" stroke="#000000" stroke-width="0.8"/>` +
    `<ellipse cx="12" cy="3.5" rx="3" ry="1.2" fill="#06b6d4" stroke="#000000" stroke-width="0.8"/>` +
    `<circle cx="12" cy="3.5" r="0.5" fill="#ffffff" opacity="0.9"/>` +
    `<line x1="12" y1="3.5" x2="12" y2="1.5" stroke="#000000" stroke-width="0.5" opacity="0.7"/>` +
    `<line x1="9" y1="9" x2="7" y2="7" stroke="#000000" stroke-width="0.5" opacity="0.6"/>` +
    `<circle cx="6.8" cy="6.8" r="0.3" fill="#000000" opacity="0.6"/>` +
    `<line x1="15" y1="9" x2="17" y2="7" stroke="#000000" stroke-width="0.5" opacity="0.6"/>` +
    `<circle cx="17.2" cy="6.8" r="0.3" fill="#000000" opacity="0.6"/>` +
    `<polygon points="11,16 13,16 13.5,18 10.5,18" fill="#06b6d4" stroke="#000000" stroke-width="0.5" opacity="0.7"/>` +
    `</svg>`,
  ),

  civilian: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">` +
    `<rect x="11" y="5" width="2" height="14" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1.2"/>` +
    `<line x1="11" y1="8" x2="13" y2="10" stroke="#000000" stroke-width="0.4" opacity="0.6"/>` +
    `<line x1="13" y1="8" x2="11" y2="10" stroke="#000000" stroke-width="0.4" opacity="0.6"/>` +
    `<line x1="11" y1="13" x2="13" y2="15" stroke="#000000" stroke-width="0.4" opacity="0.6"/>` +
    `<line x1="13" y1="13" x2="11" y2="15" stroke="#000000" stroke-width="0.4" opacity="0.6"/>` +
    `<rect x="1" y="7" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/>` +
    `<line x1="3.25" y1="7" x2="3.25" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="5.5" y1="7" x2="5.5" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="7.75" y1="7" x2="7.75" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<rect x="1" y="14" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/>` +
    `<line x1="3.25" y1="14" x2="3.25" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="5.5" y1="14" x2="5.5" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="7.75" y1="14" x2="7.75" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<rect x="14" y="7" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/>` +
    `<line x1="16.25" y1="7" x2="16.25" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="18.5" y1="7" x2="18.5" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="20.75" y1="7" x2="20.75" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<rect x="14" y="14" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/>` +
    `<line x1="16.25" y1="14" x2="16.25" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="18.5" y1="14" x2="18.5" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<line x1="20.75" y1="14" x2="20.75" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
    `<rect x="10" y="3" width="4" height="2" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="0.8"/>` +
    `<circle cx="11" cy="4" r="0.4" fill="#000000" opacity="0.9"/>` +
    `<circle cx="13" cy="4" r="0.4" fill="#000000" opacity="0.9"/>` +
    `<line x1="12" y1="19" x2="12" y2="22" stroke="#000000" stroke-width="0.6" opacity="0.7"/>` +
    `<circle cx="12" cy="22.5" r="0.8" fill="#84cc16" stroke="#000000" stroke-width="0.5" opacity="0.7"/>` +
    `<circle cx="12" cy="22.5" r="0.3" fill="#000000" opacity="0.7"/>` +
    `</svg>`,
  ),
};

export const SAT_RECON_ICON: string = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">` +
  `<rect x="9.5" y="5" width="5" height="13" rx="1.5" fill="#f59e0b" stroke="#000000" stroke-width="1.2"/>` +
  `<line x1="9.5" y1="8" x2="14.5" y2="8" stroke="#000000" stroke-width="0.5" opacity="0.6"/>` +
  `<line x1="9.5" y1="11" x2="14.5" y2="11" stroke="#000000" stroke-width="0.5" opacity="0.6"/>` +
  `<line x1="9.5" y1="15" x2="14.5" y2="15" stroke="#000000" stroke-width="0.5" opacity="0.6"/>` +
  `<circle cx="12" cy="3.5" r="2.5" fill="#f59e0b" stroke="#000000" stroke-width="1"/>` +
  `<circle cx="12" cy="3.5" r="1.2" fill="#000000" stroke="#000000" stroke-width="0.5" opacity="0.7"/>` +
  `<circle cx="12" cy="3.5" r="0.5" fill="#ffffff" opacity="0.9"/>` +
  `<ellipse cx="12" cy="2" rx="3.2" ry="0.8" fill="#f59e0b" stroke="#000000" stroke-width="0.6" opacity="0.7"/>` +
  `<rect x="1.5" y="9.5" width="7" height="5" rx="0.5" fill="#f59e0b" stroke="#000000" stroke-width="1"/>` +
  `<line x1="4" y1="9.5" x2="4" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
  `<line x1="6.5" y1="9.5" x2="6.5" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
  `<line x1="1.5" y1="12" x2="8.5" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
  `<rect x="15.5" y="9.5" width="7" height="5" rx="0.5" fill="#f59e0b" stroke="#000000" stroke-width="1"/>` +
  `<line x1="18" y1="9.5" x2="18" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
  `<line x1="20.5" y1="9.5" x2="20.5" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
  `<line x1="15.5" y1="12" x2="22.5" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/>` +
  `<line x1="12" y1="18" x2="12" y2="21" stroke="#000000" stroke-width="0.8" opacity="0.7"/>` +
  `<path d="M10 21 Q12 23 14 21" fill="none" stroke="#000000" stroke-width="0.6" opacity="0.6"/>` +
  `</svg>`,
);

/** Resolve a satellite type to its icon data URI. Recon flag overrides type. */
export function getSatIcon(type: string, isRecon?: boolean): string {
  if (isRecon) return SAT_RECON_ICON;
  return SAT_ICONS[type] || SAT_ICONS.civilian;
}

// ==================== Infrastructure icons ==================================
// 32×32 output, 24×24 viewBox — uses fill="none" stroke variant

/**
 * Infrastructure-specific svgUri helper.
 * Same 32×32 / viewBox-24 pattern but with `fill="none"` on the outer SVG
 * (individual shapes set their own fill).
 */
function infraSvgUri(body: string): string {
  return (
    `data:image/svg+xml,` +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
    )
  );
}

export const INFRA_ICONS: Record<string, string> = {
  power_plant: infraSvgUri(
    `<polygon points="13,2 3,14 12,14 11,22 21,10 12,10" fill="#eab308" stroke="#000" stroke-width="1"/>`,
  ),
  refinery: infraSvgUri(
    `<rect x="4" y="12" width="16" height="10" fill="#ef4444" stroke="#000" stroke-width="1" rx="1"/>` +
    `<rect x="6" y="6" width="3" height="6" fill="#ef4444" stroke="#000" stroke-width="1"/>` +
    `<rect x="11" y="8" width="3" height="4" fill="#ef4444" stroke="#000" stroke-width="1"/>` +
    `<line x1="7.5" y1="2" x2="7.5" y2="6" stroke="#666" stroke-width="1.5"/>` +
    `<line x1="12.5" y1="4" x2="12.5" y2="8" stroke="#666" stroke-width="1.5"/>`,
  ),
  desalination: infraSvgUri(
    `<path d="M12 2 C12 2 5 12 5 16 a7 7 0 0 0 14 0 C19 12 12 2 12 2 Z" fill="#3b82f6" stroke="#000" stroke-width="1"/>`,
  ),
  military: infraSvgUri(
    `<path d="M12 2 L4 6 V12 C4 17 8 21 12 22 C16 21 20 17 20 12 V6 Z" fill="#6b7280" stroke="#000" stroke-width="1"/>` +
    `<path d="M9 12 L11 14 L15 10" stroke="#fff" stroke-width="2" fill="none"/>`,
  ),
  power_substation: infraSvgUri(
    `<circle cx="12" cy="12" r="9" fill="#f97316" fill-opacity="0.8" stroke="#000" stroke-width="1"/>` +
    `<polygon points="13,5 8,13 11,13 10,19 16,11 13,11" fill="#fff" stroke="none"/>`,
  ),
  communication_tower: infraSvgUri(
    `<line x1="12" y1="2" x2="12" y2="18" stroke="#06b6d4" stroke-width="2"/>` +
    `<line x1="6" y1="8" x2="12" y2="2" stroke="#06b6d4" stroke-width="1.5"/>` +
    `<line x1="18" y1="8" x2="12" y2="2" stroke="#06b6d4" stroke-width="1.5"/>` +
    `<circle cx="12" cy="4" r="2" fill="#06b6d4" stroke="#000" stroke-width="0.5"/>` +
    `<rect x="9" y="18" width="6" height="4" fill="#06b6d4" stroke="#000" stroke-width="0.5" rx="1"/>`,
  ),
  aerodrome: infraSvgUri(
    `<path d="M12 2 L14 8 L22 10 L14 12 L14 18 L18 20 L18 22 L12 20 L6 22 L6 20 L10 18 L10 12 L2 10 L10 8 Z" fill="#9ca3af" stroke="#000" stroke-width="0.8"/>`,
  ),
  dam: infraSvgUri(
    `<path d="M2 12 Q6 8 12 12 Q18 16 22 12" stroke="#3b82f6" stroke-width="2" fill="none"/>` +
    `<path d="M2 16 Q6 12 12 16 Q18 20 22 16" stroke="#3b82f6" stroke-width="2" fill="none"/>` +
    `<rect x="4" y="4" width="16" height="6" fill="#3b82f6" fill-opacity="0.3" stroke="#3b82f6" stroke-width="1" rx="1"/>`,
  ),
};

/** Resolve an infrastructure subtype to its icon data URI. Falls back to power_plant. */
export function getInfraIcon(subtype: string): string {
  return INFRA_ICONS[subtype] || INFRA_ICONS.power_plant;
}

// ======================== Conflict icons ====================================
// 32×32 output, 48×48 viewBox — full SVG via svgDataUri

export const CONFLICT_ICON_EXPLOSIONS: string =
  `data:image/svg+xml,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<circle cx="24" cy="24" r="20" fill="#ef4444" opacity="0.12"/>` +
    `<polygon points="24,2 27,14 34,6 30,16 42,12 33,20 46,24 33,28 42,36 30,32 34,42 27,34 24,46 21,34 14,42 18,32 6,36 15,28 2,24 15,20 6,12 18,16 14,6 21,14" fill="#ef4444" stroke="#991b1b" stroke-width="0.8"/>` +
    `<polygon points="24,10 27,18 32,13 29,19 38,18 31,22 38,24 31,26 38,30 29,29 32,35 27,30 24,38 21,30 16,35 19,29 10,30 17,26 10,24 17,22 10,18 19,19 16,13 21,18" fill="#f97316" stroke="#ea580c" stroke-width="0.5"/>` +
    `<circle cx="24" cy="24" r="5" fill="#fbbf24" stroke="#f59e0b" stroke-width="0.5"/>` +
    `<circle cx="24" cy="24" r="2.5" fill="#fef3c7" opacity="0.8"/>` +
    `<circle cx="24" cy="24" r="1" fill="#ffffff"/>` +
    `</svg>`,
  );

export const CONFLICT_ICON_BATTLES: string =
  `data:image/svg+xml,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<path d="M2 22 L10 22 L10 18 L6 16 L2 18 Z" fill="#f97316" stroke="#000" stroke-width="0.8" stroke-linejoin="round"/>` +
    `<path d="M10 18 L10 24 L34 24 L36 20 L34 18 L10 18 Z" fill="#f97316" stroke="#000" stroke-width="0.8" stroke-linejoin="round"/>` +
    `<rect x="34" y="19" width="12" height="3" rx="0.5" fill="#f97316" stroke="#000" stroke-width="0.8"/>` +
    `<rect x="45" y="18" width="2" height="5" rx="0.3" fill="#f97316" stroke="#000" stroke-width="0.8"/>` +
    `<rect x="42" y="16" width="1.5" height="3" rx="0.3" fill="#f97316" stroke="#000" stroke-width="0.8"/>` +
    `<rect x="14" y="16" width="1.5" height="2" rx="0.3" fill="#f97316" stroke="#000" stroke-width="0.8"/>` +
    `<path d="M22 24 L24 24 L26 36 L20 36 Z" fill="#f97316" stroke="#000" stroke-width="0.8" stroke-linejoin="round"/>` +
    `<path d="M28 24 L30 24 L31 34 L27 34 Z" fill="#f97316" stroke="#000" stroke-width="0.8" stroke-linejoin="round"/>` +
    `<path d="M25 24 Q26 28 29 28 L29 24" fill="none" stroke="#000" stroke-width="0.8"/>` +
    `<rect x="20" y="16.5" width="14" height="1.5" rx="0.5" fill="#f97316" stroke="#000" stroke-width="0.6"/>` +
    `</svg>`,
  );

export const CONFLICT_ICON_VIOLENCE: string =
  `data:image/svg+xml,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<path d="M8 10 L40 38" stroke="#eab308" stroke-width="4" stroke-linecap="round" fill="none"/>` +
    `<circle cx="7" cy="8" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/>` +
    `<circle cx="10" cy="11" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/>` +
    `<circle cx="41" cy="40" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/>` +
    `<circle cx="38" cy="37" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/>` +
    `<path d="M40 10 L8 38" stroke="#eab308" stroke-width="4" stroke-linecap="round" fill="none"/>` +
    `<circle cx="41" cy="8" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/>` +
    `<circle cx="38" cy="11" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/>` +
    `<circle cx="7" cy="40" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/>` +
    `<circle cx="10" cy="37" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/>` +
    `<ellipse cx="24" cy="18" rx="12" ry="11" fill="#eab308" stroke="#000" stroke-width="1"/>` +
    `<path d="M14 22 L14 28 Q16 32 20 30 L22 32 L24 30 L26 32 L28 30 Q32 32 34 28 L34 22" fill="#eab308" stroke="#000" stroke-width="1"/>` +
    `<ellipse cx="19" cy="17" rx="3.5" ry="4" fill="#000"/>` +
    `<ellipse cx="29" cy="17" rx="3.5" ry="4" fill="#000"/>` +
    `<path d="M22 23 L24 21 L26 23" fill="#000" stroke="#000" stroke-width="0.5"/>` +
    `<line x1="18" y1="28" x2="30" y2="28" stroke="#000" stroke-width="0.6"/>` +
    `<line x1="21" y1="26" x2="21" y2="30" stroke="#000" stroke-width="0.5"/>` +
    `<line x1="24" y1="26" x2="24" y2="32" stroke="#000" stroke-width="0.5"/>` +
    `<line x1="27" y1="26" x2="27" y2="30" stroke="#000" stroke-width="0.5"/>` +
    `</svg>`,
  );

/** Resolve a conflict event type to its icon data URI. */
export function getConflictIcon(eventType: string): string {
  if (eventType.includes('Explosions') || eventType.includes('Remote violence'))
    return CONFLICT_ICON_EXPLOSIONS;
  if (eventType === 'Battles') return CONFLICT_ICON_BATTLES;
  return CONFLICT_ICON_VIOLENCE;
}

// ======================== OSINT / GDACS icons ===============================
// Parametric: (eventType, alertLevel) -> distinct shape + colour.
// 36×36 output, 24×24 viewBox.

/** Alert-level fill colours. */
export const OSINT_ALERT_FILL: Record<string, string> = {
  Red: '#ef4444',
  Orange: '#f97316',
  Green: '#22c55e',
};

/** SVG body fragments per GDACS event class. */
export const OSINT_EVENT_BODY: Record<string, string> = {
  // earthquake — concentric ripples
  EQ: `<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6" fill="none" stroke-width="1.5"/><circle cx="12" cy="12" r="9" fill="none" stroke-width="1"/>`,
  // tropical cyclone — spiral
  TC: `<path d="M12 4 a8 8 0 1 1 -8 8 a5 5 0 0 1 5 -5 a3 3 0 0 1 3 3 a1.5 1.5 0 0 1 -3 0" fill-opacity="0.85"/>`,
  // flood — waves
  FL: `<path d="M2 12 q3 -4 6 0 t6 0 t6 0 v6 h-18 z"/><path d="M2 8 q3 -4 6 0 t6 0 t6 0" fill="none" stroke-width="1.5"/>`,
  // volcano — triangle + smoke
  VO: `<polygon points="12,3 4,21 20,21"/><circle cx="12" cy="6" r="1.5" fill="black"/><path d="M11 4 q1 -2 2 0 q-1 2 0 4" fill="none" stroke="black"/>`,
  // wildfire — flame
  WF: `<path d="M12 3 q3 4 3 8 a3 3 0 1 1 -6 0 q0 -4 3 -8 z"/><path d="M12 9 q1.5 2 1.5 4 a1.5 1.5 0 1 1 -3 0 q0 -2 1.5 -4 z" fill="black"/>`,
  // drought — cracked land
  DR: `<rect x="3" y="14" width="18" height="6"/><path d="M6 14 v-3 m4 3 v-5 m4 5 v-4 m4 4 v-6"/>`,
  // unknown
  XX: `<rect x="6" y="6" width="12" height="12" rx="2"/>`,
};

/**
 * Build an OSINT/GDACS icon data URI from event type + alert level.
 * 36×36 output, 24×24 viewBox, coloured by alert severity.
 */
export function getOsintIcon(eventType: string, alertLevel: string): string {
  const body = OSINT_EVENT_BODY[eventType] || OSINT_EVENT_BODY.XX;
  const fill = OSINT_ALERT_FILL[alertLevel] || OSINT_ALERT_FILL.Green;
  return (
    `data:image/svg+xml,` +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" ` +
      `fill="${fill}" stroke="black" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
    )
  );
}

// ========================= Outage icons =====================================
// 40×40 output, 48×48 viewBox — full SVG via svgDataUri

export const OUTAGE_ICON_CRITICAL: string =
  `data:image/svg+xml,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 48 48">` +
    `<circle cx="24" cy="24" r="22" fill="#ef4444" opacity="0.1"/>` +
    `<circle cx="24" cy="24" r="19" fill="#ef4444" opacity="0.15"/>` +
    `<circle cx="24" cy="24" r="22" fill="none" stroke="#ef4444" stroke-width="0.6" opacity="0.3"/>` +
    `<circle cx="24" cy="24" r="19" fill="none" stroke="#ef4444" stroke-width="0.4" opacity="0.4"/>` +
    `<circle cx="24" cy="24" r="15" fill="#991b1b" stroke="#ef4444" stroke-width="1.2"/>` +
    `<circle cx="24" cy="24" r="12" fill="#b91c1c" stroke="#dc2626" stroke-width="0.5"/>` +
    `<polygon points="27,8 19,24 23,24 20,40 32,22 27,22 30,10" fill="#fbbf24" stroke="#f59e0b" stroke-width="0.8"/>` +
    `<polygon points="27,11 21,23 24,23 22,36 30,23 27,23 29,13" fill="#fde68a" opacity="0.4"/>` +
    `<circle cx="17" cy="18" r="0.8" fill="#fbbf24" opacity="0.6"/>` +
    `<circle cx="31" cy="30" r="0.8" fill="#fbbf24" opacity="0.6"/>` +
    `<circle cx="17" cy="30" r="0.6" fill="#fbbf24" opacity="0.4"/>` +
    `<circle cx="31" cy="18" r="0.6" fill="#fbbf24" opacity="0.4"/>` +
    `</svg>`,
  );

export const OUTAGE_ICON_WARNING: string =
  `data:image/svg+xml,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 48 48">` +
    `<circle cx="24" cy="24" r="20" fill="#f97316" opacity="0.1"/>` +
    `<circle cx="24" cy="24" r="20" fill="none" stroke="#f97316" stroke-width="0.5" opacity="0.3"/>` +
    `<circle cx="24" cy="24" r="15" fill="#7c2d12" stroke="#f97316" stroke-width="1.2"/>` +
    `<circle cx="24" cy="24" r="12" fill="#9a3412" stroke="#ea580c" stroke-width="0.5"/>` +
    `<polygon points="27,8 19,24 23,24 20,40 32,22 27,22 30,10" fill="#fbbf24" stroke="#f59e0b" stroke-width="0.8"/>` +
    `<polygon points="27,11 21,23 24,23 22,36 30,23 27,23 29,13" fill="#fde68a" opacity="0.4"/>` +
    `<circle cx="18" cy="19" r="0.6" fill="#fbbf24" opacity="0.4"/>` +
    `<circle cx="30" cy="29" r="0.6" fill="#fbbf24" opacity="0.4"/>` +
    `</svg>`,
  );

/** Resolve outage severity to icon data URI. Falls back to warning. */
export function getOutageIcon(severity: string): string {
  if (severity === 'critical') return OUTAGE_ICON_CRITICAL;
  return OUTAGE_ICON_WARNING;
}

// ========================== GFW icon ========================================
// 36×36, 48×48 viewBox — no-fishing sign

export const GFW_ICON: string =
  `data:image/svg+xml,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 48 48">` +
    `<circle cx="24" cy="24" r="20" fill="none" stroke="#8b5cf6" stroke-width="2.5"/>` +
    `<path d="M12 24 Q18 16 28 18 L34 14 L34 20 Q38 24 34 28 L34 34 L28 30 Q18 32 12 24 Z" fill="#a78bfa" stroke="#7c3aed" stroke-width="0.8"/>` +
    `<circle cx="18" cy="23" r="1.8" fill="#8b5cf6"/>` +
    `<circle cx="18" cy="23" r="0.8" fill="#1e1b4b"/>` +
    `<path d="M33 16 L36 14 L34 20" fill="none" stroke="#7c3aed" stroke-width="0.6"/>` +
    `<path d="M33 32 L36 34 L34 28" fill="none" stroke="#7c3aed" stroke-width="0.6"/>` +
    `<line x1="10" y1="38" x2="38" y2="10" stroke="#8b5cf6" stroke-width="3" stroke-linecap="round"/>` +
    `</svg>`,
  );

// ========================= Webcam icon ======================================
// 32×32 output, 48×48 viewBox — camera with lens

export const WEBCAM_ICON: string =
  `data:image/svg+xml,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48">` +
    `<rect x="6" y="16" width="28" height="20" rx="3" fill="#0e7490" stroke="#155e75" stroke-width="1"/>` +
    `<line x1="6" y1="22" x2="34" y2="22" stroke="#155e75" stroke-width="0.4"/>` +
    `<rect x="8" y="24" width="10" height="3" rx="0.5" fill="#164e63" stroke="#0e7490" stroke-width="0.3"/>` +
    `<circle cx="30" cy="19" r="1.5" fill="#ef4444" stroke="#991b1b" stroke-width="0.4"/>` +
    `<circle cx="38" cy="26" r="8" fill="#164e63" stroke="#22d3ee" stroke-width="1"/>` +
    `<circle cx="38" cy="26" r="6" fill="#0c4a6e" stroke="#06b6d4" stroke-width="0.6"/>` +
    `<circle cx="38" cy="26" r="3.5" fill="#155e75" stroke="#22d3ee" stroke-width="0.5"/>` +
    `<circle cx="38" cy="26" r="1.5" fill="#22d3ee" opacity="0.6"/>` +
    `<circle cx="36" cy="24" r="1" fill="white" opacity="0.2"/>` +
    `<circle cx="38" cy="26" r="7" fill="none" stroke="#67e8f9" stroke-width="0.3" opacity="0.4"/>` +
    `<rect x="10" y="10" width="12" height="6" rx="2" fill="#155e75" stroke="#0e7490" stroke-width="0.8"/>` +
    `<rect x="12" y="11" width="4" height="4" rx="1" fill="#0c4a6e" stroke="#22d3ee" stroke-width="0.4"/>` +
    `<rect x="13" y="12" width="2" height="2" rx="0.5" fill="#67e8f9" opacity="0.4"/>` +
    `<rect x="24" y="8" width="4" height="8" rx="1.5" fill="#164e63" stroke="#0e7490" stroke-width="0.6"/>` +
    `<rect x="17" y="36" width="6" height="3" rx="0.5" fill="#164e63" stroke="#155e75" stroke-width="0.5"/>` +
    `<line x1="20" y1="39" x2="20" y2="42" stroke="#155e75" stroke-width="1"/>` +
    `<circle cx="9" cy="19" r="0.8" fill="#22d3ee" opacity="0.8"/>` +
    `</svg>`,
  );

// ========================= Fire dot icons ===================================
// 16×16, radial gradient — small heat-map dots for NASA FIRMS

/**
 * Build a 16×16 radial-gradient fire dot data URI from an RGB colour string.
 * The gradient fades to transparent at the edge for a soft glow effect.
 */
export function getFireDot(rgb: string): string {
  return (
    `data:image/svg+xml,` +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
      `<defs><radialGradient id="g" cx="50%" cy="50%" r="50%">` +
      `<stop offset="0%" stop-color="${rgb}" stop-opacity="1"/>` +
      `<stop offset="70%" stop-color="${rgb}" stop-opacity="0.85"/>` +
      `<stop offset="100%" stop-color="${rgb}" stop-opacity="0"/>` +
      `</radialGradient></defs>` +
      `<circle cx="8" cy="8" r="8" fill="url(#g)"/>` +
      `</svg>`,
    )
  );
}

/** Pre-built fire dots for the three FRP severity bands. */
export const FIRE_DOT_HIGH: string = getFireDot('#ef4444');   // red  (FRP > 100 MW)
export const FIRE_DOT_MEDIUM: string = getFireDot('#f97316'); // orange (30-100 MW)
export const FIRE_DOT_LOW: string = getFireDot('#eab308');    // yellow (< 30 MW)

// ====================== Universal lookup ====================================

/**
 * Universal icon lookup by layer name and subtype string.
 * Returns the matching data URI, or undefined if the (layer, subtype)
 * combination is unknown.
 */
export function getMapIcon(layer: string, subtype: string): string | undefined {
  switch (layer) {
    // --- Aviation ---
    case 'aviation':
      return AVI_ICONS[subtype] ?? AVI_ICONS.general;

    // --- Maritime ---
    case 'maritime':
      if (subtype === 'dark_vessel') return DARK_VESSEL_ICON;
      return VESSEL_ICONS[subtype] ?? VESSEL_ICONS.unknown;

    // --- Satellites ---
    case 'satellites':
      if (subtype === 'recon') return SAT_RECON_ICON;
      return SAT_ICONS[subtype] ?? SAT_ICONS.civilian;

    // --- Infrastructure ---
    case 'infrastructure':
      return INFRA_ICONS[subtype] ?? INFRA_ICONS.power_plant;

    // --- Conflicts ---
    case 'conflicts':
      return getConflictIcon(subtype);

    // --- OSINT / GDACS (use getOsintIcon for full parametric control) ---
    case 'osint':
      // subtype doubles as eventType; default to Green alert for the lookup
      return getOsintIcon(subtype, 'Green');

    // --- Outages ---
    case 'outages':
      return getOutageIcon(subtype);

    // --- GFW ---
    case 'gfw':
      return GFW_ICON;

    // --- Webcams ---
    case 'webcams':
      return WEBCAM_ICON;

    // --- Fires ---
    case 'fires':
      if (subtype === 'high') return FIRE_DOT_HIGH;
      if (subtype === 'medium') return FIRE_DOT_MEDIUM;
      if (subtype === 'low') return FIRE_DOT_LOW;
      return FIRE_DOT_HIGH;

    default:
      return undefined;
  }
}

// ======================== Icon Set Architecture ===============================
// Supports switching between 'default' (current inline SVGs) and 'enhanced'
// (future detailed 48×48 SVGs from frontend/src/icons/enhanced/).
//
// Each set is a nested Record<layer, Record<subtype, dataUri>>.
// The active set is determined by the Zustand store's `activeIconSet` flag.

export type IconSet = Record<string, Record<string, string>>;

/** Default icon set — the icons currently baked into the layer hooks above. */
export const DEFAULT_SET: IconSet = {
  aviation: AVI_ICONS,
  maritime: VESSEL_ICONS,
  satellites: SAT_ICONS,
  infrastructure: INFRA_ICONS,
  conflicts: {
    explosions: CONFLICT_ICON_EXPLOSIONS,
    battles: CONFLICT_ICON_BATTLES,
    violence: CONFLICT_ICON_VIOLENCE,
  },
  outages: {
    critical: OUTAGE_ICON_CRITICAL,
    warning: OUTAGE_ICON_WARNING,
  },
  gfw: { default: GFW_ICON },
  webcams: { default: WEBCAM_ICON },
  fires: {
    high: FIRE_DOT_HIGH,
    medium: FIRE_DOT_MEDIUM,
    low: FIRE_DOT_LOW,
  },
};

/**
 * Enhanced icon set — placeholder. Will be populated from
 * frontend/src/icons/enhanced/ directory when SVGs are finalized.
 * For now, falls back to DEFAULT_SET entirely.
 */
export const ENHANCED_SET: IconSet = {};

let _activeSet: 'default' | 'enhanced' = 'default';

/** Set the active icon set. Called from Zustand store subscription. */
export function setActiveIconSet(set: 'default' | 'enhanced'): void {
  _activeSet = set;
}

/**
 * Resolve an icon from the active set. Falls back to DEFAULT_SET if the
 * enhanced set doesn't have the requested layer/subtype.
 */
export function getActiveIcon(layer: string, subtype: string): string | undefined {
  const set = _activeSet === 'enhanced' ? ENHANCED_SET : DEFAULT_SET;
  const layerIcons = set[layer];
  if (layerIcons?.[subtype]) return layerIcons[subtype];
  // Fallback to default set
  return DEFAULT_SET[layer]?.[subtype];
}
