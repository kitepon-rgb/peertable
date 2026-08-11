#!/usr/bin/env node
// start.shから呼ばれる小さな正規着手helper。tokenはcredential fileからだけ読む。
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const [command, ...args] = process.argv.slice(2)

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

async function stdinText() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

if (command === 'state') {
  const [file, key] = args
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))[key]
    if (value === undefined || value === null || value === '') process.exit(2)
    process.stdout.write(String(value))
  } catch {
    process.exit(2)
  }
} else if (command === 'lattice-title') {
  try {
    const task = JSON.parse(await stdinText()).task
    if (!task || typeof task.title !== 'string' || !task.title) process.exit(2)
    process.stdout.write(task.title)
  } catch {
    process.exit(2)
  }
} else if (command === 'start-digest') {
  const raw = await stdinText()
  for (const line of raw.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line)
      if (typeof value.event_digest === 'string' && value.event_digest) {
        process.stdout.write(value.event_digest)
        process.exit(0)
      }
    } catch {}
  }
  process.exit(2)
} else if (command === 'standalone-title') {
  const [file, id] = args
  try {
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find((candidate) => {
      const match = /^\s*-\s+([^:]+):\s*(.*)$/.exec(candidate)
      return match && match[1].trim() === id
    })
    if (!line) process.exit(2)
    process.stdout.write(line.replace(/^\s*-\s+/, '').trim())
  } catch {
    process.exit(2)
  }
} else if (command === 'standalone-transition') {
  const url = process.env.TASK_EVENT_URL
  const room = process.env.TASK_EVENT_ROOM
  const actor = process.env.TASK_EVENT_ACTOR
  const task = process.env.TASK_EVENT_TASK
  if (!url || !room || !actor || !task) fail('standalone claimの照会情報が無い')

  let response
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}/api/${encodeURIComponent(room)}/messages`)
  } catch (error) {
    fail(`standalone claimを照会できない: ${error.message}`)
  }
  if (!response.ok) fail(`standalone claimの照会が拒否された: HTTP ${response.status}`)

  let messages
  try {
    const payload = await response.json()
    messages = Array.isArray(payload.messages) ? payload.messages : []
  } catch {
    fail('standalone claimの応答がJSONでない')
  }
  const escapedTask = task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const claimPattern = new RegExp(`^\\s*\\[claim\\]\\s+${escapedTask}(?:\\s|:|：|$)`)
  const claim = messages.filter(message =>
    message?.from === actor
      && typeof message.body === 'string'
      && claimPattern.test(message.body)
      && Number.isInteger(message.seq),
  ).at(-1)
  if (!claim) fail(`standalone claimが見つからない: ${task}`)

  // 同じclaimの再試行は同じID、再着席して新しいclaimを出した時だけ新しいIDになる。
  const digest = createHash('sha256')
    .update(JSON.stringify({ room, actor, task, claim_seq: claim.seq }))
    .digest('hex')
  process.stdout.write(`started:${digest}`)
} else if (command === 'send-event') {
  const url = process.env.TASK_EVENT_URL
  const room = process.env.TASK_EVENT_ROOM
  const actor = process.env.TASK_EVENT_ACTOR
  const plan = process.env.TASK_EVENT_PLAN
  const task = process.env.TASK_EVENT_TASK
  const title = process.env.TASK_EVENT_TITLE
  const transition = process.env.TASK_EVENT_TRANSITION
  const credentialFile = process.env.PEERTABLE_CREDENTIAL_FILE
  let token
  try { token = readFileSync(credentialFile, 'utf8').trim() } catch {
    fail('PEERTABLE_CREDENTIAL_UNREADABLE: credential fileを読めない')
  }
  if (!token) fail('PEERTABLE_CREDENTIAL_INVALID: credential fileが空')

  let response
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}/api/${encodeURIComponent(room)}/task-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': token },
      body: JSON.stringify({
        kind: 'started', actor, plan_key: plan, task_id: task, title, transition_id: transition,
      }),
    })
  } catch (error) {
    fail(`started task eventを送れない: ${error.message}`)
  }

  const raw = await response.text()
  let event
  try { event = JSON.parse(raw) } catch {
    fail(`started task eventの応答がJSONでない: HTTP ${response.status}`)
  }
  if (!response.ok) fail(`started task eventが拒否された: HTTP ${response.status}`)
  if (event.type !== 'task_event' || event.event_kind !== 'started') fail('started task eventの応答型が不正')
  console.log(`${event.idempotent ? 'already sent' : 'sent'} [${event.seq}] ${event.type}:${event.event_kind}`)
} else {
  fail(`未知のhelper command: ${command ?? '(無し)'}`)
}
