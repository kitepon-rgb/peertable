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

// project_id は Lattice store が持つ値が正。setup 時点では store がまだ無いので、
// 既存 identity → プロジェクトディレクトリ名 の順で決める（make-plan-input.mjs の既定と同じ）。
const projectId = current.project_id ?? basename(realpathSync(proj))
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
