#!/usr/bin/env node
// campaign peertable-autonomy-runtime-20260811 §2.2/§2.3 の契約を role テンプレートが
// 満たすことを測る再現ハーネス（t2 の前提）。
//
// 欠陥（修正前）: skill/templates/member.md の完了手順が
//   証跡→commit→done.sh実行 → room完了報告（この時に監査を依頼）
// の順で、`.team/scripts/done.sh` による Lattice `todo done` が実装者以外の監査より
// **先に** 走っていた（決定60時代の「done 後に監査」）。これは §2.2 の
// 「監査が通ってから Lattice 完了になる」と矛盾する。
//
// このハーネスは3点を確認する:
//   1. 完了手順の本文中で、監査依頼が `done.sh` 実行より前に出現する
//   2. 「監査所見が付く前に done.sh を実行しない」ことが明記されている
//   3. active → ready → 文脈近接 peer audit → 待機 の探索順が明記されている
// member-standalone.md（単独円卓モード）と charter.md（憲章）にも同じ趣旨の記述を求める。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFile(process.argv[2] ? `${process.argv[2]}/${rel}` : `${root}/${rel}`, 'utf8')

let ok = true
const check = (name, pass, detail) => { console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!pass) ok = false }

const member = await read('skill/templates/member.md')
const standalone = await read('skill/templates/member-standalone.md')
const charter = await read('skill/templates/charter.md')

// 1. member.md: 監査依頼(room へ監査依頼を一行投稿する)が done.sh 実行より先に出現する
{
  const auditIdx = member.indexOf('room へ監査依頼を一行投稿する')
  const doneShIdx = member.indexOf('.team/scripts/done.sh <task_id>` を実行する')
  check('member.md: 監査依頼が done.sh 実行より前に書かれている',
    auditIdx !== -1 && doneShIdx !== -1 && auditIdx < doneShIdx,
    `auditIdx=${auditIdx} doneShIdx=${doneShIdx}`)
}

// 2. member.md: 監査前の done.sh 実行を明示的に禁じている
check('member.md: 監査所見が付く前に done.sh を実行しないと明記', member.includes('監査所見が付く前に done.sh を実行しない'))

// 3. member.md: 探索順が明記されている
check('member.md: active→ready→文脈近接peer audit→待機の探索順を明記',
  member.includes('探索順は active → ready → 文脈近接 peer audit → 待機である'))

// 4. member.md: turn を閉じる前の記録義務
check('member.md: active turnを記録せず閉じない規律を明記',
  member.includes('active な工程を持つターンは、進捗・完了・blocker・明示的待機のいずれかを room へ記録せずに終えない'))

// 5. member.md: 旧「done後監査」を示す文言（他の席の done を監査する）が除去されている
check('member.md: 旧「他の席の done を監査する」文言が除去されている',
  !member.includes('他の席の done を監査する'))

// 6. member-standalone.md: 完了([done])より前に監査依頼が来る
{
  const auditIdx = standalone.indexOf('[監査依頼] <タスク>')
  const doneIdx = standalone.lastIndexOf('[done] <タスク>')
  check('member-standalone.md: 監査依頼が [done] 宣言より前に書かれている',
    auditIdx !== -1 && doneIdx !== -1 && auditIdx < doneIdx,
    `auditIdx=${auditIdx} doneIdx=${doneIdx}`)
}
check('member-standalone.md: 監査所見が付く前に[done]を出さないと明記',
  standalone.includes('監査所見が付く前に `[done]` を出さない'))
check('member-standalone.md: active→ready→文脈近接peer audit→待機の探索順を明記',
  standalone.includes('探索順は active → ready → 文脈近接 peer audit → 待機である'))

// 7. charter.md: 監査ゲート原則とturn記録義務
check('charter.md: 監査前に完了状態にしない原則を明記',
  charter.includes('監査前に工程正本') && charter.includes('完了状態にしない'))
check('charter.md: turnを記録せず終えない規律を明記',
  charter.includes('記録せずに自分のターンを終えない'))

console.log(ok ? 'member audit-before-done repro: green' : 'member audit-before-done repro: RED')
process.exit(ok ? 0 : 1)
