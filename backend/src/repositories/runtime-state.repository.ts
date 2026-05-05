import { DatabaseService } from '../db/database.service';

type RuntimeStatePayload = {
    status?: string;
    note?: string;
    count?: number;
    [key: string]: any;
};

const STATUS_BINDINGS: Array<{
    key: string;
    layerId: string;
    sourceId?: string | null;
    stateScope?: 'layer' | 'source';
}> = [
    { key: 'satellites', layerId: 'satellite' },
    { key: 'aviation', layerId: 'aircraft' },
    { key: 'maritime', layerId: 'vessel' },
    { key: 'cables', layerId: 'cable' },
    { key: 'fires', layerId: 'fire' },
    { key: 'jamming', layerId: 'jamming' },
    { key: 'airspace', layerId: 'airspace' },
    { key: 'conflicts', layerId: 'conflict' },
    { key: 'acled', layerId: 'conflict', sourceId: 'acled', stateScope: 'source' },
    { key: 'gdelt', layerId: 'conflict', sourceId: 'gdelt', stateScope: 'source' },
    { key: 'gfw', layerId: 'gfw' },
    { key: 'outages', layerId: 'outage' },
    { key: 'traffic', layerId: 'traffic' },
    { key: 'webcams', layerId: 'webcam' },
    { key: 'infrastructure', layerId: 'infrastructure' },
    { key: 'overture', layerId: 'infrastructure', sourceId: 'overture', stateScope: 'source' },
];

export class RuntimeStateRepository {
    private lastPersistAt = 0;
    private sourceExistence = new Map<string, boolean>();
    private warnedMissingSources = new Set<string>();

    constructor(private readonly database: DatabaseService) {}

    private async resolveSourceId(sourceId: string | null | undefined): Promise<string | null> {
        if (!sourceId) return null;

        if (this.sourceExistence.has(sourceId)) {
            return this.sourceExistence.get(sourceId) ? sourceId : null;
        }

        const result = await this.database.query<{ exists: boolean }>(
            `
                SELECT EXISTS (
                    SELECT 1
                    FROM catalog.sources
                    WHERE source_id = $1
                ) AS exists
            `,
            [sourceId],
        );

        const exists = Boolean(result?.rows[0]?.exists);
        this.sourceExistence.set(sourceId, exists);

        if (!exists && !this.warnedMissingSources.has(sourceId)) {
            this.warnedMissingSources.add(sourceId);
            console.warn(`[runtime-state] source_id=${sourceId} not found in catalog.sources; persisting snapshot with source_id=NULL`);
        }

        return exists ? sourceId : null;
    }

    async persistSnapshot(snapshot: Record<string, any>, minIntervalMs = 15_000): Promise<void> {
        if (!this.database.isReady()) return;
        const now = Date.now();
        if (now - this.lastPersistAt < minIntervalMs) return;
        this.lastPersistAt = now;

        for (const binding of STATUS_BINDINGS) {
            const payload = snapshot[binding.key];
            if (!payload || typeof payload !== 'object') continue;
            if (typeof payload.status !== 'string') continue;

            const stateScope = binding.stateScope || 'layer';
            const resolvedSourceId = await this.resolveSourceId(binding.sourceId || null);
            const layerRuntimeStateId = binding.sourceId
                ? `${binding.layerId}:${binding.sourceId}:${stateScope}`
                : `${binding.layerId}:${stateScope}`;

            await this.database.query(
                `
                    INSERT INTO app.layer_runtime_states (
                        layer_runtime_state_id,
                        layer_id,
                        source_id,
                        state_scope,
                        status,
                        note,
                        count,
                        details,
                        observed_at,
                        created_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), now())
                    ON CONFLICT (layer_runtime_state_id)
                    DO UPDATE SET
                        status = EXCLUDED.status,
                        note = EXCLUDED.note,
                        count = EXCLUDED.count,
                        details = EXCLUDED.details,
                        observed_at = EXCLUDED.observed_at
                `,
                [
                    layerRuntimeStateId,
                    binding.layerId,
                    resolvedSourceId,
                    stateScope,
                    payload.status || 'unknown',
                    payload.note || null,
                    typeof payload.count === 'number' ? payload.count : null,
                    JSON.stringify({
                        ...payload,
                        requestedSourceId: binding.sourceId || null,
                        sourceBound: resolvedSourceId,
                    }),
                ],
            );
        }
    }
}
