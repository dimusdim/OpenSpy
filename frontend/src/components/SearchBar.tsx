'use client';

import { useState } from 'react';
import axios from 'axios';
import { Search, Loader2 } from 'lucide-react';

export default function SearchBar({ variant = 'floating' }: { variant?: 'floating' | 'topbar' }) {
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!query.trim()) return;

        setLoading(true);
        try {
            // Free OSM Nominatim API
            const res = await axios.get(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
            if (res.data && res.data.length > 0) {
                const lat = parseFloat(res.data[0].lat);
                const lng = parseFloat(res.data[0].lon);
                // Dispatch event to fly camera
                document.dispatchEvent(new CustomEvent('fly-to', { detail: { lat, lng, height: 25000 } }));
            }
        } catch (error) {
            console.error('Geocoder failed', error);
        } finally {
            setLoading(false);
        }
    };

    if (variant === 'topbar') {
        return (
            <form onSubmit={handleSearch} className="os-search">
                <Search size={14} />
                <input
                    id="os-search-input"
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Fly to location, callsign, MMSI, NORAD…"
                />
                {loading ? <Loader2 size={14} className="animate-spin" /> : <kbd>/</kbd>}
            </form>
        );
    }

    return (
        <div className="w-full">
            <form onSubmit={handleSearch} className="relative flex items-center">
                <input
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Fly to location..."
                    className="w-full bg-black/60 backdrop-blur-xl border border-zinc-800 rounded-full px-4 py-3 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-cyan-500 shadow-2xl transition-colors"
                />
                <button 
                    type="submit" 
                    className="absolute right-2 p-2 text-zinc-400 hover:text-cyan-400"
                    disabled={loading}
                >
                    {loading ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
                </button>
            </form>
        </div>
    );
}
