import * as Cesium from 'cesium';

const CesiumAny = Cesium as any;

type DenseGeometryKind = 'fill' | 'line';

type DenseGeometryPrimitiveOptions = {
    kind: DenseGeometryKind;
    positions: Float64Array;
    indices: Uint32Array;
    colors: Uint8Array;
    featureOrdinals: Uint32Array;
    pickIds: string[];
    debugLabel: string;
};

const AttributeLocations = {
    positionHigh: 0,
    positionLow: 1,
    color: 2,
    pickColor: 3,
} as const;

const VERTEX_SHADER = `
in vec3 positionHigh;
in vec3 positionLow;
in vec4 color;
in vec4 pickColor;

out vec4 v_color;
out vec4 v_pickColor;

void main()
{
    vec4 p = czm_translateRelativeToEye(positionHigh, positionLow);
    vec4 positionEC = czm_modelViewRelativeToEye * p;
    gl_Position = czm_projection * positionEC;
    czm_vertexLogDepth();
    v_color = color;
    v_pickColor = pickColor;
}
`;

const FRAGMENT_SHADER = `
in vec4 v_color;
in vec4 v_pickColor;

void main()
{
    if (v_color.a < 0.005)
    {
        discard;
    }
    out_FragColor = czm_gammaCorrect(v_color);
    czm_writeLogDepth();
}
`;

function encodeComponent(value: number): { high: number; low: number } {
    let high: number;
    if (value >= 0.0) {
        high = Math.floor(value / 65536.0) * 65536.0;
        return { high, low: value - high };
    }
    high = Math.floor(-value / 65536.0) * 65536.0;
    return { high: -high, low: value + high };
}

function encodePositions(positions: Float64Array): { high: Float32Array; low: Float32Array } {
    const high = new Float32Array(positions.length);
    const low = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 1) {
        const encoded = encodeComponent(positions[i]);
        high[i] = encoded.high;
        low[i] = encoded.low;
    }
    return { high, low };
}

function colorToBytes(color: Cesium.Color, target: Uint8Array, offset: number): void {
    target[offset] = Cesium.Color.floatToByte(color.red);
    target[offset + 1] = Cesium.Color.floatToByte(color.green);
    target[offset + 2] = Cesium.Color.floatToByte(color.blue);
    target[offset + 3] = Cesium.Color.floatToByte(color.alpha);
}

export function writeDenseColor(color: Cesium.Color, target: Uint8Array, vertexIndex: number): void {
    colorToBytes(color, target, vertexIndex * 4);
}

export class ReplayDenseGeometryPrimitive {
    private readonly kind: DenseGeometryKind;
    private positionHigh: Float32Array | null;
    private positionLow: Float32Array | null;
    private indices: Uint32Array | null;
    private colors: Uint8Array | null;
    private featureOrdinals: Uint32Array | null;
    private pickObjectIds: string[] | null;
    private readonly debugLabel: string;
    private readonly boundingVolume: Cesium.BoundingSphere;
    private vertexArray: any | null = null;
    private shaderProgram: any | null = null;
    private renderState: any | null = null;
    private command: any | null = null;
    private pickIds: Array<{ color: Cesium.Color; destroy: () => void }> = [];
    private destroyed = false;

    constructor(options: DenseGeometryPrimitiveOptions) {
        if (options.positions.length === 0 || options.indices.length === 0) {
            throw new Error(`[ReplayDenseGeometryPrimitive] empty geometry for ${options.debugLabel}`);
        }
        if (options.positions.length % 3 !== 0) {
            throw new Error(`[ReplayDenseGeometryPrimitive] positions must be vec3 for ${options.debugLabel}`);
        }
        const vertexCount = options.positions.length / 3;
        if (options.colors.length !== vertexCount * 4) {
            throw new Error(`[ReplayDenseGeometryPrimitive] color count mismatch for ${options.debugLabel}`);
        }
        if (options.featureOrdinals.length !== vertexCount) {
            throw new Error(`[ReplayDenseGeometryPrimitive] feature ordinal count mismatch for ${options.debugLabel}`);
        }
        const encoded = encodePositions(options.positions);
        this.kind = options.kind;
        this.positionHigh = encoded.high;
        this.positionLow = encoded.low;
        this.indices = options.indices;
        this.colors = options.colors;
        this.featureOrdinals = options.featureOrdinals;
        this.pickObjectIds = options.pickIds;
        this.debugLabel = options.debugLabel;
        this.boundingVolume = Cesium.BoundingSphere.fromVertices(options.positions as any);
    }

    update(frameState: any): void {
        if (this.destroyed) return;
        const passes = frameState.passes;
        if (!passes.render && !passes.pick) return;
        if (!this.command) this.createResources(frameState.context);
        frameState.commandList.push(this.command);
    }

