#!/usr/bin/env node
// Lattice の pull 型 run を円卓へ可視化する常駐。**AI ではない**し、**席へ1バイトも送らない**。
//
// usage: run-bridge.mjs <project_dir> [--lattice <path>]   起動（前面。nohup で常駐させる）
//        run-bridge.mjs <project_dir> --stop               停止
//
// **この常駐は仕事を配らない。** 2026-08-09 のオーナー裁定（改・裁定1）で、装置が席を選んで
// 仕事を配る向きは撤回された——**作業を選ぶのも始めるのも AI** であり、Lattice がやるのは
// 着手済み ToDo 間の競合判定と介入だけである。旧版が持っていた席選定・`[配車]` 投稿・
// `[受諾]`/`[辞退]` の再配車・work report の書き込みは、その向きの部品なので**全部落とした**。
//
// 残った役目は2つだけで、**どちらも読み取りである**:
//   1. pull run の進行（`lattice run observe`）を、変化した時だけ room へ1行返す
//   2. 装置が出した介入（hold）を、その作業を始めた席宛に room へ返す
//
// **この常駐は必須経路ではない。** 席は自分で `run intake` / `attach` / `accept` を打ち、
// 介入は `run intake intervention` で自分でも読めるので、bridge が落ちていても作業は進む——
// 見えなくなるだけである（peertable 決定63・相互独立）。
// 書き込む先は room だけで、spool にも run store にも1バイトも書かない。
//
// 生死の作法は Lattice ADR 0157 に倣う: 自分の pid を記録に置き、起動時に前の記録を掃除し、
// 止まらなければ黙って諦めず typed error で落ちる。
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolvePostToken } from './seat-usage.mjs'
import { observePidCommand } from './seat-identity.mjs'

const run = promisify(execFile)
const [proj, ...rest] = process.argv.slice(2)
if (!proj) {
  console.error('usage: run-bridge.mjs <project_dir> [--lattice <path>] | <project_dir> --stop')
  process.exit(1)
}

const record = join(proj, '.team', 'run-bridge.json')
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = line => console.log(`[${new Date().toISOString()}] ${line}`)

// pid だけを頼りに signal を送らない（ADR 0157）。**pid は再利用される**ので、記録した
// 起動時刻（ps の lstart）と command line を照合し、通った相手にだけ送る。照合が合わない記録は
// 「自分の常駐ではない誰か」なので、掃除はしても**殺さない**。
async function processFacts(pid) {
  // ps 観測は seat-identity.mjs（OS観測ライブラリ）が唯一の所有者
  try {
    const { started_identity: startIdentity, argv: command } = observePidCommand(pid)
    return { startIdentity, command }
  } catch { return null }
}

async function stopRecorded({ strict = false } = {}) {
  if (!existsSync(record)) return
  const stored = JSON.parse(readFileSync(record, 'utf8'))
  const { pid } = stored
  const facts = await processFacts(pid)
  if (facts === null || !alive(pid)) {
    unlinkSync(record); log(`死んだ記録を掃除した（pid ${pid}）`); return
  }
  const sameProcess = stored.start_identity === undefined
    ? false   // 旧形式の記録は再認証できない＝殺さない
    : facts.startIdentity === stored.start_identity
      && facts.command.includes('run-bridge.mjs')
      && facts.command.includes(proj)
  if (!sameProcess) {
    unlinkSync(record)
    const detail = `pid ${pid} は記録した常駐ではない（観測: ${facts.startIdentity} / ${facts.command.slice(0, 120)}）`
    if (strict) {
      console.error(`RUN_BRIDGE_RECORD_STALE: ${detail}。**signal は送っていない**——`
        + '本物の常駐が別 pid で生きている可能性があるので、`ps` で確認して手で止めること')
      process.exit(1)
    }
    log(`RUN_BRIDGE_RECORD_STALE: ${detail}。signal を送らずに記録だけ掃除した`)
    return
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 25 && alive(pid); i++) await sleep(200)
  if (alive(pid)) {
    process.kill(pid, 'SIGKILL')
    for (let i = 0; i < 15 && alive(pid); i++) await sleep(200)
  }
  if (alive(pid)) {
    console.error(`RUN_BRIDGE_STOP_FAILED: pid ${pid} が SIGKILL でも止まらない`)
    process.exit(1)
  }
  if (existsSync(record)) unlinkSync(record)
  log(`前のブリッジを停止した（pid ${pid}）`)
}

