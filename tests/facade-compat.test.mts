import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { core, facadeFixture } from './helpers/grigdesk.mts';
import { me, nativeTask, protocol } from './helpers/protocol.mts';

test('FACADE-READ: installed registry package and existing HTTP/DTO decoders', async (t) => {
  const f = protocol();
  const host = await facadeFixture(t, f.host);
  const decoders = await core('web/src/shared/boardContracts.ts');
  const auth = await host.registry.testAuth('grigdesk-tasks');
  assert.deepEqual(auth, { ok: true, userId: 1 });
  const response = await host.app.inject('/api/tracker/task/81');
  assert.equal(response.statusCode, 200, response.body);
  const detail = decoders.decodeTaskDetail(response.json());
  assert.equal(detail.status, 4);
  assert.equal(detail.responsible.id, '2');
  assert.deepEqual(detail.checklist.map((row: any) => row.parentId), ['0', '41']);
  const dashboard = await host.app.inject('/api/tracker/dashboard');
  assert.equal(dashboard.statusCode, 200, dashboard.body);
  const board = decoders.decodeBoardDashboard(dashboard.json());
  assert.equal(board.tasks[0].responsible, 'Bob');
  assert.equal(board.capabilities.attachments, false);
  assert.equal(decoders.decodeBoardNamedItems((await host.app.inject('/api/tracker/users')).json(),
    'users')[0].id, '1');
  assert.equal(decoders.decodeBoardNamedItems((await host.app.inject('/api/tracker/groups')).json(),
    'groups')[0].id, '7');
  const page = await host.app.inject('/api/tracker/task/81/comments');
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(decoders.decodeTaskComments(page.json())[0].text, 'Hello');
  assert.deepEqual(decoders.decodeTaskTags(page.json()), ['Release']);
  assert.equal(host.registry.activeIds.includes('own'), true);
});

test('FACADE-ERROR: external error maps400/404/502, safe unknown UUID survives HTTP', async (t) => {
  let mode = 'immutable';
  const f = protocol(({ url, init }) => {
    if (url.pathname === '/api/v1/tasks/81' && init.method === 'PATCH') {
      return mode === 'unknown' ? Response.json({ error: 'internal_error' }, { status: 503 })
        : mode === 'missing' ? Response.json({ error: 'task_not_found' }, { status: 404 })
          : Response.json({ error: 'project_immutable', message: 'secret-token' }, { status: 422 });
    }
    if (url.pathname.startsWith('/api/v1/operations/')) {
      return Response.json({ error: 'operation_not_found' }, { status: 404 });
    }
  });
  const { app } = await facadeFixture(t, f.host);
  const request = () => app.inject({ method: 'PUT', url: '/api/tracker/task/81', payload: { title: 'Edit' } });
  const invalid = await request();
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'b24_bad_request');
  assert.equal(invalid.body.includes('secret-token'), false);
  mode = 'missing';
  const missing = await request();
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'task_not_found');
  mode = 'unknown';
  const unknown = await request();
  assert.equal(unknown.statusCode, 502);
  assert.equal(unknown.json().error, 'tracker_error');
  assert.match(unknown.json().message, /Результат неизвестен; проверьте операцию в трекере перед повтором/u);
  const writes = f.calls.filter((call) => call.init.method === 'PATCH');
  const last = writes.slice(-3);
  const key = new Headers(last[0].init.headers).get('Idempotency-Key')!;
  assert.ok(unknown.json().message.includes(key));
  assert.equal(new Set(last.map((call) => new Headers(call.init.headers).get('Idempotency-Key'))).size, 1);
  assert.equal(new Set(last.map((call) => call.init.body)).size, 1);
});

test('FACADE-IDENTITY: restore changes dashboard source while native numeric IDs remain stable', async (t) => {
  let epoch = me.installation.syncEpoch;
  const f = protocol(({ url }) => url.pathname === '/api/v1/me'
    ? { ...me, installation: { ...me.installation, syncEpoch: epoch } } : undefined);
  const { tracker, directory } = await facadeFixture(t, f.host);
  const { TaskFavoritesService } = await core('server/src/lib/taskFavoritesService.ts');
  const { TaskFavoritesStore } = await core('server/src/lib/taskFavoritesStore.ts');
  const store = new TaskFavoritesStore({ filePath: path.join(directory, 'favorites.json') });
  const favorites = new TaskFavoritesService({ tracker, store });
  const saved = await favorites.add('81');
  assert.deepEqual(saved.taskIds, ['81']);
  const first = await tracker.getDashboard();
  epoch = '21bbaeff-039b-48e2-bfa5-29d578f5314f';
  const restored = await tracker.getDashboard();
  assert.notEqual(first.source, restored.source);
  const afterRestore = await favorites.list();
  assert.notEqual(saved.scope, afterRestore.scope);
  assert.deepEqual(afterRestore.taskIds, []);
  assert.deepEqual((await store.list(saved.scope)).taskIds, ['81']);
  assert.equal(first.tasks[0].id, restored.tasks[0].id);
  assert.equal((await tracker.taskDetail('81')).responsible.id, '2');
});
