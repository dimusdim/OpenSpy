#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { performance } = require('perf_hooks');
const { decode } = require('../backend/node_modules/@msgpack/msgpack');

const ROOT_DIR = path.resolve(__dirname, '..');
const TILE_ROOT = path.join(ROOT_DIR, 'backend/var/replay-tiles');
const DEFAULT_OUT_DIR = path.join(ROOT_DIR, '.local/replay-binary-prototype');
const VIEWER_SRC = path.join(__dirname, 'replay-binary-viewer.html');
const MAGIC = 'AWVBIN1\0';
const HEADER_BYTES = 64;

function parseArgs(argv) {
  const out = {
    layer: 'airspace',
    z: 0,
    x: 0,
    y: 0,
    out: DEFAULT_OUT_DIR,
    port: 8787,
    maxFeatures: Number.POSITIVE_INFINITY,
    serve: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--layer') out.layer = next();
    else if (arg === '--tile') out.tile = next();
    else if (arg === '--at') out.at = next();
    else if (arg === '--z') out.z = Number(next());
    else if (arg === '--x') out.x = Number(next());
    else if (arg === '--y') out.y = Number(next());
    else if (arg === '--out') out.out = path.resolve(next());
    else if (arg === '--port') out.port = Number(next());
    else if (arg === '--max-features') out.maxFeatures = Number(next());
    else if (arg === '--serve') out.serve = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function usage() {
  console.log(`
Build a prototype binary render payload from an existing replay msgpack tile.

Usage:
  node scripts/prototype-replay-binary.cjs --layer airspace --at 2026-04-24T00:00:00.000Z
  node scripts/prototype-replay-binary.cjs --tile backend/var/replay-tiles/pipeline/0/0/0/file.msgpack
  node scripts/prototype-replay-binary.cjs --layer cable --out tmp/replay-binary-prototype/cable --serve

Options:
  --layer <id>          Replay tile layer, default airspace.
  --tile <path>         Exact .msgpack tile to convert.
  --at <iso>            Prefer tile whose filename starts with this bucket time.
  --z/--x/--y <n>       Tile coordinate, default 0/0/0.
  --max-features <n>    Cap features for quick sampling.
  --out <dir>           Output dir, default tmp/replay-binary-prototype.
  --serve               Serve the output dir with a standalone viewer.
  --port <n>            Port for --serve, default 8787.
`);
}

function timeStep(timings, name, startedAt) {
  timings[name] = roundMs(performance.now() - startedAt);
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function normalizeBucketForFilename(iso) {
  return new Date(iso).toISOString().replace(/:/g, '-');
}

function findTile(options) {
  if (options.tile) {
    const absolute = path.resolve(options.tile);
    if (!fs.existsSync(absolute)) throw new Error(`Tile not found: ${absolute}`);
    return absolute;
  }

  const dir = path.join(TILE_ROOT, options.layer, String(options.z), String(options.x), String(options.y));
  if (!fs.existsSync(dir)) throw new Error(`Tile directory not found: ${dir}`);

  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.msgpack'))
    .sort();
  if (files.length === 0) throw new Error(`No .msgpack tiles in ${dir}`);

  if (options.at) {
    const prefix = normalizeBucketForFilename(options.at);
    const exact = files.find((name) => name.startsWith(prefix));
    if (!exact) throw new Error(`No tile for --at ${options.at} (${prefix}) in ${dir}`);
    return path.join(dir, exact);
  }

  return path.join(dir, files[files.length - 1]);
}

function stableHash32(input) {
  const str = String(input || '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function asFeatureList(payload) {
  const snapshot = payload.snapshot || {};
  const base = [
    ...(snapshot.assets || []),
    ...(snapshot.events || []),
    ...(snapshot.entities || []),
  ];

  // Most current replay tiles keep renderable state in snapshot.*. This fallback
  // makes the prototype useful for unusual bucket-only payloads too.
  for (const item of payload.items || []) {
    if (item && item.geometry) base.push(item);
    else if (item && item.asset && item.asset.geometry) base.push(item.asset);
    else if (item && item.event && item.event.geometry) base.push(item.event);
    else if (item && item.entity && item.entity.geometry) base.push(item.entity);
  }

  return base;
}

function getFeatureId(feature, index) {
  return feature.asset_id
    || feature.event_id
    || feature.entity_id
    || feature.id
    || `${feature.layer_id || 'feature'}:${index}`;
}

function getDisplayName(feature, fallbackId) {
  return feature.display_name
    || feature.name
    || feature.properties?.name
    || feature.properties?.location
    || fallbackId;
}

function isValidLonLat(point) {
  return Array.isArray(point)
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]))
    && Number(point[0]) >= -180
    && Number(point[0]) <= 180
    && Number(point[1]) >= -90
    && Number(point[1]) <= 90;
}

function geometryForFeature(feature) {
  if (feature?.geometry?.type) return feature.geometry;

  const lng = Number(feature?.display_lng ?? feature?.lng ?? feature?.lon ?? feature?.longitude);
  const lat = Number(feature?.display_lat ?? feature?.lat ?? feature?.latitude);
  if (Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
    return { type: 'Point', coordinates: [lng, lat] };
  }

  return null;
}

function samePoint(a, b) {
  return a && b && Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1]);
}

