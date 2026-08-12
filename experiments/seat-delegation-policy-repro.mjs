#!/usr/bin/env node
// 親の正式な円卓席作成と、着席メンバーの二次委譲を混同しない境界を測る。
// --without-policy は旧版の案内を再現する負のcontrol。
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCH = path.join(ROOT, 'skill/scripts/launch-seat.sh')
const DOCS = [
  '.team/roles/member.md',
  'skill/templates/member.md',
  'skill/templates/member-standalone.md',
  'skill/templates/charter.md',
  'skill/SKILL.md',
]
const mutation = process.argv.includes('--without-policy')
const mutatePolicy = source => source
  .replaceAll('Aiterm長寿命', 'native child')
  .replaceAll('自由に選べる', '親が禁止する')

// 負制御も同じsource単位で評価し、連結した別文書の文言で欠落を隠さない。
const sources = (await Promise.all(DOCS.map(async file => [file, await readFile(path.join(ROOT, file), 'utf8')])))
  .map(([file, source]) => [file, mutation ? mutatePolicy(source) : source])
const sourceByFile = new Map(sources)
const launchSource = await readFile(LAUNCH, 'utf8')
const policyText = sources.map(([, source]) => source).join('\n')
const parentFiles = ['skill/SKILL.md', 'skill/templates/charter.md']
const memberFiles = ['.team/roles/member.md', 'skill/templates/member.md', 'skill/templates/member-standalone.md']

function sourceFor(file) {
  return sourceByFile.get(file)
}

function assertSource(file, pattern, message) {
  assert.match(sourceFor(file), pattern, `${file}: ${message}`)
}

function assertSourceDoesNotMatch(file, pattern, message) {
  assert.doesNotMatch(sourceFor(file), pattern, `${file}: ${message}`)
}

function assertPolicyText() {
  const rejectAt = launchSource.indexOf('SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN')
  const unsetAt = launchSource.indexOf('unset PEERTABLE_POST_TOKEN')
  assert.ok(rejectAt >= 0, 'launch-seat.sh: 委譲子のtyped rejectがない')
  assert.ok(unsetAt >= 0 && rejectAt < unsetAt, 'launch-seat.sh: typed rejectが副作用境界より後ろにある')
  assert.match(launchSource, /if \[ -n "\$\{PEERTABLE_MEMBER:-\}" \]/, 'launch-seat.sh: PEERTABLE_MEMBERの非空判定がない')
  for (const file of parentFiles) {
    assertSource(file, /launch-seat\.sh/, '親の正式な長寿命席入口が案内されていない')
    assertSource(file, /Aiterm長寿命/, '親の席がAiterm長寿命席であることが案内されていない')
    assertSource(file, /native[\s\S]*円卓(?:メンバー|席)の代用/, '親がnative子を円卓席の代用にしない境界がない')
  }
  assertSource('skill/SKILL.md', /短命PTY[\s\S]*長寿命PTY/, '短命shellと長寿命席の区別がない')
  for (const file of memberFiles) {
    assertSource(file, /native sub-agent、Aiterm外部agent、相談agent、自己実装を自由に選べる/, '着席メンバーの委譲選択が自由であることがない')
    assertSource(file, /親は二次委譲の手段を禁止・指定しない/, '親が二次委譲を禁止・指定しない境界がない')
    assertSource(file, /子は自動的に円卓メンバーにはならず/, '子が自動で円卓メンバーにならない境界がない')
    assertSource(file, /工程所有・統合・room報告/, '着席メンバーの所有・統合・報告境界がない')
    assertSourceDoesNotMatch(file, /native sub-agentを円卓メンバーの代用として起動しない/, 'member roleが二次委譲まで禁止している')
    assertSourceDoesNotMatch(file, /この席では拒否/, 'member roleがnative/ultraを一律拒否している')
  }
  for (const file of ['skill/SKILL.md', 'skill/templates/member.md']) {
    assertSource(file, /PEERTABLE_MEMBER[\s\S]*SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN/, '委譲子のtyped reject境界が文書化されていない')
  }
  assert.match(policyText, /親が円卓メンバーを増やす時/, '親の円卓席作成境界がない')
}

