import axios from 'axios';

interface CountryEnergy {
    iso_code: string;
    country: string;
    year: number;
    population: number | null;
    oil_production: number | null;
    oil_consumption: number | null;
    fossil_fuel_consumption: number | null;
    energy_per_capita: number | null;
    coal_production: number | null;
    gas_production: number | null;
    renewables_share_energy: number | null;
    electricity_generation: number | null;
    carbon_intensity_elec: number | null;
    energy_import_dependency: number | null;  // World Bank EG.IMP.CONS.ZS (% of energy use)
}

export class EnergyService {
    private byIso: Map<string, CountryEnergy> = new Map();
    private allCountries: CountryEnergy[] = [];

    async start(): Promise<void> {
        console.log('[Energy] Fetching OWID energy data...');
        await this.fetch();
        console.log('[Energy] Fetching World Bank energy import dependency...');
        await this.fetchWorldBankImportDependency();
    }

    getCountryEnergy(isoCode: string): CountryEnergy | null {
        return this.byIso.get(isoCode.toUpperCase()) ?? null;
    }

    getAllCountries(): CountryEnergy[] {
        return this.allCountries;
    }

    private async fetch(): Promise<void> {
        const url = 'https://owid-public.owid.io/data/energy/owid-energy-data.csv';
        try {
            const { data } = await axios.get<string>(url, {
                timeout: 120_000,
                responseType: 'text',
            });

            const lines = data.split('\n');
            if (lines.length < 2) {
                console.warn('[Energy] CSV has no data rows');
                return;
            }

            const header = lines[0].split(',');
            const idx = (name: string) => header.indexOf(name);

            const isoIdx = idx('iso_code');
            const countryIdx = idx('country');
            const yearIdx = idx('year');
            const popIdx = idx('population');
            const oilProdIdx = idx('oil_production');
            const oilConsIdx = idx('oil_consumption');
            const fossilConsIdx = idx('fossil_fuel_consumption');
            const epcIdx = idx('energy_per_capita');
            const coalProdIdx = idx('coal_production');
            const gasProdIdx = idx('gas_production');
            const renewShareIdx = idx('renewables_share_energy');
            const elecGenIdx = idx('electricity_generation');
            const carbonIntIdx = idx('carbon_intensity_elec');

            if (isoIdx === -1 || countryIdx === -1 || yearIdx === -1) {
                console.warn('[Energy] CSV missing required columns (iso_code, country, year)');
                return;
            }

            // Parse all rows and keep latest year per iso_code
            const latest = new Map<string, CountryEnergy>();

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                if (!line || !line.trim()) continue;

                // Simple CSV parse — handle quoted fields
                const cols = this.parseCSVLine(line);

                const iso = cols[isoIdx]?.trim();
                const country = cols[countryIdx]?.trim();
                const year = parseInt(cols[yearIdx], 10);

                // Skip aggregates (no ISO code) and invalid years
                if (!iso || iso.length !== 3 || isNaN(year)) continue;

                const num = (i: number) => {
                    if (i === -1) return null;
                    const v = parseFloat(cols[i]);
                    return isNaN(v) ? null : v;
                };

                const record: CountryEnergy = {
                    iso_code: iso,
                    country: country || '',
                    year,
                    population: num(popIdx),
                    oil_production: num(oilProdIdx),
                    oil_consumption: num(oilConsIdx),
                    fossil_fuel_consumption: num(fossilConsIdx),
                    energy_per_capita: num(epcIdx),
                    coal_production: num(coalProdIdx),
                    gas_production: num(gasProdIdx),
                    renewables_share_energy: num(renewShareIdx),
                    electricity_generation: num(elecGenIdx),
                    carbon_intensity_elec: num(carbonIntIdx),
                    energy_import_dependency: null, // filled by World Bank data
                };

                const existing = latest.get(iso);
                if (!existing || existing.year < year) {
                    latest.set(iso, record);
                }
            }

            this.byIso = latest;
            this.allCountries = Array.from(latest.values());
            console.log(`[Energy] Loaded energy data for ${this.allCountries.length} countries`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Energy] Failed to fetch: ${msg}`);
        }
    }

    /**
     * Fetch World Bank energy import dependency indicator (EG.IMP.CONS.ZS)
     * and merge into existing OWID records by ISO-3 code.
     * World Bank uses ISO-3 country codes (same as OWID iso_code).
     */
    private async fetchWorldBankImportDependency(): Promise<void> {
        const url = 'https://api.worldbank.org/v2/country/all/indicator/EG.IMP.CONS.ZS?format=json&date=2020:2024&per_page=300';
        try {
            const { data } = await axios.get(url, { timeout: 30_000 });

            // World Bank JSON response: [pagination_meta, data_array]
            if (!Array.isArray(data) || data.length < 2 || !Array.isArray(data[1])) {
                console.warn('[Energy] World Bank response has unexpected format');
                return;
            }

            // Build a map: iso3 -> latest value
            const wbMap = new Map<string, number>();
            for (const entry of data[1]) {
                if (entry.value == null) continue;
                const iso = entry.countryiso3code as string;
                if (!iso || iso.length !== 3) continue;
                const year = parseInt(entry.date, 10);
                const existing = wbMap.get(iso);
                // Keep the value (we just want any non-null — prefer later years
                // by iterating in order; API returns newest first)
                if (existing === undefined) {
                    wbMap.set(iso, entry.value);
                }
            }

            // Merge into existing OWID records
            let merged = 0;
            for (const [iso, value] of wbMap) {
                const record = this.byIso.get(iso);
                if (record) {
                    record.energy_import_dependency = value;
                    merged++;
                }
            }

            console.log(`[Energy] World Bank energy import dependency: ${wbMap.size} countries fetched, ${merged} merged with OWID data`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Energy] World Bank fetch failed: ${msg}`);
        }
    }

    private parseCSVLine(line: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        result.push(current);
        return result;
    }
}
