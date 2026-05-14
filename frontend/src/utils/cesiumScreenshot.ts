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

export interface ScreenshotRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ScreenshotGeometry {
    viewportCanvas: { width: number; height: number };
    capture: { width: number; height: number; aspectRatio: string };
    visibleRect: ScreenshotRect;
    requestedAspectRatio: string;
    strategy: 'viewport' | 'expanded-render' | 'center-pad';
}

export interface CaptureScreenshotOptions {
    maxWidth?: number;
    supportedAspectRatios?: string[];
}

function parseAspectRatio(label: string): { width: number; height: number; value: number } | null {
    const [rawW, rawH] = label.split(':');
    const w = Number(rawW);
    const h = Number(rawH);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: w, height: h, value: w / h };
}

function aspectRatioValue(label: string): number | null {
    return parseAspectRatio(label)?.value ?? null;
}

function selectAspectRatio(width: number, height: number, supported: string[] | undefined): { label: string; width: number; height: number; value: number } {
    const ratio = width / height;
    const options = (supported || [])
        .map((label) => ({ label, ratio: parseAspectRatio(label) }))
        .filter((item): item is { label: string; ratio: { width: number; height: number; value: number } } => item.ratio !== null)
        .map((item) => ({ label: item.label, ...item.ratio }));
    if (options.length === 0) {
        // Defensive path for missing/malformed model capabilities: preserve
        // the current viewport ratio instead of forcing a model-specific one.
        return { label: `${width}:${height}`, width, height, value: ratio };
    }
    return options.reduce((best, candidate) => (
        Math.abs(candidate.value - ratio) < Math.abs(best.value - ratio) ? candidate : best
    ));
}

function exactExpandedSize(width: number, height: number, ratio: { width: number; height: number }): { width: number; height: number } {
    let units = Math.max(
        Math.ceil(width / ratio.width),
        Math.ceil(height / ratio.height),
    );
    const canMatchWidthParity = ratio.width % 2 !== 0 || width % 2 === 0;
    const canMatchHeightParity = ratio.height % 2 !== 0 || height % 2 === 0;
    if (canMatchWidthParity && canMatchHeightParity) {
        while (
            ((units * ratio.width - width) % 2 !== 0) ||
            ((units * ratio.height - height) % 2 !== 0)
        ) {
            units += 1;
        }
    }
    return {
        width: units * ratio.width,
        height: units * ratio.height,
    };
}

function fitExactSizeWithinWidth(width: number, ratio: { width: number; height: number }, maxWidth: number): { width: number; height: number } {
    const currentUnits = Math.floor(width / ratio.width);
    const maxUnits = Math.max(1, Math.floor(maxWidth / ratio.width));
    const units = Math.max(1, Math.min(currentUnits, maxUnits));
    return {
        width: units * ratio.width,
        height: units * ratio.height,
    };
}

function preciseRect(rect: ScreenshotRect): ScreenshotRect {
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
    };
}

