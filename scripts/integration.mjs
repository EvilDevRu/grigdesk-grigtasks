import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.GRIGTASKS_ROOT;
if (!root || !path.isAbsolute(root)) { throw new Error('GRIGTASKS_ROOT required (read-only source fixture)'); }
const { Pool } = createRequire(path.join(root, 'package.json'))('pg');
const name = 'grigdesk-driver-test-' + randomUUID();
const password = randomBytes(24).toString('hex');
let created = false;
let child;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { interrupted = true; child?.kill(signal); });
}

try {
  execFileSync('docker', ['run', '--detach', '--rm', '--name', name,
    '--label', 'grigdesk.driver-fixture=' + name, '--memory', '512m', '--cpus', '1',
    '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=grigtasks_test_admin',
    '-p', '127.0.0.1::5432', 'postgres:18-alpine'], { stdio: 'pipe' });
  created = true;
  const mapping = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim();
  const port = mapping.split(':').at(-1);
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/grigtasks_test_admin`;
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline && !interrupted) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1000, max: 1 });
    try { await pool.query('SELECT 1'); ready = true; break; }
    catch { await delay(250); }
    finally { await pool.end(); }
  }
  if (!ready) { throw new Error('test_postgres_not_ready'); }
  child = spawn('bash', ['scripts/test-safe.sh', 'tests/integration/real.test.mts'], {
    stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url, DATABASE_URL: '' },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  if (created) { execFileSync('docker', ['rm', '--force', '--volumes', name], { stdio: 'pipe' }); }
}
