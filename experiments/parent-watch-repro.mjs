#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const watcher = join(repo, 'skill/scripts/parent-watch.mjs')
const roomServer = join(repo, 'room/server.mjs')
const root = await mkdtemp(join(tmpdir(), 'peertable-parent-watch-'))
const project = join(root, 'project')
const data = join(root, 'data')
const room = 'parent-watch-fixture'
const parent = 'bell'
const roomUpdateBody = 'room全体の状況が更新された。roomログを読み、状況を把握して次の行動を判断する。'
let server = null
let green = true
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) green = false
}
const freePort = async () => {
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  socket.close()
  await once(socket, 'close')
  return port
}
const start = (extraArgs, env = {}) => {
  const child = spawn(process.execPath, [watcher, project, parent, ...extraArgs], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return { child, result: new Promise(resolve => child.once('close', status => resolve({ status, stdout, stderr }))) }
}
const run = (extraArgs, env = {}) => start(extraArgs, env).result

try {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const api = `${base}/api/${room}`
  await mkdir(join(project, '.team'), { recursive: true })
  await mkdir(join(project, '.lattice', 'todo'), { recursive: true })
  const bin = join(root, 'bin')
  const latticeStatus = join(project, '.lattice', 'todo', 'manifest.json')
  await mkdir(bin)
  const latticeCli = join(bin, 'lattice')
  await writeFile(latticeCli, `#!/bin/sh\ncat ${JSON.stringify(latticeStatus)}\n`, { mode: 0o755 })
  await writeFile(latticeStatus, `${JSON.stringify({ next_ready: [{}], active_set: [{}, {}] })}\n`)
  await writeFile(join(project, '.team/setup-state.json'), `${JSON.stringify({ room, server_url: base, lattice_cli: latticeCli })}\n`)
  const serverEnv = { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data }
  delete serverEnv.PEERTABLE_POST_TOKEN
  server = spawn(process.execPath, [roomServer], {
    env: serverEnv, stdio: 'ignore',
  })
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${api}/summary`)).ok) break } catch {}
    await sleep(50)
  }

  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'system', to: parent, body: 'prime以前の履歴' }),
  })
  const primed = await run(['--prime'])
  const stateAfterPrime = JSON.parse(await readFile(join(project, '.team/parent-watch.json'), 'utf8'))
  check('primeは親を起こさず現在headへカーソルを置く', primed.status === 0 && primed.stdout === '' && stateAfterPrime.last_seq === 1,
    `${primed.stderr} ${JSON.stringify(stateAfterPrime)}`)
  check('primeはLattice工程数を無通知の基準値として保存する',
    stateAfterPrime.lattice.ready === 1 && stateAfterPrime.lattice.active === 2, JSON.stringify(stateAfterPrime.lattice))

  const live = run(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '3000' })
  await sleep(150)
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'hinata', to: 'nagi', body: '親以外' }),
  })
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: parent, to: parent, body: '親自身' }),
  })
  const liveBody = 'いま届くべきDM'
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'asahi', to: [parent, 'nagi'], body: liveBody }),
  })
  const liveResult = await live
  const liveEvents = liveResult.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  check('単独宛と複数宛を同じ構造化eventで親へ返す', liveResult.status === 0
    && liveEvents.length === 1
    && liveEvents[0].type === 'parent_dm'
    && liveEvents[0].from === 'asahi'
    && liveEvents[0].body === liveBody
    && liveEvents[0].to_names.includes(parent), liveResult.stdout || liveResult.stderr)
  check('親以外と親自身の発言では起こさない', !liveResult.stdout.includes('親以外') && !liveResult.stdout.includes('親自身'))

  const allBody = 'ALL本文はroomだけに残す'
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'hinata', to: 'all', body: allBody }),
  })
  const allResult = await run(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '1000' })
  const allEvent = JSON.parse(allResult.stdout.trim())
  check('allは本文でなくroom再読eventとして親へ返す', allResult.status === 0
    && allEvent.type === 'parent_room_update'
    && allEvent.body === roomUpdateBody
    && allEvent.to === 'all', allResult.stdout || allResult.stderr)
  check('all本文を親への直接出力へ混ぜない', !allResult.stdout.includes(allBody), allResult.stdout)

  const missedBody = 'watcher不在中のDM'
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'nagi', to: parent, body: missedBody }),
  })
  const caught = await run(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '1000' })
  const caughtEvent = JSON.parse(caught.stdout.trim())
  check('watcher不在中のDMも永続cursorからcatch-upする', caught.status === 0
    && caughtEvent.body === missedBody && caughtEvent.from === 'nagi', caught.stdout || caught.stderr)

  const duplicate = await run(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '250' })
  check('再起動しても配達済みDMを重複させない', duplicate.status === 0 && duplicate.stdout === '', duplicate.stdout || duplicate.stderr)

  const roomSeqBeforeLattice = (await (await fetch(`${api}/summary`)).json()).seq
  await writeFile(latticeStatus, `${JSON.stringify({ next_ready: [{}, {}], active_set: [{}] })}\n`)
  const latticeBreakdownChanged = await run(['--poll'])
  check('ready/activeの内訳が入れ替わってもX＋Yが同値なら通知しない',
    latticeBreakdownChanged.status === 0 && latticeBreakdownChanged.stdout === '',
    latticeBreakdownChanged.stdout || latticeBreakdownChanged.stderr)

  await writeFile(latticeStatus, `${JSON.stringify({ next_ready: [{}, {}], active_set: [{}, {}] })}\n`)
  const latticeTotalChanged = await run(['--poll'])
  const latticeTotalEvent = JSON.parse(latticeTotalChanged.stdout.trim())
  check('X＋Yが変化した時だけ親向けeventを一件返す', latticeTotalChanged.status === 0
    && latticeTotalEvent.type === 'parent_lattice_update'
    && latticeTotalEvent.ready === 2
    && latticeTotalEvent.active === 2
    && latticeTotalEvent.standard_worker_count === 4
    && latticeTotalEvent.body === '現在、着手可能工程は 2 件、着手中工程は 2 件になりました。標準は 4＋監査担当数です。円卓メンバー数を検討してください。',
  latticeTotalChanged.stdout || latticeTotalChanged.stderr)
  const latticeDuplicate = await run(['--poll'])
  check('同じLattice状態のpollでは反復通知しない',
    latticeDuplicate.status === 0 && latticeDuplicate.stdout === '', latticeDuplicate.stdout || latticeDuplicate.stderr)

  await writeFile(latticeStatus, `${JSON.stringify({ next_ready: [{}, {}], active_set: [{}, {}, {}] })}\n`)
  const latticeActiveChanged = await run(['--poll'])
  const latticeActiveEvent = JSON.parse(latticeActiveChanged.stdout.trim())
  check('着手中工程数の変化もX＋Yだけを親へ知らせる', latticeActiveChanged.status === 0
    && latticeActiveEvent.ready === 2
    && latticeActiveEvent.active === 3
    && latticeActiveEvent.standard_worker_count === 5
    && latticeActiveEvent.body === '現在、着手可能工程は 2 件、着手中工程は 3 件になりました。標準は 5＋監査担当数です。円卓メンバー数を検討してください。',
  latticeActiveChanged.stdout || latticeActiveChanged.stderr)
  const roomSeqAfterLattice = (await (await fetch(`${api}/summary`)).json()).seq
  check('工程通知はroomや円卓メンバーへ書き込まない', roomSeqAfterLattice === roomSeqBeforeLattice,
    `${roomSeqBeforeLattice} -> ${roomSeqAfterLattice}`)

  await writeFile(latticeStatus, '{invalid\n')
  const duringFailureBody = 'Lattice観測失敗中も届くDM'
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'nagi', to: parent, body: duringFailureBody }),
  })
  const latticeFailure = await run(['--poll'])
  const latticeFailureEvents = latticeFailure.stdout.trim().split('\n').map(line => JSON.parse(line))
  check('Lattice観測失敗はtyped eventで一度知らせroom DM追従を継続する', latticeFailure.status === 0
    && latticeFailureEvents.length === 2
    && latticeFailureEvents[0].type === 'parent_lattice_error'
    && latticeFailureEvents[0].code === 'LATTICE_TODO_STATUS_FAILED'
    && latticeFailureEvents[1].type === 'parent_dm'
    && latticeFailureEvents[1].body === duringFailureBody,
  latticeFailure.stdout || latticeFailure.stderr)
  const repeatedFailure = await run(['--poll'])
  check('同じLattice観測失敗を反復通知しない',
    repeatedFailure.status === 0 && repeatedFailure.stdout === '', repeatedFailure.stdout || repeatedFailure.stderr)
  await writeFile(latticeStatus, `${JSON.stringify({ next_ready: [{}, {}], active_set: [{}, {}, {}] })}\n`)
  const recovered = await run(['--poll'])
  check('復旧時にX/Yが同値なら人数検討通知を水増ししない',
    recovered.status === 0 && recovered.stdout === '', recovered.stdout || recovered.stderr)

  for (const [from, body] of [['hinata', '常駐一件目'], ['asahi', '常駐二件目']]) {
    await fetch(`${api}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: parent, body }),
    })
  }
  const polled = await run(['--poll'])
  const polledEvents = polled.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  check('pollは未達DMをまとめて返して即終了する',
    polled.status === 0
    && polledEvents.length === 2
    && polledEvents[0].body === '常駐一件目'
    && polledEvents[1].body === '常駐二件目',
    polled.stdout || polled.stderr)
  check('poll終了後にNode processとlockを常駐させない', !existsSync(join(project, '.team/parent-watch.lock')))

  await rm(join(project, '.team/parent-watch.json'))
  await writeFile(latticeStatus, '{invalid\n')
  const failedPrime = await run(['--prime'])
  const failedAfterPrime = await run(['--poll'])
  check('prime時のLattice観測失敗はprimeを黙らせたまま次回に一度通知する',
    failedPrime.status === 0 && failedPrime.stdout === ''
    && JSON.parse(failedAfterPrime.stdout).type === 'parent_lattice_error',
  failedPrime.stderr || failedAfterPrime.stdout || failedAfterPrime.stderr)
  await writeFile(latticeStatus, `${JSON.stringify({ next_ready: [{}, {}], active_set: [{}, {}, {}] })}\n`)
  await run(['--poll'])

  const held = start(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '1000' })
  await sleep(80)
  const competing = await run(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '200' })
  check('同じ親の番犬を二世代同時に起動しない', competing.status === 1
    && competing.stderr.includes('PARENT_WATCH_ALREADY_RUNNING'), competing.stderr)
  held.child.kill('SIGTERM')
  await held.result
} catch (error) {
  console.error(`HARNESS ERROR: ${error.stack}`)
  green = false
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
    await Promise.race([once(server, 'exit'), sleep(1000)])
    if (server.exitCode === null) server.kill('SIGKILL')
  }
  await rm(root, { recursive: true, force: true })
}

console.log(green ? 'parent watch: green' : 'parent watch: red')
process.exit(green ? 0 : 1)
