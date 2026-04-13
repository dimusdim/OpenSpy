import express from 'express';
import { AIImageService } from '../services/ai-image.service';

/**
 * Register AI Image generation routes on the Express app.
 *
 * Integration (add to index.ts):
 *   import { setupAIImageRoutes } from './routes/ai-image';
 *   setupAIImageRoutes(app);
 */
export function setupAIImageRoutes(app: express.Express): AIImageService {
    const service = new AIImageService();

    // JSON body parser scoped to AI Image routes (large base64 payloads).
    const jsonParser = express.json({ limit: '100mb' });

    // -----------------------------------------------------------------------
    // POST /api/ai-image/generate
    // Body: { screenshot, viewport, prompt, model?, presetName? }
    // -----------------------------------------------------------------------
    app.post('/api/ai-image/generate', jsonParser, async (req: express.Request, res: express.Response) => {
        const bodySize = req.headers['content-length'] || 'unknown';
        const { screenshot, viewport, prompt, model, presetName } = req.body ?? {};
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
                screenshot, viewport, prompt, model, presetName,
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
