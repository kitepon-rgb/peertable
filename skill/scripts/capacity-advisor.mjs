import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

const ref = task => `${task.plan_key}/${task.task_id}`

const groupTaskIds = group => {
  if (Array.isArray(group)) return group
  if (Array.isArray(group?.task_ids)) return group.task_ids
  if (Array.isArray(group?.tasks)) return group.tasks
  return []
}

const pairTaskIds = pair => {
  if (Array.isArray(pair)) return pair
  if (Array.isArray(pair?.task_ids)) return pair.task_ids
  return [pair?.left_task_id, pair?.right_task_id].filter(Boolean)
}

export function verifiedReadyTasks(todoStatus) {
  const readyByPlan = new Map()
  for (const task of todoStatus?.next_ready ?? []) {
    const tasks = readyByPlan.get(task.plan_key) ?? []
    tasks.push(task)
    readyByPlan.set(task.plan_key, tasks)
  }

  const projected = (todoStatus?.independence_projections ?? []).map(projection => ({
    plan_key: projection.plan_key,
    coverage: projection.coverage,
    unjudged_task_ids: (projection.frontier?.unknown ?? []).map(item => item.task_id),
    verified_parallel_groups: projection.frontier?.parallel_groups ?? [],
    serialize_pairs: projection.frontier?.serialize_pairs ?? [],
    conflicts_with_active: projection.frontier?.conflicts_with_active ?? [],
  }))
  const candidates = new Map([...(todoStatus?.parallel_candidates ?? []), ...projected]
    .map(candidate => [candidate.plan_key, candidate]))
  const verifiedPlanGroups = []
  const excluded = []

  for (const [planKey, tasks] of readyByPlan) {
    const candidate = candidates.get(planKey)
    if (candidate?.coverage !== 'verified') {
      excluded.push(...tasks.map(task => ({ task, reason: candidate?.coverage ?? 'missing' })))
      continue
    }
    const unjudged = new Set(candidate.unjudged_task_ids ?? [])
    const activeConflicts = new Set((candidate.conflicts_with_active ?? []).flatMap(pairTaskIds))
    const eligible = tasks.filter(task => !unjudged.has(task.task_id) && !activeConflicts.has(task.task_id))
    const groups = (candidate.verified_parallel_groups ?? [])
      .map(groupTaskIds)
      .map(ids => eligible.filter(task => ids.includes(task.task_id)))
      .filter(group => group.length > 0)
      .sort((a, b) => b.length - a.length)

    if (groups.length > 0) {
      verifiedPlanGroups.push(groups[0])
      const selected = new Set(groups[0].map(task => task.task_id))
      excluded.push(...eligible.filter(task => !selected.has(task.task_id))
        .map(task => ({ task, reason: 'serialized_frontier' })))
      continue
    }

    if (eligible.length > 0) {
      verifiedPlanGroups.push([eligible[0]])
      excluded.push(...eligible.slice(1).map(task => ({ task, reason: 'serialized_frontier' })))
    }
  }

  // independence は plan 単位の証拠であり、別planのready同士が非競合だとは証明しない。
  // automation側で未検証のcross-plan並列を作らず、最大の検証済み群だけを同時着手可能とする。
  verifiedPlanGroups.sort((left, right) => right.length - left.length
    || left.map(ref).join(',').localeCompare(right.map(ref).join(',')))
  const accepted = verifiedPlanGroups[0] ?? []
  for (const group of verifiedPlanGroups.slice(1)) {
    excluded.push(...group.map(task => ({ task, reason: 'cross_plan_unverified' })))
  }

  return {
    accepted,
    accepted_refs: accepted.map(ref),
    excluded: excluded.map(({ task, reason }) => ({ ref: ref(task), reason })),
  }
}

const liveWorker = (member, parentName) => member?.name && member.name !== parentName
  && member.status !== 'dead'

const sameNames = (left = [], right = []) => left.length === right.length
  && left.every((name, index) => name === right[index])

function actionFor(state) {
  if (state.launch_count > 0 && state.reclaim_count > 0) return 'scale_up_and_reclaim'
  if (state.launch_count > 0) return 'scale_up'
  if (state.reclaim_count > 0) return 'reclaim_idle'
  if (state.retire_count > 0 && state.retire_candidates.length > 0) return 'scale_down'
  if (state.retire_count > 0) return 'shrink_blocked'
  return 'balanced'
}

