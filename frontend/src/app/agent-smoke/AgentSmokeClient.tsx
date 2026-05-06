'use client';

import { useEffect } from 'react';
import AgentPanel from '../../components/AgentPanel';
import { ImageryContextBadge } from '../../components/ImageryPanel';
import { useTimelineStore } from '../../store/useTimelineStore';

export default function AgentSmokeClient() {
    useEffect(() => {
        const win = window as any;
        win.__agentSmokeEvents = [];
        win.__agentSmokeTimelineState = () => {
            const state = useTimelineStore.getState();
            return {
                mode: state.mode,
                playbackKind: state.playbackKind,
                currentTime: state.currentTime.toISOString(),
                speedMultiplier: state.speedMultiplier,
                isPlaying: state.isPlaying,
                selectedEntityId: state.selectedEntityId,
                selectedEntityData: state.selectedEntityData,
                activeImageryOverlay: state.activeImageryOverlay,
                appliedSelections: state.appliedSelections,
            };
        };

        const onFlyTo = (event: Event) => {
            win.__agentSmokeEvents.push({ type: 'fly-to', detail: (event as CustomEvent).detail });
        };
        const onTimeline = (event: Event) => {
            win.__agentSmokeEvents.push({ type: 'timeline-ctrl', detail: (event as CustomEvent).detail });
        };
        document.addEventListener('fly-to', onFlyTo);
        document.addEventListener('timeline-ctrl', onTimeline);

        const smokeEntities: any[] = [];
        win.viewerContext = {
            isDestroyed: () => false,
            entities: {
                add: (entity: any) => {
                    smokeEntities.push(entity);
                    win.__agentSmokeEvents.push({
                        type: 'viewer.entity.add',
                        id: entity?.id,
                        label: entity?.label?.text,
                    });
                    return entity;
                },
                remove: (entity: any) => {
                    const idx = smokeEntities.indexOf(entity);
                    if (idx >= 0) smokeEntities.splice(idx, 1);
                    win.__agentSmokeEvents.push({
                        type: 'viewer.entity.remove',
                        id: entity?.id,
                    });
                    return true;
                },
                getById: (id: string) => smokeEntities.find((entity) => entity?.id === id),
                get values() {
                    return smokeEntities;
                },
            },
            imageryLayers: {
                addImageryProvider: (provider: any) => {
                    const layer = { provider, alpha: 1 };
                    win.__agentSmokeEvents.push({ type: 'viewer.imagery.add' });
                    return layer;
                },
                remove: () => {
                    win.__agentSmokeEvents.push({ type: 'viewer.imagery.remove' });
                    return true;
                },
            },
            scene: {
                requestRender: () => {
                    win.__agentSmokeEvents.push({ type: 'viewer.scene.requestRender' });
                },
            },
        };

        return () => {
            document.removeEventListener('fly-to', onFlyTo);
            document.removeEventListener('timeline-ctrl', onTimeline);
            delete win.viewerContext;
        };
    }, []);

    return (
        <main className="relative min-h-screen bg-zinc-950 text-white">
            <div className="absolute left-4 top-4 z-20 w-80">
                <ImageryContextBadge />
            </div>
            <AgentPanel isOpen={true} onClose={() => {}} />
        </main>
    );
}
