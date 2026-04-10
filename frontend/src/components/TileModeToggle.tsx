'use client';

import { useTimelineStore } from '../store/useTimelineStore';
import { Globe2, Building2, Group, Ungroup } from 'lucide-react';

export default function TileModeToggle() {
    const tileMode = useTimelineStore(s => s.tileMode);
    const setTileMode = useTimelineStore(s => s.setTileMode);
    const clusteringEnabled = useTimelineStore(s => s.clusteringEnabled);
    const toggleClustering = useTimelineStore(s => s.toggleClustering);

    const isGoogle = tileMode === 'google';

    return (
        <div className="flex flex-col gap-1.5">
            {/* Tile mode */}
            <div className="flex bg-black/80 backdrop-blur-xl border border-zinc-800 rounded-lg overflow-hidden shadow-2xl">
                <button
                    onClick={() => setTileMode('google')}
                    title="Google Photorealistic 3D Tiles"
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono transition-colors ${
                        isGoogle
                            ? 'bg-cyan-600/30 text-cyan-300 border-r border-cyan-700/50'
                            : 'text-zinc-500 hover:text-zinc-300 border-r border-zinc-800'
                    }`}
                >
                    <Globe2 size={14} />
                    <span>Google 3D</span>
                </button>
                <button
                    onClick={() => setTileMode('osm')}
                    title="OpenStreetMap 3D Buildings + Cesium World Terrain"
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono transition-colors ${
                        !isGoogle
                            ? 'bg-cyan-600/30 text-cyan-300'
                            : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                >
                    <Building2 size={14} />
                    <span>OSM 3D</span>
                </button>
            </div>

            {/* Clustering toggle */}
            <button
                onClick={toggleClustering}
                title={clusteringEnabled ? 'Disable clustering — show all icons' : 'Enable clustering — group nearby icons'}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-mono rounded-lg border shadow-2xl backdrop-blur-xl transition-colors ${
                    clusteringEnabled
                        ? 'bg-cyan-600/30 text-cyan-300 border-cyan-700/50'
                        : 'bg-black/80 text-zinc-500 hover:text-zinc-300 border-zinc-800'
                }`}
            >
                {clusteringEnabled ? <Group size={14} /> : <Ungroup size={14} />}
                <span>{clusteringEnabled ? 'Clustering ON' : 'Clustering OFF'}</span>
            </button>
        </div>
    );
}
