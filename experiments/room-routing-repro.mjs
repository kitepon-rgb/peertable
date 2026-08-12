#!/usr/bin/env node
// roomの宛先はall・個人・複数人の通常postだけであることを測る。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const token = 'room-routing-fixture-token'
const room = 'room-routing-repro'
const data = mkdtempSync(join(tmpdir(), 'peertable-room-routing-'))
mkdirSync(join(data, room), { recursive: true })

const probe = createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
probe.close()
await once(probe, 'close')

const server = spawn(process.execPath, [join(repo, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data, PEERTABLE_POST_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
server.stdout.on('data', chunk => { output += chunk })
server.stderr.on('data', chunk => { output += chunk })

const base = `http://127.0.0.1:${port}/api/${room}`
const headers = { 'Content-Type': 'application/json', 'X-Peertable-Token': token }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/messages`)).ok) break
  } catch {}
  if (i === 99) throw new Error(`room server did not start: ${output}`)
  await wait(25)
}

const post = async (from, to, body) => {
  const response = await fetch(`${base}/messages`, {
    method: 'POST', headers, body: JSON.stringify({ from, to, body }),
  })
  return { response, data: await response.json() }
}

try {
  const claim = await post('alice', 'all', '[claim] x1')
  if (!claim.response.ok || claim.data.to !== 'all') throw new Error('claimのall投稿が失敗')

  const self = await post('alice', 'alice', '[次の行動] 実装を続ける')
  if (!self.response.ok || self.data.to !== 'alice') throw new Error('自己DMが失敗')

  const done = await post('alice', 'all', '[done] x1 実装と確認を完了')
  if (!done.response.ok || done.data.to !== 'all') throw new Error('完了のall投稿が失敗')

  const dm = await post('alice', 'bob', '確認してください')
  if (!dm.response.ok || dm.data.to !== 'bob') throw new Error('個人DMが失敗')

  const multi = await post('alice', ['bob', 'carol'], '二人への用事')
  if (!multi.response.ok || JSON.stringify(multi.data.to_names) !== JSON.stringify(['bob', 'carol'])) {
    throw new Error('複数人宛が失敗')
  }

  const retired = await fetch(`${base}/task-events`, {
    method: 'POST', headers, body: JSON.stringify({ kind: 'started' }),
  })
  if (retired.status !== 404) throw new Error(`task-eventsが残っている: HTTP ${retired.status}`)

  const messageCount = readFileSync(join(data, room, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).length
  if (messageCount !== 5) throw new Error(`通常post以外の行数が混ざった: ${messageCount}`)

  console.log('room-routing repro: green')
} finally {
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit'), wait(1000)])
  if (server.exitCode === null) server.kill('SIGKILL')
  rmSync(data, { recursive: true, force: true })
}