// **引数の検査は前のブリッジを止めるより先にやる。** 逆順にすると、旧版の command line
// （spool dir と席名つき）で叩いた人が「動いているブリッジを殺してから起動に失敗する」——
// 正典が旧形式を載せていた期間があるので、これは実際に起きる（自分で踏んで気づいた）。
// `--stop` はここを通さない。止めるだけの呼び出しに `--lattice` は要らない。
let latticeCli = 'lattice'
if (rest[0] !== '--stop') {
  // `--lattice <path>` は任意。既定は PATH 上の `lattice`。**release 前の source tree を実測する時**は
  // ここで実物を指す。PATH の install は publish 済みの版なので、**version 表示が同じでも**
  // 未 publish の schema を読めず `INVALID_RUN_STORE` 等で落ちる（2026-08-09 に卓で3件実測）。
  const latticeFlag = rest.indexOf('--lattice')
  if (latticeFlag >= 0) {
    latticeCli = rest[latticeFlag + 1] ?? ''
    if (latticeCli.length === 0) {
      console.error('RUN_BRIDGE_ARGS_INVALID: --lattice には実行可能な path を渡すこと')
      process.exit(1)
    }
    rest.splice(latticeFlag, 2)
  }
  if (rest.length > 0) {
    // 旧版は spool dir と席名を受けていた。**黙って無視すると、配車が来ないのを不具合と読む。**
    console.error(`RUN_BRIDGE_ARGS_INVALID: 余分な引数 ${rest.join(' ')}。`
      + '**この常駐はもう配車をしないので spool dir も席名も取らない**（改・裁定1）。'
      + '席は自分で run intake を打ち、bridge は run の進行と介入を room へ返すだけである')
    process.exit(1)
  }
}

await stopRecorded({ strict: rest[0] === '--stop' })
if (rest[0] === '--stop') process.exit(0)

const state = JSON.parse(readFileSync(join(proj, '.team', 'setup-state.json'), 'utf8'))
const { room, server_url: url } = state
// launch-seat.sh:25-27 と同じ解決規則（env が先・無ければ `~/.config/peertable.env`）。
// **`export` の有無に常駐の生死を握らせない**——seat-status-bridge が同じ依存で4時間死んだ（2026-08-10）
const token = resolvePostToken(process.env)
if (token.length === 0) {
  // 投稿できないブリッジは何も返せない。起きてから黙って何もしない常駐を作らない
  console.error('RUN_BRIDGE_TOKEN_MISSING: 書込トークンが無い（環境変数 PEERTABLE_POST_TOKEN か ~/.config/peertable.env）')
  process.exit(1)
}

// 記録には pid だけでなく**起動時刻と command line**を入れる。停止側はこれで再認証する
const selfFacts = await processFacts(process.pid)
if (selfFacts === null) {
  console.error('RUN_BRIDGE_SELF_UNOBSERVABLE: 自分の process を ps で観測できない')
  process.exit(1)
}
writeFileSync(record, JSON.stringify({
  pid: process.pid, start_identity: selfFacts.startIdentity, command: selfFacts.command,
  room, server_url: url, started_at: new Date().toISOString(),
}) + '\n')
const cleanup = () => { if (existsSync(record)) unlinkSync(record); process.exit(0) }
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)

async function post(to, body) {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-peertable-token': token },
    body: JSON.stringify({ from: 'run-bridge', to, body }),
  })
  if (!res.ok) throw new Error(`room post ${res.status}`)
}

// cwd を project へ固定する。run ref は repo 相対なので、bridge がどこから起こされても解決する。
// **絶対 path を渡すと公開 CLI が `INVALID_RUN_REF` で拒否する**（2026-08-09 の t11 で実測）。
async function lattice(args) {
  const { stdout } = await run(latticeCli, args, { cwd: proj, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout)
}

const runSummaries = new Map()      // run_ref -> 直近に記録した要約
const interventions = new Map()     // `${run_ref}\0${task_id}` -> 直近に観測した介入の形
const closedRuns = new Set()        // closed を観測した run。以後 poll しない
let pollTicks = 0
let readyRecorded = false
function markReady() {
  if (readyRecorded) return
  const temp = `${record}.tmp`
  writeFileSync(temp, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), ready_at: new Date().toISOString() }) + '\n')
  renameSync(temp, record)
  readyRecorded = true
}

