'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = {
    children: ReactNode;
    /** Human label for the region, e.g. "Globe" or "Agent". */
    label?: string;
    /** Render a tighter fallback for narrow dock/panel regions. */
    compact?: boolean;
};

type ErrorBoundaryState = {
    error: Error | null;
};

/**
 * Catches render/lifecycle errors in a subtree and shows a compact, dismissible
 * fallback instead of a blank screen. Wrapping the globe and each dock panel
 * separately keeps one crashing panel from taking down the whole app.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        const scope = this.props.label ? ` ${this.props.label}` : '';
        // eslint-disable-next-line no-console
        console.error(`[ErrorBoundary${scope}]`, error, info.componentStack);
    }

    private handleDismiss = () => {
        this.setState({ error: null });
    };

    private handleReload = () => {
        if (typeof window !== 'undefined') window.location.reload();
    };

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;

        const { label, compact } = this.props;
        const title = label ? `${label} failed to render` : 'Something went wrong';
        const message = error.message || 'An unexpected error occurred in this panel.';

        return (
            <div className={compact ? 'os-error-boundary os-error-boundary--compact' : 'os-error-boundary'} role="alert">
                <div className="os-error-boundary__title">{title}</div>
                <div className="os-error-boundary__msg">{message}</div>
                <div className="os-error-boundary__actions">
                    <button type="button" className="os-error-boundary__btn os-error-boundary__btn--primary" onClick={this.handleReload}>
                        Reload
                    </button>
                    <button type="button" className="os-error-boundary__btn" onClick={this.handleDismiss}>
                        Dismiss
                    </button>
                </div>
            </div>
        );
    }
}
