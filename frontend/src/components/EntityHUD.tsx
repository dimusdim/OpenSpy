'use client';

import { useTimelineStore } from '../store/useTimelineStore';
import { useEffect, useState, useRef, useCallback } from 'react';
import * as Cesium from 'cesium';
import { Crosshair, Filter, X } from 'lucide-react';
import axios from 'axios';
import Hls from 'hls.js';
import { aircraftMetaMap } from '../cesium/useDynamicLayers';
import { webcamMetaMap } from '../cesium/useWebcamsLayer';
import { API_URL } from '../lib/config';
import { fireMetaMap } from '../cesium/useFiresLayer';
import { cableMetaMap } from '../cesium/useCablesLayer';
import { pipelineMetaMap } from '../cesium/usePipelinesLayer';
import { airspaceMetaMap } from '../cesium/useAirspaceLayer';
import { infraMetaMap } from '../cesium/useInfrastructureLayer';
import { satelliteMetaMap } from '../cesium/useSatellitesLayer';

// Squawk code interpretation
function squawkBadge(code: string | null): { label: string; color: string } | null {
    if (!code) return null;
    if (code === '7700') return { label: 'EMERGENCY', color: 'bg-red-600 text-white' };
    if (code === '7600') return { label: 'RADIO FAIL', color: 'bg-orange-600 text-white' };
    if (code === '7500') return { label: 'HIJACK', color: 'bg-red-800 text-white' };
    return null;
}

// Fire type to human label
function fireTypeLabel(ft: number): string | null {
    switch (ft) {
        case 1: return 'VOLCANIC';
        case 2: return 'INDUSTRIAL';
        case 3: return 'OFFSHORE';
        default: return null;
    }
}

