// done.sh の receipt gate 再現ハーネス（f6）。
//
// 罠: 実行層（pull run）に載せた task の成果の正本は Lattice が撮った observed diff
// （accepted receipt）である。しかし done.sh は accept 状態を見ずに `todo done` を打っていたので、
// 2026-08-11 に「accept は RUNTIME_CONFLICT_HOLD で止まっているのに ToDo は done」という状態が生まれ、
// 親の事後照合（run landing = landed:false / accepted_receipts:[]）まで誰にも見えなかった（room [42][45]）。
// landing-only mode も accepted receipt しか数えないので、受理前で止まった intake には無言だった。
//
// 測るのは: 未accept なら done を打たない / accept 済みなら通す / 実行層に載っていない task は素通し /
// 状態を読めない時は黙って通さない / landing-only mode が「未accept」を別軸で出す /
// 引数なし・--help が raw CLI の誤解釈にならない。
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname)
const root = await mkdtemp(join(tmpdir(), 'peertable-done-gate-'))
const repo = join(root, 'repo')
const bin = join(root, 'bin')
const plan = 'fixture-plan'
const latticeLog = join(root, 'lattice.log')
const state = join(root, 'state.json')
const credential = join(root, 'client.token')
const remote = join(root, 'remote.git')

await mkdir(join(repo, `evidence/${plan}`), { recursive: true })
await mkdir(bin)
await writeFile(credential, 'fixture-token\n')
const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
git('init', '-q')
git('config', 'user.email', 'fixture@example.com')
git('config', 'user.name', 'fixture')
await writeFile(join(repo, `evidence/${plan}/x1.md`), '# x1\n\n監査: fixture-audit\n判定: defect-free\n')
git('add', '.')
git('commit', '-q', '-m', 'fixture evidence')
git('branch', '-M', 'main')
assert.equal(spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' }).status, 0)
assert.equal(git('remote', 'add', 'origin', remote).status, 0)
assert.equal(git('push', '-q', '-u', 'origin', 'main').status, 0)

const eventLog = join(root, 'task-events.jsonl')
const eventServerCode = `
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const records = new Map()
const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/reset') {
    if (request.headers['x-peertable-token'] !== 'fixture-token') {
      response.writeHead(401)
      response.end()
      return
    }
    records.clear()
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method !== 'POST' || request.url !== '/api/fixture-room/task-events') {
    response.writeHead(404)
    response.end()
    return
  }
  let raw = ''
  request.on('data', chunk => { raw += chunk.toString() })
  request.on('end', () => {
    if (request.headers['x-peertable-token'] !== 'fixture-token') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'bad token' }))
      return
    }
    const body = JSON.parse(raw)
    const idempotent = records.has(body.transition_id)
    if (!idempotent) records.set(body.transition_id, body)
    appendFileSync(process.env.EVENT_LOG, JSON.stringify({ body, idempotent }) + '\\n')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      type: 'task_event',
      event_kind: body.kind,
      idempotent,
      seq: records.size,
    }))
  })
})
server.listen(0, '127.0.0.1', () => console.log('PORT=' + server.address().port))
`
const eventServer = spawn(process.execPath, ['--input-type=module', '-e', eventServerCode], {
  env: { ...process.env, EVENT_LOG: eventLog },
  stdio: ['ignore', 'pipe', 'inherit'],
})
const eventUrl = await new Promise((resolvePort, rejectPort) => {
  let output = ''
  const timeout = setTimeout(() => rejectPort(new Error('event server start timeout')), 10_000)
  eventServer.stdout.on('data', chunk => {
    output += chunk.toString()
    const match = /PORT=(\d+)/.exec(output)
    if (match) {
      clearTimeout(timeout)
      resolvePort(`http://127.0.0.1:${match[1]}`)
    }
  })
  eventServer.once('error', error => {
    clearTimeout(timeout)
    rejectPort(error)
  })
})

// stub lattice: state.json が「この run/task が今どう見えるか」を決める。
// run list → active_runs、run observe → intakes、todo done → 呼ばれたことを log へ書く。
await writeFile(join(bin, 'lattice'), `#!/bin/bash
printf '%s\\n' "$*" >> "$LATTICE_LOG"
mode=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["mode"])' "$STUB_STATE")
case "$1 $2" in
  "todo show")
    python3 -c '
import json,sys
state=json.load(open(sys.argv[1]))
status=state.get("todo_status", "in-progress")
done_at=state.get("done_at", "") or None
print(json.dumps({"schema":"lattice.todo_detail_result.v2","task":{"task_id":"x1","title":"x1 fixture"},"state":{"task_id":"x1","status":status,"done_at":done_at,"evidence":{}}}))
' "$STUB_STATE"
    exit 0 ;;
  "run list")
    [ "$mode" = "list_broken" ] && { echo "boom" >&2; exit 1; }
    [ "$mode" = "list_invalid" ] && { echo '{"schema":"wrong"}'; exit 0; }
    [ "$mode" = "selection_missing" ] && { printf '{"schema":"lattice.run_list.v1","active_runs":[{"run_id":"r1","run_ref":".lattice/runs/r1","plan_key":"${plan}"}]}\\n'; exit 0; }
    [ "$mode" = "selection_invalid" ] && { printf '{"schema":"lattice.run_list.v1","active_runs":[{"run_id":"r1","run_ref":".lattice/runs/r1","selection":"push","plan_key":"${plan}"}]}\\n'; exit 0; }
    [ "$mode" = "no_run" ] && { echo '{"schema":"lattice.run_list.v1","active_runs":[]}'; exit 0; }
    printf '{"schema":"lattice.run_list.v1","active_runs":[{"run_id":"r1","run_ref":".lattice/runs/r1","selection":"pull","plan_key":"${plan}"}]}\\n'
    exit 0 ;;
  "run observe")
    [ "$mode" = "observe_broken" ] && { echo "boom" >&2; exit 1; }
    [ "$mode" = "observe_invalid" ] && { echo '{"schema":"wrong"}'; exit 0; }
    python3 -c '
import json,sys
mode=json.load(open(sys.argv[1]))["mode"]
intakes=[]
if mode=="pending": intakes=[{"task_id":"x1","accepted_head_sha":None}]
if mode in ("accepted", "landing_unlanded"): intakes=[{"task_id":"x1","accepted_head_sha":"a"*40}]
if mode=="other_task": intakes=[{"task_id":"other","accepted_head_sha":None}]
if mode=="duplicate": intakes=[{"task_id":"x1","accepted_head_sha":None},{"task_id":"x1","accepted_head_sha":"a"*40}]
print(json.dumps({"schema":"lattice.pull_run_observation.v1","intakes":intakes}))
' "$STUB_STATE"
    exit 0 ;;
  "run landing")
    [ "$mode" = "landing_broken" ] && { echo "boom" >&2; exit 1; }
    [ "$mode" = "landing_invalid" ] && { echo '{"schema":"wrong"}'; exit 0; }
    [ "$mode" = "landing_missing" ] && { echo '{"schema":"lattice.run_landing_report.v1","accepted_receipts":[]}'; exit 0; }
    [ "$mode" = "landing_landed_invalid" ] && { echo '{"schema":"lattice.run_landing_report.v1","landed":"yes","accepted_receipts":[]}'; exit 0; }
    [ "$mode" = "landing_unlanded" ] && { printf '{"schema":"lattice.run_landing_report.v1","run_id":"r1","landed":false,"accepted_receipts":[{"task_id":"x1","landed":false}]}\\n'; exit 0; }
    printf '{"schema":"lattice.run_landing_report.v1","run_id":"r1","landed":true,"accepted_receipts":[{"task_id":"x1","landed":true}]}\\n'
    exit 0 ;;
  "todo done")
    python3 -c '
import json,sys
path=sys.argv[1]
state=json.load(open(path))
sequence=state.get("done_seq", 0) + 1
state["done_seq"]=sequence
state["todo_status"]="done"
state["done_at"]=f"done-{sequence}"
json.dump(state, open(path, "w"))
' "$STUB_STATE"
    printf '{"schema":"lattice.todo_mutation_result.v2","task_id":"x1","status":"done"}\\n'
    exit 0 ;;
esac
exit 0
`)
await chmod(join(bin, 'lattice'), 0o755)

const setMode = (mode, extra = {}) => writeFile(state, JSON.stringify({
  mode,
  todo_status: 'in-progress',
  done_at: '',
  done_seq: 0,
  ...extra,
}) + '\n')
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  PEERTABLE_PLAN: plan,
  LATTICE_CLI: join(bin, 'lattice'),
  LATTICE_LOG: latticeLog,
  STUB_STATE: state,
  PEERTABLE_URL: eventUrl,
  PEERTABLE_ROOM: 'fixture-room',
  PEERTABLE_MEMBER: 'fixture-seat',
  PEERTABLE_CREDENTIAL_FILE: credential,
}
// template は配布時に実行権を付けて配られるので、正本そのものは bash で回す
const runWith = (args, extraEnv = {}) => spawnSync('bash', [join(REPO, 'skill/templates/done.sh'), ...args], {
  cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30_000,
})
const run = (...args) => runWith(args)
const calls = async () => {
  if (!existsSync(latticeLog)) return []
  return (await readFile(latticeLog, 'utf8')).trim().split('\n').filter(Boolean)
}
const doneCalls = async () => (await calls()).filter(line => line.startsWith('todo done'))
const resetLog = () => rm(latticeLog, { force: true })
const eventSnapshot = async () => {
  if (!existsSync(eventLog)) return []
  return (await readFile(eventLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
const resetEvents = async () => {
  const response = await fetch(`${eventUrl}/reset`, {
    method: 'POST',
    headers: { 'X-Peertable-Token': 'fixture-token' },
  })
  assert.equal(response.status, 204)
  await rm(eventLog, { force: true })
}
let checks = 0
const check = (label, fn) => { fn(); checks += 1; console.log(`  ok: ${label}`) }

try {
  // 1. 引数なし・--help は usage と正規の完了入口を案内し、lattice を呼ばない
  await resetLog()
  let result = run()
  check('引数なしは usage を表示して raw CLI を呼ばない', () => {
    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage: done\.sh/)
    assert.match(result.stderr, /PEERTABLE_PLAN/)
    assert.match(result.stderr, /evidence<|evidence\//)
  })
  assert.deepEqual(await calls(), [])
  await resetLog()
  result = run('--help')
  check('--help は usage を表示して raw CLI を呼ばない', () => {
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /usage: done\.sh/)
    assert.match(result.stdout, /lattice todo done/)
  })
  assert.deepEqual(await calls(), [])

  // 2. 未accept の intake が在るなら done を打たない
  await setMode('pending')
  await resetLog()
  result = run('x1')
  check('未accept の receipt では done を打たない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /receipt が未acceptのまま done は打てない: x1/)
    assert.match(result.stderr, /run intake accept --run \.lattice\/runs\/r1 --task x1/)
  })
  assert.deepEqual(await doneCalls(), [], '未accept で todo done が呼ばれていない')

  // 3. audit が証跡に無ければ、todo done も completed も打たない
  await writeFile(join(repo, `evidence/${plan}/x1.md`), '# x1\n')
  await setMode('accepted')
  await resetLog()
  await resetEvents()
  result = run('x1')
  check('監査所見の無い証跡では completed を送らない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /defect-free監査所見が証跡に無い/)
  })
  assert.deepEqual(await doneCalls(), [], '監査不足で todo done が呼ばれていない')
  assert.equal((await eventSnapshot()).length, 0)
  await writeFile(join(repo, `evidence/${plan}/x1.md`), '# x1\n\n監査: fixture-audit\n判定: defect-free\n')

  // 4. accept・landing 済みなら completed を一度送る
  await setMode('accepted')
  await resetLog()
  await resetEvents()
  result = run('x1')
  check('accept 済みなら done を打つ', () => {
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  })
  assert.equal((await doneCalls()).length, 1)
  assert.equal((await eventSnapshot()).length, 1)
  const firstEvent = (await eventSnapshot())[0].body
  assert.equal(firstEvent.kind, 'completed')
  assert.equal(firstEvent.plan_key, plan)
  assert.equal(firstEvent.task_id, 'x1')

  // 5. 同じ done の再試行は todo done を重ねず、同じtransitionを冪等送信する
  await resetLog()
  result = run('x1')
  check('同じ done の再試行は completed を重複生成しない', () => {
    assert.equal(result.status, 0, result.stderr)
  })
  assert.deepEqual(await doneCalls(), [], '既存doneの再試行で todo done を再実行していない')
  const retryEvents = await eventSnapshot()
  assert.equal(retryEvents.length, 2)
  assert.equal(new Set(retryEvents.map(event => event.body.transition_id)).size, 1)
  assert.equal(retryEvents[0].body.transition_id, retryEvents[1].body.transition_id)

  // 6. f6 の task receipt が未着地なら completed を送らない。
  await setMode('landing_unlanded')
  await resetLog()
  result = run('x1')
  check('f6 task receipt 未着地では completed を送らない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /task receipt がcanonical landing済みでない/)
  })
  assert.equal((await eventSnapshot()).length, 2)

  // 7. canonical landing 前は done 後でも completed を送らない。push 後の再試行で同じdoneを送る。
  assert.equal(git('commit', '--allow-empty', '-q', '-m', 'unlanded fixture').status, 0)
  await setMode('accepted', { done_seq: 1 })
  await resetLog()
  result = run('x1')
  check('canonical landing 前は completed を送らない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /canonical landing 不足/)
  })
  assert.equal((await doneCalls()).length, 1)
  assert.equal((await eventSnapshot()).length, 2)
  assert.equal(git('push', '-q').status, 0)
  await resetLog()
  result = run('x1')
  check('push 後の再試行で同じdoneの completed を送る', () => {
    assert.equal(result.status, 0, result.stderr)
  })
  assert.equal((await eventSnapshot()).length, 3)

  // 8. reopen 後の新しい done は新しい transition を一度送る
  await setMode('accepted', { done_seq: 2 })
  await resetLog()
  result = run('x1')
  check('reopen後の新完了は別transitionで送る', () => {
    assert.equal(result.status, 0, result.stderr)
  })
  const transitions = (await eventSnapshot()).map(event => event.body.transition_id)
  assert.equal(transitions.length, 4)
  assert.equal(new Set(transitions).size, 3)
  assert.equal(transitions[0], transitions[1])
  assert.notEqual(transitions[1], transitions[2])
  assert.notEqual(transitions[2], transitions[3])

  // 9. 実行層に載っていない task（intake が無い）は素通し
  await setMode('other_task')
  await resetLog()
  result = run('x1')
  check('実行層に載っていない task は素通しする', () => {
    assert.equal(result.status, 0, result.stderr)
  })
  assert.equal((await doneCalls()).length, 1)

  // 10. pull run そのものが無い卓も素通し
  await setMode('no_run')
  await resetLog()
  result = run('x1')
  check('pull run が無い卓は素通しする', () => {
    assert.equal(result.status, 0, result.stderr)
  })
  assert.equal((await doneCalls()).length, 1)

  // 11. 状態を読めない時は黙って通さない（fallbackで成功にしない）
  for (const [mode, label] of [
    ['list_broken', 'run list'],
    ['list_invalid', 'run list のJSON不正'],
    ['selection_missing', '対象runのselection欠落'],
    ['selection_invalid', '対象runのselection不正'],
    ['observe_broken', 'run observe'],
    ['observe_invalid', 'run observe のJSON不正'],
    ['duplicate', 'run observeのintake重複'],
  ]) {
    await setMode(mode)
    await resetLog()
    result = run('x1')
    check(`${label} を読めない時は done を打たずに落ちる`, () => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /receipt の状態を読めない/)
    })
    assert.deepEqual(await doneCalls(), [], `${label} 失敗時に todo done が呼ばれていない`)
  }

  // 7. landing-only mode の読取失敗は全て非0で落とす
  for (const [mode, label] of [
    ['landing_broken', 'run landing の失敗'],
    ['landing_invalid', 'run landing のJSON不正'],
    ['landing_missing', 'run landingのlanded欠落'],
    ['landing_landed_invalid', 'run landingのlanded不正'],
    ['observe_broken', 'run observe の失敗'],
    ['observe_invalid', 'run observe のJSON不正'],
    ['duplicate', 'run observeのintake重複'],
  ]) {
    await setMode(mode)
    await resetLog()
    result = run('--landing-run', '.lattice/runs/r1')
    check(`landing-only ${label} は成功へ倒さず落ちる`, () => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /状態を読めない|未accept本数を読めない/)
    })
  }
  await resetLog()
  result = runWith(['--landing-run', '.lattice/runs/r1'], {
    LATTICE_CLI: join(root, 'missing-lattice'),
  })
  check('landing-only のCLI不在は成功へ倒さず落ちる', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /着地状態を読めない/)
  })

  // 9. landing-only mode が「未accept」を着地とは別軸で出す
  await setMode('pending')
  await resetLog()
  result = run('--landing-run', '.lattice/runs/r1')
  check('landing-only mode が未accept を別軸で報告する', () => {
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /未accept: run \.lattice\/runs\/r1 に受理されていない intake が在る（x1）/)
  })
  await setMode('accepted')
  await resetLog()
  result = run('--landing-run', '.lattice/runs/r1')
  check('全て accept 済みなら未accept は報告しない', () => {
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /未accept/)
  })

  console.log(`done-receipt-gate repro: ${checks}/${checks} green`)
} finally {
  if (!eventServer.killed) {
    eventServer.kill('SIGTERM')
    await new Promise(resolveClose => eventServer.once('close', resolveClose))
  }
  await rm(root, { recursive: true, force: true })
}
