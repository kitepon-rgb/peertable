#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  capacityProjection,
  createCapacityTracker,
  readLatticeCapacityStatus,
  seatIntakeDecision,
  standaloneTodoStatus,
} from '../skill/scripts/capacity-advisor.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

const task = (plan_key, task_id) => ({ plan_key, task_id })
const member = (name, status) => ({ name, status })
const status = ({ active = [], ready = [], coverage = 'verified', groups = [ready] }) => ({
  active_set: active.map(id => task('plan', id)),
  next_ready: ready.map(id => task('plan', id)),
  parallel_candidates: [{
    plan_key: 'plan',
    coverage,
    unjudged_task_ids: coverage === 'verified' ? [] : ready,
    verified_parallel_groups: groups.map(task_ids => ({ task_ids })),
    serialize_pairs: [],
  }],
})

const checks = []
const check = (label, fn) => {
  try {
    fn()
    checks.push(true)
    console.log(`ok: ${label}`)
  } catch (error) {
    checks.push(false)
    console.error(`NG: ${label}: ${error.message}`)
  }
}

const workers3 = [member('bell', null), member('a', 'busy'), member('b', 'busy'), member('c', 'busy')]
const overloaded = capacityProjection({
  todoStatus: status({ active: ['a1', 'a2', 'a3'], ready: ['r1', 'r2', 'r3', 'r4'] }),
  members: workers3,
})
check('3 busy＋検証済みready 4はowner催促なしの4席増員eventになる', () => {
  assert.equal(overloaded.state.target, 7)
  assert.equal(overloaded.state.worker_count, 3)
  assert.equal(overloaded.event?.code, 'PEERTABLE_CAPACITY_CHANGED')
  assert.equal(overloaded.event?.launch_count, 4)
  assert.equal(overloaded.event?.action, 'scale_up')
})

check('親bellは目標worker席数へ数えない', () => {
  assert.equal(overloaded.state.worker_count, 3)
})

const repeated = capacityProjection({
  todoStatus: status({ active: ['a1', 'a2', 'a3'], ready: ['r1', 'r2', 'r3', 'r4'] }),
  members: workers3,
  previous: overloaded.state,
})
check('同じcapacity差の反復pollは重複通知しない', () => assert.equal(repeated.event, null))

const transitioned = capacityProjection({
  todoStatus: status({ active: ['a1', 'a2', 'a3', 'r1'], ready: ['r2', 'r3', 'r4'] }),
  members: workers3,
  previous: overloaded.state,
})
check('readyからactiveへの単純遷移で合計不変なら通知しない', () => assert.equal(transitioned.event, null))

const unverified = capacityProjection({
  todoStatus: status({ active: ['a1', 'a2', 'a3'], ready: ['r1', 'r2', 'r3', 'r4'], coverage: 'missing' }),
  members: workers3,
})
check('independence未検査readyは競合なし席数へ含めない', () => {
  assert.equal(unverified.state.verified_ready_count, 0)
  assert.equal(unverified.state.target, 3)
  assert.equal(unverified.event, null)
  assert.deepEqual(unverified.state.excluded_ready.map(entry => entry.reason), Array(4).fill('missing'))
})

const verifiedSingle = capacityProjection({
  todoStatus: {
    active_set: [],
    next_ready: [task('single', 'r1')],
    parallel_candidates: [],
    independence_projections: [{
      plan_key: 'single', coverage: 'verified',
      frontier: { unknown: [], parallel_groups: [], serialize_pairs: [], conflicts_with_active: [] },
    }],
  },
  members: [member('bell', null)],
})
check('status候補欄から省略される検証済みready 1件もindependence projectionから数える', () => {
  assert.equal(verifiedSingle.state.verified_ready_count, 1)
  assert.equal(verifiedSingle.event?.launch_count, 1)
})

const serializedReady = capacityProjection({
  todoStatus: {
    ...status({ ready: ['r1', 'r2'], groups: [] }),
    parallel_candidates: [{
      plan_key: 'plan', coverage: 'verified', unjudged_task_ids: [], verified_parallel_groups: [],
      serialize_pairs: [{ task_ids: ['r1', 'r2'] }],
    }],
  },
  members: [member('bell', null)],
})
check('直列化されたready 2件は同時2席でなく現在着手可能な1席だけ数える', () => {
  assert.equal(serializedReady.state.verified_ready_count, 1)
})

