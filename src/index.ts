import type { TaskTracker, TrackerHost } from '../types/contract.ts';
import { Client, configuration, record } from './client.ts';
import { nativeIdentity, trackerIdentity, testAuthIdentity } from './identity.ts';
import { badInput, only, snapshot, taskInput, title } from './input.ts';
import { comment, id, task, text, type Directory } from './mapping.ts';
import { DriverRequestError, executeMutation, prepareMutation, type PreparedMutation } from './write.ts';

const capabilities = Object.freeze({
  create: true, editing: true, comments: true, complete: true, delete: true, renew: true,
  users: true, projects: true, checklist: true, tags: true, review: true,
  attachments: false, timer: false, widgets: false,
});

/** Справочник ограничен доступными проектами и не раскрывает скрытые аккаунты установки. */
async function directory(client: Client): Promise<Directory> {
  const projects = await client.pages('/api/v1/projects');
  const people = new Map<string, string>();
  const projectNames = new Map<string, string>();
  for (const project of projects) {
    const projectId = id(project.id);
    projectNames.set(projectId, text(project.title));
    const members = await client.pages('/api/v1/projects/' + projectId + '/members');
    for (const member of members) { people.set(id(member.id), text(member.displayName)); }
  }
  const me = await client.get('/api/v1/me');
  const user = record(me.user);
  people.set(id(user.id), text(user.displayName));
  return { people, projects: projectNames };
}

/** Один prepared wire принадлежит одному invocation; транспорт не перечитывает реквизиты. */
async function write(client: Client, me: unknown, method: PreparedMutation['method'], path: string,
  payload: unknown, version: unknown = null) {
  const identity = nativeIdentity(me);
  if (version !== null && typeof version !== 'string') {
    throw new DriverRequestError('invalid_version', 'Трекер не вернул версию ресурса', 502);
  }
  const prepared = prepareMutation(method, path, payload, version, identity.syncEpoch);
  return (await executeMutation(client.request, prepared, { signal: client.signal })).body;
}

/** Epoch фиксируется до чтения версии, conflict не вызывает получения новой версии для записи. */
async function mutation(host: TrackerHost) {
  const client = new Client(host, {}, true);
  const me = await client.get('/api/v1/me');
  const identity = nativeIdentity(me);
  client.bindIdentity(identity.installationId, identity.nativeUserId);
  return { client, me };
}

/** Текущий сервер отдаёт версию node внутри checklists; task.version здесь неприменима. */
async function nodeVersion(client: Client, taskId: string, nodeId: string): Promise<string> {
  const lists = await client.pages('/api/v1/tasks/' + taskId + '/checklists');
  for (const list of lists) {
    if (list.id === nodeId) { return text(list.version); }
    if (!Array.isArray(list.items)) { throw new Error('invalid_checklist'); }
    for (const candidate of list.items) {
      const item = record(candidate);
      if (item.id === nodeId) { return text(item.version); }
    }
  }
  throw new DriverRequestError('task_not_found', 'Пункт чек-листа недоступен', 404);
}

/** Выбирается ровно один разрешённый edge по kind, неоднозначность требует собственного web. */
async function transition(host: TrackerHost, value: string, kind: string) {
  const taskId = id(value);
  const { client, me } = await mutation(host);
  const path = '/api/v1/tasks/' + taskId + '/transitions';
  const available = await client.get(path);
  if (!Array.isArray(available.items)) { throw new Error('invalid_transitions'); }
  const edges = available.items.map(record).filter((edge) => edge.kind === kind);
  if (edges.length !== 1) {
    throw new DriverRequestError('transition_unavailable',
      'Однозначный разрешённый переход ' + kind + ' недоступен: откройте задачу в трекере', 409);
  }
  await write(client, me, 'POST', path, { transitionId: id(edges[0].id) }, available.version);
  return { ok: true, id: taskId };
}

