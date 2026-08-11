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
import { spawnSync } from 'node:child_process'
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

await mkdir(join(repo, `evidence/${plan}`), { recursive: true })
await mkdir(bin)
const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
git('init', '-q')
git('config', 'user.email', 'fixture@example.com')
git('config', 'user.name', 'fixture')
await writeFile(join(repo, `evidence/${plan}/x1.md`), '# x1\n')
git('add', '.')
git('commit', '-q', '-m', 'fixture evidence')

// stub lattice: state.json が「この run/task が今どう見えるか」を決める。
// run list → active_runs、run observe → intakes、todo done → 呼ばれたことを log へ書く。
await writeFile(join(bin, 'lattice'), `#!/bin/bash
printf '%s\\n' "$*" >> "$LATTICE_LOG"
mode=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["mode"])' "$STUB_STATE")
case "$1 $2" in
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
if mode=="accepted": intakes=[{"task_id":"x1","accepted_head_sha":"a"*40}]
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
    printf '{"schema":"lattice.run_landing_report.v1","run_id":"r1","landed":true,"accepted_receipts":[]}\\n'
    exit 0 ;;
  "todo done")
    printf '{"schema":"lattice.todo_mutation_result.v2","task_id":"x1","status":"done"}\\n'
    exit 0 ;;
esac
exit 0
`)
await chmod(join(bin, 'lattice'), 0o755)

const setMode = mode => writeFile(state, JSON.stringify({ mode }) + '\n')
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  PEERTABLE_PLAN: plan,
  LATTICE_CLI: join(bin, 'lattice'),
  LATTICE_LOG: latticeLog,
  STUB_STATE: state,
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

  // 3. accept 済みなら通す
  await setMode('accepted')
  await resetLog()
  result = run('x1')
  check('accept 済みなら done を打つ', () => {
    assert.equal(result.status, 0, result.stderr)
  })
  assert.equal((await doneCalls()).length, 1)

  // 4. 実行層に載っていない task（intake が無い）は素通し
  await setMode('other_task')
  await resetLog()
  result = run('x1')
  check('実行層に載っていない task は素通しする', () => {
    assert.equal(result.status, 0, result.stderr)
  })
  assert.equal((await doneCalls()).length, 1)

  // 5. pull run そのものが無い卓も素通し
  await setMode('no_run')
  await resetLog()
  result = run('x1')
  check('pull run が無い卓は素通しする', () => {
    assert.equal(result.status, 0, result.stderr)
  })
  assert.equal((await doneCalls()).length, 1)

  // 6. 状態を読めない時は黙って通さない（fallbackで成功にしない）
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

  // 8. landing-only mode が「未accept」を着地とは別軸で出す
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
  await rm(root, { recursive: true, force: true })
}
