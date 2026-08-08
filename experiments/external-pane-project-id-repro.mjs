#!/usr/bin/env node
// refit-20260808 t7 の再現ハーネス。
// PascalCase のディレクトリ名 × kebab-case の store project_id という食い違いを実際に作り、
// `lattice todo status` が生きているかで合否を出す。
//
// usage:
//   node experiments/external-pane-project-id-repro.mjs            # 現行の external-pane.mjs を検査
//   node experiments/external-pane-project-id-repro.mjs --broken   # 負のコントロール（旧挙動＝ディレクトリ名を書く）
//
// 負のコントロール込みで走らせること。--broken が落ちないハーネスは、通っても何も保証しない。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

const broken = process.argv.includes('--broken')
const preexisting = process.argv.includes('--preexisting')
const repo = join(import.meta.dirname, '..')
const base = mkdtempSync(join(tmpdir(), 'peertable-t7-'))
// ディレクトリ名は PascalCase、store の project_id は kebab-case にして食い違わせる。
const proj = join(base, 'RootSitePromotion')
// project_id は走るたびに変える。dashboard 登録簿は project_id を鍵に repo root を覚えているので、
// 固定値だと前回の（既に消えた）temp dir と衝突して PROJECT_ROOT_CONFLICT になる（製品ではなくハーネスの問題）。
const STORE_ID = `root-site-promotion-${process.pid}`
mkdirSync(join(proj, '.team'), { recursive: true })

// dashboard 登録簿は既定で ~/.lattice/dashboard（利用者の実物）。ハーネスがそこを触らないよう
// runtime dir を temp へ逃がす。**AUTOSTART は切らない**——identity 解決は dashboard 登録の経路に
// 乗っているので、切ると欠陥そのものが再現しなくなる（負のコントロールが通ってしまう）。
const run = (cmd, args, options = {}) => execFileSync(cmd, args, {
  cwd: proj, encoding: 'utf8', ...options,
  env: { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: join(base, 'dashboard'), ...(options.env ?? {}) },
})

try {
  run('git', ['init', '--quiet'])
  // store を kebab-case の project_id で作る（＝既に Lattice を使っている project の状態）
  writeFileSync(join(base, 'tasks.json'), JSON.stringify({
    plan_key: 'existing', project_id: STORE_ID,
    tasks: [{ id: 't1', title: '既存の工程', memo: 'store が先に在る project を模す' }],
  }))
  run('node', [join(repo, 'skill/scripts/make-plan-input.mjs'), join(base, 'tasks.json'), '--project', proj])
  run('lattice', ['plan', 'create', '--input', '.lattice/plan-create.json', '--serialization-reviewed'])

  const manifest = JSON.parse(readFileSync(join(proj, '.lattice', 'todo', 'manifest.json'), 'utf8'))
  if (manifest.project_id !== STORE_ID) throw new Error(`前提が崩れている: manifest=${manifest.project_id}`)

  // 既存 identity がある場合は project_id を書き換えない（人が書いた値が正）。
  // ただし store と食い違うなら黙って進めず警告を出す、が仕様。
  if (preexisting) {
    writeFileSync(join(proj, '.lattice', 'project.json'), `${JSON.stringify({
      schema: 'lattice.project_identity.v1', project_id: STORE_ID, display_name: '既存の表示名',
    }, null, 2)}\n`)
    const stderr = []
    run('node', [join(repo, 'skill/scripts/external-pane.mjs'), proj, 'room-a', 'https://example.test'],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    const after = JSON.parse(readFileSync(join(proj, '.lattice', 'project.json'), 'utf8'))
    const ok = after.project_id === STORE_ID && after.display_name === '既存の表示名'
      && after.external_pane?.title === '円卓'
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  既存 identity の project_id と display_name を保ったまま external_pane だけ足す`
      + `  — project_id=${after.project_id} display_name=${after.display_name}\n`)
    process.exitCode = ok ? 0 : 1
    void stderr
    process.exit(process.exitCode)
  }

  if (broken) {
    // 旧挙動の再現: ディレクトリ名をそのまま project_id として書く
    writeFileSync(join(proj, '.lattice', 'project.json'), `${JSON.stringify({
      schema: 'lattice.project_identity.v1',
      project_id: basename(proj),
      display_name: basename(proj),
      external_pane: { title: '円卓', url: 'https://example.test/room-a', probe_url: 'https://example.test/api/room-a/members' },
    }, null, 2)}\n`)
  } else {
    run('node', [join(repo, 'skill/scripts/external-pane.mjs'), proj, 'room-a', 'https://example.test'])
  }

  const identity = JSON.parse(readFileSync(join(proj, '.lattice', 'project.json'), 'utf8'))
  const checks = []
  checks.push(['project_id が store と一致', identity.project_id === STORE_ID, `${identity.project_id} vs ${STORE_ID}`])
  checks.push(['external_pane が書かれている', identity.external_pane?.title === '円卓', JSON.stringify(identity.external_pane ?? null)])

  let statusAlive = false
  let statusDetail = ''
  try {
    const out = run('lattice', ['todo', 'status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    statusAlive = JSON.parse(out).project_id === STORE_ID
    statusDetail = `project_id=${JSON.parse(out).project_id}`
  } catch (error) {
    statusDetail = String(error.stderr ?? error.message).trim().slice(0, 160)
  }
  checks.push(['lattice todo status が生きている', statusAlive, statusDetail])

  for (const [name, ok, detail] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}\n`)
  const allPass = checks.every(([, ok]) => ok)
  process.stdout.write(`${broken ? '負のコントロール（旧挙動）' : '現行実装'}: ${allPass ? 'all pass' : 'fail あり'}\n`)
  process.exitCode = allPass ? 0 : 1
} finally {
  if (existsSync(base)) rmSync(base, { recursive: true, force: true })
}
