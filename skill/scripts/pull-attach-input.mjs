#!/usr/bin/env node
// attach 入力は room 台帳（member 行の本人性欄）だけから作る。呼び出し側の pid 推定を受け付けない。
// usage: pull-attach-input.mjs <project_dir> <name> [refusedPid]
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const fail = (code, message) => {
  process.stderr.write(`${code}: ${message}\n`)
  process.exit(2)
}

const [projectDir, name, maybePid] = process.argv.slice(2)
if (!projectDir || !name) fail('ATTACH_INPUT_ARGS', 'usage: pull-attach-input.mjs <project_dir> <name> [refusedPid]')

let setup
try {
  setup = JSON.parse(readFileSync(join(resolve(projectDir), '.team', 'setup-state.json'), 'utf8'))
} catch (error) {
  fail('ATTACH_INPUT_STATE_UNREADABLE', error.message)
}

let member
try {
  const response = await fetch(`${setup.server_url.replace(/\/$/u, '')}/api/${encodeURIComponent(setup.room)}/members/${encodeURIComponent(name)}`)
  if (!response.ok) fail('ATTACH_INPUT_MEMBER_MISSING', `台帳に ${name} が無い（HTTP ${response.status}）`)
  member = (await response.json()).member
} catch (error) {
  if (error?.code === undefined) fail('ATTACH_INPUT_LEDGER_UNREACHABLE', String(error?.message ?? error))
  throw error
}

const pid = member.pid
if (!Number.isSafeInteger(pid) || pid < 1) fail('ATTACH_INPUT_NO_PID', '台帳の member 行に pid が無い')
if (maybePid !== undefined && Number(maybePid) !== pid) {
  fail('WORKER_IDENTITY_MISMATCH',
    `invented pid ${maybePid} is not the ledger pid ${pid}（実行層死亡ではない）`)
}
if (!member.started_identity || !member.argv_digest) {
  fail('ATTACH_INPUT_IDENTITY_INCOMPLETE', '台帳の member 行に started_identity / argv_digest が無い')
}

// `session` は席名。tmux 名（peer-<name>）を入れると Lattice の attach が
// `WORKER_ACTOR_MISMATCH` で必ず拒否される（actor session は LATTICE_TODO_ACTOR_SESSION=<name>）。
const input = {
  schema: 'lattice.pull_worker_attach_input.v1',
  name: member.name,
  session: member.name,
  pid,
  started_identity: member.started_identity,
  argv_digest: member.argv_digest,
  recorded_at: member.identity_recorded_at,
}
process.stdout.write(`${JSON.stringify(input)}\n`)
