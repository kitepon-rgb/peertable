#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  capacityProjection,
  seatIntakeDecision,
  standaloneTodoStatus,
} from '../skill/scripts/capacity-advisor.mjs'

const task = (plan_key, task_id) => ({ plan_key, task_id })
const member = (name, status) => ({ name, status })
const status = ({ active = [], ready = [], coverage = 'complete', groups = [ready] }) => ({
  active_set: active.map(id => task('plan', id)),
  next_ready: ready.map(id => task('plan', id)),
  parallel_candidates: [{
    plan_key: 'plan',
    coverage,
    unjudged_task_ids: coverage === 'complete' ? [] : ready,
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

const idleReclaim = capacityProjection({
  todoStatus: status({ ready: ['r1', 'r2', 'r3', 'r4'] }),
  members: [member('bell', null), member('idle-a', 'idle'), member('idle-b', 'idle')],
})
check('2 idle＋ready 4は既存席の再claimと2席増員を同時に起動する', () => {
  assert.equal(idleReclaim.event?.action, 'scale_up_and_reclaim')
  assert.deepEqual(idleReclaim.event?.reclaim_workers, ['idle-a', 'idle-b'])
  assert.equal(idleReclaim.event?.launch_count, 2)
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

console.log(`elastic capacity repro: ${checks.filter(Boolean).length}/${checks.length} green`)
process.exit(checks.every(Boolean) ? 0 : 1)
