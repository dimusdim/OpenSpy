'use client';

import { memo, useEffect, useState } from 'react';
import { useTimelineStore } from '../store/useTimelineStore';
import { Layers, Radio, AlertCircle } from 'lucide-react';
import { API_URL } from '../lib/config';

// Hoisted helpers — pure functions, don't need to live inside the component.
const getStatusColor = (status: string) => {
    switch (status) {
        case 'streaming': return 'bg-green-500';
        case 'limited': return 'bg-green-400';
        case 'degraded': return 'bg-yellow-500';
        case 'warning': return 'bg-yellow-500';
        case 'connecting': return 'bg-yellow-400';
        case 'rate-limited': return 'bg-orange-400';
        case 'auth-missing': return 'bg-orange-500';
        case 'disabled': return 'bg-zinc-600';
        case 'error': return 'bg-red-500';
        default: return 'bg-yellow-400';
    }
};

const getStatusLabel = (status: string) => {
    switch (status) {
        case 'streaming': return null;
        case 'limited': return 'free tier';
        case 'degraded': return 'degraded';
        case 'connecting': return 'loading';
        case 'rate-limited': return 'rate limited';
        case 'auth-missing': return 'API key needed';
        case 'disabled': return 'disabled';
        case 'error': return 'error';
        default: return null;
    }
};

// True when the user has enabled the source but data hasn't landed yet.
// Keyed strictly off an IN-FLIGHT status ('connecting' or unknown/
// undefined); a streaming source with zero rows counts as "active but
// empty" (e.g. no active GDACS alerts, no wildfires in the current
// window) and must NOT paint permanent yellow. The earlier version
// treated `streaming && count === 0` as loading and flashed the row
// yellow forever on legitimately empty feeds.
const isLoading = (isSourceOn: boolean, status: string | undefined) => {
    if (!isSourceOn) return false;
    return status === 'connecting' || status === undefined;
};

// Per-row component. Subscribes ONLY to its own streamMetric slice via
// a selector so a metric write for layer A does NOT re-render row B.
// Memoised on isSourceOn + layerName + onToggle so the parent's
// `sources` reference bump (from any other row's toggle) doesn't
// re-render unchanged rows either.
interface LayerRowProps {
    layerName: string;
    isSourceOn: boolean;
    onToggle: (layer: any) => void;
}

