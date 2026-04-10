import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import * as satelliteJs from 'satellite.js';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// Distinct billboard icons per satellite class.
//   military   — red, crosshair-style target
//   commercial — cyan, classic two-panel comsat
//   civilian   — lime, ISS-style station with truss
const svg = (body: string) => `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" stroke="black" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
);

const SAT_ICONS: Record<string, string> = {
    military: svg(`<circle cx="12" cy="12" r="3" fill="#ef4444"/><circle cx="12" cy="12" r="7" fill="none" stroke="#ef4444" stroke-width="1.6"/><line x1="12" y1="2" x2="12" y2="5" stroke="#ef4444" stroke-width="1.6"/><line x1="12" y1="19" x2="12" y2="22" stroke="#ef4444" stroke-width="1.6"/><line x1="2" y1="12" x2="5" y2="12" stroke="#ef4444" stroke-width="1.6"/><line x1="19" y1="12" x2="22" y2="12" stroke="#ef4444" stroke-width="1.6"/>`),
    commercial: svg(`<rect x="10" y="9" width="4" height="6" fill="#06b6d4"/><rect x="2" y="10" width="7" height="4" fill="#06b6d4" stroke="black"/><rect x="15" y="10" width="7" height="4" fill="#06b6d4" stroke="black"/><line x1="12" y1="9" x2="12" y2="4" stroke="#06b6d4" stroke-width="1.6"/><circle cx="12" cy="3" r="1.2" fill="#06b6d4"/>`),
    civilian: svg(`<rect x="8" y="10" width="8" height="4" fill="#84cc16" stroke="black"/><rect x="2" y="9" width="5" height="6" fill="#84cc16" stroke="black"/><rect x="17" y="9" width="5" height="6" fill="#84cc16" stroke="black"/><line x1="9" y1="10" x2="7" y2="9" stroke="black"/><line x1="15" y1="10" x2="17" y2="9" stroke="black"/>`),
};

// Recon satellite icon — amber/gold eye symbol, larger and distinctive
const SAT_RECON_ICON = svg(
    `<circle cx="12" cy="12" r="8" fill="none" stroke="#f59e0b" stroke-width="2"/>` +
    `<circle cx="12" cy="12" r="3.5" fill="#f59e0b"/>` +
    `<ellipse cx="12" cy="12" rx="11" ry="6" fill="none" stroke="#f59e0b" stroke-width="1.5"/>` +
    `<line x1="12" y1="2" x2="12" y2="5" stroke="#f59e0b" stroke-width="1.5"/>` +
    `<line x1="12" y1="19" x2="12" y2="22" stroke="#f59e0b" stroke-width="1.5"/>`
);

const getSatSvg = (type: string, isRecon?: boolean) => {
    if (isRecon) return SAT_RECON_ICON;
    return SAT_ICONS[type] || SAT_ICONS.civilian;
};

// Satellite sensor footprint — a line from the satellite to nadir (ground point)
// plus a ground ellipse showing approximate field of regard.
// FOV depends on satellite type:
//   military/recon: narrow (~10°), high-res imaging
//   commercial:     medium (~20°), Earth observation
//   civilian:       wide (~45°), comms/weather
const SAT_FOV_DEG: Record<string, number> = {
    military: 10,
    commercial: 20,
    civilian: 45,
};

export function useSatellitesLayer(viewer: Cesium.Viewer | null) {
    const isVisible = useTimelineStore(s => s.layers.satellites);
    const dataSourceRef = useRef<Cesium.CustomDataSource | null>(null);

    useEffect(() => {
        if (!viewer) return;

        const ds = new Cesium.CustomDataSource('satellites');
        viewer.dataSources.add(ds);
        dataSourceRef.current = ds;

        // Clustering available but off by default — 300 satellites is fine
        // without clustering, and clustering causes flickering during rotation.
        ds.clustering.enabled = false;
        ds.clustering.pixelRange = 40;
        ds.clustering.minimumClusterSize = 12;
        const bubble = `data:image/svg+xml,` + encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">` +
            `<circle cx="12" cy="12" r="10" fill="#06b6d4" fill-opacity="0.5" stroke="#06b6d4" stroke-width="1.5"/>` +
            `<circle cx="12" cy="12" r="6" fill="black" fill-opacity="0.55"/></svg>`
        );
        ds.clustering.clusterEvent.addEventListener((entities, cluster) => {
            cluster.label.show = true;
            cluster.label.text = entities.length.toLocaleString();
            cluster.label.font = 'bold 11px monospace';
            cluster.label.fillColor = Cesium.Color.WHITE;
            cluster.label.style = Cesium.LabelStyle.FILL_AND_OUTLINE;
            cluster.label.outlineWidth = 2;
            cluster.label.outlineColor = Cesium.Color.BLACK;
            cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
            cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
            cluster.billboard.show = true;
            cluster.billboard.image = bubble;
            cluster.billboard.scale = 0.7 + Math.min(0.5, Math.log10(entities.length) * 0.2);
            cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
            cluster.billboard.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
        });

        let active = true;

        async function fetchSatellites() {
            try {
                const res = await axios.get('http://localhost:3055/api/satellites');
                if (!active) return;
                
                const data = res.data;
                useTimelineStore.getState().setStreamMetric('satellites', { count: data.length, status: 'streaming' });

                data.forEach((sat: any) => {
                    const satrec = satelliteJs.twoline2satrec(sat.tleLine1, sat.tleLine2);
                    const positionProperty = new Cesium.SampledPositionProperty();
                    // HOLD so the satellite stays visible if the clock drifts past
                    // the precomputed ±2h sample window before the next refresh.
                    positionProperty.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
                    positionProperty.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;

                    // Precompute orbits for +/- 2 hours from current time
                    const now = new Date();
                    const start = Cesium.JulianDate.fromDate(new Date(now.getTime() - 2 * 3600 * 1000));
                    
                    // Sample every 2 minutes for 4 hours total
                    for (let i = 0; i <= 120; i += 1) {
                        const time = Cesium.JulianDate.addMinutes(start, i * 2, new Cesium.JulianDate());
                        const jsDate = Cesium.JulianDate.toDate(time);
                        const positionAndVelocity = satelliteJs.propagate(satrec, jsDate);
                        
                        if (positionAndVelocity.position && typeof positionAndVelocity.position !== 'boolean') {
                            const p = positionAndVelocity.position as satelliteJs.EciVec3<number>;
                            const gmst = satelliteJs.gstime(jsDate);
                            const geodetic = satelliteJs.eciToGeodetic(p, gmst);

                            const lon = Cesium.Math.toDegrees(geodetic.longitude);
                            const lat = Cesium.Math.toDegrees(geodetic.latitude);
                            const height = geodetic.height * 1000; // to meters

                            const cPos = Cesium.Cartesian3.fromDegrees(lon, lat, height);
                            positionProperty.addSample(time, cPos);
                        }
                    }

                    const isRecon = sat.recon === true;
                    // Recon satellites get gold/amber trail; others keep original colors
                    const trailColor = isRecon
                        ? Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.5)
                        : sat.type === 'military' ? Cesium.Color.RED.withAlpha(0.3)
                        : sat.type === 'commercial' ? Cesium.Color.CYAN.withAlpha(0.3)
                        : Cesium.Color.LIME.withAlpha(0.3);

                    const entityProps: Record<string, any> = {
                        layer: 'Satellite',
                        subtype: isRecon ? 'recon' : sat.type,
                    };
                    if (isRecon && sat.reconMeta) {
                        entityProps.country = sat.reconMeta.country;
                        entityProps.sensorType = sat.reconMeta.sensorType;
                        entityProps.resolution = sat.reconMeta.resolution;
                    }

                    ds.entities.add({
                        id: `sat-${sat.name}`,
                        name: sat.name,
                        position: positionProperty as any,
                        properties: new Cesium.PropertyBag(entityProps),
                        billboard: {
                            image: getSatSvg(sat.type, isRecon),
                            scale: isRecon ? 1.8 : 1.4,
                        },
                        path: {
                            resolution: 60, // 1 minute interpolation points
                            material: new Cesium.ColorMaterialProperty(trailColor),
                            width: isRecon ? 2.5 : 1.5,
                            leadTime: 0,
                            trailTime: 5400,
                        }
                    });
                });
            } catch (err) {
                console.error('Failed to load satellites layer', err);
            }
        }
        
        fetchSatellites();

        return () => {
            active = false;
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
            }
        };
    }, [viewer]);

    // Satellite footprint (sensor cone projected to ground)
    // Rendered as a separate datasource so it can be toggled independently
    const footprintDsRef = useRef<Cesium.CustomDataSource | null>(null);

    useEffect(() => {
        if (!viewer || !dataSourceRef.current) return;

        // Remove old footprint DS if exists
        const oldDs = viewer.dataSources.getByName('sat-footprints')[0];
        if (oldDs) viewer.dataSources.remove(oldDs);

        const fpDs = new Cesium.CustomDataSource('sat-footprints');
        viewer.dataSources.add(fpDs);
        footprintDsRef.current = fpDs;

        // For each satellite entity, create a ground ellipse that follows its sub-satellite point
        const satDs = dataSourceRef.current;
        satDs.entities.values.forEach(satEntity => {
            if (!satEntity.position) return;
            const subtype = (satEntity.properties as any)?.subtype?.getValue?.() ?? 'civilian';
            const fovDeg = SAT_FOV_DEG[subtype] || 20;
            const color = subtype === 'military' ? Cesium.Color.RED
                : subtype === 'commercial' ? Cesium.Color.CYAN
                : Cesium.Color.LIME;

            // Ground track point (nadir) — a CallbackProperty that reads the sat position
            // and projects to surface
            const nadirPosition = new Cesium.CallbackProperty((time) => {
                const satPos = satEntity.position!.getValue(time);
                if (!satPos) return Cesium.Cartesian3.ZERO;
                const carto = Cesium.Cartographic.fromCartesian(satPos);
                return Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0);
            }, false);

            // Footprint radius depends on altitude and FOV
            const footprintRadius = new Cesium.CallbackProperty((time) => {
                const satPos = satEntity.position!.getValue(time);
                if (!satPos) return 100000;
                const carto = Cesium.Cartographic.fromCartesian(satPos);
                const altKm = carto.height / 1000;
                // radius = alt * tan(fov/2)
                return altKm * Math.tan(Cesium.Math.toRadians(fovDeg / 2)) * 1000;
            }, false);

            // Ground footprint ellipse
            fpDs.entities.add({
                id: `fp-${satEntity.id}`,
                position: nadirPosition as any,
                ellipse: {
                    semiMinorAxis: footprintRadius as any,
                    semiMajorAxis: footprintRadius as any,
                    material: new Cesium.ColorMaterialProperty(color.withAlpha(0.08)),
                    height: 0,
                    outline: true,
                    outlineColor: color.withAlpha(0.3),
                    outlineWidth: 1,
                },
            });

            // Line from satellite to nadir (sensor beam)
            fpDs.entities.add({
                id: `beam-${satEntity.id}`,
                polyline: {
                    positions: new Cesium.CallbackProperty((time) => {
                        const satPos = satEntity.position!.getValue(time);
                        if (!satPos) return [];
                        const carto = Cesium.Cartographic.fromCartesian(satPos);
                        const ground = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0);
                        return [satPos, ground];
                    }, false) as any,
                    width: 1,
                    material: new Cesium.ColorMaterialProperty(color.withAlpha(0.15)),
                },
            });
        });

        return () => {
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(fpDs);
            }
        };
    }, [viewer, isVisible]);

    const showTrajectories = useTimelineStore(s => s.showTrajectories);
    const clusteringEnabled = useTimelineStore(s => s.clusteringEnabled);

    useEffect(() => {
        if (dataSourceRef.current) {
            dataSourceRef.current.show = isVisible;
        }
    }, [isVisible]);

    // Clustering toggle from store
    useEffect(() => {
        if (dataSourceRef.current) {
            dataSourceRef.current.clustering.enabled = clusteringEnabled;
        }
    }, [clusteringEnabled]);

    useEffect(() => {
        if (dataSourceRef.current) {
            dataSourceRef.current.entities.values.forEach(e => {
                if (e.path) {
                    e.path.show = new Cesium.ConstantProperty(showTrajectories);
                }
            });
        }
        // Also toggle footprint visibility with trajectories
        if (footprintDsRef.current) {
            footprintDsRef.current.show = isVisible && showTrajectories;
        }
    }, [showTrajectories, isVisible]);

    // Recount + apply per-subtype visibility from store. Same pattern as
    // useDynamicLayers — pulled out so each layer owns its own bookkeeping.
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    useEffect(() => {
        if (!viewer) return;
        const tick = () => {
            const ds = dataSourceRef.current;
            if (!ds) return;
            const counts: Record<string, number> = {};
            ds.entities.values.forEach(e => {
                const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'unknown';
                counts[sub] = (counts[sub] || 0) + 1;
                const show = subtypeVisibility[`satellites:${sub}`] !== false;
                e.show = show;
            });
            useTimelineStore.getState().setSubtypeCounts('satellites', counts);
        };
        tick();
        const interval = setInterval(tick, 2000);
        return () => clearInterval(interval);
    }, [viewer, subtypeVisibility]);
}
