import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const skip = process.platform !== 'linux' || process.getuid?.() === 0;

function runSetup(t, { existing = false, installedNvm = false, downloadFails = false, failStep = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-setup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const nodeBin = path.join(root, 'node-bin');
  const nvmDir = path.join(root, 'nvm');
  const scriptDir = path.join(root, 'scripts');
  for (const directory of [bin, nodeBin, nvmDir, scriptDir]) fs.mkdirSync(directory);
  const script = path.join(scriptDir, 'setup-ubuntu.sh');
  fs.copyFileSync(new URL('../scripts/setup-ubuntu.sh', import.meta.url), script);
  const trace = path.join(root, 'trace');
  fs.writeFileSync(trace, '');
  const executable = (file, body) => fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  for (const command of ['bash', 'dirname', 'mktemp', 'rm', 'mkdir', 'cp']) {
    const source = ['/usr/bin', '/bin'].map(directory => path.join(directory, command)).find(file => fs.existsSync(file));
    assert.ok(source, `Missing system command: ${command}`);
    fs.symlinkSync(source, path.join(bin, command));
  }
  executable(path.join(nodeBin, 'node'), 'exit 0');
  for (const command of ['npm', 'npx']) {
    executable(path.join(nodeBin, command), `
printf '%s\\n' '${command} '"$*" >> "$SETUP_TEST_TRACE"
if [[ '${command} '"$*" == "$SETUP_TEST_FAIL_STEP" ]]; then exit 42; fi
`);
  }
  const nvmFixture = path.join(root, 'nvm-fixture');
  fs.writeFileSync(nvmFixture, `
nvm() {
  printf '%s\\n' "nvm $*" >> "$SETUP_TEST_TRACE"
  if [[ "nvm $*" == "$SETUP_TEST_FAIL_STEP" ]]; then return 42; fi
  export PATH="$SETUP_TEST_NODE_BIN:$PATH"
}
`);
  if (installedNvm) fs.copyFileSync(nvmFixture, path.join(nvmDir, 'nvm.sh'));
  const installer = path.join(root, 'installer');
  executable(installer, `
mkdir -p "$NVM_DIR"
cp "$SETUP_TEST_NVM_FIXTURE" "$NVM_DIR/nvm.sh"
printf 'install-nvm\\n' >> "$SETUP_TEST_TRACE"
`);
  executable(path.join(bin, 'curl'), downloadFails ? 'exit 22' : `
printf 'download-installer\\n' >> "$SETUP_TEST_TRACE"
cp "$SETUP_TEST_INSTALLER" "${'${!#}'}"
`);
  const result = spawnSync('/bin/bash', [script, '--login'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: existing ? `${nodeBin}:${bin}` : bin,
      NVM_DIR: nvmDir,
      BASH_ENV: '',
      SETUP_TEST_TRACE: trace,
      SETUP_TEST_NODE_BIN: nodeBin,
      SETUP_TEST_NVM_FIXTURE: nvmFixture,
      SETUP_TEST_INSTALLER: installer,
      SETUP_TEST_FAIL_STEP: failStep,
    },
  });
  return { ...result, steps: fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) };
}

const installSteps = ['npm ci', 'npx playwright install --with-deps chromium', 'npm run build', 'npm run login', 'npm run auth:check'];

test('Ubuntu setup installs missing Node/npm and logs in using the activated environment', { skip }, t => {
  const result = runSetup(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.steps, ['download-installer', 'install-nvm', 'nvm install 24', 'nvm use 24', ...installSteps]);
});

test('Ubuntu setup preserves an existing compatible Node/npm installation', { skip }, t => {
  const result = runSetup(t, { existing: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.steps, installSteps);
});

test('Ubuntu setup loads an existing nvm installation without downloading again', { skip }, t => {
  const result = runSetup(t, { installedNvm: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.steps, ['nvm install 24', 'nvm use 24', ...installSteps]);
});

test('Ubuntu setup stops when downloading the installer fails', { skip }, t => {
  const result = runSetup(t, { downloadFails: true });
  assert.equal(result.status, 22, result.stderr);
  assert.deepEqual(result.steps, []);
});

test('Ubuntu setup stops if dependency installation fails', { skip }, t => {
  const result = runSetup(t, { existing: true, failStep: 'npm ci' });
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(result.steps, ['npm ci']);
});

test('Ubuntu setup propagates nvm installation failures', { skip }, t => {
  const result = runSetup(t, { installedNvm: true, failStep: 'nvm install 24' });
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(result.steps, ['nvm install 24']);
});

test('Ubuntu setup skips auth verification after a failed login', { skip }, t => {
  const result = runSetup(t, { existing: true, failStep: 'npm run login' });
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(result.steps, installSteps.slice(0, -1));
});
