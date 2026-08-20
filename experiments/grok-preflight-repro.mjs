#!/usr/bin/env node
// grok -p ping が user config の MCP（booth 120s）を待つ退行を止める。
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launch = readFileSync(join(root, 'skill/scripts/launch-seat.sh'), 'utf8')
const grokArm = launch.slice(launch.indexOf('  grok)'), launch.indexOf('  *) echo "unknown vendor'))

let ok = true
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

check('launch-seat に grok 腕がある', grokArm.includes('grok_bin='))
check('席専用 GROK_HOME を使う', grokArm.includes('.team/seats/${name}.grok-home') || grokArm.includes('.team/seats/${name}.grok-home'))
check('GROK_HOME を preflight に渡す', grokArm.includes('GROK_HOME="$grok_home"'))
check('auth.json だけ借りる', grokArm.includes('cp "${HOME}/.grok/auth.json"'))
check('user config.toml をコピーしない', !grokArm.includes('config.toml" "${grok_home}'))
check('一時 config は ui だけ', grokArm.includes("printf '%s\\n' '[ui]' 'permission_mode = \"always-approve\"'"))
check('mcp_servers を書かない', !grokArm.includes('mcp_servers'))
check('ping は -p ping', grokArm.includes('-p "ping"'))
check('preflight 全体は stdin を閉じる', launch.includes('</dev/null'))
check('timeout 時に log path を出す', launch.includes('echo "preflight log: ${preflight_log}"'))
check('成功後に GROK_HOME を消さない', !launch.includes('rm -rf "$grok_home"\n\nsock='))
check('launch_env に GROK_HOME を載せる', launch.includes('launch_env+=("GROK_HOME=$grok_home")'))
const aitermLaunch = readFileSync(join(root, 'skill/scripts/aiterm-launch.mjs'), 'utf8')
check('live grok 席へ GROK_HOME を渡す', aitermLaunch.includes("env_vars.push('GROK_HOME')"))
const leave = readFileSync(join(root, 'skill/scripts/leave-seat.sh'), 'utf8')
check('退席で席専用 GROK_HOME を消す', leave.includes('${name}.grok-home'))

console.log(ok ? 'grok preflight repro: green' : 'grok preflight repro: RED')
process.exit(ok ? 0 : 1)
