import path from 'path';
import fs from 'fs';
import { DatabaseService } from '../db/database.service';

const SETTINGS_FILE = path.resolve(__dirname, '../../data/user-settings.json');
const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_VIEW_STATE_ID = 'default';

export type ViewStatePayload = Record<string, any>;

function normalizeBooleanMapKey(
    value: unknown,
    fromKey: string,
    toKey: string,
): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const map = { ...(value as Record<string, any>) };
    if (map[fromKey] !== undefined && map[toKey] === undefined) {
        map[toKey] = map[fromKey];
    }
    delete map[fromKey];
    return map;
}

function normalizeSubtypeVisibility(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const input = value as Record<string, any>;
    const output: Record<string, any> = {};
    for (const [key, flag] of Object.entries(input)) {
        if (key.startsWith('osint:')) {
            output[`disasters:${key.slice('osint:'.length)}`] = flag;
            continue;
        }
        output[key] = flag;
    }
    return output;
}

function normalizePersistedViewState(payload: ViewStatePayload): ViewStatePayload {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    return {
        ...payload,
        sources: normalizeBooleanMapKey(payload.sources, 'osint', 'disasters'),
        visibility: normalizeBooleanMapKey(payload.visibility, 'osint', 'disasters'),
        subtypeVisibility: normalizeSubtypeVisibility(payload.subtypeVisibility),
    };
}

function safeReadJsonFile(): ViewStatePayload {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return {};
        return normalizePersistedViewState(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')));
    } catch {
        return {};
    }
}

function safeWriteJsonFile(payload: ViewStatePayload) {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(normalizePersistedViewState(payload), null, 2));
}

export class ViewStateRepository {
    constructor(private readonly database: DatabaseService) {}

    async loadDefaultViewState(): Promise<ViewStatePayload> {
        if (!this.database.isReady()) {
            return safeReadJsonFile();
        }

        const result = await this.database.query<{ state: ViewStatePayload }>(
            `
                SELECT state
                FROM app.view_states
                WHERE workspace_id = $1 AND view_state_id = $2
                LIMIT 1
            `,
            [DEFAULT_WORKSPACE_ID, DEFAULT_VIEW_STATE_ID],
        );

        const dbState = result?.rows[0]?.state;
        if (dbState && typeof dbState === 'object') {
            const normalized = normalizePersistedViewState(dbState);
            if (JSON.stringify(normalized) !== JSON.stringify(dbState)) {
                await this.saveDefaultViewState(normalized);
            }
            return normalized;
        }

        const fileState = safeReadJsonFile();
        if (Object.keys(fileState).length > 0) {
            await this.saveDefaultViewState(fileState);
        }
        return fileState;
    }

    async saveDefaultViewState(payload: ViewStatePayload): Promise<void> {
        const normalizedPayload = normalizePersistedViewState(payload);
        safeWriteJsonFile(normalizedPayload);

        if (!this.database.isReady()) return;

        const requestedTileMode = typeof normalizedPayload.tileMode === 'string' ? normalizedPayload.tileMode : null;
        const effectiveTileMode = typeof normalizedPayload.effectiveTileMode === 'string'
            ? normalizedPayload.effectiveTileMode
            : requestedTileMode;

        await this.database.query(
            `
                INSERT INTO app.view_states (
                    view_state_id,
                    workspace_id,
                    requested_tile_mode,
                    effective_tile_mode,
                    state,
                    metadata
                )
                VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb)
                ON CONFLICT (view_state_id)
                DO UPDATE SET
                    requested_tile_mode = EXCLUDED.requested_tile_mode,
                    effective_tile_mode = EXCLUDED.effective_tile_mode,
                    state = EXCLUDED.state,
                    updated_at = now()
            `,
            [
                DEFAULT_VIEW_STATE_ID,
                DEFAULT_WORKSPACE_ID,
                requestedTileMode,
                effectiveTileMode,
                JSON.stringify(normalizedPayload),
            ],
        );
    }
}