function nextOperation(state) {
  if (state.action === 'scale_up_and_reclaim') {
    return `idle ${state.reclaim_count}席へ自律claimを促し、launch-seat.shで${state.launch_count}席起こす`
  }
  if (state.action === 'scale_up') return `launch-seat.shで${state.launch_count}席起こす`
  if (state.action === 'reclaim_idle') return `idle ${state.reclaim_count}席へ正本照合と自律claimを促す`
  if (state.action === 'scale_down') {
    return `idle候補の本人と工程正本でWIPなしを確認後、leave-seat.shで最大${state.retire_candidates.length}席畳む`
  }
  if (state.action === 'shrink_blocked') return 'busy/blocked席を畳まず、WIP解消後の再観測を待つ'
  return '操作不要'
}

export function capacityProjection({ todoStatus, members, parentName = 'bell', previous = null }) {
  const active = [...new Map((todoStatus?.active_set ?? []).map(task => [ref(task), task])).values()]
  const ready = verifiedReadyTasks(todoStatus)
  const workers = (members ?? []).filter(member => liveWorker(member, parentName))
  const idle = workers.filter(member => member.status === 'idle').map(member => member.name).sort()
  const engagedCount = workers.length - idle.length
  const target = active.length + ready.accepted.length
  const delta = target - workers.length
  const launchCount = Math.max(0, delta)
  const retireCount = Math.max(0, -delta)
  const reclaimCount = Math.min(idle.length, Math.max(0, target - engagedCount))
  const reclaimWorkers = idle.slice(0, reclaimCount)
  const state = {
    target,
    delta,
    active_count: active.length,
    verified_ready_count: ready.accepted.length,
    worker_count: workers.length,
    engaged_worker_count: engagedCount,
    idle_workers: idle,
    reclaim_count: reclaimCount,
    reclaim_workers: reclaimWorkers,
    launch_count: launchCount,
    retire_count: retireCount,
    retire_candidates: idle.slice(0, retireCount),
    active_refs: active.map(ref),
    verified_ready_refs: ready.accepted_refs,
    excluded_ready: ready.excluded,
  }

  // idle席へDMを送ると、そのturn中だけstatusがbusyになり、終了後またidleへ戻る。
  // 現在のidle集合だけを前回値にすると、この往復を新しいcapacity差分と誤認して
  // 同じreclaim・launchを8秒ごとに再発火する。frontierが同じ間は通知済み席を
  // 累積し、launchも絶対targetごとに一度だけ要求する。
  const sameFrontier = previous !== null
    && sameNames(previous.active_refs, state.active_refs)
    && sameNames(previous.verified_ready_refs, state.verified_ready_refs)
  const notifiedReclaim = sameFrontier
    ? (previous.reclaim_notified ?? previous.reclaim_workers ?? [])
    : []
  const newReclaimWorkers = reclaimWorkers.filter(name => !notifiedReclaim.includes(name))
  state.reclaim_notified = [...new Set([...notifiedReclaim, ...reclaimWorkers])].sort()

  const launchAlreadyNotified = launchCount > 0
    && previous?.launch_notified_target === target
  const launchTriggered = launchCount > 0 && !launchAlreadyNotified
  state.launch_notified_target = launchCount > 0 ? target : null
  state.action = actionFor(state)
  state.next_operation = nextOperation(state)

  const targetChanged = previous !== null && previous.target !== target
  const retireChanged = previous === null
    ? retireCount > 0
    : previous.retire_count !== retireCount
      || !sameNames(previous.retire_candidates, state.retire_candidates)
  const changed = launchTriggered || newReclaimWorkers.length > 0 || retireChanged || targetChanged
  const oldTarget = previous?.target ?? workers.length
  const oldDelta = previous?.delta ?? 0
  const eventState = {
    ...state,
    reclaim_count: newReclaimWorkers.length,
    reclaim_workers: newReclaimWorkers,
    launch_count: launchTriggered ? launchCount : 0,
  }
  eventState.action = actionFor(eventState)
  eventState.next_operation = nextOperation(eventState)
  const event = changed ? {
    code: 'PEERTABLE_CAPACITY_CHANGED',
    old_target: oldTarget,
    target,
    old_delta: oldDelta,
    delta,
    active_count: state.active_count,
    verified_ready_count: state.verified_ready_count,
    worker_count: state.worker_count,
    reclaim_workers: newReclaimWorkers,
    launch_count: eventState.launch_count,
    retire_count: retireCount,
    retire_candidates: state.retire_candidates,
    action: eventState.action,
    next_operation: eventState.next_operation,
  } : null
  return { state, event }
}

