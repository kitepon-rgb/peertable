#!/usr/bin/env node
// post が受信カーソルを進める欠陥の再現ハーネス（0.2.1 で修正した挙動の回帰検出）。
// 欠陥は沈黙する（例外も red も出ない）ので、実プロセスを JSON-RPC で駆動して観測する。
//
// usage: node experiments/cursor-repro.mjs <client.mjs のパス> <room サーバー URL>
// 期待: 修正前は「未読なし」（他人の発言を取りこぼす）／修正後は他人の発言が返る
import { spawn } from 'node:child_process'

const [clientPath, url] = process.argv.slice(2)
if (!clientPath || !url) {
  console.error('usage: node experiments/cursor-repro.mjs <client.mjs> <server_url>')
  process.exit(2)
}
const ROOM = 'cursor-repro'
const ME = 'alice'
const OTHER = 'bob'
const token = process.env.PEERTABLE_POST_TOKEN ?? ''
const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Peertable-Token': token } : {}) }

const child = spawn('node', [clientPath], {
  env: { ...process.env, PEERTABLE_URL: url, PEERTABLE_ROOM: ROOM, PEERTABLE_MEMBER: ME },
  stdio: ['pipe', 'pipe', 'inherit'],
})

let buf = ''
const waiters = new Map()
child.stdout.on('data', chunk => {
  buf += chunk.toString('utf8')
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const w = waiters.get(msg.id)
    if (w) { waiters.delete(msg.id); w(msg) }
  }
})

let id = 0
const rpc = (method, params) => new Promise(resolve => {
  const reqId = ++id
  waiters.set(reqId, resolve)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }) + '\n')
})
const notify = method => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'cursor-repro', version: '1' },
})
notify('notifications/initialized')
await sleep(500) // client 側の参加登録とカーソル初期化を待つ

// 1) 他人が発言する（alice はまだ読んでいない）
await fetch(`${url}/api/${ROOM}/messages`, {
  method: 'POST', headers,
  body: JSON.stringify({ from: OTHER, to: 'alice', body: '取りこぼされてはいけない発言' }),
})
await sleep(300)

// 2) alice が発言する（ここで cursor を進めるのが欠陥）
console.log('post →', await call('post', { to: OTHER, message: 'alice の発言' }))

// 3) alice が未読を読む
const unread = await call('read_unread')
console.log('read_unread →', unread)

child.kill()
const lost = unread.includes('未読なし')
console.log(lost
  ? '結果: 取りこぼした（欠陥あり）'
  : '結果: 取りこぼさなかった（修正済み）')
process.exit(lost ? 1 : 0)
