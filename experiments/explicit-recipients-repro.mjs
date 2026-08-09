#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const TOKEN = 'explicit-recipients-repro-token'
const ROOM = 'explicit-recipients-repro'
const root = mkdtempSync(join(tmpdir(), 'peertable-explicit-recipients-'))
const roomDir = join(root, ROOM)
mkdirSync(roomDir, { recursive: true })

// 旧broadcast行は改変せず読めることを先に固定する。
const legacy = { seq: 1, ts: new Date(0).toISOString(), from: 'legacy', to: 'all', body: 'legacy broadcast' }
writeFileSync(join(roomDir, 'log.jsonl'), `${JSON.stringify(legacy)}\n`)

const probe = createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
probe.close()
await once(probe, 'close')

const child = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: root, PEERTABLE_POST_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', chunk => { output += chunk })
child.stderr.on('data', chunk => { output += chunk })

const base = `http://127.0.0.1:${port}/api/${ROOM}`
const headers = { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (label, condition, detail = '') => {
  checks.push({ label, condition, detail })
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${base}/messages`)
      if (response.ok) return
    } catch {}
    await sleep(50)
  }
  throw new Error(`room server did not start: ${output}`)
}

const post = body => fetch(`${base}/messages`, { method: 'POST', headers, body: JSON.stringify(body) })

try {
  await waitReady()

  for (const [label, audience] of [
    ['to all', { to: 'all' }],
    ['to all with explicit names', { to: 'all', to_names: ['alice'] }],
    ['to_names all', { to_names: ['alice', 'all'] }],
    ['missing recipient', {}],
  ]) {
    const response = await post({ from: 'sender', body: label, ...audience })
    const error = await response.json()
    check(`${label}をtyped拒否`, response.status === 400
      && error.schema === 'peertable.error.v1'
      && error.code === 'EXPLICIT_RECIPIENT_REQUIRED', JSON.stringify(error))
    check(`${label}のerrorにmember一覧を含めない`, !('members' in error) && !('member_names' in error))
  }

  const directResponse = await post({ from: 'sender', to: 'alice', body: 'direct' })
  const direct = await directResponse.json()
  check('単独DMを保存', directResponse.ok && direct.to === 'alice' && !('to_names' in direct))

  const multiResponse = await post({ from: 'sender', to: ['alice', 'bob', 'alice'], body: 'multi' })
  const multi = await multiResponse.json()
  check('複数人宛をto_namesだけで保存', multiResponse.ok
    && !('to' in multi) && JSON.stringify(multi.to_names) === JSON.stringify(['alice', 'bob']), JSON.stringify(multi))

  const memberResponse = await fetch(`${base}/members`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'carol' }),
  })
  check('member登録が成功', memberResponse.ok)

  const { messages } = await (await fetch(`${base}/messages`)).json()
  check('旧broadcastログを無変更で読める', JSON.stringify(messages[0]) === JSON.stringify(legacy))
  const joined = messages.find(message => message.from === 'system' && message.body === 'carol が参加した')
  check('system参加発言も本人への明示宛先', joined?.to === 'carol' && !('to_names' in joined), JSON.stringify(joined))
  check('新規broadcast行が無い', messages.slice(1).every(message => message.to !== 'all'))

  const persisted = readFileSync(join(roomDir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  check('正本fileも同じ宛先形', persisted.slice(1).every(message => message.to !== 'all'))

  const clientSource = readFileSync(join(REPO, 'room/client.mjs'), 'utf8')
  const wakeupSource = readFileSync(join(REPO, 'skill/scripts/wakeup-bridge.mjs'), 'utf8')
  const runBridgeSource = readFileSync(join(REPO, 'skill/scripts/run-bridge.mjs'), 'utf8')
  const parentJoinSource = readFileSync(join(REPO, 'skill/scripts/parent-join.sh'), 'utf8')
  const teardownSource = readFileSync(join(REPO, 'skill/scripts/teardown.sh'), 'utf8')
  check('client新着filterにlegacy all分岐が無い', !clientSource.includes("m.to === 'all'"))
  check('wakeup-bridgeにlegacy all分岐が無い', !wakeupSource.includes("msg.to !== 'all'"))
  check('run-bridgeがbroadcast投稿しない', !runBridgeSource.includes("post('all'"))
  check('parent-joinがkickoff/broadcastを持たない', !parentJoinSource.includes("'to': 'all'")
    && !parentJoinSource.includes('kickoff='))
  check('teardownの区切りも明示宛先', !teardownSource.includes("'to':'all'"))
} finally {
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
}

process.exit(checks.every(check => check.condition) ? 0 : 1)
