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
//   4. 待機の全体投稿をせず親だけへDMし、turn終了時の次の行動を自分宛DMする
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
const skill = await read('skill/SKILL.md')

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

// 4. member.md: 待機を全体へ流さず、turn終了時は自分宛DMにする
check('member.md: 待機をallへ投稿しないと明記',
  member.includes('待機を `to: "all"` へ投稿しない'))
check('member.md: 待機は最終手段として親だけへDMすると明記',
  member.includes('最終手段として `[待機] ...` を親（bell 等、その卓の親名）だけへDMする'))
check('member.md: turn終了時の次の行動を自分宛DMすると明記',
  member.includes('次に行う作業または再確認条件を `post(to: "<自分の名前>"'))

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
check('member-standalone.md: 待機をallへ投稿しないと明記',
  standalone.includes('待機を `to: "all"` へ投稿しない'))
check('member-standalone.md: 待機は最終手段として親だけへDMすると明記',
  standalone.includes('最終手段として `[待機] ...` を親（bell 等、その卓の親名）だけへDMする'))
check('member-standalone.md: turn終了時の次の行動を自分宛DMすると明記',
  standalone.includes('次に行う作業または再確認条件を `post(to: "<自分の名前>"'))

// 7. charter.md: 監査ゲート原則と宛先規則
check('charter.md: 監査前に完了状態にしない原則を明記',
  charter.includes('監査前に工程正本') && charter.includes('完了状態にしない'))
check('charter.md: turn終了時の次の行動は自分宛と明記',
  charter.includes('ターン終了時の次の行動は `post(to: "<自分の名前>")`'))
check('charter.md: 待機宣言は最終手段として親だけへDMすると明記',
  charter.includes('待機宣言は最終手段として親だけへDMし、`all`へ送らない'))

// 8. 実装監査は監査済み計画とToDoの実現確認だけに限定し、思想で計画を再審議しない
check('member.md: 元PLANと工程正本を絶対の正本として固定',
  member.includes('元PLANの当該節・そのPLANから作られた工程正本のToDo・明記された受入条件・実成果だけ')
    && member.includes('元PLANと工程正本を絶対の正本として扱う'))
check('member.md: 個人の思想・異論・代替案を監査へ持ち込まない',
  member.includes('円卓メンバー個人の思想・異論・代替案は求められていない'))
check('member.md: 計画外改善を監査所見・差し戻し・起票・工程追加へ混ぜない',
  member.includes('監査所見・差し戻し・`todo note`・課題起票・工程追加のどこにも混ぜない'))
check('member.md: 従えない監査者は監査を降りて退席',
  member.includes('従えないなら監査を降りて退席する'))
check('member.md: 親の監査は制限対象外',
  member.includes('この制限は円卓メンバーの監査だけに適用し、親の監査には適用しない'))
check('standalone.md: 議題の思想監査と計画外改善の混入を禁止',
  standalone.includes('元PLAN（単独円卓では監査済み議題）')
    && standalone.includes('正本へ逆らわず')
    && standalone.includes('監査所見・差し戻し・課題起票・議題追加へ混ぜない'))
check('charter.md: 絶対の正本・退席・親監査除外を明記',
  charter.includes('元PLANと、そのPLANから作られた工程正本のToDo')
    && charter.includes('従えない監査者は監査を降りて退席する')
    && charter.includes('親の監査には適用しない'))
check('SKILL.md: 円卓監査を正本へ拘束し親監査を除外',
  skill.includes('監査済みの元PLAN')
    && skill.includes('正本へ逆らわず')
    && skill.includes('親の監査には適用しない'))
check('SKILL.md: 受入条件外を申し送りにする旧逃げ道を除去',
  !skill.includes('受入条件外なら「修正を求めない申し送り」')
    && skill.includes('受入条件外の思想・改善案は「申し送り」と言い換えて残さず'))

console.log(ok ? 'member audit-before-done repro: green' : 'member audit-before-done repro: RED')
process.exit(ok ? 0 : 1)
