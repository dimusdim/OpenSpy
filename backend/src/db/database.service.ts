import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { runMigrations } from './migrator';

type DatabaseHealthStatus = 'disabled' | 'streaming' | 'error';

export interface DatabaseHealth {
    status: DatabaseHealthStatus;
    note?: string;
    migrationsApplied?: number;
}

function envFlag(value: string | undefined): boolean {
    if (!value) return false;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export class DatabaseService {
    private pool: Pool | null = null;
    private ready = false;
    private health: DatabaseHealth = { status: 'disabled', note: 'DATABASE_URL not configured' };

    isEnabled(): boolean {
        return envFlag(process.env.POSTGRES_ENABLED) || Boolean(process.env.DATABASE_URL);
    }

    isReady(): boolean {
        return this.ready;
    }

    getHealth(): DatabaseHealth {
        return this.health;
    }

    async init(): Promise<void> {
        if (!this.isEnabled()) {
            this.health = { status: 'disabled', note: 'PostgreSQL disabled' };
            return;
        }

        if (this.pool) return;

        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            this.health = { status: 'error', note: 'POSTGRES_ENABLED=true but DATABASE_URL missing' };
            return;
        }

        try {
            this.pool = new Pool({
                connectionString,
                application_name: process.env.DB_APP_NAME || 'openspy-backend',
            });

            await this.pool.query('SELECT 1');
            const ran = await runMigrations(this.pool);
            const migrationCountResult = await this.pool.query<{ count: string }>(
                'SELECT COUNT(*)::text AS count FROM app.schema_migrations',
            );

            this.ready = true;
            this.health = {
                status: 'streaming',
                note: ran.length > 0 ? `Applied migrations: ${ran.join(', ')}` : 'Schema up to date',
                migrationsApplied: Number(migrationCountResult.rows[0]?.count || '0'),
            };
        } catch (error: any) {
            this.ready = false;
            this.health = {
                status: 'error',
                note: error?.message || 'Database init failed',
            };
            console.error('[database] init failed:', error);
        }
    }

    async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        params: unknown[] = [],
    ): Promise<QueryResult<T> | null> {
        if (!this.pool || !this.ready) return null;
        return this.pool.query<T>(text, params);
    }
}

export const databaseService = new DatabaseService();

