#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { capacityProjection } from '../skill/scripts/capacity-advisor.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const launch = await readFile(resolve(root, 'skill/scripts/launch-seat.sh'), 'utf8')
const client = await readFile(resolve(root, 'room/client.mjs'), 'utf8')

assert.match(launch, /role="\$\{7:-worker\}"/)
assert.match(launch, /PEERTABLE_ROLE=\$role/)
assert.match(launch, /if \[ "\$vendor" = codex \]; then[\s\S]*ensure-bridge\.sh" "\$proj" wakeup/)
assert.match(launch, /SEAT_WAKEUP_BRIDGE_NOT_READY/)
assert.match(client, /role: process\.env\.PEERTABLE_ROLE/)
assert.match(await readFile(resolve(root, 'skill/templates/member.md'), 'utf8'), /初回着任時の既定PLAN/)
assert.match(await readFile(resolve(root, 'skill/templates/member.md'), 'utf8'), /完全修飾 `<plan_key>\/<task_id>`/)

const projection = capacityProjection({
  todoStatus: { active_set: [{ plan_key: 'p', task_id: 'a' }], next_ready: [] },
  members: [
    { name: 'worker', status: 'idle', role: 'worker' },
    { name: 'rei', status: 'idle', role: 'auditor' },
  ],
})
assert.equal(projection.state.worker_count, 1)
assert.deepEqual(projection.state.idle_workers, ['worker'])

console.log('live-seat-config m2 boundary: 9/9 green')
