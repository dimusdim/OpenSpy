const DEFAULT_API_URL =
    typeof window === 'undefined'
        ? 'http://localhost:3055'
        : `${window.location.protocol}//${window.location.hostname}:3055`;

export const API_URL = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;
