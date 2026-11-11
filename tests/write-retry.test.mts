import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';

import {
  executeMutation,
  prepareMutation,
  type Reply,
  type RequestPort,
} from '../src/write.ts';

const EPOCH = '5548c827-de54-411f-8de3-d1822f41efc2';

type Wire = {
  method: string;
  path: string;
  key: string | undefined;
  version: string | undefined;
  epoch: string | undefined;
  body: string;
};

/**
 * Loopback-приёмник подтверждает фактический wire и разрывает настоящий HTTP-ответ.
 * Он не заменяет PostgreSQL-проверки сервера: моделируется только контракт его receipt.
 */
async function receiver(t: TestContext, mode: 'receipt' | 'missing' | 'forbidden' | 'conflict') {
  const wires: Wire[] = [];
  let effect = 0;
  let committed: Reply | null = null;
  let mutationCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const wire: Wire = {
      method: req.method ?? '',
      path: req.url ?? '',
      key: req.headers['idempotency-key'] as string | undefined,
      version: req.headers['if-match'] as string | undefined,
      epoch: req.headers['x-sync-epoch'] as string | undefined,
      body: Buffer.concat(chunks).toString('utf8'),
    };

    wires.push(wire);
    res.setHeader('Content-Type', 'application/json');

    if (wire.method === 'GET') {
      res.statusCode = mode === 'forbidden' ? 403 : committed ? 200 : 404;
      const error = res.statusCode === 404 ? 'operation_not_found' : 'forbidden';

      res.end(JSON.stringify(res.statusCode === 200 ? committed : { error }));

      return;
    }

    mutationCount += 1;

    if (mode === 'conflict') {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'version_conflict', currentVersion: '8' }));

      return;
    }

    if (mutationCount === 1) {
      if (mode === 'receipt' || mode === 'forbidden') {
        effect += 1;
        committed = { status: 201, body: { id: '81', version: '1' } };
        res.destroy();
      } else {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'unavailable' }));
      }

      return;
    }

    effect += 1;
    res.statusCode = 201;
    res.end(JSON.stringify({ id: '81', version: '1' }));
  });

  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  assert.ok(address && typeof address === 'object');

  const baseUrl = 'http://127.0.0.1:' + address.port;
  const request: RequestPort = async (method, path, headers, body) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(2_000),
    });

    return { status: response.status, body: await response.json() };
  };

  return { wires, request, effects: () => effect };
}

test('DRIVER-ACK: receipt восстанавливает ответ после настоящего разрыва', {
  timeout: 10_000,
}, async (t) => {
  const f = await receiver(t, 'receipt');
  const prepared = prepareMutation('POST', '/api/v1/tasks', { title: 'Один эффект' }, null, EPOCH);
  const result = await executeMutation(f.request, prepared);

  assert.deepEqual(result, { status: 201, body: { id: '81', version: '1' } });
  assert.equal(f.effects(), 1);
  assert.deepEqual(f.wires.map((wire) => wire.method), ['POST', 'GET']);
  assert.equal(f.wires[1].path, '/api/v1/operations/' + prepared.operationId);
});

test('DRIVER-WIRE: нет receipt — повторяется исходное тело, UUID и версия', {
  timeout: 10_000,
}, async (t) => {
  const f = await receiver(t, 'missing');
  const payload = { title: 'Зафиксировано', complete: false };
  const prepared = prepareMutation('PATCH', '/api/v1/tasks/81', payload, '7', EPOCH);

  payload.title = 'Поздняя правка формы';

  const result = await executeMutation(f.request, prepared);

  assert.equal(result.status, 201);
  assert.equal(f.effects(), 1);
  assert.deepEqual(f.wires.map((wire) => wire.method), ['PATCH', 'GET', 'PATCH']);
  assert.deepEqual(f.wires[0], f.wires[2]);
  assert.equal(f.wires[0].version, '"7"');
  assert.equal(f.wires[0].epoch, EPOCH);
  assert.deepEqual(JSON.parse(f.wires[0].body), { title: 'Зафиксировано', complete: false });
});

test('DRIVER-REVOKE: отказ чтения receipt не вызывает новую предметную запись', {
  timeout: 10_000,
}, async (t) => {
  const f = await receiver(t, 'forbidden');
  const prepared = prepareMutation('POST', '/api/v1/tasks', { title: 'Отозвано' }, null, EPOCH);

  await assert.rejects(executeMutation(f.request, prepared), { code: 'tracker_request_failed' });
  assert.equal(f.effects(), 1);
  assert.deepEqual(f.wires.map((wire) => wire.method), ['POST', 'GET']);
});

test('DRIVER-CONFLICT: новая версия не подставляется автоматически', {
  timeout: 10_000,
}, async (t) => {
  const f = await receiver(t, 'conflict');
  const prepared = prepareMutation('PATCH', '/api/v1/tasks/81', { title: 'Конфликт' }, '7', EPOCH);

  await assert.rejects(executeMutation(f.request, prepared), {
    code: 'tracker_request_failed',
    status: 502,
  });
  assert.equal(f.effects(), 0);
  assert.equal(f.wires.length, 1);
  assert.equal(f.wires[0].version, '"7"');
  assert.equal(f.wires[0].epoch, EPOCH);
});
