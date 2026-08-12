#!/usr/bin/env node
// 現storeのbinding_staleと、u1→a6 cross-plan edgeの入力snapshotを無変更で固定する。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const snapshotPath = join(repo, 'evidence/peertable-task-announcements-fx-20260812/u1-rebind-input.json')
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))

const runJson = args => {
  const result = spawnSync('lattice', args, { cwd: repo, encoding: 'utf8' })
  const output = (result.stdout.trim() || result.stderr.trim())
  assert.ok(output, `lattice ${args.join(' ')} produced no JSON: ${result.stderr}`)
  return { result, json: JSON.parse(output) }
}

try {
  const projectStatus = runJson(['status', '--json'])
  assert.notEqual(projectStatus.result.status, 0, 'invalid store must return a non-zero exit code')
  assert.equal(projectStatus.json.schema, 'lattice.project_status.v1')
  assert.equal(projectStatus.json.cli.version, snapshot.store_observation.cli_version)
  assert.equal(projectStatus.json.project.git_head, snapshot.store_observation.git_head)
  assert.equal(projectStatus.json.state, 'invalid')
  assert.deepEqual(projectStatus.json.next_action, snapshot.store_observation.next_action)
  assert.equal(projectStatus.json.result_digest, snapshot.store_observation.result_digest)

  const todoStatus = runJson(['todo', 'status', '--json'])
  assert.notEqual(todoStatus.result.status, 0, 'binding_stale must not be reported as ready')
  assert.deepEqual(todoStatus.json, {
    schema: 'lattice.cli_error.v2',
    code: 'STORE_INCONSISTENT',
    message: 'binding_stale',
    detail: { reason: 'binding_stale' },
  })

  assert.equal(snapshot.binding_stale.producer.task_id, 'u1')
  assert.equal(snapshot.binding_stale.consumer.task_id, 'a6')
  assert.notEqual(
    snapshot.binding_stale.producer.expected_topology_digest,
    snapshot.binding_stale.producer.current_source_topology_digest,
    'fixture must pin the stale producer topology mismatch',
  )
  console.log(JSON.stringify({
    schema: 'peertable.u1_binding_stale_rebind_repro.v1',
    result: 'pass',
    state: projectStatus.json.state,
    reason: todoStatus.json.detail.reason,
    edge: {
      from: `${snapshot.binding_stale.producer.plan_key}/${snapshot.binding_stale.producer.task_id}`,
      to: `${snapshot.binding_stale.consumer.plan_key}/${snapshot.binding_stale.consumer.task_id}`,
    },
  }))
} catch (error) {
  console.error(error.stack ?? error)
  process.exitCode = 1
}
