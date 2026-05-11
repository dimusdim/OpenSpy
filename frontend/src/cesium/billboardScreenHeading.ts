import * as Cesium from 'cesium';

const FORWARD_DISTANCE_METERS = 10_000;
const EARTH_RADIUS_METERS = 6_378_137;
const MIN_SCREEN_DELTA_PX = 0.25;
const ROTATION_EPSILON = 0.0001;

export type BillboardScreenHeadingScratch = {
    cartographic: Cesium.Cartographic;
    forwardCartesian: Cesium.Cartesian3;
    windowPosition: Cesium.Cartesian2;
    windowForward: Cesium.Cartesian2;
};

export function createBillboardScreenHeadingScratch(): BillboardScreenHeadingScratch {
    return {
        cartographic: new Cesium.Cartographic(),
        forwardCartesian: new Cesium.Cartesian3(),
        windowPosition: new Cesium.Cartesian2(),
        windowForward: new Cesium.Cartesian2(),
    };
}

export function headingFallbackRotation(headingDeg: number | null | undefined): number {
    const heading = Number(headingDeg);
    return Number.isFinite(heading) ? Cesium.Math.toRadians(-heading) : 0;
}

export function screenSpaceRotationForHeading(
    scene: Cesium.Scene,
    position: Cesium.Cartesian3,
    headingDeg: number | null | undefined,
    scratch: BillboardScreenHeadingScratch,
): number | null {
    const heading = Number(headingDeg);
    if (!Number.isFinite(heading)) return null;

    const cartographic = Cesium.Cartographic.fromCartesian(
        position,
        Cesium.Ellipsoid.WGS84,
        scratch.cartographic,
    );
    if (!cartographic) return null;

    const bearing = Cesium.Math.toRadians(heading);
    const angularDistance = FORWARD_DISTANCE_METERS / Math.max(EARTH_RADIUS_METERS, EARTH_RADIUS_METERS + cartographic.height);
    const sinLat = Math.sin(cartographic.latitude);
    const cosLat = Math.cos(cartographic.latitude);
    const sinAngular = Math.sin(angularDistance);
    const cosAngular = Math.cos(angularDistance);
    const nextLat = Math.asin(sinLat * cosAngular + cosLat * sinAngular * Math.cos(bearing));
    const nextLng = cartographic.longitude + Math.atan2(
        Math.sin(bearing) * sinAngular * cosLat,
        cosAngular - sinLat * Math.sin(nextLat),
    );

    Cesium.Cartesian3.fromRadians(
        nextLng,
        nextLat,
        cartographic.height,
        Cesium.Ellipsoid.WGS84,
        scratch.forwardCartesian,
    );

    const screenPosition = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        position,
        scratch.windowPosition,
    );
    const screenForward = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        scratch.forwardCartesian,
        scratch.windowForward,
    );
    if (!screenPosition || !screenForward) return null;

    const dx = screenForward.x - screenPosition.x;
    const dy = screenForward.y - screenPosition.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    if (Math.abs(dx) < MIN_SCREEN_DELTA_PX && Math.abs(dy) < MIN_SCREEN_DELTA_PX) return null;

    return -Math.atan2(dx, -dy);
}

export function applyBillboardScreenSpaceHeading(
    scene: Cesium.Scene,
    billboard: Cesium.Billboard,
    headingDeg: number | null | undefined,
    scratch: BillboardScreenHeadingScratch,
): boolean {
    const rotation = screenSpaceRotationForHeading(scene, billboard.position, headingDeg, scratch);
    if (rotation == null) return false;
    if (Math.abs(billboard.rotation - rotation) <= ROTATION_EPSILON) return false;
    billboard.rotation = rotation;
    return true;
}