function cleanLine(coords) {
  if (!Array.isArray(coords)) return [];
  const line = [];
  for (const point of coords) {
    if (!isValidLonLat(point)) continue;
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    const prev = line[line.length - 1];
    if (prev && prev[0] === lng && prev[1] === lat) continue;
    line.push([lng, lat]);
  }
  return line;
}

function cleanRing(coords) {
  const ring = cleanLine(coords);
  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) ring.pop();
  return ring;
}

function updateBbox(bbox, lng, lat) {
  if (lng < bbox[0]) bbox[0] = lng;
  if (lat < bbox[1]) bbox[1] = lat;
  if (lng > bbox[2]) bbox[2] = lng;
  if (lat > bbox[3]) bbox[3] = lat;
}

function styleIdFor(feature) {
  return stableHash32(`${feature.layer_id || ''}:${feature.subtype || feature.asset_kind || feature.event_kind || feature.source_id || ''}`) & 0xffff;
}

function pushPoint(state, featureHash, bbox, point) {
  const lng = Number(point[0]);
  const lat = Number(point[1]);
  state.pointPositions.push(lng, lat);
  state.pointFeatureIds.push(featureHash);
  updateBbox(bbox, lng, lat);
}

function pushLine(state, featureHash, bbox, coords) {
  const line = cleanLine(coords);
  if (line.length < 2) return 0;

  let vertices = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    state.linePositions.push(a[0], a[1], b[0], b[1]);
    state.lineFeatureIds.push(featureHash, featureHash);
    updateBbox(bbox, a[0], a[1]);
    updateBbox(bbox, b[0], b[1]);
    vertices += 2;
  }
  return vertices;
}

function pushPolygon(state, featureHash, bbox, polygon) {
  if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) return { fillVertices: 0, fillIndices: 0, lineVertices: 0 };

  let lineVertices = 0;
  for (const ringCoords of polygon) {
    const ring = cleanRing(ringCoords);
    if (ring.length < 2) continue;
    const closed = [...ring, ring[0]];
    lineVertices += pushLine(state, featureHash, bbox, closed);
  }

  // Prototype triangulation: outer-ring fan only. It is intentionally simple:
  // we want a timing baseline for server-side conversion and browser upload,
  // not final cartographic polygon correctness.
  const outer = cleanRing(polygon[0]);
  if (outer.length < 3) return { fillVertices: 0, fillIndices: 0, lineVertices };

  const baseVertex = state.fillPositions.length / 2;
  for (const point of outer) {
    state.fillPositions.push(point[0], point[1]);
    state.fillFeatureIds.push(featureHash);
    updateBbox(bbox, point[0], point[1]);
  }

  const indexStart = state.fillIndices.length;
  for (let i = 1; i < outer.length - 1; i += 1) {
    state.fillIndices.push(baseVertex, baseVertex + i, baseVertex + i + 1);
  }

  return {
    fillVertices: outer.length,
    fillIndices: state.fillIndices.length - indexStart,
    lineVertices,
  };
}

