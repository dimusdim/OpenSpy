import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import axios from 'axios';
import { SatelliteService } from './services/satellite.service';
import { SimulatorService } from './services/adsb.service';
import { ExtendedDataService } from './services/extended.service';
import { GPSJamService } from './services/gpsjam.service';
import { WebcamsService } from './services/webcams.service';
import { InfrastructureService } from './services/infrastructure.service';
import { IODAService } from './services/ioda.service';
import { OilPricesService } from './services/oilprices.service';
import { EnergyService } from './services/energy.service';
import { TomTomService } from './services/tomtom.service';
import { HereTrafficService } from './services/here.service';
import { ACLEDService } from './services/acled.service';
import { AirspaceService } from './services/airspace.service';
import { GFWService } from './services/gfw.service';
import { CloudflareService } from './services/cloudflare.service';
import { WindyService } from './services/windy.service';
import { Road511Service } from './services/road511.service';
import { NotamService } from './services/notam.service';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const satelliteService = new SatelliteService();
const simulatorService = new SimulatorService(io);
const extendedService = new ExtendedDataService();
const gpsJamService = new GPSJamService();
const webcamsService = new WebcamsService();
const infrastructureService = new InfrastructureService();
const iodaService = new IODAService();
const oilPricesService = new OilPricesService();
const energyService = new EnergyService();
const tomtomService = new TomTomService();
const hereTrafficService = new HereTrafficService();
const acledService = new ACLEDService();
const airspaceService = new AirspaceService();
const gfwService = new GFWService();
const cloudflareService = new CloudflareService();
const windyService = new WindyService();
const road511Service = new Road511Service();
const notamService = new NotamService();

app.get('/api/satellites', (req, res) => {
    res.json(satelliteService.getSatellites());
});

app.get('/api/satellites/recon', (req, res) => {
    res.json(satelliteService.getReconSatellites());
});

app.get('/api/osint', (req, res) => {
    res.json(simulatorService.getOsintEvents());
});

app.get('/api/cables', (_req, res) => {
    res.json(extendedService.getCables() ?? { type: 'FeatureCollection', features: [] });
});

app.get('/api/fires', (_req, res) => {
    res.json(extendedService.getFires());
});

app.get('/api/jamming', (_req, res) => {
    res.json(gpsJamService.getZones());
});

app.get('/api/webcams', (_req, res) => {
    res.json(webcamsService.getWebcams());
});

app.get('/api/outages', (_req, res) => {
    res.json(iodaService.getOutages());
});

// Critical infrastructure from OSM Overpass
app.get('/api/infrastructure', async (req, res) => {
    const bboxStr = req.query.bbox as string | undefined;
    if (!bboxStr) {
        res.status(400).json({ error: 'Missing bbox query parameter (south,west,north,east)' });
        return;
    }
    const parts = bboxStr.split(',').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({ error: 'Invalid bbox format. Expected: south,west,north,east' });
        return;
    }
    const [south, west, north, east] = parts;
    try {
        const data = await infrastructureService.getInfrastructure(south, west, north, east);
        res.json(data);
    } catch (err: any) {
        console.error('[Infrastructure] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch infrastructure data' });
    }
});

// Power infrastructure from OpenInfraMap
app.get('/api/power-infra', async (req, res) => {
    const bbox = req.query.bbox as string | undefined;
    if (!bbox) {
        res.status(400).json({ error: 'Missing bbox query parameter (west,south,east,north)' });
        return;
    }
    try {
        const data = await infrastructureService.getPowerInfra(bbox);
        res.json(data);
    } catch (err: any) {
        console.error('[PowerInfra] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch power infrastructure data' });
    }
});

// Oil & gas pipelines from OSM Overpass
app.get('/api/pipelines', async (_req, res) => {
    try {
        const data = await infrastructureService.getPipelines();
        res.json(data);
    } catch (err: any) {
        console.error('[Pipelines] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch pipeline data' });
    }
});

// Oil prices from Yahoo Finance
app.get('/api/oil-prices', (_req, res) => {
    res.json(oilPricesService.getPrices());
});

// OWID country energy data
app.get('/api/energy', (_req, res) => {
    res.json(energyService.getAllCountries());
});

app.get('/api/energy/:iso', (req, res) => {
    const data = energyService.getCountryEnergy(req.params.iso);
    if (!data) {
        res.status(404).json({ error: 'Country not found' });
        return;
    }
    res.json(data);
});

