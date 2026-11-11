import assert from 'node:assert/strict';
import test from 'node:test';
import createDriver from '../driver.ts';
import { Client } from '../src/client.ts';
import { executeMutation, prepareMutation } from '../src/write.ts';
import { epoch, me, nativeTask, protocol } from './helpers/protocol.mts';

test('TRANSPORT: credentials/body/epoch are frozen across 503 retry and receipt404', async () => {
  let count = 0;
  let f: ReturnType<typeof protocol>;
  const input = { title: 'Original', groupId: 7, responsibleId: 2 };
  f = protocol(({ init, url }) => {
    if (url.pathname.startsWith('/api/v1/operations/')) {
      return Response.json({ error: 'operation_not_found' }, { status: 404 });
    }
    if (init.method === 'POST') {
      count += 1;
      f.credentials({ baseUrl: 'https://other.example', apiToken: 'another-token' });
      input.title = 'Late change';
      if (count === 1) { return Response.json({ error: 'unavailable' }, { status: 503 }); }
      return nativeTask;
    }
  });
  const driver = createDriver(f.host);
  await driver.createTask!(input);
  const writes = f.calls.filter((call) => call.init.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].init.body, writes[1].init.body);
  assert.equal(JSON.parse(String(writes[0].init.body)).title, 'Original');
  for (const call of f.calls) {
    assert.equal(call.url.origin, 'https://tasks.example');
    assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer secret-token');
    assert.equal(call.init.redirect, 'error');
    if (call.url.pathname !== '/api/v1/me') {
      assert.equal(new Headers(call.init.headers).get('X-Expected-User-Id'), '1');
      assert.equal(new Headers(call.init.headers).get('X-Expected-Installation-Id'), me.installation.id);
    }
  }
  assert.equal(new Headers(writes[1].init.headers).get('X-Sync-Epoch'), epoch);
});

test('TRANSPORT: invalid JSON/redirect never look successful; exact404 and forbidden receipt terminal', async () => {
  for (const response of [new Response('bad JSON'), new Response(null, { status: 302,
    headers: { Location: 'https://other.example' } })]) {
    const f = protocol(() => response.clone());
    assert.equal((await createDriver(f.host).testAuth()).ok, false);
  }
  for (const status of [401, 403, 404, 409, 422]) {
    let writes = 0;
    const prepared = prepareMutation('POST', '/api/v1/tasks', {}, null, epoch);
    await assert.rejects(executeMutation(async () => {
      writes += 1;
      return { status, body: { error: 'server_error', message: 'secret-token' } };
    }, prepared), (error: any) => !error.message.includes('secret-token'));
    assert.equal(writes, 1);
  }
});

test('TRANSPORT: only operation_not_found is missing; malformed receipt is not success', async () => {
  for (const body of [{ error: 'not_found' }, { status: 200 }, { status: 500, body: {} }, null]) {
    let count = 0;
    const prepared = prepareMutation('PATCH', '/api/v1/tasks/81', {}, '7', epoch);
    await assert.rejects(executeMutation(async (method) => {
      if (method !== 'GET') { count += 1; throw new Error('lost'); }
      return { status: body && 'error' in body ? 404 : 200, body };
    }, prepared));
    assert.equal(count, 1);
  }
});

test('TRANSPORT: read cancellation reaches host.fetch and never turns into an empty list', async () => {
  const abort = new AbortController();
  const f = protocol();
  f.host.fetch = async (_url, init) => {
    abort.abort();
    init!.signal!.throwIfAborted();
    return Response.json({});
  };
  await assert.rejects(createDriver(f.host).listTasks({ signal: abort.signal }));
});

test('TRANSPORT: exhausted60s budget sends no further network requests', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let writes = 0;
  const f = protocol(({ init }) => {
    if (init.method === 'POST') {
      writes += 1;
      t.mock.timers.tick(60_001);
      return Response.json({ error: 'unavailable' }, { status: 503 });
    }
  });
  await assert.rejects(createDriver(f.host).createTask!({ groupId: 7, title: 'Budget' }), {
    code: 'operation_unknown',
  });
  assert.equal(writes, 1);
});

test('PAGINATION: repeated cursor fails without partial success, escaped cursor stays on same origin', async () => {
  const f = protocol(({ url }) => url.pathname === '/api/v1/tasks'
    ? { items: [nativeTask], nextCursor: '//other.example/?secret=yes' } : undefined);
  await assert.rejects(createDriver(f.host).listTasks(), { code: 'invalid_cursor' });
  assert.ok(f.calls.every((call) => call.url.origin === 'https://tasks.example'));
  assert.ok(f.calls[1].url.search.includes('%2F%2Fother.example'));
});

test('RESTORE: sync_reset_required terminates with original key/epoch and UUID in safe message', async () => {
  const f = protocol(({ init }) => init.method === 'PATCH'
    ? Response.json({ error: 'sync_reset_required' }, { status: 409 }) : undefined);
  await assert.rejects(createDriver(f.host).updateTask!('81', { title: 'Before restore' }), (error: any) => {
    const write = f.calls.find((call) => call.init.method === 'PATCH')!;
    assert.equal(new Headers(write.init.headers).get('X-Sync-Epoch'), epoch);
    assert.ok(error.message.includes(new Headers(write.init.headers).get('Idempotency-Key')));
    return error.code === 'tracker_request_failed';
  });
  assert.equal(f.calls.filter((call) => call.url.pathname === '/api/v1/me').length, 1);
  assert.equal(f.calls.filter((call) => call.init.method === 'PATCH').length, 1);
});

test('RETRY:429 respects Retry-After and normal retries use backoff', async () => {
  let writes = 0;
  const times: number[] = [];
  const prepared = prepareMutation('POST', '/api/v1/tasks', {}, null, epoch);
  const result = await executeMutation(async (method) => {
    if (method === 'GET') { return { status: 404, body: { error: 'operation_not_found' } }; }
    times.push(performance.now());
    writes += 1;
    return { status: writes === 1 ? 503 : 201, body: {} };
  }, prepared);
  assert.equal(result.status, 201);
  assert.ok(times[1] - times[0] >= 75, 'retry must have backoff');

  const f = protocol(({ init }) => init.method === 'POST'
    ? Response.json({}, { status: 429, headers: { 'Retry-After': '1' } }) : undefined);
  const client = new Client(f.host, {}, true);
  await client.request('POST', '/api/v1/tasks', {}, '{}');
  const started = performance.now();
  await client.get('/api/v1/me');
  assert.ok(performance.now() - started >= 900, 'Retry-After must delay next request');
});