function packGeometry(payload, options) {
  const allFeatures = asFeatureList(payload);
  const maxFeatures = Number.isFinite(options.maxFeatures) ? options.maxFeatures : allFeatures.length;
  const features = allFeatures.slice(0, maxFeatures);

  const state = {
    pointPositions: [],
    pointFeatureIds: [],
    linePositions: [],
    lineFeatureIds: [],
    fillPositions: [],
    fillIndices: [],
    fillFeatureIds: [],
    featureRows: [],
    featureBboxes: [],
    featureSamples: [],
    skippedNoGeometry: 0,
    skippedUnsupported: 0,
  };

  for (let i = 0; i < features.length; i += 1) {
    const feature = features[i];
    const geometry = geometryForFeature(feature);
    if (!geometry || !geometry.type) {
      state.skippedNoGeometry += 1;
      continue;
    }

    const id = getFeatureId(feature, i);
    const hash = stableHash32(id);
    const style = styleIdFor(feature);
    const pointStart = state.pointPositions.length / 2;
    const lineStart = state.linePositions.length / 2;
    const fillStart = state.fillPositions.length / 2;
    const indexStart = state.fillIndices.length;
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    let kind = 0;

    switch (geometry.type) {
      case 'Point':
        if (isValidLonLat(geometry.coordinates)) {
          pushPoint(state, hash, bbox, geometry.coordinates);
          kind |= 1;
        }
        break;
      case 'MultiPoint':
        for (const point of geometry.coordinates || []) {
          if (isValidLonLat(point)) {
            pushPoint(state, hash, bbox, point);
            kind |= 1;
          }
        }
        break;
      case 'LineString':
        if (pushLine(state, hash, bbox, geometry.coordinates) > 0) kind |= 2;
        break;
      case 'MultiLineString':
        for (const line of geometry.coordinates || []) {
          if (pushLine(state, hash, bbox, line) > 0) kind |= 2;
        }
        break;
      case 'Polygon': {
        const result = pushPolygon(state, hash, bbox, geometry.coordinates);
        if (result.lineVertices > 0) kind |= 2;
        if (result.fillVertices > 0 && result.fillIndices > 0) kind |= 4;
        break;
      }
      case 'MultiPolygon':
        for (const polygon of geometry.coordinates || []) {
          const result = pushPolygon(state, hash, bbox, polygon);
          if (result.lineVertices > 0) kind |= 2;
          if (result.fillVertices > 0 && result.fillIndices > 0) kind |= 4;
        }
        break;
      default:
        state.skippedUnsupported += 1;
        break;
    }

    const pointCount = state.pointPositions.length / 2 - pointStart;
    const lineVertexCount = state.linePositions.length / 2 - lineStart;
    const fillVertexCount = state.fillPositions.length / 2 - fillStart;
    const indexCount = state.fillIndices.length - indexStart;
    if (!kind || !Number.isFinite(bbox[0])) continue;

    state.featureRows.push(
      hash,
      kind,
      pointStart,
      pointCount,
      lineStart,
      lineVertexCount,
      fillStart,
      fillVertexCount,
      indexStart,
      indexCount,
      style,
      0,
    );
    state.featureBboxes.push(bbox[0], bbox[1], bbox[2], bbox[3]);

    if (state.featureSamples.length < 24) {
      state.featureSamples.push({
        id,
        hash,
        name: getDisplayName(feature, id),
        subtype: feature.subtype || null,
        sourceId: feature.source_id || null,
        kind,
        bbox,
      });
    }
  }

  return {
    featureTable: Uint32Array.from(state.featureRows),
    featureBboxes: Float32Array.from(state.featureBboxes),
    pointPositions: Float32Array.from(state.pointPositions),
    pointFeatureIds: Uint32Array.from(state.pointFeatureIds),
    linePositions: Float32Array.from(state.linePositions),
    lineFeatureIds: Uint32Array.from(state.lineFeatureIds),
    fillPositions: Float32Array.from(state.fillPositions),
    fillIndices: Uint32Array.from(state.fillIndices),
    fillFeatureIds: Uint32Array.from(state.fillFeatureIds),
    featureSamples: state.featureSamples,
    skippedNoGeometry: state.skippedNoGeometry,
    skippedUnsupported: state.skippedUnsupported,
    inputFeatureCount: allFeatures.length,
  };
}

function typedBuffer(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function buildBinary(packed, payload, sourceTile) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(HEADER_BYTES, 12);
  header.writeUInt32LE(packed.featureTable.length / 12, 16);
  header.writeUInt32LE(packed.pointPositions.length / 2, 20);
  header.writeUInt32LE(packed.linePositions.length / 2, 24);
  header.writeUInt32LE(packed.fillPositions.length / 2, 28);
  header.writeUInt32LE(packed.fillIndices.length, 32);
  header.writeUInt32LE(stableHash32(payload.layerId || path.basename(sourceTile)), 36);

  const sectionSpecs = [
    ['featureTable', 'uint32', 12, packed.featureTable],
    ['featureBboxes', 'float32', 4, packed.featureBboxes],
    ['pointPositions', 'float32', 2, packed.pointPositions],
    ['pointFeatureIds', 'uint32', 1, packed.pointFeatureIds],
    ['linePositions', 'float32', 2, packed.linePositions],
    ['lineFeatureIds', 'uint32', 1, packed.lineFeatureIds],
    ['fillPositions', 'float32', 2, packed.fillPositions],
    ['fillIndices', 'uint32', 1, packed.fillIndices],
    ['fillFeatureIds', 'uint32', 1, packed.fillFeatureIds],
  ];

  let byteOffset = HEADER_BYTES;
  const sections = {};
  const buffers = [header];

  for (const [name, type, itemSize, array] of sectionSpecs) {
    const buffer = typedBuffer(array);
    sections[name] = {
      type,
      itemSize,
      byteOffset,
      byteLength: buffer.byteLength,
      length: array.length,
    };
    buffers.push(buffer);
    byteOffset += buffer.byteLength;
  }

  return {
    buffer: Buffer.concat(buffers),
    sections,
  };
}

