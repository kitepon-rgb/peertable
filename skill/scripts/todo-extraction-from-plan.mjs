#!/usr/bin/env node
// 稼働中 campaign へ独立欠陥 ToDo を軽量に追加するための正規入口。
//
// 背景: main plan の migrate 時に narrative_ref へ #L 行番号を持たせなかったため、
// `lattice todo split` が `predecessor_source_inventory_unavailable` で機構的に失敗した
// （実測 2026-08-11。docs/plan_peertable-autonomy-runtime-fx-20260811.md f4）。`todo revise` は
// 使えるが desired_plan 全体・source_cutover_batch を要求する重量級 API で、発見者が親裁定なしに
// 選べる手段ではない。このツールは「計画 Markdown に `### <task_id> <title>` 見出しで task を書く
// →本ツールで extraction.json を自動生成→`lattice todo migrate` で新規 companion plan として起票」
// という軽量な代替経路を提供する。既存 plan への task 追加は、新規 companion plan を作り
// `lattice todo dependency connect` で前提へ接続する（このツールは新規 plan の migrate 入力生成
// だけを担う。稼働中 plan への revise は対象外）。
//
// usage:
//   node todo-extraction-from-plan.mjs <plan.md> <plan_key> --project <project_id> --agent <name>
//     [--session <name>] [--host <name>] [--lane <lane>] [--out <path>]
//
// 計画 Markdown の規約: `# <root見出し>` → `## <section見出し>` → `### <task_id> <title>` の3階層。
// 各 `###` 見出しの本文（次の `#`/`##`/`###` 見出しまで）が design_memo になる。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'

function usage(message) {
  if (message) console.error(`ERROR: ${message}`)
  console.error('usage: todo-extraction-from-plan.mjs <plan.md> <plan_key> --project <id> --agent <name> [--session <name>] [--host <name>] [--lane <lane>] [--out <path>]')
  process.exit(1)
}

const args = process.argv.slice(2)
if (args.length < 2 || args[0].startsWith('--')) usage('plan.md と plan_key は最初の2つの位置引数')
const [planPath, planKey, ...rest] = args
const opts = { project: null, agent: null, session: null, host: 'mac', lane: 'defect', out: null }
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i]?.replace(/^--/, '')
  if (!(key in opts)) usage(`unknown flag: ${rest[i]}`)
  opts[key] = rest[i + 1]
}
if (!opts.project) usage('--project は必須')
if (!opts.agent) usage('--agent は必須')
if (!opts.session) opts.session = opts.agent

const latticeCli = process.env.LATTICE_CLI
if (!latticeCli) usage('LATTICE_CLI 環境変数が必要（Lattice パッケージの src/todo-contracts.mjs を解決するため）')
const latticePkgSrc = join(dirname(dirname(latticeCli)), 'src', 'todo-contracts.mjs')
const { todoSelfDigest } = await import(latticePkgSrc)

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const relPlanPath = execFileSync('git', ['-C', repoRoot, 'ls-files', '--full-name', planPath], { encoding: 'utf8' }).trim()
if (!relPlanPath) usage(`${planPath} は git 管理下にない（先に commit すること）`)
const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', relPlanPath], { encoding: 'utf8' }).trim()
if (dirty) usage(`${relPlanPath} に未 commit の変更がある。先に commit してから実行すること`)
const sourceCommit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

const text = readFileSync(join(repoRoot, relPlanPath), 'utf8')
const lines = text.split('\n')

let rootHeading = null
let sectionHeading = null
const tasks = []
let current = null // { taskId, title, startLine, headingPath }

const flush = (endLineExclusive) => {
  if (!current) return
  const bodyLines = lines.slice(current.startLine, endLineExclusive)
  while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift()
  while (bodyLines.length && bodyLines.at(-1).trim() === '') bodyLines.pop()
  const designMemo = bodyLines.join('\n').trim()
  if (!designMemo) usage(`task ${current.taskId} の design_memo が空`)
  tasks.push({ ...current, designMemo })
  current = null
}

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]
  const h1 = /^# (.+)$/.exec(line)
  const h2 = /^## (.+)$/.exec(line)
  const h3 = /^### (\S+) (.+)$/.exec(line)
  if (h1) { flush(i); rootHeading = h1[1]; sectionHeading = null; continue }
  if (h2) { flush(i); sectionHeading = h2[1]; continue }
  if (h3) {
    flush(i)
    if (!rootHeading || !sectionHeading) usage(`行${i + 1}: task見出しの前に # と ## の見出しが要る`)
    current = {
      taskId: h3[1], title: h3[2], startLine: i + 1,
      headingPath: [rootHeading, sectionHeading, `${h3[1]} ${h3[2]}`],
      headingLine: i + 1,
    }
  }
}
flush(lines.length)
if (tasks.length === 0) usage('`### <task_id> <title>` 見出しが1つも見つからない')

const migrationContext = {
  carry_over_ref: null, condition: null, evidence_refs: [], external_canonical_ref: null,
  h_required: false, notes: [],
}

const extraction = {
  actor: { agent: opts.agent, host: opts.host, session: opts.session },
  hard_dependencies: [],
  joins: [],
  plan_key: planKey,
  plan_version: 'v1',
  project_id: opts.project,
  recorded_at: new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, (m) => m.length === 5 ? m : '.000Z'),
  schema: 'lattice.todo_extraction.v3',
  tasks: tasks.map(({ taskId, title, headingPath, headingLine, designMemo }) => ({
    compile_binding: null,
    completion: null,
    design_memo: designMemo,
    disposition: 'register_pending',
    lane: opts.lane,
    migration_context: migrationContext,
    narrative_ref: relPlanPath,
    source: {
      checkbox_state: 'absent',
      heading_path: headingPath,
      markdown_depth: 3,
      origin_line: headingLine,
      origin_plan_ref: relPlanPath,
      parent_task_id: null,
      source_commit: sourceCommit,
    },
    start: null,
    task_id: taskId,
    title,
  })),
  extraction_digest: '0'.repeat(64),
}
extraction.extraction_digest = todoSelfDigest(extraction, 'extraction_digest')

const outPath = opts.out ?? join(repoRoot, `.lattice/extraction-${planKey}.json`)
writeFileSync(outPath, JSON.stringify(extraction, null, 2) + '\n')
console.log(`written: ${outPath} (${tasks.length} tasks: ${tasks.map((t) => t.taskId).join(', ')})`)
console.log(`next: lattice todo migrate --input ${outPath} --dry-run --json`)
