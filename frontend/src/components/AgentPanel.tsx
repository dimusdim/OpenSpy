'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as Cesium from 'cesium';
import {
    Bot,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Database,
    History,
    Loader2,
    MapPin,
    MessageSquare,
    Play,
    Plus,
    Satellite,
    Send,
    Square,
    X,
} from 'lucide-react';
import { API_URL } from '../lib/config';
import { clearOpenSpyImageryLayers, showOpenSpyImageryCompare, showOpenSpyImageryLayer } from '../lib/imageryOverlay';
import { useTimelineStore } from '../store/useTimelineStore';
import { replayMetaMap } from '../cesium/useReplayOverlay';
import { useToast } from './Toast';

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
    first_user_prompt?: string | null;
    last_user_prompt?: string | null;
    created_at: string;
    updated_at: string;
};

type AgentMessage = {
    agent_message_id: string;
    role: string;
    content: string;
    content_json?: { actions?: AgentAction[]; actions_parse_error?: string; raw_actions?: string } | null;
    created_at?: string;
    metadata?: Record<string, any>;
};

type AgentAction = {
    type: string;
    label?: string;
    payload?: Record<string, any>;
};

type PresentationGuideState = {
    key: string;
    sessionId: string;
    messageId: string;
    actions: AgentAction[];
    currentIndex: number;
    status: 'running' | 'manual' | 'completed' | 'partial' | 'stopped';
    skippedSteps?: number;
};

type AgentStreamPart = {
    id: string;
    type: 'text' | 'tool' | 'status';
    text?: string;
    eventType?: string;
    name?: string;
    toolUseId?: string;
    rawType?: string;
    providerToolName?: string;
    command?: string;
    input?: any;
    output?: any;
    state?: 'started' | 'completed' | 'status';
    isError?: boolean;
};

type ParsedActionContract = {
    visible: string;
    actions: AgentAction[];
    contentJson: { actions?: AgentAction[]; actions_parse_error?: string; raw_actions?: string } | null;
    incomplete: boolean;
};

const SESSION_PICKER_DISPLAY_LIMIT = 80;
const AGENT_LABEL_FONT = '16px sans-serif';
const AGENT_LABEL_OFFSET_Y = -34;
const AGENT_GEOMETRY_HEIGHT_M = 0;
const AGENT_LINE_HEIGHT_M = 1800;
const AGENT_LABEL_STAGGER_OFFSETS = [
    [0, -44],
    [220, -44],
    [-220, -44],
    [0, -104],
    [220, -104],
    [-220, -104],
    [0, 64],
    [220, 64],
    [-220, 64],
    [0, -164],
] as const;
const agentLabelClusterCounts = new Map<string, number>();

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
    infrastructure_cables: 'infrastructure/telecom-infra/cables',
    infrastructure_telecom: 'infrastructure/telecom-infra',
    telecom_cables: 'infrastructure/telecom-infra/cables',
    cables: 'infrastructure/telecom-infra/cables',
    cable: 'infrastructure/telecom-infra/cables',
    wifi: 'connectivity/wifi',
    outages: 'connectivity/outages',
    outage: 'connectivity/outages',
};

const AGENT_ENTITY_PREFIX = 'agent-';

type TrackPoint = {
    lat: number;
    lng: number;
    alt?: number;
    at?: string;
    heading?: number;
    speed?: number;
    layer?: string;
    source?: string;
};

type AgentPanelProps = {
    isOpen: boolean;
    onClose: () => void;
    embedded?: boolean;
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

function dedupeSessions(rows: AgentSession[]): AgentSession[] {
    const byId = new Map<string, AgentSession>();
    const order: string[] = [];
    for (const row of rows) {
        const id = String(row?.agent_session_id || '');
        if (!id) continue;
        if (!byId.has(id)) order.push(id);
        const previous = byId.get(id);
        byId.set(id, previous ? {
            ...previous,
            ...row,
            metadata: {
                ...(previous.metadata || {}),
                ...(row.metadata || {}),
            },
            agent_session_id: id,
        } : { ...row, agent_session_id: id });
    }
    return order.map((id) => byId.get(id)).filter(Boolean) as AgentSession[];
}

function dedupeMessages(rows: AgentMessage[]): AgentMessage[] {
    const byId = new Map<string, AgentMessage>();
    const order: string[] = [];
    for (const row of rows) {
        const id = String(row?.agent_message_id || '');
        if (!id) continue;
        if (!byId.has(id)) order.push(id);
        const previous = byId.get(id);
        byId.set(id, previous ? {
            ...previous,
            ...row,
            content: row.content || previous.content,
            content_json: row.content_json || previous.content_json || null,
            metadata: {
                ...(previous.metadata || {}),
                ...(row.metadata || {}),
            },
        } : { ...row, agent_message_id: id });
    }
    return order.map((id) => byId.get(id)).filter(Boolean) as AgentMessage[];
}

function compactSingleLine(value: unknown): string {
    const compact = String(value || '').replace(/\s+/g, ' ').trim();
    return compact;
}

function singleLinePreview(value: unknown, maxChars = 72): string {
    const compact = compactSingleLine(value);
    if (!compact) return '';
    return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}...` : compact;
}

function isDateLikeSessionLabel(value: unknown): boolean {
    const compact = compactSingleLine(value);
    if (!compact) return false;
    if (Number.isFinite(Date.parse(compact))) return true;
    return /^[\d\s:.,/+\-TZ]+$/i.test(compact);
}

function meaningfulSessionSnippet(value: unknown, maxChars = 72): string {
    const compact = compactSingleLine(value);
    if (!compact || isDateLikeSessionLabel(compact)) return '';
    return singleLinePreview(compact, maxChars);
}

function firstLoadedUserPrompt(messages: AgentMessage[]): string {
    return messages.find((message) => message.role === 'user' && meaningfulSessionSnippet(message.content))?.content || '';
}

function sessionPromptTitle(session: AgentSession, messages: AgentMessage[] = []): string {
    const fromMetadata = typeof session.metadata?.title === 'string' ? session.metadata.title : '';
    return meaningfulSessionSnippet(session.first_user_prompt)
        || meaningfulSessionSnippet(firstLoadedUserPrompt(messages))
        || meaningfulSessionSnippet(session.last_user_prompt)
        || meaningfulSessionSnippet(fromMetadata)
        || 'New chat';
}

function formatSessionDate(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const now = new Date();
    const options: Intl.DateTimeFormatOptions = date.getFullYear() === now.getFullYear()
        ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
        : { month: 'short', day: 'numeric', year: 'numeric' };
    return new Intl.DateTimeFormat(undefined, options).format(date);
}

function sessionSecondaryLabel(session: AgentSession, providers: ProviderInfo[]): string {
    return [
        providerLabel(session.provider, providers),
        formatSessionDate(session.updated_at || session.created_at),
    ].filter(Boolean).join(' - ');
}

function getActionIcon(type: string) {
    if (type.startsWith('replay.')) return <Play size={13} />;
    if (type.startsWith('map.')) return <MapPin size={13} />;
    if (type.startsWith('layer.') || type.startsWith('overlay.')) return <MapPin size={13} />;
    if (type.startsWith('entity.') || type.startsWith('track.')) return <MapPin size={13} />;
    if (type.startsWith('imagery.')) return <Satellite size={13} />;
    if (type.startsWith('selection.')) return <Database size={13} />;
    return <Bot size={13} />;
}

function cleanVisibleText(text: string): string {
    return extractActionContract(text).visible.trim();
}

function normalizeAgentActions(value: any): AgentAction[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => item && typeof item === 'object' && typeof item.type === 'string')
        .map((item) => ({
            ...item,
            type: String(item.type),
            label: typeof item.label === 'string' ? item.label : undefined,
            payload: item.payload && typeof item.payload === 'object' ? item.payload : undefined,
        }));
}

function cappedActionRaw(raw: string, maxChars = 4000): string {
    const value = String(raw || '');
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function parseActionJson(raw: string): ParsedActionContract {
    try {
        const parsed = JSON.parse(raw || '{}');
        const actions = normalizeAgentActions(parsed?.actions);
        return {
            visible: '',
            actions,
            contentJson: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? { ...parsed, actions }
                : { actions },
            incomplete: false,
        };
    } catch (err) {
        return {
            visible: '',
            actions: [],
            contentJson: {
                actions_parse_error: err instanceof Error ? err.message : 'Invalid ACTIONS_JSON',
                raw_actions: cappedActionRaw(raw),
            },
            incomplete: false,
        };
    }
}

function rawJsonHasActions(raw: string): boolean {
    try {
        const parsed = JSON.parse(String(raw || '{}'));
        return normalizeAgentActions(parsed?.actions).length > 0;
    } catch {
        return false;
    }
}

function findCompleteFenceActionBlock(content: string): {
    start: number;
    end: number;
    rawStart: number;
    rawEnd: number;
    incomplete: boolean;
} | null {
    const pattern = /(^|\n)((?:```ACTIONS_JSON|ACTIONS_JSON\s*:?\s*```(?:json)?)\s*)([\s\S]*?)(\s*```)/i;
    const match = pattern.exec(content);
    if (!match || match.index == null) return null;
    const leading = match[1] || '';
    const prefix = match[2] || '';
    const raw = match[3] || '';
    const suffix = match[4] || '';
    const start = match.index + leading.length;
    const rawStart = start + prefix.length;
    const rawEnd = rawStart + raw.length;
    const end = rawEnd + suffix.length;
    return { start, end, rawStart, rawEnd, incomplete: false };
}

function findCompleteGenericJsonActionBlock(content: string): {
    start: number;
    end: number;
    rawStart: number;
    rawEnd: number;
    incomplete: boolean;
} | null {
    const pattern = /(^|\n)(```json[ \t]*\n?)([\s\S]*?)(\s*```)/ig;
    for (const match of Array.from(content.matchAll(pattern))) {
        if (match.index == null) continue;
        const leading = match[1] || '';
        const prefix = match[2] || '';
        const raw = match[3] || '';
        const suffix = match[4] || '';
        if (!rawJsonHasActions(raw.trim())) continue;
        const start = match.index + leading.length;
        const rawStart = start + prefix.length;
        const rawEnd = rawStart + raw.length;
        const end = rawEnd + suffix.length;
        if (content.slice(end).trim().length > 0) continue;
        return { start, end, rawStart, rawEnd, incomplete: false };
    }
    return null;
}

function isActionFenceStart(line: string): boolean {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    if (upper === '```ACTIONS_JSON') return true;
    if (!upper.startsWith('ACTIONS_JSON')) return false;
    let rest = upper.slice('ACTIONS_JSON'.length).trim();
    if (rest.startsWith(':')) rest = rest.slice(1).trim();
    return rest === '```' || rest === '```JSON';
}

function findFenceActionBlock(content: string): {
    start: number;
    end: number;
    rawStart: number;
    rawEnd: number;
    incomplete: boolean;
} | null {
    const complete = findCompleteFenceActionBlock(content);
    if (complete) return complete;
    const genericJson = findCompleteGenericJsonActionBlock(content);
    if (genericJson) return genericJson;

    const lines = content.split('\n');
    let offset = 0;
    for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        const hasNewline = idx < lines.length - 1;
        const lineStart = offset;
        const lineEnd = lineStart + line.length;
        const nextOffset = lineEnd + (hasNewline ? 1 : 0);
        if (!isActionFenceStart(line)) {
            offset = nextOffset;
            continue;
        }
        let innerOffset = nextOffset;
        for (let endIdx = idx + 1; endIdx < lines.length; endIdx += 1) {
            const endLine = lines[endIdx];
            const endHasNewline = endIdx < lines.length - 1;
            const endLineStart = innerOffset;
            const endLineEnd = endLineStart + endLine.length;
            const endNextOffset = endLineEnd + (endHasNewline ? 1 : 0);
            if (endLine.trim().startsWith('```')) {
                return {
                    start: lineStart,
                    end: endNextOffset,
                    rawStart: nextOffset,
                    rawEnd: endLineStart,
                    incomplete: false,
                };
            }
            innerOffset = endNextOffset;
        }
        return {
            start: lineStart,
            end: content.length,
            rawStart: nextOffset,
            rawEnd: content.length,
            incomplete: true,
        };
    }
    return null;
}

function findXmlActionBlock(content: string): {
    start: number;
    end: number;
    rawStart: number;
    rawEnd: number;
    incomplete: boolean;
} | null {
    const open = '<ACTIONS_JSON>';
    const close = '</ACTIONS_JSON>';
    const lower = content.toLowerCase();
    const start = lower.indexOf(open.toLowerCase());
    if (start < 0) return null;
    const rawStart = start + open.length;
    const closeStart = lower.indexOf(close.toLowerCase(), rawStart);
    if (closeStart < 0) {
        return {
            start,
            end: content.length,
            rawStart,
            rawEnd: content.length,
            incomplete: true,
        };
    }
    return {
        start,
        end: closeStart + close.length,
        rawStart,
        rawEnd: closeStart,
        incomplete: false,
    };
}

function extractActionContract(content: string): ParsedActionContract {
    const source = String(content || '');
    const candidates = [findXmlActionBlock(source), findFenceActionBlock(source)]
        .filter(Boolean) as NonNullable<ReturnType<typeof findXmlActionBlock>>[];
    if (candidates.length === 0) {
        return {
            visible: source.trim(),
            actions: [],
            contentJson: null,
            incomplete: false,
        };
    }
    const block = candidates.sort((a, b) => a.start - b.start)[0];
    const visible = `${source.slice(0, block.start)}${block.incomplete ? '' : source.slice(block.end)}`.trim();
    if (block.incomplete) {
        return {
            visible,
            actions: [],
            contentJson: null,
            incomplete: true,
        };
    }
    const parsed = parseActionJson(source.slice(block.rawStart, block.rawEnd).trim());
    return {
        ...parsed,
        visible,
        incomplete: false,
    };
}

function actionsFromMessage(message: AgentMessage): AgentAction[] {
    const contentJsonActions = normalizeAgentActions(message.content_json?.actions);
    if (contentJsonActions.length > 0) return contentJsonActions;
    return extractActionContract(message.content).actions;
}

function cleanToolName(name?: string): string {
    const raw = String(name || '').trim();
    if (!raw || /^toolu_[a-z0-9]+$/i.test(raw)) return 'tool';
    return raw;
}

function isGenericToolName(name?: string): boolean {
    const raw = cleanToolName(name).toLowerCase();
    return raw === 'tool' || raw === 'bash' || /worldview command|open.?spy command|ai worldview command/i.test(raw);
}

