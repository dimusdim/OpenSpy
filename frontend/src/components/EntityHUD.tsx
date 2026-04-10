'use client';

import { useTimelineStore } from '../store/useTimelineStore';
import { useEffect, useState, useRef, useCallback } from 'react';
import * as Cesium from 'cesium';
import { Crosshair } from 'lucide-react';
import axios from 'axios';
import Hls from 'hls.js';
import { aircraftMetaMap } from '../cesium/useDynamicLayers';
import { webcamMetaMap } from '../cesium/useWebcamsLayer';
import { fireMetaMap } from '../cesium/useFiresLayer';

// HUD that locks onto whatever entity the user clicked. Continuously projects
// the entity's 3D world position to screen coords (for the dotted leader line)
// AND reads back the live geodetic position (lat/lng/alt) + the subtype that
// the layer hooks stashed in entity.properties when the entity was created.
export default function EntityHUD() {
    const { selectedEntityId, selectedEntityData } = useTimelineStore();
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
            try { return props?.[key]?.getValue?.() ?? props?.[key]; } catch { return undefined; }
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
                });
                requestAnimationFrame(update);
                return;
            }

            // Entity-based objects (satellites, maritime, osint, jamming, borders)
            const entity = findEntity();
            if (entity && entity.position) {
                const time = cesViewer.clock.currentTime;
                const pos = entity.position.getValue(time);
                if (pos) {
                    const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                    setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                    const carto = Cesium.Cartographic.fromCartesian(pos);
                    const props = entity.properties as any;
                    setLive({
                        lat: Cesium.Math.toDegrees(carto.latitude),
                        lng: Cesium.Math.toDegrees(carto.longitude),
                        alt: carto.height,
                        layer: readProp(props, 'layer'),
                        subtype: readProp(props, 'subtype'),
                        alertLevel: readProp(props, 'alertLevel'),
                        source: readProp(props, 'source'),
                        speed: readProp(props, 'speed'),
                        heading: readProp(props, 'heading'),
                        description: readProp(props, 'description'),
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

        const callsign = selectedEntityId;
        const meta = aircraftMetaMap.get(callsign);
        let cancelled = false;

        // Origin country from OpenSky data
        if (meta?.origin) {
            setAircraftInfo({ origin: meta.origin });
        }

        // Photo from Planespotters.net via backend proxy
        if (meta?.icao24) {
            axios.get(`http://localhost:3055/api/aircraft-photo/${meta.icao24}`)
                .then(res => {
                    if (cancelled) return;
                    const photo = res.data?.photos?.[0];
                    if (photo?.thumbnail_large?.src) {
                        setAircraftPhoto(photo.thumbnail_large.src);
                    }
                })
                .catch(() => {}); // Silently fail
        }

        // Fetch route via backend proxy (avoids CORS block from OpenSky)
        axios.get(`http://localhost:3055/api/routes/${encodeURIComponent(callsign.trim())}`)
            .then(res => {
                if (cancelled) return;
                if (res.data?.route?.length >= 2) {
                    setAircraftRoute({
                        origin: res.data.route[0],
                        destination: res.data.route[res.data.route.length - 1],
                    });
                }
            })
            .catch(() => {}); // Silently fail — rate limits, no route found, etc.

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
                className="absolute w-80 pointer-events-auto bg-black/85 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-[0_0_30px_rgba(0,0,0,0.8)]"
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
                            <div className="text-yellow-300 text-sm uppercase">{live?.subtype || '—'}</div>
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

                    {/* MMSI for vessels */}
                    {live?.layer === 'Vessel' && selectedEntityId && (
                        <div>
                            <div className="text-[10px] text-zinc-500 font-mono">MMSI</div>
                            <div className="text-zinc-300 text-sm font-mono">{selectedEntityId}</div>
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

                    {selectedEntityData?.type === 'Webcam' && selectedEntityData.url && (
                        <div className="border-t border-zinc-800/60 pt-3">
                            <div className="text-[10px] text-zinc-500 font-mono mb-1">LIVE STREAM</div>
                            <WebcamPlayer url={selectedEntityData.url} />
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
                </div>

                <div className="p-2 border-t border-zinc-800/50 bg-cyan-900/10 text-center">
                    <span className="text-xs font-mono text-cyan-500 animate-pulse">TRACKING SECURE</span>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// WebcamPlayer — embedded HLS video player using hls.js
// ---------------------------------------------------------------------------

function WebcamPlayer({ url }: { url: string }) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<Hls | null>(null);
    const [error, setError] = useState(false);

    const attachHls = useCallback((videoEl: HTMLVideoElement | null) => {
        // Cleanup previous instance
        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }

        videoRef.current = videoEl;
        if (!videoEl || !url) return;

        if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
            });
            hls.loadSource(url);
            hls.attachMedia(videoEl);
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (data.fatal) {
                    setError(true);
                }
            });
            hlsRef.current = hls;
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari native HLS support
            videoEl.src = url;
        } else {
            setError(true);
        }
    }, [url]);

    useEffect(() => {
        return () => {
            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
        };
    }, []);

    if (error) {
        return (
            <div className="text-[10px] text-zinc-500 font-mono py-2">
                Stream unavailable
            </div>
        );
    }

    return (
        <video
            ref={attachHls}
            autoPlay
            muted
            playsInline
            className="w-full rounded-md border border-zinc-700 mt-1"
            style={{ maxHeight: 180 }}
        />
    );
}
