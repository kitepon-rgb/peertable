#!/usr/bin/env node
// c1: 現行の正規launchがAiterm managed-agent session_idを供給するかを固定する。
// この時点では製品を直さない。c2はこの実測に従い、必要なら最小adapterを所有する。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const launch = await readFile(resolve(root, 'skill/scripts/launch-seat.sh'), 'utf8')
const checks = []
const check = (name, fn) => {
  fn()
  checks.push(name)
}

check('正規launchは席名からtmux targetを作る', () => {
  assert.match(launch, /sess="peer-\$name"/)
  assert.match(launch, /tmux -S "\$sock" new-session -d -s "\$sess"/)
})

check('Claude／Codexはtmux paneへ直接起動する', () => {
  assert.match(launch, /cmd="claude --model \$model"/)
  assert.match(launch, /cmd="codex --model \$model -C \$proj/)
  assert.match(launch, /tmux -S "\$sock" send-keys -t "\$sess" "\$cmd" Enter/)
})

check('room metadataの観測記述子はtmux socket/targetだけである', () => {
  const meta = launch.match(/body = \{'name': name,[\s\S]*?print\(json\.dumps\(body\)\)/)?.[0]
  assert.ok(meta, 'member metadata生成部が見つかる')
  assert.match(meta, /'tmux_socket': sock, 'tmux_target': sess/)
  assert.doesNotMatch(meta, /session_id|agent_session|vendor_session/)
})

check('現行launchはagent_configureへ渡すsession_idを生成しない', () => {
  const executable = launch.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(executable, /agent_configure|agent-configure/)
})

console.log(`live-seat-config c1 boundary: ${checks.length}/${checks.length} green`)
