import * as Cesium from 'cesium';
import { API_URL } from './config';
import { useTimelineStore, type ImageryOverlayContext } from '../store/useTimelineStore';

let openSpyImageryLayers: Cesium.ImageryLayer[] = [];

type Bbox = [number, number, number, number];
type BboxOrder = 'west,south,east,north' | 'south,west,north,east';

function normalizeGibsLayerName(value: any): string {
    const key = String(value || '').trim();
    const normalized = key.toLowerCase().replace(/[\s-]+/g, '_');
    const aliases: Record<string, string> = {
        modis: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        modis_true_color: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        terra_true_color: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        true_color: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        aqua_true_color: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
        viirs: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
        viirs_true_color: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
        viirs_noaa20_true_color: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
        viirs_noaa21_true_color: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
    };
    return aliases[normalized] || key || 'MODIS_Terra_CorrectedReflectance_TrueColor';
}

function normalizeBboxOrder(order?: string | null): BboxOrder {
    const normalized = String(order || 'west,south,east,north').toLowerCase();
    if (normalized === 'west,south,east,north' || normalized.includes('west,south,east,north')) return 'west,south,east,north';
    if (normalized === 'south,west,north,east' || normalized.includes('south,west,north,east')) return 'south,west,north,east';
    throw new Error(`Unsupported imagery bbox_order: ${order}`);
}

function normalizeBboxToOpenSpy(raw: any, order?: string | null): Bbox | null {
    const bbox = Array.isArray(raw) ? raw.map(Number) as Bbox : null;
    if (!bbox || bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
        return null;
    }
    const normalizedOrder = normalizeBboxOrder(order);
    const [a, b, c, d] = bbox;
    return normalizedOrder === 'west,south,east,north'
        ? [a, b, c, d]
        : [b, a, d, c];
}

function bboxToRectangle(raw: any, order?: string | null): Cesium.Rectangle {
    const bbox = normalizeBboxToOpenSpy(raw, order);
    if (!bbox) return Cesium.Rectangle.MAX_VALUE;
    const [west, south, east, north] = bbox;
    return Cesium.Rectangle.fromDegrees(west, south, east, north);
}

function imageryRenderSizeForBbox([west, south, east, north]: Bbox, maxPixels = 768): { width: number; height: number } {
    const latSpan = Math.max(0.0001, Math.abs(north - south));
    const lngSpan = Math.max(0.0001, Math.abs(east - west));
    const midLatRad = ((north + south) / 2) * Math.PI / 180;
    const widthAtLat = Math.max(0.0001, lngSpan * Math.max(0.2, Math.cos(midLatRad)));
    const aspect = Math.max(0.25, Math.min(4, widthAtLat / latSpan));
    const longSide = Math.max(128, Math.min(maxPixels, 1024));
    if (aspect >= 1) {
        return { width: longSide, height: Math.max(128, Math.round(longSide / aspect)) };
    }
    return { width: Math.max(128, Math.round(longSide * aspect)), height: longSide };
}

function explicitBoolean(value: unknown): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function imageryPayloadSwitchesBase(payload: Record<string, unknown>): boolean {
    const scene = payload.scene && typeof payload.scene === 'object'
        ? payload.scene as Record<string, unknown>
        : null;
    return explicitBoolean(payload.switchBase)
        || explicitBoolean(payload.switch_base)
        || explicitBoolean(scene?.switchBase)
        || explicitBoolean(scene?.switch_base);
}

function applyImageryDisplayOptions(viewer: Cesium.Viewer, payload: Record<string, unknown>) {
    if (!imageryPayloadSwitchesBase(payload)) return;
    const store = useTimelineStore.getState();
    if (store.tileMode !== 'modis') store.setTileMode('modis');
    if (viewer.scene?.globe) viewer.scene.globe.show = true;
}

function sourceLabel(source: string): string {
    if (/firms|fire/.test(source)) return 'NASA FIRMS';
    if (/landsat|usgs/.test(source)) return 'USGS Landsat';
    if (/copernicus|sentinel/.test(source)) return 'Copernicus Sentinel';
    if (/(gibs|nasa|worldview)/.test(source)) return 'NASA GIBS';
    return source || 'Satellite imagery';
}

function extractImageryDate(payload: Record<string, any>): Date {
    const scene = payload.scene && typeof payload.scene === 'object' ? payload.scene : null;
    const value = payload.time
        || payload.at
        || payload.date
        || scene?.datetime
        || scene?.date
        || payload.from
        || payload.to
        || scene?.render?.from
        || scene?.render?.to
        || Date.now() - 86_400_000;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return new Date(Date.now() - 86_400_000);
    return date;
}

