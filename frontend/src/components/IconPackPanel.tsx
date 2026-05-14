'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Upload } from 'lucide-react';
import { API_URL } from '../lib/config';
import { setRuntimeIconPack, type RuntimeIconPack } from '../icons/map-icons';

type IconTarget = {
  id: string;
  group: string;
  label: string;
  layer: string;
  subtype: string;
  file: string;
};

type IconPackIcon = IconTarget & {
  scale: number;
  opacity: number;
};

type IconPack = RuntimeIconPack & {
  name: string;
  icons: Record<string, IconPackIcon>;
};

type IconPackPayload = {
  activePackId: string;
  targets: IconTarget[];
  packs: IconPack[];
};

type DraftIcon = {
  scale: string;
  opacity: string;
};

function groupTargets(targets: IconTarget[]): Array<[string, IconTarget[]]> {
  const groups = new Map<string, IconTarget[]>();
  for (const target of targets) {
    const next = groups.get(target.group) || [];
    next.push(target);
    groups.set(target.group, next);
  }
  return Array.from(groups.entries());
}

function iconUrl(pack: IconPack, icon: IconPackIcon | IconTarget): string {
  return `/icon-packs/${encodeURIComponent(pack.id)}/${encodeURIComponent(icon.file)}?v=${encodeURIComponent(String(pack.name || pack.id))}`;
}

function readSvgFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read SVG'));
    reader.readAsText(file);
  });
}

