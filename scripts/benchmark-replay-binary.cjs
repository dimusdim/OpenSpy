#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT_DIR = path.resolve(__dirname, '..');
const TILE_ROOT = path.join(ROOT_DIR, 'backend/var/replay-tiles');
const DEFAULT_OUT_DIR = path.join(ROOT_DIR, '.local/replay-binary-benchmark');
const DEFAULT_AT = '2026-04-24T21:40:00.000Z';

function parseArgs(argv) {
  const options = {
    at: DEFAULT_AT,
    out: DEFAULT_OUT_DIR,
    port: 0,
    headed: true,
    browser: true,
    layers: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--at') options.at = next();
    else if (arg === '--out') options.out = path.resolve(next());
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--layers') options.layers = next().split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--no-browser') options.browser = false;
    else if (arg === '--headless') options.headed = false;
    else if (arg === '--headed') options.headed = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  console.log(`
Build prototype binary payloads for replay layers and optionally benchmark them in Chrome.

Usage:
  node scripts/benchmark-replay-binary.cjs --at 2026-04-24T21:40:00.000Z

Options:
  --at <iso>          Replay timestamp. Default ${DEFAULT_AT}
  --layers <a,b,c>    Limit layers. Default: all replay tile dirs.
  --out <dir>         Output dir. Default .local/replay-binary-benchmark
  --headed            Browser benchmark in headed Chrome. Default.
  --headless          Browser benchmark in headless Chromium.
  --no-browser        Only build binaries, skip browser measurements.
  --port <n>          HTTP port for browser benchmark. Default: random free port.
`);
}

function bucketSeconds(layer) {
  if (layer === 'aircraft' || layer === 'vessel') return 10 * 60;
  if (layer === 'airspace' || layer === 'pipeline' || layer === 'cable') return 24 * 60 * 60;
  return 60 * 60;
}

function floorIsoToBucket(atIso, seconds) {
  const ms = seconds * 1000;
  return new Date(Math.floor(new Date(atIso).getTime() / ms) * ms).toISOString();
}

function bucketPrefix(iso) {
  return new Date(iso).toISOString().replace(/:/g, '-');
}

function formatBytes(bytes) {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function availableLayers() {
  return fs.readdirSync(TILE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function findTileForLayer(layer, atIso) {
  const bucketIso = floorIsoToBucket(atIso, bucketSeconds(layer));
  const dir = path.join(TILE_ROOT, layer, '0', '0', '0');
  const prefix = bucketPrefix(bucketIso);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.msgpack')).sort()
    : [];
  const match = files.find((name) => name.startsWith(prefix));
  return {
    layer,
    bucketIso,
    tilePath: match ? path.join(dir, match) : null,
    expectedPrefix: prefix,
    fileCount: files.length,
  };
}

function runPrototype(tilePath, outDir) {
  const startedAt = performance.now();
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, 'prototype-replay-binary.cjs'), '--tile', tilePath, '--out', outDir],
    {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `prototype failed for ${tilePath}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }

  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return {
    buildWallMs: roundMs(performance.now() - startedAt),
    manifest,
  };
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.bin')) return 'application/octet-stream';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function createServer(rootDir) {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(rootDir, `.${pathname}`);
    if (!target.startsWith(path.resolve(rootDir))) {
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
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function benchmarkBrowser(outDir, rows, options) {
  const { chromium } = require('playwright');
  const server = createServer(outDir);
  const port = await listen(server, options.port || 0);
  let browser;

  try {
    try {
      browser = await chromium.launch({ headless: !options.headed, channel: 'chrome' });
    } catch {
      browser = await chromium.launch({ headless: !options.headed });
    }

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let browserInfo = null;

    for (const row of rows) {
      if (!row.ok) continue;
      const startedAt = performance.now();
      await page.goto(`http://127.0.0.1:${port}/${row.layer}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const text = document.querySelector('#stats')?.textContent || '';
        return text.trim().startsWith('{') && text.includes('browserTimingsMs');
      }, { timeout: 30000 });
      const pageReadyMs = roundMs(performance.now() - startedAt);
      const stats = JSON.parse(await page.textContent('#stats'));
      row.browser = {
        pageReadyMs,
        ...stats.browserTimingsMs,
      };

      if (!browserInfo) {
        browserInfo = await page.evaluate(() => {
          const canvas = document.querySelector('#gl');
          const gl = canvas.getContext('webgl2');
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          return {
            userAgent: navigator.userAgent,
            webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
            webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            devicePixelRatio: window.devicePixelRatio,
          };
        });
      }
    }

    return { port, browserInfo };
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
  }
}

