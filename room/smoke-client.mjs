#!/usr/bin/env node
// client.mjs の stdio smoke: initialize → tools/list → post → 他人の発言 → read_unread
import { spawn } from 'node:child_process'

const child = spawn('node', ['client.mjs'], {
  env: {
    PEERTABLE_URL: 'http://localhost:8790',
    PEERTABLE_ROOM: 'demo',
    PEERTABLE_MEMBER: 'sakura',
    ...process.env, // 環境変数があれば既定より優先
  },
  stdio: ['pipe', 'pipe', 'inherit'],
})

const send = o => child.stdin.write(JSON.stringify(o) + '\n')
const seen = []
let buf = ''
child.stdout.on('data', c => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (line.trim()) seen.push(JSON.parse(line))
  }
})

const wait = (pred, ms = 5000) => new Promise((ok, ng) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    const hit = seen.find(pred)
    if (hit) { clearInterval(iv); ok(hit) }
    else if (Date.now() - t0 > ms) { clearInterval(iv); ng(new Error('timeout: ' + seen.map(s => s.method ?? s.id).join(','))) }
  }, 50)
})

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })
await wait(m => m.id === 1)
send({ jsonrpc: '2.0', method: 'notifications/initialized' })
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
const tools = await wait(m => m.id === 2)
console.log('tools:', tools.result.tools.map(t => t.name).join(', '))

send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'post', arguments: { to: 'bell', message: 'sakura です、join します' } } })
console.log('post:', (await wait(m => m.id === 3)).result.content[0].text)

// 他人（hinata）が発言。Claude 席の起床は notifications/claude/channel。ここでは履歴読取だけ確認する
const BASE = process.env.PEERTABLE_URL ?? 'http://localhost:8790'
const TOKEN_HEADER = process.env.PEERTABLE_POST_TOKEN ? { 'X-Peertable-Token': process.env.PEERTABLE_POST_TOKEN } : {}
await fetch(`${BASE}/api/demo/messages`, { method: 'POST', headers: TOKEN_HEADER, body: JSON.stringify({ from: 'hinata', to: 'sakura', body: 'sakura さん、タスクYお願い' }) })
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_unread', arguments: {} } })
console.log('read_unread:', (await wait(m => m.id === 4)).result.content[0].text)
send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'members', arguments: {} } })
console.log('members:', (await wait(m => m.id === 5)).result.content[0].text.replaceAll('\n', ' / '))

child.kill()
console.log('SMOKE OK')
