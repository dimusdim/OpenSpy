import * as Cesium from 'cesium';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ViewportSnapshot {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture a PNG screenshot of the Cesium canvas together with the current
 * camera viewport.
 *
 * Image is capped at `maxWidth` px (default 2048 for 2K input).
 * Aspect ratio is computed server-side from the PNG header.
 */
export function captureScreenshot(maxWidth = 2048): Promise<{
    dataUrl: string;
    viewport: ViewportSnapshot;
}> {
    return new Promise((resolve, reject) => {
        const viewer = (window as any).viewerContext as Cesium.Viewer | undefined;
        if (!viewer || viewer.isDestroyed()) {
            return reject(new Error('Cesium viewer not available'));
        }

        const camera = viewer.camera;
        const pos = camera.positionCartographic;

        const removeListener = viewer.scene.postRender.addEventListener(() => {
            removeListener();
            try {
                const srcCanvas = viewer.canvas;
                let dataUrl: string;
                let outW: number;
                let outH: number;

                if (srcCanvas.width > maxWidth) {
                    const scale = maxWidth / srcCanvas.width;
                    outW = maxWidth;
                    outH = Math.round(srcCanvas.height * scale);
                    const offscreen = document.createElement('canvas');
                    offscreen.width = outW;
                    offscreen.height = outH;
                    const ctx = offscreen.getContext('2d')!;
                    ctx.drawImage(srcCanvas, 0, 0, outW, outH);
                    dataUrl = offscreen.toDataURL('image/png');
                } else {
                    outW = srcCanvas.width;
                    outH = srcCanvas.height;
                    dataUrl = srcCanvas.toDataURL('image/png');
                }

                const viewport: ViewportSnapshot = {
                    longitude: Cesium.Math.toDegrees(pos.longitude),
                    latitude: Cesium.Math.toDegrees(pos.latitude),
                    height: pos.height,
                    heading: Cesium.Math.toDegrees(camera.heading),
                    pitch: Cesium.Math.toDegrees(camera.pitch),
                    roll: Cesium.Math.toDegrees(camera.roll),
                };

                resolve({
                    dataUrl,
                    viewport,
                });
            } catch (err) {
                reject(err);
            }
        });

        viewer.scene.requestRender();
    });
}

// ---------------------------------------------------------------------------
// Fly-to
// ---------------------------------------------------------------------------

function requestAIContextRefresh(reason: string): void {
    document.dispatchEvent(new CustomEvent('openspy:ai-context-refresh', {
        detail: { reason, at: Date.now() },
    }));
}

export function flyToViewport(viewport: Pick<ViewportSnapshot, 'longitude' | 'latitude' | 'height' | 'heading' | 'pitch' | 'roll'>): void {
    const viewer = (window as any).viewerContext as Cesium.Viewer | undefined;
    if (!viewer || viewer.isDestroyed()) return;

    requestAIContextRefresh('fly-to-start');
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
            viewport.longitude,
            viewport.latitude,
            viewport.height,
        ),
        orientation: {
            heading: Cesium.Math.toRadians(viewport.heading),
            pitch: Cesium.Math.toRadians(viewport.pitch),
            roll: Cesium.Math.toRadians(viewport.roll),
        },
        duration: 1.5,
        complete: () => requestAIContextRefresh('fly-to-complete'),
        cancel: () => requestAIContextRefresh('fly-to-cancel'),
    });
}
