#!/usr/bin/env node
// a2: 正規着手入口が、成功したstartの後だけstarted task eventを一度送ることを測る。
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SETUP = path.join(ROOT, 'skill/scripts/setup.sh')
const START_TEMPLATE = path.join(ROOT, 'skill/templates/start.sh')

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

async function makeProject(prefix) {
  const project = await mkdtemp(path.join(tmpdir(), prefix))
  await run('git', ['init', '-q'], { cwd: project })
  await run('git', ['config', 'user.email', 'fixture@example.com'], { cwd: project })
  await run('git', ['config', 'user.name', 'fixture'], { cwd: project })
  await writeFile(path.join(project, 'README.md'), '# fixture\n')
  await run('git', ['add', 'README.md'], { cwd: project })
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: project })
  return project
}

async function updateState(project, values) {
  const statePath = path.join(project, '.team/setup-state.json')
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  await writeFile(statePath, JSON.stringify({ ...state, ...values }) + '\n')
}

async function fixtureServer() {
  const events = []
  const messages = []
  const requests = []
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: request.method, path: requestUrl.pathname, token: request.headers['x-peertable-token'] })
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET' && requestUrl.pathname.endsWith('/messages')) {
      response.end(JSON.stringify({ messages }))
      return
    }
    if (request.method === 'POST' && requestUrl.pathname.endsWith('/task-events')) {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const payload = JSON.parse(body)
        const existing = events.find(event => event.transition_id === payload.transition_id)
        if (!existing) events.push(payload)
        response.end(JSON.stringify({
          type: 'task_event',
          event_kind: 'started',
          seq: existing?.seq ?? events.length,
          idempotent: Boolean(existing),
        }))
      })
      return
    }
    response.end(JSON.stringify({ members: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${address.port}`, events, messages, requests }
}

async function makeFakeLattice(work) {
  const cli = path.join(work, 'fake-lattice.mjs')
  const log = path.join(work, 'lattice-args.jsonl')
  await writeFile(cli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_LATTICE_ARGS_FILE, JSON.stringify(args) + '\\n')
if (args[0] === 'todo' && args[1] === 'show') {
  console.log(JSON.stringify({ task: { title: '自動着手のfixture工程' } }))
  process.exit(0)
}
if (args[0] === 'todo' && args[1] === 'start') {
  if (process.env.FAKE_LATTICE_MODE === 'failure') {
    console.error(JSON.stringify({ code: 'START_REJECTED', message: '既着手または競合' }))
    process.exit(7)
  }
  console.log(JSON.stringify({ event_digest: 'fixture-start-digest-a2', sequence: 101, status: 'in-progress' }))
  process.exit(0)
}
console.error('unexpected fake lattice command')
process.exit(9)
`)
  await chmod(cli, 0o755)
  return { cli, log }
}

let ok = true
const check = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'pass' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) ok = false
}

const work = await mkdtemp(path.join(tmpdir(), 'peertable-task-start-'))
const { server, url, events, messages, requests } = await fixtureServer()
const fake = await makeFakeLattice(work)
const credential = path.join(work, 'seat.token')
await writeFile(credential, 'fixture-secret\n')
await chmod(credential, 0o600)
const probeLog = path.join(work, 'node-probe.log')
const probeSecretFile = path.join(work, 'probe-secret')
const nodeProbe = path.join(work, 'node')
await writeFile(probeSecretFile, 'fixture-secret\n')
await writeFile(nodeProbe, `#!/bin/bash
secret=$(tr -d '\\r\\n' < "$PROBE_SECRET_FILE")
if env | grep -F -- "$secret" >/dev/null || printf '%s\\n' "$*" | grep -F -- "$secret" >/dev/null; then
  printf 'TOKEN_LEAK\\n' >> "$PROBE_LOG"
fi
printf 'argv=%s\\n' "$*" >> "$PROBE_LOG"
exec "$REAL_NODE" "$@"
`)
await chmod(nodeProbe, 0o755)

