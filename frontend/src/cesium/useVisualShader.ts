import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { useTimelineStore, type VisualShaderPreset } from '../store/useTimelineStore';

const FULL_SCENE_SHADER = `
uniform sampler2D colorTexture;
uniform vec2 colorTextureDimensions;
uniform float u_preset;

in vec2 v_textureCoordinates;

float luminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

float edgeSignal(vec2 uv) {
    vec2 px = 1.0 / colorTextureDimensions;
    float c = luminance(texture(colorTexture, uv).rgb);
    float dx = abs(c - luminance(texture(colorTexture, uv + vec2(px.x, 0.0)).rgb));
    float dy = abs(c - luminance(texture(colorTexture, uv + vec2(0.0, px.y)).rgb));
    return smoothstep(0.035, 0.18, dx + dy);
}

float lineGrid(vec2 uv, float scale, float width) {
    vec2 cell = abs(fract(uv * scale) - 0.5);
    float nearest = min(cell.x, cell.y);
    return 1.0 - smoothstep(width, width + 0.01, nearest);
}

float dotGrid(vec2 uv, float scale, float radius) {
    vec2 cell = fract(uv * scale) - 0.5;
    float dist = length(cell);
    return 1.0 - smoothstep(radius, radius + 0.018, dist);
}

vec3 thermalRamp(float value) {
    vec3 cold = vec3(0.02, 0.04, 0.15);
    vec3 blue = vec3(0.0, 0.22, 0.75);
    vec3 magenta = vec3(0.75, 0.05, 0.55);
    vec3 orange = vec3(1.0, 0.42, 0.04);
    vec3 white = vec3(1.0, 0.92, 0.62);
    vec3 color = mix(cold, blue, smoothstep(0.00, 0.28, value));
    color = mix(color, magenta, smoothstep(0.22, 0.52, value));
    color = mix(color, orange, smoothstep(0.48, 0.78, value));
    color = mix(color, white, smoothstep(0.76, 1.00, value));
    return color;
}

void main() {
    vec2 uv = v_textureCoordinates;
    vec4 original = texture(colorTexture, uv);
    vec3 color = original.rgb;
    float lum = luminance(color);
    float edge = edgeSignal(uv);
    float aspect = colorTextureDimensions.x / max(colorTextureDimensions.y, 1.0);
    vec2 squareUv = vec2(uv.x * aspect, uv.y);

    if (u_preset < 0.5) {
        color = original.rgb;
    } else if (u_preset < 1.5) {
        vec3 base = vec3(0.006, 0.023, 0.060) + vec3(0.015, 0.100, 0.210) * pow(lum, 0.65);
        float dots = dotGrid(squareUv, 58.0, 0.038);
        float scan = 1.0 - smoothstep(0.018, 0.050, abs(fract(uv.y * 115.0 - czm_frameNumber * 0.020) - 0.5));
        color = base
            + edge * vec3(0.00, 0.48, 0.95)
            + dots * vec3(0.00, 0.18, 0.36)
            + scan * vec3(0.00, 0.035, 0.075);
        color *= 0.88 + 0.18 * smoothstep(0.0, 0.85, lum);
    } else if (u_preset < 2.5) {
        vec3 base = color * vec3(0.18, 0.32, 0.36);
        float grid = lineGrid(squareUv, 28.0, 0.012);
        float dots = dotGrid(squareUv, 36.0, 0.034);
        color = base
            + edge * vec3(0.05, 0.92, 0.98)
            + grid * vec3(0.00, 0.18, 0.22)
            + dots * vec3(0.00, 0.34, 0.36);
    } else if (u_preset < 3.5) {
        float heat = clamp(pow(lum, 0.78) + edge * 0.24, 0.0, 1.0);
        color = thermalRamp(heat);
    } else if (u_preset < 4.5) {
        float mono = pow(lum, 0.82);
        color = vec3(mono) * 1.08 + edge * vec3(0.22, 0.28, 0.30);
    } else if (u_preset < 5.5) {
        float scan = 0.65 + 0.35 * sin(uv.y * 820.0 - czm_frameNumber * 0.095);
        color = vec3(0.015, 0.080, 0.020) + vec3(0.08, 0.62, 0.10) * pow(lum, 0.72) + edge * vec3(0.20, 1.0, 0.18);
        color *= scan;
    } else if (u_preset < 6.5) {
        float split = smoothstep(0.20, 0.90, lum);
        vec3 cyan = vec3(0.0, 0.86, 1.0) * (edge + 0.18);
        vec3 magenta = vec3(1.0, 0.08, 0.78) * split;
        float grid = lineGrid(squareUv + vec2(czm_frameNumber * 0.0015, 0.0), 34.0, 0.010);
        color = color * vec3(0.22, 0.18, 0.30) + cyan + magenta * 0.45 + grid * vec3(0.20, 0.0, 0.28);
    } else if (u_preset < 7.5) {
        color = vec3(0.88, 0.96, 1.0) * (1.0 - pow(lum, 0.72)) + edge * vec3(0.0, 0.65, 1.0);
    } else if (u_preset < 8.5) {
        float hazard = lineGrid(squareUv + vec2(czm_frameNumber * 0.002, -czm_frameNumber * 0.001), 18.0, 0.020);
        color = vec3(0.11, 0.055, 0.005) + vec3(1.0, 0.42, 0.02) * pow(lum, 0.80) + hazard * vec3(0.40, 0.18, 0.0) + edge * vec3(1.0, 0.28, 0.0);
    } else if (u_preset < 9.5) {
        float stars = dotGrid(squareUv + vec2(0.0, czm_frameNumber * 0.0008), 92.0, 0.020);
        color = color * vec3(0.05, 0.08, 0.16) + edge * vec3(0.20, 0.34, 0.72) + stars * vec3(0.25, 0.55, 1.0);
    } else {
        float scope = 1.0 - smoothstep(0.32, 0.72, length(uv - vec2(0.5)));
        float sweep = 1.0 - smoothstep(0.020, 0.080, abs(fract(atan(uv.y - 0.5, uv.x - 0.5) / 6.28318 + czm_frameNumber * 0.004) - 0.5));
        color = vec3(0.18, 0.012, 0.006) + vec3(1.0, 0.12, 0.035) * pow(lum, 0.70) + edge * vec3(1.0, 0.18, 0.06);
        color *= 0.70 + scope * 0.38 + sweep * 0.10;
    }

    out_FragColor = vec4(clamp(color, 0.0, 1.0), original.a);
}
`;

