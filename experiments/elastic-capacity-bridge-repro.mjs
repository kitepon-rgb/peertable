#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const bridgeScript = join(repo, 'skill/scripts/capacity-bridge.mjs')
const root = await mkdtemp(join(tmpdir(), 'peertable-capacity-bridge-'))
const project = join(root, 'project')
const team = join(project, '.team')
const latticeState = join(root, 'lattice-state.json')
const latticeStub = join(root, 'lattice-stub.mjs')
const token = 'capacity-bridge-fixture-token'
const room = 'capacity-bridge-fixture'
const posts = []
const joinedMembers = []
let members = [
  { name: 'bell', status: null },
  { name: 'busy', status: 'busy' },
  { name: 'idle', status: 'idle' },
]

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid')
  response.setHeader('content-type', 'application/json')
  if (request.method === 'GET' && url.pathname.endsWith('/members')) {
    response.end(JSON.stringify({ members }))
    return
  }
  if (request.method === 'GET' && url.pathname.endsWith('/messages')) {
    response.end(JSON.stringify({ messages: posts.map((message, index) => ({ ...message, seq: index + 1 })) }))
    return
  }
  if (request.method === 'POST' && url.pathname.endsWith('/messages')) {
    if (request.headers['x-peertable-token'] !== token) {
      response.writeHead(403).end(JSON.stringify({ error: 'forbidden' }))
      return
    }
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      posts.push(JSON.parse(raw))
      response.end(JSON.stringify({ ...posts.at(-1), seq: posts.length }))
    })
    return
  }
  if (request.method === 'POST' && url.pathname.endsWith('/members')) {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      joinedMembers.push(JSON.parse(raw))
      response.end(JSON.stringify({ ok: true }))
    })
    return
  }
  response.writeHead(404).end(JSON.stringify({ error: 'not found' }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const serverUrl = `http://127.0.0.1:${server.address().port}`

await mkdir(team, { recursive: true })
await writeFile(join(team, 'setup-state.json'), `${JSON.stringify({
  room, server_url: serverUrl, mode: 'lattice', lattice_cli: latticeStub,
})}\n`)
await writeFile(latticeStub, `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const state = JSON.parse(readFileSync(process.env.CAPACITY_FIXTURE_STATE, 'utf8'))
const args = process.argv.slice(2)
if (args[0] === 'todo' && args[1] === 'status') process.stdout.write(JSON.stringify(state.status))
else if (args[0] === 'todo' && args[1] === 'independence') {
  const plan = args[args.indexOf('--plan') + 1]
  process.stdout.write(JSON.stringify(state.projections[plan]))
} else process.exit(2)
`)
await chmod(latticeStub, 0o755)

const env = { ...process.env, PEERTABLE_POST_TOKEN: token, CAPACITY_FIXTURE_STATE: latticeState }
const runOnce = () => new Promise(resolve => {
  const child = spawn(process.execPath, [bridgeScript, project, '--once'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('close', status => resolve({ status, stdout, stderr }))
})
const runProcess = (command, args, options = {}) => new Promise(resolve => {
  const child = spawn(command, args, {
    env: options.env ?? env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('close', status => resolve({ status, stdout, stderr }))
})
const checks = []
const check = (label, fn) => {
  try { fn(); checks.push(true); console.log(`ok: ${label}`) }
  catch (error) { checks.push(false); console.error(`NG: ${label}: ${error.message}`) }
}

try {
  await writeFile(latticeState, `${JSON.stringify({
    status: {
      active_set: ['a1', 'a2', 'a3'].map(task_id => ({ plan_key: 'plan', task_id })),
      next_ready: ['r1', 'r2'].map(task_id => ({ plan_key: 'plan', task_id })),
      parallel_candidates: [],
    },
    projections: {
      plan: {
        plan_key: 'plan', coverage: 'verified',
        frontier: {
          unknown: [], parallel_groups: [{ task_ids: ['r1', 'r2'] }],
          serialize_pairs: [], conflicts_with_active: [],
        },
      },
    },
  })}\n`)

  const first = await runOnce()
  check('実process境界でcapacity増員DMを一通送る', () => {
    assert.equal(first.status, 0, first.stderr)
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].to, ['bell', 'idle'])
    assert.match(posts[0].body, /action=scale_up_and_reclaim/u)
    assert.match(posts[0].body, /launch=3/u)
  })

  const repeated = await runOnce()
  check('同じ状態の再process・再pollはDMを重複しない', () => {
    assert.equal(repeated.status, 0, repeated.stderr)
    assert.equal(posts.length, 1)
  })

  await writeFile(latticeState, `${JSON.stringify({
    status: {
      active_set: [{ plan_key: 'plan', task_id: 'a1' }],
      next_ready: [],
      parallel_candidates: [],
    },
    projections: {},
  })}\n`)
  const shrink = await runOnce()
  check('frontier収束はidleだけを候補にした縮退DMになる', () => {
    assert.equal(shrink.status, 0, shrink.stderr)
    assert.equal(posts.length, 2)
    assert.deepEqual(posts[1].to, ['bell'])
    assert.match(posts[1].body, /action=scale_down/u)
    assert.match(posts[1].body, /retire=1/u)
  })

  const bridge = spawn(process.execPath, [bridgeScript, project], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let bridgeOutput = ''
  bridge.stdout.on('data', chunk => { bridgeOutput += chunk })
  bridge.stderr.on('data', chunk => { bridgeOutput += chunk })
  const recordPath = join(team, 'capacity-bridge.json')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (existsSync(recordPath)) {
      const record = JSON.parse(readFileSync(recordPath, 'utf8'))
      if (record.ready_at) break
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  check('常駐は初回観測後だけready_atを立てる', () => {
    assert.ok(existsSync(recordPath), bridgeOutput)
    assert.ok(JSON.parse(readFileSync(recordPath, 'utf8')).ready_at, bridgeOutput)
  })
  const competing = await runOnce()
  check('live常駐と競合するonce観測はstate競合を作らずtyped拒否する', () => {
    assert.equal(competing.status, 1)
    assert.match(competing.stderr, /CAPACITY_BRIDGE_ALREADY_RUNNING/u)
  })
  const stopped = await runProcess(process.execPath, [bridgeScript, project, '--stop'])
  await Promise.race([once(bridge, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))])
  if (bridge.exitCode === null) bridge.kill('SIGKILL')
  check('stop入口は常駐停止・record/lock撤去を同じ境界で完了する', () => {
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.notEqual(bridge.exitCode, null)
    assert.equal(existsSync(recordPath), false)
    assert.equal(existsSync(`${recordPath}.lock`), false)
  })

  await writeFile(latticeState, `${JSON.stringify({
    status: {
      active_set: ['a1', 'a2'].map(task_id => ({ plan_key: 'plan', task_id })),
      next_ready: [],
      parallel_candidates: [],
    },
    projections: {},
  })}\n`)
  const beforeConcurrent = posts.length
  const concurrent = await Promise.all([runOnce(), runOnce()])
  check('同時once観測も差分計算からstate固定まで直列化して一通だけ送る', () => {
    assert.ok(concurrent.every(result => result.status === 0), JSON.stringify(concurrent))
    assert.equal(posts.length, beforeConcurrent + 1)
    assert.equal(existsSync(`${recordPath}.lock`), false)
  })

  const parentProject = join(root, 'parent-project')
  const parentScripts = join(root, 'parent-scripts')
  const fakeBin = join(root, 'fake-bin')
  const ensureLog = join(root, 'ensure.log')
  await mkdir(join(parentProject, '.team'), { recursive: true })
  await mkdir(parentScripts, { recursive: true })
  await mkdir(fakeBin, { recursive: true })
  await writeFile(join(parentProject, '.team/setup-state.json'), `${JSON.stringify({
    room, server_url: serverUrl, mode: 'standalone',
  })}\n`)
  await copyFile(join(repo, 'skill/scripts/parent-join.sh'), join(parentScripts, 'parent-join.sh'))
  await writeFile(join(parentScripts, 'ensure-bridge.sh'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$CAPACITY_FIXTURE_ENSURE_LOG"\n`)
  await writeFile(join(fakeBin, 'tmux'), `#!/bin/bash\ncase "$3" in\n  '#{socket_path}') printf '%s\\n' /tmp/capacity-fixture.sock ;;\n  '#{pane_id}') printf '%s\\n' %42 ;;\nesac\n`)
  await chmod(join(parentScripts, 'parent-join.sh'), 0o755)
  await chmod(join(parentScripts, 'ensure-bridge.sh'), 0o755)
  await chmod(join(fakeBin, 'tmux'), 0o755)

  const parentEnv = {
    ...env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    TMUX: 'capacity-fixture',
    CAPACITY_FIXTURE_ENSURE_LOG: ensureLog,
  }
  const joined = await runProcess('bash', [join(parentScripts, 'parent-join.sh'), parentProject, 'bell', '', '', 'codex'], { env: parentEnv })
  check('Codex親はname→descriptor配送bridge ready後にcapacityを起動する', () => {
    assert.equal(joined.status, 0, joined.stderr)
    const calls = readFileSync(ensureLog, 'utf8').trim().split('\n')
    assert.match(calls[0], / wakeup bell$/u)
    assert.match(calls[1], / capacity$/u)
    assert.equal(joinedMembers.at(-1)?.observe?.tmux_target, '%42')
  })

  await rm(ensureLog, { force: true })
  const noDescriptor = await runProcess('bash', [join(parentScripts, 'parent-join.sh'), parentProject, 'bell-undeliverable', '', '', 'codex'], {
    env: { ...parentEnv, TMUX: '' },
  })
  check('Codex親にdescriptorが無ければ初回DMをstate済みにせずcapacityを起動しない', () => {
    assert.equal(noDescriptor.status, 0, noDescriptor.stderr)
    assert.match(noDescriptor.stderr, /CAPACITY_BRIDGE_DELIVERY_NOT_READY/u)
    assert.equal(existsSync(ensureLog), false)
  })
} finally {
  await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}

console.log(`elastic capacity bridge repro: ${checks.filter(Boolean).length}/${checks.length} green`)
process.exit(checks.every(Boolean) ? 0 : 1)
