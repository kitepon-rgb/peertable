#!/usr/bin/env node
// Claude/Codex の Stop hook から呼ぶ、親専用 turn 完了DMの発射器。
// 通常の工程 started/completed 通知とは別経路で、本文と宛先は room に生成させる。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const fail = message => {
  console.error(`ERROR: ${message}`)
  process.exitCode = 1
}

const readStdin = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

const nonempty = value => typeof value === 'string' && value.length > 0

const jsonDigest = value => createHash('sha256')
  .update(JSON.stringify(value), 'utf8')
  .digest('hex')

const readCredential = file => {
  if (!nonempty(file)) throw new Error('PEERTABLE_CREDENTIAL_FILEが無い')
  let token
  try { token = readFileSync(file, 'utf8').trim() } catch {
    throw new Error('PEERTABLE_CREDENTIAL_UNREADABLE: credential fileを読めない')
  }
  if (!token) throw new Error('PEERTABLE_CREDENTIAL_INVALID: credential fileが空')
  return token
}

try {
  const payload = JSON.parse(await readStdin())
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Stop payloadがobjectでない')
  if (payload.hook_event_name !== 'Stop') throw new Error('Stop以外のhookをturn完了にできない')
  if (payload.stop_hook_active === true) process.exit(0)

  const url = process.env.PEERTABLE_URL
  const room = process.env.PEERTABLE_ROOM
  const actor = process.env.PEERTABLE_MEMBER
  const credentialFile = process.env.PEERTABLE_CREDENTIAL_FILE
  if (![url, room, actor].every(nonempty)) throw new Error('PEERTABLE_URL / PEERTABLE_ROOM / PEERTABLE_MEMBER が無い')
  const sessionId = payload.session_id ?? payload.sessionId
  if (!nonempty(sessionId)) throw new Error('Stop payloadにsession_idが無い')

  const transcriptPath = payload.transcript_path ?? payload.transcriptPath ?? null
  let transcriptDigest = null
  if (nonempty(transcriptPath)) {
    try { transcriptDigest = jsonDigest(readFileSync(transcriptPath, 'utf8')) } catch {
      throw new Error('Stop payloadのtranscript_pathを読めない')
    }
  }
  const turnId = payload.turn_id ?? payload.turnId ?? null
  const lastAssistantMessage = typeof payload.last_assistant_message === 'string'
    ? payload.last_assistant_message
    : null
  if (![turnId, transcriptDigest].some(nonempty)) {
    throw new Error('turn_idまたはtranscriptの完了識別子が無い')
  }

  // Codexのturn_idは同じturnのStop再送でも不変なので、これを優先して
  // transcriptの後追いflushによる別DM化を防ぐ。Claude等でturn_idが無い時だけ
  // 完了済みtranscriptの識別子へ落とす。
  const transitionBasis = nonempty(turnId)
    ? { session_id: sessionId, turn_id: turnId }
    : {
        session_id: sessionId,
        transcript_path: transcriptPath,
        transcript_digest: transcriptDigest,
        last_assistant_message: lastAssistantMessage,
      }
  const transitionId = `member-turn:${jsonDigest(transitionBasis)}`
  const token = readCredential(credentialFile)
  let response
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}/api/${encodeURIComponent(room)}/task-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': token },
      body: JSON.stringify({ kind: 'member_turn_completed', actor, transition_id: transitionId }),
    })
  } catch (error) {
    throw new Error(`member_turn_completedを送れない: ${error.message}`)
  }

  const raw = await response.text()
  let event
  try { event = JSON.parse(raw) } catch {
    throw new Error(`member_turn_completedの応答がJSONでない: HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(`member_turn_completedが拒否された: HTTP ${response.status}`)
  if (event.type !== 'member_turn_completed' || event.event_kind !== 'member_turn_completed') {
    throw new Error('member_turn_completedの応答型が不正')
  }
  // Codex Stop hookのstdoutはJSON応答として解釈されるため、診断文字列を混ぜない。
  console.error(`${event.idempotent ? 'already sent' : 'sent'} [${event.seq}] ${event.type}:${event.event_kind}`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
