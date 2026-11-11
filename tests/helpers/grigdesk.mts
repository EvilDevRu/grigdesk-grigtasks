import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import type { TrackerHost } from '../../types/contract.ts';

export const grigdeskRoot = process.env.GRIGDESK_ROOT;
if (!grigdeskRoot || !path.isAbsolute(grigdeskRoot)) { throw new Error('GRIGDESK_ROOT required'); }
export const core = (relative: string) => import(pathToFileURL(path.join(grigdeskRoot!, relative)).href);
export const coreRequire = createRequire(path.join(grigdeskRoot, 'server/package.json'));

/** Реестр и HTTP facade читают копию поставляемых файлов только во временном каталоге. */
export async function facadeFixture(t: TestContext, host: TrackerHost) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tasks-driver-host-'));
  const drivers = path.join(directory, 'drivers');
  const installed = path.join(drivers, 'grigdesk-tasks');
  await mkdir(installed, { recursive: true });
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const name of ['driver.ts', 'driver.json', 'package.json', 'src', 'types']) {
    await cp(path.join(root, name), path.join(installed, name), { recursive: true });
  }
  const { TrackerRegistry } = await core('server/src/lib/trackers/registry.ts');
  const { TrackerFacade } = await core('server/src/lib/trackers/facade.ts');
  const { TrackerSettingsStore } = await core('server/src/lib/trackers/settingsStore.ts');
  const { default: trackerModule } = await core('server/src/modules/tracker/index.ts');
  const registry = new TrackerRegistry({ directory: drivers, host: () => host });
  const selection = new TrackerSettingsStore(path.join(directory, 'selection.json'));
  const tracker = new TrackerFacade({ registry, selection });
  const app = coreRequire('fastify')({ logger: false });
  t.after(async () => {
    await app.close();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  });
  await registry.refresh();
  await registry.activate('grigdesk-tasks');
  selection.write('grigdesk-tasks');
  await app.register(trackerModule, { tracker });
  await app.ready();
  return { app, registry, tracker, selection, installed, directory };
}
