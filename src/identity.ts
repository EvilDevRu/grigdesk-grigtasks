export interface NativeIdentity {
  installationId: string;
  syncEpoch: string;
  nativeUserId: string;
}

export interface PackageTrackerIdentity {
  baseUrl: string;
  userId: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_USER_ID = 9_007_199_254_740_991n;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * /me сохраняет native ID для предметных запросов отдельно от установки и эпохи.
 * Невалидная metadata не заменяется пустой строкой и не объединяет чужие источники.
 */
export function nativeIdentity(value: unknown): NativeIdentity {
  const root = record(value);
  const user = record(root?.user);
  const installation = record(root?.installation);
  const nativeUserId = user?.id;
  const installationId = installation?.id;
  const syncEpoch = installation?.syncEpoch;

  if (typeof nativeUserId !== 'string' || !/^[1-9]\d*$/u.test(nativeUserId)
    || BigInt(nativeUserId) > MAX_USER_ID) {
    throw new Error('invalid_native_user_id');
  }

  if (typeof installationId !== 'string' || !UUID.test(installationId)
    || typeof syncEpoch !== 'string' || !UUID.test(syncEpoch)) {
    throw new Error('invalid_installation_identity');
  }

  return { installationId, syncEpoch, nativeUserId };
}

/**
 * Существующий GrigDesk хэширует только baseUrl и userId, игнорируя metadata.
 * Поэтому установка и restore-эпоха входят в opaque userId только этого scope-контракта.
 */
export function trackerIdentity(baseUrl: string, me: unknown): PackageTrackerIdentity {
  const url = new URL(baseUrl);

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_tracker_base_url');
  }

  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';

  const identity = nativeIdentity(me);

  return {
    baseUrl: url.toString().replace(/\/$/u, ''),
    userId: [identity.installationId, identity.syncEpoch, identity.nativeUserId].join(':'),
  };
}

/**
 * testAuth contract1 ожидает числовой native ID, а не личный scope.
 * Проверка диапазона завершена до преобразования, поэтому Number не теряет точность.
 */
export function testAuthIdentity(me: unknown): { ok: true; userId: number } {
  const identity = nativeIdentity(me);

  return { ok: true, userId: Number(identity.nativeUserId) };
}
