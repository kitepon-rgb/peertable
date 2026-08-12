#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const launch = await readFile(resolve(root, 'skill/scripts/launch-seat.sh'), 'utf8')

const receiptAt = launch.indexOf('SEAT_AITERM_LAUNCH_RECEIPT_INVALID')
const roomReadyAt = launch.indexOf('SEAT_ROOM_MCP_NOT_READY')
assert.ok(receiptAt >= 0, 'Aiterm launch receiptのtyped failureがない')
assert.ok(roomReadyAt > receiptAt, 'room member登録がlaunch receiptより前に判定される')
assert.match(launch, /Aiterm管理席の process 起動は公開launch receiptで確定している/)
assert.match(launch, /room member登録を観測できない/)
assert.match(launch, /if \[ -n "\$brief" \] && \[ "\$brief_dispatched" != true \]; then/)
assert.doesNotMatch(launch, /OpenAI Codex \(v/)
assert.doesNotMatch(launch, /Channels \(experimental\)/)
assert.doesNotMatch(launch, /1\. Yes, I trust this folder/)
assert.doesNotMatch(launch, /1\. Update now/)

console.log('live-seat-config r2 boundary: 9/9 green')
