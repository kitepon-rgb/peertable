#!/usr/bin/env node
// 既存卓のPeertable管理generated asset同期を、a2欠落・a3 stale・mode境界で再現する。
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upgrade = join(repo, 'skill/scripts/upgrade-team-assets.sh')
const template = relative => readFile(join(repo, 'skill/templates', relative), 'utf8')

async function makeProject(prefix, state) {
  const project = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(project, '.team', 'roles'), { recursive: true })
  await mkdir(join(project, '.team', 'scripts'), { recursive: true })
  await writeFile(join(project, '.team', 'setup-state.json'), `${JSON.stringify(state)}\n`)
  return project
}

function report(result) {
  const line = result.stdout.trim().split(/\r?\n/).at(-1)
  assert.ok(line, `upgrade output is empty: ${result.stderr}`)
  return JSON.parse(line)
}

function run(project) {
  return spawnSync(upgrade, [project], { cwd: repo, encoding: 'utf8' })
}

async function assertLatticePositive() {
  const project = await makeProject('peertable-assets-positive-', {
    room: 'fixture-room',
    server_url: 'http://127.0.0.1:1',
    mode: 'lattice',
    plan_key: 'fixture-plan',
    phases: [],
  })
  try {
    const team = join(project, '.team')
    const sentinel = 'user-owned\n'
    await writeFile(join(team, 'user-notes.txt'), sentinel)
    await mkdir(join(team, 'credentials'))
    await writeFile(join(team, 'credentials', 'api.token'), 'secret-fixture-token\n')
    await writeFile(join(team, 'scripts', 'custom.sh'), '# user script\n')
    await writeFile(join(team, 'scripts', 'done.sh'), '#!/bin/sh\n# a3 stale generated asset\n')

    assert.equal(existsSync(join(team, 'scripts', 'start.sh')), false, 'a2 start.sh should be missing before repair')
    assert.notEqual(await readFile(join(team, 'scripts', 'done.sh'), 'utf8'), await template('done.sh'))

    const first = run(project)
    assert.equal(first.status, 0, first.stderr)
    const firstReport = report(first)
    assert.equal(firstReport.result, 'ok')
    assert.ok(firstReport.changes.some(change => change.path === '.team/scripts/start.sh' && change.action === 'created'))
    assert.ok(firstReport.changes.some(change => change.path === '.team/scripts/start-event.mjs' && change.action === 'created'))
    assert.ok(firstReport.changes.some(change => change.path === '.team/scripts/done.sh' && change.action === 'updated'))
    assert.equal(await readFile(join(team, 'scripts', 'start.sh'), 'utf8'), await template('start.sh'))
    assert.equal(await readFile(join(team, 'scripts', 'start-event.mjs'), 'utf8'), await template('start-event.mjs'))
    assert.equal(await readFile(join(team, 'scripts', 'done.sh'), 'utf8'), await template('done.sh'))
    assert.match(await readFile(join(team, 'roles', 'member.md'), 'utf8'), /fixture-plan/)
    assert.equal(await readFile(join(team, 'user-notes.txt'), 'utf8'), sentinel)
    assert.equal(await readFile(join(team, 'credentials', 'api.token'), 'utf8'), 'secret-fixture-token\n')
    assert.equal(await readFile(join(team, 'scripts', 'custom.sh'), 'utf8'), '# user script\n')

    const second = run(project)
    assert.equal(second.status, 0, second.stderr)
    const secondReport = report(second)
    assert.equal(secondReport.changed_count, 0)
    assert.ok(secondReport.changes.every(change => change.action === 'unchanged'), JSON.stringify(secondReport))
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertStandaloneBoundary() {
  const project = await makeProject('peertable-assets-standalone-', {
    room: 'fixture-room',
    server_url: 'http://127.0.0.1:1',
    mode: 'standalone',
    plan_key: '',
    phases: [],
  })
  try {
    const tasks = '- user-task: user task\n'
    const staleDone = '#!/bin/sh\n# user-owned standalone file\n'
    await writeFile(join(project, '.team', 'tasks.md'), tasks)
    await writeFile(join(project, '.team', 'scripts', 'done.sh'), staleDone)
    const result = run(project)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await readFile(join(project, '.team', 'tasks.md'), 'utf8'), tasks)
    assert.equal(await readFile(join(project, '.team', 'scripts', 'done.sh'), 'utf8'), staleDone)
    assert.equal(await readFile(join(project, '.team', 'roles', 'member.md'), 'utf8'), await template('member-standalone.md'))
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertUnsafeSymlinkReject() {
  const project = await makeProject('peertable-assets-symlink-', {
    room: 'fixture-room',
    server_url: 'http://127.0.0.1:1',
    mode: 'lattice',
    plan_key: 'fixture-plan',
    phases: [],
  })
  try {
    const sentinel = join(project, 'sentinel.txt')
    await writeFile(sentinel, 'must remain\n')
    await symlink(sentinel, join(project, '.team', 'scripts', 'start.sh'))
    const result = run(project)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /PEERTABLE_GENERATED_ASSET_UNSAFE_PATH/)
    assert.equal(await readFile(sentinel, 'utf8'), 'must remain\n')
    assert.equal(existsSync(join(project, '.team', 'scripts', 'done.sh')), false, 'preflight reject must not partially sync')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertInvalidStateReject() {
  const project = await makeProject('peertable-assets-invalid-state-', {
    room: 'fixture-room',
    server_url: 'http://127.0.0.1:1',
    mode: 'lattice',
    plan_key: '',
    phases: [],
  })
  try {
    const result = run(project)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /PEERTABLE_SETUP_STATE_INVALID/)
    assert.equal(existsSync(join(project, '.team', 'scripts', 'start.sh')), false)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

try {
  await assertLatticePositive()
  await assertStandaloneBoundary()
  await assertUnsafeSymlinkReject()
  await assertInvalidStateReject()
  console.log(JSON.stringify({
    schema: 'peertable.generated_assets_upgrade_repro.v1',
    result: 'pass',
    cases: ['lattice-positive-idempotent', 'standalone-boundary', 'unsafe-symlink-reject', 'invalid-setup-state-reject'],
  }))
} catch (error) {
  console.error(error.stack ?? error)
  process.exitCode = 1
}
