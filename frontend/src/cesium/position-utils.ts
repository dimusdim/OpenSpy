import * as Cesium from 'cesium';

export function safeCartesianFromDegrees(
    lng: number | string | null | undefined,
    lat: number | string | null | undefined,
    height = 0,
): Cesium.Cartesian3 | null {
    const safeLng = Number(lng);
    const safeLat = Number(lat);
    const safeHeight = Number(height);

    if (!Number.isFinite(safeLng) || !Number.isFinite(safeLat) || !Number.isFinite(safeHeight)) {
        return null;
    }

    const position = Cesium.Cartesian3.fromDegrees(safeLng, safeLat, safeHeight);
    if (!position) return null;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
        return null;
    }

    return position;
}

export function isFiniteCartesian(position: Cesium.Cartesian3 | null | undefined): position is Cesium.Cartesian3 {
    return Boolean(
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        Number.isFinite(position.z),
    );
}

export function getViewerAltitudeMeters(viewer: Cesium.Viewer | null | undefined): number | null {
    if (!viewer || viewer.isDestroyed?.()) return null;

    const cartographicHeight = viewer.camera.positionCartographic?.height;
    const worldPosition = viewer.camera.positionWC;
    const radialHeight = isFiniteCartesian(worldPosition)
        ? Cesium.Cartesian3.magnitude(worldPosition) - Cesium.Ellipsoid.WGS84.maximumRadius
        : Number.NaN;

    if (Number.isFinite(cartographicHeight) && cartographicHeight! >= 0) {
        if (
            Number.isFinite(radialHeight) &&
            radialHeight > 100_000 &&
            cartographicHeight! < radialHeight * 0.1
        ) {
            return radialHeight;
        }
        return cartographicHeight!;
    }

    if (Number.isFinite(radialHeight) && radialHeight >= 0) {
        return radialHeight;
    }

    return null;
}

let worldTerrainForHeightPromise: Promise<Cesium.TerrainProvider> | null = null;
const AGL_TERRAIN_SAMPLE_TIMEOUT_MS = 2500;

function isUsableSurfaceHeight(value: unknown): value is number {
    const height = Number(value);
    return Number.isFinite(height) && height >= -1000 && height <= 10000;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('terrain height sample timeout')), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export function getViewerHeightAboveGroundMeters(viewer: Cesium.Viewer | null | undefined): number | null {
    if (!viewer || viewer.isDestroyed?.()) return null;

    const cartographic = viewer.camera.positionCartographic;
    const cameraHeight = cartographic?.height;
    if (!cartographic || !Number.isFinite(cameraHeight)) return null;

    let groundHeight: number | undefined;
    try {
        groundHeight = viewer.scene?.sampleHeight?.(cartographic);
    } catch {
        groundHeight = undefined;
    }
    if (!isUsableSurfaceHeight(groundHeight)) {
        groundHeight = viewer.scene?.globe?.getHeight(cartographic);
    }
    if (!isUsableSurfaceHeight(groundHeight)) return null;

    return Math.max(0, cameraHeight! - groundHeight!);
}

export async function getViewerHeightAboveGroundMetersMostDetailed(viewer: Cesium.Viewer | null | undefined): Promise<number | null> {
    const immediate = getViewerHeightAboveGroundMeters(viewer);
    if (immediate != null) return immediate;
    if (!viewer || viewer.isDestroyed?.()) return null;

    const cartographic = viewer.camera.positionCartographic;
    const cameraHeight = cartographic?.height;
    if (!cartographic || !Number.isFinite(cameraHeight)) return null;

    try {
        if (!worldTerrainForHeightPromise) {
            worldTerrainForHeightPromise = Cesium.createWorldTerrainAsync();
        }
        const terrainProvider = await withTimeout(worldTerrainForHeightPromise, AGL_TERRAIN_SAMPLE_TIMEOUT_MS);
        const sampled = await withTimeout(
            Cesium.sampleTerrainMostDetailed(terrainProvider, [Cesium.Cartographic.clone(cartographic)]),
            AGL_TERRAIN_SAMPLE_TIMEOUT_MS,
        );
        const groundHeight = sampled[0]?.height;
        if (!isUsableSurfaceHeight(groundHeight)) return null;
        return Math.max(0, cameraHeight! - groundHeight);
    } catch {
        return null;
    }
}
