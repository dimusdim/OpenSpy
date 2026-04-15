export type LiveDeliveryMode = 'delta' | 'replace' | 'snapshot-only' | 'none';

export type PublicSourceLiveContract = {
    source_id: string;
    delivery_mode: LiveDeliveryMode;
    stale_after_sec: number | null;
    remove_after_sec: number | null;
    notes?: string;
};

const LIVE_DELIVERY_MODES = new Set<LiveDeliveryMode>(['delta', 'replace', 'snapshot-only', 'none']);

function parseNullableSeconds(value: unknown): number | null {
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function extractPublicSourceLiveContract(
    sourceId: string | null | undefined,
    manifest: any,
): PublicSourceLiveContract | null {
    const contract = manifest?.live_contract;
    if (!sourceId || !contract || typeof contract !== 'object') return null;

    const deliveryMode = contract.delivery_mode;
    if (!LIVE_DELIVERY_MODES.has(deliveryMode)) return null;

    const staleAfterSec = parseNullableSeconds(contract.stale_after_sec);
    const removeAfterSec = parseNullableSeconds(contract.remove_after_sec);
    const notes = typeof contract.notes === 'string' && contract.notes.trim().length > 0
        ? contract.notes.trim()
        : undefined;

    return {
        source_id: sourceId,
        delivery_mode: deliveryMode,
        stale_after_sec: staleAfterSec,
        remove_after_sec: removeAfterSec,
        ...(notes ? { notes } : {}),
    };
}
