'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import {
    Bot,
    Database,
    Loader2,
    MapPin,
    MessageSquare,
    Play,
    Plus,
    Send,
    Square,
    X,
} from 'lucide-react';
import { API_URL } from '../lib/config';
import { useTimelineStore } from '../store/useTimelineStore';

type ProviderInfo = {
    provider: string;
    label: string;
    command: string;
    available: boolean;
    notes?: string;
};

type AgentSession = {
    agent_session_id: string;
    provider: string;
    provider_session_id: string | null;
    status: string;
    metadata?: Record<string, any>;
    created_at: string;
    updated_at: string;
};

type AgentMessage = {
    agent_message_id: string;
    role: string;
    content: string;
    content_json?: { actions?: AgentAction[] } | null;
    created_at?: string;
    metadata?: Record<string, any>;
};

type AgentAction = {
    type: string;
    label?: string;
    payload?: Record<string, any>;
};

type AgentStreamPart = {
    id: string;
    type: 'text' | 'tool' | 'status';
    text?: string;
    eventType?: string;
    name?: string;
    state?: 'started' | 'completed' | 'status';
    isError?: boolean;
};

const ACTION_BLOCK_RE_LIST = [
    /<ACTIONS_JSON>\s*([\s\S]*?)\s*<\/ACTIONS_JSON>/i,
    /```ACTIONS_JSON\s*([\s\S]*?)\s*```/i,
    /ACTIONS_JSON:?\s*```(?:json)?\s*([\s\S]*?)\s*```/i,
];

