'use client';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Activity, Bot, ChevronDown, ChevronUp, History, Image as ImageIcon, Layers, Palette, ScanLine, Settings, Sparkles, X } from 'lucide-react';
import TimelinePlayer from '../components/TimelinePlayer';
import SearchBar from '../components/SearchBar';
import Legend from '../components/Legend';
import EntityHUD from '../components/EntityHUD';
import TrackReplay from '../components/TrackReplay';
import CameraHUD from '../components/CameraHUD';
import SettingsPanel from '../components/SettingsPanel';
import SystemStorageStatus from '../components/SystemStorageStatus';
import RenderPerfStatus from '../components/RenderPerfStatus';
import AIImagePanel from '../components/AIImagePanel';
import AgentPanel from '../components/AgentPanel';
import ImageryPanel, { ImageryContextBadge } from '../components/ImageryPanel';
import EsriDateReadout from '../components/EsriDateReadout';
import IconPackPanel from '../components/IconPackPanel';
import GlobeShaderPanel from '../components/GlobeShaderPanel';
import ErrorBoundary from '../components/ErrorBoundary';
import { ToastProvider } from '../components/Toast';
import { useAIImageStore } from '../store/useAIImageStore';
import { useTimelineStore } from '../store/useTimelineStore';
import type { PowerGridEffectPreset, TrafficFlowEffectPreset, VisualShaderPreset } from '../store/useTimelineStore';
import { useStatusPoller } from '../hooks/useStatusPoller';
import { API_URL } from '../lib/config';
import { setRuntimeIconPack } from '../icons/map-icons';

const GlobeDynamic = dynamic(() => import('../components/Globe'), {
  ssr: false,
});

type LeftDock = 'layers' | 'imagery' | 'replay' | null;
type RightDock = 'agent' | 'vision' | 'icons' | 'shaders' | 'status' | null;
type OpenSpyWindow = Window & {
  __openspyTimelineStore?: typeof useTimelineStore;
};

function isVisualShaderPreset(value: unknown): value is VisualShaderPreset {
  return value === 'normal'
    || value === 'night-ops'
    || value === 'signal-grid'
    || value === 'thermal'
    || value === 'monochrome'
    || value === 'tactical-green'
    || value === 'cyberpunk'
    || value === 'xray'
    || value === 'hazard'
    || value === 'deep-space'
    || value === 'infrared';
}

function isPowerGridEffectPreset(value: unknown): value is PowerGridEffectPreset {
  return value === 'off'
    || value === 'electric-flow'
    || value === 'ember-pulse'
    || value === 'voltage-surge';
}

function isTrafficFlowEffectPreset(value: unknown): value is TrafficFlowEffectPreset {
  return value === 'off'
    || value === 'flow-particles'
    || value === 'congestion-pulse'
    || value === 'signal-rain';
}

