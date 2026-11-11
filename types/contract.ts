import type {
  TrackerCapabilities,
  TrackerSettingsSchema,
  TrackerWidget,
} from './capabilities.ts';

import type { TrackerIdentity } from './identity.ts';

export type { TrackerIdentity } from './identity.ts';

export type TaskData = Record<string, unknown>;
export type TaskRef = { trackerId: string; id: string };
export type TaskPresence = 'exists' | 'absent' | 'unknown';
export type ChecklistItemInput = { title: string; parentId?: string };
export type ChecklistItemUpdate = { title?: string; complete?: boolean };

export interface DriverManifest {
  id: string;
  name: string;
  version: string;
  contract: 1;
  settings: TrackerSettingsSchema;
}

export interface TrackerReadOptions {
  signal?: AbortSignal;
}

export interface TrackerReadTrace {
  operation: 'identity' | 'dashboard' | 'task' | 'taskPage' | 'users' | 'groups' | 'probe';
  phase: 'queued' | 'started' | 'request' | 'headers' | 'settled';
  outcome?: 'success' | 'error' | 'cancelled' | 'timeout';
  ms?: number;
  waitMs?: number;
  attempt?: number;
  status?: number;
}

export interface TrackerHost {
  traceRead?(event: TrackerReadTrace): void;
  fetch?: typeof fetch;
  credentials: { read(): TaskData | null };
  dataDir: string;
  cookiePath: string;
  serial<T>(operation: () => Promise<T>): Promise<T>;
  logger: { info(message: string): void; warn(message: string): void };
}

export interface TrackerDashboard extends TaskData {
  tasks: TaskData[];
  toReview: TaskData[];
  created: TaskData[];
  accomplice?: TaskData[];
  auditor?: TaskData[];
  widgets: TrackerWidget[];
  compatibility?: TaskData;
}

export interface TaskTracker {
  id: string;
  capabilities: TrackerCapabilities;
  isConfigured(): boolean;
  accountIdentity(options?: TrackerReadOptions): Promise<TrackerIdentity | null>;
  testAuth(): Promise<{
    ok: boolean;
    userId?: number | null;
    error?: string;
  }>;
  listTasks(options?: TrackerReadOptions): Promise<TaskData[]>;
  taskDetail(id: string, options?: TrackerReadOptions): Promise<unknown>;
  getDashboard(options?: TrackerReadOptions): Promise<TrackerDashboard>;
  sourceUrl(id: string): Promise<string> | string;
  probeTaskNumber(id: string): Promise<TaskPresence>;
  taskPageData?(id: string, options?: TrackerReadOptions): Promise<unknown>;
  createTask?(input: TaskData): Promise<unknown>;
  updateTask?(id: string, input: unknown): Promise<unknown>;
  addComment?(id: string, text: unknown): Promise<unknown>;
  timer?(action: string, id: string): Promise<unknown>;
  completeTask?(id: string): Promise<unknown>;
  deleteTask?(id: string): Promise<{ ok: boolean }>;
  renewTask?(id: string): Promise<unknown>;
  addChecklistItem?(id: string, input: ChecklistItemInput): Promise<unknown>;
  updateChecklistItem?(id: string, itemId: string, input: ChecklistItemUpdate): Promise<unknown>;
  deleteChecklistItem?(id: string, itemId: string): Promise<unknown>;
  updateTaskTags?(id: string, tags: string[]): Promise<unknown>;
  approveTask?(id: string): Promise<unknown>;
  disapproveTask?(id: string): Promise<unknown>;
  findUsers?(query: string, options?: TrackerReadOptions): Promise<unknown>;
  listGroups?(options?: TrackerReadOptions): Promise<unknown>;
  dispose?(): Promise<void>;
}

export type TrackerFactory = (host: TrackerHost) => TaskTracker | Promise<TaskTracker>;

export class TrackerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