function presetToUniform(preset: VisualShaderPreset): number {
    switch (preset) {
        case 'night-ops': return 1;
        case 'signal-grid': return 2;
        case 'thermal': return 3;
        case 'monochrome': return 4;
        case 'tactical-green': return 5;
        case 'cyberpunk': return 6;
        case 'xray': return 7;
        case 'hazard': return 8;
        case 'deep-space': return 9;
        case 'infrared': return 10;
        case 'normal':
        default:
            return 0;
    }
}

export function useVisualShader(viewer: Cesium.Viewer | null) {
    const visualShader = useTimelineStore((s) => s.visualShader);
    const stageRef = useRef<Cesium.PostProcessStage | null>(null);

    useEffect(() => {
        if (!viewer || viewer.isDestroyed()) return;

        const needsStage = visualShader !== 'normal';
        if (!needsStage) {
            if (stageRef.current) {
                viewer.scene.postProcessStages.remove(stageRef.current);
                stageRef.current = null;
                viewer.scene.requestRender();
            }
            return;
        }

        if (!stageRef.current) {
            stageRef.current = new Cesium.PostProcessStage({
                name: 'openspy-visual-shader',
                fragmentShader: FULL_SCENE_SHADER,
                uniforms: {
                    u_preset: presetToUniform(visualShader),
                },
            });
            viewer.scene.postProcessStages.add(stageRef.current);
        } else {
            (stageRef.current.uniforms as any).u_preset = presetToUniform(visualShader);
        }
        viewer.scene.requestRender();

        return () => {
            if (viewer.isDestroyed() || !stageRef.current) return;
            viewer.scene.postProcessStages.remove(stageRef.current);
            stageRef.current = null;
            viewer.scene.requestRender();
        };
    }, [viewer, visualShader]);

    useEffect(() => {
        if (!viewer || viewer.isDestroyed()) return;
        if (visualShader === 'normal') return;
        const interval = window.setInterval(() => {
            if (!viewer.isDestroyed()) viewer.scene.requestRender();
        }, 33);
        return () => window.clearInterval(interval);
    }, [viewer, visualShader]);
}
