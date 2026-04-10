import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { io, Socket } from 'socket.io-client';
import { useTimelineStore } from '../store/useTimelineStore';

// Wraps an inline SVG body in a data URI.
const svgUri = (body: string) => `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" stroke="black" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
);

// Aircraft icons — pre-built data URIs, reused for all billboards of same type.
const AVI_ICONS: Record<string, string> = {
    airliner: svgUri(`<path d="M12 2 L10 11 L2 14 L2 16 L10 14 L10 20 L7 22 L7 23 L12 22 L17 23 L17 22 L14 20 L14 14 L22 16 L22 14 L14 11 Z" fill="#ffffff"/>`),
    military: svgUri(`<path d="M12 2 L8 13 L2 18 L2 20 L9 17 L9 21 L7 22 L7 23 L12 22 L17 23 L17 22 L15 21 L15 17 L22 20 L22 18 L16 13 Z" fill="#facc15"/>`),
    light:    svgUri(`<circle cx="12" cy="12" r="2" fill="#60a5fa"/><path d="M12 4 L11 11 L4 12 L4 13 L11 13 L11 19 L9 20 L9 21 L12 20 L15 21 L15 20 L13 19 L13 13 L20 13 L20 12 L13 11 Z" fill="#60a5fa"/>`),
    general:  svgUri(`<path d="M12 2 L10 11 L2 14 L2 16 L10 14 L10 20 L7 22 L7 23 L12 22 L17 23 L17 22 L14 20 L14 14 L22 16 L22 14 L14 11 Z" fill="#e5e7eb"/>`),
};
const getAviSVG = (type: string) => AVI_ICONS[type] || AVI_ICONS.general;

// Vessel icons
const VESSEL_ICONS: Record<string, string> = {
    cargo:     svgUri(`<rect x="3" y="11" width="18" height="5" fill="#e5e7eb"/><polygon points="3,11 21,11 19,8 5,8" fill="#e5e7eb"/><rect x="6" y="9" width="2" height="2" fill="#0f172a"/><rect x="10" y="9" width="2" height="2" fill="#0f172a"/><rect x="14" y="9" width="2" height="2" fill="#0f172a"/><polygon points="3,16 21,16 19,19 5,19" fill="#cbd5e1"/>`),
    tanker:    svgUri(`<rect x="2" y="10" width="20" height="6" rx="2" fill="#ef4444"/><circle cx="8" cy="13" r="1" fill="#0f172a"/><circle cx="12" cy="13" r="1" fill="#0f172a"/><circle cx="16" cy="13" r="1" fill="#0f172a"/><polygon points="2,16 22,16 20,19 4,19" fill="#b91c1c"/>`),
    passenger: svgUri(`<rect x="5" y="9" width="14" height="6" rx="1" fill="#3b82f6"/><rect x="6" y="10" width="2" height="2" fill="#fef9c3"/><rect x="9" y="10" width="2" height="2" fill="#fef9c3"/><rect x="12" y="10" width="2" height="2" fill="#fef9c3"/><rect x="15" y="10" width="2" height="2" fill="#fef9c3"/><polygon points="5,15 19,15 17,19 7,19" fill="#1d4ed8"/>`),
    fishing:   svgUri(`<polygon points="8,11 16,11 14,16 10,16" fill="#84cc16"/><line x1="12" y1="11" x2="12" y2="4" stroke="#84cc16" stroke-width="1.5"/><line x1="12" y1="4" x2="18" y2="9" stroke="#84cc16" stroke-width="1.5"/>`),
    military:  svgUri(`<rect x="3" y="12" width="18" height="3" fill="#64748b"/><polygon points="3,12 21,12 19,9 5,9" fill="#94a3b8"/><rect x="11" y="6" width="2" height="3" fill="#475569"/><polygon points="3,15 21,15 19,19 5,19" fill="#475569"/>`),
    unknown:   svgUri(`<rect x="4" y="11" width="16" height="4" fill="#9ca3af"/><polygon points="4,15 20,15 18,19 6,19" fill="#6b7280"/>`),
};
const getShipSVG = (type: string) => VESSEL_ICONS[type] || VESSEL_ICONS.unknown;

// Dark vessel icon — red warning triangle with exclamation mark
const DARK_VESSEL_ICON = `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="11" fill="#dc2626" opacity="0.3"/>` +
    `<circle cx="12" cy="12" r="7" fill="#ef4444" stroke="black" stroke-width="1"/>` +
    `<path d="M12 7 L12 13" stroke="white" stroke-width="2.5" stroke-linecap="round"/>` +
    `<circle cx="12" cy="16" r="1.2" fill="white"/>` +
    `</svg>`
);

// Metadata stored per aircraft for picking and EntityHUD.
interface AircraftMeta {
    id: string;
    icao24: string;
    origin: string;
    type: string;
    speed: number;
    heading: number;
    lat: number;
    lng: number;
    alt: number;
}

// Global registry so Globe.tsx picking can look up aircraft metadata by billboard.
// Key = billboard reference (set as billboard.id), value = metadata.
export const aircraftMetaMap = new Map<string, AircraftMeta>();

export function useDynamicLayers(viewer: Cesium.Viewer | null) {
    const isAviationVisible = useTimelineStore(s => s.layers.aviation);
    const isMaritimeVisible = useTimelineStore(s => s.layers.maritime);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const mode = useTimelineStore(s => s.mode);
    const currentTime = useTimelineStore(s => s.currentTime);

    // Aviation: BillboardCollection (GPU-batched, 1 draw call for 11K billboards)
    const aviBillboardsRef = useRef<Cesium.BillboardCollection | null>(null);
    const aviBillboardMap = useRef<Map<string, Cesium.Billboard>>(new Map());

    // Maritime: still Entity API (only ~300-500 vessels, perf is fine)
    const maritimeDsRef = useRef<Cesium.CustomDataSource | null>(null);
    // Dark vessels: separate datasource for AIS-dark flagged vessels
    const darkVesselDsRef = useRef<Cesium.CustomDataSource | null>(null);
    const socketRef = useRef<Socket | null>(null);

    useEffect(() => {
        if (!viewer) return;
        let active = true;

        // --- Aviation: BillboardCollection ---
        const aviBillboards = new Cesium.BillboardCollection({ scene: viewer.scene });
        viewer.scene.primitives.add(aviBillboards);
        aviBillboardsRef.current = aviBillboards;
        const billboardMap = new Map<string, Cesium.Billboard>();
        aviBillboardMap.current = billboardMap;

        // --- Maritime: Entity API (small count, clustering useful) ---
        const maritimeDs = new Cesium.CustomDataSource('maritime');
        viewer.dataSources.add(maritimeDs);
        maritimeDsRef.current = maritimeDs;

        // --- Dark vessels: AIS-silent vessels flagged by backend ---
        const darkVesselDs = new Cesium.CustomDataSource('dark-vessels');
        viewer.dataSources.add(darkVesselDs);
        darkVesselDsRef.current = darkVesselDs;

        const socket = io('http://localhost:3055');
        socketRef.current = socket;

        let aviMsgs = 0;
        let marMsgs = 0;

        const speedInterval = setInterval(() => {
            if (active) {
                useTimelineStore.getState().setStreamMetric('aviation', { speed: `${aviMsgs} Kbps` });
                useTimelineStore.getState().setStreamMetric('maritime', { speed: `${marMsgs} msgs/s` });
                aviMsgs = 0;
                marMsgs = 0;
            }
        }, 10_000);

        socket.on('simulator-update', (data: any) => {
            // ---- Aviation via BillboardCollection ----
            if (data.aircrafts) {
                aviMsgs += Math.round(JSON.stringify(data.aircrafts).length / 1024);

                for (const ac of data.aircrafts) {
                    const pos = Cesium.Cartesian3.fromDegrees(ac.lng, ac.lat, ac.alt * 0.3048);
                    const rotation = Cesium.Math.toRadians(-(ac.heading || 0));

                    let bb = billboardMap.get(ac.id);
                    if (!bb) {
                        bb = aviBillboards.add({
                            position: pos,
                            image: getAviSVG(ac.type),
                            scale: 0.7,
                            rotation,
                            id: ac.id, // for scene.pick()
                        });
                        billboardMap.set(ac.id, bb);
                    } else {
                        bb.position = pos;
                        bb.rotation = rotation;
                    }

                    // Store metadata for picking
                    aircraftMetaMap.set(ac.id, {
                        id: ac.id,
                        icao24: ac.icao24 || '',
                        origin: ac.origin || '',
                        type: ac.type,
                        speed: ac.speed,
                        heading: ac.heading,
                        lat: ac.lat,
                        lng: ac.lng,
                        alt: ac.alt,
                    });
                }
            }

            // Server-computed counts → store (no client forEach)
            if (data.meta) {
                useTimelineStore.getState().setStreamMetric('aviation', {
                    count: data.meta.aviationTotal,
                    status: 'streaming'
                });
                useTimelineStore.getState().setSubtypeCounts('aviation', data.meta.aviationCounts || {});
                useTimelineStore.getState().setSubtypeCounts('maritime', data.meta.maritimeCounts || {});
            }

            // ---- Maritime via Entity API (small count) ----
            marMsgs += data.vessels.length;

            data.vessels.forEach((v: any) => {
                let entity = maritimeDs.entities.getById(v.id);
                const pos = Cesium.Cartesian3.fromDegrees(v.lng, v.lat, 0);
                const rotation = Cesium.Math.toRadians(-(v.heading || 0));

                if (!entity) {
                    const positionProperty = new Cesium.SampledPositionProperty();
                    positionProperty.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
                    positionProperty.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
                    entity = maritimeDs.entities.add({
                        id: v.id,
                        name: `Ship ${v.id}`,
                        position: positionProperty as any,
                        properties: new Cesium.PropertyBag({
                            layer: 'Vessel',
                            subtype: v.type,
                            speed: v.speed,
                            heading: v.heading || 0,
                        }),
                        billboard: {
                            image: getShipSVG(v.type),
                            scale: 0.7,
                            rotation,
                            alignedAxis: Cesium.Cartesian3.UNIT_Z,
                        },
                        // Show vessel trail (wake) — last 30 min of accumulated positions
                        path: {
                            leadTime: 0,
                            trailTime: 1800,
                            width: 1.5,
                            material: new Cesium.PolylineGlowMaterialProperty({
                                glowPower: 0.15,
                                color: Cesium.Color.CYAN.withAlpha(0.4),
                            }),
                        },
                    });
                } else {
                    // Update rotation to match current heading
                    if (entity.billboard) {
                        entity.billboard.rotation = new Cesium.ConstantProperty(rotation);
                    }
                    // Update type if known
                    if (entity.properties && v.type !== 'unknown') {
                        (entity.properties as any).subtype = new Cesium.ConstantProperty(v.type);
                        if (entity.billboard) {
                            entity.billboard.image = new Cesium.ConstantProperty(getShipSVG(v.type));
                        }
                    }
                    // Update speed/heading properties for EntityHUD
                    if (entity.properties) {
                        (entity.properties as any).speed = new Cesium.ConstantProperty(v.speed || 0);
                        (entity.properties as any).heading = new Cesium.ConstantProperty(v.heading || 0);
                    }
                }

                const positionProperty = entity.position as Cesium.SampledPositionProperty;
                const prev = positionProperty.getValue(viewer.clock.currentTime);
                if (!prev || !Cesium.Cartesian3.equalsEpsilon(prev, pos, 0, 1.0)) {
                    positionProperty.addSample(viewer.clock.currentTime, pos);
                }
            });

            if (data.meta) {
                const darkCount = data.meta.darkVesselCount || 0;
                useTimelineStore.getState().setStreamMetric('maritime', {
                    count: data.meta.maritimeTotal + darkCount,
                    status: data.meta.maritimeTotal > 0 ? 'streaming' : 'connecting'
                });
            }

            // ---- Dark vessels via Entity API ----
            if (data.darkVessels && Array.isArray(data.darkVessels)) {
                // Track which dark vessels are in the current payload
                const currentDarkIds = new Set<string>();
                for (const dv of data.darkVessels) {
                    const darkId = `dark-${dv.id}`;
                    currentDarkIds.add(darkId);
                    const pos = Cesium.Cartesian3.fromDegrees(dv.lng, dv.lat, 0);

                    let entity = darkVesselDs.entities.getById(darkId);
                    if (!entity) {
                        const darkSinceDate = new Date(dv.darkSince);
                        const darkMinutes = Math.round((Date.now() - dv.darkSince) / 60000);
                        darkVesselDs.entities.add({
                            id: darkId,
                            name: `Dark Vessel ${dv.id} (${darkMinutes}m silent)`,
                            position: Cesium.Cartesian3.fromDegrees(dv.lng, dv.lat, 0),
                            properties: new Cesium.PropertyBag({
                                layer: 'Dark Vessel',
                                subtype: dv.type || 'unknown',
                                speed: dv.speed,
                                heading: dv.heading || 0,
                                lastSeen: new Date(dv.lastSeen).toISOString(),
                                darkSince: darkSinceDate.toISOString(),
                            }),
                            billboard: {
                                image: DARK_VESSEL_ICON,
                                scale: 1.1,
                            },
                            // Red pulsing ellipse around last known position
                            ellipse: {
                                semiMinorAxis: 50_000,
                                semiMajorAxis: 50_000,
                                material: new Cesium.ColorMaterialProperty(Cesium.Color.RED.withAlpha(0.08)),
                                height: 0,
                                outline: true,
                                outlineColor: Cesium.Color.RED.withAlpha(0.3),
                                outlineWidth: 1,
                            },
                        });
                    } else {
                        // Update name with current dark duration
                        const darkMinutes = Math.round((Date.now() - dv.darkSince) / 60000);
                        entity.name = `Dark Vessel ${dv.id} (${darkMinutes}m silent)`;
                    }
                }

                // Remove entities that are no longer dark (vessel reappeared)
                const toRemove: string[] = [];
                darkVesselDs.entities.values.forEach(e => {
                    if (!currentDarkIds.has(e.id)) toRemove.push(e.id);
                });
                for (const id of toRemove) darkVesselDs.entities.removeById(id);
            }
        });

        return () => {
            active = false;
            clearInterval(speedInterval);
            socket.disconnect();
            aircraftMetaMap.clear();
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(aviBillboards);
                viewer.dataSources.remove(maritimeDs);
                viewer.dataSources.remove(darkVesselDs);
            }
        };
    }, [viewer]);

    // Visibility toggles
    useEffect(() => {
        const isDeepHistory = mode === 'playback' && (Date.now() - currentTime.getTime() > 10 * 60 * 1000);
        if (aviBillboardsRef.current) aviBillboardsRef.current.show = isAviationVisible && !isDeepHistory;
        if (maritimeDsRef.current) maritimeDsRef.current.show = isMaritimeVisible && !isDeepHistory;
        if (darkVesselDsRef.current) darkVesselDsRef.current.show = isMaritimeVisible && !isDeepHistory;
    }, [isAviationVisible, isMaritimeVisible, mode, currentTime]);

    // Per-subtype visibility (aviation: hide/show by type via billboard.show)
    useEffect(() => {
        const hasFilters = Object.keys(subtypeVisibility).some(k => k.startsWith('aviation:'));
        if (!hasFilters) return;
        aviBillboardMap.current.forEach((bb, id) => {
            const meta = aircraftMetaMap.get(id);
            if (meta) {
                bb.show = subtypeVisibility[`aviation:${meta.type}`] !== false;
            }
        });
    }, [subtypeVisibility]);

    // Per-subtype visibility for maritime (Entity API)
    useEffect(() => {
        const hasFilters = Object.keys(subtypeVisibility).some(k => k.startsWith('maritime:'));
        if (!hasFilters || !maritimeDsRef.current) return;
        maritimeDsRef.current.entities.values.forEach(e => {
            const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'unknown';
            e.show = subtypeVisibility[`maritime:${sub}`] !== false;
        });
    }, [subtypeVisibility]);
}