function buildImageryContext(payload: Record<string, any>, source: string): ImageryOverlayContext {
    const scene = payload.scene && typeof payload.scene === 'object' ? payload.scene : null;
    const date = extractImageryDate(payload);
    const acquisitionTime = date.toISOString();
    const layer = String(
        payload.layer
        || payload.gibsLayer
        || payload.gibs_layer
        || scene?.collection
        || scene?.layer_id
        || scene?.requested_layer
        || scene?.render?.layer
        || '',
    ) || null;
    const mode = payload.mode === 'compare' || payload.before || payload.after ? 'compare' : 'single';
    const provider = sourceLabel(source);
    const acquisitionLabel = acquisitionTime.slice(0, 10);
    const label = [
        provider,
        mode === 'compare' ? 'comparison' : null,
        acquisitionLabel,
        layer,
    ].filter(Boolean).join(' · ');
    const rawBbox = Array.isArray(payload.bbox)
        ? payload.bbox.map(Number).filter((value: number) => Number.isFinite(value)).slice(0, 4)
        : Array.isArray(scene?.bbox)
            ? scene.bbox.map(Number).filter((value: number) => Number.isFinite(value)).slice(0, 4)
            : null;
    const bboxOrder = payload.bbox_order || scene?.bbox_order || scene?.render?.bbox_order || 'west,south,east,north';
    const bbox = rawBbox && rawBbox.length === 4
        ? normalizeBboxToOpenSpy(rawBbox, bboxOrder)
        : null;
    const opacity = Number(payload.opacity ?? payload.alpha);
    const timeline = useTimelineStore.getState();
    return {
        id: `imagery:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        mode,
        source: provider,
        label,
        layer,
        acquisitionTime,
        acquisitionLabel,
        opacity: Number.isFinite(opacity) ? opacity : null,
        bbox,
        replayLinked: false,
        replayTimeAtShow: timeline.currentTime?.toISOString?.() || null,
        shownAt: new Date().toISOString(),
        note: 'This imagery is a date-addressed context overlay. Replay seek/playback changes vector layers, but it does not retime this imagery layer.',
    };
}

export function clearOpenSpyImageryLayers(viewer: Cesium.Viewer): void {
    const layers = viewer.imageryLayers;
    for (const layer of openSpyImageryLayers) {
        try {
            if (layers?.contains?.(layer)) layers.remove(layer, true);
        } catch {
            // Cesium can throw if the viewer is being torn down. The next
            // assignment clears our handle set either way.
        }
    }
    openSpyImageryLayers = [];
    useTimelineStore.getState().setActiveImageryOverlay(null);
}

function showGibsImageryLayer(viewer: Cesium.Viewer, payload: Record<string, any>): void {
    const scene = payload.scene && typeof payload.scene === 'object' ? payload.scene : null;
    const layerName = normalizeGibsLayerName(
        payload.gibsLayer
        || payload.gibs_layer
        || scene?.layer_id
        || scene?.gibsLayer
        || payload.layer
        || payload.product
        || scene?.requested_layer,
    );
    const date = new Date(payload.time || payload.at || payload.date || scene?.date || Date.now() - 86400_000);
    if (Number.isNaN(date.getTime())) throw new Error('imagery.show_layer requires a valid date/time');
    const time = date.toISOString().slice(0, 10);
    const opacity = Number(payload.opacity ?? payload.alpha ?? 0.65);
    const normalizedBbox = normalizeBboxToOpenSpy(
        payload.bbox || scene?.bbox || scene?.coverage?.bbox,
        payload.bbox_order || scene?.bbox_order || scene?.coverage?.bbox_order || 'west,south,east,north',
    );

    if (!viewer.imageryLayers?.addImageryProvider) {
        return;
    }

    if (normalizedBbox) {
        const [west, south, east, north] = normalizedBbox;
        const renderSize = imageryRenderSizeForBbox(
            normalizedBbox,
            Number(payload.maxPixels || payload.max_pixels || 1024),
        );
        const params = new URLSearchParams({
            SERVICE: 'WMS',
            VERSION: '1.1.1',
            REQUEST: 'GetMap',
            LAYERS: layerName,
            STYLES: '',
            FORMAT: 'image/png',
            TRANSPARENT: 'true',
            BBOX: `${west},${south},${east},${north}`,
            SRS: 'EPSG:4326',
            WIDTH: String(renderSize.width),
            HEIGHT: String(renderSize.height),
            TIME: time,
        });
        const provider = new Cesium.SingleTileImageryProvider({
            url: `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${params.toString()}`,
            rectangle: bboxToRectangle(normalizedBbox, 'west,south,east,north'),
            tileWidth: renderSize.width,
            tileHeight: renderSize.height,
            credit: `NASA GIBS ${layerName}`,
        });
        const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
        imageryLayer.alpha = Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 0.65;
        openSpyImageryLayers.push(imageryLayer);
        return;
    }

    const provider = new Cesium.WebMapTileServiceImageryProvider({
        url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layerName}/default/${time}/GoogleMapsCompatible_Level9/{TileMatrix}/{TileRow}/{TileCol}.jpg`,
        layer: layerName,
        style: 'default',
        tileMatrixSetID: 'GoogleMapsCompatible_Level9',
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        tileWidth: 256,
        tileHeight: 256,
        maximumLevel: 9,
        format: 'image/jpeg',
        credit: `NASA GIBS ${layerName}`,
    });
    const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    imageryLayer.alpha = Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 0.65;
    openSpyImageryLayers.push(imageryLayer);
}

