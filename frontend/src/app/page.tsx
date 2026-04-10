'use client';
import dynamic from 'next/dynamic';
import LayerManager from '../components/LayerManager';
import TimelinePlayer from '../components/TimelinePlayer';
import SearchBar from '../components/SearchBar';
import Legend from '../components/Legend';
import EntityHUD from '../components/EntityHUD';
import TileModeToggle from '../components/TileModeToggle';
import TrackReplay from '../components/TrackReplay';
// OilPricesWidget removed — price ticker without geographic context is not useful

const GlobeDynamic = dynamic(() => import('../components/Globe'), {
  ssr: false,
});

export default function Home() {
  return (
    <main className="relative w-screen h-screen overflow-hidden bg-zinc-950 text-white selection:bg-cyan-500 selection:text-black">
        <GlobeDynamic />

        {/* Left column: data sources */}
        <LayerManager />

        {/* Right column: controls stacked vertically, no overlap */}
        <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 max-h-[calc(100vh-100px)] w-80">
            <SearchBar />
            <TileModeToggle />
            <TrackReplay />
        </div>

        {/* Bottom bar */}
        <TimelinePlayer />

        {/* Bottom-right: legend (self-positioned) */}
        <Legend />

        {/* Overlay: entity info panel */}
        <EntityHUD />
    </main>
  );
}
