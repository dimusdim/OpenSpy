import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';

function resolveMigrationsDir(): string {
    const candidates = [
        path.resolve(__dirname, 'migrations'),
        path.resolve(process.cwd(), 'dist/db/migrations'),
        path.resolve(process.cwd(), 'src/db/migrations'),
    ];
    const found = candidates.find((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
    if (!found) {
        throw new Error(`Migrations directory not found. Checked: ${candidates.join(', ')}`);
    }
    return found;
}

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
    const migrationsDir = resolveMigrationsDir();
    const files = fs.readdirSync(migrationsDir)
        .filter(name => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b));

    const ran: string[] = [];
    for (const file of files) {
        if (applied.has(file)) continue;

        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
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
