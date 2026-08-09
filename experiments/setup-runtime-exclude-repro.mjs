#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(ROOT, 'skill', 'scripts', 'setup.sh');
const TEARDOWN = path.join(ROOT, 'skill', 'scripts', 'teardown.sh');
const RUNTIME_EXCLUDE = '/.lattice/runtime/';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url?.endsWith('/members')) {
      response.end(JSON.stringify({ members: [{ name: 'fixture-seat' }] }));
      return;
    }
    if (request.method === 'DELETE') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function makeFixture(root, name, url, { preexistingRuntimeExclude = false } = {}) {
  const project = path.join(root, name);
  const bin = path.join(root, `${name}-bin`);
  await mkdir(path.join(project, '.git', 'info'), { recursive: true });
  await mkdir(path.join(project, '.lattice'), { recursive: true });
  await mkdir(bin, { recursive: true });
  const exclude = ['.team/', '/.mcp.json'];
  if (preexistingRuntimeExclude) exclude.push(RUNTIME_EXCLUDE);
  await writeFile(path.join(project, '.git', 'info', 'exclude'), `${exclude.join('\n')}\n`);
  await writeFile(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(path.join(project, '.git', 'refs', 'heads'), { recursive: true });
  // setupのgit-root検査には実repositoryが必要なので、最小commitを作る。
  assert.equal((await run('git', ['init', '--quiet', '--initial-branch=main'], { cwd: project })).code, 0);
  const identity = {
    schema: 'lattice.project_identity.v1',
    project_id: name,
    display_name: name,
    external_pane: {
      title: '円卓', url: `${url}/${name}`, probe_url: `${url}/api/${name}/members`,
    },
  };
  await writeFile(path.join(project, '.lattice', 'project.json'), `${JSON.stringify(identity, null, 2)}\n`);
  assert.equal((await run('git', ['add', '.lattice/project.json'], { cwd: project })).code, 0);
  assert.equal((await run('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid',
    'commit', '--quiet', '-m', 'base'], { cwd: project })).code, 0);

  const cli = path.join(bin, 'lattice');
  const adapter = path.join(bin, 'lattice-work-order-adapter.mjs');
  const registrationCapture = path.join(bin, 'registration.json');
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "adapter" ] && [ "$3" = "register" ] && [ "$4" = "--input" ]; then
  cp "$5" "$LATTICE_FIXTURE_REGISTRATION_CAPTURE"
fi
printf '{"schema":"fixture.adapter_registration.v1"}\\n'
`);
  await writeFile(adapter, '#!/bin/sh\nexit 0\n');
  await chmod(cli, 0o755);
  await chmod(adapter, 0o755);
  return { project, cli, adapter, registrationCapture };
}

async function excludeLines(project) {
  return (await readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8'))
    .split('\n').filter(Boolean);
}

async function setupFixture(fixture, room, url) {
  const result = await run('bash', [SETUP, fixture.project, room, url, 'fixture-plan', ROOT], {
    env: {
      LATTICE_CLI: fixture.cli,
      LATTICE_WORK_ORDER_ADAPTER_BINARY: fixture.adapter,
      LATTICE_FIXTURE_REGISTRATION_CAPTURE: fixture.registrationCapture,
      PEERTABLE_PUBLIC_URL: url,
    },
  });
  assert.equal(result.code, 0, `setup failed\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(await readFile(path.join(fixture.project, '.team', 'setup-state.json'), 'utf8'));
}

async function teardownFixture(fixture) {
  const result = await run('bash', [TEARDOWN, fixture.project, '--purge'], {
    env: { PEERTABLE_POST_TOKEN: 'fixture-token' },
  });
  assert.equal(result.code, 0, `teardown failed\n${result.stdout}\n${result.stderr}`);
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'peertable-runtime-exclude-'));
const { server, url } = await makeServer();
try {
  const added = await makeFixture(temporaryRoot, 'runtime-added', url);
  const addedState = await setupFixture(added, 'runtime-added', url);
  const registration = JSON.parse(await readFile(added.registrationCapture, 'utf8'));
  assert.equal(registration.binary_path, await realpath(process.execPath));
  assert.deepEqual(registration.argv, [await realpath(added.adapter)]);
  assert.notEqual(registration.binary_path, registration.argv[0],
    'shebang scriptをnative executableとして登録している');
  assert.equal(addedState.runtime_preexisting, false);
  assert.equal(addedState.added_runtime_exclude, true);
  assert.equal((await excludeLines(added.project)).filter((line) => line === RUNTIME_EXCLUDE).length, 1);
  assert.equal((await run('git', ['status', '--short'], { cwd: added.project })).stdout, '',
    'runtime stateをsetupしたcanonical treeがcleanでない');

  // 欠陥版の測定器: runtime excludeだけを外せば、同じfixtureが実際にdirtyになる。
  const withoutRuntime = (await excludeLines(added.project)).filter((line) => line !== RUNTIME_EXCLUDE);
  await writeFile(path.join(added.project, '.git', 'info', 'exclude'), `${withoutRuntime.join('\n')}\n`);
  assert.match((await run('git', ['status', '--short'], { cwd: added.project })).stdout,
    /\?\? \.lattice\/runtime\//u);
  await writeFile(path.join(added.project, '.git', 'info', 'exclude'),
    `${[...withoutRuntime, RUNTIME_EXCLUDE].join('\n')}\n`);

  await teardownFixture(added);
  assert.equal((await excludeLines(added.project)).includes(RUNTIME_EXCLUDE), false,
    'setupが足したruntime excludeがteardown後も残った');
  assert.equal((await run('git', ['status', '--short'], { cwd: added.project })).stdout, '',
    'teardown後にruntime stateが露出した');

  const preserved = await makeFixture(temporaryRoot, 'runtime-preserved', url, {
    preexistingRuntimeExclude: true,
  });
  const preservedState = await setupFixture(preserved, 'runtime-preserved', url);
  assert.equal(preservedState.added_runtime_exclude, false);
  assert.equal((await excludeLines(preserved.project)).filter((line) => line === RUNTIME_EXCLUDE).length, 1);
  await teardownFixture(preserved);
  assert.equal((await excludeLines(preserved.project)).filter((line) => line === RUNTIME_EXCLUDE).length, 1,
    'setup以前からあるruntime excludeをteardownが消した');

  process.stdout.write('OK runtime stateはsetup中clean、追加excludeだけteardownで復元\n');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
