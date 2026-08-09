#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const BRIDGE = join(REPO, 'skill/scripts/run-bridge.mjs')
const TOKEN = 'run-bridge-explicit-recipients-token'
const ROOM = 'run-bridge-explicit-recipients'
const root = await mkdtemp(join(tmpdir(), 'run-bridge-explicit-recipients-'))
const project = join(root, 'project')
await mkdir(join(project, '.team'), { recursive: true })

const messages = []
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== `/api/${ROOM}/messages`) {
    res.writeHead(404).end('{}')
    return
  }
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const message = JSON.parse(raw)
    messages.push(message)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...message, seq: messages.length }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
await writeFile(join(project, '.team/setup-state.json'), `${JSON.stringify({ room: ROOM, server_url: url })}\n`)

const stub = join(root, 'lattice-stub.mjs')
await writeFile(stub, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'run' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ active_runs: [{ selection: 'pull', run_ref: '.lattice/runs/repro' }] }) + '\\n')
} else if (args[0] === 'run' && args[1] === 'observe') {
  process.stdout.write(JSON.stringify({
    closed: false,
    intakes: [
      { task_id: 'known', accepted_head_sha: null, worktree_path: '/tmp/known', actor: { agent: 'alice' }, intervention: { state: 'hold', reason: 'known conflict' } },
      { task_id: 'unknown', accepted_head_sha: null, worktree_path: '/tmp/unknown', actor: {}, intervention: { state: 'hold', reason: 'unknown owner' } }
    ]
  }) + '\\n')
} else {
  process.stderr.write('unsupported\\n')
  process.exit(2)
}
`)
await chmod(stub, 0o755)

const bridge = spawn(process.execPath, [BRIDGE, project, '--lattice', stub], {
  env: { ...process.env, PEERTABLE_POST_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
bridge.stdout.on('data', chunk => { output += chunk })
bridge.stderr.on('data', chunk => { output += chunk })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (label, condition, detail = '') => {
  checks.push(condition)
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
}

try {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (messages.length >= 1 && output.includes('RUN_BRIDGE_RECIPIENT_UNKNOWN') && output.includes('run 進行:')) break
    if (bridge.exitCode !== null) break
    await sleep(50)
  }

  check('既知の介入は本人だけへ明示DM', messages.length === 1
    && messages[0].to === 'alice' && !('to_names' in messages[0]), JSON.stringify(messages))
  check('roomへbroadcastを作らない', messages.every(message => message.to !== 'all'))
  check('介入本文を明示DMへ載せる', messages[0]?.body.startsWith('[介入] known — hold') === true)
  check('宛先不明はtyped local error', output.includes('RUN_BRIDGE_RECIPIENT_UNKNOWN'))
  check('run進行はlocal logだけへ記録', output.includes('run 進行: .lattice/runs/repro')
    && !messages.some(message => message.body?.startsWith('[run] ')))
} finally {
  if (bridge.exitCode === null) bridge.kill('SIGTERM')
  await Promise.race([once(bridge, 'exit'), sleep(1_000)])
  if (bridge.exitCode === null) bridge.kill('SIGKILL')
  await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}

process.exit(checks.every(Boolean) ? 0 : 1)
