import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

async function ensureMigrationsTable(pool: Pool) {
    await pool.query(`
        CREATE SCHEMA IF NOT EXISTS app;
        CREATE TABLE IF NOT EXISTS app.schema_migrations (
            version text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        );
    `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
    const result = await pool.query<{ version: string }>('SELECT version FROM app.schema_migrations');
    return new Set(result.rows.map(row => row.version));
}

export async function runMigrations(pool: Pool): Promise<string[]> {
    await ensureMigrationsTable(pool);

    const applied = await getAppliedMigrations(pool);
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(name => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b));

    const ran: string[] = [];
    for (const file of files) {
        if (applied.has(file)) continue;

        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query(
                'INSERT INTO app.schema_migrations (version) VALUES ($1)',
                [file],
            );
            await client.query('COMMIT');
            ran.push(file);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    return ran;
}

