#!/usr/bin/env node
// タスク定義 JSON から `lattice plan create` の入力（lattice.plan_create_input.v4）を生成する。
// usage: make-plan-input.mjs <tasks.json> [--project <dir>] [--out <path>]
//   既定の出力先は <project>/.lattice/plan-create.json（`lattice status` が案内する場所）。
//
// 入力（tasks.json）:
// {
//   "plan_key": "lattice-integration",
//   "project_id": "peertable",           // 省略時は project ディレクトリ名
//   "plan_version": "v1",                // 省略時 v1
//   "actor": { "host": "mac", "session": "setup", "agent": "bell" },   // 省略可
//   "phase": { "id": "p1", "title": "…", "gate_policy": "audit" },     // 省略可（単一 Phase）
//   "tasks": [
//     { "id": "t1", "title": "…", "memo": "…", "deps": ["t0"] }        // deps は「先に終わる方」
//   ]
// }
//
// 手書きで2回踏んだ罠をここで潰す:
//   1. hard_dependencies は (from.task_id, to.task_id) の昇順ソートが必須。崩れると
//      `INPUT_INVALID / plan_create_schema_invalid / pointer:"/"` としか言われない
//      （caveat `lattice-plan-create-hard-dependencies-from-to-pointer`）
//   2. input_digest は input_digest 自身を除いたキー昇順の正規化 JSON の sha256
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
let src = null
let projectArg = '.'
let outArg = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--project') projectArg = argv[++i]
  else if (argv[i] === '--out') outArg = argv[++i]
  else src ??= argv[i]
}
if (!src) {
  console.error('usage: make-plan-input.mjs <tasks.json> [--project <dir>] [--out <path>]')
  process.exit(1)
}

const spec = JSON.parse(readFileSync(src, 'utf8'))
const proj = realpathSync(resolve(projectArg))
const out = resolve(outArg ?? join(proj, '.lattice', 'plan-create.json'))

const projectId = spec.project_id ?? basename(proj)
const planKey = spec.plan_key
const phase = spec.phase ?? {}
const phaseId = phase.id ?? 'p1'
const ref = taskId => ({ project_id: projectId, plan_key: planKey, task_id: taskId })

const deps = []
for (const t of spec.tasks) for (const d of t.deps ?? []) deps.push({ from: ref(d), to: ref(t.id) })
deps.sort((a, b) => a.from.task_id.localeCompare(b.from.task_id) || a.to.task_id.localeCompare(b.to.task_id))

const input = {
  schema: 'lattice.plan_create_input.v4',
  project_id: projectId,
  plan_key: planKey,
  plan_version: spec.plan_version ?? 'v1',
  actor: spec.actor ?? { host: 'mac', session: 'setup', agent: 'bell' },
  // 記録時刻が未来だと弾かれうるので少し過去へ倒す（gen-plan.mjs から踏襲）
  recorded_at: new Date(Date.now() - 60_000).toISOString(),
  tasks: spec.tasks.map(t => ({
    task_id: t.id,
    title: t.title,
    lane: t.lane ?? 'dev',
    design_memo: t.memo,
    narrative_ref: null,
    narrative_anchor: null,
    compile_binding: null,
    parent_task_id: null,
    phase_id: t.phase ?? phaseId,
  })),
  phases: [{
    phase_id: phaseId,
    title: phase.title ?? planKey,
    gate_policy: phase.gate_policy ?? 'audit',
    predecessor_phase_ids: [],
    required_evidence_slots: phase.required_evidence_slots ?? ['result'],
  }],
  hard_dependencies: deps,
  joins: [],
  phase_accept_dependencies: [],
  input_digest: '0'.repeat(64),
}

const canon = o => {
  if (Array.isArray(o)) return o.map(canon)
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map(k => [k, canon(o[k])]))
  return o
}
const { input_digest, ...rest } = input
input.input_digest = createHash('sha256').update(JSON.stringify(canon(rest))).digest('hex')

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(canon(input)) + '\n')
console.log(`${out}（${input.tasks.length} tasks / ${deps.length} deps）`)
console.log(`次: cd ${proj} && lattice plan create --input ${out}`)
