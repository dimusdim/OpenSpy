import * as fs from 'fs';
import * as path from 'path';

const PRESETS_FILE = path.resolve(__dirname, '../../data/ai-image-presets.json');

export interface PresetsPayload {
    schemaVersion: number;
    presets: unknown[];
}

const EMPTY_PAYLOAD: PresetsPayload = { schemaVersion: 1, presets: [] };

export class AIPresetsService {
    load(): PresetsPayload {
        try {
            if (!fs.existsSync(PRESETS_FILE)) return { ...EMPTY_PAYLOAD };
            const raw = fs.readFileSync(PRESETS_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return { schemaVersion: 1, presets: parsed };
            }
            if (parsed && Array.isArray(parsed.presets)) {
                return {
                    schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
                    presets: parsed.presets,
                };
            }
            return { ...EMPTY_PAYLOAD };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[AIPresets] load failed, returning empty payload:', message);
            return { ...EMPTY_PAYLOAD };
        }
    }

    save(payload: PresetsPayload): void {
        const dir = path.dirname(PRESETS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PRESETS_FILE, JSON.stringify(payload, null, 2));
    }
}
