export type SpzLoadOptions = {
    colorScaleFactor?: number;
    unpackOptions?: {
        coordinateSystem?: string;
    };
};

function unsupportedSpz(): never {
    throw new Error(
        'Cesium SPZ Gaussian Splat decoding is disabled in this build. ' +
        'This app does not use SPZ tilesets; add an explicit SPZ bundling path before enabling them.',
    );
}

export async function loadSpz(_spzData: Uint8Array | ArrayBuffer, _options?: SpzLoadOptions): Promise<never> {
    unsupportedSpz();
}

export async function loadSpzFromUrl(_url: string, _options?: SpzLoadOptions): Promise<never> {
    unsupportedSpz();
}
