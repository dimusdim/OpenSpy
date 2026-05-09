'use client';

import { useTimelineStore } from '../store/useTimelineStore';
import { useEffect, useState, useRef, useCallback } from 'react';
import * as Cesium from 'cesium';
import { Crosshair, Filter, X } from 'lucide-react';
import axios from 'axios';
import Hls from 'hls.js';
import { aircraftMetaMap, vesselMetaMap } from '../cesium/useDynamicLayers';
import { webcamMetaMap } from '../cesium/useWebcamsLayer';
import { API_URL } from '../lib/config';
import { fireMetaMap } from '../cesium/useFiresLayer';
import { cableMetaMap } from '../cesium/useCablesLayer';
import { pipelineMetaMap } from '../cesium/usePipelinesLayer';
import { airspaceMetaMap } from '../cesium/useAirspaceLayer';
import { infraMetaMap } from '../cesium/useInfrastructureLayer';
import { wifiMetaMap } from '../cesium/useWifiLayer';
import { satelliteMetaMap } from '../cesium/useSatellitesLayer';
import { replayMetaMap } from '../cesium/useReplayOverlay';
import { replayRenderBatchMetaMap } from '../cesium/replayRenderBatch';
import { conflictMetaMap } from '../cesium/useConflictsLayer';
import { gfwMetaMap } from '../cesium/useGFWLayer';

const LIVE_DETAILS_LAYER_BY_TYPE: Record<string, string> = {
    Aircraft: 'aircraft',
    Vessel: 'vessel',
    Satellite: 'satellite',
    Webcam: 'webcam',
    Cable: 'cable',
    Airspace: 'airspace',
    Pipeline: 'pipeline',
    Fire: 'fire',
    Disaster: 'disasters',
    Conflict: 'conflict',
    GFW: 'gfw',
    'AIS Signal Lost': 'gfw',
    Jamming: 'jamming',
    Outage: 'outage',
    'Wi-Fi Network': 'wifi',
};

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

function formatOrbitConfidence(value: unknown): string {
    if (value === 'nominal') return 'FRESH';
    if (value === 'degraded') return 'DEGRADED';
    if (value === 'unknown') return 'UNKNOWN';
    return String(value || 'UNKNOWN').toUpperCase();
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
    Outage: 'Connectivity', 'Wi-Fi Network': 'Connectivity', Webcam: 'Context', Airspace: 'Air', Jamming: 'Air',
};

// HUD that locks onto whatever entity the user clicked. Continuously projects
// the entity's 3D world position to screen coords (for the dotted leader line)
// AND reads back the live geodetic position (lat/lng/alt) + the subtype that
// the layer hooks stashed in entity.properties when the entity was created.
type EntityHUDProps = {
    avoidRightPx?: number;
};

