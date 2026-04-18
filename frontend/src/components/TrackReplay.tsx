'use client';

import { useState } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { Plane, Loader2, X } from 'lucide-react';
import { API_URL } from '../lib/config';
import { useTimelineStore } from '../store/useTimelineStore';

/**
 * TrackReplay — small HUD panel that loads a historical flight track from
 * OpenSky Network by ICAO24 hex code, renders it as a yellow polyline with
 * a moving billboard on the Cesium viewer, and sets the clock to replay.
 */
export default function TrackReplay() {
    const [icao24, setIcao24] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTrack, setActiveTrack] = useState<string | null>(null);

    const handleLoad = async (e: React.FormEvent) => {
        e.preventDefault();
        const hex = icao24.trim().toLowerCase();
        if (!hex) return;

        if (!/^[0-9a-f]{6}$/.test(hex)) {
            setError('Enter a valid 6-character ICAO24 hex code');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const res = await axios.get(`${API_URL}/api/track/${hex}`);
            const data = res.data;

            if (!data.path || data.path.length === 0) {
                setError('Track returned but contains no waypoints.');
                setLoading(false);
                return;
            }

            const viewer = (window as any).viewerContext as Cesium.Viewer | undefined;
            if (!viewer || viewer.isDestroyed()) {
                setError('Globe viewer not ready');
                setLoading(false);
                return;
            }

            // Remove previous track if any
            const existingDs = viewer.dataSources.getByName('track-replay');
            for (let i = 0; i < existingDs.length; i++) {
                viewer.dataSources.remove(existingDs[i], true);
            }

            const ds = new Cesium.CustomDataSource('track-replay');
            viewer.dataSources.add(ds);

            // Build SampledPositionProperty from waypoints
            // path: [[time, lat, lng, baro_altitude, true_track, on_ground], ...]
            const positionProperty = new Cesium.SampledPositionProperty();
            positionProperty.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
            positionProperty.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;

            const cartesianPositions: Cesium.Cartesian3[] = [];

            for (const wp of data.path) {
                const [time, lat, lng, altitude, , onGround] = wp;
                if (lat == null || lng == null) continue;

                // altitude is barometric in meters; default to 1000m if null/on ground
                const alt = (altitude != null && !onGround) ? altitude : 1000;
                const julianTime = Cesium.JulianDate.fromDate(new Date(time * 1000));
                const position = Cesium.Cartesian3.fromDegrees(lng, lat, alt);

                positionProperty.addSample(julianTime, position);
                cartesianPositions.push(position);
            }

            if (cartesianPositions.length === 0) {
                setError('No valid waypoints in the track.');
                setLoading(false);
                return;
            }

            // Yellow aircraft billboard SVG
            const billboardSvg = `data:image/svg+xml,` + encodeURIComponent(
                `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" stroke="black" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">` +
                `<path d="M12 2 L10 11 L2 14 L2 16 L10 14 L10 20 L7 22 L7 23 L12 22 L17 23 L17 22 L14 20 L14 14 L22 16 L22 14 L14 11 Z" fill="#facc15"/>` +
                `</svg>`
            );

            // Add the moving entity
            ds.entities.add({
                id: `track-${hex}`,
                name: `Track: ${data.callsign?.trim() || hex.toUpperCase()}`,
                position: positionProperty,
                billboard: {
                    image: billboardSvg,
                    scale: 0.9,
                    verticalOrigin: Cesium.VerticalOrigin.CENTER,
                    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                },
                label: {
                    text: data.callsign?.trim() || hex.toUpperCase(),
                    font: 'bold 11px monospace',
                    fillColor: Cesium.Color.YELLOW,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    outlineWidth: 2,
                    outlineColor: Cesium.Color.BLACK,
                    pixelOffset: new Cesium.Cartesian2(0, -22),
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                },
                path: {
                    material: new Cesium.ColorMaterialProperty(Cesium.Color.YELLOW.withAlpha(0.8)),
                    width: 2,
                    leadTime: 0,
                    trailTime: 86400,
                },
                polyline: {
                    positions: cartesianPositions,
                    material: Cesium.Color.YELLOW.withAlpha(0.4),
                    width: 1,
                    clampToGround: false,
                },
            });

            // Switch store to playback mode — otherwise Globe.onTick
            // will force currentTime = now and break the replay
            const store = useTimelineStore.getState();
            store.setMode('playback');
            store.setPlaybackKind('track');

            // Set clock to the track's time range for scrubbing
            const startTime = Cesium.JulianDate.fromDate(new Date(data.startTime * 1000));
            const endTime = Cesium.JulianDate.fromDate(new Date(data.endTime * 1000));

            viewer.clock.startTime = startTime;
            viewer.clock.stopTime = endTime;
            viewer.clock.currentTime = startTime.clone();
            viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
            viewer.clock.multiplier = 60; // 1 minute per second for smooth replay
            viewer.clock.shouldAnimate = true;

            // Mirror the clock state into the Zustand store so TimelinePlayer,
            // deep-history checks in useDynamicLayers, and speed HUD stay in sync.
            store.setSpeedMultiplier(60);
            store.setIsPlaying(true);
            store.setCurrentTime(new Date(data.startTime * 1000));

            // Fly camera to the first waypoint
            const firstWp = data.path[0];
            document.dispatchEvent(new CustomEvent('fly-to', {
                detail: { lat: firstWp[1], lng: firstWp[2], height: 50000 }
            }));

            setActiveTrack(data.callsign?.trim() || hex.toUpperCase());
        } catch (err: any) {
            const msg = err.response?.data?.error || err.message || 'Failed to load track';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    const handleClear = () => {
        const viewer = (window as any).viewerContext as Cesium.Viewer | undefined;
        if (viewer && !viewer.isDestroyed()) {
            const existingDs = viewer.dataSources.getByName('track-replay');
            for (let i = 0; i < existingDs.length; i++) {
                viewer.dataSources.remove(existingDs[i], true);
            }

            // Restore live clock
            viewer.clock.clockRange = Cesium.ClockRange.UNBOUNDED;
            viewer.clock.multiplier = 1;
            viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date());
            viewer.clock.shouldAnimate = true;
        }
        // Return store to live mode so Globe.onTick resumes syncing to now
        const store = useTimelineStore.getState();
        store.setMode('live');
        store.setPlaybackKind(null);
        store.setSpeedMultiplier(1);
        store.setIsPlaying(true);
        store.setCurrentTime(new Date());
        setActiveTrack(null);
        setError(null);
    };

    return (
        <div className="w-full">
            <div className="bg-black/60 backdrop-blur-xl border border-zinc-800 rounded-2xl px-4 py-3 shadow-2xl">
                <div className="flex items-center gap-2 mb-2">
                    <Plane size={14} className="text-yellow-400" />
                    <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Flight Track Replay</span>
                </div>

                <form onSubmit={handleLoad} className="flex items-center gap-2">
                    <input
                        type="text"
                        value={icao24}
                        onChange={e => setIcao24(e.target.value)}
                        placeholder="ICAO24 hex (e.g. 3c6589)"
                        maxLength={6}
                        className="flex-1 bg-zinc-900/80 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-yellow-500 transition-colors font-mono"
                    />
                    <button
                        type="submit"
                        disabled={loading}
                        className="px-3 py-2 bg-yellow-500/20 border border-yellow-500/40 rounded-lg text-yellow-400 text-sm font-medium hover:bg-yellow-500/30 disabled:opacity-50 transition-colors"
                    >
                        {loading ? <Loader2 size={16} className="animate-spin" /> : 'Load'}
                    </button>
                </form>

                {error && (
                    <p className="mt-2 text-xs text-red-400">{error}</p>
                )}

                {activeTrack && (
                    <div className="mt-2 flex items-center justify-between">
                        <span className="text-xs text-yellow-400 font-mono">
                            Replaying: {activeTrack}
                        </span>
                        <button
                            onClick={handleClear}
                            className="p-1 text-zinc-400 hover:text-red-400 transition-colors"
                            title="Clear track"
                        >
                            <X size={14} />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