const LayerRow = memo(function LayerRow({ layerName, isSourceOn, onToggle }: LayerRowProps) {
    // The selector returns this row's metric object only. Because
    // `setStreamMetric` builds a fresh inner object only for the
    // affected layer (and leaves other layers' inner objects intact),
    // this selector fires only when THIS row's metric actually changes.
    const metric = useTimelineStore(s => s.streamMetrics[layerName]);
    const loading = isLoading(isSourceOn, metric?.status);

    // Row border: three states so the user can see at a glance
    //   - off (grey)
    //   - on + loading (yellow — "the switch is on, data is on
    //     its way, do not toggle it again")
    //   - on + streaming (cyan — fully hot)
    const rowBorder = !isSourceOn
        ? 'border-zinc-800 bg-zinc-900/50'
        : loading
            ? 'border-yellow-500/60 bg-yellow-900/10'
            : 'border-cyan-500/50 bg-cyan-900/10';

    return (
        <div className={`relative p-3 rounded-lg border flex flex-col gap-2 transition-colors ${rowBorder}`}>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {/* Status Dot — yellow pulse while loading, green pulse
                        while streaming, dim grey when the source is off. */}
                    <div className="relative flex h-2.5 w-2.5">
                        {isSourceOn && (metric?.status === 'streaming' || loading) && (
                            <span className={`${loading ? 'bg-yellow-400' : getStatusColor(metric?.status || 'streaming')} animate-ping absolute inline-flex h-full w-full rounded-full opacity-75`}></span>
                        )}
                        <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isSourceOn ? (loading ? 'bg-yellow-400' : getStatusColor(metric?.status || 'connecting')) : 'bg-zinc-700'}`}></span>
                    </div>
                    <span className="capitalize font-mono text-xs">{metric?.label || layerName}</span>
                </div>
                <div
                    className={`w-8 h-4 rounded-full flex items-center p-0.5 cursor-pointer transition-colors ${isSourceOn ? (loading ? 'bg-yellow-500' : 'bg-cyan-500') : 'bg-zinc-600'}`}
                    onClick={() => onToggle(layerName as any)}
                    title={isSourceOn ? (loading ? 'Loading data — click to stop fetching' : 'Stop fetching this data source') : 'Resume fetching'}
                >
                    <div className={`w-3 h-3 bg-white rounded-full shadow-md transform transition-transform ${isSourceOn ? 'translate-x-4' : 'translate-x-0'}`} />
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
                    <span className={`px-1.5 py-0.5 bg-black rounded border text-[10px] font-bold uppercase tracking-wider ${
                        loading ? 'border-yellow-700 text-yellow-400 animate-pulse'
                        : metric?.status === 'auth-missing' ? 'border-orange-800 text-orange-400'
                        : metric?.status === 'disabled' ? 'border-zinc-700 text-zinc-500'
                        : metric?.status === 'error' ? 'border-red-800 text-red-400'
                        : 'border-zinc-800 text-cyan-400'
                    }`}>
                        {loading
                            ? 'LOADING'
                            : getStatusLabel(metric?.status || '') || (
                                metric?.count
                                    ? metric.count.toLocaleString()
                                    : metric?.status === 'streaming'
                                        ? 'active'
                                        : 'idle'
                            )}
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
                {/* Free-form note from /api/status — used for Overture
                    init failures, fallback explanations, etc. Coloured
                    orange when the status is error/warning so the
                    message reads as a real diagnostic; otherwise
                    muted grey for benign notes. `break-words` keeps
                    long DuckDB / URL error messages inside the row
                    instead of blowing the panel width. */}
                {metric?.note && (
                    <div
                        title={metric.note}
                        className={`text-[9px] font-mono pt-1 leading-snug break-words whitespace-normal ${
                            metric.status === 'error' || metric.status === 'warning'
                                ? 'text-orange-400'
                                : 'text-zinc-500'
                        }`}
                        style={{ overflowWrap: 'anywhere' }}
                    >
                        {metric.note}
                    </div>
                )}
            </div>
        </div>
    );
});

export default function LayerManager() {
  // LayerManager is the "Data Intelligence" left panel — it controls SOURCES
  // (whether we fetch data for a layer from the backend). Visibility (whether
  // rendered primitives are shown) lives in Legend.tsx and uses `visibility`.
  //
  // Perf note: we intentionally use INDIVIDUAL SELECTORS here instead of
  // `const { ... } = useTimelineStore()`. The whole-store form re-renders
  // this component on every single store write — including streamMetrics
  // writes from every layer hook (which fire constantly) and currentTime
  // writes from Globe's onTick (twice per second). Per-row streamMetrics
  // updates are handled by the memoised <LayerRow> child so only the
  // affected row re-renders.
  const sources = useTimelineStore(s => s.sources);
  const toggleSource = useTimelineStore(s => s.toggleSource);
  const showTrajectories = useTimelineStore(s => s.showTrajectories);
  const toggleTrajectories = useTimelineStore(s => s.toggleTrajectories);
  const [backendReachable, setBackendReachable] = useState<boolean | null>(null);
  const [retrying, setRetrying] = useState<boolean>(true);
  // Bump this to kick off a fresh retry cycle (manual "Retry" button).
  const [retryNonce, setRetryNonce] = useState(0);

  // Fetch backend service status with retry — if backend is still starting up
  // we retry a few times before giving up. Retries every 5s for 2 minutes.
  useEffect(() => {
    let attempts = 0;
    const MAX_ATTEMPTS = 24; // 2 minutes @ 5s
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    setRetrying(true);

    const tryFetch = () => {
      if (cancelled) return;
      attempts++;
      fetch(`${API_URL}/api/status`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((status: Record<string, { status: string; count?: number; note?: string }>) => {
          if (cancelled) return;
          setBackendReachable(true);
          setRetrying(false);
          const { setStreamMetric } = useTimelineStore.getState();
          // Propagate status AND note from /api/status. Layer hooks
          // emit their own status on fetch cadence, so this loop makes
          // the backend health visible in between fetches — AND it
          // carries the free-form `note` (e.g. Overture DuckDB init
          // failure message) through to the row so the user sees WHY
          // something is red, not just that it is red.
          for (const [layer, info] of Object.entries(status)) {
            const known = ['streaming', 'error', 'auth-missing', 'disabled', 'degraded', 'limited', 'warning'];
            const patch: Partial<{ status: string; note: string }> = {};
            if (known.includes(info.status)) patch.status = info.status;
            if (info.note !== undefined) patch.note = info.note;
            if (Object.keys(patch).length > 0) {
              setStreamMetric(layer, patch as any);
            }
          }
        })
        .catch(() => {
          if (cancelled) return;
          setBackendReachable(false);
          if (attempts < MAX_ATTEMPTS) {
            retryTimer = setTimeout(tryFetch, 5000);
          } else {
            // Give up auto-retrying; user can click "Retry" to restart.
            setRetrying(false);
          }
        });
    };
    tryFetch();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [retryNonce]);

  return (
    <div className="absolute top-4 left-4 w-80 max-h-[85vh] overflow-y-auto bg-black/80 backdrop-blur-xl border border-zinc-800 rounded-xl p-4 text-white shadow-[0_0_40px_rgba(0,0,0,0.8)] z-10 flex flex-col gap-4">
      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-zinc-800">
        <Layers className="w-5 h-5 text-zinc-400" />
        <h2 className="font-mono text-sm tracking-wider font-semibold uppercase text-cyan-500">Data Intelligence</h2>
      </div>

      {backendReachable === false && (
        <div className="flex items-start gap-2 p-2 rounded-lg border border-red-700/50 bg-red-900/20 text-[10px] font-mono text-red-300">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-bold mb-0.5">Backend unreachable</div>
            {retrying ? (
              <div className="text-red-400/80">Retrying every 5s. Check if backend is running at {API_URL}</div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <div className="text-red-400/80">Gave up. Check backend at {API_URL}</div>
                <button
                  onClick={() => setRetryNonce(n => n + 1)}
                  className="px-2 py-0.5 rounded border border-red-600/60 bg-red-900/40 hover:bg-red-800/60 hover:border-red-500 text-red-200 font-bold uppercase tracking-wider text-[9px] transition-colors"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {Object.entries(sources).map(([layerName, isSourceOn]) => (
            <LayerRow
                key={layerName}
                layerName={layerName}
                isSourceOn={isSourceOn}
                onToggle={toggleSource}
            />
        ))}
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
