#!/usr/bin/env node
// 実装が全部閉じて pending が親手番1件だけになると ready 1・active 0。
// 合計は直前の active 1 と同じ1なので、合計比較だと親が起きない。
import { strict as assert } from 'node:assert'
import { latticeStaffingChanged, addressedToParent } from '../skill/scripts/parent-watch-logic.mjs'

assert.equal(latticeStaffingChanged({ ready: 0, active: 1 }, { ready: 1, active: 0 }), true)
assert.equal(latticeStaffingChanged({ ready: 1, active: 0 }, { ready: 1, active: 0 }), false)
assert.equal(latticeStaffingChanged({ ready: 2, active: 1 }, { ready: 1, active: 1 }), true)
assert.equal(addressedToParent({ from: 'nagi', to: 'bell' }, 'bell'), true)
assert.equal(addressedToParent({ from: 'bell', to: 'nagi' }, 'bell'), false)
assert.equal(addressedToParent({ from: 'nagi', to: 'all' }, 'bell'), true)

console.log('parent-watch-staffing-repro: ok')