function decideParent(entry) {
  return entry === 'aiterm-long-lived'
    ? { ok: true, reason: 'PARENT_FORMAL_PEERTABLE_ENTRY' }
    : { ok: false, reason: 'PARENT_MEMBER_ENTRY_FORMAL_AITERM_REQUIRED' }
}

function decideMember(entry) {
  const allowed = new Set(['native-sub-agent', 'aiterm-external-agent', 'consultation-agent', 'self'])
  return allowed.has(entry)
    ? { ok: true, reason: 'MEMBER_OWNS_DELEGATION' }
    : { ok: false, reason: 'MEMBER_DELEGATION_UNKNOWN' }
}

function delegatedChildBoundary() {
  return {
    room_member: false,
    task_owner: 'seated-member',
    integrator: 'seated-member',
    room_reporter: 'seated-member',
  }
}

async function runRealLaunch(member) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'peertable-seat-delegation-'))
  const project = path.join(work, 'project')
  const bin = path.join(work, 'bin')
  const marker = path.join(work, 'preflight.marker')
  await mkdir(project)
  await mkdir(bin)
  const fakeClaude = path.join(bin, 'claude')
  await writeFile(fakeClaude, '#!/bin/sh\nprintf \'preflight\\n\' >> "$LAUNCH_POLICY_MARKER"\nexit 0\n')
  await chmod(fakeClaude, 0o755)

  const env = { ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    TMPDIR: work,
    PEERTABLE_TMUX_SOCKET: path.join(work, 'unused.sock'),
    LAUNCH_POLICY_MARKER: marker,
  }
  delete env.PEERTABLE_MEMBER
  delete env.PEERTABLE_CREDENTIAL_HELPER
  delete env.PEERTABLE_ROOM_MCP_HELPER
  delete env.PEERTABLE_POST_TOKEN
  if (member !== undefined) env.PEERTABLE_MEMBER = member

  const result = spawnSync(LAUNCH, [project, 'fixture-seat', 'sonnet', 'claude', 'low'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  })
  const markerText = await readFile(marker, 'utf8').catch(() => '')
  const projectEntries = await readdir(project)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  await rm(work, { recursive: true, force: true })
  return { markerText, output, projectEntries, result }
}

assertPolicyText()
assert.deepEqual(decideParent('native-sub-agent'), {
  ok: false,
  reason: 'PARENT_MEMBER_ENTRY_FORMAL_AITERM_REQUIRED',
})
assert.deepEqual(decideParent('aiterm-long-lived'), {
  ok: true,
  reason: 'PARENT_FORMAL_PEERTABLE_ENTRY',
})
for (const entry of ['native-sub-agent', 'aiterm-external-agent', 'consultation-agent', 'self']) {
  assert.deepEqual(decideMember(entry), { ok: true, reason: 'MEMBER_OWNS_DELEGATION' })
}
assert.deepEqual(delegatedChildBoundary(), {
  room_member: false,
  task_owner: 'seated-member',
  integrator: 'seated-member',
  room_reporter: 'seated-member',
})

const delegatedLaunch = await runRealLaunch('hinata')
assert.notEqual(delegatedLaunch.result.status, 0, '委譲子のlaunchが成功扱いになった')
assert.match(delegatedLaunch.output, /SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN/, '委譲子のtyped rejectが返らない')
assert.equal(delegatedLaunch.markerText, '', '委譲子の拒否前にmodel preflightが走った')
assert.deepEqual(delegatedLaunch.projectEntries, [], '委譲子の拒否前にprojectへ副作用が残った')

const parentLaunch = await runRealLaunch(undefined)
assert.notEqual(parentLaunch.result.status, 0, '親の既存preflight後のfixture停止が成功扱いになった')
assert.equal(parentLaunch.markerText, 'preflight\n', 'PEERTABLE_MEMBER無しの親が既存model preflightへ到達していない')
assert.doesNotMatch(parentLaunch.output, /SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN/, '親の正式増員が委譲子として拒否された')
assert.deepEqual(parentLaunch.projectEntries, [], '親のpreflight到達fixtureがprojectへ副作用を残した')

console.log(`seat delegation boundary: ${mutation ? 'mutation rejected as expected' : 'green'}`)
console.log('seat delegation launch: delegated child rejected before side effects; parent reached existing preflight')
