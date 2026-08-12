#!/usr/bin/env node
// 正規 launch-seat.sh で立てた実 Codex / Claude 席を使う k1 E2E。
//
// 各vendorを別project・別roomで順番に実行し、roomへDMを保存した後、
// Codexはwakeup-bridge、Claudeはchannelsの一回wake → 実CLIのturn開始 →
// room clientのread_unread結果にDM本文が現れる、までを実測する。
// fake CLIや手動の本文注入は使わない。
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOM_SERVER = join(REPO, 'room', 'server.mjs')
const ROOM_CLIENT = join(REPO, 'room', 'client.mjs')
const LAUNCH = join(REPO, 'skill', 'scripts', 'launch-seat.sh')
const BRIDGE = join(REPO, 'skill', 'scripts', 'wakeup-bridge.mjs')
const ENSURE = join(REPO, 'skill', 'scripts', 'ensure-bridge.sh')
const TOKEN = 'k1-real-seats-fixture-token'
const actionLoop = process.env.K1_ACTION_LOOP === '1'
const bridgeSource = await readFile(BRIDGE, 'utf8')
const clientSource = await readFile(ROOM_CLIENT, 'utf8')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, why, timeout = 120_000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`${why}: timeout`)
    await sleep(500)
  }
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(2_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}
const run = (file, args, options = {}, timeout = 240_000) => new Promise(resolve => {
  const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    resolve({ code, signal, stdout, stderr })
  })
})
const capturePane = (socket, session) => {
  try {
    return execFileSync('tmux', ['-S', socket, 'capture-pane', '-S', '-1000', '-t', session, '-p'], { encoding: 'utf8' })
  } catch {
    return ''
  }
}
const count = (text, pattern) => text.split(pattern).length - 1

const freePort = async () => {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  probe.close()
  await once(probe, 'close')
  return port
}

const root = await mkdtemp(join(tmpdir(), 'peertable-dm-real-seats-'))
const data = join(root, 'room-data')
const tokenSource = join(root, 'token-source')
const socket = join(root, 'tmux.sock')
await writeFile(tokenSource, `PEERTABLE_POST_TOKEN=${TOKEN}\n`, { mode: 0o600 })

let roomServer = null
let good = true
let roomError = ''
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}

