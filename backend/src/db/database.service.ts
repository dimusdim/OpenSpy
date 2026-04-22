import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { AsyncLocalStorage } from 'async_hooks';
import { runMigrations } from './migrator';
import { recordDbQuery, withSpan } from '../telemetry/observability';

// Current transactional client for the running async context. withTransaction
// sets this before invoking the callback so nested this.database.query() calls
// route to the txn client instead of the pool. Without this pattern each query
// checks out a fresh connection and the BEGIN/COMMIT discipline is lost.
const txStorage = new AsyncLocalStorage<PoolClient>();

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
        const startedAt = performance.now();
        const txClient = txStorage.getStore();
        return withSpan('db.query', { 'db.query.params': params.length }, async () => {
            try {
                const result = txClient
                    ? await txClient.query<T>(text, params)
                    : await this.pool!.query<T>(text, params);
                recordDbQuery(text, performance.now() - startedAt, true, result.rowCount);
                return result;
            } catch (error) {
                recordDbQuery(text, performance.now() - startedAt, false, null);
                throw error;
            }
        });
    }

    // Run `fn` inside a single database transaction. Any this.database.query()
    // called from inside `fn` (at any async depth) reuses the same pg connection
    // and participates in the BEGIN/COMMIT. On throw the transaction is rolled
    // back and the original error is re-raised.
    //
    // Nested calls reuse the outer transaction (no savepoints) so scar-tissue
    // retry logic like loadLatestAssetHashes -> persist still sees a consistent
    // snapshot. If the DB is disabled or not ready, `fn` runs without a txn so
    // dev-mode bootstraps that skip Postgres still work.
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
        if (!this.pool || !this.ready) return fn();
        if (txStorage.getStore()) return fn();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await txStorage.run(client, fn);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch { /* swallow secondary failure */ }
            throw error;
        } finally {
            client.release();
        }
    }
}

export const databaseService = new DatabaseService();
