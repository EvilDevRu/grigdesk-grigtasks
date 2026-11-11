import assert from 'node:assert/strict';
import test from 'node:test';
import createDriver from '../driver.ts';
import { me, nativeTask, protocol } from './helpers/protocol.mts';

test('CONFIG: HTTPS, no URL secrets, required token, frozen false capabilities', async () => {
  const f = protocol();
  const driver = createDriver(f.host);
  assert.equal(driver.isConfigured(), true);
  assert.deepEqual(await driver.testAuth(), { ok: true, userId: 1 });
  for (const baseUrl of ['http://tasks.example', 'https://u:p@tasks.example',
    'https://tasks.example/?token=secret', 'https://tasks.example/#secret']) {
    f.credentials({ baseUrl, apiToken: 'token' });
    assert.equal(driver.isConfigured(), false);
  }
  assert.equal(driver.capabilities.attachments, false);
  assert.equal(driver.capabilities.timer, false);
  assert.equal(driver.capabilities.widgets, false);
});

test('READ: list pages, distinct dashboard views, numeric participants and checklist roots/items', async () => {
  const f = protocol(({ url }) => {
    if (url.pathname === '/api/v1/tasks' && url.searchParams.get('view') === 'assigned') {
      return url.searchParams.has('cursor')
        ? { items: [{ ...nativeTask, id: '82' }], nextCursor: null }
        : { items: [nativeTask], nextCursor: 'opaque-cursor' };
    }
  });
  const driver = createDriver(f.host);
  const listed = await driver.listTasks();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].responsible, 'Bob');
  assert.equal(listed[0].group, 'Project');
  const detail: any = await driver.taskDetail('81');
  assert.equal(detail.status, 4);
  assert.equal(detail.statusId, '93');
  assert.equal(detail.statusKind, 'await_acceptance');
  assert.equal(detail.creator.id, '1');
  assert.equal(detail.responsible.id, '2');
  assert.deepEqual(detail.accomplices, ['1']);
  assert.equal(detail.checklist[0].parentId, '0');
  assert.equal(detail.checklist[1].parentId, '41');
  assert.equal(detail.checklist[1].isComplete, 'Y');
  assert.equal(detail.description, '&lt;plain&gt;&#38;text');
  assert.equal(JSON.stringify(detail).includes('must-not-escape'), false);
  const dashboard = await driver.getDashboard();
  assert.equal(dashboard.tasks.length, 2);
  assert.equal(dashboard.created.length, 1);
  assert.equal(dashboard.toReview.length, 1);
  for (const view of ['assigned', 'created', 'review']) {
    assert.ok(f.calls.some((call) => call.url.searchParams.get('view') === view));
  }
  assert.ok(f.calls.every((call) => call.init.redirect === 'error'));
});

test('PAGE: all comments, tags, actual subtasks, no attachments; users/projects and web link', async () => {
  const f = protocol(({ url }) => {
    if (url.pathname === '/api/v1/tasks' && !url.searchParams.has('view')) {
      return { items: [{ ...nativeTask, id: '82', parentId: '81' }], nextCursor: null };
    }
  });
  const driver = createDriver(f.host);
  const page: any = await driver.taskPageData!('81');
  assert.equal(page.comments[0].author, 'Bob');
  assert.equal(page.comments[0].mid, '11');
  assert.deepEqual(page.tags, ['Release']);
  assert.equal(page.subtasks[0].id, '82');
  assert.deepEqual(page.attachments, []);
  assert.deepEqual(await driver.findUsers!('BO'), [{ id: '2', name: 'Bob' }]);
  assert.deepEqual(await driver.listGroups!(), [{ id: '7', name: 'Project' }]);
  assert.equal(await driver.sourceUrl('81'), 'https://tasks.example/tasks/81');
});

test('READ FAILURES: revoked auth is visible, exact task404 absent, API-only no link, fresh epoch', async () => {
  let response = me;
  const f = protocol(({ url }) => {
    if (url.pathname === '/api/v1/me') { return response; }
    if (url.pathname === '/api/v1/tasks/81') {
      return Response.json({ error: 'unauthorized', message: 'secret-token' }, { status: 401 });
    }
    if (url.pathname === '/api/v1/tasks/83') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (url.pathname === '/api/v1/tasks/84') {
      return Response.json({ error: 'project_not_found' }, { status: 404 });
    }
  });
  const driver = createDriver(f.host);
  await assert.rejects(driver.taskDetail('81'), (error: any) => !error.message.includes('secret-token'));
  assert.equal(await driver.probeTaskNumber('81'), 'unknown');
  assert.equal(await driver.probeTaskNumber('82'), 'absent');
  assert.equal(await driver.probeTaskNumber('83'), 'unknown');
  assert.equal(await driver.probeTaskNumber('84'), 'absent');
  const before = await driver.accountIdentity();
  response = { ...me, installation: { ...me.installation, syncEpoch: '21bbaeff-039b-48e2-bfa5-29d578f5314f' } };
  assert.notEqual((await driver.accountIdentity())?.userId, before?.userId);
  response = { ...me, installation: { ...me.installation, webUrl: null as any } };
  assert.equal(await driver.sourceUrl('81'), '');
});
