import type { TrackerHost } from '../../types/contract.ts';

export const epoch = '5548c827-de54-411f-8de3-d1822f41efc2';
export const me = {
  user: { id: '1', displayName: 'Alice' },
  installation: {
    id: '77a2f654-39e0-4aa8-8e85-fbd1d43c23a0', syncEpoch: epoch,
    webUrl: 'https://tasks.example',
  },
};
export const nativeTask = {
  id: '81', projectId: '7', key: 'TEST-9', title: 'Task', description: '<plain>&text',
  creatorId: '1', assigneeId: '2', parentId: null, version: '7',
  priority: 'high', dueAt: '2027-01-01T12:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  status: { id: '93', kind: 'review', title: 'Review', category: 'active' },
  accompliceIds: ['1'], observerIds: ['2'], tags: [{ id: '1', title: 'Release' }],
  checklists: [{
    id: '41', title: 'Root', position: 0, version: '6', items: [{
      id: '42', listId: '41', title: 'Item', complete: true, position: 0, version: '3',
    }],
  }],
  attachments: [{ downloadUrl: 'https://must-not-escape.example/secret' }],
};

export type Call = { url: URL; init: RequestInit };
export type Handler = (call: Call) => unknown | Promise<unknown>;

/** Protocol fixture сохраняет wire и использует формы реального production API. */
export function protocol(handler?: Handler) {
  const calls: Call[] = [];
  let credentials: Record<string, unknown> = { baseUrl: 'https://tasks.example', apiToken: 'secret-token' };
  const host: TrackerHost = {
    credentials: { read: () => credentials }, dataDir: '/unused', cookiePath: '/unused',
    serial: async (work) => work(), logger: { info() {}, warn() {} },
    fetch: async (input, init = {}) => {
      const call = { url: new URL(String(input)), init };
      calls.push(call);
      const override = await handler?.(call);
      if (override instanceof Response) { return override; }
      if (override !== undefined) { return Response.json(override); }
      const path = call.url.pathname;
      if (path === '/api/v1/me') { return Response.json(me); }
      if (path === '/api/v1/projects') {
        return Response.json({ items: [{ id: '7', title: 'Project', key: 'TEST', archived: false }] });
      }
      if (path === '/api/v1/projects/7/members') {
        return Response.json({ items: [{ id: '1', displayName: 'Alice' }, { id: '2', displayName: 'Bob' }] });
      }
      if (path === '/api/v1/tasks/81/checklists') { return Response.json({ items: nativeTask.checklists }); }
      if (path === '/api/v1/tasks/81/transitions' && init.method === 'GET') {
        return Response.json({ version: '7', items: [{ id: '90', kind: 'approve' }] });
      }
      if (path === '/api/v1/tasks/81/comments') {
        return Response.json({ items: [{ id: '11', authorId: '2', text: 'Hello', createdAt: '2026-01-01' }] });
      }
      if (path === '/api/v1/tasks') {
        return Response.json({ items: [nativeTask], nextCursor: null });
      }
      if (path === '/api/v1/tasks/81') { return Response.json(nativeTask); }
      return Response.json({ error: 'task_not_found' }, { status: 404 });
    },
  };
  return { host, calls, credentials: (value: Record<string, unknown>) => { credentials = value; } };
}
