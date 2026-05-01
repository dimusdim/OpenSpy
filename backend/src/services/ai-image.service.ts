import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ViewportData {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
    tileMode: 'google' | 'osm' | 'modis';
}

export interface AIImageContextObject {
    id: string;
    sourceId: string;
    sourceLabel: string;
    name: string;
    type: string;
    subtype?: string | null;
    lat: number;
    lng: number;
    alt?: number | null;
    distanceM: number;
    description?: string | null;
    fields?: Record<string, string | number | boolean | null>;
}

export interface AIImageContextSnapshot {
    mode: string;
    center: { lat: number; lng: number };
    searchCenter: string;
    radiusM: number;
    selected: AIImageContextObject[];
    candidatesCount: number;
    excludedCount: number;
    generatedAt: string;
}

export interface ImageRecord {
    id: string;
    timestamp: string;
    prompt: string;
    model: string;
    presetName: string;
    viewport: ViewportData;
    originalFile: string;
    generatedFile: string;
    contextSnapshot?: AIImageContextSnapshot;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(__dirname, '../../data/ai-images');
const ORIGINALS_DIR = path.join(DATA_DIR, 'originals');
const GENERATED_DIR = path.join(DATA_DIR, 'generated');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');

// ---------------------------------------------------------------------------
// Aspect ratio helper — parse PNG header and find closest standard ratio
// ---------------------------------------------------------------------------

const STANDARD_RATIOS = [
    { label: '1:1', value: 1 },
    { label: '3:2', value: 3 / 2 },
    { label: '2:3', value: 2 / 3 },
    { label: '4:3', value: 4 / 3 },
    { label: '3:4', value: 3 / 4 },
    { label: '16:9', value: 16 / 9 },
    { label: '9:16', value: 9 / 16 },
];

function closestAspectRatio(w: number, h: number): string {
    const ratio = w / h;
    let best = STANDARD_RATIOS[0];
    let bestDiff = Math.abs(ratio - best.value);
    for (const opt of STANDARD_RATIOS) {
        const diff = Math.abs(ratio - opt.value);
        if (diff < bestDiff) {
            best = opt;
            bestDiff = diff;
        }
    }
    return best.label;
}

/**
 * Parse width and height from PNG IHDR chunk (bytes 16-23 of the file).
 * The screenshot parameter is a base64 data URL like "data:image/png;base64,...".
 * Returns the closest standard aspect ratio string.
 */
function aspectRatioFromPng(dataUrl: string): string {
    const base64Body = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    // PNG header: 8-byte signature, then IHDR chunk (4 len + 4 type + 4 width + 4 height ...)
    // Width is at bytes 16-19, height at bytes 20-23 (big-endian uint32).
    const buf = Buffer.from(base64Body, 'base64');
    if (buf.length < 24) {
        console.warn('[AIImage] PNG too short to read IHDR, defaulting to 16:9');
        return '16:9';
    }
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const ratio = closestAspectRatio(width, height);
    console.log(`[AIImage] PNG dimensions: ${width}x${height} → aspect_ratio=${ratio}`);
    return ratio;
}

function imageUrlFromValue(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(text)) return text;
    if (/^https?:\/\//i.test(text)) return text;
    const compact = text.replace(/\s+/g, '');
    if (compact.length > 2048 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
        return `data:image/png;base64,${compact}`;
    }
    return null;
}

function imageUrlFromRecord(record: any): string | null {
    if (!record || typeof record !== 'object') return null;
    return imageUrlFromValue(record.image_url?.url)
        || imageUrlFromValue(record.image_url)
        || imageUrlFromValue(record.image?.url)
        || imageUrlFromValue(record.url)
        || imageUrlFromValue(record.data)
        || imageUrlFromValue(record.b64_json)
        || imageUrlFromValue(record.base64);
}

function imageUrlFromText(text: string): string | null {
    const dataUri = text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[^\s)"']+/);
    if (dataUri) return dataUri[0];
    const markdownImage = text.match(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i);
    if (markdownImage) return markdownImage[1];
    const imageUrl = text.match(/https?:\/\/[^\s)"']+\.(png|jpg|jpeg|webp)(\?[^\s)"']*)?/i);
    return imageUrl ? imageUrl[0] : null;
}

function extractImageData(responseBody: any): string | null {
    const msgObj = responseBody?.choices?.[0]?.message;
    const candidates = [
        ...(Array.isArray(msgObj?.images) ? msgObj.images : []),
        ...(Array.isArray(responseBody?.images) ? responseBody.images : []),
    ];
    for (const item of candidates) {
        const image = imageUrlFromRecord(item);
        if (image) return image;
    }

    if (Array.isArray(msgObj?.content)) {
        for (const part of msgObj.content) {
            const image = imageUrlFromRecord(part);
            if (image) return image;
            if (typeof part?.text === 'string') {
                const textImage = imageUrlFromText(part.text);
                if (textImage) return textImage;
            }
        }
    }

    if (typeof msgObj?.content === 'string') {
        return imageUrlFromText(msgObj.content);
    }

    return imageUrlFromRecord(msgObj);
}

function responseTextPreview(responseBody: any): string {
    const msgObj = responseBody?.choices?.[0]?.message;
    const texts: string[] = [];
    if (typeof msgObj?.content === 'string') texts.push(msgObj.content);
    if (Array.isArray(msgObj?.content)) {
        for (const part of msgObj.content) {
            if (typeof part?.text === 'string') texts.push(part.text);
        }
    }
    return texts.join('\n').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function responseShape(responseBody: any): string {
    const choice = responseBody?.choices?.[0];
    const msgObj = choice?.message;
    const contentType = Array.isArray(msgObj?.content) ? 'array' : typeof msgObj?.content;
    const contentParts = Array.isArray(msgObj?.content)
        ? msgObj.content.map((p: any) => ({
            type: p?.type,
            hasImageUrl: !!(p?.image_url?.url || p?.image_url || p?.url || p?.image?.url),
            hasData: !!(p?.data || p?.b64_json || p?.base64),
            textLen: typeof p?.text === 'string' ? p.text.length : 0,
        }))
        : null;
    return `finish=${choice?.finish_reason ?? 'unknown'} content=${contentType} images=${msgObj?.images?.length ?? 0} parts=${JSON.stringify(contentParts)}`;
}

function sanitizeContextSnapshot(input: unknown): AIImageContextSnapshot | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const snapshot = input as Partial<AIImageContextSnapshot>;
    const center = snapshot.center;
    if (
        !center ||
        typeof center.lat !== 'number' ||
        typeof center.lng !== 'number' ||
        !Number.isFinite(center.lat) ||
        !Number.isFinite(center.lng)
    ) {
        return undefined;
    }

    const selected = Array.isArray(snapshot.selected)
        ? snapshot.selected.slice(0, 20).map(sanitizeContextObject).filter((item): item is AIImageContextObject => !!item)
        : [];

    return {
        mode: String(snapshot.mode ?? 'optional'),
        center: { lat: center.lat, lng: center.lng },
        searchCenter: String(snapshot.searchCenter ?? 'viewportGroundTarget'),
        radiusM: finiteNumber(snapshot.radiusM, 0),
        selected,
        candidatesCount: finiteNumber(snapshot.candidatesCount, selected.length),
        excludedCount: finiteNumber(snapshot.excludedCount, 0),
        generatedAt: typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt : new Date().toISOString(),
    };
}

function sanitizeContextObject(input: unknown): AIImageContextObject | null {
    if (!input || typeof input !== 'object') return null;
    const object = input as Partial<AIImageContextObject>;
    if (
        typeof object.lat !== 'number' ||
        typeof object.lng !== 'number' ||
        !Number.isFinite(object.lat) ||
        !Number.isFinite(object.lng)
    ) {
        return null;
    }
    return {
        id: textField(object.id, 'unknown'),
        sourceId: textField(object.sourceId, 'unknown'),
        sourceLabel: textField(object.sourceLabel, 'Unknown source'),
        name: textField(object.name, 'Unknown'),
        type: textField(object.type, 'Unknown'),
        subtype: object.subtype == null ? null : textField(object.subtype, ''),
        lat: object.lat,
        lng: object.lng,
        alt: typeof object.alt === 'number' && Number.isFinite(object.alt) ? object.alt : null,
        distanceM: finiteNumber(object.distanceM, 0),
        description: object.description == null ? null : textField(object.description, ''),
        fields: sanitizeContextFields(object.fields),
    };
}

function sanitizeContextFields(input: unknown): Record<string, string | number | boolean | null> | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const out: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(input).slice(0, 24)) {
        if (typeof value === 'string') out[key] = value.slice(0, 240);
        else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
        else if (typeof value === 'boolean' || value === null) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function textField(value: unknown, fallback: string): string {
    if (value === null || value === undefined) return fallback;
    const text = String(value).trim();
    return text ? text.slice(0, 240) : fallback;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AIImageService {
    private manifest: ImageRecord[] = [];

    constructor() {
        for (const dir of [DATA_DIR, ORIGINALS_DIR, GENERATED_DIR]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }
        if (fs.existsSync(MANIFEST_PATH)) {
            try {
                this.manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
            } catch {
                console.warn('[AIImage] Corrupt manifest — starting fresh');
                this.manifest = [];
            }
        }
    }

    private saveManifest(): void {
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(this.manifest, null, 2));
    }

    // -----------------------------------------------------------------------
    // Generate
    // -----------------------------------------------------------------------

    async generate(
        screenshot: string,
        viewport: ViewportData,
        prompt: string,
        model: string = 'google/gemini-3.1-flash-image-preview',
        presetName: string = '',
        contextSnapshot?: AIImageContextSnapshot,
    ): Promise<ImageRecord> {
        const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = new Date().toISOString();

        // Persist original screenshot ----------------------------------------
        const originalFile = `${id}_original.png`;
        const base64Body = screenshot.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(path.join(ORIGINALS_DIR, originalFile), base64Body, 'base64');

        console.log(`[AIImage] Saved original: ${originalFile} (${(base64Body.length * 0.75 / 1024 / 1024).toFixed(1)} MB)`);

        // Call OpenRouter Gemini Flash Image ---------------------------------
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');

        // Compute aspect ratio from PNG header
        const aspectRatio = aspectRatioFromPng(screenshot);

        // Build model-specific config
        const isGemini = model.startsWith('google/');
        const modalities = isGemini ? ['image', 'text'] : ['image'];

        // OpenRouter image_config supports ONLY:
        //   aspect_ratio: "1:1"|"2:3"|"3:2"|"4:3"|"16:9" etc.
        //   image_size: "1K"|"2K"|"4K"
        // width/height are NOT supported — OpenRouter silently ignores them
        // and returns 1024x1024. All models use the same params.
        let imageConfig: Record<string, any>;
        if (isGemini) {
            // Gemini auto-inherits aspect ratio from input image
            imageConfig = { image_size: '2K' };
        } else {
            // FLUX, and any other model: aspect_ratio + image_size
            imageConfig = { aspect_ratio: aspectRatio, image_size: '2K' };
        }

        let imageData: string | null = null;
        let lastNoImageBody = '';
        let lastTextPreview = '';

        for (let attempt = 1; attempt <= 2 && !imageData; attempt++) {
            const attemptPrompt = attempt === 1
                ? prompt
                : `${prompt}\n\nReturn the transformed result as an image output. Do not answer with text only.`;
            console.log(`[AIImage] Generating ${id} attempt=${attempt}  model=${model}  config=${JSON.stringify(imageConfig)}  prompt="${attemptPrompt.slice(0, 80)}…"`);

            const response = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                    model,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: attemptPrompt },
                                { type: 'image_url', image_url: { url: screenshot } },
                            ],
                        },
                    ],
                    modalities,
                    image_config: imageConfig,
                },
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 120_000,
                    maxContentLength: 100 * 1024 * 1024,
                    maxBodyLength: 100 * 1024 * 1024,
                    // Don't throw on 4xx/5xx — we need the error body for logging
                    validateStatus: () => true,
                },
            );

            // Log and throw on non-2xx -------------------------------------------
            if (response.status < 200 || response.status >= 300) {
                const errBody = JSON.stringify(response.data).slice(0, 1000);
                console.error(`[AIImage] OpenRouter ${response.status}: ${errBody}`);
                const msg = response.data?.error?.message || response.data?.error || `OpenRouter HTTP ${response.status}`;
                throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
            }

            console.log(`[AIImage] Response structure attempt=${attempt}: ${responseShape(response.data)}`);
            imageData = extractImageData(response.data);
            if (!imageData) {
                lastTextPreview = responseTextPreview(response.data);
                lastNoImageBody = JSON.stringify(response.data?.choices?.[0]?.message ?? response.data).slice(0, 1000);
                console.warn(`[AIImage] No image in response attempt=${attempt}: ${lastNoImageBody}`);
            }
        }

        if (!imageData) {
            const detail = lastTextPreview ? ` Model text: ${lastTextPreview}` : '';
            console.error('[AIImage] No image in final response:', lastNoImageBody);
            throw new Error(`No image returned from model.${detail}`);
        }

        // Persist generated image --------------------------------------------
        const generatedFile = `${id}_generated.png`;
        if (imageData.startsWith('data:')) {
            const genBase64 = imageData.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(path.join(GENERATED_DIR, generatedFile), genBase64, 'base64');
        } else {
            const imgRes = await axios.get(imageData, {
                responseType: 'arraybuffer',
                timeout: 30_000,
            });
            fs.writeFileSync(path.join(GENERATED_DIR, generatedFile), Buffer.from(imgRes.data));
        }

        console.log(`[AIImage] Saved ${generatedFile}`);

        const record: ImageRecord = {
            id,
            timestamp,
            prompt,
            model,
            presetName,
            viewport,
            originalFile,
            generatedFile,
            contextSnapshot: sanitizeContextSnapshot(contextSnapshot),
        };

        this.manifest.push(record);
        this.saveManifest();
        return record;
    }

    // -----------------------------------------------------------------------
    // Gallery
    // -----------------------------------------------------------------------

    getGallery(): ImageRecord[] {
        return [...this.manifest].reverse(); // newest first
    }

    // -----------------------------------------------------------------------
    // Delete
    // -----------------------------------------------------------------------

    deleteImage(id: string): boolean {
        const idx = this.manifest.findIndex((r) => r.id === id);
        if (idx === -1) return false;

        const record = this.manifest[idx];
        for (const f of [
            path.join(ORIGINALS_DIR, record.originalFile),
            path.join(GENERATED_DIR, record.generatedFile),
        ]) {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }

        this.manifest.splice(idx, 1);
        this.saveManifest();
        return true;
    }

    // -----------------------------------------------------------------------
    // File access (safe — prevents path traversal)
    // -----------------------------------------------------------------------

    getFilePath(type: 'originals' | 'generated', filename: string): string | null {
        const safe = path.basename(filename);
        const dir = type === 'originals' ? ORIGINALS_DIR : GENERATED_DIR;
        const full = path.join(dir, safe);
        return fs.existsSync(full) ? full : null;
    }
}
