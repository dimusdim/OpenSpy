import YahooFinance from 'yahoo-finance2';
import axios from 'axios';

interface OilQuote {
    price: number;
    change: number;
    changePercent: number;
    source: 'yahoo' | 'eia';
}

interface OilPricesData {
    brent: OilQuote;
    wti: OilQuote;
    spread: number;
    updatedAt: string;
}

export class OilPricesService {
    private data: OilPricesData | null = null;
    private interval: ReturnType<typeof setInterval> | null = null;
    private yf: InstanceType<typeof YahooFinance>;
    private eiaApiKey: string;

    constructor() {
        this.yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
        this.eiaApiKey = process.env.EIA_API_KEY ?? '';
    }

    async start(): Promise<void> {
        console.log('[OilPrices] Starting oil prices feed...');
        if (!this.eiaApiKey) {
            console.warn('[OilPrices] EIA_API_KEY not configured, using Yahoo Finance only');
        }
        await this.fetch();
        // Poll every 5 minutes
        this.interval = setInterval(() => this.fetch().catch(() => {}), 5 * 60 * 1000);
    }

    getPrices(): OilPricesData | null {
        return this.data;
    }

    private async fetchEIA(): Promise<{ brent?: number; wti?: number }> {
        if (!this.eiaApiKey) return {};

        try {
            const baseUrl = 'https://api.eia.gov/v2/petroleum/pri/spt/data/';
            const commonParams = `api_key=${this.eiaApiKey}&frequency=daily&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&length=1`;

            const [brentRes, wtiRes] = await Promise.all([
                axios.get(`${baseUrl}?${commonParams}&facets[series][]=RBRTE`, { timeout: 15_000 }),
                axios.get(`${baseUrl}?${commonParams}&facets[series][]=RWTC`, { timeout: 15_000 }),
            ]);

            const brentVal = brentRes.data?.response?.data?.[0]?.value;
            const wtiVal = wtiRes.data?.response?.data?.[0]?.value;

            const result: { brent?: number; wti?: number } = {};
            if (brentVal != null) result.brent = Number(brentVal);
            if (wtiVal != null) result.wti = Number(wtiVal);

            if (result.brent || result.wti) {
                console.log(`[OilPrices] EIA data: Brent=${result.brent ?? 'N/A'}, WTI=${result.wti ?? 'N/A'}`);
            }
            return result;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[OilPrices] EIA fetch failed: ${msg}`);
            return {};
        }
    }

    private async fetch(): Promise<void> {
        try {
            // Fetch from both sources in parallel
            const [yahooResult, eiaResult] = await Promise.allSettled([
                this.fetchYahoo(),
                this.fetchEIA(),
            ]);

            const yahoo = yahooResult.status === 'fulfilled' ? yahooResult.value : null;
            const eia = eiaResult.status === 'fulfilled' ? eiaResult.value : {};

            // EIA is authoritative when available; fall back to Yahoo
            const brent: OilQuote = {
                price: eia.brent ?? yahoo?.brent?.price ?? 0,
                change: yahoo?.brent?.change ?? 0,
                changePercent: yahoo?.brent?.changePercent ?? 0,
                source: eia.brent ? 'eia' : 'yahoo',
            };

            const wti: OilQuote = {
                price: eia.wti ?? yahoo?.wti?.price ?? 0,
                change: yahoo?.wti?.change ?? 0,
                changePercent: yahoo?.wti?.changePercent ?? 0,
                source: eia.wti ? 'eia' : 'yahoo',
            };

            this.data = {
                brent,
                wti,
                spread: +(brent.price - wti.price).toFixed(2),
                updatedAt: new Date().toISOString(),
            };

            console.log(`[OilPrices] Brent: $${brent.price.toFixed(2)} (${brent.source}), WTI: $${wti.price.toFixed(2)} (${wti.source}), Spread: $${this.data.spread}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[OilPrices] Failed to fetch: ${msg}`);
        }
    }

    private async fetchYahoo(): Promise<{ brent: Omit<OilQuote, 'source'>; wti: Omit<OilQuote, 'source'> }> {
        const quoteFn = (this.yf as any).quote.bind(this.yf);
        const [brentQuote, wtiQuote]: any[] = await Promise.all([
            quoteFn('BZ=F'),
            quoteFn('CL=F'),
        ]);

        return {
            brent: {
                price: brentQuote?.regularMarketPrice ?? 0,
                change: brentQuote?.regularMarketChange ?? 0,
                changePercent: brentQuote?.regularMarketChangePercent ?? 0,
            },
            wti: {
                price: wtiQuote?.regularMarketPrice ?? 0,
                change: wtiQuote?.regularMarketChange ?? 0,
                changePercent: wtiQuote?.regularMarketChangePercent ?? 0,
            },
        };
    }
}
