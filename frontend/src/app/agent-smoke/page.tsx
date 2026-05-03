import { notFound } from 'next/navigation';
import AgentSmokeClient from './AgentSmokeClient';

export default function AgentSmokePage() {
    if (process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_ENABLE_AGENT_SMOKE !== 'true') {
        notFound();
    }
    return <AgentSmokeClient />;
}
