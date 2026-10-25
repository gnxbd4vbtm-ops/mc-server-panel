import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('requires paired TLS credentials and HTTPS for non-loopback binding', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'byte-panel-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certPath = path.join(directory, 'panel.crt');
  const keyPath = path.join(directory, 'panel.key');
  await writeFile(certPath, 'test certificate');
  await writeFile(keyPath, 'test private key');

  const configModule = pathToFileURL(path.resolve('src/config.js')).href;
  const runConfig = (overrides) => spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import('${configModule}').then(({config}) => console.log(config.tls !== null))`
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BSP_HOST: '127.0.0.1',
      BSP_TLS_CERT: '',
      BSP_TLS_KEY: '',
      ...overrides
    }
  });

  const lanWithoutTls = runConfig({ BSP_HOST: '0.0.0.0' });
  assert.notEqual(lanWithoutTls.status, 0);
  assert.match(lanWithoutTls.stderr, /Non-loopback BSP_HOST requires/);

  const unpairedTls = runConfig({ BSP_TLS_CERT: certPath });
  assert.notEqual(unpairedTls.status, 0);
  assert.match(unpairedTls.stderr, /must be supplied together/);

  const lanWithTls = runConfig({
    BSP_HOST: '0.0.0.0',
    BSP_TLS_CERT: certPath,
    BSP_TLS_KEY: keyPath
  });
  assert.equal(lanWithTls.status, 0, lanWithTls.stderr);
  assert.equal(lanWithTls.stdout.trim(), 'true');
});