// Format duration in seconds to human readable
function fmtDuration(sec: number | null): string {
    if (!sec || sec <= 0) return '—';
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)} hr`;
    return `${(sec / 86400).toFixed(1)} days`;
}

function formatSubtypeLabel(layer: string | undefined, subtype: string | undefined): string {
    if (!subtype) return '—';
    if (layer === 'Disaster') {
        const labels: Record<string, string> = {
            EQ: 'Earthquake',
            FL: 'Flood',
            TC: 'Tropical Cyclone',
            VO: 'Volcano',
            WF: 'Wildfire',
            DR: 'Drought',
        };
        return labels[subtype] || subtype;
    }
    return subtype;
}

// Domain lookup for isolation buttons
const LAYER_TO_DOMAIN: Record<string, string> = {
    Aircraft: 'Air', Vessel: 'Sea', 'AIS Signal Lost': 'Sea', GFW: 'Sea',
    Satellite: 'Space', Conflict: 'Ground', Disaster: 'Ground', Fire: 'Ground',
    Infrastructure: 'Infrastructure', Cable: 'Infrastructure', Pipeline: 'Infrastructure',
    Outage: 'Connectivity', Webcam: 'Context', Airspace: 'Air', Jamming: 'Air',
};

// HUD that locks onto whatever entity the user clicked. Continuously projects
// the entity's 3D world position to screen coords (for the dotted leader line)
// AND reads back the live geodetic position (lat/lng/alt) + the subtype that
// the layer hooks stashed in entity.properties when the entity was created.
export default function EntityHUD() {
    // Individual selectors — whole-store subscription re-renders this
    // component on every store write (streamMetrics, currentTime, etc.),
    // including the 60 Hz rAF loop below calling setScreenPos/setLive.
    // Per-field selectors keep re-renders bound to what EntityHUD reads.
    const selectedEntityId = useTimelineStore(s => s.selectedEntityId);
    const selectedEntityData = useTimelineStore(s => s.selectedEntityData);
    const [screenPos, setScreenPos] = useState<{ x: number, y: number } | null>(null);
    const [live, setLive] = useState<{
        lat: number;
        lng: number;
        alt: number;
        layer?: string;
        subtype?: string;
        alertLevel?: string;
        source?: string;
        speed?: number;
        heading?: number;
        description?: string;
        // Enrichment fields (populated per layer type)
        extra?: Record<string, any>;
    } | null>(null);

    useEffect(() => {
        if (!selectedEntityId || typeof window === 'undefined') {
            setScreenPos(null);
            setLive(null);
            return;
        }

        const cesViewer = (window as any).viewerContext as Cesium.Viewer;
        if (!cesViewer) return;

        let active = true;

        // Search ALL dataSources for the selected entity
        const findEntity = () => {
            // Check viewer's own entities first
            const direct = cesViewer.entities.getById(selectedEntityId);
            if (direct) return direct;
            // Search every dataSource
            for (let i = 0; i < cesViewer.dataSources.length; i++) {
                const ds = cesViewer.dataSources.get(i);
                const found = ds.entities.getById(selectedEntityId);
                if (found) return found;
            }
            return undefined;
        };

        const readProp = (props: any, key: string) => {
            try {
                const p = props?.[key];
                if (!p) return undefined;
                return typeof p.getValue === 'function' ? p.getValue() : p;
            } catch { return undefined; }
        };

        const update = () => {
            if (!active) return;

            // Webcam billboard — read from metadata map.
            const wcMeta = webcamMetaMap.get(selectedEntityId);
            if (wcMeta) {
                const pos = Cesium.Cartesian3.fromDegrees(wcMeta.lng, wcMeta.lat, 0);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: wcMeta.lat,
                    lng: wcMeta.lng,
                    alt: 0,
                    layer: 'Webcam',
                    source: wcMeta.source,
                });
                requestAnimationFrame(update);
                return;
            }

            // Fire point — read from fireMetaMap
            const fireMeta = fireMetaMap.get(selectedEntityId);
            if (fireMeta) {
                const pos = Cesium.Cartesian3.fromDegrees(fireMeta.lng, fireMeta.lat, 500);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                const level = fireMeta.frp > 100 ? 'high' : fireMeta.frp > 30 ? 'medium' : 'low';
                setLive({
                    lat: fireMeta.lat,
                    lng: fireMeta.lng,
                    alt: 0,
                    layer: 'Fire',
                    subtype: level,
                    source: 'NASA FIRMS',
                    description: `FRP: ${fireMeta.frp.toFixed(1)} MW | Brightness: ${fireMeta.brightness.toFixed(0)} K | Confidence: ${fireMeta.confidence}`,
                    extra: {
                        daynight: fireMeta.daynight,
                        acqTime: fireMeta.acqTime,
                        fireType: fireMeta.fireType,
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            // Submarine cable (GroundPolylinePrimitive) — read from metaMap.
            // Cables aren't in any dataSource.entities, so findEntity() would
            // miss them; this branch runs before findEntity() below.
            const cableMeta = cableMetaMap.get(selectedEntityId);
            if (cableMeta) {
                const pos = Cesium.Cartesian3.fromDegrees(cableMeta.lng, cableMeta.lat, 0);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: cableMeta.lat,
                    lng: cableMeta.lng,
                    alt: 0,
                    layer: cableMeta.layer,
                    subtype: cableMeta.subtype,
                    source: cableMeta.source,
                    description: cableMeta.description,
                    extra: {
                        owners: cableMeta.owners,
                        length: cableMeta.length,
                        year: cableMeta.year,
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            // Oil/gas pipeline (batched Primitive). Same rationale as cables —
            // not in entities, HUD reads straight from metaMap.
            const pipelineMeta = pipelineMetaMap.get(selectedEntityId);
            if (pipelineMeta) {
                const pos = Cesium.Cartesian3.fromDegrees(pipelineMeta.lng, pipelineMeta.lat, 0);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: pipelineMeta.lat,
                    lng: pipelineMeta.lng,
                    alt: 0,
                    layer: pipelineMeta.layer,
                    subtype: pipelineMeta.substance,
                    source: pipelineMeta.source,
                    description: pipelineMeta.description,
                });
                requestAnimationFrame(update);
                return;
            }

            // Airspace zone (dual Primitive fill+outline). HUD shows type,
            // vertical limits and source in the description row below.
            const airspaceMeta = airspaceMetaMap.get(selectedEntityId);
            if (airspaceMeta) {
                const pos = Cesium.Cartesian3.fromDegrees(
                    airspaceMeta.lng,
                    airspaceMeta.lat,
                    airspaceMeta.lowerLimit || 0
                );
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: airspaceMeta.lat,
                    lng: airspaceMeta.lng,
                    alt: airspaceMeta.lowerLimit || 0,
                    layer: airspaceMeta.layer,
                    subtype: airspaceMeta.subtype,
                    source: airspaceMeta.source,
                    description: `${airspaceMeta.name} — ${airspaceMeta.lowerLimit}→${airspaceMeta.upperLimit}m`,
                });
                requestAnimationFrame(update);
                return;
            }

            // Infrastructure (billboards + power-line GroundPolylinePrimitive).
            // All infrastructure objects share one metaMap so one branch
            // handles plants, refineries, substations, military, power lines.
            const infraMeta = infraMetaMap.get(selectedEntityId);
            if (infraMeta) {
                const pos = Cesium.Cartesian3.fromDegrees(infraMeta.lng, infraMeta.lat, 50);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: infraMeta.lat,
                    lng: infraMeta.lng,
                    alt: 0,
                    layer: infraMeta.layer,
                    subtype: infraMeta.subtype,
                    source: infraMeta.source,
                    description: infraMeta.description,
                });
                requestAnimationFrame(update);
                return;
            }

            // Aircraft are now BillboardCollection, not Entity. Read from metadata map.
            const acMeta = aircraftMetaMap.get(selectedEntityId);
            if (acMeta) {
                const pos = Cesium.Cartesian3.fromDegrees(acMeta.lng, acMeta.lat, acMeta.alt * 0.3048);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                const carto = Cesium.Cartographic.fromCartesian(pos);
                setLive({
                    lat: Cesium.Math.toDegrees(carto.latitude),
                    lng: Cesium.Math.toDegrees(carto.longitude),
                    alt: carto.height,
                    layer: 'Aircraft',
                    subtype: acMeta.type,
                    speed: acMeta.speed,
                    heading: acMeta.heading,
                    extra: {
                        squawk: acMeta.squawk,
                        verticalRate: acMeta.verticalRate,
                        onGround: acMeta.onGround,
                        lastContact: acMeta.lastContact,
                        callsign: acMeta.callsign,
                        icao24: acMeta.icao24,
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            // Satellite billboard — current live position is updated in
            // satelliteMetaMap from the worker positions stream.
            const satMeta = satelliteMetaMap.get(selectedEntityId);
            if (
                satMeta &&
                Number.isFinite(satMeta.lat) &&
                Number.isFinite(satMeta.lng) &&
                Number.isFinite(satMeta.alt)
            ) {
                const pos = Cesium.Cartesian3.fromDegrees(satMeta.lng!, satMeta.lat!, satMeta.alt!);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: satMeta.lat!,
                    lng: satMeta.lng!,
                    alt: satMeta.alt!,
                    layer: 'Satellite',
                    subtype: satMeta.subtype,
                    extra: {
                        noradId: satMeta.noradId,
                        resolution: satMeta.reconMeta?.resolution,
                        country: satMeta.reconMeta?.country,
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            // Entity-based objects (satellites, maritime, disasters, jamming, borders)
            const entity = findEntity();
            if (entity && entity.position) {
                const time = cesViewer.clock.currentTime;
                const pos = entity.position.getValue(time);
                if (pos) {
                    const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                    setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                    const carto = Cesium.Cartographic.fromCartesian(pos);
                    const props = entity.properties as any;
                    const layer = readProp(props, 'layer');
                    // Build enrichment extra object based on layer type
                    const extra: Record<string, any> = {};
                    if (layer === 'Vessel') {
                        extra.vesselName = readProp(props, 'vesselName');
                        extra.callSign = readProp(props, 'callSign');
                        extra.imo = readProp(props, 'imo');
                        extra.navigationStatus = readProp(props, 'navigationStatus');
                        extra.destination = readProp(props, 'destination');
                        extra.eta = readProp(props, 'eta');
                        extra.rateOfTurn = readProp(props, 'rateOfTurn');
                        extra.draught = readProp(props, 'draught');
                        extra.vesselLength = readProp(props, 'vesselLength');
                        extra.beam = readProp(props, 'beam');
                        extra.cog = readProp(props, 'cog');
                    } else if (layer === 'GFW') {
                        extra.confidence = readProp(props, 'confidence');
                        extra.duration = readProp(props, 'duration');
                        extra.vesselOwner = readProp(props, 'vesselOwner');
                        extra.vesselMmsi = readProp(props, 'vesselMmsi');
                        extra.vesselType = readProp(props, 'vesselType');
                        extra.vesselName = readProp(props, 'vesselName');
                        extra.flagState = readProp(props, 'flagState');
                        extra.start = readProp(props, 'start');
                        extra.end = readProp(props, 'end');
                    } else if (layer === 'Satellite') {
                        extra.noradId = readProp(props, 'noradId');
                        extra.resolution = readProp(props, 'resolution');
                        extra.country = readProp(props, 'country');
                    } else if (layer === 'Conflict') {
                        extra.event_type = readProp(props, 'event_type');
                        extra.sub_event_type = readProp(props, 'sub_event_type');
                        extra.fatalities = readProp(props, 'fatalities');
                        extra.country = readProp(props, 'country');
                        extra.actor1 = readProp(props, 'actor1');
                        extra.actor2 = readProp(props, 'actor2');
                        extra.event_date = readProp(props, 'event_date');
                        extra.notes = readProp(props, 'notes');
                    }
                    setLive({
                        lat: Cesium.Math.toDegrees(carto.latitude),
                        lng: Cesium.Math.toDegrees(carto.longitude),
                        alt: carto.height,
                        layer,
                        subtype: readProp(props, 'subtype'),
                        alertLevel: readProp(props, 'alertLevel'),
                        source: readProp(props, 'source'),
                        speed: readProp(props, 'speed'),
                        heading: readProp(props, 'heading'),
                        description: readProp(props, 'description'),
                        extra,
                    });
                }
            }
            requestAnimationFrame(update);
        };

        requestAnimationFrame(update);

        return () => {
            active = false;
        };
    }, [selectedEntityId]);

    // Enrich aircraft with photo (Planespotters) + route (OpenSky)
    const [aircraftRoute, setAircraftRoute] = useState<{ origin: string; destination: string } | null>(null);
    const [aircraftPhoto, setAircraftPhoto] = useState<string | null>(null);
    const [aircraftInfo, setAircraftInfo] = useState<{ origin: string } | null>(null);

    useEffect(() => {
        setAircraftRoute(null);
        setAircraftPhoto(null);
        setAircraftInfo(null);
        if (!selectedEntityId || !selectedEntityData) return;
        if (selectedEntityData.type !== 'Aircraft') return;

        // selectedEntityId is now icao24 (primary key). Callsign comes from meta.
        const meta = aircraftMetaMap.get(selectedEntityId);
        let cancelled = false;

        // Origin country from OpenSky data
        if (meta?.origin) {
            setAircraftInfo({ origin: meta.origin });
        }

        // Photo from Planespotters.net via backend proxy (uses icao24)
        if (meta?.icao24) {
            axios.get(`${API_URL}/api/aircraft-photo/${meta.icao24}`)
                .then(res => {
                    if (cancelled) return;
                    const photo = res.data?.photos?.[0];
                    if (photo?.thumbnail_large?.src) {
                        setAircraftPhoto(photo.thumbnail_large.src);
                    }
                })
                .catch(err => console.warn('[EntityHUD] Photo fetch failed:', err.message));
        }

        // Fetch route via backend proxy (uses callsign, not icao24)
        const callsign = meta?.callsign?.trim();
        if (callsign && callsign !== meta?.icao24) {
            axios.get(`${API_URL}/api/routes/${encodeURIComponent(callsign)}`)
                .then(res => {
                    if (cancelled) return;
                    if (res.data?.route?.length >= 2) {
                        setAircraftRoute({
                            origin: res.data.route[0],
                            destination: res.data.route[res.data.route.length - 1],
                        });
                    }
                })
                .catch(err => console.warn('[EntityHUD] Route fetch failed:', err.message));
        }

        return () => { cancelled = true; };
    }, [selectedEntityId, selectedEntityData]);

    if (!selectedEntityId || !selectedEntityData) return null;

    const panelX = typeof window !== 'undefined' ? window.innerWidth - 340 : 1000;
    const panelY = 100;

    const flyTo = () => {
        if (!live) return;
        document.dispatchEvent(new CustomEvent('fly-to', {
            detail: {
                lat: live.lat,
                lng: live.lng,
                height: Math.max(live.alt + 50_000, 500_000),
            }
        }));
    };

    // Coordinate formatter: 4-decimal degrees with hemisphere letter
    const fmtLat = (l: number) => `${Math.abs(l).toFixed(4)}° ${l >= 0 ? 'N' : 'S'}`;
    const fmtLng = (l: number) => `${Math.abs(l).toFixed(4)}° ${l >= 0 ? 'E' : 'W'}`;
    const fmtAlt = (m: number) => m > 1000 ? `${(m / 1000).toFixed(1)} km` : `${m.toFixed(0)} m`;

    const alertColor =
        live?.alertLevel === 'Red' ? 'text-red-400'
        : live?.alertLevel === 'Orange' ? 'text-orange-400'
        : live?.alertLevel === 'Green' ? 'text-green-400'
        : 'text-zinc-400';

    return (
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
            {screenPos && (
                <svg className="absolute inset-0 w-full h-full opacity-60">
                    <line
                        x1={screenPos.x} y1={screenPos.y}
                        x2={panelX - 10} y2={panelY + 40}
                        stroke="#06b6d4" strokeWidth="1" strokeDasharray="4 4"
                    />
                    <circle cx={screenPos.x} cy={screenPos.y} r="6" fill="transparent" stroke="#06b6d4" strokeWidth="2" strokeDasharray="3 3" className="animate-spin" style={{ animationDuration: '3s' }} />
                </svg>
            )}

            <div
                className="absolute w-80 max-h-[80vh] overflow-y-auto pointer-events-auto bg-black/85 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-[0_0_30px_rgba(0,0,0,0.8)]"
                style={{ top: panelY, left: panelX }}
            >
                <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
                    <div className="text-xs font-mono font-bold text-cyan-400 tracking-wider">TARGET ACQUIRED</div>
                    <button onClick={() => useTimelineStore.getState().setSelectedEntityId(null)} className="text-zinc-500 hover:text-white text-xl leading-none">&times;</button>
                </div>

                <div className="p-4 space-y-3">
                    <div>
                        <div className="text-[10px] text-zinc-500 font-mono">IDENTIFIER</div>
                        <div className="font-bold text-base leading-tight">{selectedEntityData.name || selectedEntityId}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <div className="text-[10px] text-zinc-500 font-mono">LAYER</div>
                            <div className="text-cyan-300 text-sm">{live?.layer || selectedEntityData.type || '—'}</div>
                        </div>
                        <div>
                            <div className="text-[10px] text-zinc-500 font-mono">CLASS</div>
                            <div className="text-yellow-300 text-sm uppercase">{formatSubtypeLabel(live?.layer, live?.subtype)}</div>
                        </div>
                    </div>

                    {aircraftInfo?.origin && (
                        <div>
                            <div className="text-[10px] text-zinc-500 font-mono">ORIGIN</div>
                            <div className="text-zinc-300 text-sm">{aircraftInfo.origin}</div>
                        </div>
                    )}

                    {aircraftRoute && (
                        <div>
                            <div className="text-[10px] text-zinc-500 font-mono">ROUTE</div>
                            <div className="text-cyan-300 text-sm font-mono">
                                {aircraftRoute.origin} → {aircraftRoute.destination}
                            </div>
                        </div>
                    )}

                    {aircraftPhoto && (
                        <div className="border-t border-zinc-800/60 pt-2">
                            <div className="text-[10px] text-zinc-500 font-mono mb-1">AIRCRAFT PHOTO</div>
                            <img
                                src={aircraftPhoto}
                                alt="Aircraft"
                                className="w-full rounded-md border border-zinc-700"
                                loading="lazy"
                            />
                        </div>
                    )}

                    {live?.alertLevel && (
                        <div>
                            <div className="text-[10px] text-zinc-500 font-mono">ALERT LEVEL</div>
                            <div className={`${alertColor} text-sm font-semibold uppercase`}>{live.alertLevel}</div>
                        </div>
                    )}

                    {live?.source && (
                        <div>
                            <div className="text-[10px] text-zinc-500 font-mono">SOURCE</div>
                            <div className="text-zinc-300 text-xs font-mono">{live.source}</div>
                        </div>
                    )}

                    {/* ---- Aircraft enrichment ---- */}
                    {live?.layer === 'Aircraft' && live.extra && (
                        <div className="space-y-2">
                            {live.extra.squawk && (
                                <div className="flex items-center gap-2">
                                    <div>
                                        <div className="text-[10px] text-zinc-500 font-mono">SQUAWK</div>
                                        <div className="text-zinc-300 text-sm font-mono">{live.extra.squawk}</div>
                                    </div>
                                    {squawkBadge(live.extra.squawk) && (
                                        <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${squawkBadge(live.extra.squawk)!.color}`}>
                                            {squawkBadge(live.extra.squawk)!.label}
                                        </span>
                                    )}
                                </div>
                            )}
                            {live.extra.verticalRate != null && live.extra.verticalRate !== 0 && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">VERTICAL RATE</div>
                                    <div className="text-zinc-300 text-sm font-mono">
                                        {live.extra.verticalRate > 0 ? '↑' : '↓'} {Math.abs(live.extra.verticalRate).toFixed(1)} m/s
                                    </div>
                                </div>
                            )}
                            {live.extra.onGround && (
                                <span className="inline-block text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-yellow-700/50 text-yellow-300 border border-yellow-600/40">ON GROUND</span>
                            )}
                            {live.extra.lastContact && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">LAST CONTACT</div>
                                    <div className={`text-sm font-mono ${
                                        Date.now() / 1000 - live.extra.lastContact < 30 ? 'text-green-400'
                                        : Date.now() / 1000 - live.extra.lastContact < 120 ? 'text-yellow-400'
                                        : 'text-red-400'
                                    }`}>
                                        {Math.round(Date.now() / 1000 - live.extra.lastContact)}s ago
                                        {Date.now() / 1000 - live.extra.lastContact > 120 && (
                                            <span className="ml-1 text-[9px] bg-red-800/50 text-red-300 px-1 py-0.5 rounded">STALE</span>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ---- Vessel enrichment ---- */}
                    {live?.layer === 'Vessel' && (
                        <div className="space-y-2">
                            <div>
                                <div className="text-[10px] text-zinc-500 font-mono">MMSI</div>
                                <div className="text-zinc-300 text-sm font-mono">{selectedEntityId}</div>
                            </div>
                            {live.extra?.callSign && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">CALL SIGN</div>
                                    <div className="text-zinc-300 text-sm font-mono">{live.extra.callSign}</div>
                                </div>
                            )}
                            {live.extra?.imo && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">IMO</div>
                                    <div className="text-zinc-300 text-sm font-mono">{live.extra.imo}</div>
                                </div>
                            )}
                            {live.extra?.navigationStatus && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">NAV STATUS</div>
                                    <div className="text-zinc-300 text-xs">{live.extra.navigationStatus}</div>
                                </div>
                            )}
                            {live.extra?.destination && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">DESTINATION</div>
                                    <div className="text-cyan-300 text-sm font-mono">
                                        {live.extra.destination}
                                        {live.extra.eta && <span className="text-zinc-500 text-xs ml-1">ETA {live.extra.eta}</span>}
                                    </div>
                                </div>
                            )}
                            {live.extra?.rateOfTurn != null && Math.abs(live.extra.rateOfTurn) > 0 && (
                                <div className="flex items-center gap-2">
                                    <div>
                                        <div className="text-[10px] text-zinc-500 font-mono">RATE OF TURN</div>
                                        <div className="text-zinc-300 text-sm font-mono">{live.extra.rateOfTurn.toFixed(1)}°/min</div>
                                    </div>
                                    {Math.abs(live.extra.rateOfTurn) > 20 && (
                                        <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-orange-800/50 text-orange-300 border border-orange-600/40">HARD TURN</span>
                                    )}
                                </div>
                            )}
                            {(live.extra?.draught || live.extra?.vesselLength || live.extra?.beam) && (
                                <div className="grid grid-cols-3 gap-2">
                                    {live.extra.draught && (
                                        <div>
                                            <div className="text-[10px] text-zinc-500 font-mono">DRAUGHT</div>
                                            <div className="text-zinc-300 text-xs font-mono">{live.extra.draught}m</div>
                                        </div>
                                    )}
                                    {live.extra.vesselLength && (
                                        <div>
                                            <div className="text-[10px] text-zinc-500 font-mono">LENGTH</div>
                                            <div className="text-zinc-300 text-xs font-mono">{live.extra.vesselLength}m</div>
                                        </div>
                                    )}
                                    {live.extra.beam && (
                                        <div>
                                            <div className="text-[10px] text-zinc-500 font-mono">BEAM</div>
                                            <div className="text-zinc-300 text-xs font-mono">{live.extra.beam}m</div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* ---- Fire enrichment ---- */}
                    {live?.layer === 'Fire' && live.extra && (
                        <div className="flex items-center gap-2 flex-wrap">
                            {live.extra.daynight && (
                                <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                                    live.extra.daynight === 'D' ? 'bg-yellow-900/30 text-yellow-300 border-yellow-700/40' : 'bg-indigo-900/30 text-indigo-300 border-indigo-700/40'
                                }`}>{live.extra.daynight === 'D' ? 'DAY' : 'NIGHT'}</span>
                            )}
                            {live.extra.acqTime && (
                                <span className="text-[9px] font-mono text-zinc-400">{live.extra.acqTime.slice(0,2)}:{live.extra.acqTime.slice(2)} UTC</span>
                            )}
                            {fireTypeLabel(live.extra.fireType) && (
                                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-red-900/30 text-red-300 border border-red-700/40">
                                    {fireTypeLabel(live.extra.fireType)}
                                </span>
                            )}
                        </div>
                    )}

                    {/* ---- GFW enrichment ---- */}
                    {live?.layer === 'GFW' && live.extra && (
                        <div className="space-y-2">
                            {live.extra.confidence != null && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">CONFIDENCE</div>
                                    <div className="text-zinc-300 text-sm font-mono">{(live.extra.confidence * 100).toFixed(0)}%</div>
                                </div>
                            )}
                            {live.extra.duration != null && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">DURATION</div>
                                    <div className="text-zinc-300 text-sm font-mono">{fmtDuration(live.extra.duration)}</div>
                                </div>
                            )}
                            {live.extra.vesselOwner && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">OWNER</div>
                                    <div className="text-zinc-300 text-xs">{live.extra.vesselOwner}</div>
                                </div>
                            )}
                            {live.extra.vesselMmsi && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">MMSI</div>
                                    <div className="text-zinc-300 text-sm font-mono">{live.extra.vesselMmsi}</div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ---- Cable enrichment ---- */}
                    {live?.layer === 'Cable' && live.extra && (
                        <div className="space-y-2">
                            {live.extra.owners && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">OWNERS</div>
                                    <div className="text-zinc-300 text-xs">{live.extra.owners}</div>
                                </div>
                            )}
                            <div className="grid grid-cols-2 gap-2">
                                {live.extra.length && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 font-mono">LENGTH</div>
                                        <div className="text-zinc-300 text-xs font-mono">{live.extra.length} km</div>
                                    </div>
                                )}
                                {live.extra.year && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 font-mono">RFS YEAR</div>
                                        <div className="text-zinc-300 text-xs font-mono">{live.extra.year}</div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Satellite orbit info */}
                    {live?.layer === 'Satellite' && live.alt > 100000 && (
                        <div>
                            <div className="text-[10px] text-zinc-500 font-mono">ORBIT</div>
                            <div className="text-zinc-300 text-sm font-mono">
                                {live.alt > 30000000 ? 'GEO' : live.alt > 1000000 ? 'MEO' : 'LEO'} — {fmtAlt(live.alt)}
                            </div>
                        </div>
                    )}
                    {/* Satellite enrichment */}
                    {live?.layer === 'Satellite' && live.extra && (
                        <div className="space-y-2">
                            {live.extra.noradId && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">NORAD ID</div>
                                    <div className="text-zinc-300 text-sm font-mono">{live.extra.noradId}</div>
                                </div>
                            )}
                            {live.extra.resolution && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">RESOLUTION</div>
                                    <div className="text-zinc-300 text-sm font-mono">{live.extra.resolution}</div>
                                </div>
                            )}
                            {live.extra.country && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">COUNTRY</div>
                                    <div className="text-zinc-300 text-sm">{live.extra.country}</div>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="border-t border-zinc-800/60 pt-3">
                        <div className="text-[10px] text-zinc-500 font-mono mb-1">POSITION (WGS-84)</div>
                        {live ? (
                            <div className="font-mono text-xs leading-relaxed text-zinc-200">
                                <div>{fmtLat(live.lat)}</div>
                                <div>{fmtLng(live.lng)}</div>
                                <div className="text-zinc-400">alt {fmtAlt(live.alt)}</div>
                                {live.speed != null && live.speed > 0 && (
                                    <div className="text-zinc-400">speed {live.speed.toFixed(0)} {live.layer === 'Vessel' ? 'kn' : 'km/h'}</div>
                                )}
                                {live.heading != null && live.heading > 0 && (
                                    <div className="text-zinc-400">hdg {live.heading.toFixed(0)}°</div>
                                )}
                            </div>
                        ) : (
                            <div className="font-mono text-xs text-zinc-600">acquiring…</div>
                        )}
                    </div>

                    {live?.description && (
                        <div className="border-t border-zinc-800/60 pt-3">
                            <div className="text-[10px] text-zinc-500 font-mono mb-1">DESCRIPTION</div>
                            <div className="text-zinc-300 text-xs leading-snug">{live.description}</div>
                        </div>
                    )}

                    {selectedEntityData?.type === 'Webcam' && (
                        <div className="border-t border-zinc-800/60 pt-3">
                            <div className="text-[10px] text-zinc-500 font-mono mb-1">LIVE STREAM</div>
                            <WebcamPlayer
                                url={selectedEntityData.url}
                                imageUrl={selectedEntityData.imageUrl}
                                playerUrl={selectedEntityData.playerUrl}
                                source={selectedEntityData.source}
                            />
                        </div>
                    )}

                    {/*
                      Footprint annotation — only present when the user
                      clicked on the footprint overlay (fp- or beam-
                      entity) of a satellite. The parent sat's normal
                      card is shown above; this block adds the sensor
                      swath + a hard "PROJECTED" badge so the user
                      understands the shape on the ground is computed,
                      not a literal sensor readback.
                    */}
                    {selectedEntityData?.type === 'Satellite' && selectedEntityData?.footprint && (
                        <div className="border-t border-zinc-800/60 pt-3">
                            <div className="flex items-center justify-between mb-1">
                                <div className="text-[10px] text-zinc-500 font-mono">PROJECTED FOOTPRINT</div>
                                <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-700/60 bg-amber-900/30 text-amber-300">
                                    projected
                                </span>
                            </div>
                            <div className="font-mono text-xs leading-relaxed text-zinc-200">
                                <div>sensor <span className="text-zinc-400">{selectedEntityData.footprint.sensorName || '—'}</span></div>
                                <div>type <span className="text-zinc-400">{selectedEntityData.footprint.sensorType}</span></div>
                                <div>swath <span className="text-zinc-400">{(selectedEntityData.footprint.swathMeters / 1000).toFixed(1)} km</span></div>
                                <div className="text-[10px] text-zinc-500 mt-1">
                                    Shape is a predictive projection from sensor swath. Real footprint depends on pointing mode + orbit phase.
                                </div>
                                <div className="text-[10px] text-zinc-600">source · {selectedEntityData.footprint.source}</div>
                            </div>
                        </div>
                    )}

                    {/* ---- Conflict enrichment ---- */}
                    {live?.layer === 'Conflict' && live.extra && (
                        <div className="space-y-1 border-t border-zinc-800/60 pt-2">
                            {live.extra.event_type && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">EVENT</div>
                                    <div className="text-zinc-200 text-sm">{live.extra.event_type}{live.extra.sub_event_type ? ` — ${live.extra.sub_event_type}` : ''}</div>
                                </div>
                            )}
                            {(live.extra.actor1 || live.extra.actor2) && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">ACTORS</div>
                                    <div className="text-zinc-300 text-xs font-mono">
                                        {live.extra.actor1 || '?'} <span className="text-zinc-600">vs</span> {live.extra.actor2 || '?'}
                                    </div>
                                </div>
                            )}
                            {live.extra.fatalities > 0 && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">FATALITIES</div>
                                    <div className="text-red-400 text-sm font-bold">{live.extra.fatalities}</div>
                                </div>
                            )}
                            {live.extra.event_date && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">DATE</div>
                                    <div className="text-zinc-300 text-xs font-mono">{live.extra.event_date}</div>
                                </div>
                            )}
                            {live.extra.country && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">COUNTRY</div>
                                    <div className="text-zinc-300 text-xs">{live.extra.country}</div>
                                </div>
                            )}
                            {live.extra.notes && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">NOTES</div>
                                    <div className="text-zinc-400 text-[10px] leading-relaxed max-h-20 overflow-y-auto">{live.extra.notes}</div>
                                </div>
                            )}
                        </div>
                    )}

                    <button
                        onClick={flyTo}
                        disabled={!live}
                        className="w-full mt-2 flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-cyan-700/60 bg-cyan-900/20 text-cyan-300 text-xs font-mono uppercase tracking-wider hover:bg-cyan-800/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                        <Crosshair size={12} />
                        Fly to target
                    </button>

                    {/* Isolation buttons */}
                    {live && (
                        <IsolationButtons
                            layer={live.layer || ''}
                            subtype={live.subtype || ''}
                            entityName={selectedEntityData.name || selectedEntityId}
                            entityId={selectedEntityId}
                        />
                    )}
                </div>

                <div className="p-2 border-t border-zinc-800/50 bg-cyan-900/10 text-center">
                    <span className="text-xs font-mono text-cyan-500 animate-pulse">TRACKING SECURE</span>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// IsolationButtons — Solo / This Type / This Domain / Reset
// ---------------------------------------------------------------------------

// Map layer names to LayerFlags keys for building visibility overrides
const LAYER_TO_VISIBILITY_KEY: Record<string, string> = {
    Aircraft: 'aviation', Vessel: 'maritime', 'AIS Signal Lost': 'maritime',
    GFW: 'gfw', Satellite: 'satellites', Conflict: 'conflicts',
    Disaster: 'disasters', Fire: 'fires', Infrastructure: 'infrastructure',
    Cable: 'cables', Pipeline: 'pipelines', Outage: 'outages',
    Webcam: 'webcams', Airspace: 'airspace', Jamming: 'jamming',
};

// All known subtypes per visibility key — hardcoded so isolation works
// even before data arrives (subtypeCounts may be empty).
const ALL_SUBTYPES_FOR_LAYER: Record<string, string[]> = {
    aviation: ['airliner', 'military', 'light', 'general'],
    maritime: ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'unknown'],
    satellites: ['military', 'recon', 'commercial', 'civilian'],
    conflicts: ['explosions', 'battles', 'assaults', 'mass_violence', 'protests', 'threats', 'force_posture', 'coercion'],
    disasters: ['EQ', 'TC', 'FL', 'VO', 'WF', 'DR'],
    fires: ['high', 'medium', 'low'],
    infrastructure: ['power_plant', 'power_substation', 'power_line', 'refinery', 'dam', 'desalination', 'military', 'aerodrome', 'communication_tower'],
    pipelines: ['oil', 'gas'],
    outages: ['critical', 'warning'],
    jamming: ['high', 'medium', 'low'],
    airspace: ['restricted', 'danger', 'prohibited', 'alert', 'warning'],
};

const DOMAIN_TO_LAYERS: Record<string, string[]> = {
    Air: ['aviation', 'airspace', 'jamming'],
    Sea: ['maritime', 'gfw'],
    Space: ['satellites', 'satelliteFootprints'],
    Ground: ['conflicts', 'disasters', 'fires'],
    Infrastructure: ['infrastructure', 'pipelines', 'cables'],
    Connectivity: ['outages'],
    Context: ['traffic', 'webcams', 'labels', 'satellite_imagery', 'clouds'],
};

function IsolationButtons({ layer, subtype, entityName, entityId }: { layer: string; subtype: string; entityName: string; entityId: string }) {
    const activeFilter = useTimelineStore(s => s.activeFilter);
    const applyFilter = useTimelineStore(s => s.applyFilter);
    const clearFilter = useTimelineStore(s => s.clearFilter);
    const setIsolatedEntityId = useTimelineStore(s => s.setIsolatedEntityId);
    const visibility = useTimelineStore(s => s.visibility);

    const visKey = LAYER_TO_VISIBILITY_KEY[layer];
    const domain = LAYER_TO_DOMAIN[layer];
    if (!visKey) return null;

    const allOff = () => {
        const vis: any = {};
        for (const k of Object.keys(visibility)) vis[k] = false;
        vis.labels = true; // always keep borders
        return vis;
    };

    const handleSolo = () => {
        const vis = allOff();
        vis[visKey] = true;
        setIsolatedEntityId(entityId);
        if (!subtype) {
            applyFilter('solo', entityName, vis);
            return;
        }
        // Build subtype override: hide ALL known subtypes, then show only this one
        const sub: Record<string, boolean> = {};
        const knownSubs = ALL_SUBTYPES_FOR_LAYER[visKey] || [];
        for (const s of knownSubs) sub[`${visKey}:${s}`] = false;
        sub[`${visKey}:${subtype}`] = true;
        applyFilter('solo', entityName, vis, sub);
    };

    const handleThisType = () => {
        const vis = allOff();
        vis[visKey] = true;
        setIsolatedEntityId(null); // Clear solo — This Type shows all of this subtype
        if (!subtype) {
            applyFilter('thisType', layer, vis);
            return;
        }
        const sub: Record<string, boolean> = {};
        const knownSubs = ALL_SUBTYPES_FOR_LAYER[visKey] || [];
        for (const s of knownSubs) sub[`${visKey}:${s}`] = false;
        sub[`${visKey}:${subtype}`] = true;
        applyFilter('thisType', `${layer}: ${subtype}`, vis, sub);
    };

    const handleThisDomain = () => {
        if (!domain) return;
        const vis = allOff();
        const domainLayers = DOMAIN_TO_LAYERS[domain] || [];
        for (const l of domainLayers) vis[l] = true;
        setIsolatedEntityId(null); // Clear solo
        applyFilter('thisDomain', domain, vis);
    };

    return (
        <div className="flex flex-wrap gap-1 mt-2">
            <button
                onClick={handleSolo}
                className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono uppercase tracking-wider border border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:text-cyan-300 hover:border-cyan-700/50 transition-colors"
            >
                <Filter size={9} /> Solo
            </button>
            <button
                onClick={handleThisType}
                className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono uppercase tracking-wider border border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:text-cyan-300 hover:border-cyan-700/50 transition-colors"
            >
                This Type
            </button>
            {domain && (
                <button
                    onClick={handleThisDomain}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono uppercase tracking-wider border border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:text-cyan-300 hover:border-cyan-700/50 transition-colors"
                >
                    {domain}
                </button>
            )}
            {activeFilter && (
                <button
                    onClick={() => { setIsolatedEntityId(null); clearFilter(); }}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono uppercase tracking-wider border border-red-700/50 bg-red-900/20 text-red-400 hover:text-red-300 hover:border-red-600 transition-colors"
                >
                    <X size={9} /> Reset
                </button>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// WebcamPlayer — handles HLS streams, Windy previews, and webpage links
// ---------------------------------------------------------------------------

function WebcamPlayer({ url, imageUrl, playerUrl, source }: {
    url?: string;
    imageUrl?: string;
    playerUrl?: string;
    source?: string;
}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<Hls | null>(null);
    const [status, setStatus] = useState<'loading' | 'playing' | 'error'>('loading');

    const isHls = url?.includes('.m3u8');
    const hasEmbed = !!playerUrl && playerUrl !== imageUrl && playerUrl !== url;
    const isWebpage = url && !isHls && (url.includes('http') && !url.includes('.m3u8'));
    const isWindy = source?.toLowerCase().includes('windy');

    const attachHls = useCallback((videoEl: HTMLVideoElement | null) => {
        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }

        videoRef.current = videoEl;
        if (!videoEl || !isHls || !url) return;

        setStatus('loading');

        if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
            });
            hls.loadSource(url);
            hls.attachMedia(videoEl);
            hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus('playing'));
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (data.fatal) setStatus('error');
            });
            hlsRef.current = hls;
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            videoEl.src = url;
            videoEl.onplaying = () => setStatus('playing');
            videoEl.onerror = () => setStatus('error');
        } else {
            setStatus('error');
        }
    }, [url, isHls]);

    useEffect(() => {
        return () => {
            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
        };
    }, []);

    // Case 1: Real HLS stream
    if (isHls && url) {
        return (
            <div className="relative">
                {status === 'loading' && (
                    <div className="flex items-center gap-2 py-3">
                        <div className="w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                        <span className="text-[10px] text-zinc-400 font-mono">Connecting to stream...</span>
                    </div>
                )}
                {status === 'error' && (
                    <div className="text-[10px] text-zinc-500 font-mono py-2">
                        Stream offline or unavailable
                    </div>
                )}
                <video
                    ref={attachHls}
                    autoPlay
                    muted
                    playsInline
                    className={`w-full rounded-md border border-zinc-700 mt-1 ${status === 'loading' ? 'h-0 overflow-hidden' : ''}`}
                    style={{ maxHeight: 180 }}
                />
            </div>
        );
    }

    // Case 2: Embed player (Windy embed iframe, etc.)
    if (hasEmbed && playerUrl) {
        return (
            <div>
                <iframe
                    src={playerUrl}
                    className="w-full rounded-md border border-zinc-700 mt-1"
                    style={{ height: 180, border: 0 }}
                    allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                />
                <div className="text-[10px] text-zinc-500 font-mono mt-1">
                    {isWindy ? 'Windy embed (free tier — 10 min expiry)' : `Embed player${source ? ` (${source})` : ''}`}
                </div>
                <a
                    href={playerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block mt-1 text-[10px] text-cyan-400 font-mono hover:text-cyan-300"
                >
                    Open player ↗
                </a>
            </div>
        );
    }

    // Case 3: Windy preview image
    if (imageUrl) {
        return (
            <div>
                <img
                    src={imageUrl}
                    alt="Webcam preview"
                    className="w-full rounded-md border border-zinc-700 mt-1"
                    style={{ maxHeight: 180, objectFit: 'cover' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                <div className="text-[10px] text-zinc-500 font-mono mt-1">
                    {isWindy ? 'Preview image (Windy free tier)' : `Preview image${source ? ` (${source})` : ''}`}
                </div>
            </div>
        );
    }

    // Case 4: Webpage URL (skylinewebcams etc.)
    if (isWebpage && url) {
        return (
            <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-center py-2 px-3 rounded-md border border-cyan-700/40 bg-cyan-900/10 text-cyan-400 text-xs font-mono hover:bg-cyan-900/30 transition-colors"
            >
                Open live stream ↗
            </a>
        );
    }

    // Case 5: No stream available
    return (
        <div className="text-[10px] text-zinc-500 font-mono py-2">
            No stream available for this camera
        </div>
    );
}
