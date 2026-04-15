import 'dotenv/config';
import { databaseService } from './database.service';

async function main() {
    await databaseService.init();
    const health = databaseService.getHealth();
    console.log(JSON.stringify(health, null, 2));
    process.exit(health.status === 'streaming' ? 0 : 1);
}

main().catch((error) => {
    console.error('[db:migrate] failed:', error);
    process.exit(1);
});