function writeViewer(outDir) {
  if (fs.existsSync(VIEWER_SRC)) {
    fs.copyFileSync(VIEWER_SRC, path.join(outDir, 'index.html'));
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.bin')) return 'application/octet-stream';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function serveDir(outDir, port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(outDir, `.${pathname}`);
    if (!target.startsWith(path.resolve(outDir))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType(target),
        'Cache-Control': 'no-store',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      res.end(data);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Viewer: http://127.0.0.1:${port}/`);
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const totalStart = performance.now();
  const timings = {};
  const tileStart = performance.now();
  const tilePath = findTile(options);
  timeStep(timings, 'locateTile', tileStart);

  const readStart = performance.now();
  const raw = fs.readFileSync(tilePath);
  timeStep(timings, 'readMsgpack', readStart);

  const decodeStart = performance.now();
  const payload = decode(raw);
  timeStep(timings, 'decodeMsgpack', decodeStart);

  const packStart = performance.now();
  const packed = packGeometry(payload, options);
  timeStep(timings, 'packTypedArrays', packStart);

  const binaryStart = performance.now();
  const binary = buildBinary(packed, payload, tilePath);
  timeStep(timings, 'buildBinaryBuffer', binaryStart);

  const writeStart = performance.now();
  fs.mkdirSync(options.out, { recursive: true });
  const binPath = path.join(options.out, 'layer.bin');
  const manifestPath = path.join(options.out, 'manifest.json');
  fs.writeFileSync(binPath, binary.buffer);

  const featureCount = packed.featureTable.length / 12;
  const manifest = {
    format: 'AWVBIN1',
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceTile: path.relative(ROOT_DIR, tilePath),
    layerId: payload.layerId || options.layer,
    z: payload.z,
    x: payload.x,
    y: payload.y,
    tBucket: payload.tBucket,
    snapshotAt: payload.snapshotAt,
    bbox: payload.bbox,
    notes: [
      'Prototype render payload. Runtime app code does not consume this format yet.',
      'Polygon fill uses simple outer-ring fan triangulation; holes and concavity are not production-correct.',
      'Metadata is intentionally not in layer.bin; render payload is packed numeric arrays only.',
    ],
    counts: {
      inputFeatures: packed.inputFeatureCount,
      outputFeatures: featureCount,
      skippedNoGeometry: packed.skippedNoGeometry,
      skippedUnsupported: packed.skippedUnsupported,
      payloadSnapshotEntities: payload.snapshot?.entities?.length || 0,
      payloadSnapshotEvents: payload.snapshot?.events?.length || 0,
      payloadSnapshotAssets: payload.snapshot?.assets?.length || 0,
      payloadItems: payload.items?.length || 0,
      pointVertices: packed.pointPositions.length / 2,
      lineVertices: packed.linePositions.length / 2,
      lineSegments: packed.linePositions.length / 4,
      fillVertices: packed.fillPositions.length / 2,
      fillTriangles: packed.fillIndices.length / 3,
      fillIndices: packed.fillIndices.length,
    },
    bytes: {
      sourceMsgpack: raw.byteLength,
      binary: binary.buffer.byteLength,
      ratioBinaryToSource: raw.byteLength ? roundMs(binary.buffer.byteLength / raw.byteLength) : null,
      formatted: {
        sourceMsgpack: formatBytes(raw.byteLength),
        binary: formatBytes(binary.buffer.byteLength),
      },
    },
    sections: binary.sections,
    timingsMs: timings,
    memoryMb: {
      rss: roundMs(process.memoryUsage().rss / 1024 / 1024),
      heapUsed: roundMs(process.memoryUsage().heapUsed / 1024 / 1024),
    },
    featureSamples: packed.featureSamples,
  };

  timings.totalBeforeWriteManifest = roundMs(performance.now() - totalStart);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeViewer(options.out);
  timeStep(timings, 'writeOutput', writeStart);
  timings.total = roundMs(performance.now() - totalStart);
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, timingsMs: timings }, null, 2)}\n`);

  console.log(JSON.stringify({
    outDir: path.relative(ROOT_DIR, options.out),
    sourceTile: path.relative(ROOT_DIR, tilePath),
    layerId: manifest.layerId,
    counts: manifest.counts,
    bytes: manifest.bytes.formatted,
    timingsMs: timings,
    memoryMb: manifest.memoryMb,
    viewerFile: path.relative(ROOT_DIR, path.join(options.out, 'index.html')),
  }, null, 2));

  if (options.serve) serveDir(options.out, options.port);
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
