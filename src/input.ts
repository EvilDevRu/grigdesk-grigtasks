import { record } from './client.ts';
import { id } from './mapping.ts';
import { DriverRequestError } from './write.ts';

export function badInput(message: string): never {
  throw new DriverRequestError('b24_bad_request', message, 400);
}

/** Пользовательский объект копируется до первого await, чтобы поздняя правка не меняла запрос. */
export function snapshot(value: unknown): Record<string, unknown> {
  try {
    return structuredClone(record(value));
  } catch {
    return badInput('Поля должны быть объектом данных');
  }
}

export function only(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    badInput('Переданы неподдерживаемые поля');
  }
}

export function title(value: unknown, maximum = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    return badInput('Проверьте непустой заголовок и его длину');
  }
  return value.trim();
}

export function participantIds(value: unknown): string[] {
  if (value === '' || value === null) { return []; }
  if (!Array.isArray(value) || value.length > 100) { return badInput('Нужен массив ID участников'); }
  const ids = value.map(id);
  if (new Set(ids).size !== ids.length) { return badInput('Участники не должны повторяться'); }
  return ids;
}

/** Contract1 преобразуется в native fields без молчаливой потери неподдерживаемых полей. */
export function taskInput(input: Record<string, unknown>, create: boolean, actorId: string) {
  only(input, ['title', 'description', 'groupId', 'responsibleId', 'priority', 'deadline',
    'createdById', 'parentId', 'accomplices', 'auditors', 'images', 'frames', 'clips']);
  const result: Record<string, unknown> = {};
  if (!create && Object.hasOwn(input, 'groupId')) {
    badInput('Перенос задачи между проектами недоступен');
  }
  if (input.createdById !== null && input.createdById !== undefined && id(input.createdById) !== actorId) {
    badInput('Создание или правка от имени другого постановщика недоступны');
  }
  for (const field of ['images', 'frames', 'clips']) {
    if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].length > 0)) {
      badInput('Вложения доступны в собственном web GrigTasks');
    }
  }
  if (create || Object.hasOwn(input, 'title')) { result.title = title(input.title); }
  if (create) { result.projectId = id(input.groupId); }
  if (Object.hasOwn(input, 'description')) {
    if (typeof input.description !== 'string' || Buffer.byteLength(input.description) > 65536) {
      badInput('Описание должно быть строкой до 65536 UTF-8 bytes');
    }
    result.description = input.description;
  }
  if (Object.hasOwn(input, 'responsibleId')) {
    result.assigneeId = input.responsibleId === null ? null : id(input.responsibleId);
  }
  if (Object.hasOwn(input, 'parentId')) {
    result.parentId = input.parentId === null ? null : id(input.parentId);
  }
  if (Object.hasOwn(input, 'deadline')) {
    const due = input.deadline;
    if (due !== null && (typeof due !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/u.test(due)
      || !Number.isFinite(Date.parse(due)))) {
      badInput('Срок должен быть ISO-датой или null');
    }
    result.dueAt = due === null ? null : new Date(due as string).toISOString();
  }
  // Участники входят в ту же native мутацию и receipt, что поля задачи.
  // Отсутствие сохраняет связи, явный [] очищает только выбранную группу.
  if (Object.hasOwn(input, 'accomplices')) {
    result.accompliceIds = participantIds(input.accomplices);
  }
  if (Object.hasOwn(input, 'auditors')) {
    result.observerIds = participantIds(input.auditors);
  }
  if (Object.hasOwn(input, 'priority')) {
    const priority = ['low', 'normal', 'high'][Number(input.priority)];
    if (!priority || !['number', 'string'].includes(typeof input.priority)
      || !['0', '1', '2'].includes(String(input.priority))) { badInput('Приоритет: 0, 1 или 2'); }
    result.priority = priority;
  }
  return result;
}
