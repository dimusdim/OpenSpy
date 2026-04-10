import CopyWebpackPlugin from 'copy-webpack-plugin';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
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