function formatToolPayload(value: any): string {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function shellCommandFromPayload(value: any): string {
    if (!value || typeof value !== 'object') return '';
    const command = typeof value.command === 'string'
        ? value.command
        : typeof value.cmd === 'string'
            ? value.cmd
            : '';
    return command.trim();
}

function summarizeToolCommand(command: string): string {
    const raw = String(command || '').trim();
    if (!raw) return '';
    const tokens = raw.split(/\s+/).filter(Boolean);
    const script = (scriptName: string) => tokens.findIndex((token) => token.endsWith(scriptName));
    const worldviewIndex = script('worldview-cli.sh');
    if (worldviewIndex >= 0) return ['worldview-cli', ...tokens.slice(worldviewIndex + 1, worldviewIndex + 4)].join(' ').trim();
    const backendIndex = script('backend-api.sh');
    if (backendIndex >= 0) return ['backend-api', ...tokens.slice(backendIndex + 1, backendIndex + 3)].join(' ').trim();
    const sourceIndex = script('source-fetch.sh');
    if (sourceIndex >= 0) return ['source-fetch', ...tokens.slice(sourceIndex + 1, sourceIndex + 3)].join(' ').trim();
    const mapIndex = script('map-command.sh');
    if (mapIndex >= 0) return ['map-command', ...tokens.slice(mapIndex + 1, mapIndex + 3)].join(' ').trim();
    if (tokens.some((token) => token.endsWith('sql-readonly.sh'))) return 'read-only SQL';
    return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
}

function displayToolName(part: { name?: string; providerToolName?: string; command?: string; input?: any }): string {
    const providerToolName = cleanToolName(part.providerToolName);
    const command = part.command || shellCommandFromPayload(part.input);
    const summarized = summarizeToolCommand(command);
    if (summarized && isGenericToolName(providerToolName)) return summarized;
    if (providerToolName && providerToolName !== 'tool') return providerToolName;
    const name = cleanToolName(part.name);
    if (summarized && (isGenericToolName(name) || summarized !== name)) return summarized;
    return name;
}

function formatActionType(type: string): string {
    const labels: Record<string, string> = {
        'map.fly_to': 'Move map',
        'map.highlight': 'Highlight',
        'map.annotate': 'Annotate',
        'map.add_aoi': 'Show area',
        'map.add_corridor': 'Show corridor',
        'map.clear_agent_overlays': 'Clear overlays',
        'presentation.step': 'Presentation step',
        'presentation.group': 'Presentation group',
        'presentation.sequence': 'Presentation sequence',
        'actions.batch': 'Action batch',
        'action.batch': 'Action batch',
        'legend.set_node_state': 'Set legend',
        'map.set_layers': 'Set layers',
        'layer.set_visibility': 'Set layers',
        'layer.filter': 'Filter layer',
        'overlay.draw_geometry': 'Show geometry',
        'view.patch': 'Set view',
        'object.open': 'Open object',
        'object.focus': 'Focus object',
        'entity.open': 'Open entity',
        'asset.open': 'Open asset',
        'event.open': 'Open event',
        'entity.place': 'Place entity',
        'entity.show_marker': 'Show marker',
        'entity.track': 'Draw track',
        'entity.draw_track': 'Draw track',
        'entity.animate_track': 'Animate track',
        'track.draw': 'Draw track',
        'track.animate': 'Animate track',
        'imagery.show_layer': 'Show imagery',
        'imagery.show_scene': 'Show imagery',
        'imagery.compare': 'Compare imagery',
        'imagery.clear': 'Clear imagery',
        'selection.apply': 'Apply selection',
        'selection.clear': 'Clear selection',
        'replay.seek': 'Seek replay',
        'replay.play_window': 'Play replay',
        'replay.pause': 'Pause replay',
        'replay.stop': 'Stop replay',
        'replay.set_speed': 'Set speed',
        'replay.follow_entity': 'Follow entity',
    };
    return labels[type] || type.replace(/[._]/g, ' ');
}

function nestedActionsFor(action: AgentAction): AgentAction[] {
    const payload = normalizedActionPayload(action);
    const raw = payload.actions || payload.steps || [];
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((item) => item && typeof item === 'object' && typeof item.type === 'string')
        .map((item) => ({
            type: String(item.type),
            label: typeof item.label === 'string' ? item.label : undefined,
            payload: item.payload && typeof item.payload === 'object' ? item.payload : undefined,
            ...item,
        }));
}

function isActionBatch(action: AgentAction): boolean {
    return action.type === 'presentation.step'
        || action.type === 'presentation.group'
        || action.type === 'presentation.sequence'
        || action.type === 'actions.batch'
        || action.type === 'action.batch';
}

function actionLabel(action: AgentAction, idx: number): string {
    if (isActionBatch(action)) {
        const count = nestedActionsFor(action).length;
        return action.label || `${idx + 1}. ${formatActionType(action.type)}${count ? ` (${count})` : ''}`;
    }
    return action.label || `${idx + 1}. ${formatActionType(action.type)}`;
}

function isImageryAction(action: AgentAction): boolean {
    return action.type === 'imagery.show_layer'
        || action.type === 'imagery.show_scene'
        || action.type === 'imagery.compare';
}

function imageryDetails(action: AgentAction): {
    source: string;
    sceneId: string | null;
    acquisition: string;
    layer: string;
    cloud: string | null;
    aoi: string | null;
    limitation: string;
} {
    const payload = normalizedActionPayload(action);
    const scene = payload.scene && typeof payload.scene === 'object' ? payload.scene : {};
    const sourceRaw = payload.source || payload.provider || scene.source || scene.provider || '';
    const source = /copernicus|sentinel/i.test(String(sourceRaw))
        ? 'Copernicus / Sentinel'
        : /landsat|usgs/i.test(String(sourceRaw))
            ? 'USGS Landsat'
            : /firms|fire/i.test(String(sourceRaw))
                ? 'NASA FIRMS'
                : /gibs|nasa|worldview/i.test(String(sourceRaw))
                    ? 'NASA GIBS / Worldview'
                    : String(sourceRaw || 'Imagery source');
    const sceneId = String(payload.scene_id || scene.scene_id || '').trim() || null;
    const acquisitionRaw = payload.time || payload.at || payload.date || payload.from || scene.datetime || scene.date || '';
    const acquisition = acquisitionRaw ? String(acquisitionRaw).slice(0, 19).replace('T', ' ') : 'date-addressed scene';
    const layer = String(payload.layer || payload.gibsLayer || payload.gibs_layer || scene.collection || scene.layer_id || scene.requested_layer || 'context imagery');
    const cloudRaw = payload.cloud_cover ?? payload.maxCloudCover ?? payload.max_cloud_cover ?? scene.cloud_cover ?? scene.cloudCover;
    const cloudNumber = Number(cloudRaw);
    const cloud = Number.isFinite(cloudNumber) ? `${Math.round(cloudNumber)}% cloud` : null;
    const bbox = payload.bbox || scene.bbox;
    const aoi = Array.isArray(bbox) && bbox.length === 4 ? 'bounded AOI overlay' : null;
    const limitation = /copernicus|sentinel/i.test(source)
        ? 'Preview rendered through backend credentials; not a raw scene download.'
        : /landsat/i.test(source)
            ? 'Browse/thumbnail overlay; raw multiband Landsat COG rendering is not active.'
            : /firms/i.test(source)
                ? 'Thermal hotspot WMS overlay; not raw optical satellite imagery.'
                : 'Public daily context imagery; not high-resolution tasking evidence.';
    return { source, sceneId, acquisition, layer, cloud, aoi, limitation };
}

function ImageryEvidenceRows({
    actions,
    onApply,
}: {
    actions: AgentAction[];
    onApply: (action: AgentAction) => void;
}) {
    const imageryActions = actions.filter(isImageryAction);
    if (imageryActions.length === 0) return null;
    return (
        <div className="mt-2 border-t border-zinc-900 pt-2">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase font-mono text-zinc-500">
                <Satellite size={12} />
                <span>Imagery evidence</span>
            </div>
            <div className="space-y-1">
                {imageryActions.map((action, idx) => {
                    const details = imageryDetails(action);
                    return (
                        <div key={`${action.type}-${idx}`} className="grid gap-1 border-l border-cyan-900/60 pl-2 text-[11px] leading-relaxed text-zinc-400">
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="truncate text-zinc-200">{action.label || formatActionType(action.type)}</div>
                                    <div className="text-zinc-500">{details.source} · {details.acquisition}</div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => onApply(action)}
                                    className="shrink-0 rounded border border-cyan-800/80 bg-cyan-950/30 px-2 py-1 text-[10px] font-mono text-cyan-200 hover:border-cyan-500"
                                >
                                    Show
                                </button>
                            </div>
                            <div className="text-zinc-500">
                                {details.layer}
                                {details.cloud ? ` · ${details.cloud}` : ''}
                                {details.aoi ? ` · ${details.aoi}` : ''}
                            </div>
                            {details.sceneId && <div className="truncate font-mono text-[10px] text-zinc-600">Scene: {details.sceneId}</div>}
                            <div className="text-zinc-600">{details.limitation}</div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function paramsToPayload(params: URLSearchParams, skip: Set<string> = new Set()): Record<string, any> {
    const payload: Record<string, any> = {};
    params.forEach((value, key) => {
        if (skip.has(key)) return;
        if (/^(bbox|bounds|center|coordinates)$/i.test(key)) {
            const values = value.split(',').map((part) => Number(part.trim()));
            payload[key] = values.length > 0 && values.every((part) => Number.isFinite(part)) ? values : value;
            return;
        }
        if (/^(lat|lng|lon|height|height_m|speed|alt|heading|heading_deg|speed_mps|opacity|alpha|maxCloudCover|max_cloud_cover|width|height_px)$/i.test(key)) {
            const numeric = Number(value);
            payload[key] = Number.isFinite(numeric) ? numeric : value;
            return;
        }
        if (/^(show_marker|draw_marker|enabled)$/i.test(key)) {
            payload[key] = ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
            return;
        }
        payload[key] = value;
    });
    return payload;
}

function parseJsonParam(params: URLSearchParams): Record<string, any> {
    const raw = params.get('payload') || params.get('payload_json');
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function parseOpenSpyLink(href: string, fallbackLabel?: string): AgentAction | null {
    if (!href || !href.startsWith('ospy://')) return null;
    const url = new URL(href);
    const target = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
    const pathId = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] || '');
    const params = url.searchParams;
    const label = params.get('label') || fallbackLabel || undefined;
    const jsonPayload = parseJsonParam(params);
    const skip = new Set(['type', 'label', 'payload', 'payload_json']);
    const payload = {
        ...paramsToPayload(params, skip),
        ...jsonPayload,
    };

    if (target === 'entity' || target === 'object') {
        const id = canonicalObjectIdForLayer(
            payload.entity_id || payload.entityId || payload.id || pathId,
            payload.layer || payload.layer_id || payload.layerId,
        );
        if (!id) throw new Error(`ospy://${target} requires entity_id or id`);
        return {
            type: params.get('type') || (target === 'entity' ? 'entity.open' : 'object.open'),
            label: label || `Open ${payload.name || payload.display_name || id}`,
            payload: {
                ...payload,
                id,
                entity_id: id,
                object_type: payload.object_type || payload.objectType || typeForLayer(payload.layer || payload.layer_id || target),
                show_marker: payload.show_marker ?? true,
                draw_marker: payload.draw_marker ?? true,
            },
        };
    }

    if (target === 'asset' || target === 'event') {
        const id = canonicalObjectIdForLayer(
            target === 'asset'
                ? (payload.asset_id || payload.assetId || payload.id || pathId)
                : (payload.event_id || payload.eventId || payload.id || pathId),
            payload.layer || payload.layer_id || payload.layerId,
        );
        if (!id) throw new Error(`ospy://${target} requires ${target}_id or id`);
        return {
            type: params.get('type') || (target === 'asset' ? 'asset.open' : 'event.open'),
            label: label || `Open ${payload.name || payload.display_name || id}`,
            payload: {
                ...payload,
                id,
                ...(target === 'asset' ? { asset_id: id } : {}),
                ...(target === 'event' ? { event_id: id } : {}),
                object_type: payload.object_type || payload.objectType || typeForLayer(payload.layer || payload.layer_id || target),
                show_marker: payload.show_marker ?? true,
                draw_marker: payload.draw_marker ?? true,
            },
        };
    }

    if (target === 'selection') {
        const type = params.get('type') || 'selection.apply';
        if (!payload.selection_id && !payload.selectionId && pathId) payload.selection_id = pathId;
        if (type !== 'selection.clear' && !payload.selection_id && !payload.selectionId) {
            throw new Error('ospy://selection requires selection_id');
        }
        const selectionId = payload.selection_id || payload.selectionId;
        const layer = payload.layer || payload.layer_id;
        return {
            type,
            label: label || (type === 'selection.clear' ? 'Clear selection' : 'Apply selection'),
            payload: {
                ...payload,
                selection_id: selectionId,
                selectionId,
                layer,
            },
        };
    }

    if (target === 'replay') {
        const explicitType = params.get('type');
        const type = explicitType || (payload.from || payload.to ? 'replay.play_window' : 'replay.seek');
        if (type === 'replay.play_window' && !payload.from && !payload.at && !payload.time) {
            throw new Error('ospy://replay play_window requires from, at, or time');
        }
        if (type === 'replay.seek' && !payload.at && !payload.time) {
            throw new Error('ospy://replay seek requires at or time');
        }
        return {
            type,
            label: label || (type === 'replay.seek' ? 'Seek replay' : 'Play replay'),
            payload,
        };
    }

    if (target === 'imagery') {
        const explicitType = params.get('type');
        const type = explicitType
            || (payload.before || payload.after ? 'imagery.compare' : payload.scene_id || payload.scene ? 'imagery.show_scene' : 'imagery.show_layer');
        return {
            type,
            label: label || formatActionType(type),
            payload,
        };
    }

    if (target === 'map' || target === 'camera') {
        const explicitType = params.get('type');
        const hasLat = payload.lat !== undefined || payload.latitude !== undefined;
        const hasLng = payload.lng !== undefined || payload.lon !== undefined || payload.longitude !== undefined;
        const hasPoint = (hasLat && hasLng) || payload.center !== undefined;
        const type = explicitType || (!hasPoint && payload.bbox ? 'map.add_aoi' : 'map.fly_to');
        return {
            type,
            label: label || (type === 'map.add_aoi' ? 'Show area' : 'Move map'),
            payload,
        };
    }

    if (target === 'action') {
        const type = params.get('type');
        if (!type) throw new Error('ospy://action requires type');
        return {
            type,
            label: label || formatActionType(type),
            payload,
        };
    }

    throw new Error(`Unsupported OpenSpy link target: ${target}`);
}

function inspectOpenSpyLink(href: string, fallbackLabel?: string): { target: string; actionType: string; valid: boolean; error?: string } {
    if (!href || !href.startsWith('ospy://')) return { target: '', actionType: '', valid: false };
    try {
        const url = new URL(href);
        const target = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
        const action = parseOpenSpyLink(href, fallbackLabel);
        return { target, actionType: action?.type || '', valid: Boolean(target && action?.type) };
    } catch (err) {
        return {
            target: '',
            actionType: '',
            valid: false,
            error: err instanceof Error ? err.message : 'Invalid OpenSpy link',
        };
    }
}

function childrenText(value: any): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(childrenText).join('');
    if (value && typeof value === 'object' && 'props' in value) return childrenText(value.props?.children);
    return '';
}

function MarkdownBlock({
    text,
    onOpenSpyLinkClick,
}: {
    text: string;
    onOpenSpyLinkClick?: (href: string, label?: string) => void;
}) {
    const cleaned = cleanVisibleText(text);
    if (!cleaned) return null;
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => (url.startsWith('ospy://') ? url : defaultUrlTransform(url))}
            components={{
                p: ({ children }) => <p className="my-1 text-xs leading-relaxed text-zinc-300">{children}</p>,
                ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-zinc-300">{children}</ul>,
                ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-4 text-xs leading-relaxed text-zinc-300">{children}</ol>,
                li: ({ children }) => <li>{children}</li>,
                strong: ({ children }) => <strong className="font-semibold text-zinc-100">{children}</strong>,
                code: ({ children }) => <code className="rounded bg-zinc-900 px-1 py-0.5 text-[11px] text-cyan-200">{children}</code>,
                h1: ({ children }) => <div className="mt-2 text-[13px] font-semibold text-zinc-100">{children}</div>,
                h2: ({ children }) => <div className="mt-2 text-[12px] font-semibold text-zinc-100">{children}</div>,
                h3: ({ children }) => <div className="mt-2 text-[12px] font-semibold text-zinc-100">{children}</div>,
                table: ({ children }) => (
                    <div className="my-2 overflow-x-auto rounded border border-zinc-800">
                        <table className="min-w-full border-collapse text-left text-[10px] text-zinc-300">{children}</table>
                    </div>
                ),
                thead: ({ children }) => <thead className="bg-zinc-900/80 text-zinc-100">{children}</thead>,
                th: ({ children }) => <th className="border-b border-zinc-800 px-2 py-1 font-semibold">{children}</th>,
                tr: ({ children }) => <tr className="odd:bg-zinc-950/80 even:bg-zinc-900/30">{children}</tr>,
                td: ({ children }) => <td className="border-t border-zinc-900 px-2 py-1 align-top">{children}</td>,
                a: ({ href, children }) => {
                    const linkHref = String(href || '');
                    if (linkHref.startsWith('ospy://')) {
                        const label = childrenText(children);
                        const linkInfo = inspectOpenSpyLink(linkHref, label);
                        if (!linkInfo.valid) {
                            return (
                                <span
                                    title={linkInfo.error || 'Invalid OpenSpy link'}
                                    data-ospy-invalid="true"
                                    data-ospy-link={linkHref}
                                    className="inline-flex max-w-full items-baseline rounded border border-red-900/70 bg-red-950/20 px-1 py-0.5 align-baseline font-mono text-[11px] leading-none text-red-200"
                                >
                                    {children}
                                </span>
                            );
                        }
                        return (
                            <button
                                type="button"
                                onClick={() => onOpenSpyLinkClick?.(linkHref, label)}
                                title="Open in OpenSpy"
                                data-ospy-link={linkHref}
                                data-ospy-target={linkInfo.target}
                                data-action-type={linkInfo.actionType}
                                className="inline-flex max-w-full items-baseline rounded border border-cyan-900/70 bg-cyan-950/20 px-1 py-0.5 align-baseline font-mono text-[11px] leading-none text-cyan-200 underline decoration-cyan-700/70 underline-offset-2 hover:border-cyan-500 hover:bg-cyan-950/50 hover:text-cyan-100"
                            >
                                {children}
                            </button>
                        );
                    }
                    return (
                        <a
                            href={linkHref}
                            target="_blank"
                            rel="noreferrer"
                            className="text-cyan-300 underline decoration-cyan-700 underline-offset-2 hover:text-cyan-100"
                        >
                            {children}
                        </a>
                    );
                },
            }}
        >
            {cleaned}
        </ReactMarkdown>
    );
}

function isMessageCurrentlyStreaming(message: AgentMessage, runningRunId: string | null): boolean {
    if (!runningRunId) return false;
    const metadataRunId = typeof message.metadata?.run_id === 'string' ? message.metadata.run_id : '';
    return message.agent_message_id === `run:${runningRunId}` || metadataRunId === runningRunId;
}

function displayPartsForMessage(message: AgentMessage, runningRunId: string | null): AgentStreamPart[] {
    const parts = streamPartsFromMetadata(message.metadata);
    if (parts.length === 0) return [];
    if (!isMessageCurrentlyStreaming(message, runningRunId) && cleanVisibleText(message.content)) {
        return parts.filter((part) => part.type !== 'text');
    }
    return parts;
}

function shouldRenderFinalContent(message: AgentMessage, streamParts: AgentStreamPart[], runningRunId: string | null): boolean {
    if (!message.content) return false;
    if (streamParts.length === 0) return true;
    return !isMessageCurrentlyStreaming(message, runningRunId);
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
    const visibleParts = parts.filter((part) => part.state === 'started' || part.state === 'completed');
    if (visibleParts.length === 0) return null;
    const rows: Array<{
        key: string;
        id: string;
        name?: string;
        toolUseId?: string;
        providerToolName?: string;
        command?: string;
        rawTypes: string[];
        input?: any;
        output?: any;
        state?: 'started' | 'completed' | 'status';
        isError?: boolean;
    }> = [];
    const rowByKey = new Map<string, (typeof rows)[number]>();
    for (const part of visibleParts) {
        const key = part.toolUseId ? `tool:${part.toolUseId}` : part.id;
        let row = rowByKey.get(key);
        if (!row) {
            row = {
                key,
                id: part.id,
                name: part.name,
                toolUseId: part.toolUseId,
                providerToolName: part.providerToolName,
                command: part.command || shellCommandFromPayload(part.input),
                rawTypes: [],
                state: part.state,
                isError: part.isError,
            };
            rowByKey.set(key, row);
            rows.push(row);
        }
        if (part.name && (!row.name || isGenericToolName(row.name) || !isGenericToolName(part.name))) row.name = part.name;
        if (part.toolUseId) row.toolUseId = part.toolUseId;
        if (part.providerToolName) row.providerToolName = part.providerToolName;
        if (part.command || shellCommandFromPayload(part.input)) row.command = part.command || shellCommandFromPayload(part.input);
        if (part.rawType && !row.rawTypes.includes(part.rawType)) row.rawTypes.push(part.rawType);
        if (part.input !== undefined) row.input = part.input;
        if (part.output !== undefined) row.output = part.output;
        if (part.state === 'completed') row.state = 'completed';
        if (part.isError) row.isError = true;
    }
    const runningCount = rows.filter((part) => part.state === 'started').length;
    const failedCount = rows.filter((part) => part.isError).length;
    const completedCount = rows.filter((part) => part.state === 'completed' && !part.isError).length;
    const summaryParts = [
        runningCount > 0 ? `${runningCount} running` : '',
        completedCount > 0 ? `${completedCount} completed` : '',
        failedCount > 0 ? `${failedCount} failed` : '',
    ].filter(Boolean);
    const summaryLabel = runningCount > 0
        ? `Working${summaryParts.length > 0 ? `: ${summaryParts.join(', ')}` : ''}`
        : failedCount > 0
            ? 'Evidence trace · attention'
            : 'Evidence trace';
    return (
        <details
            className={`my-1 rounded border px-2 py-1 text-[10px] font-mono ${
                failedCount > 0
                    ? 'border-red-950/50 bg-red-950/10 text-red-300'
                    : runningCount > 0
                        ? 'border-zinc-800 bg-zinc-900/60 text-zinc-400'
                        : 'border-cyan-950/60 bg-cyan-950/10 text-cyan-300'
            }`}
            data-agent-tool-group="true"
        >
            <summary className="flex cursor-pointer list-none items-center gap-1.5">
                <Database size={12} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                    {summaryLabel}
                </span>
            </summary>
            <div className="mt-1 space-y-1 border-t border-zinc-800/70 pt-1">
                {rows.map((part) => {
                    const input = formatToolPayload(part.input);
                    const output = formatToolPayload(part.output);
                    const title = displayToolName(part);
                    return (
                        <details
                            key={part.key}
                            className={`rounded border px-2 py-1 ${
                                part.isError
                                    ? 'border-red-950/60 bg-red-950/15 text-red-300'
                                    : part.state === 'started'
                                        ? 'border-zinc-800 bg-zinc-900/60 text-zinc-400'
                                        : 'border-cyan-950/70 bg-cyan-950/15 text-cyan-300'
                            }`}
                            data-agent-tool-row="true"
                        >
                            <summary className="flex cursor-pointer list-none items-center gap-1.5">
                                <span className="min-w-0 flex-1 truncate">
                                    {part.state === 'started' ? 'Started' : part.isError ? 'Failed' : 'Completed'}: {title}
                                </span>
                            </summary>
                            <div className="mt-1 space-y-1 border-t border-zinc-800/70 pt-1 text-[10px] text-zinc-400">
                                {part.name && part.name !== title && (
                                    <div className="truncate">
                                        <span className="text-zinc-500">normalized:</span> {part.name}
                                    </div>
                                )}
                                {part.providerToolName && part.providerToolName !== title && (
                                    <div className="truncate">
                                        <span className="text-zinc-500">provider tool:</span> {part.providerToolName}
                                    </div>
                                )}
                                {part.command && (
                                    <div className="truncate">
                                        <span className="text-zinc-500">command:</span> {part.command}
                                    </div>
                                )}
                                {part.toolUseId && (
                                    <div className="truncate">
                                        <span className="text-zinc-500">id:</span> {part.toolUseId}
                                    </div>
                                )}
                                {part.rawTypes.length > 0 && (
                                    <div className="truncate">
                                        <span className="text-zinc-500">event:</span> {part.rawTypes.join(', ')}
                                    </div>
                                )}
                                {input && (
                                    <div>
                                        <div className="mb-0.5 text-zinc-500">IN</div>
                                        <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded bg-black/60 p-2 text-[10px] leading-relaxed text-zinc-300">
                                            {input}
                                        </pre>
                                    </div>
                                )}
                                {output && (
                                    <div>
                                        <div className="mb-0.5 text-zinc-500">OUT</div>
                                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-black/60 p-2 text-[10px] leading-relaxed text-zinc-300">
                                            {output}
                                        </pre>
                                    </div>
                                )}
                                {!input && !output && (
                                    <div className="text-zinc-600">No structured payload in stream event.</div>
                                )}
                            </div>
                        </details>
                    );
                })}
            </div>
        </details>
    );
}

function streamPartsFromMetadata(metadata: Record<string, any> | undefined): AgentStreamPart[] {
    return Array.isArray(metadata?.streamParts) ? metadata.streamParts : [];
}

function streamTextFromMetadata(metadata: Record<string, any> | undefined): string {
    return streamPartsFromMetadata(metadata)
        .filter((part) => part.type === 'text')
        .map((part) => part.text || '')
        .join('');
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
                toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined,
                rawType: typeof payload.raw_type === 'string' ? payload.raw_type : undefined,
                providerToolName: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
                command: typeof payload.command === 'string' ? payload.command : undefined,
                input: payload.input,
                output: payload.output,
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

function roundCoord(value: number, digits = 6): number | null {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function cartographicToLatLng(carto: Cesium.Cartographic | undefined | null): Record<string, number | null> | null {
    if (!carto) return null;
    return {
        lat: roundCoord(Cesium.Math.toDegrees(carto.latitude)),
        lng: roundCoord(Cesium.Math.toDegrees(carto.longitude)),
        height_m: roundCoord(carto.height, 1),
    };
}

function buildAgentRequestContext(): Record<string, any> {
    const timeline = useTimelineStore.getState();
    const viewer = getViewer();
    const context: Record<string, any> = {
        timeline: {
            mode: timeline.mode,
            playbackKind: timeline.playbackKind,
            currentTime: timeline.currentTime?.toISOString?.(),
            isPlaying: timeline.isPlaying,
            speedMultiplier: timeline.speedMultiplier,
        },
        layers: {
            sources: timeline.sources,
            visibility: timeline.visibility,
            subtypeVisibility: timeline.subtypeVisibility,
            sourceVisibility: timeline.sourceVisibility,
            activeFilter: timeline.activeFilter,
            selectedEntityId: timeline.selectedEntityId,
        },
    };
    if (!viewer?.camera || !viewer?.scene?.canvas || !viewer?.scene?.globe?.ellipsoid) return context;

    const cameraCarto = viewer.camera.positionCartographic;
    const canvas = viewer.scene.canvas;
    const screenCenter = new Cesium.Cartesian2(
        Math.max(1, canvas.clientWidth || canvas.width || 1) / 2,
        Math.max(1, canvas.clientHeight || canvas.height || 1) / 2,
    );
    const groundCartesian = viewer.camera.pickEllipsoid(screenCenter, viewer.scene.globe.ellipsoid);
    const groundCarto = groundCartesian
        ? Cesium.Cartographic.fromCartesian(groundCartesian, viewer.scene.globe.ellipsoid)
        : null;
    const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);

    context.view = {
        camera: {
            ...(cartographicToLatLng(cameraCarto) || {}),
            heading_deg: roundCoord(Cesium.Math.toDegrees(viewer.camera.heading), 2),
            pitch_deg: roundCoord(Cesium.Math.toDegrees(viewer.camera.pitch), 2),
            roll_deg: roundCoord(Cesium.Math.toDegrees(viewer.camera.roll), 2),
        },
        groundTarget: cartographicToLatLng(groundCarto),
        bbox: rect ? [
            roundCoord(Cesium.Math.toDegrees(rect.west)),
            roundCoord(Cesium.Math.toDegrees(rect.south)),
            roundCoord(Cesium.Math.toDegrees(rect.east)),
            roundCoord(Cesium.Math.toDegrees(rect.north)),
        ] : null,
        bboxOrder: 'west,south,east,north',
        capturedAt: new Date().toISOString(),
    };
    return context;
}

function normalizeLayerKey(layer: any): string | null {
    const raw = String(layer || '').trim();
    if (!raw) return null;
    return LAYER_KEY_ALIASES[raw] || LAYER_KEY_ALIASES[raw.replace(/-/g, '_')] || null;
}

function normalizeCatalogLayerId(layer: any): string {
    const raw = String(layer || '').trim();
    if (!raw) return '';
    const key = raw.replace(/-/g, '_').toLowerCase();
    const aliases: Record<string, string> = {
        aviation: 'aircraft',
        aircraft: 'aircraft',
        maritime: 'vessel',
        vessel: 'vessel',
        vessels: 'vessel',
        satellites: 'satellite',
        satellite: 'satellite',
        fires: 'fire',
        fire: 'fire',
        outages: 'outage',
        outage: 'outage',
        conflicts: 'conflict',
        conflict: 'conflict',
        pipelines: 'pipeline',
        pipeline: 'pipeline',
        cables: 'cable',
        cable: 'cable',
    };
    return aliases[key] || raw;
}

function canonicalObjectIdForLayer(id: any, layer: any): string {
    const raw = String(id || '').trim();
    if (!raw || raw.includes(':')) return raw;
    const layerId = normalizeCatalogLayerId(layer);
    return layerId ? `${layerId}:${raw}` : raw;
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

function explicitBoolean(value: any): boolean | null {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    }
    return null;
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

function normalizeAppliedSelectionsPatch(value: any, current: Record<string, any> = {}): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const patch: Record<string, any> = {};
    for (const [rawLayer, rawSelection] of Object.entries(value)) {
        if (!rawSelection || typeof rawSelection !== 'object' || Array.isArray(rawSelection)) continue;
        const selection = rawSelection as Record<string, any>;
        const layer = normalizeCatalogLayerId(rawLayer) || String(rawLayer || '').trim();
        const selectionId = String(selection.selectionId || selection.selection_id || '').trim();
        if (!layer || !selectionId) continue;
        const mode = ['replace', 'append', 'exclude', 'only'].includes(String(selection.mode))
            ? String(selection.mode)
            : 'only';
        const existing = current[layer];
        patch[layer] = {
            ...(existing?.selectionId === selectionId ? existing : {}),
            selectionId,
            mode,
            layer,
            updatedAt: selection.updatedAt || selection.updated_at || existing?.updatedAt,
        };
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
    if (viewState.appliedSelections && typeof viewState.appliedSelections === 'object') {
        patch.appliedSelections = {
            ...(current.appliedSelections || {}),
            ...normalizeAppliedSelectionsPatch(viewState.appliedSelections, current.appliedSelections || {}),
        };
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
        if (!item) continue;
        if (typeof item === 'string') {
            const layerKey = normalizeLayerKey(item);
            if (layerKey) patch.visibility = { ...(patch.visibility || {}), [layerKey]: true };
            continue;
        }
        if (typeof item !== 'object') continue;
        const layerKey = normalizeLayerKey(item.layer || item.layer_id || item.id);
        if (!layerKey) continue;
        const target = item.target === 'sources' || item.source === true ? 'sources' : 'visibility';
        const nextValue = explicitBoolean(item.enabled ?? item.visible ?? item.value) ?? true;
        patch[target] = { ...(patch[target] || {}), [layerKey]: nextValue };
    }

    if (Array.isArray(payload.visible)) {
        for (const item of payload.visible) {
            const layerKey = normalizeLayerKey(item);
            if (layerKey) patch.visibility = { ...(patch.visibility || {}), [layerKey]: true };
        }
    }
    if (Array.isArray(payload.hidden)) {
        for (const item of payload.hidden) {
            const layerKey = normalizeLayerKey(item);
            if (layerKey) patch.visibility = { ...(patch.visibility || {}), [layerKey]: false };
        }
    }

    const singleLayer = normalizeLayerKey(payload.layer || payload.layer_id);
    if (singleLayer) {
        const target = payload.target === 'sources' || payload.source === true ? 'sources' : 'visibility';
        const nextValue = explicitBoolean(payload.enabled ?? payload.visible ?? payload.value) ?? true;
        patch[target] = { ...(patch[target] || {}), [singleLayer]: nextValue };
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

function overlayHeightFromPayload(payload: Record<string, any>, fallback = AGENT_GEOMETRY_HEIGHT_M): number {
    const raw = payload.height ?? payload.alt ?? payload.altitude ?? payload.height_m ?? payload.heightMeters;
    const height = Number(raw);
    return Number.isFinite(height) ? height : fallback;
}

function labelClusterKey(lat: number, lng: number): string {
    return `${Math.round(lat * 100)}:${Math.round(lng * 100)}`;
}

function labelOffsetFromPayload(payload: Record<string, any>, lat: number, lng: number): Cesium.Cartesian2 {
    const explicitX = Number(payload.label_offset_x ?? payload.labelOffsetX ?? payload.pixel_offset_x ?? payload.pixelOffsetX);
    const explicitY = Number(payload.label_offset_y ?? payload.labelOffsetY ?? payload.pixel_offset_y ?? payload.pixelOffsetY);
    if (Number.isFinite(explicitX) || Number.isFinite(explicitY)) {
        return new Cesium.Cartesian2(Number.isFinite(explicitX) ? explicitX : 0, Number.isFinite(explicitY) ? explicitY : AGENT_LABEL_OFFSET_Y);
    }
    const key = labelClusterKey(lat, lng);
    const index = agentLabelClusterCounts.get(key) || 0;
    agentLabelClusterCounts.set(key, index + 1);
    const base = AGENT_LABEL_STAGGER_OFFSETS[index % AGENT_LABEL_STAGGER_OFFSETS.length];
    const cycle = Math.floor(index / AGENT_LABEL_STAGGER_OFFSETS.length);
    return new Cesium.Cartesian2(base[0], base[1] - cycle * 60);
}

function labelGraphics(text: string, pixelOffset = new Cesium.Cartesian2(0, AGENT_LABEL_OFFSET_Y)): Cesium.LabelGraphics.ConstructorOptions {
    return {
        text,
        font: AGENT_LABEL_FONT,
        pixelOffset,
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.62),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
    };
}

function shouldClampOverlayToGround(payload: Record<string, any>): boolean {
    return explicitBoolean(payload.clampToGround ?? payload.clamp_to_ground) === true;
}

function shouldShowGeometryLabel(payload: Record<string, any>): boolean {
    return explicitBoolean(payload.show_label ?? payload.showLabel ?? payload.label_visible ?? payload.labelVisible) === true;
}

function polygonGraphics(
    coords: Array<[number, number]>,
    fill: Cesium.Color,
    outline: Cesium.Color,
    height: number,
): Cesium.PolygonGraphics.ConstructorOptions {
    const clampToGround = height <= 0;
    const graphics: Cesium.PolygonGraphics.ConstructorOptions = {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(coords.flat()),
        material: fill,
        outline: !clampToGround,
        outlineColor: outline,
        perPositionHeight: false,
    };
    if (clampToGround) {
        graphics.height = 0;
        (graphics as any).heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
    } else {
        graphics.height = height;
    }
    return graphics;
}

function drawGroundPolygonOutline(
    viewer: Cesium.Viewer,
    id: string,
    coords: Array<[number, number]>,
    outline: Cesium.Color,
    width = 3,
): void {
    const closed = coords.length > 0
        && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])
        ? [...coords, coords[0]]
        : coords;
    if (closed.length < 2) return;
    viewer.entities.add({
        id: `${id}:outline`,
        polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(closed.flat()),
            width,
            material: outline,
            clampToGround: true,
        },
    });
}

function normalizeOpenSpyBbox(values: number[]): [number, number, number, number] | null {
    if (!Array.isArray(values) || values.length < 4) return null;
    let [west, south, east, north] = values.slice(0, 4).map(Number);
    if (![west, south, east, north].every(Number.isFinite)) return null;
    if (west < -180 || west > 180 || east < -180 || east > 180) return null;
    if (south < -90 || south > 90 || north < -90 || north > 90) return null;
    if (north < south) return null;
    if (east === west) {
        const epsilon = 0.0001;
        west = Math.max(-180, west - epsilon);
        east = Math.min(180, east + epsilon);
    }
    if (north === south) {
        const epsilon = 0.0001;
        south = Math.max(-90, south - epsilon);
        north = Math.min(90, north + epsilon);
    }
    return [west, south, east, north];
}

function bboxToDegreesArray(bbox: any): number[] | null {
    if (Array.isArray(bbox) && bbox.length >= 4) {
        return normalizeOpenSpyBbox(bbox.slice(0, 4).map(Number));
    }
    if (bbox && typeof bbox === 'object') {
        const west = Number(bbox.west ?? bbox.minLng ?? bbox.min_lng ?? bbox.lng_min);
        const south = Number(bbox.south ?? bbox.minLat ?? bbox.min_lat ?? bbox.lat_min);
        const east = Number(bbox.east ?? bbox.maxLng ?? bbox.max_lng ?? bbox.lng_max);
        const north = Number(bbox.north ?? bbox.maxLat ?? bbox.max_lat ?? bbox.lat_max);
        return normalizeOpenSpyBbox([west, south, east, north]);
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

function trackPointFromValue(value: any): TrackPoint | null {
    if (!value || typeof value !== 'object') return null;
    const props = value.properties && typeof value.properties === 'object' ? value.properties : {};
    const coordinates = value.geometry?.coordinates || value.coordinates;
    const pair = Array.isArray(coordinates) ? normalizeCoordinatePair(coordinates) : null;
    const lng = Number(value.lng ?? value.lon ?? value.longitude ?? value.display_lng ?? props.lng ?? props.lon ?? props.longitude ?? props.display_lng ?? pair?.[0]);
    const lat = Number(value.lat ?? value.latitude ?? value.display_lat ?? props.lat ?? props.latitude ?? props.display_lat ?? pair?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const alt = Number(value.alt ?? value.altitude ?? value.altitude_m ?? props.alt ?? props.altitude ?? props.altitude_m ?? coordinates?.[2] ?? 0);
    const at = String(value.at || value.time || value.observed_at || props.at || props.time || props.observed_at || '');
    const heading = Number(value.heading_deg ?? value.heading ?? props.heading_deg ?? props.heading);
    const speed = Number(value.speed_mps ?? value.speed ?? props.speed_mps ?? props.speed);
    return {
        lat,
        lng,
        alt: Number.isFinite(alt) ? alt : 0,
        at: at || undefined,
        heading: Number.isFinite(heading) ? heading : undefined,
        speed: Number.isFinite(speed) ? speed : undefined,
        layer: value.layer_id || props.layer_id || undefined,
        source: value.source_id || props.source_id || undefined,
    };
}

function trackPointsFromPayload(payload: Record<string, any>): TrackPoint[] {
    const candidates = payload.points || payload.track || payload.samples || payload.items || payload.coordinates || [];
    if (!Array.isArray(candidates)) return [];
    if (candidates.length > 0 && Array.isArray(candidates[0])) {
        const points: TrackPoint[] = [];
        for (const item of candidates) {
            const pair = normalizeCoordinatePair(item);
            if (!pair) continue;
            const alt = Number(item[2] || 0);
            points.push({ lng: pair[0], lat: pair[1], alt: Number.isFinite(alt) ? alt : 0 });
        }
        return points;
    }
    return candidates
        .map(trackPointFromValue)
        .filter((point: TrackPoint | null): point is TrackPoint => point !== null);
}

function drawTrackOverlay(
    viewer: Cesium.Viewer,
    points: TrackPoint[],
    payload: Record<string, any>,
    label: string,
): void {
    if (points.length < 2) throw new Error('Track action requires at least two points');
    const color = colorFromPayload(payload.color, Cesium.Color.CYAN);
    const idBase = `${AGENT_ENTITY_PREFIX}track-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const visualHeight = overlayHeightFromPayload(payload, AGENT_LINE_HEIGHT_M);
    const clampToGround = shouldClampOverlayToGround(payload);
    const positions = points.flatMap((point) => [point.lng, point.lat, Number(point.alt || visualHeight)]);
    viewer.entities.add({
        id: `${idBase}:line`,
        polyline: {
            positions: clampToGround
                ? Cesium.Cartesian3.fromDegreesArray(points.flatMap((point) => [point.lng, point.lat]))
                : Cesium.Cartesian3.fromDegreesArrayHeights(positions),
            width: Number(payload.width || 6),
            material: payload.arrow === false
                ? color.withAlpha(Number(payload.alpha ?? 0.85))
                : new Cesium.PolylineArrowMaterialProperty(color.withAlpha(Number(payload.alpha ?? 0.9))),
            clampToGround,
        },
    });
    const first = points[0];
    const last = points[points.length - 1];
    drawPointOrLabel(viewer, {
        lat: first.lat,
        lng: first.lng,
        label: payload.start_label || 'start',
        pixelSize: 7,
    }, 'track start', color.withAlpha(0.75));
    drawPointOrLabel(viewer, {
        lat: last.lat,
        lng: last.lng,
        label: payload.label || label || payload.entity_id || 'track',
        pixelSize: 10,
    }, label || 'track', color);
}

async function fetchTrackPoints(payload: Record<string, any>): Promise<TrackPoint[]> {
    const existing = trackPointsFromPayload(payload);
    if (existing.length >= 2) return existing;
    const entityId = String(payload.entity_id || payload.entityId || payload.id || '').trim();
    if (!entityId) return existing;
    const params = new URLSearchParams();
    if (payload.from) params.set('from', String(payload.from));
    if (payload.to) params.set('to', String(payload.to));
    if (payload.limit) params.set('limit', String(payload.limit));
    if (payload.stepSeconds || payload.step_seconds) params.set('stepSeconds', String(payload.stepSeconds || payload.step_seconds));
    const response = await fetch(`${API_URL}/api/replay/track/${encodeURIComponent(entityId)}?${params.toString()}`);
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(json?.error || `Track fetch failed for ${entityId}`);
    return (Array.isArray(json?.items) ? json.items : [])
        .map(trackPointFromValue)
        .filter((point: TrackPoint | null): point is TrackPoint => point !== null);
}

function nearestTrackPoint(points: TrackPoint[], at: string): TrackPoint | null {
    if (points.length === 0) return null;
    const target = new Date(at).getTime();
    if (Number.isNaN(target)) return points[points.length - 1] || null;
    let best = points[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const point of points) {
        const observed = point.at ? new Date(point.at).getTime() : Number.NaN;
        const delta = Number.isNaN(observed) ? Number.POSITIVE_INFINITY : Math.abs(observed - target);
        if (delta < bestDelta) {
            best = point;
            bestDelta = delta;
        }
    }
    return best || null;
}

async function resolveEntityPoint(payload: Record<string, any>, entityId: string): Promise<TrackPoint | null> {
    const lat = Number(payload.lat ?? payload.latitude);
    const lng = Number(payload.lng ?? payload.lon ?? payload.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return {
            lat,
            lng,
            alt: Number(payload.alt ?? payload.altitude ?? payload.height ?? 0) || 0,
            at: payload.at || payload.time || undefined,
            heading: Number.isFinite(Number(payload.heading_deg ?? payload.heading)) ? Number(payload.heading_deg ?? payload.heading) : undefined,
            speed: Number.isFinite(Number(payload.speed_mps ?? payload.speed)) ? Number(payload.speed_mps ?? payload.speed) : undefined,
            layer: payload.layer || payload.layer_id || undefined,
            source: payload.source || payload.source_id || undefined,
        };
    }

    const at = String(payload.at || payload.time || '').trim();
    const date = at ? new Date(at) : null;
    if (!date || Number.isNaN(date.getTime())) return null;
    const windowMinutes = Number(payload.lookup_window_minutes ?? payload.lookupWindowMinutes ?? 30);
    const boundedWindowMinutes = Number.isFinite(windowMinutes) ? Math.max(1, Math.trunc(windowMinutes)) : 30;
    const from = new Date(date.getTime() - boundedWindowMinutes * 60_000).toISOString();
    const to = new Date(date.getTime() + boundedWindowMinutes * 60_000).toISOString();
    const points = await fetchTrackPoints({
        entity_id: entityId,
        from,
        to,
        limit: payload.lookup_limit ?? payload.lookupLimit ?? 120,
        stepSeconds: payload.stepSeconds || payload.step_seconds,
    });
    return nearestTrackPoint(points, at);
}

async function animateTrackOverlay(
    viewer: Cesium.Viewer,
    points: TrackPoint[],
    payload: Record<string, any>,
    label: string,
): Promise<void> {
    if (points.length < 2) throw new Error('Track animation requires at least two points');
    drawTrackOverlay(viewer, points, payload, label);
    const color = colorFromPayload(payload.color, Cesium.Color.LIME);
    const marker = viewer.entities.add({
        id: `${AGENT_ENTITY_PREFIX}track-marker-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        position: Cesium.Cartesian3.fromDegrees(points[0].lng, points[0].lat, Number(points[0].alt || overlayHeightFromPayload(payload, AGENT_LINE_HEIGHT_M))),
        point: {
            pixelSize: Number(payload.pixelSize || 12),
            color: color.withAlpha(0.95),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: labelGraphics(
            String(payload.label || label || payload.entity_id || 'tracked object'),
            labelOffsetFromPayload(payload, points[0].lat, points[0].lng),
        ),
    });
    const durationMs = Math.max(250, Math.min(Number(payload.duration_ms ?? payload.durationMs ?? 3500), 30_000));
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
        const tick = () => {
            const elapsed = performance.now() - startedAt;
            const progress = Math.min(1, elapsed / durationMs);
            const scaled = progress * (points.length - 1);
            const index = Math.min(points.length - 2, Math.floor(scaled));
            const local = scaled - index;
            const a = points[index];
            const b = points[index + 1];
            const lng = a.lng + (b.lng - a.lng) * local;
            const lat = a.lat + (b.lat - a.lat) * local;
            const defaultHeight = overlayHeightFromPayload(payload, AGENT_LINE_HEIGHT_M);
            const alt = Number(a.alt || defaultHeight) + (Number(b.alt || defaultHeight) - Number(a.alt || defaultHeight)) * local;
            (marker as any).position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(lng, lat, alt));
            viewer.scene.requestRender();
            if (progress >= 1) {
                resolve();
                return;
            }
            window.requestAnimationFrame(tick);
        };
        tick();
    });
}

function drawPointOrLabel(
    viewer: Cesium.Viewer,
    payload: Record<string, any>,
    label: string,
    color: Cesium.Color,
): string {
    const lat = Number(payload.lat ?? payload.latitude);
    const lng = Number(payload.lng ?? payload.lon ?? payload.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Point action requires lat and lng');
    const id = String(
        payload.entity_id
        || payload.entityId
        || payload.object_id
        || payload.objectId
        || payload.asset_id
        || payload.assetId
        || payload.event_id
        || payload.eventId
        || payload.id
        || `${AGENT_ENTITY_PREFIX}annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const height = overlayHeightFromPayload(payload, AGENT_LINE_HEIGHT_M);
    const existing = viewer.entities.getById(id);
    if (existing) viewer.entities.remove(existing);
    viewer.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(lng, lat, Number.isFinite(height) ? height : 0),
        properties: {
            layer: typeForLayer(payload.layer || payload.layer_id),
        },
        point: {
            pixelSize: Number(payload.pixelSize || 12),
            color: color.withAlpha(0.9),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: labelGraphics(
            String(payload.label || payload.text || label || 'Agent note'),
            labelOffsetFromPayload(payload, lat, lng),
        ),
    });
    replayMetaMap.set(id, {
        id,
        name: String(payload.name || payload.display_name || payload.label || payload.text || label || id),
        layer: typeForLayer(payload.layer || payload.layer_id),
        layerId: normalizeCatalogLayerId(payload.layer || payload.layer_id || '') || String(payload.layer || payload.layer_id || ''),
        subtype: payload.subtype || payload.type || null,
        source: payload.source || payload.source_id || null,
        lat,
        lng,
        alt: Number.isFinite(height) ? height : 0,
        speed: Number.isFinite(Number(payload.speed_mps ?? payload.speed)) ? Number(payload.speed_mps ?? payload.speed) : null,
        heading: Number.isFinite(Number(payload.heading_deg ?? payload.heading)) ? Number(payload.heading_deg ?? payload.heading) : null,
        description: payload.description || payload.note || undefined,
        extra: {
            ...((payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {}),
            agentOverlay: true,
            observedAt: payload.observed_at || payload.observedAt || payload.at || payload.time || undefined,
        },
    });
    return id;
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
    const height = overlayHeightFromPayload(payload);
    const rawGeometry = payload.geojson || payload.geometry;
    const geojson = rawGeometry?.type === 'Feature' ? rawGeometry.geometry : rawGeometry;

    const bbox = bboxToDegreesArray(payload.bbox || geojson?.bbox || payload);
    if (bbox) {
        const [west, south, east, north] = bbox;
        const rings: Array<[number, number][]> = east < west
            ? [
                [[west, south], [180, south], [180, north], [west, north]],
                [[-180, south], [east, south], [east, north], [-180, north]],
            ]
            : [[[west, south], [east, south], [east, north], [west, north]]];
        rings.forEach((coords, index) => {
            const entityId = rings.length > 1 ? `${id}:${index}` : id;
            viewer.entities.add({
                id: entityId,
                polygon: polygonGraphics(coords, fill, outline, height),
            });
            if (height <= 0) {
                drawGroundPolygonOutline(viewer, entityId, coords, outline, Number(payload.outlineWidth ?? payload.outline_width ?? 3));
            }
        });
        const center = east < west
            ? { lng: ((west + ((east + 360 - west) / 2) + 540) % 360) - 180, lat: (south + north) / 2 }
            : centerOfCoordinates(rings[0]);
        if (center && shouldShowGeometryLabel(payload) && (payload.label || payload.text || label)) {
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
            position: Cesium.Cartesian3.fromDegrees(lng, lat, height),
            ellipse: {
                semiMajorAxis: radius,
                semiMinorAxis: radius,
                material: fill,
                outline: height > 0,
                outlineColor: outline,
                ...(height > 0 ? { height } : { height: 0, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }),
            },
        });
        if (shouldShowGeometryLabel(payload) && (payload.label || payload.text || label)) drawPointOrLabel(viewer, { ...payload, lat, lng, pixelSize: 6 }, label, color);
        return;
    }

    const geometryType = String(payload.geometry_type || payload.type || geojson?.type || '').toLowerCase();
    const actionType = String(payload.action_type || payload.actionType || '').toLowerCase();
    const rawCoordinates = payload.coordinates || geojson?.coordinates || [];
    const lineCoordinates = geometryType.includes('line') || actionType.includes('corridor')
        ? normalizeCoordinates(Array.isArray(rawCoordinates?.[0]?.[0]) ? rawCoordinates[0] : rawCoordinates)
        : [];
    if (lineCoordinates.length >= 2) {
        const clampToGround = shouldClampOverlayToGround(payload);
        viewer.entities.add({
            id,
            polyline: {
                positions: clampToGround
                    ? Cesium.Cartesian3.fromDegreesArray(lineCoordinates.flat())
                    : Cesium.Cartesian3.fromDegreesArrayHeights(lineCoordinates.flatMap(([lng, lat]) => [lng, lat, overlayHeightFromPayload(payload, AGENT_LINE_HEIGHT_M)])),
                width: Number(payload.width || 6),
                material: payload.arrow === false
                    ? outline
                    : new Cesium.PolylineArrowMaterialProperty(outline),
                clampToGround,
            },
        });
        const lineCenter = centerOfCoordinates(lineCoordinates);
        if (lineCenter && shouldShowGeometryLabel(payload) && (payload.label || payload.text || label)) {
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
            polygon: polygonGraphics(polygonCoordinates, fill, outline, height),
        });
        if (height <= 0) {
            drawGroundPolygonOutline(viewer, id, polygonCoordinates, outline, Number(payload.outlineWidth ?? payload.outline_width ?? 3));
        }
        const polygonCenter = centerOfCoordinates(polygonCoordinates);
        if (polygonCenter && shouldShowGeometryLabel(payload) && (payload.label || payload.text || label)) {
            drawPointOrLabel(viewer, { ...payload, ...polygonCenter, pixelSize: 6 }, label, color);
        }
        return;
    }

    drawPointOrLabel(viewer, payload, label, color);
}

function runCursorKey(runId: string): string {
    return `ospy:agent-run-cursor:${runId}`;
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
let replayWindowEndGuardId = 0;
let replayWindowEndGuardTimer: number | null = null;

function cancelReplayWindowEndGuard(): void {
    replayWindowEndGuardId += 1;
    if (replayWindowEndGuardTimer) {
        window.clearTimeout(replayWindowEndGuardTimer);
        replayWindowEndGuardTimer = null;
    }
}

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

function pauseHistoricalPlayback(action: 'pause' | 'stop' = 'pause'): void {
    cancelReplayWindowEndGuard();
    cancelPendingHistoricalPlayback();
    const state = useTimelineStore.getState();
    state.setIsPlaying(false);
    document.dispatchEvent(new CustomEvent('timeline-ctrl', { detail: { action } }));
}

function armReplayWindowEndGuard(to: Date, speed: number): void {
    cancelReplayWindowEndGuard();
    const endMs = to.getTime();
    if (!Number.isFinite(endMs)) return;
    const requestId = ++replayWindowEndGuardId;
    const effectiveSpeed = Math.max(Math.abs(Number.isFinite(speed) ? speed : 1), 1);

    const pauseAtWindowEnd = () => {
        if (requestId !== replayWindowEndGuardId) return;
        replayWindowEndGuardTimer = null;
        const state = useTimelineStore.getState();
        state.setCurrentTime(to, {
            silent: true,
            reason: 'playback-clamp',
        });
        state.setIsPlaying(false);
        document.dispatchEvent(new CustomEvent('timeline-ctrl', {
            detail: { action: 'pause', reason: 'replay-window-end', time: to.toISOString() },
        }));
    };

    const tick = () => {
        if (requestId !== replayWindowEndGuardId) return;
        const state = useTimelineStore.getState();
        if (state.mode !== 'playback' || state.playbackKind !== 'historical') {
            cancelReplayWindowEndGuard();
            return;
        }
        if (!state.isPlaying) {
            replayWindowEndGuardTimer = window.setTimeout(tick, 250);
            return;
        }
        const currentMs = state.currentTime.getTime();
        if (Number.isFinite(currentMs) && currentMs >= endMs) {
            pauseAtWindowEnd();
            return;
        }
        const remainingReplayMs = Number.isFinite(currentMs) ? Math.max(endMs - currentMs, 0) : 1000;
        const nextDelay = Math.max(250, Math.min(2000, Math.ceil(remainingReplayMs / effectiveSpeed / 4)));
        replayWindowEndGuardTimer = window.setTimeout(tick, nextDelay);
    };

    replayWindowEndGuardTimer = window.setTimeout(tick, 250);
}

function publishPresentationState(detail: Record<string, any>): void {
    if (typeof window === 'undefined') return;
    (window as any).__agentPresentationState = {
        ...detail,
        updatedAt: new Date().toISOString(),
    };
    document.dispatchEvent(new CustomEvent('agent-presentation-state', {
        detail: (window as any).__agentPresentationState,
    }));
}

function shouldResumeHistoricalPlaybackAfterViewChange(state: ReturnType<typeof useTimelineStore.getState>): boolean {
    return state.mode === 'playback'
        && state.playbackKind === 'historical'
        && (state.isPlaying || pendingHistoricalPlaybackStart);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function fingerprintSelectionIds(ids: string[]): string {
    let hash = 2166136261;
    for (const id of ids) {
        for (let i = 0; i < id.length; i += 1) {
            hash ^= id.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        hash ^= 31;
        hash = Math.imul(hash, 16777619);
    }
    return `${ids.length}:${(hash >>> 0).toString(36)}`;
}

function markHistoricalReplayHydrating(): void {
    const state = useTimelineStore.getState();
    if (state.mode === 'playback' && state.playbackKind === 'historical') {
        state.setReplayHydrating(true);
    }
}

function defaultOpenObjectHeight(_actionType: string, payload: Record<string, any>): number {
    const explicitHeight = Number(payload.height ?? payload.height_m ?? payload.camera_height ?? payload.cameraHeight);
    if (Number.isFinite(explicitHeight) && explicitHeight > 0) return explicitHeight;

    const layer = normalizeCatalogLayerId(payload.layer || payload.layer_id || payload.layerId || payload.entity_layer || payload.entityLayer);
    const fallbackByLayer: Record<string, number> = {
        vessel: 180000,
        aircraft: 260000,
        satellite: 1000000,
        fire: 260000,
        outage: 320000,
        conflict: 320000,
        jamming: 320000,
        cable: 420000,
        pipeline: 420000,
    };
    const fallbackHeight = fallbackByLayer[layer] || 300000;
    const viewer = getViewer();
    const currentHeight = Number(viewer?.camera?.positionCartographic?.height);
    if (Number.isFinite(currentHeight) && currentHeight > 0) {
        return Math.max(60000, Math.min(fallbackHeight, currentHeight));
    }
    return fallbackHeight;
}

function explicitCameraHeightFromPayload(payload: Record<string, any>): number | null {
    const explicitHeight = Number(payload.height ?? payload.height_m ?? payload.camera_height ?? payload.cameraHeight);
    return Number.isFinite(explicitHeight) && explicitHeight > 0 ? explicitHeight : null;
}

function selectionCurrentlyAffectsReplay(selection: any): boolean {
    if (!selection?.selectionId) return false;
    const ids = Array.isArray(selection.itemIds) ? selection.itemIds : [];
    const itemCount = Number(selection.itemCount ?? ids.length);
    const status = String(selection.materializationStatus || '').toLowerCase();
    return ids.length > 0
        || selection.truncated === false
        || itemCount === 0
        || status === 'empty'
        || status === 'materialized';
}

function presentationDelayForAction(action: AgentAction): number {
    const payload = normalizedActionPayload(action);
    const explicitDelay = Number(payload.presentation_ms ?? payload.presentationMs ?? payload.duration_ms ?? payload.durationMs);
    if (Number.isFinite(explicitDelay) && explicitDelay >= 0) return explicitDelay;
    if (isActionBatch(action)) return 400;
    if (action.type === 'replay.play_window') return 3000;
    if (action.type === 'map.fly_to' || action.type === 'object.open' || action.type === 'object.focus' || action.type === 'entity.open' || action.type === 'asset.open' || action.type === 'event.open') return 1200;
    if (action.type === 'entity.animate_track' || action.type === 'track.animate') return Number(payload.duration_ms ?? payload.durationMs ?? 3500) + 500;
    if (action.type.startsWith('selection.')) return 700;
    return 500;
}

function movingReplayLayerForAction(action: AgentAction): string {
    const payload = normalizedActionPayload(action);
    const layer = normalizeCatalogLayerId(payload.layer || payload.layer_id || payload.layerId || payload.entity_layer || payload.entityLayer);
    if (layer === 'vessel' || layer === 'aircraft' || layer === 'satellite') return layer;
    const id = String(payload.entity_id || payload.entityId || payload.object_id || payload.objectId || payload.id || '').trim();
    const prefix = normalizeCatalogLayerId(id.split(':')[0]);
    return prefix === 'vessel' || prefix === 'aircraft' || prefix === 'satellite' ? prefix : '';
}

function isMovingReplayFocusAction(action: AgentAction): boolean {
    return ['object.open', 'object.focus', 'entity.open', 'replay.follow_entity'].includes(action.type)
        && Boolean(movingReplayLayerForAction(action));
}

function isStaticObjectCameraAction(action: AgentAction): boolean {
    return ['object.open', 'object.focus', 'entity.open', 'asset.open', 'event.open'].includes(action.type)
        && !isMovingReplayFocusAction(action);
}

async function hydrateAppliedSelectionItems(layer: string, selectionId: string, mode: string): Promise<void> {
    const normalizedLayer = normalizeCatalogLayerId(layer) || String(layer || '').trim();
    const normalizedSelectionId = String(selectionId || '').trim();
    if (!normalizedLayer || !normalizedSelectionId) return;
    const normalizedMode = ['replace', 'append', 'exclude', 'only'].includes(mode) ? mode : 'only';
    markHistoricalReplayHydrating();
    useTimelineStore.setState((state: any) => ({
        appliedSelections: {
            ...(state.appliedSelections || {}),
            [normalizedLayer]: {
                ...((state.appliedSelections || {})[normalizedLayer] || {}),
                selectionId: normalizedSelectionId,
                mode: normalizedMode,
                layer: normalizedLayer,
                materializationStatus: 'loading',
                updatedAt: new Date().toISOString(),
            },
        },
    }));
    const itemIds: string[] = [];
    let hasMore = true;
    let materializedCount = 0;
    let materializationStatus = 'unknown';
    let finalPageHasMore = false;
    const pageLimit = 5000;
    const fetchPage = async (pageOffset: number) => {
        const params = new URLSearchParams({ limit: String(pageLimit), offset: String(pageOffset) });
        const response = await fetch(`${API_URL}/api/selections/${encodeURIComponent(normalizedSelectionId)}/items?${params.toString()}`);
        const json = await response.json().catch(() => null);
        if (!response.ok || json?.status === 'error') {
            throw new Error(json?.error?.message || `Failed to hydrate selection ${normalizedSelectionId}`);
        }
        return json.data || json;
    };
    try {
        let pageOffset = 0;
        while (hasMore) {
            const data = await fetchPage(pageOffset);
            materializedCount = Number(data.materialized_count || data.materializedCount || materializedCount || 0);
            materializationStatus = String(data.materialization_status || data.materializationStatus || materializationStatus);
            for (const item of Array.isArray(data.items) ? data.items : []) {
                const id = String(item?.object_id || item?.objectId || item?.entity_id || item?.event_id || item?.asset_id || '').trim();
                if (id) itemIds.push(id);
            }
            finalPageHasMore = Boolean(data.pagination?.has_more || data.has_more);
            hasMore = finalPageHasMore;
            if (!hasMore) break;
            const nextOffset = Number(data.pagination?.next_offset ?? pageOffset + pageLimit);
            if (!Number.isFinite(nextOffset) || nextOffset <= pageOffset) {
                throw new Error(`Selection ${normalizedSelectionId} pagination did not advance`);
            }
            pageOffset = Math.trunc(nextOffset);
        }
        hasMore = finalPageHasMore;
    } catch (err) {
        console.warn('[AgentPanel] selection hydration failed', err);
        useTimelineStore.getState().setReplayHydrating(false);
        useTimelineStore.setState((state: any) => ({
            appliedSelections: {
                ...(state.appliedSelections || {}),
                [normalizedLayer]: {
                    ...((state.appliedSelections || {})[normalizedLayer] || {}),
                    selectionId: normalizedSelectionId,
                    mode: normalizedMode,
                    layer: normalizedLayer,
                    materializationStatus: 'error',
                    updatedAt: new Date().toISOString(),
                },
            },
        }));
        return;
    }
    const uniqueIds = Array.from(new Set(itemIds));
    const materializationStatusLower = materializationStatus.toLowerCase();
    const truncated = materializationStatusLower === 'partial'
        || materializationStatusLower === 'error'
        || hasMore
        || (materializedCount > 0 && uniqueIds.length < materializedCount);
    useTimelineStore.setState((state: any) => ({
        appliedSelections: {
            ...(state.appliedSelections || {}),
            [normalizedLayer]: {
                ...((state.appliedSelections || {})[normalizedLayer] || {}),
                selectionId: normalizedSelectionId,
                mode: normalizedMode,
                layer: normalizedLayer,
                itemIds: uniqueIds,
                itemCount: materializedCount || uniqueIds.length,
                itemFingerprint: fingerprintSelectionIds(uniqueIds),
                materializationStatus,
                truncated,
                updatedAt: new Date().toISOString(),
            },
        },
    }));
    useTimelineStore.getState().setReplayHydrating(false);
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

function compactPresentationText(value: any, maxLength = 180): string {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function humanizePresentationTitle(action: AgentAction, value: any): string {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return formatActionType(action.type);
    if (/^aoi[\s_-]*(b-?box|bbox|bounds?)$/i.test(text)) return 'Area of interest';
    if (/^(bbox|bounds?)$/i.test(text)) return 'Area of interest';
    if (/^map[\s._-]*add[\s._-]*aoi$/i.test(text)) return 'Area of interest';
    return text;
}

function presentationStepTitle(action: AgentAction, index: number, total: number): string {
    const payload = normalizedActionPayload(action);
    const rawTitle = payload.title || payload.heading || action.label || payload.label || formatActionType(action.type);
    const title = humanizePresentationTitle(action, rawTitle);
    return `${index + 1}/${Math.max(total, 1)} ${compactPresentationText(title, 72)}`;
}

function presentationStepNarration(action: AgentAction): string {
    const payload = normalizedActionPayload(action);
    return compactPresentationText(
        payload.narration
        || payload.caption
        || payload.summary
        || payload.note
        || payload.description
        || payload.text
        || payload.body
        || '',
        220,
    );
}

function pointFromActionPayload(payload: Record<string, any>): { lat: number; lng: number } | null {
    const lat = Number(payload.lat ?? payload.latitude);
    const lng = Number(payload.lng ?? payload.lon ?? payload.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };

    const bbox = bboxToDegreesArray(payload.bbox || payload.bounds);
    if (bbox) {
        const [west, south, east, north] = bbox;
        return { lat: (south + north) / 2, lng: (west + east) / 2 };
    }

    const coordinates = normalizeCoordinates(payload.coordinates);
    if (coordinates.length > 0) {
        const [firstLng, firstLat] = coordinates[Math.floor(coordinates.length / 2)];
        return { lat: firstLat, lng: firstLng };
    }

    return null;
}

function presentationStepPoint(action: AgentAction): { lat: number; lng: number } | null {
    const point = pointFromActionPayload(normalizedActionPayload(action));
    if (point) return point;
    for (const nested of nestedActionsFor(action)) {
        const nestedPoint = presentationStepPoint(nested);
        if (nestedPoint) return nestedPoint;
    }
    return null;
}

function clearPresentationStepCallout(): void {
    const viewer = getViewer();
    const id = `${AGENT_ENTITY_PREFIX}presentation-current-callout`;
    const existing = viewer?.entities.getById(id);
    if (viewer && existing) {
        viewer.entities.remove(existing);
        viewer.scene.requestRender();
    }
    replayMetaMap.delete(id);
}

function PresentationGuideCard({
    guide,
    onStep,
    onClose,
}: {
    guide: PresentationGuideState | null;
    onStep: (index: number) => void;
    onClose: () => void;
}) {
    if (!guide || guide.actions.length === 0) return null;
    const total = guide.actions.length;
    const currentIndex = Math.max(0, Math.min(guide.currentIndex, total - 1));
    const action = guide.actions[currentIndex];
    const title = presentationStepTitle(action, currentIndex, total);
    const narration = presentationStepNarration(action);
    const statusLabel = guide.status === 'running'
        ? 'Playing'
        : guide.status === 'manual'
            ? 'Step'
            : guide.status === 'partial'
                ? `Partial${guide.skippedSteps ? ` · ${guide.skippedSteps} skipped` : ''}`
                : guide.status === 'stopped'
                    ? 'Stopped'
                    : 'Complete';
    return (
        <div
            data-agent-presentation-guide="true"
            className="mt-2 rounded border border-cyan-900/80 bg-cyan-950/15 px-3 py-2 text-zinc-100"
        >
            <div className="flex items-start gap-2">
                <MapPin size={14} className="mt-0.5 shrink-0 text-cyan-300" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[10px] font-mono uppercase text-cyan-300">
                        <span>{statusLabel}</span>
                        <span className="text-zinc-600">/</span>
                        <span>{currentIndex + 1} of {total}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[12px] font-semibold text-zinc-100">
                        {title.replace(/^\d+\/\d+\s+/, '')}
                    </div>
                    {narration && (
                        <div className="mt-1 text-[11px] leading-snug text-zinc-300">
                            {narration}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    title="Hide presentation guide"
                    className="rounded border border-zinc-800 bg-zinc-950/80 p-1 text-zinc-500 hover:border-zinc-600 hover:text-zinc-200"
                >
                    <X size={13} />
                </button>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-900 pt-2">
                <button
                    type="button"
                    onClick={() => onStep(currentIndex - 1)}
                    disabled={currentIndex <= 0}
                    className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-[11px] font-mono text-zinc-300 hover:border-cyan-700 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    <ChevronLeft size={13} />
                    Previous
                </button>
                <button
                    type="button"
                    onClick={() => onStep(currentIndex + 1)}
                    disabled={currentIndex >= total - 1}
                    className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-[11px] font-mono text-zinc-300 hover:border-cyan-700 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    Next
                    <ChevronRight size={13} />
                </button>
            </div>
        </div>
    );
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

export default function AgentPanel({ isOpen, onClose, embedded = false }: AgentPanelProps) {
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [sessions, setSessions] = useState<AgentSession[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [messagesBySession, setMessagesBySession] = useState<Record<string, AgentMessage[]>>({});
    const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(false);
    const [runningRunsBySession, setRunningRunsBySession] = useState<Record<string, string>>({});
    const [actionsBySession, setActionsBySession] = useState<Record<string, AgentAction[]>>({});
    const [runningPresentationKey, setRunningPresentationKey] = useState<string | null>(null);
    const [presentationGuide, setPresentationGuide] = useState<PresentationGuideState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedProvider, setSelectedProvider] = useState('claude_code');
    const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());
    const runCursorsRef = useRef<Map<string, number>>(new Map());
    const toolNamesByRunRef = useRef<Map<string, Map<string, { name?: string; providerToolName?: string; command?: string }>>>(new Map());
    const runningRunsRef = useRef<Record<string, string>>({});
    const presentationGuideRef = useRef<PresentationGuideState | null>(null);
    const activeSessionIdRef = useRef<string | null>(null);
    const sessionPickerRef = useRef<HTMLDivElement | null>(null);
    const sessionsLoadSeqRef = useRef(0);
    const messagesScrollRef = useRef<HTMLDivElement | null>(null);
    const messagesEndRef = useRef<HTMLDivElement | null>(null);
    const nearBottomRef = useRef(true);
    const { showToast } = useToast();
    const visibleSessions = useMemo(() => dedupeSessions(sessions), [sessions]);
    const pickerSessions = useMemo(() => {
        const limited = visibleSessions.slice(0, SESSION_PICKER_DISPLAY_LIMIT);
        if (!activeSessionId || limited.some((session) => session.agent_session_id === activeSessionId)) {
            return limited;
        }
        const active = visibleSessions.find((session) => session.agent_session_id === activeSessionId);
        return active ? [active, ...limited.slice(0, Math.max(SESSION_PICKER_DISPLAY_LIMIT - 1, 0))] : limited;
    }, [activeSessionId, visibleSessions]);

    const activeSession = useMemo(
        () => visibleSessions.find((session) => session.agent_session_id === activeSessionId) || null,
        [activeSessionId, visibleSessions],
    );
    const activeSessionTitle = activeSession
        ? sessionPromptTitle(activeSession, messagesBySession[activeSession.agent_session_id] || [])
        : 'No chat';
    const messages = useMemo(
        () => activeSessionId ? dedupeMessages(messagesBySession[activeSessionId] || []) : [],
        [activeSessionId, messagesBySession],
    );
    const latestActions = activeSessionId ? (actionsBySession[activeSessionId] || []) : [];
    const messageActionsVisible = messages.some((message) => actionsFromMessage(message).length > 0);
    const runningRunId = activeSessionId ? (runningRunsBySession[activeSessionId] || null) : null;
    const presentationUiLocked = Boolean(runningPresentationKey);

    const availableProviders = providers.filter((provider) => provider.available);
    const defaultProvider = availableProviders[0]?.provider || 'claude_code';

    // Track whether the user is near the bottom so streamed tokens keep the view
    // pinned, but don't yank the view down if they've scrolled up to read.
    const handleMessagesScroll = useCallback(() => {
        const el = messagesScrollRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        nearBottomRef.current = distanceFromBottom < 80;
    }, []);

    // Serialized signal of the visible transcript (message count + streamed
    // content length) so the autoscroll effect fires on every streamed token.
    const messagesSignal = useMemo(() => {
        let signal = `${messages.length}`;
        const last = messages[messages.length - 1];
        if (last) {
            const streamLen = Array.isArray(last.metadata?.streamParts)
                ? last.metadata.streamParts.reduce((sum: number, part: any) => sum + (typeof part?.text === 'string' ? part.text.length : 0), 0)
                : 0;
            signal += `:${(last.content || '').length}:${streamLen}`;
        }
        return signal;
    }, [messages]);

    useEffect(() => {
        if (sessionPickerOpen) return;
        if (!nearBottomRef.current) return;
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [messagesSignal, sessionPickerOpen]);

    useEffect(() => {
        runningRunsRef.current = runningRunsBySession;
    }, [runningRunsBySession]);

    useEffect(() => {
        presentationGuideRef.current = presentationGuide;
    }, [presentationGuide]);

    useEffect(() => {
        activeSessionIdRef.current = activeSessionId;
        agentLabelClusterCounts.clear();
    }, [activeSessionId]);

    useEffect(() => {
        setSessionPickerOpen(false);
    }, [activeSessionId]);

    useEffect(() => {
        if (!sessionPickerOpen) return;
        const closeOnOutsideClick = (event: MouseEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (!sessionPickerRef.current?.contains(target)) {
                setSessionPickerOpen(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setSessionPickerOpen(false);
        };
        document.addEventListener('mousedown', closeOnOutsideClick);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('mousedown', closeOnOutsideClick);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [sessionPickerOpen]);

    useEffect(() => {
        (window as any).__agentPresentationRunningKey = runningPresentationKey;
    }, [runningPresentationKey]);

    useEffect(() => {
        const handleReplayControl = (event: Event) => {
            const action = String((event as CustomEvent).detail?.action || '').toLowerCase();
            if (action !== 'pause' && action !== 'stop') return;
            pauseHistoricalPlayback(action);
        };
        document.addEventListener('agent-replay-control', handleReplayControl);
        return () => document.removeEventListener('agent-replay-control', handleReplayControl);
    }, []);

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
        const requestSeq = ++sessionsLoadSeqRef.current;
        const response = await fetch(`${API_URL}/api/agents/sessions`);
        const json = await response.json();
        const rows = dedupeSessions(Array.isArray(json.data) ? json.data : []);
        if (requestSeq !== sessionsLoadSeqRef.current) return;
        setSessions(rows);
        setActiveSessionId((current) => (
            current
                ? current
                : rows[0]?.agent_session_id || null
        ));
    }, []);

    const loadMessages = useCallback(async (sessionId: string) => {
        const response = await fetch(`${API_URL}/api/agents/sessions/${encodeURIComponent(sessionId)}/messages`);
        const json = await response.json();
        const persisted = dedupeMessages(normalizeMessages(json.data?.messages || []));
        const lastPersistedActions = [...persisted]
            .reverse()
            .map((message) => actionsFromMessage(message))
            .find((actions) => actions.length > 0) || [];
        const activeRunId = runningRunsRef.current[sessionId]
            || (typeof json.data?.session?.metadata?.activeRunId === 'string' ? json.data.session.metadata.activeRunId : '');
        setMessagesBySession((current) => {
            const existing = dedupeMessages(current[sessionId] || []);
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
                [sessionId]: dedupeMessages(next),
            };
        });
        if (lastPersistedActions.length > 0) {
            setActionsBySession((current) => ({
                ...current,
                [sessionId]: lastPersistedActions,
            }));
        }
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
            sessionsLoadSeqRef.current += 1;
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
            setSessions((current) => dedupeSessions([session, ...current]));
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
                updateRunMessage(sessionId, runId, (message) => {
                    const metadata = appendTextPart(message.metadata, text);
                    const rawText = streamTextFromMetadata(metadata);
                    const parsed = extractActionContract(rawText);
                    if (parsed.actions.length > 0) {
                        setActionsBySession((current) => ({
                            ...current,
                            [sessionId]: parsed.actions,
                        }));
                    }
                    return {
                        ...message,
                        content: rawText || `${message.content}${text}`,
                        content_json: parsed.contentJson || message.content_json || null,
                        metadata,
                    };
                });
            }
            if (row.event_type === 'message.completed') {
                const backendContentJson = payload.content_json || payload.contentJson || null;
                const rawContent = String(payload.content || '');
                const parsed = extractActionContract(rawContent);
                const contentJson = parsed.contentJson || backendContentJson || null;
                const actions = normalizeAgentActions(contentJson?.actions);
                if (actions.length > 0) {
                    setActionsBySession((current) => ({
                        ...current,
                        [sessionId]: actions,
                    }));
                }
                updateRunMessage(sessionId, runId, (message) => ({
                    ...message,
                    content: rawContent || message.content,
                    content_json: contentJson || message.content_json || null,
                    metadata: message.metadata,
                }));
            }
            if (row.event_type === 'action.created') {
                const actions = normalizeAgentActions(payload.actions);
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
                    const names = toolNamesByRunRef.current.get(runId) || new Map<string, { name?: string; providerToolName?: string; command?: string }>();
                    names.set(toolUseId, {
                        name: String(payload.name),
                        providerToolName: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
                        command: typeof payload.command === 'string' ? payload.command : shellCommandFromPayload(payload.input),
                    });
                    toolNamesByRunRef.current.set(runId, names);
                } else if (row.event_type === 'tool.completed' && toolUseId) {
                    const started = toolNamesByRunRef.current.get(runId)?.get(toolUseId);
                    if (started) {
                        eventPayload = {
                            ...payload,
                            name: started.name || payload.name,
                            tool_name: started.providerToolName || payload.tool_name,
                            command: started.command || payload.command,
                        };
                    }
                }
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
        for (const session of visibleSessions) {
            const runId = typeof session.metadata?.activeRunId === 'string' ? session.metadata.activeRunId : '';
            if (!runId || eventSourcesRef.current.has(runId)) continue;
            setRunningRunsBySession((current) => ({
                ...current,
                [session.agent_session_id]: runId,
            }));
            setMessagesBySession((current) => {
                const existing = dedupeMessages(current[session.agent_session_id] || []);
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
    }, [attachRunStream, isOpen, visibleSessions]);

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
            [sessionId]: dedupeMessages([
                ...(current[sessionId] || []),
                {
                    agent_message_id: `local:${Date.now()}:${Math.random().toString(16).slice(2)}`,
                    role: 'user',
                    content,
                },
            ]),
        }));

        try {
            const context = buildAgentRequestContext();
            const response = await fetch(`${API_URL}/api/agents/sessions/${encodeURIComponent(sessionId)}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, context }),
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
                [sessionId]: dedupeMessages([
                    ...(current[sessionId] || []),
                    {
                        agent_message_id: `run:${runId}`,
                        role: 'assistant',
                        content: '',
                        metadata: { run_id: runId },
                    },
                ]),
            }));
            attachRunStream(sessionId, runId);
        } catch (err) {
            setRunningRunsBySession((current) => {
                const next = { ...current };
                if (sessionId) delete next[sessionId];
                return next;
            });
            const message = err instanceof Error ? err.message : 'Failed to send message';
            setError(message);
            showToast(message, 'error');
        }
    }, [activeSessionId, attachRunStream, createSession, defaultProvider, draft, selectedProvider, showToast]);

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

        if (isActionBatch(action)) {
            const nested = nestedActionsFor(action);
            if (nested.length === 0) throw new Error(`${action.type} requires a non-empty actions array`);
            const hasMaxActions = payload.max_actions !== undefined || payload.maxActions !== undefined;
            const maxActions = hasMaxActions ? Number(payload.max_actions ?? payload.maxActions) : null;
            if (hasMaxActions && (!Number.isFinite(maxActions) || maxActions! <= 0)) {
                throw new Error(`${action.type} max_actions must be a positive integer`);
            }
            const bounded = hasMaxActions ? nested.slice(0, Math.trunc(maxActions!)) : nested;
            for (const nestedAction of bounded) {
                await applyAction(nestedAction, sessionId);
                await sleep(presentationDelayForAction(nestedAction));
            }
            return;
        }

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

        const getJson = async (path: string) => {
            const response = await fetch(`${API_URL}${path}`);
            const json = await response.json().catch(() => null);
            if (!response.ok || json?.status === 'error') {
                throw new Error(json?.error?.message || json?.error || `${path} failed`);
            }
            return json;
        };

        if (action.type === 'map.fly_to') {
            const lat = Number(payload.lat ?? payload.latitude);
            const lng = Number(payload.lng ?? payload.lon ?? payload.longitude);
            const height = explicitCameraHeightFromPayload(payload) ?? 15000;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('map.fly_to requires lat and lng');
            document.dispatchEvent(new CustomEvent('fly-to', { detail: { lat, lng, height } }));
            return;
        }

        if (action.type === 'replay.seek') {
            const at = String(payload.at || payload.time || '');
            const date = new Date(at);
            if (Number.isNaN(date.getTime())) throw new Error('replay.seek requires a valid at/time value');
            cancelReplayWindowEndGuard();
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
            const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 32;
            const toValue = payload.to || payload.until || payload.end;
            const to = toValue ? new Date(String(toValue)) : null;
            if (toValue && (!to || Number.isNaN(to.getTime()))) {
                throw new Error('replay.play_window requires a valid to/until/end value');
            }
            if (to && to.getTime() <= date.getTime()) {
                throw new Error('replay.play_window requires to/until/end to be after from/at');
            }
            store.setSpeedMultiplier(safeSpeed);
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
            if (to) armReplayWindowEndGuard(to, safeSpeed);
            startHistoricalPlaybackWhenReady();
            return;
        }

        if (action.type === 'replay.set_speed') {
            const speed = Number(payload.speed || payload.multiplier);
            if (!Number.isFinite(speed) || speed <= 0) throw new Error('replay.set_speed requires a positive speed');
            store.setSpeedMultiplier(speed);
            return;
        }

        if (action.type === 'replay.pause' || action.type === 'replay.stop') {
            pauseHistoricalPlayback(action.type === 'replay.stop' ? 'stop' : 'pause');
            return;
        }

        if (action.type === 'replay.follow_entity') {
            const entityId = canonicalObjectIdForLayer(
                payload.entity_id || payload.entityId || '',
                payload.layer || payload.layer_id || payload.layerId,
            );
            if (!entityId) throw new Error('replay.follow_entity requires entity_id');
            store.setSelectedEntityId(entityId, { id: entityId, agentSelected: true });
            return;
        }

        if (action.type === 'object.open' || action.type === 'object.focus' || action.type === 'entity.open' || action.type === 'asset.open' || action.type === 'event.open') {
            const entityId = canonicalObjectIdForLayer(
                payload.entity_id || payload.entityId || payload.object_id || payload.objectId || payload.asset_id || payload.assetId || payload.event_id || payload.eventId || payload.id || '',
                payload.layer || payload.layer_id || payload.layerId || payload.entity_layer || payload.entityLayer,
            );
            if (!entityId) throw new Error(`${action.type} requires an object, entity, asset or event id`);
            store.addAgentReplayFocusId(entityId);
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
            const resolvedPoint = await resolveEntityPoint(payload, entityId);
            const layer = payload.layer || payload.layer_id || payload.type;
            const objectType = payload.object_type || payload.objectType
                || (action.type === 'asset.open' ? 'Asset' : action.type === 'event.open' ? 'Event' : typeForLayer(layer));
            store.setSelectedEntityId(entityId, {
                id: entityId,
                name: payload.name || payload.display_name || entityId,
                type: objectType,
                layer,
                source: payload.source || payload.source_id,
                assetId: action.type === 'asset.open' ? entityId : (payload.asset_id || payload.assetId),
                eventId: action.type === 'event.open' ? entityId : (payload.event_id || payload.eventId),
                lat: resolvedPoint?.lat,
                lng: resolvedPoint?.lng,
                alt: resolvedPoint?.alt,
                heading: resolvedPoint?.heading,
                speed: resolvedPoint?.speed,
                observedAt: resolvedPoint?.at || at || undefined,
                agentSelected: true,
                skipLiveDetails: payload.live_details === true || payload.liveDetails === true ? false : true,
                ...((payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {}),
            });
            const lat = Number(resolvedPoint?.lat);
            const lng = Number(resolvedPoint?.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                const viewer = getViewer();
                if (viewer && payload.draw_marker !== false && payload.show_marker !== false) {
                    drawPointOrLabel(
                        viewer,
                        {
                            ...payload,
                            lat,
                            lng,
                            alt: resolvedPoint?.alt,
                            heading: payload.heading ?? payload.heading_deg ?? resolvedPoint?.heading,
                            speed: payload.speed ?? payload.speed_mps ?? resolvedPoint?.speed,
                            source: payload.source || payload.source_id || resolvedPoint?.source,
                            layer: payload.layer || payload.layer_id || resolvedPoint?.layer,
                            observed_at: resolvedPoint?.at || at || undefined,
                            pixelSize: payload.pixelSize || 10,
                        },
                        String(action.label || payload.label || payload.name || payload.display_name || entityId),
                        colorFromPayload(payload.color, Cesium.Color.YELLOW),
                    );
                    viewer.scene.requestRender();
                }
                document.dispatchEvent(new CustomEvent('fly-to', {
                    detail: { lat, lng, height: defaultOpenObjectHeight(action.type, payload) },
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
            drawGeometryOverlay(viewer, { ...payload, action_type: action.type }, action.label || 'Agent AOI');
            viewer.scene.requestRender();
            return;
        }

        if (action.type === 'map.clear_agent_overlays') {
            const viewer = getViewer();
            if (!viewer) throw new Error('Cesium viewer is not ready');
            const entities = viewer.entities.values.filter((entity) => {
                    const id = String(entity.id || '');
                    return id.startsWith(AGENT_ENTITY_PREFIX) || Boolean(replayMetaMap.get(id)?.extra?.agentOverlay);
                });
            for (const entity of entities) viewer.entities.remove(entity);
            for (const [id, meta] of Array.from(replayMetaMap.entries())) {
                if (id.startsWith(AGENT_ENTITY_PREFIX) || meta.extra?.agentOverlay) replayMetaMap.delete(id);
            }
            agentLabelClusterCounts.clear();
            clearOpenSpyImageryLayers(viewer);
            viewer.scene.requestRender();
            return;
        }

        if (action.type === 'entity.place' || action.type === 'entity.show_marker' || action.type === 'entity.highlight') {
            const viewer = getViewer();
            if (!viewer) throw new Error('Cesium viewer is not ready');
            const label = action.label || payload.label || payload.name || payload.entity_id || 'Agent object';
            drawPointOrLabel(viewer, payload, String(label), colorFromPayload(payload.color, Cesium.Color.LIME));
            const entityId = String(payload.entity_id || payload.entityId || payload.id || '').trim();
            if (entityId) {
                store.setSelectedEntityId(entityId, {
                    id: entityId,
                    name: payload.name || payload.display_name || entityId,
                    type: payload.object_type || payload.objectType || typeForLayer(payload.layer || payload.layer_id),
                    layer: payload.layer || payload.layer_id,
                    source: payload.source || payload.source_id,
                    agentSelected: true,
                });
            }
            viewer.scene.requestRender();
            return;
        }

        if (
            action.type === 'entity.track'
            || action.type === 'entity.draw_track'
            || action.type === 'track.draw'
            || action.type === 'entity.animate_track'
            || action.type === 'track.animate'
        ) {
            const viewer = getViewer();
            if (!viewer) throw new Error('Cesium viewer is not ready');
            const points = await fetchTrackPoints(payload);
            if (points.length < 2) throw new Error(`${action.type} requires track points or entity_id with from/to`);
            if (action.type === 'entity.animate_track' || action.type === 'track.animate') {
                await animateTrackOverlay(viewer, points, payload, action.label || 'Agent track');
            } else {
                drawTrackOverlay(viewer, points, payload, action.label || 'Agent track');
            }
            viewer.scene.requestRender();
            return;
        }

        if (action.type === 'imagery.show_layer' || action.type === 'imagery.show_scene' || action.type === 'imagery.compare') {
            const viewer = getViewer();
            if (!viewer) throw new Error('Cesium viewer is not ready');
            if (action.type === 'imagery.compare') {
                showOpenSpyImageryCompare(viewer, payload);
            } else {
                showOpenSpyImageryLayer(viewer, payload);
            }
            return;
        }

        if (action.type === 'imagery.clear') {
            const viewer = getViewer();
            if (!viewer) throw new Error('Cesium viewer is not ready');
            clearOpenSpyImageryLayers(viewer);
            viewer.scene.requestRender();
            return;
        }

        if (
            action.type === 'map.set_layers'
            || action.type === 'source.set_enabled'
            || action.type === 'layer.set_visibility'
            || (action.type === 'legend.set_node_state' && payload.visibility && typeof payload.visibility === 'object')
        ) {
            const patch = buildLayerPatch(payload);
            if (Object.keys(patch).length === 0) throw new Error(`${action.type} requires layer/source/visibility payload`);
            const shouldResumePlayback = shouldResumeHistoricalPlaybackAfterViewChange(useTimelineStore.getState());
            const json = await postJson('/api/view-state/patch', patch);
            applyViewStateToStore(json.state || json.data?.state || patch);
            if (shouldResumePlayback) startHistoricalPlaybackWhenReady();
            return;
        }

        if (action.type === 'layer.filter') {
            const layer = normalizeCatalogLayerId(payload.layer || payload.layer_id);
            if (!layer) throw new Error('layer.filter requires layer');
            const json = await postJson('/api/agent-tools/map-command', {
                command: 'layer.filter',
                payload: {
                    ...payload,
                    layer,
                },
            });
            applyViewStateToStore(json.data?.state || json.state);
            const selectionId = String(json.data?.selection_id || json.data?.selectionId || '').trim();
            if (selectionId) await hydrateAppliedSelectionItems(layer, selectionId, String(json.data?.mode || payload.mode || 'only'));
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
            const shouldResumePlayback = shouldResumeHistoricalPlaybackAfterViewChange(useTimelineStore.getState());
            if (action.type === 'selection.apply' && !payload.layer && !payload.layer_id && (payload.selection_id || payload.selectionId)) {
                const selectionId = String(payload.selection_id || payload.selectionId);
                const selection = await getJson(`/api/selections/${encodeURIComponent(selectionId)}`);
                const row = selection.data || selection;
                payload.layer = normalizeCatalogLayerId(row.layer || row.layer_id || row.layerId);
            }
            if (action.type === 'selection.apply' && Array.isArray(payload.entities) && payload.entities.length > 0) {
                const ids = payload.entities
                    .map((entity: any) => String(entity?.entity_id || entity?.entityId || entity?.id || '').trim())
                    .filter(Boolean);
                if (ids.length > 0) {
                    const selection = await postJson('/api/selections', {
                        selectionId: payload.selection_id || payload.selectionId || `sel:agent-inline:${Date.now()}:${Math.random().toString(16).slice(2)}`,
                        layerId: normalizeCatalogLayerId(payload.layer || payload.layer_id || payload.entities[0]?.layer || 'vessel'),
                        selectionMode: 'filter',
                        predicate: { ids },
                        metadata: {
                            source: 'agent-action',
                            label: payload.label || action.label || null,
                        },
                    });
                    payload.selection_id = payload.selection_id || selection.selection_id || selection.data?.selection_id;
                    payload.layer = normalizeCatalogLayerId(payload.layer || selection.layer || selection.data?.layer || payload.entities[0]?.layer || 'vessel');
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
            applyViewStateToStore(json?.data?.state || json?.state);
            if (action.type === 'selection.apply') {
                const layer = normalizeCatalogLayerId(json.data?.layer || payload.layer || payload.layer_id);
                const selectionId = String(json.data?.selection_id || json.data?.selectionId || payload.selection_id || payload.selectionId || '').trim();
                if (layer && selectionId) await hydrateAppliedSelectionItems(layer, selectionId, String(json.data?.mode || payload.mode || 'only'));
                if (shouldResumePlayback) startHistoricalPlaybackWhenReady();
            } else {
                const layer = normalizeCatalogLayerId(json.data?.layer || payload.layer || payload.layer_id);
                if (layer) {
                    const current = useTimelineStore.getState() as any;
                    if (selectionCurrentlyAffectsReplay(current.appliedSelections?.[layer])) {
                        markHistoricalReplayHydrating();
                    }
                    useTimelineStore.setState((state: any) => {
                        const next = { ...(state.appliedSelections || {}) };
                        delete next[layer];
                        return { appliedSelections: next };
                    });
                    if (shouldResumePlayback) startHistoricalPlaybackWhenReady();
                }
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

    const openOpenSpyLink = useCallback(async (href: string, label?: string) => {
        try {
            setError(null);
            const action = parseOpenSpyLink(href, label);
            if (!action) throw new Error('Unsupported OpenSpy link');
            await applyAction(action, activeSessionIdRef.current);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'OpenSpy link failed');
        }
    }, [applyAction]);

    const updatePresentationGuideStep = useCallback((
        base: PresentationGuideState,
        currentIndex: number,
        status: PresentationGuideState['status'] = base.status,
        extra: Partial<PresentationGuideState> = {},
    ) => {
        const boundedIndex = Math.max(0, Math.min(currentIndex, base.actions.length - 1));
        const nextGuide: PresentationGuideState = {
            ...base,
            ...extra,
            currentIndex: boundedIndex,
            status,
        };
        setPresentationGuide(nextGuide);
        const action = nextGuide.actions[boundedIndex];
        if (action) {
            publishPresentationState({
                key: nextGuide.key,
                sessionId: nextGuide.sessionId,
                messageId: nextGuide.messageId,
                status: nextGuide.status,
                currentStep: boundedIndex + 1,
                totalSteps: nextGuide.actions.length,
                stepTitle: presentationStepTitle(action, boundedIndex, nextGuide.actions.length),
                stepNarration: presentationStepNarration(action) || null,
            });
        }
    }, []);

    const applyPresentationGuideStep = useCallback(async (index: number) => {
        const guide = presentationGuideRef.current;
        if (!guide || guide.actions.length === 0) return;
        const boundedIndex = Math.max(0, Math.min(index, guide.actions.length - 1));
        updatePresentationGuideStep(guide, boundedIndex, 'manual');
        try {
            await applyAction(guide.actions[boundedIndex], guide.sessionId);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Presentation step failed');
        }
    }, [applyAction, updatePresentationGuideStep]);

    const replayPresentation = useCallback(async (sessionId: string, messageId: string, actions: AgentAction[]) => {
        if (activeSessionIdRef.current !== sessionId) {
            setError('Switch back to this agent session to replay its presentation');
            return;
        }
        const key = `${sessionId}:${messageId}`;
        const guideBase: PresentationGuideState = {
            key,
            sessionId,
            messageId,
            actions,
            currentIndex: 0,
            status: 'running',
        };
        setPresentationGuide(guideBase);
        setRunningPresentationKey(key);
        publishPresentationState({ key, sessionId, messageId, status: 'running' });
        setError(null);
        cancelReplayWindowEndGuard();
        cancelPendingHistoricalPlayback();
        useTimelineStore.getState().clearAgentReplayFocusIds();
        agentLabelClusterCounts.clear();
        const actionErrors: string[] = [];
        let replayWindowRequested = false;
        let replayWindowPlaybackAllowed = false;
        let lastReplayOverviewAction: AgentAction | null = null;
        let lastMovingReplayFocusAction: AgentAction | null = null;
        let replayCameraNeedsRestore = false;
        let lastCameraActionRole: 'map' | 'moving' | 'static' | '' = '';
        const movingReplayFocusLayers = new Set<string>();
        try {
            for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
                const action = actions[actionIndex];
                if (activeSessionIdRef.current !== sessionId) {
                    throw new Error('Presentation stopped because another agent session became active');
                }
                try {
                    updatePresentationGuideStep(guideBase, actionIndex, 'running');
                    const needsMultiLayerOverview = action.type === 'replay.play_window'
                        && movingReplayFocusLayers.size > 1
                        && lastReplayOverviewAction
                        && lastCameraActionRole !== 'map';
                    if (action.type === 'replay.play_window' && (replayCameraNeedsRestore || needsMultiLayerOverview)) {
                        const restoreAction = lastReplayOverviewAction || lastMovingReplayFocusAction;
                        if (restoreAction) {
                            await applyAction({
                                ...restoreAction,
                                label: 'Restore replay camera before motion',
                            }, sessionId);
                            await sleep(presentationDelayForAction(restoreAction));
                            replayCameraNeedsRestore = false;
                        }
                    }
                    await applyAction(action, sessionId);
                    if (action.type === 'replay.play_window') {
                        replayWindowRequested = true;
                        replayWindowPlaybackAllowed = true;
                    }
                    if (action.type === 'replay.pause' || action.type === 'replay.stop') {
                        replayWindowPlaybackAllowed = false;
                    }
                    if (replayWindowRequested && replayWindowPlaybackAllowed && (action.type === 'replay.seek' || action.type === 'object.open' || action.type === 'object.focus' || action.type === 'entity.open' || action.type === 'asset.open' || action.type === 'event.open')) {
                        startHistoricalPlaybackWhenReady();
                    }
                    if (action.type === 'map.fly_to') {
                        lastReplayOverviewAction = action;
                        replayCameraNeedsRestore = false;
                        lastCameraActionRole = 'map';
                    } else if (isMovingReplayFocusAction(action)) {
                        const movingLayer = movingReplayLayerForAction(action);
                        if (movingLayer) movingReplayFocusLayers.add(movingLayer);
                        lastMovingReplayFocusAction = action;
                        replayCameraNeedsRestore = false;
                        lastCameraActionRole = 'moving';
                    } else if (isStaticObjectCameraAction(action) && (lastReplayOverviewAction || lastMovingReplayFocusAction)) {
                        replayCameraNeedsRestore = true;
                        lastCameraActionRole = 'static';
                    }
                } catch (err) {
                    actionErrors.push(`${formatActionType(action.type)}: ${err instanceof Error ? err.message : 'failed'}`);
                }
                await sleep(presentationDelayForAction(action));
            }
            if (replayWindowRequested && replayWindowPlaybackAllowed) {
                startHistoricalPlaybackWhenReady();
            }
            if (actionErrors.length > 0) {
                setError(`Presentation finished with ${actionErrors.length} skipped step(s)`);
            }
            setPresentationGuide((current) => (
                current?.key === key
                    ? {
                        ...current,
                        status: actionErrors.length > 0 ? 'partial' : 'completed',
                        skippedSteps: actionErrors.length,
                    }
                    : current
            ));
            publishPresentationState({
                key,
                sessionId,
                messageId,
                status: actionErrors.length > 0 ? 'partial' : 'completed',
                skippedSteps: actionErrors.length,
                skippedErrors: actionErrors,
                replayWindowRequested,
                replayPlaybackActive: replayWindowPlaybackAllowed,
            });
        } catch (err) {
            setPresentationGuide((current) => (
                current?.key === key ? { ...current, status: 'stopped' } : current
            ));
            publishPresentationState({
                key,
                sessionId,
                messageId,
                status: 'stopped',
                error: err instanceof Error ? err.message : 'Agent presentation failed',
            });
            setError(err instanceof Error ? err.message : 'Agent presentation failed');
        } finally {
            setRunningPresentationKey((current) => (current === key ? null : current));
        }
    }, [applyAction, updatePresentationGuideStep]);

    if (!isOpen) return null;

    return (
        <>
        <div
            data-agent-panel="true"
            className={embedded
                ? 'relative z-auto flex h-full min-h-0 w-full flex-col overflow-hidden bg-transparent'
                : 'absolute top-4 right-4 bottom-4 z-40 w-[min(456px,calc(100vw-24px))] rounded-lg border border-zinc-800 bg-black/85 backdrop-blur-xl shadow-2xl flex flex-col overflow-hidden'}
        >
            <div className={embedded ? 'hidden' : 'flex items-center justify-between px-3 py-2 border-b border-zinc-800'}>
                <div className="flex items-center gap-2 min-w-0">
                    <Bot size={15} className="text-cyan-300 shrink-0" />
                    <div className="min-w-0">
                        <div className="text-xs font-mono text-zinc-100">Local Agents</div>
                        <div className="text-[10px] font-mono text-zinc-500 truncate">
                            {activeSessionTitle}
                        </div>
                    </div>
                </div>
                <button onClick={() => {
                    cancelReplayWindowEndGuard();
                    cancelPendingHistoricalPlayback();
                    onClose();
                }} className="p-1 text-zinc-500 hover:text-white rounded">
                    <X size={15} />
                </button>
            </div>

            <div
                ref={sessionPickerRef}
                className={embedded
                    ? 'flex items-center gap-2 border-b border-zinc-800 px-2 py-1.5'
                    : 'relative flex gap-2 p-2 border-b border-zinc-800'}
                data-agent-active-session-id={activeSessionId || ''}
            >
                <button
                    type="button"
                    data-agent-session-picker="true"
                    aria-label="Chat history"
                    aria-expanded={sessionPickerOpen}
                    aria-controls="agent-session-list"
                    title={presentationUiLocked ? 'Presentation is running' : activeSessionTitle}
                    disabled={presentationUiLocked}
                    onClick={() => {
                        if (presentationUiLocked) return;
                        setSessionPickerOpen((current) => !current);
                    }}
                    className={embedded
                        ? 'btn shrink-0 px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-50'
                        : 'min-w-0 flex-1 flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] font-mono text-zinc-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-50'}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <History size={12} className="shrink-0 text-zinc-500" />
                        <span className="truncate">{embedded ? (sessionPickerOpen ? 'Back to chat' : 'History') : activeSessionTitle}</span>
                    </span>
                    <span className={embedded ? 'hidden' : 'flex shrink-0 items-center gap-1 text-zinc-500'}>
                        <ChevronDown size={12} className={sessionPickerOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
                    </span>
                </button>
                {embedded && <span className="flex-1" />}
                <select
                    data-agent-provider-select="true"
                    value={selectedProvider}
                    onChange={(event) => setSelectedProvider(event.target.value)}
                    disabled={availableProviders.length === 0}
                    className="w-[118px] shrink-0 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] font-mono text-zinc-400 outline-none disabled:opacity-50"
                >
                    {availableProviders.map((provider) => (
                        <option key={provider.provider} value={provider.provider}>
                            {provider.label}
                        </option>
                    ))}
                </select>
                <button
                    data-agent-new-session="true"
                    onClick={() => void createSession(selectedProvider || defaultProvider)}
                    disabled={loading || availableProviders.length === 0 || presentationUiLocked}
                    className="shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-zinc-800 bg-zinc-950 text-[10px] font-mono text-zinc-400 hover:text-white disabled:opacity-50"
                >
                    {loading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    New
                </button>
                {!embedded && sessionPickerOpen && (
                    <div
                        id="agent-session-list"
                        role="listbox"
                        data-agent-session-total={visibleSessions.length}
                        data-agent-session-rendered={pickerSessions.length}
                        className="absolute left-2 right-2 top-[calc(100%-4px)] z-50 max-h-72 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 shadow-2xl"
                    >
                        {visibleSessions.length === 0 ? (
                            <div className="px-3 py-2 text-[10px] font-mono text-zinc-500">No chats yet</div>
                        ) : pickerSessions.map((session) => {
                            const title = sessionPromptTitle(session, messagesBySession[session.agent_session_id] || []);
                            const running = Boolean(runningRunsBySession[session.agent_session_id]);
                            const active = session.agent_session_id === activeSessionId;
                            return (
                                <button
                                    key={session.agent_session_id}
                                    type="button"
                                    data-agent-session-id={session.agent_session_id}
                                    data-agent-session-active={active ? 'true' : 'false'}
                                    role="option"
                                    aria-selected={active}
                                    title={title}
                                    disabled={presentationUiLocked}
                                    onClick={() => {
                                        if (presentationUiLocked) return;
                                        setActiveSessionId(session.agent_session_id);
                                        setSessionPickerOpen(false);
                                    }}
                                    className={`w-full px-3 py-2 text-left border-b border-zinc-900 last:border-b-0 disabled:cursor-not-allowed disabled:opacity-50 ${
                                        active
                                            ? 'bg-cyan-950/40 text-cyan-100'
                                            : 'bg-zinc-950 text-zinc-300 hover:bg-zinc-900/80 hover:text-white'
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="min-w-0 truncate text-[11px] font-mono">{title}</span>
                                        {running && <Loader2 size={12} className="shrink-0 animate-spin text-cyan-300" />}
                                    </div>
                                    <div className="mt-0.5 truncate text-[10px] font-mono text-zinc-500">
                                        {sessionSecondaryLabel(session, providers)}
                                    </div>
                                </button>
                            );
                        })}
                        {visibleSessions.length > pickerSessions.length && (
                            <div
                                data-agent-session-overflow="true"
                                className="px-3 py-2 text-[10px] font-mono text-zinc-500"
                            >
                                Showing latest {pickerSessions.length} of {visibleSessions.length}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {error && (
                <div className="px-3 py-2 text-[11px] font-mono text-red-300 border-b border-red-900/60 bg-red-950/30">
                    {error}
                </div>
            )}

            <div
                ref={messagesScrollRef}
                onScroll={handleMessagesScroll}
                className={embedded ? 'chat__messages' : 'flex-1 min-h-0 overflow-y-auto p-3 space-y-3'}
            >
                {embedded && sessionPickerOpen ? (
                    <div className="section w-full !border-b-0 !p-0">
                        <h4>Recent sessions</h4>
                        {visibleSessions.length === 0 ? (
                            <div className="py-3 text-[11px] font-mono text-zinc-500">No chats yet</div>
                        ) : pickerSessions.map((session) => {
                            const title = sessionPromptTitle(session, messagesBySession[session.agent_session_id] || []);
                            const running = Boolean(runningRunsBySession[session.agent_session_id]);
                            const active = session.agent_session_id === activeSessionId;
                            return (
                                <button
                                    key={session.agent_session_id}
                                    type="button"
                                    data-agent-session-id={session.agent_session_id}
                                    data-agent-session-active={active ? 'true' : 'false'}
                                    disabled={presentationUiLocked}
                                    onClick={() => {
                                        if (presentationUiLocked) return;
                                        setActiveSessionId(session.agent_session_id);
                                        setSessionPickerOpen(false);
                                    }}
                                    className="flex w-full items-start gap-2 border-b border-zinc-900 py-2 text-left last:border-b-0 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <MessageSquare size={14} className={`mt-0.5 shrink-0 ${active ? 'text-cyan-300' : 'text-zinc-500'}`} />
                                    <span className="min-w-0 flex-1">
                                        <span className={`block truncate text-xs ${active ? 'text-cyan-200' : 'text-zinc-300'}`}>{title}</span>
                                        <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-500">
                                            {sessionSecondaryLabel(session, providers)}
                                        </span>
                                    </span>
                                    {running ? <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-cyan-300" /> : null}
                                </button>
                            );
                        })}
                        <button
                            className="btn mt-3 w-full justify-center"
                            onClick={() => void createSession(selectedProvider || defaultProvider)}
                            disabled={loading || availableProviders.length === 0 || presentationUiLocked}
                        >
                            {loading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                            New session
                        </button>
                    </div>
                ) : messages.length === 0 ? (
                    <div className="text-[11px] font-mono text-zinc-500 leading-relaxed">
                        Ask an OSINT question. The agent can inspect local data, create replay actions, and return map buttons.
                    </div>
                ) : messages.map((message) => {
                    const actions = actionsFromMessage(message);
                    const streamParts = displayPartsForMessage(message, runningRunId);
                    const streamGroups = groupStreamParts(streamParts);
                    const shouldShowFinalContent = shouldRenderFinalContent(message, streamParts, runningRunId);
                    const presentationKey = activeSessionId ? `${activeSessionId}:${message.agent_message_id}` : '';
                    const presentationRunning = Boolean(presentationKey && runningPresentationKey === presentationKey);
                    return (
                        <div
                            key={message.agent_message_id}
                            className={embedded
                                ? `chat__bubble ${message.role === 'user' ? 'chat__bubble--user' : 'chat__bubble--ai'}`
                                : `rounded-lg border px-3 py-2 ${
                                    message.role === 'user'
                                        ? 'ml-8 border-zinc-700 bg-zinc-900/80 text-zinc-100'
                                        : 'mr-8 border-zinc-800 bg-zinc-950/80 text-zinc-300'
                                }`}
                        >
                            <div className={embedded && message.role !== 'user' ? 'meta' : 'mb-1 text-[10px] uppercase font-mono text-zinc-500'}>
                                {embedded && message.role !== 'user' ? <Bot size={11} /> : null}
                                {message.role}
                            </div>
                            {streamParts.length > 0 ? (
                                <div className="space-y-1.5">
                                    {streamGroups.map((group, idx) => (
                                        group.type === 'text' ? (
                                            <MarkdownBlock key={group.part.id} text={group.part.text || ''} onOpenSpyLinkClick={(href, label) => void openOpenSpyLink(href, label)} />
                                        ) : (
                                            <ToolGroup key={`tools-${idx}-${group.parts[0]?.id || idx}`} parts={group.parts} />
                                        )
                                    ))}
                                    {shouldShowFinalContent && (
                                        <MarkdownBlock text={message.content} onOpenSpyLinkClick={(href, label) => void openOpenSpyLink(href, label)} />
                                    )}
                                </div>
                            ) : (
                                <div>
                                    {shouldShowFinalContent ? <MarkdownBlock text={message.content} onOpenSpyLinkClick={(href, label) => void openOpenSpyLink(href, label)} /> : (message.role === 'assistant' && runningRunId ? <Loader2 size={14} className="animate-spin text-cyan-300" /> : '')}
                                </div>
                            )}
                            <ImageryEvidenceRows
                                actions={actions}
                                onApply={(action) => void applyAction(action, activeSessionId).catch((err) => {
                                    setError(err instanceof Error ? err.message : 'Imagery action failed');
                                })}
                            />
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
                                    {presentationGuide?.key === presentationKey && (
                                        <PresentationGuideCard
                                            guide={presentationGuide}
                                            onStep={(index) => void applyPresentationGuideStep(index)}
                                            onClose={() => {
                                                clearPresentationStepCallout();
                                                setPresentationGuide(null);
                                            }}
                                        />
                                    )}
                                    <details className="mt-2 rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[10px] font-mono text-zinc-500">
                                        <summary className="cursor-pointer select-none text-zinc-400">
                                            Presentation steps ({actions.length})
                                        </summary>
                                        <div className="mt-2 grid gap-1">
                                            {actions.map((action, idx) => (
                                                <button
                                                    key={`${action.type}-${idx}`}
                                                    data-action-type={action.type}
                                                    title={`${formatActionType(action.type)}: ${actionLabel(action, idx)}`}
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
                {latestActions.length > 0 && !messageActionsVisible && !runningRunId && (
                    <div data-agent-latest-actions="true" className="mr-8 rounded-lg border border-cyan-900/60 bg-cyan-950/15 px-3 py-2">
                        <div className="mb-2 text-[10px] uppercase font-mono text-cyan-500">
                            latest actions
                        </div>
                        <div className="space-y-2">
                            <ImageryEvidenceRows
                                actions={latestActions}
                                onApply={(action) => void applyAction(action, activeSessionId).catch((err) => {
                                    setError(err instanceof Error ? err.message : 'Imagery action failed');
                                })}
                            />
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
                            {activeSessionId && presentationGuide?.key === `${activeSessionId}:latest-actions` && (
                                <PresentationGuideCard
                                    guide={presentationGuide}
                                    onStep={(index) => void applyPresentationGuideStep(index)}
                                    onClose={() => {
                                        clearPresentationStepCallout();
                                        setPresentationGuide(null);
                                    }}
                                />
                            )}
                            <details className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[10px] font-mono text-zinc-500">
                                <summary className="cursor-pointer select-none text-zinc-400">
                                    Presentation steps ({latestActions.length})
                                </summary>
                                <div className="mt-2 grid gap-1">
                                    {latestActions.map((action, idx) => (
                                        <button
                                            key={`latest-${action.type}-${idx}`}
                                            data-action-type={action.type}
                                            title={`${formatActionType(action.type)}: ${actionLabel(action, idx)}`}
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
                <div ref={messagesEndRef} aria-hidden="true" />
            </div>

            <div className={embedded ? (sessionPickerOpen ? 'hidden' : 'chat__compose') : 'p-2 border-t border-zinc-800'}>
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        // Enter sends; Shift+Enter inserts a newline. Ignore Enter
                        // while an IME composition is active so it commits text.
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void sendMessage();
                        }
                    }}
                    placeholder="Ask about vessels, cables, replay, sources..."
                    className={embedded
                        ? ''
                        : 'w-full h-20 resize-none rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-cyan-800'}
                />
                <div className={embedded ? 'contents' : 'mt-2 flex items-center justify-between gap-2'}>
                    <div className={embedded ? 'hidden' : 'text-[10px] font-mono text-zinc-600'}>
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
                            className={embedded
                                ? 'disabled:cursor-not-allowed disabled:opacity-50'
                                : 'flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-950/60 border border-cyan-900 text-[11px] font-mono text-cyan-100 hover:border-cyan-500 disabled:opacity-50'}
                        >
                            <Send size={12} />
                            {!embedded && 'Send'}
                        </button>
                    )}
                </div>
            </div>
        </div>
        </>
    );
}
