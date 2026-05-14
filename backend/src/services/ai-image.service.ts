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

export interface AIImageRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface AIImageSourceGeometry {
    viewportCanvas: { width: number; height: number };
    capture: { width: number; height: number; aspectRatio: string };
    visibleRect: AIImageRect;
    requestedAspectRatio: string;
    strategy: 'viewport' | 'expanded-render' | 'center-pad';
}

export interface AIImageGeneratedGeometry {
    width: number;
    height: number;
    aspectRatio: string;
}

export interface AIImageModelCapabilities {
    model: string;
    provider: string;
    supportedAspectRatios: string[];
    defaultAspectRatio: string;
    defaultImageSize: string;
    supportsImageToImage: boolean;
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
    sourceGeometry?: AIImageSourceGeometry;
    generatedGeometry?: AIImageGeneratedGeometry;
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

const OPENROUTER_STANDARD_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
const DEPRECATED_IMAGE_MODEL_REPLACEMENTS: Record<string, string> = {
    'black-forest-labs/flux.2-max': 'google/gemini-3-pro-image-preview',
};
const MODEL_CAPABILITY_OVERRIDES: Record<string, Partial<AIImageModelCapabilities>> = {
    'google/gemini-3.1-flash-image-preview': {
        provider: 'openrouter',
        supportedAspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'],
        defaultAspectRatio: '16:9',
        defaultImageSize: '2K',
        supportsImageToImage: true,
    },
    'google/gemini-3-pro-image-preview': {
        provider: 'openrouter',
        supportedAspectRatios: OPENROUTER_STANDARD_ASPECT_RATIOS,
        defaultAspectRatio: '16:9',
        defaultImageSize: '2K',
        supportsImageToImage: true,
    },
    'openai/gpt-5-image': {
        provider: 'openrouter',
        supportedAspectRatios: OPENROUTER_STANDARD_ASPECT_RATIOS,
        defaultAspectRatio: '16:9',
        defaultImageSize: '2K',
        supportsImageToImage: true,
    },
    'openai/gpt-5-image-mini': {
        provider: 'openrouter',
        supportedAspectRatios: OPENROUTER_STANDARD_ASPECT_RATIOS,
        defaultAspectRatio: '16:9',
        defaultImageSize: '2K',
        supportsImageToImage: true,
    },
    'openai/gpt-5.4-image-2': {
        provider: 'openrouter',
        supportedAspectRatios: OPENROUTER_STANDARD_ASPECT_RATIOS,
        defaultAspectRatio: '16:9',
        defaultImageSize: '2K',
        supportsImageToImage: true,
    },
};

function aspectRatioValue(label: string): number | null {
    const [rawW, rawH] = label.split(':');
    const w = Number(rawW);
    const h = Number(rawH);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return w / h;
}

function normalizeAspectRatioLabel(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return aspectRatioValue(trimmed) ? trimmed : null;
}

export function getAIImageModelCapabilities(model: string | undefined | null): AIImageModelCapabilities {
    const rawId = String(model || 'google/gemini-3.1-flash-image-preview').trim() || 'google/gemini-3.1-flash-image-preview';
    const id = DEPRECATED_IMAGE_MODEL_REPLACEMENTS[rawId] || rawId;
    const override = MODEL_CAPABILITY_OVERRIDES[id] || {};
    const supportedAspectRatios = override.supportedAspectRatios?.length
        ? override.supportedAspectRatios
        : OPENROUTER_STANDARD_ASPECT_RATIOS;
    const defaultAspectRatio = override.defaultAspectRatio && supportedAspectRatios.includes(override.defaultAspectRatio)
        ? override.defaultAspectRatio
        : supportedAspectRatios.includes('16:9') ? '16:9' : supportedAspectRatios[0];
    return {
        model: id,
        provider: override.provider || 'openrouter',
        supportedAspectRatios,
        defaultAspectRatio,
        defaultImageSize: override.defaultImageSize || '2K',
        supportsImageToImage: override.supportsImageToImage ?? true,
    };
}

function selectClosestSupportedAspectRatio(width: number, height: number, supported: string[], fallback: string): string {
    const ratio = width / height;
    const options = supported
        .map((label) => ({ label, value: aspectRatioValue(label) }))
        .filter((item): item is { label: string; value: number } => item.value !== null);
    if (options.length === 0) return fallback;
    return options.reduce((best, candidate) => (
        Math.abs(candidate.value - ratio) < Math.abs(best.value - ratio) ? candidate : best
    )).label;
}

function imageDimensionsFromBuffer(buffer: Buffer): { width: number; height: number } | null {
    if (
        buffer.length >= 24 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
    ) {
        return {
            width: buffer.readUInt32BE(16),
            height: buffer.readUInt32BE(20),
        };
    }

    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset < buffer.length - 9) {
            if (buffer[offset] !== 0xff) {
                offset += 1;
                continue;
            }
            const marker = buffer[offset + 1];
            const length = buffer.readUInt16BE(offset + 2);
            if (length < 2) return null;
            if (
                marker === 0xc0 ||
                marker === 0xc1 ||
                marker === 0xc2 ||
                marker === 0xc3 ||
                marker === 0xc5 ||
                marker === 0xc6 ||
                marker === 0xc7 ||
                marker === 0xc9 ||
                marker === 0xca ||
                marker === 0xcb ||
                marker === 0xcd ||
                marker === 0xce ||
                marker === 0xcf
            ) {
                return {
                    height: buffer.readUInt16BE(offset + 5),
                    width: buffer.readUInt16BE(offset + 7),
                };
            }
            offset += 2 + length;
        }
    }

    return null;
}

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
function aspectRatioFromPng(dataUrl: string): string | null {
    const base64Body = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    // PNG header: 8-byte signature, then IHDR chunk (4 len + 4 type + 4 width + 4 height ...)
    // Width is at bytes 16-19, height at bytes 20-23 (big-endian uint32).
    const buf = Buffer.from(base64Body, 'base64');
    if (buf.length < 24) {
        console.warn('[AIImage] PNG too short to read IHDR');
        return null;
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

function sanitizeRect(input: unknown, fallback: AIImageRect): AIImageRect {
    const rect = input && typeof input === 'object' ? input as Partial<AIImageRect> : {};
    return {
        x: Math.max(0, finiteNumber(rect.x, fallback.x)),
        y: Math.max(0, finiteNumber(rect.y, fallback.y)),
        width: Math.max(1, finiteNumber(rect.width, fallback.width)),
        height: Math.max(1, finiteNumber(rect.height, fallback.height)),
    };
}

function sanitizeSourceGeometry(
    input: unknown,
    originalDimensions: { width: number; height: number } | null,
    requestedAspectRatio: string,
): AIImageSourceGeometry | undefined {
    const width = originalDimensions?.width || 1;
    const height = originalDimensions?.height || 1;
    const fallback: AIImageSourceGeometry = {
        viewportCanvas: { width, height },
        capture: { width, height, aspectRatio: requestedAspectRatio },
        visibleRect: { x: 0, y: 0, width, height },
        requestedAspectRatio,
        strategy: 'viewport',
    };
    if (!input || typeof input !== 'object') return fallback;

    const value = input as Partial<AIImageSourceGeometry>;
    const viewportCanvas = value.viewportCanvas && typeof value.viewportCanvas === 'object'
        ? value.viewportCanvas as Partial<{ width: number; height: number }>
        : {};
    const capture = value.capture && typeof value.capture === 'object'
        ? value.capture as Partial<{ width: number; height: number; aspectRatio: string }>
        : {};
    const strategy = value.strategy === 'expanded-render' || value.strategy === 'center-pad' || value.strategy === 'viewport'
        ? value.strategy
        : 'viewport';

    return {
        viewportCanvas: {
            width: Math.max(1, finiteNumber(viewportCanvas.width, fallback.viewportCanvas.width)),
            height: Math.max(1, finiteNumber(viewportCanvas.height, fallback.viewportCanvas.height)),
        },
        capture: {
            width: Math.max(1, finiteNumber(capture.width, fallback.capture.width)),
            height: Math.max(1, finiteNumber(capture.height, fallback.capture.height)),
            aspectRatio: normalizeAspectRatioLabel(capture.aspectRatio) || requestedAspectRatio,
        },
        visibleRect: sanitizeRect(value.visibleRect, fallback.visibleRect),
        requestedAspectRatio: normalizeAspectRatioLabel(value.requestedAspectRatio) || requestedAspectRatio,
        strategy,
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
        sourceGeometry?: AIImageSourceGeometry,
        requestedAspectRatio?: string,
    ): Promise<ImageRecord> {
        const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = new Date().toISOString();

        // Persist original screenshot ----------------------------------------
        const originalFile = `${id}_original.png`;
        const base64Body = screenshot.replace(/^data:image\/\w+;base64,/, '');
        const originalBuffer = Buffer.from(base64Body, 'base64');
        fs.writeFileSync(path.join(ORIGINALS_DIR, originalFile), originalBuffer);

        console.log(`[AIImage] Saved original: ${originalFile} (${(base64Body.length * 0.75 / 1024 / 1024).toFixed(1)} MB)`);

        // Call selected OpenRouter image model -------------------------------
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');

        // Compute/validate aspect ratio against the selected model capability.
        const modelCapabilities = getAIImageModelCapabilities(model);
        const effectiveModel = modelCapabilities.model;
        const originalDimensions = imageDimensionsFromBuffer(originalBuffer);
        const fallbackAspectRatio = originalDimensions
            ? selectClosestSupportedAspectRatio(
                originalDimensions.width,
                originalDimensions.height,
                modelCapabilities.supportedAspectRatios,
                modelCapabilities.defaultAspectRatio,
            )
            : normalizeAspectRatioLabel(aspectRatioFromPng(screenshot)) || modelCapabilities.defaultAspectRatio;
        const requestedRatio = normalizeAspectRatioLabel(requestedAspectRatio)
            || normalizeAspectRatioLabel(sourceGeometry?.requestedAspectRatio)
            || fallbackAspectRatio;
        const aspectRatio = modelCapabilities.supportedAspectRatios.includes(requestedRatio)
            ? requestedRatio
            : fallbackAspectRatio;

        // Build model-specific config
        const isGemini = effectiveModel.startsWith('google/');
        const modalities = isGemini ? ['image', 'text'] : ['image'];

        // OpenRouter image_config supports ONLY:
        //   aspect_ratio: "1:1"|"2:3"|"3:2"|"4:3"|"16:9" etc.
        //   image_size: "1K"|"2K"|"4K"
        // width/height are NOT supported — OpenRouter silently ignores them
        // and returns 1024x1024. All models use the same params.
        const imageConfig: Record<string, any> = {
            aspect_ratio: aspectRatio,
            image_size: modelCapabilities.defaultImageSize,
        };

        let imageData: string | null = null;
        let lastNoImageBody = '';
        let lastTextPreview = '';

        for (let attempt = 1; attempt <= 2 && !imageData; attempt++) {
            const attemptPrompt = attempt === 1
                ? prompt
                : `${prompt}\n\nReturn the transformed result as an image output. Do not answer with text only.`;
            console.log(`[AIImage] Generating ${id} attempt=${attempt}  model=${effectiveModel}  config=${JSON.stringify(imageConfig)}  prompt="${attemptPrompt.slice(0, 80)}…"`);

            const response = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                    model: effectiveModel,
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
        let generatedBuffer: Buffer;
        if (imageData.startsWith('data:')) {
            const genBase64 = imageData.replace(/^data:image\/\w+;base64,/, '');
            generatedBuffer = Buffer.from(genBase64, 'base64');
            fs.writeFileSync(path.join(GENERATED_DIR, generatedFile), generatedBuffer);
        } else {
            const imgRes = await axios.get(imageData, {
                responseType: 'arraybuffer',
                timeout: 30_000,
            });
            generatedBuffer = Buffer.from(imgRes.data);
            fs.writeFileSync(path.join(GENERATED_DIR, generatedFile), generatedBuffer);
        }

        console.log(`[AIImage] Saved ${generatedFile}`);
        const generatedDimensions = imageDimensionsFromBuffer(generatedBuffer);

        const record: ImageRecord = {
            id,
            timestamp,
            prompt,
            model: effectiveModel,
            presetName,
            viewport,
            originalFile,
            generatedFile,
            sourceGeometry: sanitizeSourceGeometry(sourceGeometry, originalDimensions, aspectRatio),
            generatedGeometry: generatedDimensions ? {
                width: generatedDimensions.width,
                height: generatedDimensions.height,
                aspectRatio: closestAspectRatio(generatedDimensions.width, generatedDimensions.height),
            } : undefined,
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
