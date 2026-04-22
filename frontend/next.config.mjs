import CopyWebpackPlugin from 'copy-webpack-plugin';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
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
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
      ],
    }];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
        config.plugins.push(
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: path.join(__dirname, 'node_modules/cesium/Build/Cesium/Workers'),
                        to: '../public/cesium/Workers',
                    },
                    {
                        from: path.join(__dirname, 'node_modules/cesium/Build/Cesium/ThirdParty'),
                        to: '../public/cesium/ThirdParty',
                    },
                    {
                        from: path.join(__dirname, 'node_modules/cesium/Build/Cesium/Assets'),
                        to: '../public/cesium/Assets',
                    },
                    {
                        from: path.join(__dirname, 'node_modules/cesium/Build/Cesium/Widgets'),
                        to: '../public/cesium/Widgets',
                    },
                ],
            })
        );
    }
    return config;
  },
};

export default nextConfig;
