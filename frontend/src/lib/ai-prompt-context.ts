import {
    AI_CONTEXT_OBJECT_LIST_LIMIT,
    type AIContextObject,
    type AIContextSnapshot,
} from '../store/useAIImageStore';
import { formatDistance } from './ai-context-sources';

export interface AIImageCameraContext {
    lat: number;
    lng: number;
    height: number;
    heading: number;
    pitch: number;
}

export interface ResolveAIImagePromptOptions {
    includeSource: boolean;
    injectCamera: boolean;
}

export interface ResolveAIImagePromptResult {
    resolvedPrompt: string;
    warnings: string[];
}

export const AI_CONTEXT_PLACEHOLDERS = [
    { token: '{{ctx.primary.card}}', label: 'Closest object', description: 'Full card for the closest selected object' },
    { token: '{{ctx.objects_list}}', label: 'Nearby list', description: 'Cards for all selected nearby objects' },
];

const PLACEHOLDER_RE = /\{\{ctx\.([\w.]+)\}\}/g;

export function resolveAIImagePrompt(
    template: string,
    snapshot: AIContextSnapshot | null,
    camera: AIImageCameraContext,
    options: ResolveAIImagePromptOptions,
): ResolveAIImagePromptResult {
    const warnings: string[] = [];
    const primary = snapshot?.selected[0] ?? null;
    const resolved = template.replace(PLACEHOLDER_RE, (match, rawKey: string) => {
        switch (rawKey) {
            case 'primary.name':
                return primary ? primary.name : '(none)';
            case 'primary.type':
                return primary ? objectType(primary) : '(none)';
            case 'primary.card':
                return primary ? formatContextObjectCard(primary, options.includeSource) : '(none)';
            case 'objects_list':
                return snapshot ? formatObjectsList(snapshot.selected, options.includeSource) : '';
            case 'lat':
                return (snapshot?.center.lat ?? camera.lat).toFixed(5);
            case 'lng':
                return (snapshot?.center.lng ?? camera.lng).toFixed(5);
            case 'camera_height':
                return `${Math.round(camera.height)}m`;
            case 'heading':
                return `${Math.round(camera.heading)} deg`;
            case 'pitch':
                return `${Math.round(camera.pitch)} deg`;
            case 'radius':
                return `${Math.round(snapshot?.radiusM ?? 0)}m`;
            default:
                warnings.push(`Unknown placeholder: {{ctx.${rawKey}}}`);
                return match;
        }
    });

    return {
        resolvedPrompt: resolved,
        warnings,
    };
}

export function formatContextObjectCard(
    object: AIContextObject,
    includeSource: boolean,
): string {
    const lines = [
        `- Name: ${sanitize(object.name)}`,
        `- Type: ${sanitize(objectType(object))}`,
        `- Coordinates: ${object.lat.toFixed(5)}, ${object.lng.toFixed(5)}`,
        `- Distance from search center: ${formatDistance(object.distanceM)}`,
    ];
    if (typeof object.alt === 'number') {
        lines.push(`- Altitude: ${Math.round(object.alt)}m`);
    }
    if (includeSource) {
        lines.push(`- Source: ${sanitize(object.sourceLabel)}`);
    }
    if (object.description) {
        lines.push(`- Description: ${sanitize(object.description, 240)}`);
    }
    if (object.fields) {
        for (const [key, value] of Object.entries(object.fields)) {
            if (value === null || value === undefined || value === '') continue;
            lines.push(`- ${humanizeKey(key)}: ${sanitize(value, 180)}`);
        }
    }
    return lines.join('\n');
}

function formatObjectsList(objects: AIContextObject[], includeSource: boolean): string {
    return objects
        .slice(0, AI_CONTEXT_OBJECT_LIST_LIMIT)
        .map((object) => formatContextObjectCard(object, includeSource))
        .join('\n---\n');
}

function objectType(object: AIContextObject): string {
    return object.subtype ? `${object.type} / ${object.subtype}` : object.type;
}

function sanitize(value: unknown, max = 200): string {
    if (value === null || value === undefined) return '(unknown)';
    let text = String(value).trim().replace(/[\r\n\t\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ');
    if (!text) text = '(unknown)';
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function humanizeKey(key: string): string {
    return key
        .split('_')
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(' ');
}