try {
  const port = await freePort()
  roomServer = spawn(process.execPath, [ROOM_SERVER], {
    env: {
      ...process.env,
      PEERTABLE_PORT: String(port),
      PEERTABLE_DATA: data,
      PEERTABLE_POST_TOKEN: TOKEN,
      PEERTABLE_PARENT_NAME: 'bell',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  roomServer.stderr.on('data', chunk => { roomError += chunk.toString('utf8') })
  const serverUrl = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try { return (await fetch(`${serverUrl}/api/probe/members`)).ok } catch { return false }
  }, '実E2E room server', 20_000)

  const cases = [
    { vendor: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
    { vendor: 'claude', model: 'sonnet', effort: 'high' },
  ].filter(item => !process.env.K1_REAL_VENDOR || item.vendor === process.env.K1_REAL_VENDOR)
  for (const item of cases) {
    const seat = `k1-real-${item.vendor}`
    const room = `k1-real-${item.vendor}-${process.pid}`
    const project = join(root, item.vendor, 'project')
    const session = `peer-${seat}`
    const base = `${serverUrl}/api/${room}`
    let bridge = null
    await mkdir(join(project, '.team'), { recursive: true })
    await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({
      room,
      server_url: serverUrl,
      mode: 'standalone',
      plan_key: '',
      added_root_mcp: true,
    }) + '\n')
    // Claude channelsは --mcp-config を見ないため、正規setupと同じproject root定義を置く。
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: { room: { command: process.execPath, args: [ROOM_CLIENT] } },
    }) + '\n')

    const env = {
      ...process.env,
      PEERTABLE_TMUX_SOCKET: socket,
      PEERTABLE_TOKEN_SOURCE_FILE: tokenSource,
    }
    const brief = 'この実機smokeではコード変更をせず、以後room channelsの新着通知を受信したら必ずroomのread_unreadを1回呼び、取得したDM本文のmarkerを返してください。この着任確認だけを行い、すぐに入力待ちへ戻ってください。'
    try {
      const launch = await run(LAUNCH, [project, seat, item.model, item.vendor, item.effort, brief], { env })
      check(`${item.vendor}の正規launch-seat実行`, launch.code === 0, (launch.stderr || launch.stdout).split('\n').slice(-6).join('\n'))
      if (launch.code !== 0) {
        console.error(`${item.vendor} launch stdout:\n${launch.stdout}`)
        console.error(`${item.vendor} launch stderr:\n${launch.stderr}`)
        console.error(`${item.vendor} pane:\n${capturePane(socket, session)}`)
      }
      if (launch.code !== 0) continue

      const seatStatusLogPath = join(project, '.team', 'seat-status-bridge.log')
      await waitFor(async () => {
        try {
          const log = await readFile(seatStatusLogPath, 'utf8')
          return log.includes('HTTP 403') || log.includes(' 席を見て ')
        } catch {
          return false
        }
      }, `${item.vendor} seat-status-bridge write result`, 30_000)
      const seatStatusLog = await readFile(seatStatusLogPath, 'utf8')
      check(`${item.vendor} seat-status-bridgeが403なしで稼働POSTを試行`, !seatStatusLog.includes('HTTP 403'), seatStatusLog.split('\n').slice(-6).join('\n'))

      await waitFor(async () => {
        try {
          const response = await fetch(`${base}/members`)
          const body = await response.json()
          return body.members?.some(member => member.name === seat && member.vendor === item.vendor)
        } catch {
          return false
        }
      }, `${item.vendor}席のroom登録`, 30_000)

      const bridgeLogs = []
      if (item.vendor === 'codex') {
        bridge = spawn(process.execPath, [BRIDGE, project, seat], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        bridge.stdout.on('data', chunk => bridgeLogs.push(chunk.toString('utf8')))
        bridge.stderr.on('data', chunk => bridgeLogs.push(chunk.toString('utf8')))
        await waitFor(async () => {
          if (!bridge || bridge.exitCode !== null) return false
          try {
            const record = JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge.json'), 'utf8'))
            return Boolean(record.ready_at) && bridgeLogs.join('').includes('SSE 接続')
          } catch {
            return false
          }
        }, `${item.vendor} wakeup-bridge ready`, 30_000)
      } else {
        // Claude席は room channels がSSEからturnを起こす。wakeup-bridgeはClaudeを対象外にする。
        await waitFor(() => capturePane(socket, session).split('\n').slice(-16).some(line => line.trim() === '❯'), `${item.vendor}実席の入力待ち`, 60_000)
      }

      const before = capturePane(socket, session)
      const beforeTurns = count(before, 'esc to interrupt')
      const beforeRoomCalls = count(before, 'Called room')
      const beforeNotifications = count(before, '[Peertable DM #')
      const marker = `[k1-real-${item.vendor}-${process.pid}]`
      const actionReply = `[k1-action-loop-reply-${process.pid}]`
      const body = actionLoop && item.vendor === 'codex'
        ? `${marker} このDMをread_unreadで取得した後、本文の依頼を実行してください。room.postを宛先bellへ呼び、本文に ${actionReply} を含めて送信してください。読了だけでturnを終えないこと。コード変更は禁止です。`
        : `${marker} このDMをread_unreadで取得し、本文にこのmarkerを含めて返してください。コード変更は禁止です。`
      if (actionLoop && item.vendor === 'codex') {
        await fetch(`${base}/members`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Peertable-Token': TOKEN },
          body: JSON.stringify({ name: 'bell' }),
        })
      }
      const response = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Peertable-Token': TOKEN },
        body: JSON.stringify({ from: 'bell', to: seat, body }),
      })
      const saved = await response.json()
      check(`${item.vendor} DMがroomへ保存される`, response.ok && saved.seq > 0, JSON.stringify(saved))

      if (item.vendor === 'codex') {
        await waitFor(() => bridgeLogs.join('').includes(`起こした: ${seat} ← 1 件`), `${item.vendor} bridge wake`, 30_000)
        const deliveredBridgeLogs = bridgeLogs.join('')
        if (actionLoop) {
          check(`${item.vendor}起床通知実装が本文実行ループ契約を含む`, bridgeSource.includes('本文に具体的な依頼・行動要求') && bridgeSource.includes('情報通知だけなら追加の外部行動を起こさず'))
          check('room client通知実装も同じ行動契約を含む', clientSource.includes('本文に具体的な依頼・行動要求') && clientSource.includes('情報通知だけなら追加の外部行動を起こさず'))
        }
        check(`${item.vendor} bridgeがDMを一回だけwakeする`, count(deliveredBridgeLogs, `起こした: ${seat} ← 1 件`) === 1, deliveredBridgeLogs.split('\n').filter(line => line.includes('起こした:')).join('\n'))
      } else {
        await waitFor(() => count(capturePane(socket, session), '[Peertable DM #') > beforeNotifications, `${item.vendor} bridge wake`, 30_000)
        check(`${item.vendor} bridgeがDM本文を一回だけ通知する`, count(capturePane(socket, session), '[Peertable DM #') === beforeNotifications + 1)
      }

      await waitFor(() => {
        const screen = capturePane(socket, session)
        return item.vendor === 'codex'
          // Codexの短いturnは画面取得の間に開始・完了し、`esc to interrupt` が
          // 残らないことがある。MCP tool callの増加は実turnの直接観測なので併用する。
          ? count(screen, 'esc to interrupt') > beforeTurns || count(screen, 'Called room') > beforeRoomCalls
          : count(screen, 'Called room') > beforeRoomCalls || count(screen, '⏺') > count(before, '⏺')
      }, `${item.vendor}実席turn開始`, 90_000)
      check(`${item.vendor}実席でDM wake後のturn開始を観測`, true)

      let readResult = ''
      await waitFor(() => {
        readResult = capturePane(socket, session)
        return readResult.includes(marker)
      }, `${item.vendor}実席のread_unread結果`, 120_000)
      check(`${item.vendor}実席のread_unread結果にDM本文が現れる`, readResult.includes(marker), readResult.split('\n').filter(line => line.includes(marker)).slice(-3).join('\n'))

      if (actionLoop && item.vendor === 'codex') {
        await waitFor(async () => {
          const messages = (await (await fetch(`${base}/messages`)).json()).messages ?? []
          return messages.some(message => message.from === seat && message.to === 'bell' && message.body?.includes(actionReply))
        }, `${item.vendor}実席が本文の行動要求をroomへ実行`, 90_000)
        check(`${item.vendor}実席がread_unread後に本文の行動を実行する`, true)

        const infoMarker = `[k1-action-loop-info-${process.pid}]`
        const infoResponse = await fetch(`${base}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Peertable-Token': TOKEN },
          body: JSON.stringify({ from: 'bell', to: seat, body: `${infoMarker} 情報通知のみです。外部投稿や追加行動は不要です。` }),
        })
        check('情報通知DMがroomへ保存される', infoResponse.ok)
        await waitFor(() => capturePane(socket, session).includes(infoMarker), '情報通知のread_unread結果', 90_000)
        await sleep(5_000)
        const afterInfo = (await (await fetch(`${base}/messages`)).json()).messages ?? []
        check('情報通知だけでは外部投稿を増やさない', !afterInfo.some(message => message.from === seat && message.body?.includes(infoMarker)))
      }
    } catch (error) {
      console.error(`${item.vendor} E2E ERROR: ${error.message}`)
      const diagnostic = capturePane(socket, session).split('\n')
        .filter(line => /room|read_unread|Called|marker|error|失敗|未読/u.test(line))
        .slice(-30)
        .join('\n')
      if (diagnostic) console.error(`${item.vendor} pane診断:\n${diagnostic}`)
      good = false
    } finally {
      await stop(bridge)
      try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch {}
      try {
        await fetch(`${base}/members/${encodeURIComponent(seat)}`, {
          method: 'DELETE',
          headers: { 'X-Peertable-Token': TOKEN },
        })
      } catch {}
      await sleep(500)
    }
  }
} catch (error) {
  console.error(`HARNESS ERROR: ${error.message}`)
  good = false
} finally {
  await stop(roomServer)
  if (roomError) console.error(`room stderr: ${roomError.trim().split('\n').slice(-5).join('\n')}`)
  try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch {}
  await rm(root, { recursive: true, force: true })
}

console.log(good ? 'real Codex/Claude DM delivery: green' : 'real Codex/Claude DM delivery: red')
process.exit(good ? 0 : 1)
