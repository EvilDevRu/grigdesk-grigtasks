import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { nativeIdentity, testAuthIdentity, trackerIdentity } from '../src/identity.ts';

const grigdeskRoot = process.env.GRIGDESK_ROOT;

if (!grigdeskRoot || !path.isAbsolute(grigdeskRoot)) {
  throw new Error('GRIGDESK_ROOT должен содержать абсолютный путь к fixture checkout');
}

const accountScopeFile = path.join(grigdeskRoot, 'server/src/lib/trackers/accountScope.ts');
const { trackerAccountScope } = await import(pathToFileURL(accountScopeFile).href);
const origin = 'https://tracker.fixture.example';
const installationA = '77a2f654-39e0-4aa8-8e85-fbd1d43c23a0';
const installationB = 'e463ea67-a607-40ae-8074-f02d8ad52a1f';
const epochA = 'cf80b96e-cdeb-4326-8e42-bd6cdbe2fd9a';
const epochB = '21bbaeff-039b-48e2-bfa5-29d578f5314f';

function me(installationId: string, syncEpoch: string) {
  return {
    user: { id: '1', displayName: 'Участник' },
    installation: { id: installationId, syncEpoch },
  };
}

test('DRIVER-IDENTITY-EPOCH: новый install/restore отделён, reconnect стабилен', () => {
  const first = trackerIdentity(origin, me(installationA, epochA));
  const reconnect = trackerIdentity(origin + '/', me(installationA, epochA));
  const otherInstallation = trackerIdentity(origin, me(installationB, epochA));
  const restored = trackerIdentity(origin, me(installationA, epochB));
  const firstScope = trackerAccountScope(first);

  assert.equal(trackerAccountScope(reconnect), firstScope);
  assert.notEqual(trackerAccountScope(otherInstallation), firstScope);
  assert.notEqual(trackerAccountScope(restored), firstScope);
  assert.notEqual(trackerAccountScope(otherInstallation), trackerAccountScope(restored));
  assert.equal(first.userId, installationA + ':' + epochA + ':1');
  assert.equal(restored.userId, installationA + ':' + epochB + ':1');
});

test('DRIVER-NATIVE-ID: scope не меняет /me и числовой testAuth', () => {
  const response = me(installationA, epochA);
  const before = structuredClone(response);
  const mapped = trackerIdentity(origin, response);

  assert.deepEqual(response, before);
  assert.equal(nativeIdentity(response).nativeUserId, '1');
  assert.deepEqual(testAuthIdentity(response), { ok: true, userId: 1 });
  assert.notEqual(mapped.userId, response.user.id);
});

test('DRIVER-IDENTITY-INVALID: повреждённый scope не объединяет источники', () => {
  assert.throws(() => trackerIdentity(origin, {
    user: { id: '1' },
    installation: { id: installationA },
  }), /invalid_installation_identity/u);
  assert.throws(() => trackerIdentity(origin, {
    user: { id: '9007199254740992' },
    installation: { id: installationA, syncEpoch: epochA },
  }), /invalid_native_user_id/u);
  assert.throws(() => trackerIdentity('https://name:secret@tracker.fixture.example', me(
    installationA,
    epochA,
  )), /invalid_tracker_base_url/u);
});
