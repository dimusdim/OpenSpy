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
import AIImagePanel, { AIImageToggle } from '../components/AIImagePanel';
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

  // Status polling — always-on, independent of which panels are open
  useStatusPoller();

  // Load persisted settings from server on mount
  useEffect(() => {
    fetch(`${API_URL}/api/settings`)
      .then(r => r.json())
      .then(saved => {
        if (!saved || typeof saved !== 'object') return;
        const store = useTimelineStore.getState();
        if (saved.sources) {
          useTimelineStore.setState({
            sources: { ...store.sources, ...saved.sources },
          });
        }
        if (saved.visibility) {
          useTimelineStore.setState({
            visibility: { ...store.visibility, ...saved.visibility },
          });
        }
        if (saved.subtypeVisibility) {
          useTimelineStore.setState({
            subtypeVisibility: { ...store.subtypeVisibility, ...saved.subtypeVisibility },
          });
        }
        if (saved.tileMode) {
          useTimelineStore.setState({ tileMode: saved.tileMode });
        }
      })
      .catch(() => { /* no saved settings, use defaults */ });
  }, []);

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-zinc-950 text-white selection:bg-cyan-500 selection:text-black">
        <GlobeDynamic />

        {aiActive ? (
            /* AI Vision mode — only the panel, globe stays interactive */
            <AIImagePanel />
        ) : (
            <>
                {/* Left column: hierarchical legend (self-positioned top-left) */}
                <Legend />

                {/* Right column: controls stacked vertically, no overlap */}
                <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 max-h-[calc(100vh-100px)] w-80">
                    <SearchBar />
                    <TileModeToggle />
                    <AIImageToggle />
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

                {/* Bottom bar */}
                <TimelinePlayer />

                {/* Bottom-left: camera altitude + infra loading */}
                <CameraHUD />

                {/* Overlay: entity info panel */}
                <EntityHUD />

                {/* Settings modal */}
                <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
            </>
        )}
    </main>
  );
}
