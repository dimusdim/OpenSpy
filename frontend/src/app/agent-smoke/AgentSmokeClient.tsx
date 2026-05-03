'use client';

import { useEffect } from 'react';
import AgentPanel from '../../components/AgentPanel';
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

        win.viewerContext = {
            isDestroyed: () => false,
            entities: {
                add: (entity: any) => {
                    win.__agentSmokeEvents.push({
                        type: 'viewer.entity.add',
                        label: entity?.label?.text,
                    });
                    return entity;
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
            <AgentPanel isOpen={true} onClose={() => {}} />
        </main>
    );
}