function rowFromBuild(layerInfo, buildResult) {
  const manifest = buildResult.manifest;
  return {
    layer: layerInfo.layer,
    ok: true,
    bucketIso: layerInfo.bucketIso,
    sourceTile: path.relative(ROOT_DIR, layerInfo.tilePath),
    outDir: path.relative(ROOT_DIR, path.dirname(path.join(layerInfo.tilePath, '..'))),
    counts: manifest.counts,
    bytes: manifest.bytes,
    build: {
      wallMs: buildResult.buildWallMs,
      ...manifest.timingsMs,
    },
    memoryMb: manifest.memoryMb,
  };
}

function writeSummary(outDir, summary) {
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const headers = [
    'layer',
    'features',
    'src',
    'bin',
    'build_total_ms',
    'pack_ms',
    'browser_ready_ms',
    'fetch_ms',
    'init_gl_ms',
    'views_ms',
    'upload_ms',
    'points',
    'lines',
    'triangles',
  ];
  const lines = [
    `# Replay Binary Benchmark`,
    ``,
    `at: \`${summary.at}\``,
    `browser: \`${summary.browserInfo?.webglRenderer || (summary.browser ? 'unknown' : 'skipped')}\``,
    ``,
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];

  for (const row of summary.rows) {
    if (!row.ok) {
      lines.push(`| ${row.layer} | missing | - | - | - | - | - | - | - | - | - | - | - |`);
      continue;
    }
    lines.push([
      row.layer,
      row.counts.outputFeatures,
      row.bytes.formatted.sourceMsgpack,
      row.bytes.formatted.binary,
      row.build.total,
      row.build.packTypedArrays,
      row.browser?.pageReadyMs ?? '-',
      row.browser?.fetchManifestAndBinary ?? '-',
      row.browser?.initWebGL ?? '-',
      row.browser?.createTypedArrayViews ?? row.browser?.parseViews ?? '-',
      row.browser?.uploadBuffers ?? '-',
      row.counts.pointVertices,
      row.counts.lineSegments,
      row.counts.fillTriangles,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  fs.writeFileSync(path.join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const layers = options.layers || availableLayers();
  fs.mkdirSync(options.out, { recursive: true });

  const rows = [];
  for (const layer of layers) {
    const layerInfo = findTileForLayer(layer, options.at);
    if (!layerInfo.tilePath) {
      rows.push({
        layer,
        ok: false,
        bucketIso: layerInfo.bucketIso,
        error: `No z0/0/0 tile matching ${layerInfo.expectedPrefix}`,
      });
      continue;
    }

    const layerOut = path.join(options.out, layer);
    const buildResult = runPrototype(layerInfo.tilePath, layerOut);
    const row = rowFromBuild(layerInfo, buildResult);
    row.outDir = path.relative(ROOT_DIR, layerOut);
    rows.push(row);
    console.log(`${layer}: build ${row.build.total}ms, bin ${row.bytes.formatted.binary}, features ${row.counts.outputFeatures}`);
  }

  let browserInfo = null;
  let browserPort = null;
  if (options.browser) {
    const browserResult = await benchmarkBrowser(options.out, rows, options);
    browserInfo = browserResult.browserInfo;
    browserPort = browserResult.port;
  }

  const summary = {
    at: options.at,
    generatedAt: new Date().toISOString(),
    outDir: path.relative(ROOT_DIR, options.out),
    browser: options.browser ? { headed: options.headed, temporaryPort: browserPort } : null,
    browserInfo,
    rows,
  };
  writeSummary(options.out, summary);

  console.log(JSON.stringify({
    at: summary.at,
    outDir: summary.outDir,
    browserInfo,
    rows: rows.map((row) => ({
      layer: row.layer,
      ok: row.ok,
      bucketIso: row.bucketIso,
      features: row.counts?.outputFeatures,
      source: row.bytes?.formatted?.sourceMsgpack,
      binary: row.bytes?.formatted?.binary,
      buildTotalMs: row.build?.total,
      packMs: row.build?.packTypedArrays,
      browser: row.browser,
      error: row.error,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
