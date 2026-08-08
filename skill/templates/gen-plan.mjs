#!/usr/bin/env node
// V3 用 plan: t1 greet 関数 / t2 CLI（t1 依存）/ t3 README（独立）
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const P = 'peertable-v3'
const K = 'v3'
const ref = task_id => ({ project_id: P, plan_key: K, task_id })
const task = (task_id, title, design_memo) => ({
  task_id, title, lane: 'dev', design_memo,
  narrative_ref: null, narrative_anchor: null, compile_binding: null,
  parent_task_id: null, phase_id: 'p1',
})

const input = {
  schema: 'lattice.plan_create_input.v4',
  project_id: P,
  plan_key: K,
  plan_version: 'v1',
  actor: { host: 'mac', session: 'setup', agent: 'bell' },
  recorded_at: new Date(Date.now() - 60_000).toISOString(),
  tasks: [
    task('t1', 'greet 関数の実装', 'greet.mjs に greet(name) を実装して export する。挨拶文の仕様（言語・形式）は実装者が決めてよいが、決めたら room で全員に共有すること。node --test 用の簡単なテストを greet.test.mjs に書く。'),
    task('t2', 'CLI の実装', 'cli.mjs を実装する。`node cli.mjs <name>` で greet.mjs の greet(name) の結果を標準出力する。greet のインターフェースは t1 の実装者が room で共有した仕様に従う。不明なら room で聞く。'),
    task('t3', 'README の作成', 'README.md を書く。プロジェクトの説明・使い方（cli の起動例）・ファイル構成。他タスクの成果に触れる部分は room の報告を参照して正確に書く。'),
  ],
  phases: [{ phase_id: 'p1', title: 'greeter 一式', gate_policy: 'audit', predecessor_phase_ids: [], required_evidence_slots: ['result'] }],
  hard_dependencies: [{ from: ref('t1'), to: ref('t2') }],
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
input.input_digest = createHash('sha256').update(JSON.stringify(canon(rest))).digest('hex')
writeFileSync('.lattice-plan-create.json', JSON.stringify(canon(input)) + '\n')
console.log('written')
