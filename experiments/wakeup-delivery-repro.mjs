#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  formatWakeNotice,
  isWakeupBridgeTarget,
  shouldDeferGrokWake,
} from '../skill/scripts/wakeup-delivery.mjs'

assert.equal(
  formatWakeNotice({ seq: 9, from: 'nagi', to: 'all', body: 't1-contract の最終試験を監査へ渡す。\n試験結果: PASS。' }),
  '[Peertable #9] nagi → all: t1-contract の最終試験を監査へ渡す。 / 試験結果: PASS。',
)
assert.equal(
  formatWakeNotice({ seq: 11, from: 'sora', to: 'all', body: '[claim] grok-successor-launch/t2-spawn' }),
  '[Peertable #11] sora → all: [claim] grok-successor-launch/t2-spawn',
)
assert.match(formatWakeNotice({ seq: 2, from: 'nagi', to: 'all', body: '' }), /room.read_log/)
assert.equal(
  formatWakeNotice({ seq: 13, from: 'sora', to: 'nagi', body: '役割逸脱: 作業者は done.sh を打たない' }),
  '[Peertable DM #13] sora → nagi: 役割逸脱: 作業者は done.sh を打たない',
)

assert.equal(isWakeupBridgeTarget({ name: 'nagi', observe: { tmux_target: 'peer-nagi' } }), true)
assert.equal(isWakeupBridgeTarget({ name: 'bell', observe: null }), false)
assert.equal(isWakeupBridgeTarget({ name: 'bell', delivery: { kind: 'parent_watch', host: 'grok' } }), false)
assert.equal(isWakeupBridgeTarget({ name: 'missing' }), false)
assert.equal(isWakeupBridgeTarget({ name: 'bell' }), false)
assert.equal(isWakeupBridgeTarget(undefined), false)

assert.equal(shouldDeferGrokWake('codex', 'Working (1m · esc to interrupt)'), false)
assert.equal(shouldDeferGrokWake('grok', 'Working (1m · esc to interrupt)'), true)
assert.equal(shouldDeferGrokWake('grok', '◎ waiting · send a message to interrupt'), true)
assert.equal(shouldDeferGrokWake('grok', '#1 [Peertable #7] room\nEnter:send now'), true)
assert.equal(shouldDeferGrokWake('grok', 'grok-4.6 high · ~/Developer/Throughline'), false)
assert.equal(shouldDeferGrokWake('grok', 'Enter:send now'), false)

console.log('wakeup delivery: 17/17 green')