export default function Home() {
  const aiActive = useAIImageStore((s) => s.isActive);
  const setAIActive = useAIImageStore((s) => s.setActive);
  const sources = useTimelineStore((s) => s.sources);
  const visibility = useTimelineStore((s) => s.visibility);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeLeft, setActiveLeft] = useState<LeftDock>('layers');
  const [activeRight, setActiveRight] = useState<RightDock>('agent');
  const [imagerySeed, setImagerySeed] = useState<{ lat: number; lng: number; nonce: number } | null>(null);
  const [timelineHidden, setTimelineHidden] = useState(false);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [iconPackHydrated, setIconPackHydrated] = useState(false);
  const [uiMounted, setUiMounted] = useState(false);
  const activeLayerCount = useMemo(() => (
    Object.keys(visibility).filter((layerKey) => {
      const layer = layerKey as keyof typeof visibility;
      return Boolean(visibility[layer]) && Boolean(sources[layer]);
    }).length
  ), [sources, visibility]);
  const leftTitle = activeLeft === 'layers'
    ? 'Layers'
    : activeLeft === 'imagery'
      ? 'Imagery'
      : activeLeft === 'replay'
        ? 'Track replay'
        : '';
  const rightTitle = activeRight === 'agent'
    ? 'Agent'
    : activeRight === 'vision'
      ? 'AI Vision'
      : activeRight === 'icons'
        ? 'Icon Packs'
        : activeRight === 'shaders'
          ? 'Shaders'
          : activeRight === 'status'
            ? 'Status'
            : '';

  // Status polling — always-on, independent of which panels are open
  useStatusPoller();

  useEffect(() => {
    setUiMounted(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Boot must not hang on a stalled /api/icon-packs: proceed with defaults
    // after a short timeout so the globe can still mount.
    const fallback = window.setTimeout(() => {
      if (!cancelled) setIconPackHydrated(true);
    }, 3000);
    fetch(`${API_URL}/api/icon-packs`)
      .then(r => r.json())
      .then((data) => {
        if (cancelled) return;
        const pack = data?.packs?.find((candidate: any) => candidate?.id === data?.activePackId) || data?.packs?.[0] || null;
        setRuntimeIconPack(pack);
      })
      .catch(() => {
        if (cancelled) return;
        setRuntimeIconPack(null);
      })
      .finally(() => {
        window.clearTimeout(fallback);
        if (!cancelled) setIconPackHydrated(true);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
    };
  }, []);

  // Load persisted settings from server on mount
  useEffect(() => {
    let cancelled = false;
    const fallback = window.setTimeout(() => {
      if (!cancelled) setSettingsHydrated(true);
    }, 3000);
    fetch(`${API_URL}/api/settings`)
      .then(r => r.json())
      .then(saved => {
        if (cancelled) return;
        if (!saved || typeof saved !== 'object') return;
        const store = useTimelineStore.getState();
        const patch: Partial<ReturnType<typeof useTimelineStore.getState>> = {};
        if (saved.sources) {
          patch.sources = { ...store.sources, ...saved.sources };
        }
        if (saved.visibility) {
          patch.visibility = { ...store.visibility, ...saved.visibility };
        }
        if (saved.subtypeVisibility) {
          patch.subtypeVisibility = { ...store.subtypeVisibility, ...saved.subtypeVisibility };
        }
        if (saved.sourceVisibility) {
          patch.sourceVisibility = { ...store.sourceVisibility, ...saved.sourceVisibility };
        }
        if (saved.tileMode) {
          patch.tileMode = saved.tileMode;
        }
        if (typeof saved.osm3dObjectsVisible === 'boolean') {
          patch.osm3dObjectsVisible = saved.osm3dObjectsVisible;
        }
        if (typeof saved.showTrajectories === 'boolean') {
          patch.showTrajectories = saved.showTrajectories;
        }
        if (typeof saved.clusteringEnabled === 'boolean') {
          patch.clusteringEnabled = saved.clusteringEnabled;
        }
        if (
          saved.satelliteRenderLimit === null ||
          (typeof saved.satelliteRenderLimit === 'number' && Number.isInteger(saved.satelliteRenderLimit) && saved.satelliteRenderLimit >= 0)
        ) {
          patch.satelliteRenderLimit = saved.satelliteRenderLimit ?? null;
        }
        if (typeof saved.activePreset === 'string' || saved.activePreset === null) {
          patch.activePreset = saved.activePreset ?? null;
        }
        if (saved.activeIconSet === 'default' || saved.activeIconSet === 'enhanced') {
          patch.activeIconSet = saved.activeIconSet;
        }
        if (isVisualShaderPreset(saved.visualShader)) {
          patch.visualShader = saved.visualShader;
        }
        if (isPowerGridEffectPreset(saved.powerGridEffect)) {
          patch.powerGridEffect = saved.powerGridEffect;
        }
        if (isTrafficFlowEffectPreset(saved.trafficFlowEffect)) {
          patch.trafficFlowEffect = saved.trafficFlowEffect;
        }
        if (Object.keys(patch).length > 0) useTimelineStore.setState(patch);
      })
      .catch(() => { /* no saved settings, use defaults */ })
      .finally(() => {
        window.clearTimeout(fallback);
        if (!cancelled) setSettingsHydrated(true);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    (window as OpenSpyWindow).__openspyTimelineStore = useTimelineStore;
    return () => {
      delete (window as OpenSpyWindow).__openspyTimelineStore;
    };
  }, []);

  useEffect(() => {
    if (!aiActive && activeRight === 'vision') {
      setActiveRight(null);
    }
  }, [activeRight, aiActive]);

  // Globe right-click → open the Imagery panel seeded with the clicked point.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { lat?: number; lng?: number } | undefined;
      if (!detail || typeof detail.lat !== 'number' || typeof detail.lng !== 'number') return;
      setImagerySeed({ lat: detail.lat, lng: detail.lng, nonce: Date.now() });
      setActiveLeft('imagery');
    };
    document.addEventListener('openspy:imagery-here', handler);
    return () => document.removeEventListener('openspy:imagery-here', handler);
  }, []);

  const toggleLeft = (panel: Exclude<LeftDock, null>) => {
    setActiveLeft((current) => current === panel ? null : panel);
  };

  const toggleRight = (panel: Exclude<RightDock, null>) => {
    const next = activeRight === panel ? null : panel;
    setActiveRight(next);
    setAIActive(next === 'vision');
  };

  const globeReady = settingsHydrated && iconPackHydrated;

  return (
    <ToastProvider>
    <main className="os-app selection:bg-cyan-500 selection:text-black" data-timeline-hidden={timelineHidden}>
        {globeReady ? (
            <ErrorBoundary label="Globe">
                <GlobeDynamic />
            </ErrorBoundary>
        ) : (
            <div className="os-boot">
                <div className="os-boot__spinner" />
                <div className="os-boot__status">Loading globe…</div>
            </div>
        )}

        {uiMounted ? (
            <>
                <div className="os-topbar">
                    <div className="os-brand">
                        <span className="os-brand__dot" />
                        <span>OpenSpy</span>
                        <span className="os-brand__sub">R0.1</span>
                    </div>
                    <div className="flex-1" />
                    <div className="os-topbar__search">
                        <SearchBar variant="topbar" />
                    </div>
                    <div className="flex-1" />
                </div>

                <div className="os-rail os-rail--left">
                    <div className="os-rail__inner">
                        <button className="os-rail-btn" data-active={activeLeft === 'layers'} title="Layers" onClick={() => toggleLeft('layers')}>
                            <Layers size={18} />
                            {activeLayerCount > 0 && <span className="os-rail-count">{Math.min(activeLayerCount, 99)}</span>}
                        </button>
                        <button className="os-rail-btn" data-active={activeLeft === 'imagery'} title="Imagery" onClick={() => toggleLeft('imagery')}>
                            <ImageIcon size={18} />
                        </button>
                        <button className="os-rail-btn" data-active={activeLeft === 'replay'} title="Track replay" onClick={() => toggleLeft('replay')}>
                            <History size={18} />
                        </button>
                        <div className="os-rail__spacer" />
                        <button className="os-rail-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
                            <Settings size={18} />
                        </button>
                    </div>
                </div>

                <div className="os-dock os-dock--left" data-open={Boolean(activeLeft)}>
                    <div className="os-dock__header">
                        <span className="os-dock__title">{leftTitle}</span>
                    </div>
                    <div className="os-dock__body">
                        {activeLeft === 'layers' && (
                            <Legend embedded />
                        )}
                        {activeLeft === 'imagery' && (
                            <ImageryPanel isOpen embedded seedPoint={imagerySeed} onClose={() => setActiveLeft(null)} />
                        )}
                        {activeLeft === 'replay' && (
                            <div className="p-3">
                                <TrackReplay />
                            </div>
                        )}
                    </div>
                </div>

                <div className="os-rail os-rail--right">
                    <div className="os-rail__inner">
                        <button className="os-rail-btn" data-active={activeRight === 'agent'} title="Agent" onClick={() => toggleRight('agent')}>
                            <Bot size={18} />
                        </button>
                        <button className="os-rail-btn" data-active={activeRight === 'vision'} title="AI Vision" onClick={() => toggleRight('vision')}>
                            <Sparkles size={18} />
                        </button>
                        <button className="os-rail-btn" data-active={activeRight === 'icons'} title="Icon packs" onClick={() => toggleRight('icons')}>
                            <Palette size={18} />
                        </button>
                        <button className="os-rail-btn" data-active={activeRight === 'shaders'} title="Shaders" onClick={() => toggleRight('shaders')}>
                            <ScanLine size={18} />
                        </button>
                        <div className="os-rail__divider" />
                        <button className="os-rail-btn" data-active={activeRight === 'status'} title="System status" onClick={() => toggleRight('status')}>
                            <Activity size={18} />
                        </button>
                    </div>
                </div>

                <div className="os-dock os-dock--right" data-open={Boolean(activeRight)}>
                    <div className="os-dock__header">
                        <span className="os-dock__title">{rightTitle}</span>
                        <button className="os-rail-btn" style={{ width: 28, height: 28 }} onClick={() => {
                            setAIActive(false);
                            setActiveRight(null);
                        }} title="Close panel">
                            <X size={14} />
                        </button>
                    </div>
                    <div className={activeRight === 'status' ? 'os-dock__body' : 'os-dock__body os-dock__body--flush'}>
                        <ErrorBoundary label={rightTitle || 'Panel'} compact key={activeRight ?? 'none'}>
                            {activeRight === 'agent' && (
                                <AgentPanel isOpen embedded onClose={() => setActiveRight(null)} />
                            )}
                            {activeRight === 'vision' && (
                                <AIImagePanel embedded />
                            )}
                            {activeRight === 'icons' && (
                                <IconPackPanel />
                            )}
                            {activeRight === 'shaders' && (
                                <GlobeShaderPanel />
                            )}
                            {activeRight === 'status' && (
                                <div className="os-status-dock">
                                    <SystemStorageStatus />
                                    <RenderPerfStatus />
                                </div>
                            )}
                        </ErrorBoundary>
                    </div>
                </div>

                <div className="os-floating-context">
                    <EsriDateReadout />
                    <ImageryContextBadge />
                </div>

                <div className="os-bottombar" data-hidden={timelineHidden}>
                    {!timelineHidden && (
                        <div className="os-timeline-shell">
                            <TimelinePlayer embedded />
                        </div>
                    )}
                    <button
                        className="os-rail-btn border border-zinc-800 bg-[#131315]"
                        title={timelineHidden ? 'Show timeline' : 'Hide timeline'}
                        onClick={() => setTimelineHidden((current) => !current)}
                    >
                        {timelineHidden ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                </div>

                <CameraHUD />
                <EntityHUD
                    avoidLeftPx={activeLeft ? 384 : 72}
                    avoidRightPx={activeRight ? 384 : 72}
                    avoidTopPx={56}
                    avoidBottomPx={timelineHidden ? 24 : 72}
                />
                <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
            </>
        ) : null}
    </main>
    </ToastProvider>
  );
}
