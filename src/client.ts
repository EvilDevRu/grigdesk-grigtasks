import { setTimeout as delay } from 'node:timers/promises';
import type { TrackerHost, TrackerReadOptions } from '../types/contract.ts';
import { DriverRequestError, type RequestPort, responseError } from './write.ts';

export interface Configuration { baseUrl: string; apiToken: string }

/** Адрес установки и токен проверяются до сети, секреты не входят в текст ошибок. */
export function configuration(value: unknown): Readonly<Configuration> {
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  let url: URL;

  try {
    if (typeof raw.baseUrl !== 'string') { throw new Error(); }
    url = new URL(raw.baseUrl);
  } catch {
    throw new DriverRequestError('invalid_configuration', 'Укажите HTTPS URL установки', 400);
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.href.includes('?') || url.href.includes('#') || /%2f|%5c/iu.test(url.pathname)) {
    throw new DriverRequestError('invalid_configuration', 'Укажите HTTPS URL установки без секретов', 400);
  }

  if (typeof raw.apiToken !== 'string' || !raw.apiToken || raw.apiToken.length > 4096
    || /[\s\x00-\x1f\x7f]/u.test(raw.apiToken)) {
    throw new DriverRequestError('invalid_configuration', 'Укажите персональный API token', 400);
  }

  return Object.freeze({ baseUrl: url.href.replace(/\/+$/u, ''), apiToken: raw.apiToken });
}

/** Повреждённые DTO отвергаются целиком, чтобы список не выдавал частичный успех. */
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DriverRequestError('invalid_response', 'Некорректный ответ трекера', 502);
  }

  return value as Record<string, unknown>;
}

/** JSON читается под тем же deadline, с верхней границей памяти на один HTTP-ответ. */
async function responseBody(response: Response): Promise<unknown> {
  if (response.status === 204) { return null; }
  if (!response.body) { throw new Error('invalid_json'); }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { break; }
      size += part.value.byteLength;
      if (size > 16 * 1024 * 1024) { throw new Error('response_too_large'); }
      chunks.push(part.value);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Экземпляр принадлежит одному invocation и фиксирует credentials до первого await.
 * Общий budget включает подготовительные чтения, Retry-After, body и проверку receipt.
 */
export class Client {
  readonly config: Readonly<Configuration>;
  private readonly fetcher: typeof fetch;
  private readonly end: number;
  readonly signal: AbortSignal;
  private notBefore = 0;
  private readonly timeoutMs: number;
  private expectedIdentity: Readonly<Record<string, string>> = Object.freeze({});

  constructor(host: TrackerHost, options: TrackerReadOptions = {}, mutation = false) {
    this.config = configuration(host.credentials.read());
    this.fetcher = host.fetch ?? fetch;
    this.timeoutMs = mutation ? 15_000 : 30_000;
    this.end = Date.now() + (mutation ? 60_000 : 30_000);
    const budget = AbortSignal.timeout(mutation ? 60_000 : 30_000);
    this.signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  }

  /** Даже скопированный при restore token не переносит mutation в другую установку/личность. */
  bindIdentity(installationId: string, nativeUserId: string): void {
    this.expectedIdentity = Object.freeze({
      'X-Expected-Installation-Id': installationId, 'X-Expected-User-Id': nativeUserId,
    });
  }

  /** Retry-After применяется к следующему запросу той же установки, без продления budget. */
  readonly request: RequestPort = async (method, path, headers, body) => {
    try {
      if (!path.startsWith('/api/v1/') || path.includes('#') || path.includes('\\')) {
        throw new Error('invalid_path');
      }

      this.signal.throwIfAborted();
      const wait = Math.max(0, this.notBefore - Date.now());
      if (wait > 0) { await delay(Math.min(wait, Math.max(0, this.end - Date.now())), undefined,
        { signal: this.signal }); }
      const remaining = this.end - Date.now();
      if (remaining <= 0) { throw new Error('deadline'); }

      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(Math.min(this.timeoutMs, remaining))]);
      const response = await this.fetcher(this.config.baseUrl + path, {
        method, body, signal, redirect: 'error', credentials: 'omit',
        headers: { ...headers, ...this.expectedIdentity, Accept: 'application/json',
          Authorization: 'Bearer ' + this.config.apiToken },
      });
      if (response.status >= 300 && response.status < 400) { throw new Error('redirect'); }

      if (response.status === 429 || response.status === 503) {
        const retry = response.headers.get('Retry-After');
        const milliseconds = retry && /^\d+$/u.test(retry)
          ? Number(retry) * 1000 : retry ? Math.max(0, Date.parse(retry) - Date.now()) : 0;
        if (Number.isFinite(milliseconds)) {
          this.notBefore = Date.now() + Math.min(milliseconds, Math.max(0, this.end - Date.now()));
        }
      }

      return { status: response.status, body: await responseBody(response) };
    } catch {
      throw new DriverRequestError('transport_error', 'Нет подтверждённого ответа трекера', 502);
    }
  };

  async get(path: string): Promise<Record<string, unknown>> {
    const reply = await this.request('GET', path, {});
    if (reply.status !== 200) { throw responseError(reply, ''); }
    return record(reply.body);
  }

  /** Все страницы читаются последовательно; повторённый cursor не создаёт бесконечный цикл. */
  async pages(path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 10_000; page += 1) {
      const params = new URLSearchParams({ ...query, ...(cursor ? { cursor } : {}) });
      const reply = await this.get(path + (params.size ? '?' + params.toString() : ''));
      if (!Array.isArray(reply.items)) { throw new Error('invalid_page'); }
      rows.push(...reply.items.map(record));
      if (reply.nextCursor === null || reply.nextCursor === undefined) { return rows; }
      if (typeof reply.nextCursor !== 'string' || !reply.nextCursor || seen.has(reply.nextCursor)) {
        throw new DriverRequestError('invalid_cursor', 'Некорректная пагинация трекера', 502);
      }
      cursor = reply.nextCursor;
      seen.add(cursor);
    }

    throw new DriverRequestError('page_limit', 'Превышен предел страниц трекера', 502);
  }
}
