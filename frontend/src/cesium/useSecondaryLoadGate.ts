import { useTimelineStore } from '../store/useTimelineStore';

// Возвращает true когда вторичным слоям (fires/pipelines/airspace/
// conflicts/gfw/satellites/outages/disasters/jamming/wifi) разрешено
// стартовать fetch. Primary-слои (aircraft/vessels/cables/webcams/
// labels) этот gate не используют — они грузятся сразу при mount.
// См. Globe.tsx, где gate снимается через setTimeout(2000) после
// первого mount.
export function useSecondaryLoadGate(): boolean {
    return useTimelineStore((s) => s.secondaryLoadReleased);
}
