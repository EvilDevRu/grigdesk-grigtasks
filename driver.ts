import type { TaskTracker, TrackerHost } from './types/contract.ts';
import { createTracker } from './src/index.ts';

/** Contract1 использует host.fetch и локальный снимок типов без runtime-импортов ядра. */
export default function createDriver(host: TrackerHost): TaskTracker {
  return createTracker(host);
}
