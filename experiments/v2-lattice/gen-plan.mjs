#!/usr/bin/env node
// V2 検証用の plan_create_input.v4 生成。独立タスク 8 件・単一 Phase。
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const task = n => ({
  task_id: `t${n}`,
  title: `並行テストタスク ${n}`,
  lane: 'test',
  design_memo: `並行アクセス検証用の独立タスク。start→note→done を同時に流す対象 ${n}。`,
  narrative_ref: null,
  narrative_anchor: null,
  compile_binding: null,
  parent_task_id: null,
  phase_id: 'p1',
})

const input = {
  schema: 'lattice.plan_create_input.v4',
  project_id: 'peertable-v2test',
  plan_key: 'v2',
  plan_version: 'v1',
  actor: { host: 'mac', session: 'v2test', agent: 'bell' },
  recorded_at: new Date(Date.now() - 60_000).toISOString(),
  tasks: [1, 2, 3, 4, 5, 6, 7, 8].map(task),
  phases: [
    {
      phase_id: 'p1',
      title: '並行アクセス検証',
      gate_policy: 'audit',
      predecessor_phase_ids: [],
      required_evidence_slots: ['result'],
    },
  ],
  hard_dependencies: [],
  joins: [],
  phase_accept_dependencies: [],
  input_digest: '0'.repeat(64),
}

const canon = o => {
  if (Array.isArray(o)) return o.map(canon)
  if (o && typeof o === 'object')
    return Object.fromEntries(Object.keys(o).sort().map(k => [k, canon(o[k])]))
  return o
}

const { input_digest, ...rest } = input
input.input_digest = createHash('sha256')
  .update(JSON.stringify(canon(rest)))
  .digest('hex')

writeFileSync('.lattice-plan-create.json', JSON.stringify(canon(input)) + '\n')
console.log('written, digest =', input.input_digest)
