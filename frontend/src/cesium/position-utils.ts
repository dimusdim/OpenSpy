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
