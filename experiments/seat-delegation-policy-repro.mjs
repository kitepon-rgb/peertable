#!/usr/bin/env node
// Peertableの席間分担がnative agentへ誤配線されず、Codex ultraを受け入れないことを測る。
// --without-policy は旧版の案内を再現する負のcontrol。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = [
  '.team/roles/member.md',
  'skill/templates/member.md',
  'skill/templates/member-standalone.md',
  'skill/templates/charter.md',
  'skill/SKILL.md',
]
const mutation = process.argv.includes('--without-policy')

const sources = await Promise.all(DOCS.map(async file => [file, await readFile(path.join(ROOT, file), 'utf8')]))
const joined = sources.map(([, source]) => source).join('\n')
const policyText = mutation
  ? joined.replaceAll('mcp__aiterm__codex_agent', 'codex_agent').replaceAll('ultra', 'effort')
  : joined

function assertPolicyText() {
  assert.match(policyText, /launch-seat\.sh/, '正規の長寿命席入口が案内されていない')
  assert.match(policyText, /pty_read.*pty_send.*pty_key/s, '既存aiterm席の操作入口が揃っていない')
  assert.match(policyText, /mcp__aiterm__codex_agent/, 'native Codex agentの禁止が案内されていない')
  assert.match(policyText, /mcp__aiterm__claude_agent/, 'native Claude agentの禁止が案内されていない')
  assert.match(policyText, /Task.*Agent/s, 'Task/Agentの禁止が案内されていない')
  assert.match(policyText, /native sub-agent/, 'native sub-agentの禁止が案内されていない')
  assert.match(policyText, /ultra/, 'Codex ultraの扱いが案内されていない')
  assert.match(policyText, /max.*以下|max.*effort/s, 'ultraからmax以下へ誘導する規則がない')
  assert.match(policyText, /短命.*PTY.*長寿命.*PTY/s, 'shell用PTYと席用PTYの区別がない')
}

function decide({ entry, vendor, effort }) {
  if (entry !== 'external-pty') return { ok: false, reason: 'PEERTABLE_SEAT_ENTRY_NATIVE_FORBIDDEN' }
  if (vendor === 'codex' && effort === 'ultra') {
    return { ok: false, reason: 'PEERTABLE_CODEX_ULTRA_FORBIDDEN' }
  }
  return { ok: true, reason: 'PEERTABLE_EXTERNAL_PTY' }
}

assertPolicyText()
assert.deepEqual(decide({ entry: 'native-agent', vendor: 'codex', effort: 'max' }), {
  ok: false,
  reason: 'PEERTABLE_SEAT_ENTRY_NATIVE_FORBIDDEN',
})
assert.deepEqual(decide({ entry: 'external-pty', vendor: 'codex', effort: 'ultra' }), {
  ok: false,
  reason: 'PEERTABLE_CODEX_ULTRA_FORBIDDEN',
})
assert.deepEqual(decide({ entry: 'external-pty', vendor: 'codex', effort: 'max' }), {
  ok: true,
  reason: 'PEERTABLE_EXTERNAL_PTY',
})
assert.deepEqual(decide({ entry: 'external-pty', vendor: 'claude', effort: 'high' }), {
  ok: true,
  reason: 'PEERTABLE_EXTERNAL_PTY',
})

console.log(`seat delegation policy: ${mutation ? 'mutation rejected as expected' : 'green'}`)
