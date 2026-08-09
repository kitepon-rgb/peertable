#!/usr/bin/env node
// wakeup-bridge が「繋がったまま取りこぼしている」状態から自力で復帰することの再現ハーネス。
// この経路は watchdog では原理的に検出できない（心拍が届く限り最終受信時刻は更新され続ける）ので、
// 心拍が積んでくる room の最新 seq との差分だけが手掛かりになる。欠陥は沈黙する＝
// 「起こされないまま静かに続く」ので、実プロセスを走らせてログで観測する（cursor-repro.mjs と同じ方針）。
//
// usage: node experiments/bridge-catchup-repro.mjs [port] [bridge.mjs のパス]
//   第2引数で古い版の bridge を指せば、ハーネスが**欠陥を実際に検出する**ことを確かめられる
//   （例: `git show 387bce0:skill/scripts/wakeup-bridge.mjs > /tmp/old.mjs` → 非ゼロで落ちる）
// 期待: `心拍が示す最新 seq 3 に追いついていない` → `取りこぼし確認（心拍の差分・since 1）: 2 件`
//       → 起床が走る（tmux 席が無ければ「起こせなかった」で出るが、配達判断が走ったことは分かる）
//
// 本物の room サーバーは使わない。**心拍だけを流して本文を1件も送らない stub** を立てることで、
// bridge に内部状態を触る口を開けずに「取りこぼした状態」を外から作る（kotoha の提案・room [132]）。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 18899)
const ROOM = 'catchup-repro'
const SEAT = 'nobody' // tmux 席は用意しない。見たいのは配達判断であって送信の成否ではない

// stub が抱える「本当の」履歴。head を進めると、bridge から見て取りこぼしが生まれる
const messages = [{ seq: 1, ts: new Date(0).toISOString(), from: 'bell', to: SEAT, body: '起動前からある発言' }]
let head = 1
const streams = new Set()

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === `/api/${ROOM}/events`) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(`: connected seq=${head}\n\n`)
    streams.add(res)
    req.on('close', () => streams.delete(res))
    return
  }
  if (url.pathname === `/api/${ROOM}/messages`) {
    const since = Number(url.searchParams.get('since') ?? 0)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ messages: messages.filter(m => m.seq > since) }))
    return
  }
  res.writeHead(404).end()
})

// 心拍だけを流す。**本文（data: {...}）は一度も送らない**のが仕掛けの本体
const beat = setInterval(() => {
  for (const res of streams) res.write(`event: ping\ndata: ${head}\n\n`)
}, 2000)

await new Promise(resolve => server.listen(port, resolve))

const dir = mkdtempSync(join(tmpdir(), 'bridge-repro-'))
mkdirSync(join(dir, '.team'), { recursive: true })
writeFileSync(join(dir, '.team', 'setup-state.json'), JSON.stringify({
  room: ROOM, server_url: `http://127.0.0.1:${port}`, mode: 'standalone', plan_key: '',
}) + '\n')

const bridgePath = process.argv[3] ?? new URL('../skill/scripts/wakeup-bridge.mjs', import.meta.url).pathname
const child = spawn('node', [bridgePath, dir, SEAT], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', c => { log += c.toString('utf8') })
child.stderr.on('data', c => { log += c.toString('utf8') })

const sleep = ms => new Promise(r => setTimeout(r, ms))
await sleep(3000) // 頭出し（seq 1 まで既読）を済ませる

// ここで「繋がったまま取りこぼした」状態を作る: 履歴だけ進めて、本文は流さない
messages.push(
  { seq: 2, ts: new Date().toISOString(), from: 'bell', to: SEAT, body: '取りこぼした発言A' },
  { seq: 3, ts: new Date().toISOString(), from: 'bell', to: SEAT, body: '取りこぼした発言B' },
)
head = 3

await sleep(6000) // 心拍2〜3回ぶん待つ

child.kill('SIGTERM')
clearInterval(beat)
for (const res of streams) res.end()
server.close()
await sleep(300)

const noticed = /心拍が示す最新 seq 3 に追いついていない/.test(log)
const recovered = /取りこぼし確認（心拍の差分・since 1）: 2 件/.test(log)
const delivered = /(起こした|起こせなかった): nobody ← 2 件/.test(log)

console.log(log.trim())
console.log('---')
console.log(`心拍の差分に気づいた: ${noticed}`)
console.log(`取りこぼしを回収した: ${recovered}`)
console.log(`配達判断まで走った: ${delivered}`)
rmSync(dir, { recursive: true, force: true })
process.exit(noticed && recovered && delivered ? 0 : 1)
