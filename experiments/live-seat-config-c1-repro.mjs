#!/usr/bin/env node
// c1: Aiterm公開面とPeertable正規launchの相関を固定する。
// r1以降、正規launchはAiterm managed-agent session_idをroom memberへ保持する。
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

check('正規launchは席名からAiterm session targetを作る', () => {
  assert.match(launch, /sess="peer-\$name"/)
  assert.match(launch, /node "\$aiterm_launch_helper" "\$sess" "\$vendor" "\$model" "\$effort" "\$proj" "\$brief"/)
})

check('Claude／Codex／Grokのdirect CLI launchへfallbackしない', () => {
  assert.doesNotMatch(launch, /cmd="claude --model \$model"/)
  assert.doesNotMatch(launch, /cmd="codex --model \$model -C \$proj/)
  assert.doesNotMatch(launch, /cmd="grok --model \$model/)
})

check('room metadataはAiterm sessionとtmux観測記述子を保持する', () => {
  const meta = launch.match(/body = \{'name': name,[\s\S]*?print\(json\.dumps\(body\)\)/)?.[0]
  assert.ok(meta, 'member metadata生成部が見つかる')
  assert.match(meta, /'tmux_socket': sock, 'tmux_target': sess/)
  assert.match(meta, /'aiterm_session_id': aiterm_session_id/)
})

check('launchは設定変更を直接実行しない', () => {
  const executable = launch.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(executable, /agent_configure|agent-configure/)
})

console.log(`live-seat-config c1 boundary: ${checks.length}/${checks.length} green`)
