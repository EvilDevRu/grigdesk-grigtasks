import assert from 'node:assert/strict';
import test from 'node:test';
import createDriver from '../driver.ts';
import { core, facadeFixture } from './helpers/grigdesk.mts';
import { nativeTask, protocol } from './helpers/protocol.mts';

process.env.NODE_ENV = 'test';

test('TASK MODAL: native review93/done105 show approve/renew and invoke real package through facade', {
  timeout: 30_000,
}, async (t) => {
  let stage = { id: '93', kind: 'review', title: 'Native review', category: 'active' };
  const f = protocol(({ url, init }) => {
    if (url.pathname === '/api/v1/tasks/81') { return { ...nativeTask, status: stage }; }
    if (url.pathname === '/api/v1/tasks/81/transitions') {
      if (init.method === 'GET') {
        return { version: '7', items: [{ id: stage.kind === 'review' ? '101' : '102',
          kind: stage.kind === 'review' ? 'approve' : 'reopen' }] };
      }
      stage = stage.kind === 'review'
        ? { id: '105', kind: 'done', title: 'Native done', category: 'done' }
        : { id: '91', kind: 'new', title: 'Native new', category: 'todo' };
      return { ...nativeTask, status: stage };
    }
  });
  const driver = createDriver(f.host);
  const { app } = await facadeFixture(t, f.host);
  const { mountTrackerCard, cardButton } = await core('tests/web/helpers/trackerCard.js');
  const card = await mountTrackerCard(t, {
    trackerId: driver.id, id: '81', capabilities: driver.capabilities,
    detail: await driver.taskDetail('81'), pageData: await driver.taskPageData!('81'),
    mutation: async ({ method, url, payload, task }: any) => {
      const response = await app.inject({ method, url, payload });
      assert.equal(response.statusCode, 200, response.body);
      Object.assign(task, await driver.taskDetail('81'));
      return response.json();
    },
  });
  assert.equal(card.wrapper.find('[data-role="task-approve"]').exists(), true);
  assert.equal(card.wrapper.find('[data-role="task-disapprove"]').exists(), true);
  assert.equal(card.wrapper.get('[data-checklist-id="41"]').find('input[type="checkbox"]').exists(), false);
  assert.equal(card.wrapper.get('[data-checklist-id="42"]').find('input[type="checkbox"]').exists(), true);
  await card.wrapper.get('[data-role="task-approve"]').trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-role="task-approve"]').exists(), false);
  assert.ok(cardButton(card.wrapper, 'Возобновить'));
  await cardButton(card.wrapper, 'Возобновить').trigger('click');
  await card.flushPromises();
  const transitions = f.calls.filter((call) => call.init.method === 'POST'
    && call.url.pathname.endsWith('/transitions'));
  assert.deepEqual(transitions.map((call) => JSON.parse(String(call.init.body)).transitionId), ['101', '102']);
  assert.equal(stage.kind, 'new');
});
