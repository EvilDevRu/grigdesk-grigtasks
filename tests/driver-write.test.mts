import assert from 'node:assert/strict';
import test from 'node:test';
import createDriver from '../driver.ts';
import { epoch, nativeTask, protocol } from './helpers/protocol.mts';

test('WRITE: create/edit/comments/tags map inputs with task version and explicit clear', async () => {
  const f = protocol(({ init, url }) => {
    if (init.method !== 'GET') {
      if (url.pathname.endsWith('/comments')) { return { id: '11', text: 'comment' }; }
      return nativeTask;
    }
  });
  const driver = createDriver(f.host);
  await driver.createTask!({ title: 'Created', groupId: 7, responsibleId: 2, priority: 2, createdById: 1 });
  await driver.updateTask!('81', { title: 'Edit', deadline: null, priority: 0 });
  await driver.addComment!('81', 'comment');
  await driver.updateTaskTags!('81', []);
  const writes = f.calls.filter((call) => call.init.method !== 'GET');
  assert.equal(writes.length, 4);
  assert.deepEqual(JSON.parse(String(writes[0].init.body)), {
    title: 'Created', projectId: '7', assigneeId: '2', priority: 'high',
  });
  assert.deepEqual(JSON.parse(String(writes[1].init.body)), { title: 'Edit', dueAt: null, priority: 'low' });
  assert.equal(new Headers(writes[1].init.headers).get('If-Match'), '"7"');
  assert.deepEqual(JSON.parse(String(writes[2].init.body)), { text: 'comment' });
  assert.deepEqual(JSON.parse(String(writes[3].init.body)), { tags: [] });
  assert.equal(new Set(writes.map((call) => new Headers(call.init.headers).get('Idempotency-Key'))).size, 4);
  assert.ok(writes.every((call) => new Headers(call.init.headers).get('X-Sync-Epoch') === epoch));
});

test('CHECKLIST: root/item create, node version for rename/toggle false/delete', async () => {
  const f = protocol(({ init }) => init.method !== 'GET'
    ? (init.method === 'DELETE' ? new Response(null, { status: 204 }) : { id: '42', version: '4' })
    : undefined);
  const driver = createDriver(f.host);
  await driver.addChecklistItem!('81', { title: 'Root' });
  await driver.addChecklistItem!('81', { title: 'Item', parentId: '41' });
  await driver.updateChecklistItem!('81', '41', { title: 'Renamed' });
  await driver.updateChecklistItem!('81', '42', { complete: false });
  await driver.deleteChecklistItem!('81', '41');
  const writes = f.calls.filter((call) => call.init.method !== 'GET');
  assert.equal(writes[0].url.pathname, '/api/v1/tasks/81/checklists');
  assert.equal(writes[1].url.pathname, '/api/v1/tasks/81/checklists/41/items');
  assert.equal(writes[2].url.pathname, '/api/v1/tasks/81/checklist-nodes/41');
  assert.equal(new Headers(writes[2].init.headers).get('If-Match'), '"6"');
  assert.equal(new Headers(writes[3].init.headers).get('If-Match'), '"3"');
  assert.deepEqual(JSON.parse(String(writes[3].init.body)), { complete: false });
  assert.equal(writes[4].init.method, 'DELETE');
});

test('WORKFLOW: select semantic edge only, no implicit transition chain, delete confirmed204', async () => {
  const f = protocol(({ init, url }) => init.method !== 'GET'
    ? (init.method === 'DELETE' ? new Response(null, { status: 204 }) : nativeTask) : undefined);
  const driver = createDriver(f.host);
  await assert.rejects(driver.completeTask!('81'), { code: 'transition_unavailable' });
  assert.equal(f.calls.filter((call) => call.init.method !== 'GET').length, 0);
  const approved = await driver.approveTask!('81');
  assert.equal(JSON.stringify(approved).includes('must-not-escape'), false);
  assert.deepEqual(JSON.parse(String(f.calls.at(-1)!.init.body)), { transitionId: '90' });
  assert.deepEqual(await driver.deleteTask!('81'), { ok: true });
});

test('VALIDATION: project immutable and foreign creator rejected before effects, unknown fields rejected', async () => {
  const f = protocol();
  const driver = createDriver(f.host);
  await assert.rejects(driver.updateTask!('81', { groupId: 7 }), { code: 'b24_bad_request' });
  await assert.rejects(driver.createTask!({ title: 'Bad', groupId: 7, createdById: 2 }), {
    code: 'b24_bad_request',
  });
  await assert.rejects(driver.updateTask!('81', { surprising: true }), { code: 'b24_bad_request' });
  assert.equal(f.calls.filter((call) => call.init.method !== 'GET').length, 0);
});

test('PARTICIPANTS: create and mixed edit use one atomic POST/PATCH with explicit arrays', async () => {
  const f = protocol(({ init }) => init.method !== 'GET' ? nativeTask : undefined);
  const driver = createDriver(f.host);
  await driver.updateTask!('81', { accomplices: [], auditors: [] });
  await driver.updateTask!('81', { title: 'Mixed', accomplices: [] });
  await driver.createTask!({ title: 'With participants', groupId: 7, accomplices: [2], auditors: [1] });
  const writes = f.calls.filter((call) => call.init.method !== 'GET');
  assert.equal(writes.length, 3);
  assert.equal(writes[0].url.pathname, '/api/v1/tasks/81');
  assert.equal(writes[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(writes[0].init.body)), { accompliceIds: [], observerIds: [] });
  assert.deepEqual(JSON.parse(String(writes[1].init.body)), { title: 'Mixed', accompliceIds: [] });
  assert.deepEqual(JSON.parse(String(writes[2].init.body)), {
    title: 'With participants', projectId: '7', accompliceIds: ['2'], observerIds: ['1'],
  });
});