// Historical flight track from OpenSky Network
app.get('/api/track/:icao24', async (req, res) => {
    const { icao24 } = req.params;
    const time = req.query.time ? Number(req.query.time) : Math.floor(Date.now() / 1000);

    if (!icao24 || !/^[0-9a-fA-F]{6}$/.test(icao24)) {
        res.status(400).json({ error: 'Invalid ICAO24 hex code. Must be exactly 6 hex characters.' });
        return;
    }

    try {
        const url = `https://opensky-network.org/api/tracks/all?icao24=${icao24.toLowerCase()}&time=${time}`;
        console.log(`[Track] Fetching: ${url}`);
        const response = await axios.get(url, { timeout: 15000 });
        res.json(response.data);
    } catch (err: any) {
        const status = err.response?.status;
        if (status === 404) {
            console.warn(`[Track] No track found for icao24=${icao24}`);
            res.status(404).json({ error: 'No track found for this aircraft. It may not have been airborne recently.' });
        } else if (status === 429) {
            console.warn(`[Track] Rate limited by OpenSky`);
            res.status(429).json({ error: 'Rate limited by OpenSky Network. Try again in a few seconds.' });
        } else {
            console.error(`[Track] Error fetching track:`, err.message);
            res.status(status || 502).json({ error: 'Failed to fetch track from OpenSky Network.' });
        }
    }
});

// Proxy Planespotters photo API
app.get('/api/aircraft-photo/:icao24', async (req, res) => {
    const { icao24 } = req.params;
    try {
        const response = await axios.get(
            `https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(icao24)}`,
            { timeout: 10000 }
        );
        res.json(response.data);
    } catch {
        res.status(502).json({ error: 'Failed to fetch photo' });
    }
});

// Proxy OpenSky routes API (avoids CORS when called from browser)
app.get('/api/routes/:callsign', async (req, res) => {
    const { callsign } = req.params;
    try {
        const response = await axios.get(
            `https://opensky-network.org/api/routes?callsign=${encodeURIComponent(callsign.trim())}`,
            { timeout: 10000 }
        );
        res.json(response.data);
    } catch (err: any) {
        const status = err.response?.status || 502;
        res.status(status).json({ error: 'Failed to fetch route' });
    }
});

// TomTom Traffic Flow tiles (vector + raster proxy)
app.get('/api/traffic/tile/:z/:x/:y', (req, res) => {
    tomtomService.proxyVectorTile(req, res);
});
app.get('/api/traffic/raster/:z/:x/:y', (req, res) => {
    tomtomService.proxyRasterTile(req, res);
});

// ACLED armed conflict events
app.get('/api/conflicts', (_req, res) => {
    res.json(acledService.getEvents());
});

// OpenAIP restricted airspace / no-fly zones
app.get('/api/airspace', (_req, res) => {
    res.json(airspaceService.getZones());
});

// Global Fishing Watch dark vessel events
app.get('/api/gfw-events', (_req, res) => {
    res.json(gfwService.getEvents());
});

// Cloudflare Radar internet outages
app.get('/api/cloudflare-outages', (_req, res) => {
    res.json(cloudflareService.getOutages());
});

// HERE Traffic Flow v7
app.get('/api/here-traffic', async (req, res) => {
    const bbox = req.query.bbox as string | undefined;
    if (!bbox) {
        res.status(400).json({ error: 'Missing bbox query parameter (west,south,east,north)' });
        return;
    }
    const data = await hereTrafficService.getFlow(bbox);
    res.json(data);
});

// Windy Webcams — nearby cameras by lat/lng/radius
app.get('/api/windy-webcams', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radius = Number(req.query.radius) || 50;
    if (isNaN(lat) || isNaN(lng)) {
        res.status(400).json({ error: 'Missing or invalid lat/lng query parameters' });
        return;
    }
    try {
        const data = await windyService.getWebcams(lat, lng, radius);
        res.json(data);
    } catch (err: any) {
        console.error('[WindyWebcams] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch Windy webcams' });
    }
});

// Road511 US/Canada traffic cameras
app.get('/api/road511-cameras', async (_req, res) => {
    try {
        const data = await road511Service.getCameras();
        res.json(data);
    } catch (err: any) {
        console.error('[Road511] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch Road511 cameras' });
    }
});

// NASA DIP NOTAMs
app.get('/api/notams', async (_req, res) => {
    try {
        const data = await notamService.getNotams();
        res.json(data);
    } catch (err: any) {
        console.error('[NOTAMs] endpoint error:', err.message);
        res.status(502).json({ error: 'Failed to fetch NOTAMs' });
    }
});

async function bootstrap() {
    console.log('Initializing backend services...');
    await satelliteService.init();
    simulatorService.start();
    extendedService.start();
    gpsJamService.start();
    webcamsService.start();
    iodaService.start();
    oilPricesService.start();
    energyService.start();
    acledService.start();
    airspaceService.start();
    gfwService.start();
    cloudflareService.start();

    io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);
    });

    const PORT = process.env.PORT || 3055;
    server.listen(PORT, () => {
        console.log(`Backend server running on port ${PORT}`);
    });
}

bootstrap();
