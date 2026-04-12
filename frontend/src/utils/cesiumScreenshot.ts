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
// Aspect ratio helper
// ---------------------------------------------------------------------------

const ASPECT_RATIOS = [
    { label: '1:1', value: 1 },
    { label: '4:3', value: 4 / 3 },
    { label: '3:2', value: 3 / 2 },
    { label: '16:9', value: 16 / 9 },
    { label: '21:9', value: 21 / 9 },
    { label: '5:4', value: 5 / 4 },
    { label: '4:5', value: 4 / 5 },
    { label: '3:4', value: 3 / 4 },
    { label: '2:3', value: 2 / 3 },
    { label: '9:16', value: 9 / 16 },
];

function closestAspectRatio(w: number, h: number): string {
    const ratio = w / h;
    let best = ASPECT_RATIOS[0];
    let bestDiff = Math.abs(ratio - best.value);
    for (const opt of ASPECT_RATIOS) {
        const diff = Math.abs(ratio - opt.value);
        if (diff < bestDiff) {
            best = opt;
            bestDiff = diff;
        }
    }
    return best.label;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture a PNG screenshot of the Cesium canvas together with the current
 * camera viewport and the detected aspect ratio string.
 *
 * Image is capped at `maxWidth` px (default 2048 for 2K input).
 */
export function captureScreenshot(maxWidth = 2048): Promise<{
    dataUrl: string;
    viewport: ViewportSnapshot;
    aspectRatio: string;
    imageWidth: number;
    imageHeight: number;
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
                    aspectRatio: closestAspectRatio(outW, outH),
                    imageWidth: outW,
                    imageHeight: outH,
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

export function flyToViewport(viewport: Pick<ViewportSnapshot, 'longitude' | 'latitude' | 'height' | 'heading' | 'pitch' | 'roll'>): void {
    const viewer = (window as any).viewerContext as Cesium.Viewer | undefined;
    if (!viewer || viewer.isDestroyed()) return;

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
    });
}
