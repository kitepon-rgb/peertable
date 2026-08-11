#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const TOKEN = 'room-summary-repro-token'
const ROOM = 'room-summary-repro'
const CORRUPT_ROOM = 'room-summary-repro-corrupt'
const root = mkdtempSync(join(tmpdir(), 'peertable-room-summary-'))

// 末尾行が壊れている room を先に用意する。summary が読むのは末尾1行だけなので、
// loadRoom の parse が壊れた行で throw せず last_ts:null に落ちることをここで固定する。
const corruptDir = join(root, CORRUPT_ROOM)
mkdirSync(corruptDir, { recursive: true })
writeFileSync(join(corruptDir, 'log.jsonl'), '{"seq":1,"ts":"2026-01-01T00:00:00.000Z","from":"x","body":"ok"}\nnot json\n')

async function freePort() {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  probe.close()
  await once(probe, 'close')
  return port
}

function spawnServer(port) {
  const child = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
    env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: root, PEERTABLE_POST_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  return { child, getOutput: () => output }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (label, condition, detail = '') => {
  checks.push({ label, condition, detail })
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function waitReady(base) {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${base}/messages`)
      if (response.ok) return
    } catch {}
    await sleep(50)
  }
  throw new Error('room server did not start')
}

async function stop({ child }) {
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

let server = null
try {
  const port = await freePort()
  server = spawnServer(port)
  const base = `http://127.0.0.1:${port}/api/${ROOM}`
  const apiBase = `http://127.0.0.1:${port}/api`
  const corruptBase = `http://127.0.0.1:${port}/api/${CORRUPT_ROOM}`
  const jsonHeaders = { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN }
  await waitReady(base)

  // room一覧: DATA直下の実在ディレクトリだけを、動的発見用の軽量APIで返す
  const roomsRes = await fetch(`${apiBase}/rooms`)
  const roomList = await roomsRes.json()
  check('room一覧はtoken無しでも200', roomsRes.status === 200)
  check('room一覧schemaがpeertable.rooms.v1', roomList.schema === 'peertable.rooms.v1')
  check('room一覧は実在ディレクトリを昇順で返す',
    JSON.stringify(roomList.rooms) === JSON.stringify([CORRUPT_ROOM]), JSON.stringify(roomList.rooms))
  check('room一覧にCORSヘッダ', roomsRes.headers.get('access-control-allow-origin') === '*')

  // 未取得room: 200・ゼロ値・ディレクトリを作らない（GET は create=false）
  const freshRes = await fetch(`${base}/summary`)
  const fresh = await freshRes.json()
  check('未存在roomでも200', freshRes.status === 200)
  check('schemaがpeertable.summary.v1', fresh.schema === 'peertable.summary.v1')
  check('seq=0', fresh.seq === 0)
  check('last_ts=null（0やepochで埋めない）', fresh.last_ts === null)
  check('member_count=0', fresh.member_count === 0)
  check('GETはroomディレクトリを作らない', !existsSync(join(root, ROOM)))

  // GET はトークンゲートより上に居る——TOKEN設定下でヘッダ無しでも summary が通ることを固定する
  const noTokenRes = await fetch(`${base}/summary`)
  check('summaryはtoken無しでも200（読み取り系はゲート対象外）', noTokenRes.status === 200)

  // CORS: 読み取り系は越境許可
  check('summaryにCORSヘッダ', freshRes.headers.get('access-control-allow-origin') === '*')

  // 発言を1件投げてからの in-memory 更新
  const post1 = await fetch(`${base}/messages`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ from: 'hinata', to: 'koharu', body: 'one' }),
  })
  const msg1 = await post1.json()
  const afterFirst = await (await fetch(`${base}/summary`)).json()
  check('post直後にseqが1へ', afterFirst.seq === 1, JSON.stringify(afterFirst))
  check('post直後にlast_tsがmsg.tsと一致', afterFirst.last_ts === msg1.ts, `${afterFirst.last_ts} vs ${msg1.ts}`)

  // 2件目でseq/last_tsが両方進む（post()内での更新を確認）
  await sleep(5)
  const post2 = await fetch(`${base}/messages`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ from: 'koharu', to: 'hinata', body: 'two' }),
  })
  const msg2 = await post2.json()
  const afterSecond = await (await fetch(`${base}/summary`)).json()
  check('2件目でseqが2へ', afterSecond.seq === 2)
  check('2件目でlast_tsが最新へ更新', afterSecond.last_ts === msg2.ts && afterSecond.last_ts !== afterFirst.last_ts)

  // member登録・削除でmember_countだけが動く（seq/last_tsは不変）
  await fetch(`${base}/members`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'hinata' }) })
  const roomsAfterCreate = await (await fetch(`${apiBase}/rooms`)).json()
  check('書込で生まれたroomが一覧へ自動反映される',
    roomsAfterCreate.rooms.includes(ROOM), JSON.stringify(roomsAfterCreate.rooms))
  const afterJoinSummary = await (await fetch(`${base}/summary`)).json()
  check('member登録でmember_countが1へ', afterJoinSummary.member_count === 1)
  check('member登録はsystem発言を伴うのでseqが進む', afterJoinSummary.seq === 3)

  await fetch(`${base}/members/${encodeURIComponent('hinata')}`, { method: 'DELETE', headers: jsonHeaders })
  const afterLeaveSummary = await (await fetch(`${base}/summary`)).json()
  check('member削除でmember_countが0へ', afterLeaveSummary.member_count === 0)
  check('member削除はseqを進めない（DELETEはpost()を呼ばない）', afterLeaveSummary.seq === 3)
  // 本改修の核: 席が消えてもログの新しさ(last_ts)は残る。member_countとlast_tsは独立に動く
  check('member削除後もlast_tsは保持される（席が消えてもログの新しさは残る）',
    afterLeaveSummary.last_ts === afterJoinSummary.last_ts, `${afterLeaveSummary.last_ts} vs ${afterJoinSummary.last_ts}`)

  // 壊れた末尾行: throwせずlast_ts:nullへ落ち、他エンドポイント（/members・/events）も巻き添えで死なない
  const corruptSummary = await (await fetch(`${corruptBase}/summary`)).json()
  check('壊れた末尾行でもseqは行数のまま', corruptSummary.seq === 2, JSON.stringify(corruptSummary))
  check('壊れた末尾行はlast_ts:nullへ落ちる（throwしない）', corruptSummary.last_ts === null)
  const corruptMembersRes = await fetch(`${corruptBase}/members`)
  check('壊れた末尾行でも/membersは巻き添えで死なない', corruptMembersRes.status === 200)
  const eventsController = new AbortController()
  const corruptEventsRes = await fetch(`${corruptBase}/events`, { signal: eventsController.signal })
  check('壊れた末尾行でも/eventsは巻き添えで死なない',
    corruptEventsRes.status === 200 && corruptEventsRes.headers.get('content-type')?.includes('text/event-stream'))
  eventsController.abort()

  // CORS: 読み取り系だけに付き、書込系には付かない（越境書込が成立しないことの型）
  check('POST /messagesにはCORSヘッダが付かない', post2.headers.get('access-control-allow-origin') === null)

  // 後方互換: /members・/messagesの応答形状が本改修で変わっていない
  const membersShape = await (await fetch(`${base}/members`)).json()
  check('/membersの形状が既存のまま', Array.isArray(membersShape.members)
    && membersShape.members.every(m => 'name' in m)
    && membersShape.capabilities?.member_observation_v1 === true, JSON.stringify(membersShape))
  const KNOWN_MESSAGE_FIELDS = new Set(['seq', 'ts', 'from', 'body', 'to', 'to_names'])
  const { messages } = await (await fetch(`${base}/messages`)).json()
  check('/messagesの各要素が既存の欄集合のまま', messages.length > 0
    && messages.every(m => Object.keys(m).every(k => KNOWN_MESSAGE_FIELDS.has(k))), JSON.stringify(messages))

  await stop(server)
  server = null

  // プロセス再起動: loadRoom がディスクの log.jsonl から last_ts を復元できることを固定する
  const port2 = await freePort()
  server = spawnServer(port2)
  const base2 = `http://127.0.0.1:${port2}/api/${ROOM}`
  await waitReady(base2)
  const restarted = await (await fetch(`${base2}/summary`)).json()
  check('再起動後もディスクからseqを復元', restarted.seq === 3, JSON.stringify(restarted))
  check('再起動後もディスクからlast_tsを復元', restarted.last_ts === afterJoinSummary.last_ts)
} finally {
  if (server) await stop(server)
  rmSync(root, { recursive: true, force: true })
}

process.exit(checks.every(c => c.condition) ? 0 : 1)
