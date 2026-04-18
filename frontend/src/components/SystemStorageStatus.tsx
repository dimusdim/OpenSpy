'use client';

import { useMemo } from 'react';
import { useTimelineStore } from '../store/useTimelineStore';

function formatBytes(bytes: number | null): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return unitIndex === 0 ? `${Math.round(value)} ${units[unitIndex]}` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

export default function SystemStorageStatus() {
    const storage = useTimelineStore((s) => s.storageStatus);

    const summary = useMemo(() => {
        const db = formatBytes(storage.dbBytes);
        const free = formatBytes(storage.diskFreeBytes);
        const total = formatBytes(storage.diskTotalBytes);
        const diskUsed = storage.diskUsedPercent != null ? `${storage.diskUsedPercent.toFixed(1)}%` : '—';
        const dbShare = storage.dbPercentOfDisk != null ? `${storage.dbPercentOfDisk.toFixed(2)}%` : '—';
        return { db, free, total, diskUsed, dbShare };
    }, [storage]);

    return (
        <div className="bg-black/70 backdrop-blur-xl border border-zinc-800 rounded-lg px-3 py-2 text-[11px] font-mono text-zinc-300 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
                <span className="text-zinc-500 uppercase tracking-[0.18em]">Storage</span>
                {storage.updatedAt && (
                    <span className="text-zinc-600">
                        {new Date(storage.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                )}
            </div>
            <div className="mt-1 leading-5">
                <span className="text-zinc-500">DB</span> {summary.db}
                <span className="text-zinc-700"> • </span>
                <span className="text-zinc-500">Free</span> {summary.free}
                <span className="text-zinc-700"> / </span>
                {summary.total}
            </div>
            <div className="leading-5">
                <span className="text-zinc-500">Disk used</span> {summary.diskUsed}
                <span className="text-zinc-700"> • </span>
                <span className="text-zinc-500">DB share</span> {summary.dbShare}
            </div>
        </div>
    );
}
