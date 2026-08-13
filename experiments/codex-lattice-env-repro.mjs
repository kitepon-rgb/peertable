#!/usr/bin/env node
// 正規Aiterm launcherへ、Peertable席のidentityとLattice actor変数名を渡す境界を固定する。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const launch = await readFile(resolve(root, 'skill/scripts/launch-seat.sh'), 'utf8')
const adapter = await readFile(resolve(root, 'skill/scripts/aiterm-launch.mjs'), 'utf8')

for (const name of [
  'PEERTABLE_MEMBER', 'PEERTABLE_PLAN', 'LATTICE_CLI',
  'LATTICE_TODO_ACTOR_HOST', 'LATTICE_TODO_ACTOR_SESSION', 'LATTICE_TODO_ACTOR_AGENT',
]) {
  assert.match(adapter, new RegExp(`['\"]${name}['\"]`), `${name}をenv_varsへ含める`)
}
assert.match(adapter, /if \(process\.env\.PEERTABLE_PLAN\) env_vars\.push\(/)
assert.match(adapter, /arguments:\s*\{[\s\S]*env_vars,/)
assert.match(launch, /LATTICE_TODO_ACTOR_SESSION=\$name/)
assert.match(launch, /launch_receipt=\$\(env -u PEERTABLE_POST_TOKEN "\$\{launch_env\[@\]\}" node "\$aiterm_launch_helper"/)
assert.doesNotMatch(launch, /cmd="codex /)

console.log('codex-lattice-env Aiterm boundary: 11/11 green')