export default function IconPackPanel() {
  const [payload, setPayload] = useState<IconPackPayload | null>(null);
  const [selectedPackId, setSelectedPackId] = useState<string>('default');
  const [newPackName, setNewPackName] = useState('');
  const [drafts, setDrafts] = useState<Record<string, DraftIcon>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const activePack = useMemo(() => (
    payload?.packs.find((pack) => pack.id === payload.activePackId) || payload?.packs[0] || null
  ), [payload]);

  const selectedPack = useMemo(() => (
    payload?.packs.find((pack) => pack.id === selectedPackId) || activePack
  ), [activePack, payload, selectedPackId]);

  const load = useCallback(async () => {
    const res = await fetch(`${API_URL}/api/icon-packs`);
    if (!res.ok) throw new Error(`Icon packs failed: ${res.status}`);
    const next = await res.json() as IconPackPayload;
    setPayload(next);
    setSelectedPackId(next.activePackId);
    const nextActive = next.packs.find((pack) => pack.id === next.activePackId) || next.packs[0] || null;
    if (nextActive) setRuntimeIconPack(nextActive);
    return next;
  }, []);

  useEffect(() => {
    load().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [load]);

  useEffect(() => {
    if (!selectedPack) return;
    const nextDrafts: Record<string, DraftIcon> = {};
    for (const [id, icon] of Object.entries(selectedPack.icons || {})) {
      nextDrafts[id] = {
        scale: String(icon.scale ?? 1),
        opacity: String(icon.opacity ?? 1),
      };
    }
    setDrafts(nextDrafts);
  }, [selectedPack]);

  const reloadIfActivePack = useCallback((packId: string) => {
    if (packId === payload?.activePackId) {
      window.setTimeout(() => window.location.reload(), 250);
    }
  }, [payload?.activePackId]);

  const switchActivePack = useCallback(async (packId: string) => {
    setBusy(`active:${packId}`);
    setMessage(null);
    try {
      const res = await fetch(`${API_URL}/api/icon-packs/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });
      if (!res.ok) throw new Error(`Switch failed: ${res.status}`);
      const next = await res.json() as IconPackPayload;
      setPayload(next);
      setSelectedPackId(packId);
      const nextActive = next.packs.find((pack) => pack.id === next.activePackId);
      if (nextActive) setRuntimeIconPack(nextActive);
      setMessage('Icon pack applied');
      window.setTimeout(() => window.location.reload(), 250);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, []);

  const createPack = useCallback(async () => {
    const name = newPackName.trim();
    if (!name || !selectedPack) return;
    setBusy('create');
    setMessage(null);
    try {
      const res = await fetch(`${API_URL}/api/icon-packs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cloneFrom: selectedPack.id }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const next = await res.json() as IconPackPayload;
      setPayload(next);
      const created = next.packs.find((pack) => pack.name === name);
      setSelectedPackId(created?.id || next.activePackId);
      setNewPackName('');
      setMessage('Icon pack created');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [newPackName, selectedPack]);

  const saveIcon = useCallback(async (target: IconTarget) => {
    if (!selectedPack) return;
    const draft = drafts[target.id];
    setBusy(`save:${target.id}`);
    setMessage(null);
    try {
      const res = await fetch(`${API_URL}/api/icon-packs/${encodeURIComponent(selectedPack.id)}/icons/${encodeURIComponent(target.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scale: Number(draft?.scale ?? 1),
          opacity: Number(draft?.opacity ?? 1),
        }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      const next = await res.json() as IconPackPayload;
      setPayload(next);
      setMessage('Icon settings saved');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [drafts, selectedPack]);

  const saveAll = useCallback(async () => {
    if (!selectedPack || !payload) return;
    setBusy('save-all');
    setMessage(null);
    try {
      const icons: Record<string, { scale: number; opacity: number }> = {};
      for (const target of payload.targets) {
        const draft = drafts[target.id];
        const current = selectedPack.icons[target.id];
        icons[target.id] = {
          scale: Number(draft?.scale ?? current?.scale ?? 1),
          opacity: Number(draft?.opacity ?? current?.opacity ?? 1),
        };
      }
      const res = await fetch(`${API_URL}/api/icon-packs/${encodeURIComponent(selectedPack.id)}/icons`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ icons }),
      });
      if (!res.ok) throw new Error(`Save all failed: ${res.status}`);
      const next = await res.json() as IconPackPayload;
      setPayload(next);
      const nextActive = next.packs.find((pack) => pack.id === next.activePackId) || null;
      if (nextActive) setRuntimeIconPack(nextActive);
      setMessage('All icon settings saved');
      reloadIfActivePack(selectedPack.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [drafts, payload, reloadIfActivePack, selectedPack]);

  const uploadIcon = useCallback(async (target: IconTarget, file: File | null) => {
    if (!selectedPack || !file) return;
    setBusy(`upload:${target.id}`);
    setMessage(null);
    try {
      const svg = await readSvgFile(file);
      const res = await fetch(`${API_URL}/api/icon-packs/${encodeURIComponent(selectedPack.id)}/icons/${encodeURIComponent(target.id)}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, svg }),
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const next = await res.json() as IconPackPayload;
      setPayload(next);
      setMessage('SVG uploaded');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [selectedPack]);

  const groups = useMemo(() => groupTargets(payload?.targets || []), [payload?.targets]);

  if (!payload || !selectedPack) {
    return (
      <div className="p-3 text-sm text-zinc-400">
        Loading icon packs...
        {message ? <div className="mt-2 text-amber-300">{message}</div> : null}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 text-sm text-zinc-200">
      <div className="space-y-3 rounded border border-zinc-800 bg-black/25 p-3">
        <div className="grid gap-2">
          <label className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Active pack</label>
          <div className="flex gap-2">
            <select
              className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-sm outline-none"
              value={selectedPackId}
              onChange={(event) => setSelectedPackId(event.target.value)}
            >
              {payload.packs.map((pack) => (
                <option key={pack.id} value={pack.id}>{pack.name}</option>
              ))}
            </select>
            <button
              className="inline-flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100 disabled:opacity-50"
              disabled={busy !== null || selectedPack.id === payload.activePackId}
              onClick={() => switchActivePack(selectedPack.id)}
            >
              <Check size={14} /> Use
            </button>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-sm outline-none"
            placeholder="New icon pack name"
            value={newPackName}
            onChange={(event) => setNewPackName(event.target.value)}
          />
          <button
            className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs disabled:opacity-50"
            disabled={busy !== null || !newPackName.trim()}
            onClick={createPack}
          >
            <Copy size={14} /> Clone
          </button>
        </div>
        <button
          className="inline-flex w-full items-center justify-center gap-2 rounded border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100 disabled:opacity-50"
          disabled={busy !== null}
          onClick={saveAll}
        >
          <Check size={14} /> {busy === 'save-all' ? 'Saving all...' : 'Save All'}
        </button>
        {message ? <div className="text-xs text-zinc-400">{message}</div> : null}
      </div>

      <div className="mt-3 space-y-4">
        {groups.map(([group, targets]) => (
          <section key={group} className="space-y-2">
            <div className="sticky top-0 z-10 border-b border-zinc-800 bg-[#101014]/95 py-2 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
              {group}
            </div>
            {targets.map((target) => {
              const icon = selectedPack.icons[target.id] || target;
              const draft = drafts[target.id] || { scale: '1', opacity: '1' };
              const rowBusy = busy === `save:${target.id}` || busy === `upload:${target.id}`;
              return (
                <div key={target.id} className="grid gap-2 rounded border border-zinc-800 bg-zinc-950/60 p-2">
                  <div className="flex items-center gap-2">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-zinc-800 bg-zinc-900">
                      <img src={iconUrl(selectedPack, icon)} alt="" className="max-h-8 max-w-8" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-zinc-100">{target.label}</div>
                      <div className="truncate font-mono text-[10px] text-zinc-500">{target.id}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="grid gap-1 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                      Scale
                      <input
                        type="number"
                        min="0.05"
                        max="8"
                        step="0.05"
                        className="rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-100 outline-none"
                        value={draft.scale}
                        onChange={(event) => setDrafts((current) => ({
                          ...current,
                          [target.id]: { ...draft, scale: event.target.value },
                        }))}
                      />
                    </label>
                    <label className="grid gap-1 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                      Opacity
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        className="rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-100 outline-none"
                        value={draft.opacity}
                        onChange={(event) => setDrafts((current) => ({
                          ...current,
                          [target.id]: { ...draft, opacity: event.target.value },
                        }))}
                      />
                    </label>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300">
                      <Upload size={13} /> SVG
                      <input
                        className="hidden"
                        type="file"
                        accept=".svg,image/svg+xml"
                        onChange={(event) => {
                          const file = event.target.files?.[0] || null;
                          event.currentTarget.value = '';
                          uploadIcon(target, file);
                        }}
                      />
                    </label>
                    <button
                      className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-[11px] disabled:opacity-50"
                      disabled={rowBusy}
                      onClick={() => saveIcon(target)}
                    >
                      {rowBusy ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
