#!/usr/bin/env node
// 着席が role 未指定を worker 既定で通し、02_models を読まない退行を止める。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { resolveSeatPlacement } from '../skill/scripts/resolve-seat-placement.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = await readFile(join(root, 'experiments/fixtures/02_models.md'), 'utf8')
const launch = await readFile(join(root, 'skill/scripts/launch-seat.sh'), 'utf8')

let ok = true
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

check('launch-seat は role 既定 worker を持たない', !launch.includes('role="${7:-worker}"'))
check('launch-seat の usage は role を位置引数にする', launch.includes('<project_dir> <name> <role>'))
check('launch-seat は 02_models 解決器を呼ぶ', launch.includes('resolve-seat-placement.mjs'))

const empty = resolveSeatPlacement('', fixture)
check('空の role を拒否する', empty.error === 'SEAT_ROLE_REQUIRED', empty.error)

const worker = resolveSeatPlacement('worker', fixture)
check('旧 worker を未知役割として拒否する', worker.error === 'SEAT_ROLE_UNKNOWN', worker.error)

const auditor = resolveSeatPlacement('auditor', fixture)
check('旧 auditor を未知役割として拒否する', auditor.error === 'SEAT_ROLE_UNKNOWN', auditor.error)

const impl = resolveSeatPlacement('実装', fixture)
check('実装は台帳1位 Terra×high へ解決する',
  impl.vendor === 'codex' && impl.model === 'gpt-5.6-terra' && impl.effort === 'high' && impl.rank === 1,
  JSON.stringify(impl))

const consult = resolveSeatPlacement('相談', fixture)
check('相談の ChatGPT 1位は着席不能として落とし Grok 2位へ進む',
  consult.rank === 2 && consult.vendor === 'grok' && consult.model === 'grok-4.6' && consult.effort === 'medium'
    && consult.dropped?.[0]?.reason === 'not-a-seat',
  JSON.stringify(consult))

const parent = resolveSeatPlacement('統括', fixture)
check('統括はオーナー指定のため着席解決できない', parent.error === 'SEAT_PLACEMENT_UNRESOLVABLE', parent.error)

const missing = spawnSync('bash', [join(root, 'skill/scripts/launch-seat.sh')], { encoding: 'utf8' })
check('launch-seat は role 無しで usage を出して落ちる',
  missing.status !== 0 && /usage:/.test(missing.stderr), missing.stderr.trim())

const env = { ...process.env, PEERTABLE_MODELS_DOC: join(root, 'experiments/fixtures/02_models.md') }
const resolveBin = join(root, 'skill/scripts/resolve-seat-placement.mjs')
const viaCli = spawnSync(process.execPath, [resolveBin, '実装'], { encoding: 'utf8', env })
check('CLI が fixture から 実装 を解決する',
  viaCli.status === 0 && JSON.parse(viaCli.stdout).model === 'gpt-5.6-terra', viaCli.stderr)

const viaEmpty = spawnSync(process.execPath, [resolveBin], { encoding: 'utf8', env })
check('CLI は role 無しで SEAT_ROLE_REQUIRED',
  viaEmpty.status !== 0 && /SEAT_ROLE_REQUIRED/.test(viaEmpty.stderr), viaEmpty.stderr.trim())

console.log(ok ? 'seat placement repro: green' : 'seat placement repro: RED')
process.exit(ok ? 0 : 1)