function showCopernicusImageryLayer(viewer: Cesium.Viewer, payload: Record<string, any>): void {
    const scene = payload.scene && typeof payload.scene === 'object' ? payload.scene : null;
    const bbox = payload.bbox || scene?.bbox || scene?.render?.bbox;
    const bboxOrder = payload.bbox_order || scene?.bbox_order || scene?.render?.bbox_order || 'west,south,east,north';
    const normalizedBbox = normalizeBboxToOpenSpy(bbox, bboxOrder);
    if (!normalizedBbox) {
        throw new Error('Copernicus imagery requires a bounded scene bbox');
    }
    const rectangle = bboxToRectangle(normalizedBbox, 'west,south,east,north');
    const renderSize = imageryRenderSizeForBbox(normalizedBbox, Number(payload.maxPixels || payload.max_pixels || 768));
    const params = new URLSearchParams({
        bbox: normalizedBbox.join(','),
        from: String(payload.from || scene?.render?.from || scene?.datetime || new Date(Date.now() - 86_400_000).toISOString()),
        to: String(payload.to || scene?.render?.to || scene?.datetime || new Date().toISOString()),
        collection: String(payload.collection || scene?.render?.collection || scene?.collection || 'sentinel-2-l2a'),
        layer: String(payload.layer || scene?.render?.layer || 'true_color'),
        maxCloudCover: String(payload.maxCloudCover ?? scene?.render?.maxCloudCover ?? 40),
        width: String(payload.width || renderSize.width),
        height: String(payload.height || renderSize.height),
    });
    const opacity = Number(payload.opacity ?? payload.alpha ?? 0.72);
    const provider = new Cesium.SingleTileImageryProvider({
        url: `${API_URL}/api/imagery/copernicus/render?${params.toString()}`,
        rectangle,
        tileWidth: Number(params.get('width') || 768),
        tileHeight: Number(params.get('height') || 768),
        credit: 'Copernicus Data Space / Sentinel Hub',
    });
    const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    imageryLayer.alpha = Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 0.72;
    openSpyImageryLayers.push(imageryLayer);
}

function showLandsatImageryLayer(viewer: Cesium.Viewer, payload: Record<string, any>): void {
    const scene = payload.scene && typeof payload.scene === 'object' ? payload.scene : null;
    const imageUrl = payload.thumbnail_url
        || payload.thumbnailUrl
        || scene?.thumbnail_url
        || scene?.assets?.reduced_resolution_browse
        || scene?.assets?.thumbnail;
    const bbox = payload.bbox || scene?.bbox;
    const bboxOrder = payload.bbox_order || scene?.bbox_order || 'west,south,east,north';
    const normalizedBbox = normalizeBboxToOpenSpy(bbox, bboxOrder);
    if (!imageUrl || !normalizedBbox) {
        throw new Error('Landsat imagery requires a browse/thumbnail URL and bounded scene bbox');
    }
    const opacity = Number(payload.opacity ?? payload.alpha ?? 0.72);
    const renderSize = imageryRenderSizeForBbox(normalizedBbox, Number(payload.maxPixels || payload.max_pixels || 1024));
    const provider = new Cesium.SingleTileImageryProvider({
        url: String(imageUrl),
        rectangle: bboxToRectangle(normalizedBbox, 'west,south,east,north'),
        tileWidth: Number(payload.width || renderSize.width),
        tileHeight: Number(payload.height || renderSize.height),
        credit: 'USGS Landsat',
    });
    const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    imageryLayer.alpha = Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 0.72;
    openSpyImageryLayers.push(imageryLayer);
}

