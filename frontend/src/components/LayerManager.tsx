'use client';

import { useTimelineStore } from '../store/useTimelineStore';
import { Layers, Activity, Radio, AlertTriangle } from 'lucide-react';

export default function LayerManager() {
  const { layers, toggleLayer, showTrajectories, toggleTrajectories, streamMetrics } = useTimelineStore();

  const getStatusColor = (status: string) => {
      switch (status) {
          case 'streaming': return 'bg-green-500';
          case 'warning': return 'bg-yellow-500';
          case 'error': return 'bg-red-500';
          default: return 'bg-zinc-500';
      }
  };

  return (
    <div className="absolute top-4 left-4 w-80 max-h-[85vh] overflow-y-auto bg-black/80 backdrop-blur-xl border border-zinc-800 rounded-xl p-4 text-white shadow-[0_0_40px_rgba(0,0,0,0.8)] z-10 flex flex-col gap-4">
      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-zinc-800">
        <Layers className="w-5 h-5 text-zinc-400" />
        <h2 className="font-mono text-sm tracking-wider font-semibold uppercase text-cyan-500">Data Intelligence</h2>
      </div>

      <div className="flex flex-col gap-3">
        {Object.entries(layers).map(([layerName, isVisible]) => {
          const metric = streamMetrics[layerName];

          return (
            <div key={layerName} className={`relative p-3 rounded-lg border flex flex-col gap-2 transition-colors ${isVisible ? 'border-cyan-500/50 bg-cyan-900/10' : 'border-zinc-800 bg-zinc-900/50'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {/* Status Dot */}
                    <div className="relative flex h-2.5 w-2.5">
                      {metric?.status === 'streaming' && (
                          <span className={`${getStatusColor(metric.status)} animate-ping absolute inline-flex h-full w-full rounded-full opacity-75`}></span>
                      )}
                      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${getStatusColor(metric?.status || 'connecting')}`}></span>
                    </div>
                    <span className="capitalize font-mono text-xs">{metric?.label || layerName}</span>
                </div>
                <div 
                    className={`w-8 h-4 rounded-full flex items-center p-0.5 cursor-pointer transition-colors ${isVisible ? 'bg-cyan-500' : 'bg-zinc-600'}`}
                    onClick={() => toggleLayer(layerName as any)}
                >
                    <div className={`w-3 h-3 bg-white rounded-full shadow-md transform transition-transform ${isVisible ? 'translate-x-4' : 'translate-x-0'}`} />
                </div>
              </div>

              {/* Source Diagnostics */}
              <div className="flex flex-col gap-1 pl-4 border-l border-zinc-700/50">
                  <div className="text-[10px] font-mono text-zinc-500 flex items-center justify-between">
                      <div className="flex items-center gap-1"><Radio className="w-3 h-3 text-zinc-600" /> {metric?.source || 'Local'}</div>
                      <div className="text-zinc-600 font-bold tracking-wider">{metric?.speed || ''}</div>
                  </div>
                  <div className="flex justify-between items-center text-[10px] font-mono text-zinc-400">
                      <span>{metric?.type || 'Static'}</span>
                      <span className="px-1.5 py-0.5 bg-black rounded border border-zinc-800 text-cyan-400">
                          {metric?.count
                              ? metric.count.toLocaleString()
                              : metric?.status === 'streaming'
                                  ? 'active'
                                  : 'Loading...'}
                      </span>
                  </div>
                  {/* Cadence: how often we poll vs how often the upstream actually publishes */}
                  <div className="flex justify-between items-center text-[9px] font-mono text-zinc-500 pt-0.5">
                      <span>
                          <span className="text-zinc-600">poll </span>
                          <span className="text-cyan-500/80">{metric?.poll || '—'}</span>
                      </span>
                      <span>
                          <span className="text-zinc-600">upstream </span>
                          <span className="text-zinc-300">{metric?.upstream || '—'}</span>
                      </span>
                  </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 pt-4 border-t border-zinc-800">
        <label className="flex items-center gap-2 text-sm font-mono text-zinc-400 cursor-pointer hover:text-white transition-colors">
            <input 
                type="checkbox" 
                className="w-4 h-4 accent-cyan-500"
                checked={showTrajectories}
                onChange={() => toggleTrajectories()}
            />
            Show Orbital/Flight Trajectories
        </label>
      </div>
    </div>
  );
}