export function standaloneTodoStatus(tasksMarkdown, messages = []) {
  const topics = tasksMarkdown.split('\n')
    .map(line => /^\s*-\s+(.+?)\s*$/u.exec(line)?.[1])
    .filter(Boolean)
  const claims = new Set()
  const done = new Set()
  for (const message of messages) {
    const body = message?.body ?? ''
    const claim = /^\[claim\]\s+(.+)$/u.exec(body)?.[1]
    const completed = /^\[(?:done|完了)\]\s+(.+)$/u.exec(body)?.[1]
    if (claim) claims.add(claim)
    if (completed) done.add(completed)
  }
  const active = topics.filter(topic => claims.has(topic) && !done.has(topic))
  const ready = topics.filter(topic => !claims.has(topic) && !done.has(topic))
  return {
    active_set: active.map(task_id => ({ plan_key: 'standalone', task_id })),
    next_ready: ready.map(task_id => ({ plan_key: 'standalone', task_id })),
    parallel_candidates: [{
      plan_key: 'standalone',
      coverage: 'verified',
      unjudged_task_ids: [],
      verified_parallel_groups: [{ task_ids: ready }],
      serialize_pairs: [],
    }],
  }
}

export function seatIntakeDecision({ intervention, hasWip }) {
  const waiting = ['wait', 'hold', 'conflict'].includes(intervention)
  if (!waiting) return { action: 'continue', code: null }
  if (hasWip) return { action: 'handoff_then_leave', code: 'PEERTABLE_CAPACITY_WIP_HANDOFF_REQUIRED' }
  return { action: 'leave_immediately', code: 'PEERTABLE_CAPACITY_INTAKE_RELEASED' }
}

export function capacityMessage(event) {
  const signed = event.delta > 0 ? `+${event.delta}` : String(event.delta)
  return '[capacity] PEERTABLE_CAPACITY_CHANGED '
    + `target ${event.old_target}→${event.target}; active=${event.active_count}; `
    + `verified_ready=${event.verified_ready_count}; workers=${event.worker_count}; delta=${signed}; `
    + `reclaim=${event.reclaim_workers.length}; launch=${event.launch_count}; retire=${event.retire_count}; `
    + `action=${event.action}; next=${event.next_operation}`
}

export function capacityRecipients(event, parentName = 'bell') {
  return [...new Set([parentName, ...event.reclaim_workers])]
}

export function createCapacityTracker({ project, readTodoStatus, readMembers, post, parentName = 'bell' }) {
  const statePath = join(project, '.team', 'capacity-advisor.json')
  const readPrevious = () => {
    if (!existsSync(statePath)) return null
    return JSON.parse(readFileSync(statePath, 'utf8')).capacity
  }
  const persist = capacity => {
    const temporary = `${statePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({
      schema: 'peertable.capacity-advisor-state.v1',
      capacity,
      observed_at: new Date().toISOString(),
    })}\n`, { mode: 0o600 })
    renameSync(temporary, statePath)
  }

  return {
    statePath,
    async tick() {
      const [todoStatus, members] = await Promise.all([readTodoStatus(), readMembers()])
      const projection = capacityProjection({
        todoStatus,
        members,
        parentName,
        previous: readPrevious(),
      })
      if (projection.event !== null) {
        await post({
          from: 'capacity',
          to: capacityRecipients(projection.event, parentName),
          body: capacityMessage(projection.event),
        })
      }
      persist(projection.state)
      return projection
    },
  }
}
export async function readLatticeCapacityStatus(project, { latticeCli = 'lattice', run = runFile } = {}) {
  const { stdout } = await run(latticeCli, ['todo', 'status', '--json'], { cwd: project })
  const status = JSON.parse(stdout)
  const planKeys = [...new Set((status.next_ready ?? []).map(task => task.plan_key))]
  const independenceProjections = []
  for (const planKey of planKeys) {
    const result = await run(latticeCli,
      ['todo', 'independence', '--plan', planKey, '--json'], { cwd: project })
    independenceProjections.push(JSON.parse(result.stdout))
  }
  return { ...status, independence_projections: independenceProjections }
}
