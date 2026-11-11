import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import createDriver from '../../driver.ts';
import type { TrackerHost } from '../../types/contract.ts';
import { core, facadeFixture } from '../helpers/grigdesk.mts';

const root = process.env.GRIGTASKS_ROOT;
if (!root || !path.isAbsolute(root)) { throw new Error('GRIGTASKS_ROOT required'); }
const source = (relative: string) => import(pathToFileURL(path.join(root, relative)).href);
const { fixture } = await source('tests/helpers/fixture.mts');
const { projectFixture } = await source('tests/helpers/project.mts');
const { actor } = await source('tests/helpers/actors.mts');
const { createApp } = await source('server/src/app.ts');

test('REAL HTTP+PG: CRUD, receipt after lost ACK, scopes, workflow, checklist, facade and revocation', {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t, { seed: false });
  const { owner, project, headers } = await projectFixture(f);
  const member = await actor(f, 'member@fixture.example');
  await f.sql('INSERT INTO project_members(project_id,user_id) VALUES ($1,$2)', [project.id, member.id]);
  await f.sql(`INSERT INTO user_role_assignments(user_id,role_id,scope_kind,project_id)
    SELECT $1,id,'project',$2 FROM roles WHERE seed_key='member'`, [member.id, project.id]);
  const hidden = await f.request('POST', '/api/v1/projects', { key: 'HIDDEN', title: 'Hidden' }, headers());
  assert.equal(hidden.status, 201);
  const hiddenTask = await f.request('POST', '/api/v1/tasks', {
    projectId: hidden.body.id, title: 'Forbidden',
  }, headers());
  assert.equal(hiddenTask.status, 201);
  const issue = async (cookie: string, scopes = ['read', 'write']) => {
    const issued = await f.request('POST', '/api/v1/me/api-tokens', {
      name: 'Driver fixture', scopes, projectIds: [project.id], expiresInDays: 1,
    }, { cookie });
    assert.equal(issued.status, 201);
    return issued.body;
  };
  const ownerToken = await issue(owner.cookie);
  const memberToken = await issue(member.cookie);
  const readToken = await issue(owner.cookie, ['read']);
  const app = createApp(f.pool, 'https://tasks.fixture.example', undefined, {
    ...f.fileOptions, webEnabled: true,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const upstream = 'http://127.0.0.1:' + app.server.address().port;
  let losePath = '/api/v1/tasks';
  let loseMethod = 'POST';
  let conflict = false;
  let resetOnPatch = false;
  const wires: { method: string; path: string; key: string | undefined; version: string | undefined;
    epoch: string | undefined; body: string }[] = [];
  const proxy = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) { chunks.push(Buffer.from(chunk)); }
      const body = Buffer.concat(chunks).toString('utf8');
      wires.push({
        method: request.method!, path: request.url!, key: request.headers['idempotency-key'] as string,
        version: request.headers['if-match'] as string, epoch: request.headers['x-sync-epoch'] as string, body,
      });
      if (conflict && request.method === 'PATCH') {
        response.writeHead(409, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'version_conflict', currentVersion: '999' }));
        return;
      }
      if (resetOnPatch && request.method === 'PATCH') {
        resetOnPatch = false;
        await f.sql('UPDATE installation SET sync_epoch=$1', [randomUUID()]);
      }
      const result = await fetch(upstream + request.url, {
        method: request.method, body: ['GET', 'HEAD'].includes(request.method!) ? undefined : body || undefined,
        headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) =>
          !['host', 'connection', 'content-length'].includes(name))) as Record<string, string>,
        redirect: 'error',
      });
      const bytes = await result.arrayBuffer();
      if (request.url === losePath && request.method === loseMethod && result.status < 300) {
        losePath = '';
        response.destroy();
        return;
      }
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(Buffer.from(bytes));
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = 'http://127.0.0.1:' + address.port;
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await app.close();
  });
  const makeHost = (token: string): TrackerHost => ({
    credentials: { read: () => ({ baseUrl: 'https://tasks.fixture.example', apiToken: token }) },
    dataDir: f.directory, cookiePath: '/unused', serial: async (work) => work(),
    logger: { info() {}, warn() {} },
    fetch: (url, init) => {
      assert.equal(new URL(String(url)).origin, 'https://tasks.fixture.example');
      assert.equal(init?.redirect, 'error');
      return fetch(endpoint + new URL(String(url)).pathname + new URL(String(url)).search, init);
    },
  });
  const driver = createDriver(makeHost(ownerToken.token));
  const worker = createDriver(makeHost(memberToken.token));
  const created = await driver.createTask!({ title: 'Driver', groupId: project.id, responsibleId: member.id,
    accomplices: [member.id], auditors: [owner.id] }) as any;
  assert.equal(created.ok, true);
  const taskId = created.id;
  const taskPath = '/api/v1/tasks/' + taskId;
  assert.deepEqual((await f.sql('SELECT user_id::text AS id,kind FROM task_participants WHERE task_id=$1 ORDER BY kind', [taskId])).rows,
    [{ id: member.id, kind: 'accomplice' }, { id: owner.id, kind: 'observer' }]);

  const creation = wires.find((wire) => wire.method === 'POST' && wire.path === '/api/v1/tasks')!;
  assert.ok(wires.some((wire) => wire.path === '/api/v1/operations/' + creation.key));
  assert.equal((await f.sql('SELECT count(*)::int n FROM tasks WHERE title=$1', ['Driver'])).rows[0].n, 1);
  assert.equal((await f.sql('SELECT count(*)::int n FROM operation_receipts WHERE operation_id=$1',
    [creation.key])).rows[0].n, 1);
  assert.equal(await driver.probeTaskNumber(taskId), 'exists');
  assert.equal(await driver.probeTaskNumber(hiddenTask.body.id), 'absent');
  assert.deepEqual((await driver.listGroups!() as any[]).map((row) => row.id), [project.id]);
  assert.equal(await driver.sourceUrl(taskId), 'https://tasks.fixture.example/tasks/' + taskId);

  await driver.updateTask!(taskId, { title: 'Edited', description: 'Body', deadline: null, priority: 0, accomplices: [], auditors: [member.id] });
  assert.deepEqual((await f.sql('SELECT user_id::text AS id,kind FROM task_participants WHERE task_id=$1', [taskId])).rows,
    [{ id: member.id, kind: 'observer' }]);

  losePath = taskPath + '/comments';
  loseMethod = 'POST';
  await driver.addComment!(taskId, 'Lost ACK comment');
  assert.equal((await f.sql('SELECT count(*)::int n FROM comments WHERE task_id=$1', [taskId])).rows[0].n, 1);
  const list: any = await driver.addChecklistItem!(taskId, { title: 'Root' });
  const item: any = await driver.addChecklistItem!(taskId, { title: 'Item', parentId: list.id });
  assert.notEqual(list.id, item.id);
  await driver.updateChecklistItem!(taskId, list.id, { title: 'Renamed' });
  await driver.updateChecklistItem!(taskId, item.id, { complete: true });
  await driver.updateChecklistItem!(taskId, item.id, { complete: false });
  await driver.updateTaskTags!(taskId, ['Release']);
  const detail: any = await driver.taskDetail(taskId);
  assert.equal(detail.checklist.length, 2);
  assert.equal(detail.checklist[1].isComplete, 'N');
  assert.equal(detail.responsible.id, member.id);
  const child: any = await driver.createTask!({ title: 'Child', groupId: project.id, parentId: taskId });
  assert.ok(child.id);

  const host = await facadeFixture(t, makeHost(ownerToken.token));
  const decoders = await core('web/src/shared/boardContracts.ts');
  const httpDetail = await host.app.inject('/api/tracker/task/' + taskId);
  assert.equal(httpDetail.statusCode, 200, httpDetail.body);
  assert.equal(decoders.decodeTaskDetail(httpDetail.json()).checklist.length, 2);
  const httpPage = await host.app.inject('/api/tracker/task/' + taskId + '/comments');
  assert.equal(decoders.decodeTaskComments(httpPage.json()).length, 1);
  assert.deepEqual(decoders.decodeTaskTags(httpPage.json()), ['Release']);
  assert.equal(decoders.decodeTaskSubtasks(httpPage.json())[0].id, child.id);
  await driver.addComment!(taskId, 'Same text is a new intention');
  await driver.addComment!(taskId, 'Same text is a new intention');
  assert.equal((await f.sql('SELECT count(*)::int n FROM comments WHERE task_id=$1', [taskId])).rows[0].n, 3);

  await assert.rejects(worker.completeTask!(taskId), { code: 'transition_unavailable' });
  const edges = await f.request('GET', taskPath + '/transitions', undefined, headers(member.cookie));
  const move = edges.body.items.find((edge: any) => edge.kind === 'move');
  const current = await f.request('GET', taskPath, undefined, headers());
  assert.equal((await f.request('POST', taskPath + '/transitions', { transitionId: move.id },
    headers(member.cookie, current.body.version))).status, 200);
  await worker.completeTask!(taskId);
  const dashboard = await driver.getDashboard();
  assert.equal(dashboard.toReview.length, 1);
  assert.equal((await worker.getDashboard()).tasks.length, 1);
  assert.equal((await worker.getDashboard()).created.length, 0);
  await driver.disapproveTask!(taskId);
  await worker.completeTask!(taskId);
  await driver.approveTask!(taskId);
  assert.equal((await driver.taskDetail(taskId) as any).status, 5);
  await driver.renewTask!(taskId);

  const beforeConflict = wires.length;
  conflict = true;
  await assert.rejects(driver.updateTask!(taskId, { title: 'Must not overwrite' }), {
    code: 'tracker_request_failed',
  });
  conflict = false;
  assert.equal(wires.slice(beforeConflict).filter((wire) => wire.method === 'PATCH').length, 1);
  assert.equal((await driver.taskDetail(taskId) as any).title, 'Edited');
  const previousIdentity = await driver.accountIdentity();
  resetOnPatch = true;
  await assert.rejects(driver.updateTask!(taskId, { title: 'Old epoch' }), {
    code: 'tracker_request_failed',
  });
  assert.notEqual((await driver.accountIdentity())?.userId, previousIdentity?.userId);
  assert.equal((await driver.taskDetail(taskId) as any).title, 'Edited');
  await assert.rejects(createDriver(makeHost(readToken.token)).createTask!({
    groupId: project.id, title: 'No write scope',
  }));
  await driver.deleteChecklistItem!(taskId, list.id);
  assert.equal((await f.sql('SELECT count(*)::int n FROM checklist_items WHERE task_id=$1', [taskId])).rows[0].n, 0);
  assert.equal((await f.sql('SELECT count(*)::int n FROM checklists WHERE task_id=$1', [taskId])).rows[0].n, 0);
  await driver.updateTaskTags!(taskId, []);
  assert.deepEqual((await driver.taskPageData!(taskId) as any).tags, []);
  await driver.deleteTask!(taskId);
  assert.equal(await driver.probeTaskNumber(taskId), 'absent');

  const revoked = await f.request('DELETE', '/api/v1/me/api-tokens/' + ownerToken.id, undefined,
    { cookie: owner.cookie });
  assert.equal(revoked.status, 204);
  assert.equal((await driver.testAuth()).ok, false);
  await assert.rejects(driver.listTasks());
});
