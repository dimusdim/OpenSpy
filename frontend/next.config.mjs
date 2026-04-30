import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  experimental: {
    externalDir: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Cesium BillboardTexture.loadImage (Source/Scene/BillboardTexture.js:241)
  // reads `atlas.rectangles[index].width` without guarding against the atlas
  // being destroyed between addImage kickoff and its Promise resolve.
  // Next.js 14 defaults reactStrictMode to true, which double-invokes every
  // effect in dev: first mount creates a BillboardCollection and fires an
  // async texture load, cleanup destroys the atlas, second mount creates a
  // fresh one, and the in-flight Promise from the first mount then indexes
  // into the wrong atlas -> `rectangle` is undefined -> the TypeError
  // cascades into every live billboard.add call on the page.
  reactStrictMode: false,
  webpack(config) {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      // Cesium 1.140 imports @spz-loader/core for Gaussian Splat 3D Tiles.
      // The upstream package embeds WASM in a JS template literal that Next's
      // production client build emits as an invalid JS chunk. We do not load
      // SPZ tilesets in this app, so keep the core map build valid and fail
      // explicitly if that unsupported path is ever exercised.
      '@spz-loader/core$': path.resolve(__dirname, 'src/cesium/spzLoaderUnavailable.ts'),
    };
    return config;
  },
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
      ],
    }];
  },
};

export default nextConfig;
