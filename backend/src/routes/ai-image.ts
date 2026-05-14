import express from 'express';
import { AIImageService, getAIImageModelCapabilities } from '../services/ai-image.service';
import { AIPresetsService, PresetsPayload } from '../services/ai-presets.service';

/**
 * Register AI Image generation routes on the Express app.
 *
 * Integration (add to index.ts):
 *   import { setupAIImageRoutes } from './routes/ai-image';
 *   setupAIImageRoutes(app);
 */
export function setupAIImageRoutes(app: express.Express): AIImageService {
    const service = new AIImageService();
    const presetsService = new AIPresetsService();

    // JSON body parser scoped to AI Image routes (large base64 payloads).
    const jsonParser = express.json({ limit: '100mb' });
    const presetsJsonParser = express.json({ limit: '1mb' });

    // -----------------------------------------------------------------------
    // GET /api/ai-image/model-capabilities?model=<provider/model>
    // -----------------------------------------------------------------------
    app.get('/api/ai-image/model-capabilities', (req: express.Request, res: express.Response) => {
        res.json(getAIImageModelCapabilities(String(req.query.model || '')));
    });

    // -----------------------------------------------------------------------
    // POST /api/ai-image/generate
    // Body: { screenshot, viewport, prompt, model?, presetName?, sourceGeometry?, requestedAspectRatio? }
    // -----------------------------------------------------------------------
    app.post('/api/ai-image/generate', jsonParser, async (req: express.Request, res: express.Response) => {
        const bodySize = req.headers['content-length'] || 'unknown';
        const { screenshot, viewport, prompt, model, presetName, contextSnapshot, sourceGeometry, requestedAspectRatio } = req.body ?? {};
        const screenshotKB = screenshot ? Math.round(screenshot.length / 1024) : 0;
        console.log(`[AIImage] POST /generate  body=${bodySize}  screenshot=${screenshotKB}KB  model=${model || 'default'}`);

        if (!screenshot || !viewport || !prompt) {
            res.status(400).json({
                error: 'Missing required fields: screenshot, viewport, prompt',
            });
            return;
        }

        try {
            const record = await service.generate(
                screenshot, viewport, prompt, model, presetName, contextSnapshot, sourceGeometry, requestedAspectRatio,
            );
            res.json(record);
        } catch (err: any) {
            console.error('[AIImage] Generate error:', err.message);
            res.status(502).json({ error: err.message || 'Image generation failed' });
        }
    });

    // -----------------------------------------------------------------------
    // GET /api/ai-image/gallery
    // -----------------------------------------------------------------------
    app.get('/api/ai-image/gallery', (_req: express.Request, res: express.Response) => {
        res.json(service.getGallery());
    });

    // -----------------------------------------------------------------------
    // GET /api/ai-image/presets
    // -----------------------------------------------------------------------
    app.get('/api/ai-image/presets', (_req: express.Request, res: express.Response) => {
        res.json(presetsService.load());
    });

    // -----------------------------------------------------------------------
    // PUT /api/ai-image/presets
    // Body: { schemaVersion?, presets[] } | presets[]
    // -----------------------------------------------------------------------
    app.put('/api/ai-image/presets', presetsJsonParser, (req: express.Request, res: express.Response) => {
        const body = req.body;
        let payload: PresetsPayload;
        if (Array.isArray(body)) {
            payload = { schemaVersion: 1, presets: body };
        } else if (body && Array.isArray(body.presets)) {
            payload = {
                schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 1,
                presets: body.presets,
            };
        } else {
            res.status(400).json({ error: 'Body must be presets array or { schemaVersion?, presets[] }' });
            return;
        }

        try {
            presetsService.save(payload);
            res.json({ success: true, count: payload.presets.length });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[AIPresets] save error:', message);
            res.status(500).json({ error: message || 'Failed to save presets' });
        }
    });

    // -----------------------------------------------------------------------
    // DELETE /api/ai-image/:id
    // -----------------------------------------------------------------------
    app.delete('/api/ai-image/:id', (req: express.Request, res: express.Response) => {
        const ok = service.deleteImage(String(req.params.id));
        if (ok) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Image not found' });
        }
    });

    // -----------------------------------------------------------------------
    // GET /api/ai-image/files/:type/:filename
    // Serves saved originals / generated images.
    // -----------------------------------------------------------------------
    app.get('/api/ai-image/files/:type/:filename', (req: express.Request, res: express.Response) => {
        const type = String(req.params.type);
        const filename = String(req.params.filename);
        if (type !== 'originals' && type !== 'generated') {
            res.status(400).json({ error: 'type must be "originals" or "generated"' });
            return;
        }
        const filePath = service.getFilePath(type as 'originals' | 'generated', filename);
        if (!filePath) {
            res.status(404).json({ error: 'File not found' });
            return;
        }
        res.sendFile(filePath);
    });

    console.log('[AIImage] Routes registered');
    return service;
}