// **どの run を見るかは `run list` から取る。** 旧版は order の worktree_path から run dir を
// 切り出していたが、その order がもう出ないので、装置に聞く形へ変えた。
// `selection: 'pull'` だけを対象にする——legacy automatic run は席が居ないので中継しても意味がない。
async function pullRunRefs() {
  const listed = await lattice(['run', 'list', '--json'])
  markReady()
  return (listed.active_runs ?? [])
    .filter(entry => entry.selection === 'pull' && typeof entry.run_ref === 'string')
    .map(entry => entry.run_ref)
    .filter(ref => !closedRuns.has(ref))
    .sort()
}

function summarize(observation) {
  const intakes = observation.intakes ?? []
  const held = intakes.filter(entry => entry.intervention?.state === 'hold').map(entry => entry.task_id)
  const accepted = intakes.filter(entry => entry.accepted_head_sha !== null).map(entry => entry.task_id)
  const working = intakes.filter(entry => entry.accepted_head_sha === null).map(entry => entry.task_id)
  return `intake=[${working}] accepted=[${accepted}] hold=[${held}] closed=${observation.closed}`
}

// 介入は**その作業を始めた席**へ返す。誰が始めたかは観測が持っている（`intake.actor.agent`）ので、
// bridge が Todo store の内部構造を読みに行く必要はない。
function interventionText(runRef, intake) {
  const reason = intake.intervention?.reason ?? '(理由なし)'
  return [
    `[介入] ${intake.task_id} — ${intake.intervention?.state}`,
    `run: ${runRef}`,
    `理由: ${reason}`,
    `worktree: ${intake.worktree_path}`,
    '',
    '装置が競合を見て**留まれ**と言っている。作業を止めて room で調整するか、',
    `解消したら \`lattice run intake intervention --run ${runRef} --task ${intake.task_id}\` で読み直す。`,
  ].join('\n')
}

async function pollRuns() {
  let refs
  try { refs = await pullRunRefs() }
  catch (error) {
    // 観測できないことを黙らない。**沈黙を「異常なし」の証拠にしない**
    const detail = String(error?.stderr ?? error?.message ?? error).split('\n')[0].slice(0, 200)
    log(`run list 失敗: ${detail}`)
    return
  }
  for (const ref of refs) {
    let observation
    try { observation = await lattice(['run', 'observe', '--run', ref]) }
    catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? error).split('\n')[0].slice(0, 200)
      const summary = `observe 失敗: ${detail}`
      // 1 run の失敗で他の run の報告を止めない
      if (runSummaries.get(ref) !== summary) { runSummaries.set(ref, summary); log(`${ref}: ${summary}`) }
      continue
    }

    // 介入は run 要約より先に返す。**留まれという指示が要約の後ろに埋もれない**ようにする
    for (const intake of observation.intakes ?? []) {
      const key = `${ref}\0${intake.task_id}`
      const shape = `${intake.intervention?.state}\0${intake.intervention?.reason ?? ''}`
      if (interventions.get(key) === shape) continue   // 変化が無い間は鳴らさない
      interventions.set(key, shape)
      if (intake.intervention?.state !== 'hold') continue   // none は静かに通す（通知は要らない）
      const seat = intake.actor?.agent
      if (typeof seat !== 'string' || seat.length === 0) {
        // broadcast は存在しない。宛先不明を黙らせず、local logへtypedに残す。
        log(`RUN_BRIDGE_RECIPIENT_UNKNOWN: 介入の宛先を決められない: ${ref} ${intake.task_id}`)
        continue
      }
      log(`介入: ${ref} ${intake.task_id} → ${seat}（${intake.intervention.reason ?? ''}）`)
      await post(seat, interventionText(ref, intake))
    }

    const summary = summarize(observation)
    if (runSummaries.get(ref) !== summary) {
      runSummaries.set(ref, summary)
      log(`run 進行: ${ref} ${summary}`)
    }
    // closed は終端。最後の状態をlocal logへ記録してから外す
    if (observation.closed === true) {
      closedRuns.add(ref)
      log(`run 終端を観測したので poll を止める: ${ref}`)
    }
  }
  // 変化が無い時も1分に1回は件数を出す（沈黙を「異常なし」の証拠にしない）
  pollTicks += 1
  if (pollTicks % 6 === 1) log(`pull run ${refs.length} 件を観測中`)
}

log(`bridge start: room=${room} project=${proj} pid=${process.pid}（配車はしない・観測と中継だけ）`)
for (;;) {
  try { await pollRuns() }
  catch (error) { log(`run 観測に失敗（続行する）: ${error.message}`) }
  await sleep(10_000)
}