    isDestroyed(): boolean {
        return this.destroyed;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.vertexArray = this.vertexArray && this.vertexArray.destroy();
        this.shaderProgram = this.shaderProgram && this.shaderProgram.destroy();
        if (this.renderState) {
            CesiumAny.RenderState?.removeFromCache?.(this.renderState);
            this.renderState = null;
        }
        for (const pickId of this.pickIds) pickId.destroy();
        this.pickIds = [];
        this.command = null;
        this.destroyed = true;
    }

    private createResources(context: any): void {
        const positionHigh = this.positionHigh;
        const positionLow = this.positionLow;
        const indices = this.indices;
        const colors = this.colors;
        const featureOrdinals = this.featureOrdinals;
        const pickObjectIds = this.pickObjectIds;
        if (!positionHigh || !positionLow || !indices || !colors || !featureOrdinals || !pickObjectIds) {
            throw new Error(`[ReplayDenseGeometryPrimitive] CPU buffers already released before GPU upload for ${this.debugLabel}`);
        }
        const vertexCount = positionHigh.length / 3;
        const pickColors = new Uint8Array(vertexCount * 4);
        this.pickIds = pickObjectIds.map((id) => context.createPickId({ id }));
        for (let i = 0; i < vertexCount; i += 1) {
            const ordinal = featureOrdinals[i];
            const pickId = this.pickIds[ordinal];
            if (!pickId) {
                throw new Error(`[ReplayDenseGeometryPrimitive] missing pick id ordinal=${ordinal} for ${this.debugLabel}`);
            }
            colorToBytes(pickId.color, pickColors, i * 4);
        }

        const indexArray = indices;
        const indexBuffer = CesiumAny.Buffer.createIndexBuffer({
            context,
            typedArray: indexArray,
            usage: CesiumAny.BufferUsage.STATIC_DRAW,
            indexDatatype: CesiumAny.IndexDatatype.fromTypedArray(indexArray),
        });
        this.vertexArray = new CesiumAny.VertexArray({
            context,
            indexBuffer,
            attributes: [
                {
                    index: AttributeLocations.positionHigh,
                    componentDatatype: Cesium.ComponentDatatype.FLOAT,
                    componentsPerAttribute: 3,
                        vertexBuffer: CesiumAny.Buffer.createVertexBuffer({
                            context,
                            typedArray: positionHigh,
                        usage: CesiumAny.BufferUsage.STATIC_DRAW,
                    }),
                },
                {
                    index: AttributeLocations.positionLow,
                    componentDatatype: Cesium.ComponentDatatype.FLOAT,
                    componentsPerAttribute: 3,
                        vertexBuffer: CesiumAny.Buffer.createVertexBuffer({
                            context,
                            typedArray: positionLow,
                        usage: CesiumAny.BufferUsage.STATIC_DRAW,
                    }),
                },
                {
                    index: AttributeLocations.color,
                    componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
                    componentsPerAttribute: 4,
                    normalize: true,
                        vertexBuffer: CesiumAny.Buffer.createVertexBuffer({
                            context,
                            typedArray: colors,
                        usage: CesiumAny.BufferUsage.STATIC_DRAW,
                    }),
                },
                {
                    index: AttributeLocations.pickColor,
                    componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
                    componentsPerAttribute: 4,
                    normalize: true,
                    vertexBuffer: CesiumAny.Buffer.createVertexBuffer({
                        context,
                        typedArray: pickColors,
                        usage: CesiumAny.BufferUsage.STATIC_DRAW,
                    }),
                },
            ],
        });
        this.shaderProgram = CesiumAny.ShaderProgram.fromCache({
            context,
            vertexShaderSource: new CesiumAny.ShaderSource({ sources: [VERTEX_SHADER] }),
            fragmentShaderSource: new CesiumAny.ShaderSource({ sources: [FRAGMENT_SHADER] }),
            attributeLocations: AttributeLocations,
        });
        this.renderState = CesiumAny.RenderState.fromCache({
            depthTest: { enabled: true },
            depthMask: this.kind !== 'fill',
            blending: CesiumAny.BlendingState.ALPHA_BLEND,
        });
        this.command = new CesiumAny.DrawCommand({
            vertexArray: this.vertexArray,
            renderState: this.renderState,
            shaderProgram: this.shaderProgram,
            primitiveType: this.kind === 'fill' ? Cesium.PrimitiveType.TRIANGLES : Cesium.PrimitiveType.LINES,
            pass: CesiumAny.Pass.TRANSLUCENT,
            pickId: 'v_pickColor',
            owner: this,
            count: indexArray.length,
            boundingVolume: this.boundingVolume,
        });
        this.positionHigh = null;
        this.positionLow = null;
        this.indices = null;
        this.colors = null;
        this.featureOrdinals = null;
        this.pickObjectIds = null;
    }
}
