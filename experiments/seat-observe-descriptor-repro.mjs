#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveSeatObservation } from '../skill/scripts/seat-usage.mjs'

assert.deepEqual(
  resolveSeatObservation({ name: 'codex', observe: { tmux_socket: '/tmp/aiterm.sock', tmux_target: 'seat-codex' } }, '/tmp/default.sock'),
  { socket: '/tmp/aiterm.sock', target: 'seat-codex', source: 'descriptor' },
)
assert.deepEqual(resolveSeatObservation({ name: 'codex' }, '/tmp/default.sock'), {
  socket: '/tmp/default.sock', target: 'peer-codex', source: 'legacy',
})
assert.deepEqual(
  resolveSeatObservation({ name: 'codex', observe: { tmux_socket: '', tmux_target: 'seat-codex' } }, '/tmp/default.sock'),
  { socket: '/tmp/default.sock', target: 'seat-codex', source: 'descriptor' },
)
assert.equal(resolveSeatObservation({ name: 'codex', observe: { tmux_target: 'seat-codex' } }, null), null)

console.log('seat observe descriptor repro: 4/4 green')
