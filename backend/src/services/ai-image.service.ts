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
    tileMode: 'google' | 'osm';
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
        const isFlux = model.includes('flux');
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

        console.log(`[AIImage] Generating ${id}  model=${model}  config=${JSON.stringify(imageConfig)}  prompt="${prompt.slice(0, 80)}…"`);

        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
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

        // Extract image from response ----------------------------------------
        const msgObj = response.data?.choices?.[0]?.message;
        let imageData: string | null = null;

        // Debug: log response structure to understand what the model returns
        const contentType = Array.isArray(msgObj?.content) ? 'array' : typeof msgObj?.content;
        const contentParts = Array.isArray(msgObj?.content)
            ? msgObj.content.map((p: any) => ({ type: p.type, hasUrl: !!p.image_url?.url, textLen: p.text?.length }))
            : null;
        console.log(`[AIImage] Response structure: content=${contentType}, images=${msgObj?.images?.length ?? 0}, parts=${JSON.stringify(contentParts)}`);

        // Structured images array (preferred)
        if (msgObj?.images?.length > 0) {
            const img = msgObj.images[0];
            if (img.type === 'image_url' && img.image_url?.url) {
                imageData = img.image_url.url;
            }
        }

        // Multipart content array (Gemini returns [{type:'text',...}, {type:'image_url',...}])
        if (!imageData && Array.isArray(msgObj?.content)) {
            for (const part of msgObj.content) {
                if (part.type === 'image_url' && part.image_url?.url) {
                    imageData = part.image_url.url;
                    break;
                }
            }
        }

        // Fallback: extract from text content (string or multipart text parts)
        if (!imageData && msgObj?.content) {
            let text = '';
            if (typeof msgObj.content === 'string') {
                text = msgObj.content;
            } else if (Array.isArray(msgObj.content)) {
                text = msgObj.content
                    .filter((p: any) => p.type === 'text' && p.text)
                    .map((p: any) => p.text)
                    .join('\n');
            }
            const b64Match = text.match(/data:image\/[a-zA-Z]+;base64,[^\s)"']+/);
            if (b64Match) {
                imageData = b64Match[0];
            } else {
                const urlMatch = text.match(/https?:\/\/[^\s)"']+\.(png|jpg|jpeg|webp)/i);
                if (urlMatch) imageData = urlMatch[0];
            }
        }

        if (!imageData) {
            console.error('[AIImage] No image in response:', JSON.stringify(msgObj).slice(0, 500));
            throw new Error('No image returned from model');
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
