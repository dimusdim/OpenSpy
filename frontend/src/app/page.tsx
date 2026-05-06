'use client';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Settings } from 'lucide-react';
import TimelinePlayer from '../components/TimelinePlayer';
import SearchBar from '../components/SearchBar';
import Legend from '../components/Legend';
import EntityHUD from '../components/EntityHUD';
import TileModeToggle from '../components/TileModeToggle';
import TrackReplay from '../components/TrackReplay';
import CameraHUD from '../components/CameraHUD';
import SettingsPanel from '../components/SettingsPanel';
import SystemStorageStatus from '../components/SystemStorageStatus';
import RenderPerfStatus from '../components/RenderPerfStatus';
import AIImagePanel, { AIImageToggle } from '../components/AIImagePanel';
import AgentPanel, { AgentToggle } from '../components/AgentPanel';
import ImageryPanel, { ImageryContextBadge, ImageryToggle } from '../components/ImageryPanel';
import { useAIImageStore } from '../store/useAIImageStore';
import { useTimelineStore } from '../store/useTimelineStore';
import { useStatusPoller } from '../hooks/useStatusPoller';
import { API_URL } from '../lib/config';

const GlobeDynamic = dynamic(() => import('../components/Globe'), {
  ssr: false,
});

export default function Home() {
  const aiActive = useAIImageStore((s) => s.isActive);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [imageryOpen, setImageryOpen] = useState(false);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [uiMounted, setUiMounted] = useState(false);

  // Status polling — always-on, independent of which panels are open
  useStatusPoller();

  useEffect(() => {
    setUiMounted(true);
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
        if (Object.keys(patch).length > 0) useTimelineStore.setState(patch as any);
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
    (window as any).__openspyTimelineStore = useTimelineStore;
    return () => {
      delete (window as any).__openspyTimelineStore;
    };
  }, []);

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-zinc-950 text-white selection:bg-cyan-500 selection:text-black">
        {settingsHydrated ? <GlobeDynamic /> : null}

        {aiActive ? (
            /* AI Vision mode — only the panel, globe stays interactive */
            <AIImagePanel />
        ) : (
            <>
                {/* Left column: hierarchical legend (self-positioned top-left) */}
                {uiMounted ? <Legend /> : null}

                {/* Right column: controls stacked vertically, no overlap */}
                {uiMounted ? (
                    <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 max-h-[calc(100vh-100px)] w-80">
                        <SystemStorageStatus />
                        <RenderPerfStatus />
                        <SearchBar />
                        <TileModeToggle />
                        <ImageryToggle onClick={() => setImageryOpen(true)} />
                        <ImageryContextBadge />
                        <AIImageToggle />
                        <AgentToggle onClick={() => setAgentsOpen(true)} />
                        <button
                            onClick={() => setSettingsOpen(true)}
                            className="flex items-center gap-2 px-3 py-2 bg-black/70 backdrop-blur-xl border border-zinc-800 rounded-lg text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors text-xs font-mono"
                            title="Settings"
                        >
                            <Settings size={14} />
                            <span>Settings</span>
                        </button>
                        <TrackReplay />
                    </div>
                ) : null}

                {/* Bottom bar */}
                {uiMounted ? <TimelinePlayer /> : null}

                {/* Bottom-left: camera altitude + infra loading */}
                {uiMounted ? <CameraHUD /> : null}

                {/* Overlay: entity info panel */}
                {uiMounted ? <EntityHUD avoidRightPx={agentsOpen ? 472 : 0} /> : null}

                {/* Settings modal */}
                {uiMounted ? (
                    <>
                        <ImageryPanel isOpen={imageryOpen} onClose={() => setImageryOpen(false)} />
                        <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
                        <AgentPanel isOpen={agentsOpen} onClose={() => setAgentsOpen(false)} />
                    </>
                ) : null}
            </>
        )}
    </main>
  );
}
