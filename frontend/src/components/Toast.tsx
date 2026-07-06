'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastType = 'error' | 'info' | 'success';

type Toast = {
    id: number;
    message: string;
    type: ToastType;
};

type ToastContextValue = {
    showToast: (message: string, type?: ToastType) => void;
};

const AUTO_DISMISS_MS = 5000;

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Access the toast API. Returns a no-op when used outside a ToastProvider so a
 * missing provider never crashes a consumer.
 */
export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) return { showToast: () => {} };
    return ctx;
}

function ToastIcon({ type }: { type: ToastType }) {
    if (type === 'error') return <AlertTriangle size={14} />;
    if (type === 'success') return <CheckCircle2 size={14} />;
    return <Info size={14} />;
}

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const idRef = useRef(0);
    const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

    const dismiss = useCallback((id: number) => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
        const timer = timersRef.current.get(id);
        if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(id);
        }
    }, []);

    const showToast = useCallback((message: string, type: ToastType = 'info') => {
        const trimmed = message?.trim();
        if (!trimmed) return;
        const id = (idRef.current += 1);
        setToasts((current) => [...current, { id, message: trimmed, type }]);
        const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
        timersRef.current.set(id, timer);
    }, [dismiss]);

    useEffect(() => {
        const timers = timersRef.current;
        return () => {
            timers.forEach((timer) => clearTimeout(timer));
            timers.clear();
        };
    }, []);

    const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);

    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="os-toasts" aria-live="polite" aria-atomic="false">
                {toasts.map((toast) => (
                    <div key={toast.id} className={`os-toast os-toast--${toast.type}`} role="status">
                        <span className="os-toast__icon">
                            <ToastIcon type={toast.type} />
                        </span>
                        <span className="os-toast__msg">{toast.message}</span>
                        <button
                            type="button"
                            className="os-toast__close"
                            aria-label="Dismiss notification"
                            onClick={() => dismiss(toast.id)}
                        >
                            <X size={12} />
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}