const idleReclaim = capacityProjection({
  todoStatus: status({ ready: ['r1', 'r2', 'r3', 'r4'] }),
  members: [member('bell', null), member('idle-a', 'idle'), member('idle-b', 'idle')],
})
check('2 idle＋ready 4は既存席の再claimと2席増員を同時に起動する', () => {
  assert.equal(idleReclaim.event?.action, 'scale_up_and_reclaim')
  assert.deepEqual(idleReclaim.event?.reclaim_workers, ['idle-a', 'idle-b'])
  assert.equal(idleReclaim.event?.launch_count, 2)
})

const changedReclaimSeat = capacityProjection({
  todoStatus: status({ ready: ['r1', 'r2', 'r3'] }),
  members: [member('bell', null), member('idle-a', 'busy'), member('busy-a', 'idle')],
  previous: capacityProjection({
    todoStatus: status({ ready: ['r1', 'r2', 'r3'] }),
    members: [member('bell', null), member('idle-a', 'idle'), member('busy-a', 'busy')],
  }).state,
})
check('同じ件数でもreclaim対象席が変われば新しい席へ再通知する', () => {
  assert.deepEqual(changedReclaimSeat.event?.reclaim_workers, ['busy-a'])
})

const ownerlessActive = capacityProjection({
  todoStatus: status({ active: ['a1', 'a2', 'a3'] }),
  members: [member('bell', null), member('busy-a', 'busy'), member('idle-a', 'idle')],
})
check('owner不在activeが残る時もidle席を自律claimへ戻す', () => {
  assert.equal(ownerlessActive.event?.action, 'scale_up_and_reclaim')
  assert.deepEqual(ownerlessActive.event?.reclaim_workers, ['idle-a'])
  assert.equal(ownerlessActive.event?.launch_count, 1)
})

const shrink = capacityProjection({
  todoStatus: status({ active: ['a1'] }),
  members: [member('bell', null), member('busy', 'busy'), member('idle-a', 'idle'), member('idle-b', 'idle'), member('dead', 'dead')],
})
check('縮退はdeadを数えずidleだけをWIP確認待ち候補にする', () => {
  assert.equal(shrink.event?.action, 'scale_down')
  assert.equal(shrink.event?.retire_count, 2)
  assert.deepEqual(shrink.event?.retire_candidates, ['idle-a', 'idle-b'])
})

const changedRetireSeat = capacityProjection({
  todoStatus: status({ active: ['a1'] }),
  members: [member('bell', null), member('idle-a', 'busy'), member('busy', 'idle')],
  previous: capacityProjection({
    todoStatus: status({ active: ['a1'] }),
    members: [member('bell', null), member('idle-a', 'idle'), member('busy', 'busy')],
  }).state,
})
check('同じ件数でも縮退候補席が変われば親へ再通知する', () => {
  assert.deepEqual(changedRetireSeat.event?.retire_candidates, ['busy'])
})

const blockedShrink = capacityProjection({
  todoStatus: status({ active: ['a1'] }),
  members: [member('bell', null), member('busy-a', 'busy'), member('busy-b', 'blocked')],
})
check('余剰がbusy/blocked席だけなら縮退を強行しない', () => {
  assert.equal(blockedShrink.event?.action, 'shrink_blocked')
  assert.deepEqual(blockedShrink.event?.retire_candidates, [])
})

check('wait/holdの新規intakeはWIPなしなら即退席する', () => {
  assert.deepEqual(seatIntakeDecision({ intervention: 'hold', hasWip: false }), {
    action: 'leave_immediately', code: 'PEERTABLE_CAPACITY_INTAKE_RELEASED',
  })
})

check('既存WIPがある待機席はhandoffを先に要求する', () => {
  assert.equal(seatIntakeDecision({ intervention: 'wait', hasWip: true }).action, 'handoff_then_leave')
})

check('配布roleは競合hold席を待機温存せず即退席させる', () => {
  const role = readFileSync(join(repo, 'skill/templates/member.md'), 'utf8')
  assert.match(role, /未受理intakeを解放して`leave-seat\.sh`で直ちに退席/u)
  assert.match(role, /競合解除pollのために席を温存しない/u)
})

check('親roleはtyped capacity通知からlaunchと安全な縮退へ進む', () => {
  const role = readFileSync(join(repo, 'skill/templates/parent.md'), 'utf8')
  assert.match(role, /\[capacity\] PEERTABLE_CAPACITY_CHANGED/u)
  assert.match(role, /不足数だけ`launch-seat\.sh`/u)
  assert.match(role, /本人に WIP と未報告の作業が/u)
})