try {
  check('start templateが存在する', (await stat(START_TEMPLATE)).isFile())

  const latticeProject = await makeProject('peertable-task-start-lattice-')
  const latticeSetup = await run('bash', [SETUP, latticeProject, 'start-room', 'http://127.0.0.1:1', 'plan-a2', ROOT], {
    env: { LATTICE_CLI: fake.cli },
  })
  check('Lattice setupが成功する', latticeSetup.code === 0, latticeSetup.stderr.trim().slice(-240))
  await updateState(latticeProject, { server_url: url, lattice_cli: fake.cli })
  const latticeStart = path.join(latticeProject, '.team/scripts/start.sh')
  check('Lattice setupがstart入口を生成する', (await stat(latticeStart)).isFile())
  check('Lattice start入口が実行可能', ((await stat(latticeStart)).mode & 0o111) !== 0)

  const commonEnv = {
    PEERTABLE_URL: url,
    PEERTABLE_ROOM: 'start-room',
    PEERTABLE_MEMBER: 'asahi',
    PEERTABLE_CREDENTIAL_FILE: credential,
    LATTICE_CLI: fake.cli,
    FAKE_LATTICE_ARGS_FILE: fake.log,
    FAKE_LATTICE_MODE: 'success',
    PATH: `${path.dirname(nodeProbe)}:${process.env.PATH}`,
    PROBE_LOG: probeLog,
    PROBE_SECRET_FILE: probeSecretFile,
    REAL_NODE: process.execPath,
  }
  const latticeStartResult = await run('bash', [latticeStart, 'a2', '--parallel-frontier'], {
    cwd: latticeProject,
    env: commonEnv,
  })
  check('Lattice start成功後にstartedを送る', latticeStartResult.code === 0 && events.length === 1, `${latticeStartResult.stdout}${latticeStartResult.stderr}`.trim())
  check('started payloadが工程正本とactorを持つ',
    events[0]?.kind === 'started' && events[0]?.plan_key === 'plan-a2' && events[0]?.task_id === 'a2'
      && events[0]?.title === '自動着手のfixture工程' && events[0]?.actor === 'asahi')
  check('started payloadが宛先・自由本文をcallerから受けない',
    !('to' in (events[0] ?? {})) && !('to_names' in (events[0] ?? {})) && !('body' in (events[0] ?? {})))
  const latticeProbeOutput = await readFile(probeLog, 'utf8')
  check('Latticeのcredentialが子processのargv/envへ露出しない', !latticeProbeOutput.includes('TOKEN_LEAK') && !latticeProbeOutput.includes('fixture-secret'))
  const latticeArgs = (await readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  check('--parallel-frontierが正規todo startへ保持される', latticeArgs.some(args => args.includes('--parallel-frontier')))
  check('task eventのtoken headerだけがcredentialを受け取る', requests.some(request => request.path.endsWith('/task-events') && request.token === 'fixture-secret'))

  const failedStart = await run('bash', [latticeStart, 'a2', '--parallel-frontier'], {
    cwd: latticeProject,
    env: { ...commonEnv, FAKE_LATTICE_MODE: 'failure' },
  })
  check('todo start失敗は非0で返る', failedStart.code === 7)
  check('todo start失敗ではstartedを送らない', events.length === 1)

  const standaloneProject = await makeProject('peertable-task-start-standalone-')
  const tasksFile = path.join(work, 'tasks.txt')
  await writeFile(tasksFile, '- solo-a: 単独卓の議題\n- solo-aa: 類似した別議題\n')
  const standaloneSetup = await run('bash', [SETUP, standaloneProject, 'standalone-room', 'http://127.0.0.1:1', '-', ROOT, tasksFile])
  check('standalone setupが成功する', standaloneSetup.code === 0, standaloneSetup.stderr.trim().slice(-240))
  await updateState(standaloneProject, { server_url: url })
  const standaloneStart = path.join(standaloneProject, '.team/scripts/start.sh')
  check('standalone setupがstart入口を生成する', (await stat(standaloneStart)).isFile())
  messages.push({ seq: 201, from: 'solo', body: '[claim] solo-a: 単独卓の議題' })
  const standaloneEnv = {
    PEERTABLE_URL: url,
    PEERTABLE_ROOM: 'standalone-room',
    PEERTABLE_MEMBER: 'solo',
    PEERTABLE_CREDENTIAL_FILE: credential,
    PATH: `${path.dirname(nodeProbe)}:${process.env.PATH}`,
    PROBE_LOG: probeLog,
    PROBE_SECRET_FILE: probeSecretFile,
    REAL_NODE: process.execPath,
  }
  const standaloneResult = await run('bash', [standaloneStart, 'solo-a'], {
    cwd: standaloneProject,
    env: standaloneEnv,
  })
  check('standalone start成功後にstartedを送る', standaloneResult.code === 0 && events.length === 2, `${standaloneResult.stdout}${standaloneResult.stderr}`.trim())
  check('standalone payloadが議題表からtitleを解決する',
    events[1]?.plan_key === 'standalone' && events[1]?.task_id === 'solo-a'
      && events[1]?.title === 'solo-a: 単独卓の議題' && events[1]?.actor === 'solo')
  const standaloneRetry = await run('bash', [standaloneStart, 'solo-a'], {
    cwd: standaloneProject,
    env: standaloneEnv,
  })
  check('同じstandalone claimの再試行はstartedを重複登録しない',
    standaloneRetry.code === 0 && standaloneRetry.stdout.includes('already sent') && events.length === 2)
  messages.push({ seq: 202, from: 'solo', body: '[claim] solo-a: 再着席' })
  const standaloneReopen = await run('bash', [standaloneStart, 'solo-a'], {
    cwd: standaloneProject,
    env: standaloneEnv,
  })
  check('新しいstandalone claimは新しいtransitionになる',
    standaloneReopen.code === 0 && events.length === 3
      && events[2]?.transition_id !== events[1]?.transition_id)
  messages.splice(0, messages.length, { seq: 203, from: 'solo', body: '[claim] solo-aa: 類似した別議題' })
  const partialClaim = await run('bash', [standaloneStart, 'solo-a'], {
    cwd: standaloneProject,
    env: standaloneEnv,
  })
  check('類似taskのclaim部分一致を受けない', partialClaim.code !== 0 && events.length === 3)
  const standaloneExtraOption = await run('bash', [standaloneStart, 'solo-a', '--parallel-frontier'], {
    cwd: standaloneProject,
    env: standaloneEnv,
  })
  check('standaloneでLattice optionを受けない', standaloneExtraOption.code !== 0 && events.length === 3)
  const startOutputs = [latticeStartResult, failedStart, standaloneResult, standaloneRetry, standaloneReopen, partialClaim, standaloneExtraOption]
  check('全start結果のstdout/stderrへcredentialが露出しない', startOutputs.every(result =>
    !result.stdout.includes('fixture-secret') && !result.stderr.includes('fixture-secret')))
  const probeOutput = await readFile(probeLog, 'utf8')
  check('全modeの子process argv/envへcredentialが露出しない', !probeOutput.includes('TOKEN_LEAK') && !probeOutput.includes('fixture-secret'))
} finally {
  await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
}

console.log(`task start repro: ${ok ? 'green' : 'red'}`)
if (!ok) process.exitCode = 1
