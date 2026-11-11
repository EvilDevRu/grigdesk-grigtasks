import { record } from './client.ts';
import { DriverRequestError } from './write.ts';
import type { TaskData } from '../types/contract.ts';

export type Directory = { people: Map<string, string>; projects: Map<string, string> };

/** Native ID остаётся десятичной строкой, допустимой в старых числовых формах. */
export function id(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d*$/u.test(String(value))
    || !Number.isSafeInteger(Number(value))) {
    throw new DriverRequestError('b24_bad_request', 'Нужен положительный числовой ID', 400);
  }

  return String(value);
}

/** Описание API является обычным текстом; HTML renderer GrigDesk получает экранированный текст. */
export function plainText(value: unknown): string {
  const entities: Record<string, string> = {
    '&': '&#38;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  };
  return text(value).replace(/[&<>"']/gu, (symbol) => entities[symbol]);
}

export function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DriverRequestError('invalid_response', 'Некорректное текстовое поле трекера', 502);
  }
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new DriverRequestError('invalid_response', 'Некорректный список трекера', 502);
  }
  return value.map(record);
}

function person(value: unknown, directory: Directory): TaskData | null {
  if (value === null || value === undefined) { return null; }
  const nativeId = id(value);
  return { id: nativeId, name: directory.people.get(nativeId) ?? nativeId };
}

/** Roots и items используют общий namespace и не теряют false/position:0. */
export function checklist(value: unknown): TaskData[] {
  return rows(value).flatMap((list) => [
    {
      id: id(list.id), parentId: '0', title: text(list.title), sortIndex: list.position,
      isComplete: 'N', isImportant: 'N', version: list.version,
    },
    ...rows(list.items).map((item) => ({
      id: id(item.id), parentId: id(list.id), title: text(item.title), sortIndex: item.position,
      isComplete: item.complete === true ? 'Y' : 'N', isImportant: 'N', version: item.version,
    })),
  ]);
}

/**
 * Native statusId/category сохраняются независимо от compatibility status старой карточки.
 * Отмена сохраняет собственную подпись и использует legacy5 для доступности renew.
 */
export function task(value: unknown, directory: Directory, detail = false): TaskData {
  const native = record(value);
  const status = record(native.status);
  const kind = text(status.kind);
  const category = text(status.category);
  const completed = ['done', 'cancelled'].includes(kind) || ['done', 'cancelled'].includes(category);
  const review = kind === 'review';
  const todo = kind === 'new' || category === 'todo';
  const responsible = person(native.assigneeId, directory);
  const projectId = id(native.projectId);
  const group = directory.projects.get(projectId) ?? projectId;
  const accomplices = rowsOfIds(native.accompliceIds);
  const auditors = rowsOfIds(native.observerIds);
  const due = native.dueAt === null ? null : text(native.dueAt);

  return {
    id: id(native.id), key: text(native.key), title: text(native.title),
    description: plainText(native.description), rawDescription: text(native.description),
    projectId, version: native.version, status: review ? 4 : completed ? 5 : todo ? 2 : 3,
    statusId: id(status.id), statusCategory: category,
    statusKind: review ? 'await_acceptance' : kind === 'cancelled' || category === 'cancelled'
      ? 'cancelled' : completed ? 'done' : todo ? 'new' : 'in_progress',
    nativeStatusKind: kind, statusText: text(status.title), statusLabel: text(status.title),
    deadline: due, priority: ['low', 'normal', 'high'].indexOf(text(native.priority)),
    createdAt: native.createdAt, updatedAt: native.updatedAt,
    overdue: Boolean(due && Date.parse(due) < Date.now() && !completed),
    creator: person(native.creatorId, directory), responsibleId: native.assigneeId,
    responsible: detail ? responsible : responsible?.name ?? null,
    ...(detail ? { group_id: projectId, group_name: group } : { group }),
    parentId: native.parentId === null ? null : id(native.parentId),
    accomplices, auditors,
    accomplicesData: accomplices.map((nativeId) => person(nativeId, directory)),
    auditorsData: auditors.map((nativeId) => person(nativeId, directory)),
    tags: rows(native.tags).map((tag) => text(tag.title)),
    ...(detail ? { checklist: checklist(native.checklists) } : {}),
  };
}

function rowsOfIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new DriverRequestError('invalid_response', 'Некорректные участники трекера', 502);
  }
  return value.map(id);
}

export function comment(value: unknown, directory: Directory): TaskData {
  const native = record(value);
  const author = person(native.authorId, directory);
  return {
    id: id(native.id), mid: id(native.id), authorId: id(native.authorId), author: author!.name,
    text: text(native.text), time: text(native.createdAt), isSystem: false, unread: false, attachments: [],
  };
}