check('配布SKILLは親登録・配送ready後のcapacity常駐とteardown停止を正規入口にする', () => {
  const skill = readFileSync(join(repo, 'skill/SKILL.md'), 'utf8')
  assert.match(skill, /parent-join\.sh が親登録・DM配送経路ready後に自動で起こす/u)
  assert.match(skill, /CAPACITY_BRIDGE_DELIVERY_NOT_READY/u)
  assert.match(skill, /ensure-bridge\.sh <project> capacity/u)
  assert.match(skill, /capacity-bridge\.mjs <project> --stop/u)
})

const standalone = standaloneTodoStatus('- 調査\n- 実装\n- 監査\n', [
  { body: '[claim] 調査' },
  { body: '[完了] 監査' },
])
const standaloneProjection = capacityProjection({
  todoStatus: standalone,
  members: [member('bell', null), member('worker', 'busy')],
})
check('単独卓はtasks.md議題とroom claim/完了から同じcapacity語彙へ投影する', () => {
  assert.equal(standaloneProjection.state.active_count, 1)
  assert.equal(standaloneProjection.state.verified_ready_count, 1)
  assert.equal(standaloneProjection.state.target, 2)
})

const trackerRoot = await mkdtemp(join(tmpdir(), 'peertable-elastic-capacity-'))
await mkdir(join(trackerRoot, '.team'))
try {
  const posts = []
  const trackerArgs = {
    project: trackerRoot,
    readTodoStatus: async () => status({ active: ['a1'], ready: ['r1', 'r2'] }),
    readMembers: async () => [member('bell', null), member('idle', 'idle')],
    post: async message => { posts.push(message) },
  }
  const tracker = createCapacityTracker(trackerArgs)
  await tracker.tick()
  await tracker.tick()
  await createCapacityTracker(trackerArgs).tick()
  check('capacity eventは親＋reclaim席へ一通だけ送り、反復pollと再起動で重複しない', () => {
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].to, ['bell', 'idle'])
    assert.match(posts[0].body, /^\[capacity\] PEERTABLE_CAPACITY_CHANGED/u)
    assert.equal(JSON.parse(readFileSync(tracker.statePath, 'utf8')).capacity.target, 3)
  })

  const failingRoot = await mkdtemp(join(tmpdir(), 'peertable-elastic-capacity-fail-'))
  await mkdir(join(failingRoot, '.team'))
  try {
    let attempts = 0
    const failing = createCapacityTracker({
      ...trackerArgs,
      project: failingRoot,
      post: async () => { attempts++; if (attempts === 1) throw new Error('fixture post failure') },
    })
    await assert.rejects(failing.tick(), /fixture post failure/u)
    assert.equal(existsSync(failing.statePath), false)
    await failing.tick()
    check('通知POST失敗ではstateを進めず次tickで再試行する', () => {
      assert.equal(attempts, 2)
      assert.equal(existsSync(failing.statePath), true)
    })
  } finally {
    await rm(failingRoot, { recursive: true, force: true })
  }
} finally {
  await rm(trackerRoot, { recursive: true, force: true })
}

const latticeCalls = []
const latticeStatus = await readLatticeCapacityStatus('/fixture/project', {
  latticeCli: '/fixture/lattice',
  run: async (command, args, options) => {
    latticeCalls.push({ command, args, options })
    if (args[1] === 'status') {
      return { stdout: JSON.stringify({
        active_set: [],
        next_ready: [task('one', 't1'), task('two', 't2')],
        parallel_candidates: [],
      }) }
    }
    return { stdout: JSON.stringify({
      plan_key: args[3], coverage: 'verified',
      frontier: { unknown: [], parallel_groups: [], serialize_pairs: [], conflicts_with_active: [] },
    }) }
  },
})
check('runtime readerはready planごとにtodo independence projectionを必ず読む', () => {
  assert.equal(latticeCalls.length, 3)
  assert.deepEqual(latticeCalls.map(call => call.args.slice(0, 2)), [
    ['todo', 'status'], ['todo', 'independence'], ['todo', 'independence'],
  ])
  assert.equal(latticeStatus.independence_projections.length, 2)
  assert.ok(latticeCalls.every(call => call.options.cwd === '/fixture/project'))
})

console.log(`elastic capacity repro: ${checks.filter(Boolean).length}/${checks.length} green`)
process.exit(checks.every(Boolean) ? 0 : 1)
