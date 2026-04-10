'use client';

import { useEffect, useState } from 'react';
import { Fuel } from 'lucide-react';

interface OilQuote {
    price: number;
    change: number;
    changePercent: number;
}

interface OilPricesData {
    brent: OilQuote;
    wti: OilQuote;
    spread: number;
    updatedAt: string;
}

export default function OilPricesWidget() {
    const [data, setData] = useState<OilPricesData | null>(null);

    useEffect(() => {
        const fetchPrices = async () => {
            try {
                const res = await fetch('http://localhost:3055/api/oil-prices');
                if (res.ok) {
                    const json = await res.json();
                    if (json) setData(json);
                }
            } catch {
                // Silently fail — widget just shows loading state
            }
        };

        fetchPrices();
        const interval = setInterval(fetchPrices, 60_000);
        return () => clearInterval(interval);
    }, []);

    const formatChange = (q: OilQuote) => {
        const sign = q.change >= 0 ? '+' : '';
        return `${sign}${q.change.toFixed(2)} (${sign}${q.changePercent.toFixed(2)}%)`;
    };

    const changeColor = (change: number) =>
        change > 0 ? 'text-green-400' : change < 0 ? 'text-red-400' : 'text-zinc-400';

    if (!data) {
        return (
            <div className="bg-black/80 backdrop-blur-xl border border-zinc-800 rounded-lg px-3 py-2 shadow-2xl font-mono text-xs text-zinc-500">
                <div className="flex items-center gap-1.5">
                    <Fuel size={12} className="text-zinc-600" />
                    <span>Oil prices loading...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-black/80 backdrop-blur-xl border border-zinc-800 rounded-lg px-3 py-2.5 shadow-2xl font-mono text-xs w-full">
            {/* Header */}
            <div className="flex items-center gap-1.5 mb-2 pb-1.5 border-b border-zinc-800/60">
                <Fuel size={11} className="text-amber-500" />
                <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">Crude Oil</span>
            </div>

            {/* Brent */}
            <div className="flex items-center justify-between mb-1">
                <span className="text-zinc-400">Brent</span>
                <div className="flex items-center gap-2">
                    <span className="text-white font-semibold">${data.brent.price.toFixed(2)}</span>
                    <span className={`text-[10px] ${changeColor(data.brent.change)}`}>
                        {formatChange(data.brent)}
                    </span>
                </div>
            </div>

            {/* WTI */}
            <div className="flex items-center justify-between mb-1">
                <span className="text-zinc-400">WTI</span>
                <div className="flex items-center gap-2">
                    <span className="text-white font-semibold">${data.wti.price.toFixed(2)}</span>
                    <span className={`text-[10px] ${changeColor(data.wti.change)}`}>
                        {formatChange(data.wti)}
                    </span>
                </div>
            </div>

            {/* Spread */}
            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/40">
                <span className="text-zinc-500 text-[10px]">Spread</span>
                <span className="text-zinc-300 text-[10px]">${data.spread.toFixed(2)}</span>
            </div>

            {/* Updated time */}
            <div className="text-[9px] text-zinc-600 mt-1 text-right">
                {new Date(data.updatedAt).toLocaleTimeString()}
            </div>
        </div>
    );
}