/** Ответы записей не выдают native task DTO с потенциальными ссылками вложений. */
function nodeResult(value: unknown) {
  const result = record(value);
  return { ok: true, id: id(result.id), ...(typeof result.version === 'string'
    ? { version: result.version } : {}) };
}

export function createTracker(host: TrackerHost): TaskTracker {
  return {
    id: 'grigdesk-tasks', capabilities,
    isConfigured() {
      try { configuration(host.credentials.read()); return true; } catch { return false; }
    },
    async accountIdentity(options = {}) {
      const client = new Client(host, options);
      return trackerIdentity(client.config.baseUrl, await client.get('/api/v1/me'));
    },
    async testAuth() {
      try {
        const client = new Client(host);
        return testAuthIdentity(await client.get('/api/v1/me'));
      } catch (error) {
        return { ok: false,
          error: error instanceof DriverRequestError ? error.message : 'Некорректный ответ /me' };
      }
    },
    async listTasks(options = {}) {
      const client = new Client(host, options);
      const native = await client.pages('/api/v1/tasks', { view: 'assigned' });
      const names = await directory(client);
      return native.map((row) => task(row, names));
    },
    async taskDetail(value, options = {}) {
      const client = new Client(host, options);
      const native = await client.get('/api/v1/tasks/' + id(value));
      return task(native, await directory(client), true);
    },
    async getDashboard(options = {}) {
      const client = new Client(host, options);
      const assigned = await client.pages('/api/v1/tasks', { view: 'assigned' });
      const created = await client.pages('/api/v1/tasks', { view: 'created' });
      const review = await client.pages('/api/v1/tasks', { view: 'review' });
      const names = await directory(client);
      return {
        tasks: assigned.map((row) => task(row, names)), created: created.map((row) => task(row, names)),
        toReview: review.map((row) => task(row, names)), widgets: [],
      };
    },
    async taskPageData(value, options = {}) {
      const taskId = id(value);
      const client = new Client(host, options);
      const native = await client.get('/api/v1/tasks/' + taskId);
      const comments = await client.pages('/api/v1/tasks/' + taskId + '/comments');
      const projectTasks = await client.pages('/api/v1/tasks', { project: id(native.projectId) });
      const names = await directory(client);
      return {
        comments: comments.map((row) => comment(row, names)), attachments: [], tags: task(native, names).tags,
        subtasks: projectTasks.filter((row) => row.parentId === taskId).map((row) => ({
          id: id(row.id), title: text(row.title), statusText: text(record(row.status).title),
        })),
      };
    },
    async sourceUrl(value) {
      const taskId = id(value);
      const client = new Client(host);
      const me = await client.get('/api/v1/me');
      const web = record(me.installation).webUrl;
      if (typeof web !== 'string') { return ''; }
      let url: URL;
      try { url = new URL(web); } catch { return ''; }
      if (url.href.replace(/\/+$/u, '') !== client.config.baseUrl) { return ''; }
      return client.config.baseUrl + '/tasks/' + taskId;
    },
    async probeTaskNumber(value) {
      try {
        const client = new Client(host);
        const reply = await client.request('GET', '/api/v1/tasks/' + id(value), {});
        if (reply.status === 200 && id(record(reply.body).id) === id(value)) { return 'exists'; }
        return reply.status === 404 && ['task_not_found', 'project_not_found']
          .includes(String(record(reply.body).error)) ? 'absent' : 'unknown';
      } catch { return 'unknown'; }
    },
    async findUsers(query, options = {}) {
      const names = await directory(new Client(host, options));
      const search = query.trim().toLocaleLowerCase();
      return [...names.people].filter(([nativeId, name]) => name.toLocaleLowerCase().includes(search)
        || nativeId === search).map(([nativeId, name]) => ({ id: nativeId, name }));
    },
    async listGroups(options = {}) {
      const client = new Client(host, options);
      return (await client.pages('/api/v1/projects')).filter((project) => project.archived !== true)
        .map((project) => ({ id: id(project.id), name: text(project.title) }));
    },
    async createTask(value) {
      const input = snapshot(value);
      const { client, me } = await mutation(host);
      const payload = taskInput(input, true, nativeIdentity(me).nativeUserId);
      const result = record(await write(client, me, 'POST', '/api/v1/tasks', payload));
      return { ok: true, id: id(result.id), key: text(result.key) };
    },
    async updateTask(value, raw) {
      const taskId = id(value);
      const input = snapshot(raw);
      const { client, me } = await mutation(host);
      const payload = taskInput(input, false, nativeIdentity(me).nativeUserId);
      const path = '/api/v1/tasks/' + taskId;
      const current = await client.get(path);
      if (!Object.keys(payload).length) {
        badInput('Не передано изменений');
      }
      await write(client, me, 'PATCH', path, payload, current.version);
      return { ok: true, id: taskId };
    },
    async addComment(value, raw) {
      const taskId = id(value);
      if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > 65536) {
        badInput('Нужен непустой комментарий до 65536 UTF-8 bytes');
      }
      const payload = { text: raw };
      const { client, me } = await mutation(host);
      return nodeResult(await write(client, me, 'POST', '/api/v1/tasks/' + taskId + '/comments', payload));
    },
    async addChecklistItem(value, raw) {
      const taskId = id(value);
      const input = snapshot(raw);
      only(input, ['title', 'parentId']);
      const path = '/api/v1/tasks/' + taskId + '/checklists'
        + (input.parentId && input.parentId !== '0' ? '/' + id(input.parentId) + '/items' : '');
      const payload = { title: title(input.title) };
      const { client, me } = await mutation(host);
      return nodeResult(await write(client, me, 'POST', path, payload));
    },
    async updateChecklistItem(value, item, raw) {
      const taskId = id(value);
      const nodeId = id(item);
      const input = snapshot(raw);
      only(input, ['title', 'complete']);
      if (!Object.keys(input).length) { badInput('Не передано изменений пункта'); }
      if (Object.hasOwn(input, 'title')) { input.title = title(input.title); }
      if (Object.hasOwn(input, 'complete') && typeof input.complete !== 'boolean') {
        badInput('complete должен быть boolean');
      }
      const { client, me } = await mutation(host);
      const version = await nodeVersion(client, taskId, nodeId);
      return nodeResult(await write(client, me, 'PATCH',
        '/api/v1/tasks/' + taskId + '/checklist-nodes/' + nodeId, input, version));
    },
    async deleteChecklistItem(value, item) {
      const taskId = id(value);
      const nodeId = id(item);
      const { client, me } = await mutation(host);
      const version = await nodeVersion(client, taskId, nodeId);
      await write(client, me, 'DELETE', '/api/v1/tasks/' + taskId + '/checklist-nodes/' + nodeId,
        undefined, version);
      return { ok: true };
    },
    async updateTaskTags(value, raw) {
      const taskId = id(value);
      if (!Array.isArray(raw) || raw.length > 50
        || raw.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 100)) {
        badInput('Нужен массив до 50 непустых меток');
      }
      const tags = raw.map((tag) => tag.trim());
      if (new Set(tags).size !== tags.length) { badInput('Метки не должны повторяться'); }
      const { client, me } = await mutation(host);
      const path = '/api/v1/tasks/' + taskId;
      const current = await client.get(path);
      await write(client, me, 'PUT', path + '/tags', { tags }, current.version);
      return { ok: true, id: taskId };
    },
    completeTask: (value) => transition(host, value, 'submit'),
    approveTask: (value) => transition(host, value, 'approve'),
    disapproveTask: (value) => transition(host, value, 'reject'),
    renewTask: (value) => transition(host, value, 'reopen'),
    async deleteTask(value) {
      const taskId = id(value);
      const { client, me } = await mutation(host);
      const path = '/api/v1/tasks/' + taskId;
      const current = await client.get(path);
      await write(client, me, 'DELETE', path, undefined, current.version);
      return { ok: true };
    },
  };
}
