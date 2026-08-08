#!/usr/bin/env node
// Peertable → Lattice 外部ペインコネクタ（決定53）。
// usage: external-pane.mjs <project_dir> <room> <public_base>
//
// 対象プロジェクトの `.lattice/project.json` へ `external_pane`（title/url/probe_url）を書く。
// Lattice 側（project-identity）は identity 文書のキー集合を検証するので、既存欄
// （schema / project_id / display_name）を保ったまま完全な文書として書き直す。
// 既存文書は `.team/project.json.bak` へ退避し、teardown がそれを戻す。
//
// stdout: 既存 project.json があったかを `true` / `false` の1行で出す（setup.sh が state へ記録する）
// stderr: 人間向けの書き込み内容
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const [proj, room, base] = process.argv.slice(2)
const identity = join(proj, '.lattice', 'project.json')
const preexisting = existsSync(identity)
const current = preexisting ? JSON.parse(readFileSync(identity, 'utf8')) : {}
if (preexisting) copyFileSync(identity, join(proj, '.team', 'project.json.bak'))

// project_id は Lattice store が持つ値が正。store があるのにディレクトリ名を書くと、
// identity 検証が落ちて `lattice todo status` ごと死ぬ（PascalCase ディレクトリ × kebab-case store で実測）。
// 順序: 既存 identity（人が書いた値は書き換えない）→ store manifest → ディレクトリ名。
function storeProjectId() {
  const ref = join(proj, '.lattice', 'todo', 'manifest.json')
  if (!existsSync(ref)) return null
  // manifest が壊れていると、この `JSON.parse` が例外を投げて **setup の画面へ生の traceback が出る**。
  // 直していない理由: 壊れた manifest を持つ project では `lattice status` が `state:"invalid"`、
  // `todo status` が `STORE_INCONSISTENT` を返す＝**Lattice 自体が既に死んでいる**ので、
  // setup が併用モードへ進む前に止まる経路のはず。実害はほぼ無いと判断した（2026-08-08）。
  // ただし**失敗の見え方は惜しい**——typed error（`MANIFEST_UNREADABLE` 等）へ変えるなら、ここ。
  const id = JSON.parse(readFileSync(ref, 'utf8')).project_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

const stored = storeProjectId()
const projectId = current.project_id ?? stored ?? basename(realpathSync(proj))
// 食い違いは黙って通さない。書き換えはしない（人の書いた identity が正）が、
// このまま進むと `lattice todo status` が死ぬので、setup の画面へ出す。
if (current.project_id && stored && current.project_id !== stored) {
  process.stderr.write(`警告: 既存 project.json の project_id="${current.project_id}" が Lattice store の "${stored}" と食い違っている。`
    + `このままでは lattice todo status が PROJECT_IDENTITY_INVALID で落ちる。project.json 側を直してから setup し直すこと\n`)
}
const root = base.replace(/\/+$/, '')
const pane = { title: '円卓', url: `${root}/${room}`, probe_url: `${root}/api/${room}/members` }

mkdirSync(join(proj, '.lattice'), { recursive: true })
writeFileSync(identity, JSON.stringify({
  schema: 'lattice.project_identity.v1',
  project_id: projectId,
  display_name: current.display_name ?? projectId,
  external_pane: pane,
}, null, 2) + '\n')

process.stderr.write(`external pane: ${pane.url}（probe: ${pane.probe_url}・project_id: ${projectId}）\n`)
process.stdout.write(preexisting ? 'true\n' : 'false\n')