function normalizeFirmsLayerName(value: any): string {
    const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases: Record<string, string> = {
        viirs: 'fires_viirs_24',
        viirs_24: 'fires_viirs_24',
        fires_viirs_24: 'fires_viirs_24',
        fires_viirs_48: 'fires_viirs_48',
        fires_viirs_72: 'fires_viirs_72',
        fires_viirs_7: 'fires_viirs_7',
        modis: 'fires_modis_24',
        modis_24: 'fires_modis_24',
        fires_modis_24: 'fires_modis_24',
        fires_modis_48: 'fires_modis_48',
        fires_modis_72: 'fires_modis_72',
        fires_modis_7: 'fires_modis_7',
        landsat: 'fires_landsat_24',
        fires_landsat_24: 'fires_landsat_24',
        tsd_viirs: 'tsd_4_viirs_all',
        tsd_4_viirs_all: 'tsd_4_viirs_all',
        tsd_modis: 'tsd_4_modis_all',
        tsd_4_modis_all: 'tsd_4_modis_all',
    };
    if (aliases[key]) return aliases[key];
    if (/^(fires|tsd)_/.test(key)) return key;
    return 'fires_viirs_24';
}

function showFirmsImageryLayer(viewer: Cesium.Viewer, payload: Record<string, any>): void {
    const scene = payload.scene && typeof payload.scene === 'object' ? payload.scene : null;
    const layer = normalizeFirmsLayerName(payload.wmsLayer || payload.wms_layer || payload.layer || scene?.layer);
    const opacity = Number(payload.opacity ?? payload.alpha ?? 0.72);
    const time = payload.time || payload.date || scene?.time || scene?.date || null;
    const provider = new Cesium.WebMapServiceImageryProvider({
        url: `${API_URL}/api/imagery/firms/wms`,
        layers: layer,
        parameters: {
            service: 'WMS',
            request: 'GetMap',
            version: '1.1.1',
            format: 'image/png',
            transparent: true,
            styles: '',
            ...(time ? { time: String(time) } : {}),
        },
        tilingScheme: new Cesium.GeographicTilingScheme(),
        enablePickFeatures: false,
        credit: 'NASA FIRMS',
    });
    const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    imageryLayer.alpha = Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 0.72;
    openSpyImageryLayers.push(imageryLayer);
}

export function showOpenSpyImageryLayer(viewer: Cesium.Viewer, payload: Record<string, any>): void {
    const scene = payload.scene && typeof payload.scene === 'object' ? payload.scene : null;
    const source = String(payload.source || payload.provider || scene?.source || 'nasa_gibs').toLowerCase();
    const shouldReplace = payload.replace !== false && payload.mode !== 'compare';
    if (shouldReplace) clearOpenSpyImageryLayers(viewer);
    if (/firms|fire/.test(source)) {
        showFirmsImageryLayer(viewer, payload);
    } else if (/landsat|usgs/.test(source)) {
        showLandsatImageryLayer(viewer, payload);
    } else if (/copernicus|sentinel/.test(source)) {
        showCopernicusImageryLayer(viewer, payload);
    } else if (/(gibs|nasa|worldview)/.test(source)) {
        showGibsImageryLayer(viewer, payload);
    } else {
        throw new Error(`Unsupported imagery source: ${source}`);
    }
    applyImageryDisplayOptions(viewer, payload);
    useTimelineStore.getState().setActiveImageryOverlay(buildImageryContext(payload, source));
    viewer.scene.requestRender();
}

export function showOpenSpyImageryCompare(viewer: Cesium.Viewer, payload: Record<string, any>): void {
    const before = payload.before && typeof payload.before === 'object' ? payload.before : null;
    const after = payload.after && typeof payload.after === 'object' ? payload.after : null;
    const switchBase = imageryPayloadSwitchesBase(payload) ? { switchBase: true } : {};
    if (before) showOpenSpyImageryLayer(viewer, { ...before, ...switchBase, replace: true, opacity: before.opacity ?? 0.45 });
    if (after) showOpenSpyImageryLayer(viewer, { ...after, ...switchBase, replace: false, mode: 'compare', opacity: after.opacity ?? payload.opacity ?? 0.65 });
    if (!before && !after) showOpenSpyImageryLayer(viewer, { ...payload, mode: 'compare' });
}
