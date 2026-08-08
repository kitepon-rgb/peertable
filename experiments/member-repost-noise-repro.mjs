#!/usr/bin/env node
// 既存メンバーへの再 POST が room を汚す欠陥の再現ハーネス（t14/t15 の前提）。
//
// usage: member-repost-noise-repro.mjs [<room/server.mjs へのpath>]
//   既定は room/server.mjs。旧版を第1引数で指せば負のコントロールになる:
//     git show <commit>:room/server.mjs > /tmp/old-server.mjs
//     node experiments/member-repost-noise-repro.mjs /tmp/old-server.mjs
//
// 欠陥: `POST /api/<room>/members` の `post(room,'system','all','<名前> が参加した')` が
// `if (!room.members.has(name))` の**外**にあるため、**既存メンバーへの再 POST でも system 発言が出る**。
// 2026-08-08、稼働状態ブリッジの試走で6件撒いて全席を起こした（room [274]-[279]）。
// これは t14（素性 metadata の upsert）と t15（稼働状態の定期送信）の**両方が乗る前提**で、
// どちらも「member を繰り返し更新する」設計なので、直さないと更新のたびに卓が起こされる。
//
// 期待する形（直った版）:
//   - 新規メンバーの登録 → system 発言が1件出る（参加は知らせるべき事実）
//   - 既存メンバーへの再 POST → **system 発言は増えない**（更新は通知ではない）
//   - `joined_at` は最初の登録のまま動かない
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

// **固定の既定ポートを持たない。** 卓では複数の席が同時に使い捨て server を立てるので、既定値を
// 持つと他人の server に当たる。しかも当たったことに気づけない（相手は 200 を返す）——2026-08-08、
// 既定 8816 が他席の宣言と衝突して、別の server と喋りながら「保存されない」と読みかけた。
const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const server = process.argv[2] ?? 'room/server.mjs'
const port = Number(process.env.PORT) || await freePort()
const base = `http://127.0.0.1:${port}/api/repro`
const data = mkdtempSync(join(tmpdir(), 'peertable-repost-'))

// トークンは**空文字ではなく削除**する。server は `?? null` で見ているので、`''` を渡すと
// 「空文字のトークンを要求する」状態になり、書込が全部 403 になる（2026-08-08 実測・2回踏んだ）
const childEnv = { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data }
delete childEnv.PEERTABLE_POST_TOKEN
// **起動失敗を握り潰さない。** stderr を捨てると `EADDRINUSE` が1文字も出ず、他人の server に
// 当たっている事実が消える
let childErr = ''
const child = spawn('node', [server], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] })
child.stderr.on('data', d => { childErr += d })
child.on('exit', code => { if (code) console.error(`  子 server が終了した（code ${code}）: ${childErr.trim()}`) })
const cleanup = () => { child.kill(); rmSync(data, { recursive: true, force: true }) }

const wait = ms => new Promise(r => setTimeout(r, ms))
const seq = async () => (await (await fetch(`${base}/messages`)).json()).messages.length
const members = async () => (await (await fetch(`${base}/members`)).json()).members
const put = (body) => fetch(`${base}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

let ok = true
const check = (name, pass, detail) => { console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!pass) ok = false }

try {
  // **自分の子が実際にそのポートを掴んだことを、子の起動ログで確かめる。** 応答が返ることは
  // 「自分の子に繋がった」証明にならない——他人の server が同じポートで応答していても 200 は返る。
  // room が空かどうかでも判定できない（他人の server にも、この room 名は無い）。
  // 確実なのは「私の子が `on :<port>` を出したか」だけ（2026-08-08 実測。ここを緩くしていて、
  // 他人の server と喋りながら全項目 pass を読みかけた）
  const started = await Promise.race([
    new Promise(r => { const t = setInterval(() => { if (childErr.includes(`on :${port}`)) { clearInterval(t); r(true) } }, 50) }),
    wait(6000).then(() => false),
  ])
  if (!started) {
    console.error(`  子 server が port ${port} を掴めていない（他人の server が居る／起動に失敗した）。中止する`)
    if (childErr.trim()) console.error(`  子の出力: ${childErr.trim()}`)
    process.exit(2)
  }
  console.log(`対象: ${server}（port ${port}）`)

  await put({ name: 'ことは' })
  const afterFirst = await seq()
  check('新規登録は system 発言を1件出す', afterFirst === 1, `発言数 ${afterFirst}`)
  const joined = (await members())[0].joined_at

  await wait(20)
  await put({ name: 'ことは', status: 'busy' })
  await put({ name: 'ことは', status: 'idle' })
  await put({ name: 'ことは', model: 'opus' })
  const afterRepost = await seq()
  // ここが本体。旧版は 1→4 に増える（更新3回ぶん撒く）
  check('既存メンバーへの再 POST は system 発言を増やさない', afterRepost === afterFirst,
    `発言数 ${afterFirst} → ${afterRepost}${afterRepost > afterFirst ? `（${afterRepost - afterFirst} 件撒いた）` : ''}`)

  const now = (await members())[0]
  check('joined_at は最初の登録のまま', now.joined_at === joined, `${joined} → ${now.joined_at}`)

  await put({ name: 'いちか' })
  const afterSecond = await seq()
  check('別の新規メンバーは system 発言を出す', afterSecond === afterRepost + 1, `発言数 ${afterRepost} → ${afterSecond}`)
} finally {
  cleanup()
}
console.log(ok ? 'すべて pass' : '失敗あり')
process.exit(ok ? 0 : 1)