const INTERNAL_NOISE_RE = /(bash[- ]?guard|shell guard|allowed-tools|tool plumbing|alternative entrypoint|альтернативн.*entrypoint|quoting|квотирован|single-quote|double quote|пайп|кавычк|\$\$|backend-api|eval|pid|sql\s+with\s+quotes|actions_json|об[её]ртка|сыр(ой|ого)\s+sql|запускаю без них|посмотрю, как|api трактует bbox|возвращ[её]нные результаты пришли|перезапрос с правильным порядком|^понятно:?$|^понимаю проблему:?$|^изучаю\b|^анализирую\b|^смотрю\b|^проверяю\b|^получаю\b|^создаю\b|^готовлю\b|^проверю history-плотность|^готовлю отч[её]т|^i have clear coverage\.?$|^let me\b|^now i\b|^i'll\b|^i will\b|^i need\b|^next\b.*\b(check|query|build|create)\b|^got\b.*\bcoverage\b)/i;
const HIDDEN_PROVIDER_TOOL_NAMES = new Set([
    'read',
    'write',
    'edit',
    'multiedit',
    'glob',
    'grep',
    'todowrite',
    'toolsearch',
    'webfetch',
    'websearch',
    'notebookedit',
]);

const LAYER_KEY_ALIASES: Record<string, string> = {
    aircraft: 'aviation',
    aviation: 'aviation',
    vessel: 'maritime',
    vessels: 'maritime',
    maritime: 'maritime',
    satellite: 'satellites',
    satellites: 'satellites',
    satelliteFootprints: 'satelliteFootprints',
    satellite_footprints: 'satelliteFootprints',
    fire: 'fires',
    fires: 'fires',
    outage: 'outages',
    outages: 'outages',
    conflict: 'conflicts',
    conflicts: 'conflicts',
    pipeline: 'pipelines',
    pipelines: 'pipelines',
    cable: 'cables',
    cables: 'cables',
    webcam: 'webcams',
    webcams: 'webcams',
    border: 'labels',
    borders: 'labels',
    labels: 'labels',
    imagery: 'satellite_imagery',
    satellite_imagery: 'satellite_imagery',
    infrastructure: 'infrastructure',
    airspace: 'airspace',
    disasters: 'disasters',
    jamming: 'jamming',
    gfw: 'gfw',
    wifi: 'wifi',
    clouds: 'clouds',
    traffic: 'traffic',
};

const LEGEND_NODE_ALIASES: Record<string, string> = {
    air: 'air',
    aviation: 'air/aircraft',
    aircraft: 'air/aircraft',
    airspace: 'air/airspace',
    jamming: 'air/jamming',
    gnss_jamming: 'air/jamming',
    electronic_warfare: 'air/jamming',
    sea: 'maritime',
    maritime: 'maritime',
    vessel: 'maritime/vessels',
    vessels: 'maritime/vessels',
    satellite: 'space/satellites',
    satellites: 'space/satellites',
    fires: 'ground-events/fires',
    fire: 'ground-events/fires',
    conflict: 'ground-events/conflicts',
    conflicts: 'ground-events/conflicts',
    disasters: 'ground-events/disasters',
    infrastructure: 'infrastructure',
    pipelines: 'infrastructure/oil-gas/pipelines',
    pipeline: 'infrastructure/oil-gas/pipelines',
    cables: 'infrastructure/telecom-infra/cables',
    cable: 'infrastructure/telecom-infra/cables',
    wifi: 'connectivity/wifi',
    outages: 'connectivity/outages',
    outage: 'connectivity/outages',
};

const AGENT_ENTITY_PREFIX = 'agent-';

type AgentPanelProps = {
    isOpen: boolean;
    onClose: () => void;
};

function providerLabel(provider: string, providers: ProviderInfo[]): string {
    return providers.find((item) => item.provider === provider)?.label || provider;
}

function normalizeMessages(rows: any[]): AgentMessage[] {
    return rows.map((row) => ({
        agent_message_id: row.agent_message_id,
        role: row.role,
        content: row.content || '',
        content_json: row.content_json || null,
        created_at: row.created_at,
        metadata: row.metadata || {},
    }));
}

function getActionIcon(type: string) {
    if (type.startsWith('replay.')) return <Play size={13} />;
    if (type.startsWith('map.')) return <MapPin size={13} />;
    if (type.startsWith('selection.')) return <Database size={13} />;
    return <Bot size={13} />;
}

function cleanVisibleText(text: string): string {
    const withBreaks = text
        .replace(/H3-хексов/gi, 'H3-зон')
        .replace(/H3-хексы/gi, 'H3-зоны')
        .replace(/H3-хекс/gi, 'H3-зона')
        .replace(/хексов/gi, 'зон')
        .replace(/хексы/gi, 'зоны')
        .replace(/хекс/gi, 'зона')
        .replace(/(Bash guard|bash-guard|AI Worldview bash guard)/gi, '\n$1')
        .replace(/(Понятно: bash|Понимаю проблему: bash|Используем структурные команды CLI|Важное открытие: API трактует bbox)/gi, '\n$1')
        .replace(/(Теперь смотрю|Получил реальные|Сводка:|###|##|- )/g, '\n$1');
    return withBreaks
        .replace(/(\|[^\n]*\|)\n\s*\n(?=\s*\|)/g, '$1\n')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => !line || !INTERNAL_NOISE_RE.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function cleanToolName(name?: string): string {
    const raw = String(name || '').trim();
    if (!raw || /^toolu_[a-z0-9]+$/i.test(raw)) return 'AI Worldview tool';
    if (raw === 'Bash') return 'AI Worldview command';
    return raw;
}

function isHiddenToolName(name?: string): boolean {
    return HIDDEN_PROVIDER_TOOL_NAMES.has(String(name || '').trim().toLowerCase());
}

function formatActionType(type: string): string {
    const labels: Record<string, string> = {
        'map.fly_to': 'Move map',
        'map.highlight': 'Highlight',
        'map.annotate': 'Annotate',
        'map.add_aoi': 'Show area',
        'map.add_corridor': 'Show corridor',
        'map.clear_agent_overlays': 'Clear overlays',
        'legend.set_node_state': 'Set legend',
        'map.set_layers': 'Set layers',
        'view.patch': 'Set view',
        'object.open': 'Open object',
        'object.focus': 'Focus object',
        'entity.open': 'Open entity',
        'selection.apply': 'Apply selection',
        'selection.clear': 'Clear selection',
        'replay.seek': 'Seek replay',
        'replay.play_window': 'Play replay',
        'replay.set_speed': 'Set speed',
        'replay.follow_entity': 'Follow entity',
    };
    return labels[type] || type.replace(/[._]/g, ' ');
}

function actionLabel(action: AgentAction, idx: number): string {
    return action.label || `${idx + 1}. ${formatActionType(action.type)}`;
}

function inlineMarkdown(text: string): Array<string | JSX.Element> {
    const nodes: Array<string | JSX.Element> = [];
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        const token = match[0];
        if (token.startsWith('`')) {
            nodes.push(<code key={`code-${match.index}`} className="rounded bg-zinc-900 px-1 py-0.5 text-[11px] text-cyan-200">{token.slice(1, -1)}</code>);
        } else {
            nodes.push(<strong key={`strong-${match.index}`} className="font-semibold text-zinc-100">{token.slice(2, -2)}</strong>);
        }
        cursor = match.index + token.length;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
}

function MarkdownBlock({ text }: { text: string }) {
    const cleaned = cleanVisibleText(text);
    if (!cleaned) return null;
    const lines = cleaned.split(/\n/);
    const blocks: JSX.Element[] = [];
    let listItems: string[] = [];
    const flushList = () => {
        if (listItems.length === 0) return;
        const items = listItems;
        listItems = [];
        blocks.push(
            <ul key={`list-${blocks.length}`} className="my-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-zinc-300">
                {items.map((item, idx) => (
                    <li key={`${item}-${idx}`}>{inlineMarkdown(item)}</li>
                ))}
            </ul>,
        );
    };
    const parseTableRow = (line: string) => line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
    const isTableSeparator = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const rawLine = lines[lineIndex];
        const line = rawLine.trim();
        if (!line) {
            flushList();
            continue;
        }
        if (line.startsWith('|') && lines[lineIndex + 1] && isTableSeparator(lines[lineIndex + 1].trim())) {
            flushList();
            const header = parseTableRow(line);
            lineIndex += 2;
            const rows: string[][] = [];
            while (lineIndex < lines.length && lines[lineIndex].trim().startsWith('|')) {
                rows.push(parseTableRow(lines[lineIndex].trim()));
                lineIndex += 1;
            }
            lineIndex -= 1;
            blocks.push(
                <div key={`table-${blocks.length}`} className="my-2 overflow-x-auto rounded border border-zinc-800">
                    <table className="min-w-full border-collapse text-left text-[10px] text-zinc-300">
                        <thead className="bg-zinc-900/80 text-zinc-100">
                            <tr>
                                {header.map((cell, idx) => (
                                    <th key={`${cell}-${idx}`} className="border-b border-zinc-800 px-2 py-1 font-semibold">
                                        {inlineMarkdown(cell)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, rowIdx) => (
                                <tr key={`row-${rowIdx}`} className="odd:bg-zinc-950/80 even:bg-zinc-900/30">
                                    {row.map((cell, cellIdx) => (
                                        <td key={`${cell}-${cellIdx}`} className="border-t border-zinc-900 px-2 py-1 align-top">
                                            {inlineMarkdown(cell)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>,
            );
            continue;
        }
        const bullet = line.match(/^[-*]\s+(.+)$/);
        if (bullet) {
            listItems.push(bullet[1]);
            continue;
        }
        flushList();
        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
            blocks.push(
                <div key={`h-${blocks.length}`} className="mt-2 text-[12px] font-semibold text-zinc-100">
                    {inlineMarkdown(heading[2])}
                </div>,
            );
            continue;
        }
        blocks.push(
            <p key={`p-${blocks.length}`} className="my-1 text-xs leading-relaxed text-zinc-300">
                {inlineMarkdown(line)}
            </p>,
        );
    }
    flushList();
    return <>{blocks}</>;
}

function displayPartsForMessage(message: AgentMessage, runningRunId: string | null): AgentStreamPart[] {
    const parts = streamPartsFromMetadata(message.metadata)
        .filter((part) => part.type !== 'tool' || !isHiddenToolName(part.name));
    if (parts.length === 0) return [];
    const isFinal = message.role === 'assistant'
        && message.agent_message_id !== `run:${runningRunId || ''}`;
    if (!isFinal) return parts;
    return parts.filter((part) => part.type !== 'tool' || part.state !== 'started');
}

function groupStreamParts(parts: AgentStreamPart[]): Array<{ type: 'text'; part: AgentStreamPart } | { type: 'tools'; parts: AgentStreamPart[] }> {
    const groups: Array<{ type: 'text'; part: AgentStreamPart } | { type: 'tools'; parts: AgentStreamPart[] }> = [];
    let toolGroup: AgentStreamPart[] = [];
    const flushTools = () => {
        if (toolGroup.length === 0) return;
        groups.push({ type: 'tools', parts: toolGroup });
        toolGroup = [];
    };
    for (const part of parts) {
        if (part.type === 'text') {
            flushTools();
            groups.push({ type: 'text', part });
        } else {
            toolGroup.push(part);
        }
    }
    flushTools();
    return groups;
}

function ToolGroup({ parts }: { parts: AgentStreamPart[] }) {
    const completed = parts.filter((part) => part.state === 'completed' && !part.isError).length;
    const running = parts.filter((part) => part.state === 'started').length;
    if (completed === 0 && running === 0) return null;
    const summary = [
        completed > 0 ? `${completed} completed` : '',
        running > 0 ? `${running} running` : '',
    ].filter(Boolean).join(', ') || `${parts.length} calls`;
    return (
        <details className="my-1 rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[10px] font-mono text-zinc-500">
            <summary className="cursor-pointer select-none text-zinc-400">
                Tools: {summary}
            </summary>
            <div className="mt-1 space-y-1">
                {parts.filter((part) => !part.isError || part.state !== 'completed').map((part) => (
                    <div
                        key={part.id}
                        className={`flex items-center gap-1.5 rounded border px-2 py-1 ${
                            part.isError
                                ? 'border-red-950/60 bg-red-950/15 text-red-300'
                                : part.state === 'started'
                                    ? 'border-zinc-800 bg-zinc-900/60 text-zinc-400'
                                    : 'border-cyan-950/70 bg-cyan-950/15 text-cyan-300'
                        }`}
                    >
                        <Database size={12} />
                        <span className="truncate">
                            {part.state === 'started' ? 'Started' : part.isError ? 'Failed' : 'Completed'}: {cleanToolName(part.name)}
                        </span>
                    </div>
                ))}
            </div>
        </details>
    );
}

function streamPartsFromMetadata(metadata: Record<string, any> | undefined): AgentStreamPart[] {
    return Array.isArray(metadata?.streamParts) ? metadata.streamParts : [];
}

function findActionBlockStart(content: string): number {
    let first = -1;
    for (const pattern of ACTION_BLOCK_RE_LIST) {
        const match = content.match(pattern);
        if (match && typeof match.index === 'number') {
            first = first === -1 ? match.index : Math.min(first, match.index);
        }
    }
    return first;
}

function trimTrailingText(parts: AgentStreamPart[]): AgentStreamPart[] {
    const next = [...parts];
    for (let idx = next.length - 1; idx >= 0; idx -= 1) {
        const part = next[idx];
        if (part.type !== 'text') continue;
        const trimmed = (part.text || '').replace(/\s+$/g, '');
        if (trimmed) {
            next[idx] = { ...part, text: trimmed };
            return next;
        }
        next.splice(idx, 1);
    }
    return next;
}

function finalizeStreamParts(
    metadata: Record<string, any> | undefined,
    finalContent: string | undefined,
): Record<string, any> {
    const parts = streamPartsFromMetadata(metadata);
    if (parts.length === 0) return metadata || {};
    const rawText = parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text || '')
        .join('');
    const actionStart = findActionBlockStart(rawText);
    if (actionStart < 0) return metadata || {};

    let remainingText = actionStart;
    const visibleParts: AgentStreamPart[] = [];
    for (const part of parts) {
        if (part.type !== 'text') {
            if (remainingText > 0) visibleParts.push(part);
            continue;
        }
        const text = part.text || '';
        if (remainingText <= 0) continue;
        const visibleText = text.slice(0, remainingText);
        remainingText = Math.max(0, remainingText - text.length);
        if (visibleText) visibleParts.push({ ...part, text: visibleText });
    }

    const cleanedParts = trimTrailingText(visibleParts);
    if (cleanedParts.length === 0 && finalContent) {
        cleanedParts.push({
            id: `text:${Date.now()}:final`,
            type: 'text',
            text: finalContent,
        });
    }
    return {
        ...(metadata || {}),
        streamParts: cleanedParts,
    };
}

function appendTextPart(metadata: Record<string, any> | undefined, text: string): Record<string, any> {
    const parts = [...streamPartsFromMetadata(metadata)];
    const last = parts[parts.length - 1];
    if (last?.type === 'text') {
        parts[parts.length - 1] = {
            ...last,
            text: `${last.text || ''}${text}`,
        };
    } else {
        parts.push({
            id: `text:${Date.now()}:${Math.random().toString(16).slice(2)}`,
            type: 'text',
            text,
        });
    }
    return {
        ...(metadata || {}),
        streamParts: parts,
    };
}

function appendEventPart(
    metadata: Record<string, any> | undefined,
    eventType: string,
    payload: Record<string, any>,
): Record<string, any> {
    const isTool = eventType === 'tool.started' || eventType === 'tool.completed';
    const state = eventType === 'tool.started'
        ? 'started'
        : eventType === 'tool.completed'
            ? 'completed'
            : 'status';
    const name = String(payload.name || payload.raw_type || (isTool ? 'tool' : 'status'));
    if (isTool && isHiddenToolName(name)) return metadata || {};
    const message = eventType === 'status.updated'
        ? String(payload.message || payload.raw_type || 'status')
        : `${state === 'started' ? 'started' : 'completed'} ${name}`;
    return {
        ...(metadata || {}),
        streamParts: [
            ...streamPartsFromMetadata(metadata),
            {
                id: `${eventType}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
                type: isTool ? 'tool' : 'status',
                eventType,
                name,
                state,
                isError: Boolean(payload.is_error),
                text: message,
            } satisfies AgentStreamPart,
        ],
    };
}

function getViewer(): Cesium.Viewer | null {
    const viewer = (window as any).viewerContext as Cesium.Viewer | undefined;
    if (!viewer || viewer.isDestroyed()) return null;
    return viewer;
}

function normalizeLayerKey(layer: any): string | null {
    const raw = String(layer || '').trim();
    if (!raw) return null;
    return LAYER_KEY_ALIASES[raw] || LAYER_KEY_ALIASES[raw.replace(/-/g, '_')] || null;
}

function normalizeLegendNodeId(node: any): string {
    const raw = String(node || '').trim();
    if (!raw) return '';
    const key = raw.replace(/-/g, '_').toLowerCase();
    return LEGEND_NODE_ALIASES[key] || raw;
}

function typeForLayer(layer: any): string {
    const key = normalizeLayerKey(layer) || String(layer || '').trim();
    if (key === 'aviation') return 'Aircraft';
    if (key === 'maritime') return 'Vessel';
    if (key === 'satellites') return 'Satellite';
    if (key === 'cables') return 'Cable';
    if (key === 'pipelines') return 'Pipeline';
    if (key === 'airspace') return 'Airspace';
    if (key === 'fires') return 'Fire';
    if (key === 'wifi') return 'WiFi';
    if (key === 'webcams') return 'Webcam';
    if (key === 'infrastructure') return 'Infrastructure';
    return key || 'Object';
}

function toBoolean(value: any): boolean {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').toLowerCase());
}

function normalizeFlagPatch(value: any): Record<string, boolean> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const patch: Record<string, boolean> = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
        const key = normalizeLayerKey(rawKey);
        if (key) patch[key] = toBoolean(rawValue);
    }
    return patch;
}

function applyViewStateToStore(viewState: any): void {
    if (!viewState || typeof viewState !== 'object') return;
    const current = useTimelineStore.getState();
    const patch: Record<string, any> = {};
    if (viewState.sources && typeof viewState.sources === 'object') {
        patch.sources = { ...current.sources, ...normalizeFlagPatch(viewState.sources) };
    }
    if (viewState.visibility && typeof viewState.visibility === 'object') {
        patch.visibility = { ...current.visibility, ...normalizeFlagPatch(viewState.visibility) };
    }
    if (viewState.subtypeVisibility && typeof viewState.subtypeVisibility === 'object') {
        patch.subtypeVisibility = { ...current.subtypeVisibility, ...viewState.subtypeVisibility };
    }
    if (viewState.sourceVisibility && typeof viewState.sourceVisibility === 'object') {
        patch.sourceVisibility = { ...current.sourceVisibility, ...viewState.sourceVisibility };
    }
    if (typeof viewState.showTrajectories === 'boolean') patch.showTrajectories = viewState.showTrajectories;
    if (typeof viewState.clusteringEnabled === 'boolean') patch.clusteringEnabled = viewState.clusteringEnabled;
    if (typeof viewState.activePreset === 'string' || viewState.activePreset === null) patch.activePreset = viewState.activePreset;
    if (typeof viewState.activeIconSet === 'string') patch.activeIconSet = viewState.activeIconSet;
    if (typeof viewState.tileMode === 'string') patch.tileMode = viewState.tileMode;
    if (Object.keys(patch).length > 0) {
        useTimelineStore.setState(patch as any);
    }
}

function buildLayerPatch(payload: Record<string, any>): Record<string, any> {
    const patch: Record<string, any> = {};
    const sources = normalizeFlagPatch(payload.sources);
    const visibility = normalizeFlagPatch(payload.visibility);
    if (Object.keys(sources).length > 0) patch.sources = sources;
    if (Object.keys(visibility).length > 0) patch.visibility = visibility;

    const items = Array.isArray(payload.layers) ? payload.layers : [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const layerKey = normalizeLayerKey(item.layer || item.layer_id || item.id);
        if (!layerKey) continue;
        const target = item.target === 'sources' || item.source === true ? 'sources' : 'visibility';
        patch[target] = { ...(patch[target] || {}), [layerKey]: toBoolean(item.enabled) };
    }

    const singleLayer = normalizeLayerKey(payload.layer || payload.layer_id);
    if (singleLayer) {
        const target = payload.target === 'sources' || payload.source === true ? 'sources' : 'visibility';
        patch[target] = { ...(patch[target] || {}), [singleLayer]: toBoolean(payload.enabled ?? true) };
    }

    if (payload.subtypeVisibility && typeof payload.subtypeVisibility === 'object') {
        patch.subtypeVisibility = payload.subtypeVisibility;
    }
    if (payload.sourceVisibility && typeof payload.sourceVisibility === 'object') {
        patch.sourceVisibility = payload.sourceVisibility;
    }
    return patch;
}

function colorFromPayload(value: any, fallback: Cesium.Color): Cesium.Color {
    const key = String(value || '').toLowerCase();
    if (key === 'yellow') return Cesium.Color.YELLOW;
    if (key === 'orange') return Cesium.Color.ORANGE;
    if (key === 'red') return Cesium.Color.RED;
    if (key === 'green') return Cesium.Color.LIME;
    if (key === 'blue') return Cesium.Color.CYAN;
    if (key === 'white') return Cesium.Color.WHITE;
    if (/^#[0-9a-f]{6}$/i.test(key)) return Cesium.Color.fromCssColorString(key);
    return fallback;
}

function bboxToDegreesArray(bbox: any): number[] | null {
    if (Array.isArray(bbox) && bbox.length >= 4) {
        return bbox.slice(0, 4).map(Number);
    }
    if (bbox && typeof bbox === 'object') {
        const west = Number(bbox.west ?? bbox.minLng ?? bbox.min_lng ?? bbox.lng_min);
        const south = Number(bbox.south ?? bbox.minLat ?? bbox.min_lat ?? bbox.lat_min);
        const east = Number(bbox.east ?? bbox.maxLng ?? bbox.max_lng ?? bbox.lng_max);
        const north = Number(bbox.north ?? bbox.maxLat ?? bbox.max_lat ?? bbox.lat_max);
        if ([west, south, east, north].every(Number.isFinite)) return [west, south, east, north];
    }
    return null;
}

function normalizeCoordinatePair(value: any): [number, number] | null {
    if (!Array.isArray(value) || value.length < 2) return null;
    const lng = Number(value[0]);
    const lat = Number(value[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return [lng, lat];
}

function normalizeCoordinates(value: any): [number, number][] {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeCoordinatePair).filter((item): item is [number, number] => Boolean(item));
}

function centerOfCoordinates(coords: [number, number][]): { lat: number; lng: number } | null {
    if (coords.length === 0) return null;
    const sum = coords.reduce((acc, [lng, lat]) => ({ lng: acc.lng + lng, lat: acc.lat + lat }), { lat: 0, lng: 0 });
    return { lat: sum.lat / coords.length, lng: sum.lng / coords.length };
}

function drawPointOrLabel(
    viewer: Cesium.Viewer,
    payload: Record<string, any>,
    label: string,
    color: Cesium.Color,
): void {
    const lat = Number(payload.lat ?? payload.latitude);
    const lng = Number(payload.lng ?? payload.lon ?? payload.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Point action requires lat and lng');
    viewer.entities.add({
        id: `${AGENT_ENTITY_PREFIX}annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        position: Cesium.Cartesian3.fromDegrees(lng, lat, Number(payload.height || 0)),
        point: {
            pixelSize: Number(payload.pixelSize || 12),
            color: color.withAlpha(0.9),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
            text: String(payload.label || payload.text || label || 'Agent note'),
            font: '12px monospace',
            pixelOffset: new Cesium.Cartesian2(0, -24),
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
    });
}

function drawGeometryOverlay(
    viewer: Cesium.Viewer,
    payload: Record<string, any>,
    label: string,
): void {
    const color = colorFromPayload(payload.color, Cesium.Color.CYAN);
    const fill = color.withAlpha(Number(payload.fillAlpha ?? payload.fill_alpha ?? 0.16));
    const outline = color.withAlpha(Number(payload.outlineAlpha ?? payload.outline_alpha ?? 0.85));
    const id = `${AGENT_ENTITY_PREFIX}overlay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rawGeometry = payload.geojson || payload.geometry;
    const geojson = rawGeometry?.type === 'Feature' ? rawGeometry.geometry : rawGeometry;

    const bbox = bboxToDegreesArray(payload.bbox || geojson?.bbox || payload);
    if (bbox) {
        const [west, south, east, north] = bbox;
        const coords: [number, number][] = [[west, south], [east, south], [east, north], [west, north]];
        viewer.entities.add({
            id,
            polygon: {
                hierarchy: Cesium.Cartesian3.fromDegreesArray(coords.flat()),
                material: fill,
                outline: true,
                outlineColor: outline,
                height: Number(payload.height || 0),
            },
        });
        const center = centerOfCoordinates(coords);
        if (center && (payload.label || payload.text || label)) {
            drawPointOrLabel(viewer, { ...payload, ...center, pixelSize: 6 }, label, color);
        }
        return;
    }

    const circle = payload.circle && typeof payload.circle === 'object' ? payload.circle : null;
    const center = circle?.center || payload.center;
    if (center || payload.radius_m || payload.radiusMeters) {
        const pair = Array.isArray(center) ? normalizeCoordinatePair(center) : null;
        const lng = Number(payload.lng ?? payload.lon ?? payload.longitude ?? circle?.lng ?? circle?.lon ?? pair?.[0]);
        const lat = Number(payload.lat ?? payload.latitude ?? circle?.lat ?? pair?.[1]);
        const radius = Number(payload.radius_m ?? payload.radiusMeters ?? circle?.radius_m ?? circle?.radiusMeters);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) {
            throw new Error('Circle overlay requires center lat/lng and positive radius_m');
        }
        viewer.entities.add({
            id,
            position: Cesium.Cartesian3.fromDegrees(lng, lat),
            ellipse: {
                semiMajorAxis: radius,
                semiMinorAxis: radius,
                material: fill,
                outline: true,
                outlineColor: outline,
            },
        });
        if (payload.label || payload.text || label) drawPointOrLabel(viewer, { ...payload, lat, lng, pixelSize: 6 }, label, color);
        return;
    }

    const geometryType = String(payload.geometry_type || payload.type || geojson?.type || '').toLowerCase();
    const rawCoordinates = payload.coordinates || geojson?.coordinates || [];
    const lineCoordinates = geometryType.includes('line')
        ? normalizeCoordinates(Array.isArray(rawCoordinates?.[0]?.[0]) ? rawCoordinates[0] : rawCoordinates)
        : [];
    if (lineCoordinates.length >= 2) {
        viewer.entities.add({
            id,
            polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray(lineCoordinates.flat()),
                width: Number(payload.width || 4),
                material: outline,
                clampToGround: payload.clampToGround !== false,
            },
        });
        const lineCenter = centerOfCoordinates(lineCoordinates);
        if (lineCenter && (payload.label || payload.text || label)) {
            drawPointOrLabel(viewer, { ...payload, ...lineCenter, pixelSize: 6 }, label, color);
        }
        return;
    }

    const polygonCoordinates = geometryType.includes('polygon')
        ? normalizeCoordinates(Array.isArray(rawCoordinates?.[0]) ? rawCoordinates[0] : rawCoordinates)
        : normalizeCoordinates(payload.polygon || []);
    if (polygonCoordinates.length >= 3) {
        viewer.entities.add({
            id,
            polygon: {
                hierarchy: Cesium.Cartesian3.fromDegreesArray(polygonCoordinates.flat()),
                material: fill,
                outline: true,
                outlineColor: outline,
                height: Number(payload.height || 0),
            },
        });
        const polygonCenter = centerOfCoordinates(polygonCoordinates);
        if (polygonCenter && (payload.label || payload.text || label)) {
            drawPointOrLabel(viewer, { ...payload, ...polygonCenter, pixelSize: 6 }, label, color);
        }
        return;
    }

    drawPointOrLabel(viewer, payload, label, color);
}

function runCursorKey(runId: string): string {
    return `aiw:agent-run-cursor:${runId}`;
}

function readRunCursor(runId: string): number {
    try {
        const value = Number(window.sessionStorage.getItem(runCursorKey(runId)) || '0');
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
        return 0;
    }
}

function writeRunCursor(runId: string, sequence: number): void {
    if (!Number.isFinite(sequence) || sequence <= 0) return;
    try {
        window.sessionStorage.setItem(runCursorKey(runId), String(Math.floor(sequence)));
    } catch {
        // Session storage is best-effort; SSE remains correct without it.
    }
}

let historicalPlaybackRequestId = 0;
let pendingHistoricalPlaybackStart = false;
let historicalPlaybackResumeTimer: number | null = null;

function cancelPendingHistoricalPlayback(): void {
    historicalPlaybackRequestId += 1;
    pendingHistoricalPlaybackStart = false;
    if (historicalPlaybackResumeTimer) {
        window.clearTimeout(historicalPlaybackResumeTimer);
        historicalPlaybackResumeTimer = null;
    }
}

function startHistoricalPlaybackWhenReady(timeoutMs = 900_000, stableMs = 500): void {
    const requestId = ++historicalPlaybackRequestId;
    pendingHistoricalPlaybackStart = true;
    if (historicalPlaybackResumeTimer) {
        window.clearTimeout(historicalPlaybackResumeTimer);
        historicalPlaybackResumeTimer = null;
    }

    const startedAt = performance.now();
    let stableSince = 0;

    const finish = () => {
        if (requestId === historicalPlaybackRequestId) pendingHistoricalPlaybackStart = false;
        if (historicalPlaybackResumeTimer) {
            window.clearTimeout(historicalPlaybackResumeTimer);
            historicalPlaybackResumeTimer = null;
        }
    };

    const tick = () => {
        if (requestId !== historicalPlaybackRequestId) return;
        const state = useTimelineStore.getState();
        if (state.mode !== 'playback' || state.playbackKind !== 'historical') {
            finish();
            return;
        }
        if (!state.replayHydrating) {
            if (!state.isPlaying) {
                stableSince = 0;
                state.setIsPlaying(true);
                document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action: 'play' } }));
            } else {
                stableSince = stableSince || performance.now();
                if (performance.now() - stableSince >= stableMs) {
                    finish();
                    return;
                }
            }
        } else {
            stableSince = 0;
        }
        if (performance.now() - startedAt >= timeoutMs) {
            finish();
            return;
        }
        historicalPlaybackResumeTimer = window.setTimeout(tick, 100);
    };

    tick();
}

function shouldResumeHistoricalPlaybackAfterViewChange(state: ReturnType<typeof useTimelineStore.getState>): boolean {
    return state.mode === 'playback'
        && state.playbackKind === 'historical'
        && (state.isPlaying || pendingHistoricalPlaybackStart);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function presentationDelayForAction(action: AgentAction): number {
    const payload = normalizedActionPayload(action);
    const explicitDelay = Number(payload.presentation_ms ?? payload.presentationMs ?? payload.duration_ms ?? payload.durationMs);
    if (Number.isFinite(explicitDelay) && explicitDelay >= 0) return Math.min(explicitDelay, 120_000);
    if (action.type === 'replay.play_window') return 3000;
    if (action.type === 'map.fly_to' || action.type === 'object.open' || action.type === 'object.focus' || action.type === 'entity.open') return 1200;
    if (action.type.startsWith('selection.')) return 700;
    return 500;
}

function normalizedActionPayload(action: AgentAction): Record<string, any> {
    const payload: Record<string, any> = {
        ...((action.payload && typeof action.payload === 'object') ? action.payload : {}),
    };
    for (const [key, value] of Object.entries(action as any)) {
        if (key === 'type' || key === 'label' || key === 'payload') continue;
        if (payload[key] === undefined) payload[key] = value;
    }
    if (payload.label === undefined && action.label) payload.label = action.label;
    if (Array.isArray(payload.center) && payload.center.length >= 2) {
        payload.lng = payload.lng ?? payload.lon ?? payload.longitude ?? payload.center[0];
        payload.lat = payload.lat ?? payload.latitude ?? payload.center[1];
    }
    if (payload.layers && typeof payload.layers === 'object' && !Array.isArray(payload.layers)) {
        payload.visibility = payload.visibility || payload.layers;
    }
    if (payload.selectionId && !payload.selection_id) payload.selection_id = payload.selectionId;
    if (!payload.layer && Array.isArray(payload.entities) && payload.entities[0]?.layer) {
        payload.layer = payload.entities[0].layer;
    }
    if (payload.title && !payload.label) payload.label = payload.title;
    if (payload.body && !payload.text) payload.text = payload.body;
    const style = payload.style && typeof payload.style === 'object' ? payload.style : null;
    if (style?.stroke && !payload.color) payload.color = style.stroke;
    if (style?.fill && !payload.fill) payload.fill = style.fill;
    return payload;
}

export function AgentToggle({ onClick }: { onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            title="Local agents"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-mono rounded-lg border shadow-2xl backdrop-blur-xl transition-colors bg-black/80 text-zinc-500 hover:text-zinc-300 border-zinc-800"
        >
            <MessageSquare size={14} />
            <span>Agents</span>
        </button>
    );
}

export default function AgentPanel({ isOpen, onClose }: AgentPanelProps) {
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [sessions, setSessions] = useState<AgentSession[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [messagesBySession, setMessagesBySession] = useState<Record<string, AgentMessage[]>>({});
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(false);
    const [runningRunsBySession, setRunningRunsBySession] = useState<Record<string, string>>({});
    const [actionsBySession, setActionsBySession] = useState<Record<string, AgentAction[]>>({});
    const [runningPresentationKey, setRunningPresentationKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedProvider, setSelectedProvider] = useState('claude_code');
    const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());
    const runCursorsRef = useRef<Map<string, number>>(new Map());
    const toolNamesByRunRef = useRef<Map<string, Map<string, string>>>(new Map());
    const runningRunsRef = useRef<Record<string, string>>({});
    const activeSessionIdRef = useRef<string | null>(null);

    const activeSession = useMemo(
        () => sessions.find((session) => session.agent_session_id === activeSessionId) || null,
        [activeSessionId, sessions],
    );
    const messages = activeSessionId ? (messagesBySession[activeSessionId] || []) : [];
    const latestActions = activeSessionId ? (actionsBySession[activeSessionId] || []) : [];
    const messageActionsVisible = messages.some((message) => Array.isArray(message.content_json?.actions) && message.content_json.actions.length > 0);
    const runningRunId = activeSessionId ? (runningRunsBySession[activeSessionId] || null) : null;

    const availableProviders = providers.filter((provider) => provider.available);
    const defaultProvider = availableProviders[0]?.provider || 'claude_code';

    useEffect(() => {
        runningRunsRef.current = runningRunsBySession;
    }, [runningRunsBySession]);

    useEffect(() => {
        activeSessionIdRef.current = activeSessionId;
    }, [activeSessionId]);

    useEffect(() => {
        if (availableProviders.length === 0) return;
        if (!availableProviders.some((provider) => provider.provider === selectedProvider)) {
            setSelectedProvider(availableProviders[0].provider);
        }
    }, [availableProviders, selectedProvider]);

    const loadProviders = useCallback(async () => {
        const response = await fetch(`${API_URL}/api/agents/providers`);
        const json = await response.json();
        setProviders(Array.isArray(json.data) ? json.data : []);
    }, []);

    const loadSessions = useCallback(async () => {
        const response = await fetch(`${API_URL}/api/agents/sessions`);
        const json = await response.json();
        const rows = Array.isArray(json.data) ? json.data : [];
        setSessions(rows);
        setActiveSessionId((current) => current || rows[0]?.agent_session_id || null);
    }, []);

    const loadMessages = useCallback(async (sessionId: string) => {
        const response = await fetch(`${API_URL}/api/agents/sessions/${encodeURIComponent(sessionId)}/messages`);
        const json = await response.json();
        const persisted = normalizeMessages(json.data?.messages || []);
        const lastPersistedActions = [...persisted]
            .reverse()
            .find((message) => Array.isArray(message.content_json?.actions) && message.content_json.actions.length > 0)
            ?.content_json?.actions || [];
        if (lastPersistedActions.length > 0) {
            setActionsBySession((current) => ({
                ...current,
                [sessionId]: lastPersistedActions,
            }));
        }
        const activeRunId = runningRunsRef.current[sessionId]
            || (typeof json.data?.session?.metadata?.activeRunId === 'string' ? json.data.session.metadata.activeRunId : '');
        setMessagesBySession((current) => {
            const existing = current[sessionId] || [];
            const existingById = new Map(existing.map((message) => [message.agent_message_id, message]));
            const activePlaceholder = activeRunId
                ? existing.find((message) => message.agent_message_id === `run:${activeRunId}`) || {
                    agent_message_id: `run:${activeRunId}`,
                    role: 'assistant',
                    content: '',
                    metadata: { run_id: activeRunId, reattached: true },
                }
                : null;
            const next = persisted.map((message) => {
                const previous = existingById.get(message.agent_message_id);
                if (!previous) return message;
                return {
                    ...message,
                    content: message.content || previous.content,
                    content_json: message.content_json || previous.content_json || null,
                    metadata: {
                        ...(previous.metadata || {}),
                        ...(message.metadata || {}),
                    },
                };
            });
            for (const message of existing) {
                const alreadyPersisted = next.some((item) => item.agent_message_id === message.agent_message_id);
                if (alreadyPersisted) continue;
                if (message.agent_message_id.startsWith('run:') || message.agent_message_id.startsWith('local:')) {
                    next.push(message);
                }
            }
            if (activePlaceholder && !next.some((message) => message.agent_message_id === activePlaceholder.agent_message_id)) {
                next.push(activePlaceholder);
            }
            return {
                ...current,
                [sessionId]: next,
            };
        });
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        setError(null);
        void Promise.all([loadProviders(), loadSessions()]).catch((err) => {
            setError(err instanceof Error ? err.message : 'Failed to load agents');
        });
    }, [isOpen, loadProviders, loadSessions]);

    useEffect(() => {
        if (!activeSessionId || !isOpen) return;
        void loadMessages(activeSessionId).catch((err) => {
            setError(err instanceof Error ? err.message : 'Failed to load transcript');
        });
    }, [activeSessionId, isOpen, loadMessages]);

    useEffect(() => () => {
        Array.from(eventSourcesRef.current.values()).forEach((source) => source.close());
        eventSourcesRef.current.clear();
    }, []);

    useEffect(() => {
        if (isOpen) return;
        Array.from(eventSourcesRef.current.values()).forEach((source) => source.close());
        eventSourcesRef.current.clear();
    }, [isOpen]);

    const createSession = useCallback(async (provider = selectedProvider || defaultProvider): Promise<AgentSession | null> => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`${API_URL}/api/agents/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider }),
            });
            const json = await response.json();
            if (!response.ok || json.status === 'error') {
                throw new Error(json.error?.message || 'Failed to create agent session');
            }
            const session = json.data as AgentSession;
            setSessions((current) => [session, ...current]);
            setActiveSessionId(session.agent_session_id);
            setMessagesBySession((current) => ({
                ...current,
                [session.agent_session_id]: [],
            }));
            setActionsBySession((current) => ({
                ...current,
                [session.agent_session_id]: [],
            }));
            return session;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create agent session');
            return null;
        } finally {
            setLoading(false);
        }
    }, [defaultProvider, selectedProvider]);

    const updateRunMessage = useCallback((sessionId: string, runId: string, updater: (message: AgentMessage) => AgentMessage) => {
        setMessagesBySession((current) => ({
            ...current,
            [sessionId]: (current[sessionId] || []).map((message) => (
                message.agent_message_id === `run:${runId}` ? updater(message) : message
            )),
        }));
    }, []);

    const closeRunStream = useCallback((runId: string) => {
        const source = eventSourcesRef.current.get(runId);
        if (source) source.close();
        eventSourcesRef.current.delete(runId);
        toolNamesByRunRef.current.delete(runId);
    }, []);

    const attachRunStream = useCallback((sessionId: string, runId: string) => {
        closeRunStream(runId);
        const afterSequence = runCursorsRef.current.get(runId) || readRunCursor(runId);
        const eventsUrl = `${API_URL}/api/agents/runs/${encodeURIComponent(runId)}/events${afterSequence > 0 ? `?after=${afterSequence}` : ''}`;
        const source = new EventSource(eventsUrl);
        eventSourcesRef.current.set(runId, source);

        const handleEvent = (event: MessageEvent) => {
            const row = JSON.parse(event.data);
            const payload = row.payload || {};
            const sequence = Number(row.sequence_no || 0);
            if (Number.isFinite(sequence) && sequence > 0) {
                const nextSequence = Math.max(runCursorsRef.current.get(runId) || 0, sequence);
                runCursorsRef.current.set(runId, nextSequence);
                writeRunCursor(runId, nextSequence);
            }
            if (row.event_type === 'message.delta') {
                const text = String(payload.text || '');
                if (!text) return;
                updateRunMessage(sessionId, runId, (message) => ({
                    ...message,
                    content: `${message.content}${text}`,
                    metadata: appendTextPart(message.metadata, text),
                }));
            }
            if (row.event_type === 'message.completed') {
                const actions = Array.isArray(payload.content_json?.actions) ? payload.content_json.actions : [];
                if (actions.length > 0) {
                    setActionsBySession((current) => ({
                        ...current,
                        [sessionId]: actions,
                    }));
                }
                updateRunMessage(sessionId, runId, (message) => ({
                    ...message,
                    content: payload.content || message.content,
                    content_json: payload.content_json || message.content_json || null,
                    metadata: finalizeStreamParts(message.metadata, payload.content),
                }));
            }
            if (row.event_type === 'action.created') {
                const actions = Array.isArray(payload.actions) ? payload.actions : [];
                if (actions.length > 0) {
                    setActionsBySession((current) => ({
                        ...current,
                        [sessionId]: actions,
                    }));
                }
                updateRunMessage(sessionId, runId, (message) => ({
                    ...message,
                    content_json: {
                        ...(message.content_json || {}),
                        actions,
                    },
                }));
            }
            if (row.event_type === 'tool.started' || row.event_type === 'tool.completed') {
                let eventPayload = payload;
                const toolUseId = String(payload.tool_use_id || '');
                if (row.event_type === 'tool.started' && toolUseId && payload.name) {
                    const names = toolNamesByRunRef.current.get(runId) || new Map<string, string>();
                    names.set(toolUseId, String(payload.name));
                    toolNamesByRunRef.current.set(runId, names);
                } else if (row.event_type === 'tool.completed' && toolUseId) {
                    const name = toolNamesByRunRef.current.get(runId)?.get(toolUseId);
                    if (name) eventPayload = { ...payload, name };
                }
                if (isHiddenToolName(eventPayload.name || eventPayload.tool_name)) return;
                const label = `${row.event_type === 'tool.started' ? 'started' : 'completed'} ${String(eventPayload.name || eventPayload.raw_type || 'tool')}`;
                updateRunMessage(sessionId, runId, (message) => ({
                    ...message,
                    metadata: {
                        ...appendEventPart(message.metadata, row.event_type, eventPayload),
                        runEvents: [
                            ...(((message.metadata || {}).runEvents as string[] | undefined) || []),
                            label,
                        ].slice(-5),
                    },
                }));
            }
            if (row.event_type === 'run.completed' || row.event_type === 'run.failed') {
                setRunningRunsBySession((current) => {
                    const next = { ...current };
                    if (next[sessionId] === runId) delete next[sessionId];
                    return next;
                });
                closeRunStream(runId);
            }
        };

        [
            'message.delta',
            'message.completed',
            'action.created',
            'status.updated',
            'tool.started',
            'tool.completed',
            'run.completed',
            'run.failed',
        ].forEach((name) => source.addEventListener(name, handleEvent));

        source.addEventListener('stream.cursor', (event: MessageEvent) => {
            const row = JSON.parse(event.data);
            const after = Number(row.after || 0);
            if (Number.isFinite(after) && after > 0) {
                const nextSequence = Math.max(runCursorsRef.current.get(runId) || 0, after);
                runCursorsRef.current.set(runId, nextSequence);
                writeRunCursor(runId, nextSequence);
            }
        });

        source.addEventListener('stream.closed', () => {
            setRunningRunsBySession((current) => {
                const next = { ...current };
                if (next[sessionId] === runId) delete next[sessionId];
                return next;
            });
            closeRunStream(runId);
        });

        source.onerror = () => {
            if (source.readyState === EventSource.CONNECTING) return;
            setRunningRunsBySession((current) => {
                const next = { ...current };
                if (next[sessionId] === runId) delete next[sessionId];
                return next;
            });
            closeRunStream(runId);
        };
    }, [closeRunStream, updateRunMessage]);

    useEffect(() => {
        if (!isOpen) return;
        for (const session of sessions) {
            const runId = typeof session.metadata?.activeRunId === 'string' ? session.metadata.activeRunId : '';
            if (!runId || eventSourcesRef.current.has(runId)) continue;
            setRunningRunsBySession((current) => ({
                ...current,
                [session.agent_session_id]: runId,
            }));
            setMessagesBySession((current) => {
                const existing = current[session.agent_session_id] || [];
                if (existing.some((message) => message.agent_message_id === `run:${runId}`)) return current;
                return {
                    ...current,
                    [session.agent_session_id]: [
                        ...existing,
                        {
                            agent_message_id: `run:${runId}`,
                            role: 'assistant',
                            content: '',
                            metadata: { run_id: runId, reattached: true },
                        },
                    ],
                };
            });
            attachRunStream(session.agent_session_id, runId);
        }
    }, [attachRunStream, isOpen, sessions]);

    const sendMessage = useCallback(async () => {
        const content = draft.trim();
        if (!content) return;
        let sessionId = activeSessionId;
        if (!sessionId) {
            const created = await createSession(selectedProvider || defaultProvider);
            sessionId = created?.agent_session_id || null;
        }
        if (!sessionId) return;

        setDraft('');
        setError(null);
        setMessagesBySession((current) => ({
            ...current,
            [sessionId]: [
                ...(current[sessionId] || []),
                {
                    agent_message_id: `local:${Date.now()}`,
                    role: 'user',
                    content,
                },
            ],
        }));

        try {
            const response = await fetch(`${API_URL}/api/agents/sessions/${encodeURIComponent(sessionId)}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });
            const json = await response.json();
            if (!response.ok || json.status === 'error') {
                throw new Error(json.error?.message || 'Failed to start agent run');
            }
            const runId = json.data.runId as string;
            setRunningRunsBySession((current) => ({
                ...current,
                [sessionId]: runId,
            }));
            setMessagesBySession((current) => ({
                ...current,
                [sessionId]: [
                    ...(current[sessionId] || []),
                    {
                        agent_message_id: `run:${runId}`,
                        role: 'assistant',
                        content: '',
                        metadata: { run_id: runId },
                    },
                ],
            }));
            attachRunStream(sessionId, runId);
        } catch (err) {
            setRunningRunsBySession((current) => {
                const next = { ...current };
                if (sessionId) delete next[sessionId];
                return next;
            });
            setError(err instanceof Error ? err.message : 'Failed to send message');
        }
    }, [activeSessionId, attachRunStream, createSession, defaultProvider, draft, selectedProvider]);

    const cancelRun = useCallback(async () => {
        if (!runningRunId) return;
        cancelPendingHistoricalPlayback();
        await fetch(`${API_URL}/api/agents/runs/${encodeURIComponent(runningRunId)}/cancel`, { method: 'POST' }).catch(() => {});
        closeRunStream(runningRunId);
        if (activeSessionId) {
            setRunningRunsBySession((current) => {
                const next = { ...current };
                delete next[activeSessionId];
                return next;
            });
        }
    }, [activeSessionId, closeRunStream, runningRunId]);

    const applyAction = useCallback(async (action: AgentAction, sessionId?: string | null) => {
        if (sessionId && activeSessionIdRef.current !== sessionId) {
            throw new Error('Switch back to this agent session to run its map actions');
        }
        const payload = normalizedActionPayload(action);
        const store = useTimelineStore.getState();

        const postJson = async (path: string, body: Record<string, any>) => {
            const response = await fetch(`${API_URL}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await response.json().catch(() => null);
            if (!response.ok || json?.status === 'error') {
                throw new Error(json?.error?.message || json?.error || `${path} failed`);
            }
            return json;
        };

        if (action.type === 'map.fly_to') {
            const lat = Number(payload.lat ?? payload.latitude);
            const lng = Number(payload.lng ?? payload.lon ?? payload.longitude);
            const height = Number(payload.height ?? payload.altitude_m ?? 15000);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('map.fly_to requires lat and lng');
            document.dispatchEvent(new CustomEvent('fly-to', { detail: { lat, lng, height } }));
            return;
        }

        if (action.type === 'replay.seek') {
            const at = String(payload.at || payload.time || '');
            const date = new Date(at);
            if (Number.isNaN(date.getTime())) throw new Error('replay.seek requires a valid at/time value');
            cancelPendingHistoricalPlayback();
            store.enterHistoricalReplay();
            store.setCurrentTime(date, { reason: 'external' });
            store.markReplaySeek();
            document.dispatchEvent(new CustomEvent('timeline-ctrl', {
                detail: { action: 'seek', time: date.toISOString() },
            }));
            return;
        }

        if (action.type === 'replay.play_window') {
            const from = String(payload.from || payload.at || '');
            const date = new Date(from);
            const speed = Number(payload.speed || 32);
            if (Number.isNaN(date.getTime())) throw new Error('replay.play_window requires a valid from/at value');
            store.setSpeedMultiplier(Number.isFinite(speed) ? speed : 32);
            const currentState = useTimelineStore.getState();
            const alreadyAtRequestedTime = currentState.mode === 'playback'
                && currentState.playbackKind === 'historical'
                && Math.abs(currentState.currentTime.getTime() - date.getTime()) < 1000;
            if (!alreadyAtRequestedTime) {
                store.enterHistoricalReplay();
                store.setCurrentTime(date, { reason: 'external' });
                store.markReplaySeek();
                document.dispatchEvent(new CustomEvent('timeline-ctrl', {
                    detail: { action: 'seek', time: date.toISOString() },
                }));
            }
            startHistoricalPlaybackWhenReady();
            return;
        }

        if (action.type === 'replay.set_speed') {
            const speed = Number(payload.speed || payload.multiplier);
            if (!Number.isFinite(speed) || speed <= 0) throw new Error('replay.set_speed requires a positive speed');
            store.setSpeedMultiplier(speed);
            return;
        }

        if (action.type === 'replay.follow_entity') {
            const entityId = String(payload.entity_id || payload.entityId || '');
            if (!entityId) throw new Error('replay.follow_entity requires entity_id');
            store.setSelectedEntityId(entityId, { id: entityId, agentSelected: true });
            return;
        }

        if (action.type === 'object.open' || action.type === 'object.focus' || action.type === 'entity.open') {
            const entityId = String(payload.entity_id || payload.entityId || payload.id || '').trim();
            if (!entityId) throw new Error(`${action.type} requires entity_id`);
            const at = String(payload.at || payload.time || '');
            const shouldResumePlayback = shouldResumeHistoricalPlaybackAfterViewChange(useTimelineStore.getState());
            let changedReplayTime = false;
            if (at) {
                const date = new Date(at);
                if (Number.isNaN(date.getTime())) throw new Error(`${action.type} received invalid at/time`);
                const currentState = useTimelineStore.getState();
                const alreadyAtRequestedTime = currentState.mode === 'playback'
                    && currentState.playbackKind === 'historical'
                    && Math.abs(currentState.currentTime.getTime() - date.getTime()) < 1000;
                if (!alreadyAtRequestedTime) {
                    cancelPendingHistoricalPlayback();
                    store.enterHistoricalReplay();
                    store.setCurrentTime(date, { reason: 'external' });
                    store.markReplaySeek();
                    document.dispatchEvent(new CustomEvent('timeline-ctrl', {
                        detail: { action: 'seek', time: date.toISOString() },
                    }));
                    changedReplayTime = true;
                }
            }
            const layer = payload.layer || payload.layer_id || payload.type;
            store.setSelectedEntityId(entityId, {
                id: entityId,
                name: payload.name || payload.display_name || entityId,
                type: payload.object_type || payload.objectType || typeForLayer(layer),
                layer,
                source: payload.source || payload.source_id,
                agentSelected: true,
                ...((payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {}),
            });
            const lat = Number(payload.lat ?? payload.latitude);
            const lng = Number(payload.lng ?? payload.lon ?? payload.longitude);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                document.dispatchEvent(new CustomEvent('fly-to', {
                    detail: { lat, lng, height: Number(payload.height || 15000) },
                }));
            }
            if (changedReplayTime && shouldResumePlayback) startHistoricalPlaybackWhenReady();
            return;
        }

        if (
            action.type === 'map.add_aoi'
            || action.type === 'map.draw_aoi'
            || action.type === 'map.add_corridor'
            || action.type === 'map.draw_corridor'
            || action.type === 'overlay.draw_geometry'
        ) {
            const viewer = getViewer();
            if (!viewer) throw new Error('Cesium viewer is not ready');
            drawGeometryOverlay(viewer, payload, action.label || 'Agent AOI');
            viewer.scene.requestRender();
            return;
        }

        if (action.type === 'map.clear_agent_overlays') {
            const viewer = getViewer();
            if (!viewer) throw new Error('Cesium viewer is not ready');
            const entities = viewer.entities.values.filter((entity) => String(entity.id || '').startsWith(AGENT_ENTITY_PREFIX));
            for (const entity of entities) viewer.entities.remove(entity);
            viewer.scene.requestRender();
            return;
        }

        if (action.type === 'map.set_layers' || action.type === 'source.set_enabled' || action.type === 'layer.set_visibility') {
            const patch = buildLayerPatch(payload);
            if (Object.keys(patch).length === 0) throw new Error(`${action.type} requires layer/source/visibility payload`);
            const shouldResumePlayback = shouldResumeHistoricalPlaybackAfterViewChange(useTimelineStore.getState());
            const json = await postJson('/api/view-state/patch', patch);
            applyViewStateToStore(json.state || json.data?.state || patch);
            if (shouldResumePlayback) startHistoricalPlaybackWhenReady();
            return;
        }

        if (action.type === 'legend.set_node_state') {
            const nodeId = normalizeLegendNodeId(payload.node || payload.nodeId || payload.node_id || payload.id);
            if (!nodeId) throw new Error('legend.set_node_state requires node');
            const shouldResumePlayback = shouldResumeHistoricalPlaybackAfterViewChange(useTimelineStore.getState());
            const json = await postJson('/api/view-state/legend-node-state', {
                nodeId,
                enabled: toBoolean(payload.enabled ?? true),
                target: payload.target === 'sources' ? 'sources' : 'visibility',
            });
            applyViewStateToStore(json.state || json.data?.state);
            if (shouldResumePlayback) startHistoricalPlaybackWhenReady();
            return;
        }

        if (action.type === 'view.patch') {
            const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : payload;
            const shouldResumePlayback = shouldResumeHistoricalPlaybackAfterViewChange(useTimelineStore.getState());
            const json = await postJson('/api/view-state/patch', patch);
            applyViewStateToStore(json.state || json.data?.state || patch);
            if (shouldResumePlayback) startHistoricalPlaybackWhenReady();
            return;
        }

        if (action.type === 'selection.apply' || action.type === 'selection.clear') {
            if (action.type === 'selection.apply' && Array.isArray(payload.entities) && payload.entities.length > 0 && payload.selection_id) {
                const ids = payload.entities
                    .map((entity: any) => String(entity?.entity_id || entity?.entityId || entity?.id || '').trim())
                    .filter(Boolean);
                if (ids.length > 0) {
                    await postJson('/api/selections', {
                        selectionId: payload.selection_id,
                        layerId: payload.layer || 'vessel',
                        selectionMode: 'filter',
                        predicate: { ids },
                        metadata: {
                            source: 'agent-action',
                            label: payload.label || action.label || null,
                        },
                    });
                }
            }
            const response = await fetch(`${API_URL}/api/agent-tools/map-command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    command: action.type,
                    payload,
                }),
            });
            const json = await response.json().catch(() => null);
            if (!response.ok || json?.status === 'error') {
                throw new Error(json?.error?.message || `${action.type} failed`);
            }
            return;
        }

        if (action.type === 'map.highlight' || action.type === 'map.annotate') {
            const viewer = getViewer();
            if (!viewer) throw new Error('Cesium viewer is not ready');
            drawGeometryOverlay(viewer, payload, action.label || 'Agent note');
            viewer.scene.requestRender();
        }
    }, []);

    const replayPresentation = useCallback(async (sessionId: string, messageId: string, actions: AgentAction[]) => {
        if (activeSessionIdRef.current !== sessionId) {
            setError('Switch back to this agent session to replay its presentation');
            return;
        }
        const key = `${sessionId}:${messageId}`;
        setRunningPresentationKey(key);
        setError(null);
        cancelPendingHistoricalPlayback();
        const actionErrors: string[] = [];
        try {
            for (const action of actions) {
                if (activeSessionIdRef.current !== sessionId) {
                    throw new Error('Presentation stopped because another agent session became active');
                }
                try {
                    await applyAction(action, sessionId);
                } catch (err) {
                    actionErrors.push(`${formatActionType(action.type)}: ${err instanceof Error ? err.message : 'failed'}`);
                }
                await sleep(presentationDelayForAction(action));
            }
            if (actionErrors.length > 0) {
                setError(`Presentation finished with ${actionErrors.length} skipped step(s)`);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Agent presentation failed');
        } finally {
            setRunningPresentationKey((current) => (current === key ? null : current));
        }
    }, [applyAction]);

    if (!isOpen) return null;

    return (
        <div className="absolute right-4 bottom-24 z-40 w-[min(440px,calc(100vw-24px))] max-h-[calc(100vh-140px)] rounded-lg border border-zinc-800 bg-black/85 backdrop-blur-xl shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
                <div className="flex items-center gap-2 min-w-0">
                    <Bot size={15} className="text-cyan-300 shrink-0" />
                    <div className="min-w-0">
                        <div className="text-xs font-mono text-zinc-100">Local Agents</div>
                        <div className="text-[10px] font-mono text-zinc-500 truncate">
                            {activeSession ? providerLabel(activeSession.provider, providers) : 'No session'}
                        </div>
                    </div>
                </div>
                <button onClick={() => {
                    cancelPendingHistoricalPlayback();
                    onClose();
                }} className="p-1 text-zinc-500 hover:text-white rounded">
                    <X size={15} />
                </button>
            </div>

            <div className="flex gap-2 p-2 border-b border-zinc-800 overflow-x-auto">
                {sessions.map((session) => (
                    <button
                        key={session.agent_session_id}
                        onClick={() => setActiveSessionId(session.agent_session_id)}
                        className={`shrink-0 px-2 py-1 rounded border text-[10px] font-mono ${
                            session.agent_session_id === activeSessionId
                                ? 'border-cyan-600 bg-cyan-950/50 text-cyan-200'
                                : 'border-zinc-800 bg-zinc-950 text-zinc-500 hover:text-zinc-300'
                        }`}
                    >
                        {providerLabel(session.provider, providers)}
                        {runningRunsBySession[session.agent_session_id] ? ' *' : ''}
                    </button>
                ))}
                <select
                    value={selectedProvider}
                    onChange={(event) => setSelectedProvider(event.target.value)}
                    disabled={availableProviders.length === 0}
                    className="shrink-0 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] font-mono text-zinc-400 outline-none disabled:opacity-50"
                >
                    {availableProviders.map((provider) => (
                        <option key={provider.provider} value={provider.provider}>
                            {provider.label}
                        </option>
                    ))}
                </select>
                <button
                    onClick={() => void createSession(selectedProvider || defaultProvider)}
                    disabled={loading || availableProviders.length === 0}
                    className="shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-zinc-800 bg-zinc-950 text-[10px] font-mono text-zinc-400 hover:text-white disabled:opacity-50"
                >
                    {loading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    New
                </button>
            </div>

            {error && (
                <div className="px-3 py-2 text-[11px] font-mono text-red-300 border-b border-red-900/60 bg-red-950/30">
                    {error}
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                {messages.length === 0 ? (
                    <div className="text-[11px] font-mono text-zinc-500 leading-relaxed">
                        Ask an OSINT question. The agent can inspect local data, create replay actions, and return map buttons.
                    </div>
                ) : messages.map((message) => {
                    const actions = Array.isArray(message.content_json?.actions) ? message.content_json.actions : [];
                    const streamParts = displayPartsForMessage(message, runningRunId);
                    const streamGroups = groupStreamParts(streamParts);
                    const presentationKey = activeSessionId ? `${activeSessionId}:${message.agent_message_id}` : '';
                    const presentationRunning = Boolean(presentationKey && runningPresentationKey === presentationKey);
                    return (
                        <div
                            key={message.agent_message_id}
                            className={`rounded-lg border px-3 py-2 ${
                                message.role === 'user'
                                    ? 'ml-8 border-zinc-700 bg-zinc-900/80 text-zinc-100'
                                    : 'mr-8 border-zinc-800 bg-zinc-950/80 text-zinc-300'
                            }`}
                        >
                            <div className="mb-1 text-[10px] uppercase font-mono text-zinc-500">
                                {message.role}
                            </div>
                            {streamParts.length > 0 ? (
                                <div className="space-y-1.5">
                                    {streamGroups.map((group, idx) => (
                                        group.type === 'text' ? (
                                            <MarkdownBlock key={group.part.id} text={group.part.text || ''} />
                                        ) : (
                                            <ToolGroup key={`tools-${idx}-${group.parts[0]?.id || idx}`} parts={group.parts} />
                                        )
                                    ))}
                                </div>
                            ) : (
                                <div>
                                    {message.content ? <MarkdownBlock text={message.content} /> : (message.role === 'assistant' && runningRunId ? <Loader2 size={14} className="animate-spin text-cyan-300" /> : '')}
                                </div>
                            )}
                            {actions.length > 0 && activeSessionId && (
                                <div className="mt-3 border-t border-zinc-900 pt-2">
                                    <button
                                        onClick={() => void replayPresentation(activeSessionId, message.agent_message_id, actions)}
                                        disabled={presentationRunning}
                                        className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-emerald-800/80 bg-emerald-950/30 px-2 py-1.5 text-[11px] font-mono text-emerald-200 hover:border-emerald-500 disabled:opacity-60"
                                    >
                                        {presentationRunning ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                                        Replay presentation
                                    </button>
                                    <details className="mt-2 rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[10px] font-mono text-zinc-500">
                                        <summary className="cursor-pointer select-none text-zinc-400">
                                            Presentation steps ({actions.length})
                                        </summary>
                                        <div className="mt-2 grid gap-1">
                                            {actions.map((action, idx) => (
                                                <button
                                                    key={`${action.type}-${idx}`}
                                                    onClick={() => void applyAction(action, activeSessionId).catch((err) => {
                                                        setError(err instanceof Error ? err.message : 'Agent action failed');
                                                    })}
                                                    className="inline-flex items-center gap-1.5 rounded border border-cyan-950/70 bg-cyan-950/20 px-2 py-1 text-left text-[10px] font-mono text-cyan-200 hover:border-cyan-600"
                                                >
                                                    {getActionIcon(action.type)}
                                                    <span className="truncate">{actionLabel(action, idx)}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </details>
                                </div>
                            )}
                        </div>
                    );
                })}
                {latestActions.length > 0 && !messageActionsVisible && (
                    <div className="mr-8 rounded-lg border border-cyan-900/60 bg-cyan-950/15 px-3 py-2">
                        <div className="mb-2 text-[10px] uppercase font-mono text-cyan-500">
                            latest actions
                        </div>
                        <div className="space-y-2">
                            {activeSessionId && (
                                <button
                                    onClick={() => void replayPresentation(activeSessionId, 'latest-actions', latestActions)}
                                    disabled={runningPresentationKey === `${activeSessionId}:latest-actions`}
                                    className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-emerald-800/80 bg-emerald-950/30 px-2 py-1.5 text-[11px] font-mono text-emerald-200 hover:border-emerald-500 disabled:opacity-60"
                                >
                                    {runningPresentationKey === `${activeSessionId}:latest-actions` ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                                    Replay presentation
                                </button>
                            )}
                            <details className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[10px] font-mono text-zinc-500">
                                <summary className="cursor-pointer select-none text-zinc-400">
                                    Presentation steps ({latestActions.length})
                                </summary>
                                <div className="mt-2 grid gap-1">
                                    {latestActions.map((action, idx) => (
                                        <button
                                            key={`latest-${action.type}-${idx}`}
                                            onClick={() => void applyAction(action, activeSessionId).catch((err) => {
                                                setError(err instanceof Error ? err.message : 'Agent action failed');
                                            })}
                                            className="inline-flex items-center gap-1.5 rounded border border-cyan-950/70 bg-cyan-950/20 px-2 py-1 text-left text-[10px] font-mono text-cyan-200 hover:border-cyan-600"
                                        >
                                            {getActionIcon(action.type)}
                                            <span className="truncate">{actionLabel(action, idx)}</span>
                                        </button>
                                    ))}
                                </div>
                            </details>
                        </div>
                    </div>
                )}
            </div>

            <div className="p-2 border-t border-zinc-800">
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            void sendMessage();
                        }
                    }}
                    placeholder="Ask about vessels, cables, replay, sources..."
                    className="w-full h-20 resize-none rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-cyan-800"
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="text-[10px] font-mono text-zinc-600">
                        {runningRunId ? 'running' : Object.keys(runningRunsBySession).length > 0 ? `${Object.keys(runningRunsBySession).length} running in background` : 'ready'}
                    </div>
                    {runningRunId ? (
                        <button
                            onClick={() => void cancelRun()}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-950/50 border border-red-900 text-[11px] font-mono text-red-200 hover:border-red-600"
                        >
                            <Square size={12} />
                            Stop
                        </button>
                    ) : (
                        <button
                            onClick={() => void sendMessage()}
                            disabled={!draft.trim() || (!activeSessionId && availableProviders.length === 0)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-950/60 border border-cyan-900 text-[11px] font-mono text-cyan-100 hover:border-cyan-500 disabled:opacity-50"
                        >
                            <Send size={12} />
                            Send
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
