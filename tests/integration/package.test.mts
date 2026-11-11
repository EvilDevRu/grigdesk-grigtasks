import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('PACKAGED RUNTIME: tarball runs with no source checkouts, dev dependencies or network', async (t) => {
  const tarball = process.env.GRIGDESK_DRIVER_TARBALL;
  assert.ok(tarball && path.isAbsolute(tarball), 'GRIGDESK_DRIVER_TARBALL required');
  const temporary = await mkdtemp(path.join(tmpdir(), 'grigdesk-driver-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  execFileSync('tar', ['-xzf', tarball, '-C', temporary]);
  const directory = path.join(temporary, 'package');
  const files = await readdir(directory);
  assert.equal(files.includes('node_modules'), false);
  assert.equal(files.includes('tests'), false);
  assert.equal(files.includes('scripts'), false);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import createDriver from './driver.ts';
    const host = {
      credentials: { read: () => ({ baseUrl: 'https://tasks.example', apiToken: 'fixture-token' }) },
      fetch: async (url, init) => {
        assert.equal(url, 'https://tasks.example/api/v1/me');
        assert.equal(init.redirect, 'error');
        return Response.json({ user: { id: '42' }, installation: {
          id: '77a2f654-39e0-4aa8-8e85-fbd1d43c23a0',
          syncEpoch: '5548c827-de54-411f-8de3-d1822f41efc2', webUrl: null,
        } });
      },
    };
    const driver = createDriver(host);
    assert.equal(driver.id, 'grigdesk-tasks');
    assert.equal(driver.isConfigured(), true);
    assert.equal(driver.capabilities.attachments, false);
    assert.equal(driver.capabilities.timer, false);
    assert.equal(driver.capabilities.widgets, false);
    assert.deepEqual(await driver.testAuth(), { ok: true, userId: 42 });
    assert.equal((await driver.accountIdentity()).userId,
      '77a2f654-39e0-4aa8-8e85-fbd1d43c23a0:5548c827-de54-411f-8de3-d1822f41efc2:42');
    assert.equal(await driver.sourceUrl('81'), '');
    console.log('standalone runtime passed');
  `], { cwd: directory, env: { PATH: process.env.PATH, NODE_OPTIONS: '--max-old-space-size=128' },
    encoding: 'utf8', timeout: 10_000 });
  assert.match(result, /standalone runtime passed/u);
});