export default function EntityHUD({ avoidRightPx = 0 }: EntityHUDProps) {
    // Individual selectors — whole-store subscription re-renders this
    // component on every store write (streamMetrics, currentTime, etc.),
    // including the 60 Hz rAF loop below calling setScreenPos/setLive.
    // Per-field selectors keep re-renders bound to what EntityHUD reads.
    const selectedEntityId = useTimelineStore(s => s.selectedEntityId);
    const selectedEntityData = useTimelineStore(s => s.selectedEntityData);
    const mode = useTimelineStore(s => s.mode);
    const [screenPos, setScreenPos] = useState<{ x: number, y: number } | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [measuredPanelHeightPx, setMeasuredPanelHeightPx] = useState(0);
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
    const [liveDetails, setLiveDetails] = useState<Record<string, any> | null>(null);

    useEffect(() => {
        setLiveDetails(null);
        if (mode !== 'live' || !selectedEntityId || !selectedEntityData?.type) return;
        if ((selectedEntityData as any).skipLiveDetails) return;
        const layer = LIVE_DETAILS_LAYER_BY_TYPE[selectedEntityData.type] || null;
        if (!layer) return;
        let cancelled = false;
        axios.get(`${API_URL}/api/live/details/${encodeURIComponent(layer)}/${encodeURIComponent(selectedEntityId)}`)
            .then((res) => {
                if (cancelled) return;
                const rawDetails = res.data || null;
                if (rawDetails?.layerId && rawDetails.layerId !== layer) {
                    throw new Error(`live details layer mismatch: requested ${layer}, received ${rawDetails.layerId}`);
                }
                const details = rawDetails ? { ...rawDetails, layerId: rawDetails.layerId || layer } : null;
                setLiveDetails(details);
                if (layer === 'aircraft') {
                    const meta = aircraftMetaMap.get(selectedEntityId);
                    if (meta) Object.assign(meta, details);
                } else if (layer === 'vessel') {
                    const meta = vesselMetaMap.get(selectedEntityId);
                    if (meta) Object.assign(meta, {
                        ...details,
                        vesselLength: details?.length,
                    });
                } else if (layer === 'satellite') {
                    const meta = satelliteMetaMap.get(selectedEntityId);
                    if (meta) Object.assign(meta, details);
                }
                const state = useTimelineStore.getState();
                if (state.selectedEntityId === selectedEntityId && details?.name) {
                    state.setSelectedEntityId(selectedEntityId, {
                        ...(state.selectedEntityData || {}),
                        name: details.name,
                        id: selectedEntityId,
                        type: selectedEntityData.type,
                    });
                }
            })
            .catch((err) => {
                if (!cancelled) console.warn('[EntityHUD] live details fetch failed:', err.message);
            });
        return () => { cancelled = true; };
    }, [mode, selectedEntityId, selectedEntityData?.type]);

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
            const replayMeta = replayMetaMap.get(selectedEntityId);
            if (replayMeta) {
                const pos = Cesium.Cartesian3.fromDegrees(replayMeta.lng, replayMeta.lat, replayMeta.alt || 0);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: replayMeta.lat,
                    lng: replayMeta.lng,
                    alt: replayMeta.alt,
                    layer: replayMeta.layer,
                    subtype: replayMeta.subtype ?? undefined,
                    source: replayMeta.source || undefined,
                    speed: replayMeta.speed ?? undefined,
                    heading: replayMeta.heading ?? undefined,
                    description: replayMeta.description,
                    extra: replayMeta.extra,
                });
                requestAnimationFrame(update);
                return;
            }

            const replayBatchMeta = replayRenderBatchMetaMap.get(selectedEntityId);
            if (replayBatchMeta) {
                const pos = Cesium.Cartesian3.fromDegrees(replayBatchMeta.lng, replayBatchMeta.lat, replayBatchMeta.alt || 0);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: replayBatchMeta.lat,
                    lng: replayBatchMeta.lng,
                    alt: replayBatchMeta.alt,
                    layer: replayBatchMeta.layer,
                    subtype: replayBatchMeta.subtype ?? undefined,
                    source: replayBatchMeta.source || undefined,
                    speed: replayBatchMeta.speed ?? undefined,
                    heading: replayBatchMeta.heading ?? undefined,
                    description: replayBatchMeta.description,
                    extra: replayBatchMeta.extra,
                });
                requestAnimationFrame(update);
                return;
            }

            // Webcam billboard — read from metadata map.
            const wcMeta = webcamMetaMap.get(selectedEntityId);
            if (wcMeta) {
                const details = liveDetails?.layerId === 'webcam' ? liveDetails : null;
                const pos = Cesium.Cartesian3.fromDegrees(wcMeta.lng, wcMeta.lat, 0);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: wcMeta.lat,
                    lng: wcMeta.lng,
                    alt: 0,
                    layer: 'Webcam',
                    source: wcMeta.source,
                    extra: details ? {
                        url: details.url,
                        imageUrl: details.imageUrl,
                        playerUrl: details.playerUrl,
                        country: details.country,
                        quality: details.quality,
                    } : undefined,
                });
                requestAnimationFrame(update);
                return;
            }

            // Fire point — read from fireMetaMap
            const fireMeta = fireMetaMap.get(selectedEntityId);
            if (fireMeta) {
                const details = liveDetails?.layerId === 'fire' ? liveDetails : null;
                const detailProps = details?.properties || {};
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
                    description: details
                        ? `FRP: ${fireMeta.frp.toFixed(1)} MW | Brightness: ${Number(detailProps.brightness || 0).toFixed(0)} K | Confidence: ${detailProps.confidence || 'unknown'}`
                        : `FRP: ${fireMeta.frp.toFixed(1)} MW`,
                    extra: {
                        daynight: detailProps.daynight,
                        acqTime: detailProps.acqTime,
                        fireType: detailProps.fireType,
                        acqDate: detailProps.acqDate,
                        aggregated: fireMeta.aggregated,
                        count: fireMeta.count,
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
                const details = liveDetails?.layerId === 'cable' ? liveDetails : null;
                const props = details?.properties || {};
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
                        owners: props.owners || props.owner || '',
                        length: props.length || props.cable_length || '',
                        year: props.rfs || props.year || '',
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            // Oil/gas pipeline (batched Primitive). Same rationale as cables —
            // not in entities, HUD reads straight from metaMap.
            const pipelineMeta = pipelineMetaMap.get(selectedEntityId);
            if (pipelineMeta) {
                const details = liveDetails?.layerId === 'pipeline' ? liveDetails : null;
                const props = details?.properties || {};
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
                    description: details?.name || pipelineMeta.description,
                    extra: {
                        operator: props.operator || props.pipeline_operator || '',
                        substance: props.substance || pipelineMeta.substance,
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            // Airspace zone (dual Primitive fill+outline). HUD shows type,
            // vertical limits and source in the description row below.
            const airspaceMeta = airspaceMetaMap.get(selectedEntityId);
            if (airspaceMeta) {
                const details = liveDetails?.layerId === 'airspace' ? liveDetails : null;
                const props = details?.properties || {};
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
                    description: `${details?.name || airspaceMeta.name} — ${props.lowerLimit ?? airspaceMeta.lowerLimit}→${props.upperLimit ?? airspaceMeta.upperLimit}m`,
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

            const wifiMeta = wifiMetaMap.get(selectedEntityId);
            if (wifiMeta) {
                const details = liveDetails?.layerId === 'wifi' ? liveDetails : null;
                const pos = Cesium.Cartesian3.fromDegrees(wifiMeta.lng, wifiMeta.lat, 8);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: wifiMeta.lat,
                    lng: wifiMeta.lng,
                    alt: 0,
                    layer: wifiMeta.layer,
                    subtype: wifiMeta.security,
                    source: wifiMeta.source,
                    description: details?.name || wifiMeta.description,
                    extra: details ? {
                        ssid: details.ssid,
                        bssidMasked: details.bssidMasked,
                        encryption: details.encryption,
                        channel: details.channel,
                        firstSeen: details.firstSeen,
                        lastSeen: details.lastSeen,
                        providerUpdatedAt: details.providerUpdatedAt,
                        quality: details.quality,
                    } : undefined,
                });
                requestAnimationFrame(update);
                return;
            }

            // Aircraft are now BillboardCollection, not Entity. Read from metadata map.
            const acMeta = aircraftMetaMap.get(selectedEntityId);
            if (acMeta) {
                const details = liveDetails?.layerId === 'aircraft' ? liveDetails : null;
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
                        count: acMeta.aggregated ? acMeta.count : undefined,
                        aggregated: acMeta.aggregated || undefined,
                        squawk: details?.squawk ?? acMeta.squawk,
                        verticalRate: details?.verticalRate ?? acMeta.verticalRate,
                        onGround: details?.onGround ?? acMeta.onGround,
                        lastContact: details?.lastContact ?? acMeta.lastContact,
                        callsign: details?.callsign ?? acMeta.callsign,
                        icao24: details?.icao24 ?? acMeta.icao24,
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            // Live vessel billboard — read from metadata map.
            const vesselMeta = vesselMetaMap.get(selectedEntityId);
            if (vesselMeta) {
                const details = liveDetails?.layerId === 'vessel' ? liveDetails : null;
                const pos = Cesium.Cartesian3.fromDegrees(vesselMeta.lng, vesselMeta.lat, 0);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: vesselMeta.lat,
                    lng: vesselMeta.lng,
                    alt: 0,
                    layer: 'Vessel',
                    subtype: vesselMeta.type,
                    speed: vesselMeta.speed,
                    heading: vesselMeta.heading,
                    extra: {
                        count: vesselMeta.aggregated ? vesselMeta.count : undefined,
                        aggregated: vesselMeta.aggregated || undefined,
                        vesselName: details?.name ?? vesselMeta.name,
                        callSign: details?.callSign ?? vesselMeta.callSign,
                        imo: details?.imo ?? vesselMeta.imo,
                        navigationStatus: details?.navigationStatus ?? vesselMeta.navigationStatus,
                        destination: details?.destination ?? vesselMeta.destination,
                        eta: details?.eta ?? vesselMeta.eta,
                        rateOfTurn: details?.rateOfTurn ?? vesselMeta.rateOfTurn,
                        draught: details?.draught ?? vesselMeta.draught,
                        vesselLength: details?.length ?? vesselMeta.vesselLength,
                        beam: details?.beam ?? vesselMeta.beam,
                        cog: details?.cog ?? vesselMeta.cog,
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            // Satellite billboard — current live Cartesian position is updated
            // in satelliteMetaMap from the worker positions stream.
            const satMeta = satelliteMetaMap.get(selectedEntityId);
            if (satMeta?.position) {
                const details = liveDetails?.layerId === 'satellite' ? liveDetails : null;
                const pos = satMeta.position;
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                const carto = Cesium.Cartographic.fromCartesian(pos);
                if (!carto) {
                    requestAnimationFrame(update);
                    return;
                }
                const lat = Cesium.Math.toDegrees(carto.latitude);
                const lng = Cesium.Math.toDegrees(carto.longitude);
                const alt = carto.height;
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat,
                    lng,
                    alt,
                    layer: 'Satellite',
                    subtype: satMeta.subtype,
                    extra: {
                        noradId: details?.noradId ?? satMeta.noradId,
                        resolution: details?.reconMeta?.resolution ?? satMeta.reconMeta?.resolution,
                        country: details?.reconMeta?.country ?? satMeta.reconMeta?.country,
                        tleEpochAt: details?.tleEpochAt ?? satMeta.tleEpochAt,
                        fetchedAt: details?.fetchedAt ?? satMeta.fetchedAt,
                        provider: details?.provider ?? satMeta.provider,
                        motionConfidence: details?.motionConfidence ?? satMeta.motionConfidence,
                        motionAgeSec: details?.motionAgeSec ?? satMeta.motionAgeSec,
                        motionValiditySec: details?.motionValiditySec ?? satMeta.motionValiditySec,
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            const conflictMeta = conflictMetaMap.get(selectedEntityId);
            if (conflictMeta) {
                const details = liveDetails?.layerId === 'conflict' ? liveDetails : null;
                const eventDetails = details?.properties || {};
                const pos = Cesium.Cartesian3.fromDegrees(conflictMeta.lng, conflictMeta.lat, 50);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: conflictMeta.lat,
                    lng: conflictMeta.lng,
                    alt: 50,
                    layer: 'Conflict',
                    subtype: conflictMeta.subtype,
                    source: conflictMeta.source,
                    description: details?.name || conflictMeta.eventType,
                    extra: {
                        count: conflictMeta.aggregated ? conflictMeta.count : undefined,
                        aggregated: conflictMeta.aggregated || undefined,
                        event_type: eventDetails.eventType ?? conflictMeta.eventType,
                        sub_event_type: eventDetails.subEventType ?? conflictMeta.subEventType,
                        fatalities: eventDetails.fatalities ?? conflictMeta.fatalities,
                        country: eventDetails.country,
                        actor1: eventDetails.actor1,
                        actor2: eventDetails.actor2,
                        event_date: details?.observedAt?.slice?.(0, 10),
                        notes: eventDetails.notes ?? eventDetails.sourceUrl,
                    },
                });
                requestAnimationFrame(update);
                return;
            }

            const gfwMeta = gfwMetaMap.get(selectedEntityId);
            if (gfwMeta) {
                const details = liveDetails?.layerId === 'gfw' ? liveDetails : null;
                const eventDetails = details?.properties || {};
                const pos = Cesium.Cartesian3.fromDegrees(gfwMeta.lng, gfwMeta.lat, 0);
                const canvasPos = Cesium.SceneTransforms.worldToWindowCoordinates(cesViewer.scene, pos);
                setScreenPos(canvasPos ? { x: canvasPos.x, y: canvasPos.y } : null);
                setLive({
                    lat: gfwMeta.lat,
                    lng: gfwMeta.lng,
                    alt: 0,
                    layer: 'GFW',
                    subtype: gfwMeta.subtype,
                    source: gfwMeta.source,
                    description: 'AIS signal gap',
                    extra: {
                        confidence: eventDetails.confidence,
                        duration: eventDetails.duration,
                        vesselOwner: eventDetails.vesselOwner,
                        vesselMmsi: eventDetails.vesselMmsi,
                        vesselType: eventDetails.vesselType,
                        vesselName: eventDetails.vesselName,
                        flagState: eventDetails.flagState,
                        start: details?.observedAt ?? gfwMeta.start,
                        end: eventDetails.end ?? gfwMeta.end,
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
                    const eventDetails = liveDetails?.properties || {};
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
                        extra.confidence = eventDetails.confidence ?? readProp(props, 'confidence');
                        extra.duration = eventDetails.duration ?? readProp(props, 'duration');
                        extra.vesselOwner = eventDetails.vesselOwner ?? readProp(props, 'vesselOwner');
                        extra.vesselMmsi = eventDetails.vesselMmsi ?? readProp(props, 'vesselMmsi');
                        extra.vesselType = eventDetails.vesselType ?? readProp(props, 'vesselType');
                        extra.vesselName = eventDetails.vesselName ?? readProp(props, 'vesselName');
                        extra.flagState = eventDetails.flagState ?? readProp(props, 'flagState');
                        extra.start = liveDetails?.observedAt ?? readProp(props, 'start');
                        extra.end = eventDetails.end ?? readProp(props, 'end');
                    } else if (layer === 'Satellite') {
                        extra.noradId = readProp(props, 'noradId');
                        extra.resolution = readProp(props, 'resolution');
                        extra.country = readProp(props, 'country');
                        extra.motionConfidence = readProp(props, 'motionConfidence');
                        extra.motionAgeSec = readProp(props, 'motionAgeSec');
                        extra.motionValiditySec = readProp(props, 'motionValiditySec');
                    } else if (layer === 'Conflict') {
                        extra.event_type = eventDetails.eventType ?? readProp(props, 'event_type');
                        extra.sub_event_type = eventDetails.subEventType ?? readProp(props, 'sub_event_type');
                        extra.fatalities = eventDetails.fatalities ?? readProp(props, 'fatalities');
                        extra.country = eventDetails.country ?? readProp(props, 'country');
                        extra.actor1 = eventDetails.actor1 ?? readProp(props, 'actor1');
                        extra.actor2 = eventDetails.actor2 ?? readProp(props, 'actor2');
                        extra.event_date = liveDetails?.observedAt?.slice?.(0, 10) ?? readProp(props, 'event_date');
                        extra.notes = eventDetails.notes ?? eventDetails.sourceUrl ?? readProp(props, 'notes');
                    } else if (layer === 'Jamming') {
                        extra.countGood = eventDetails.countGood;
                        extra.countBad = eventDetails.countBad;
                        extra.ratio = eventDetails.ratio;
                        extra.h3Index = eventDetails.h3Index;
                    } else if (layer === 'Disaster') {
                        extra.eventType = eventDetails.eventType ?? readProp(props, 'subtype');
                        extra.alertLevel = eventDetails.alertLevel ?? readProp(props, 'alertLevel');
                        extra.radiusKm = eventDetails.radiusKm;
                        extra.startTime = liveDetails?.observedAt ?? eventDetails.startTime;
                        extra.endTime = eventDetails.endTime;
                    } else if (layer === 'Outage') {
                        extra.country = eventDetails.country ?? readProp(props, 'country');
                        extra.countryCode = eventDetails.countryCode ?? readProp(props, 'countryCode');
                        extra.datasource = eventDetails.datasource ?? readProp(props, 'datasource');
                        extra.startTime = liveDetails?.observedAt ?? eventDetails.startTime ?? eventDetails.startDate;
                        extra.endTime = eventDetails.endDate ?? liveDetails?.validTo;
                        extra.asn = eventDetails.asn;
                        extra.asnName = eventDetails.asnName;
                        extra.outageType = eventDetails.outageType;
                        extra.outageCause = eventDetails.outageCause;
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
                        description: liveDetails?.name && ['Disaster', 'Outage'].includes(layer)
                            ? liveDetails.name
                            : readProp(props, 'description'),
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
    }, [selectedEntityId, liveDetails]);

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
        const details = liveDetails?.layerId === 'aircraft' ? liveDetails : null;
        let cancelled = false;

        // Origin country from OpenSky data
        const origin = details?.origin || meta?.origin;
        if (origin) {
            setAircraftInfo({ origin });
        }

        // Photo from Planespotters.net via backend proxy (uses icao24)
        const icao24 = details?.icao24 || meta?.icao24;
        if (icao24) {
            axios.get(`${API_URL}/api/aircraft-photo/${icao24}`)
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
        const callsign = String(details?.callsign || meta?.callsign || '').trim();
        if (callsign && callsign !== icao24) {
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
    }, [selectedEntityId, selectedEntityData, liveDetails]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const node = panelRef.current;
        if (!node) return;
        const measure = () => {
            const rect = node.getBoundingClientRect();
            if (Number.isFinite(rect.height) && rect.height > 0) {
                setMeasuredPanelHeightPx(Math.ceil(rect.height));
            }
        };
        measure();
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        observer?.observe(node);
        window.addEventListener('resize', measure);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [selectedEntityId, selectedEntityData]);

    if (!selectedEntityId || !selectedEntityData) return null;

    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const reservedRightPx = Math.max(0, avoidRightPx);
    const sideAvailableWidth = viewportWidth - reservedRightPx - 32;
    const panelWidth = Math.max(
        248,
        Math.min(320, sideAvailableWidth >= 280 ? sideAvailableWidth : viewportWidth - 32)
    );
    const panelMaxHeightPx = typeof window !== 'undefined' ? Math.round(window.innerHeight * 0.8) : 640;
    const estimatedPanelHeightPx = typeof window !== 'undefined'
        ? Math.min(panelMaxHeightPx, live?.layer === 'aircraft' ? 560 : 460)
        : 460;
    const layoutPanelHeightPx = measuredPanelHeightPx > 0
        ? Math.min(panelMaxHeightPx, measuredPanelHeightPx)
        : estimatedPanelHeightPx;
    const panelPlacement = (() => {
        if (typeof window === 'undefined') {
            return { x: 1000, y: 100, anchorX: 990, anchorY: 140 };
        }
        const margin = 16;
        const gap = 32;
        const legendSafeRight = window.innerWidth >= 900 ? 352 : margin;
        const usableRight = Math.max(margin + panelWidth, window.innerWidth - reservedRightPx - margin);
        const fallbackX = Math.max(legendSafeRight, usableRight - panelWidth);
        const fallbackY = 100;
        if (!screenPos) {
            return { x: fallbackX, y: fallbackY, anchorX: fallbackX - 10, anchorY: fallbackY + 40 };
        }

        const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
        const relaxedMinX = margin;
        const relaxedMaxX = Math.max(relaxedMinX, usableRight - panelWidth);
        const minX = reservedRightPx > 0
            ? relaxedMinX
            : relaxedMaxX >= legendSafeRight ? legendSafeRight : relaxedMinX;
        const maxX = Math.max(minX, usableRight - panelWidth);
        const minY = 76;
        const maxY = Math.max(minY, window.innerHeight - layoutPanelHeightPx - margin);
        const targetPadding = 18;
        const targetSafeTop = screenPos.y - targetPadding;
        const targetSafeBottom = screenPos.y + targetPadding;
        const targetSafeLeft = screenPos.x - targetPadding;
        const targetSafeRight = screenPos.x + targetPadding;
        const clampedPanelHeight = Math.min(layoutPanelHeightPx, window.innerHeight - minY - margin);
        const scoreCandidate = (rawX: number, rawY: number, priority: number) => {
            const x = clamp(rawX, minX, maxX);
            const y = clamp(rawY, minY, maxY);
            const horizontallyOverlaps = targetSafeRight >= x && targetSafeLeft <= x + panelWidth;
            const verticallyOverlaps = targetSafeBottom >= y && targetSafeTop <= y + clampedPanelHeight;
            const coversTarget = horizontallyOverlaps && verticallyOverlaps;
            const dx = screenPos.x < x ? x - screenPos.x : screenPos.x > x + panelWidth ? screenPos.x - (x + panelWidth) : 0;
            const dy = screenPos.y < y ? y - screenPos.y : screenPos.y > y + clampedPanelHeight ? screenPos.y - (y + clampedPanelHeight) : 0;
            return {
                x,
                y,
                score: (coversTarget ? 1_000_000 : 0) + priority * 10_000 + Math.hypot(dx, dy) * 0.25,
            };
        };

        const rightX = screenPos.x + gap;
        const leftX = screenPos.x - panelWidth - gap;
        const aboveY = screenPos.y - layoutPanelHeightPx - gap;
        const belowY = screenPos.y + gap;
        const sideY = screenPos.y - 110;
        const centeredX = screenPos.x - panelWidth / 2;
        const preferLeft = reservedRightPx > 0 || screenPos.x > window.innerWidth * 0.56;
        const candidates = preferLeft
            ? [
                scoreCandidate(leftX, sideY, 0),
                scoreCandidate(rightX, sideY, 1),
                scoreCandidate(centeredX, belowY, 2),
                scoreCandidate(centeredX, aboveY, 3),
                scoreCandidate(fallbackX, fallbackY, 4),
            ]
            : [
                scoreCandidate(rightX, sideY, 0),
                scoreCandidate(leftX, sideY, 1),
                scoreCandidate(centeredX, belowY, 2),
                scoreCandidate(centeredX, aboveY, 3),
                scoreCandidate(fallbackX, fallbackY, 4),
            ];
        const best = candidates.sort((a, b) => a.score - b.score)[0];
        const x = best.x;
        const y = best.y;
        const panelIsLeftOfTarget = x + panelWidth <= screenPos.x;
        const panelIsRightOfTarget = x >= screenPos.x;
        const panelIsAboveTarget = y + clampedPanelHeight <= screenPos.y;
        const anchorClampX = clamp(screenPos.x, x + 18, x + panelWidth - 18);
        const anchorClampY = clamp(screenPos.y, y + 18, y + clampedPanelHeight - 18);
        return {
            x,
            y,
            anchorX: panelIsLeftOfTarget ? x + panelWidth + 10 : panelIsRightOfTarget ? x - 10 : anchorClampX,
            anchorY: panelIsLeftOfTarget || panelIsRightOfTarget
                ? anchorClampY
                : panelIsAboveTarget
                    ? y + clampedPanelHeight + 10
                    : y - 10,
        };
    })();

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
                        x2={panelPlacement.anchorX} y2={panelPlacement.anchorY}
                        stroke="#06b6d4" strokeWidth="1" strokeDasharray="4 4"
                    />
                    <circle
                        data-entity-hud-target="true"
                        cx={screenPos.x}
                        cy={screenPos.y}
                        r="6"
                        fill="transparent"
                        stroke="#06b6d4"
                        strokeWidth="2"
                        strokeDasharray="3 3"
                        className="animate-spin"
                        style={{ animationDuration: '3s' }}
                    />
                </svg>
            )}

            <div
                ref={panelRef}
                data-entity-hud-panel="true"
                data-entity-id={selectedEntityId}
                className="absolute max-h-[80vh] overflow-y-auto pointer-events-auto bg-black/85 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-[0_0_30px_rgba(0,0,0,0.8)]"
                style={{
                    top: panelPlacement.y,
                    left: panelPlacement.x,
                    width: panelWidth,
                    maxHeight: typeof window !== 'undefined'
                        ? Math.max(220, Math.min(panelMaxHeightPx, window.innerHeight - panelPlacement.y - 16))
                        : panelMaxHeightPx,
                }}
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

                    {/* ---- Wi-Fi enrichment ---- */}
                    {live?.layer === 'Wi-Fi Network' && live.extra && (
                        <div className="space-y-2">
                            {live.extra.ssid && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 font-mono">SSID</div>
                                    <div className="text-zinc-300 text-sm">{live.extra.ssid}</div>
                                </div>
                            )}
                            <div className="grid grid-cols-2 gap-2">
                                {live.extra.encryption && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 font-mono">ENCRYPTION</div>
                                        <div className="text-zinc-300 text-xs font-mono">{live.extra.encryption}</div>
                                    </div>
                                )}
                                {live.extra.channel != null && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 font-mono">CHANNEL</div>
                                        <div className="text-zinc-300 text-xs font-mono">{live.extra.channel}</div>
                                    </div>
                                )}
                                {live.extra.bssidMasked && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 font-mono">BSSID</div>
                                        <div className="text-zinc-300 text-xs font-mono">{live.extra.bssidMasked}</div>
                                    </div>
                                )}
                                {live.extra.lastSeen && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 font-mono">LAST SEEN</div>
                                        <div className="text-zinc-300 text-xs font-mono">{String(live.extra.lastSeen).slice(0, 10)}</div>
                                    </div>
                                )}
                            </div>
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
	                            {live.extra.motionConfidence && (
	                                <div>
	                                    <div className="text-[10px] text-zinc-500 font-mono">ORBIT MODEL</div>
	                                    <div className={`text-sm font-mono ${
	                                        live.extra.motionConfidence === 'degraded' ? 'text-amber-300' : 'text-zinc-300'
	                                    }`}>
	                                        {formatOrbitConfidence(live.extra.motionConfidence)}
	                                    </div>
	                                </div>
	                            )}
	                            {live.extra.motionAgeSec != null && (
	                                <div>
	                                    <div className="text-[10px] text-zinc-500 font-mono">TLE AGE</div>
	                                    <div className="text-zinc-300 text-sm font-mono">{fmtDuration(Number(live.extra.motionAgeSec))}</div>
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

                    {selectedEntityData?.type === 'Webcam' && (live?.extra?.url || live?.extra?.imageUrl || live?.extra?.playerUrl) && (
                        <div className="border-t border-zinc-800/60 pt-3">
                            <div className="text-[10px] text-zinc-500 font-mono mb-1">LIVE STREAM</div>
                            <WebcamPlayer
                                url={live.extra.url}
                                imageUrl={live.extra.imageUrl}
                                playerUrl={live.extra.playerUrl}
                                source={live.source}
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
    pipelines: ['oil', 'gas', 'water', 'other'],
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
