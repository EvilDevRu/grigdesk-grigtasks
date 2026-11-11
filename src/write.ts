import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface Reply {
  status: number;
  body: unknown;
}

export type RequestPort = (
  method: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  body?: string,
) => Promise<Reply>;

export interface PreparedMutation {
  operationId: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}

export class DriverRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Версия и сериализованное тело фиксируются до первого сетевого эффекта.
 * Ссылки на изменяемый input не переживают эту границу вызова contract1.
 */
export function prepareMutation(
  method: PreparedMutation['method'],
  path: string,
  payload: unknown,
  version: string | null,
  expectedSyncEpoch: string,
): PreparedMutation {
  if (!path.startsWith('/api/v1/') || path.includes('?') || path.includes('#')) {
    throw new Error('invalid_mutation_path');
  }

  if (version !== null && !/^[1-9][0-9]*$/.test(version)) {
    throw new Error('invalid_resource_version');
  }

  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(expectedSyncEpoch)) {
    throw new Error('invalid_sync_epoch');
  }

  const operationId = randomUUID();
  const headers: Record<string, string> = {
    'Idempotency-Key': operationId,
    'X-Sync-Epoch': expectedSyncEpoch,
  };

  if (version !== null) {
    headers['If-Match'] = '"' + version + '"';
  }

  const body = payload === undefined ? undefined : JSON.stringify(payload);

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  return Object.freeze({
    operationId,
    method,
    path,
    headers: Object.freeze(headers),
    body,
  });
}

/**
 * Ответы предметного API не передают произвольный текст или секреты в старый фасад.
 * Для конфликтов сообщение сохраняет operationId, поскольку details фасад теряет.
 */
export function responseError(reply: Reply, operationId: string): DriverRequestError {
  const record = reply.body !== null && typeof reply.body === 'object'
    ? reply.body as Record<string, unknown> : {};

  if (reply.status === 404) {
    return new DriverRequestError('task_not_found', 'Объект недоступен', 404);
  }

  if (reply.status === 400 || reply.status === 422) {
    const message = record.error === 'project_immutable'
      ? 'Перенос задачи между проектами недоступен'
      : 'Проверьте поля задачи: сервер отклонил изменение';

    return new DriverRequestError('b24_bad_request', message, 400);
  }

  const messages: Record<number, string> = {
    401: 'Вход в трекер истёк',
    403: 'Недостаточно прав для операции',
    409: 'Конфликт изменения: перечитайте карточку',
  };
  const message = record.error === 'sync_reset_required'
    ? 'Установка восстановлена: сверьте задачу перед новой операцией'
    : messages[reply.status] ?? 'Трекер отклонил операцию';

  const suffix = operationId ? ' [' + operationId + ']' : '';
  return new DriverRequestError('tracker_request_failed', message + suffix, 502);
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Сетевой сбой может произойти после commit: сначала сверяется receipt той же identity.
 * Тело и версия между попытками не меняются; конфликт не исправляется перезаписью.
 */
export async function executeMutation(
  request: RequestPort,
  prepared: PreparedMutation,
  options: { signal?: AbortSignal } = {},
): Promise<Reply> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      try {
        await delay(100 * 2 ** (attempt - 1), undefined, { signal: options.signal });
      } catch {
        break;
      }
      let receipt: Reply | null = null;

      try {
        receipt = await request(
          'GET', '/api/v1/operations/' + prepared.operationId, {},
        );
      } catch {
        // Receipt недоступен; повтор исходного wire защищён серверным ключом операции.
      }

      if (receipt?.status === 200) {
        const cached = receipt.body as Partial<Reply> | null;

        if (!cached || typeof cached.status !== 'number'
          || cached.status < 200 || cached.status >= 300 || !('body' in cached)) {
          throw new DriverRequestError('invalid_receipt', 'Некорректный результат операции', 502);
        }

        return { status: cached.status, body: cached.body };
      }

      const missing = receipt?.status === 404 && receipt.body !== null
        && typeof receipt.body === 'object'
        && (receipt.body as Record<string, unknown>).error === 'operation_not_found';

      if (receipt && !missing && !retryable(receipt.status)) {
        throw responseError(receipt, prepared.operationId);
      }
    }

    let reply: Reply;

    try {
      reply = await request(prepared.method, prepared.path, prepared.headers, prepared.body);
    } catch {
      continue;
    }

    if (reply.status >= 200 && reply.status < 300) {
      return reply;
    }

    if (!retryable(reply.status)) {
      throw responseError(reply, prepared.operationId);
    }
  }

  throw new DriverRequestError(
    'operation_unknown',
    'Результат неизвестен; проверьте операцию в трекере перед повтором [' + prepared.operationId + ']',
    502,
  );
}