function preciseSize(width: number, height: number): { width: number; height: number } {
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return {
        width: round(width),
        height: round(height),
    };
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
export function captureScreenshot(options: CaptureScreenshotOptions | number = {}): Promise<{
    dataUrl: string;
    viewport: ViewportSnapshot;
    sourceGeometry: ScreenshotGeometry;
}> {
    return new Promise((resolve, reject) => {
        const maxWidth = typeof options === 'number' ? options : options.maxWidth ?? 2048;
        const supportedAspectRatios = typeof options === 'number' ? undefined : options.supportedAspectRatios;
        const viewer = (window as any).viewerContext as Cesium.Viewer | undefined;
        if (!viewer || viewer.isDestroyed()) {
            return reject(new Error('Cesium viewer not available'));
        }

        const camera = viewer.camera;
        const pos = camera.positionCartographic;
        const container = viewer.container as HTMLElement;
        const srcCanvas = viewer.canvas;
        const originalRect = container.getBoundingClientRect();
        const originalCssWidth = Math.max(1, Math.round(originalRect.width || srcCanvas.clientWidth || srcCanvas.width));
        const originalCssHeight = Math.max(1, Math.round(originalRect.height || srcCanvas.clientHeight || srcCanvas.height));
        const selectedRatio = selectAspectRatio(originalCssWidth, originalCssHeight, supportedAspectRatios);
        const currentRatio = originalCssWidth / originalCssHeight;
        const needsExpansion = Math.abs(currentRatio - selectedRatio.value) > 0.001;
        const targetSize = needsExpansion
            ? exactExpandedSize(originalCssWidth, originalCssHeight, selectedRatio)
            : { width: originalCssWidth, height: originalCssHeight };
        const targetCssWidth = targetSize.width;
        const targetCssHeight = targetSize.height;
        const visibleCssRect = {
            x: Math.max(0, (targetCssWidth - originalCssWidth) / 2),
            y: Math.max(0, (targetCssHeight - originalCssHeight) / 2),
            width: originalCssWidth,
            height: originalCssHeight,
        };

        const originalStyle = {
            width: container.style.width,
            height: container.style.height,
            maxWidth: container.style.maxWidth,
            maxHeight: container.style.maxHeight,
            minWidth: container.style.minWidth,
            minHeight: container.style.minHeight,
            position: container.style.position,
            left: container.style.left,
            top: container.style.top,
            transform: container.style.transform,
            transformOrigin: container.style.transformOrigin,
            overflow: container.style.overflow,
        };

        const restoreContainer = () => {
            container.style.width = originalStyle.width;
            container.style.height = originalStyle.height;
            container.style.maxWidth = originalStyle.maxWidth;
            container.style.maxHeight = originalStyle.maxHeight;
            container.style.minWidth = originalStyle.minWidth;
            container.style.minHeight = originalStyle.minHeight;
            container.style.position = originalStyle.position;
            container.style.left = originalStyle.left;
            container.style.top = originalStyle.top;
            container.style.transform = originalStyle.transform;
            container.style.transformOrigin = originalStyle.transformOrigin;
            container.style.overflow = originalStyle.overflow;
            viewer.resize();
            viewer.scene.requestRender();
        };

        if (needsExpansion) {
            container.style.width = `${targetCssWidth}px`;
            container.style.height = `${targetCssHeight}px`;
            container.style.maxWidth = 'none';
            container.style.maxHeight = 'none';
            container.style.minWidth = `${targetCssWidth}px`;
            container.style.minHeight = `${targetCssHeight}px`;
            container.style.position = 'absolute';
            container.style.left = `${-visibleCssRect.x}px`;
            container.style.top = `${-visibleCssRect.y}px`;
            container.style.transform = 'none';
            container.style.transformOrigin = 'center center';
            container.style.overflow = 'visible';
            viewer.resize();
        }

        const removeListener = viewer.scene.postRender.addEventListener(() => {
            removeListener();
            try {
                const srcCanvas = viewer.canvas;
                let dataUrl: string;
                let outW: number;
                let outH: number;

                const pixelScaleX = srcCanvas.width / targetCssWidth;
                const pixelScaleY = srcCanvas.height / targetCssHeight;
                const visibleRawRect = {
                    x: visibleCssRect.x * pixelScaleX,
                    y: visibleCssRect.y * pixelScaleY,
                    width: visibleCssRect.width * pixelScaleX,
                    height: visibleCssRect.height * pixelScaleY,
                };
                let outputScale = 1;

                if (srcCanvas.width > maxWidth) {
                    const exactOutput = fitExactSizeWithinWidth(srcCanvas.width, selectedRatio, maxWidth);
                    outW = exactOutput.width;
                    outH = exactOutput.height;
                    outputScale = outW / srcCanvas.width;
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

                const sourceGeometry: ScreenshotGeometry = {
                    viewportCanvas: preciseSize(
                        visibleRawRect.width * outputScale,
                        visibleRawRect.height * outputScale,
                    ),
                    capture: {
                        width: outW,
                        height: outH,
                        aspectRatio: selectedRatio.label,
                    },
                    visibleRect: preciseRect({
                        x: visibleRawRect.x * outputScale,
                        y: visibleRawRect.y * outputScale,
                        width: visibleRawRect.width * outputScale,
                        height: visibleRawRect.height * outputScale,
                    }),
                    requestedAspectRatio: selectedRatio.label,
                    strategy: needsExpansion ? 'expanded-render' : 'viewport',
                };

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
                    sourceGeometry,
                });
            } catch (err) {
                reject(err);
            } finally {
                if (needsExpansion) restoreContainer();
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
