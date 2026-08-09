#!/usr/bin/env node
import assert from 'node:assert/strict'

import { parsePaneTokenHint } from '../skill/scripts/seat-usage.mjs'

assert.equal(parsePaneTokenHint('✶ Cogitating… (7m 13s · ↓ 27.8k tokens)'), 27_800)
assert.equal(parsePaneTokenHint('Calling tools…（↓28.7k tokens）'), 28_700)
assert.equal(parsePaneTokenHint('Working (1m · ↑ 1.2M tokens · esc to interrupt)'), 1_200_000)
assert.equal(parsePaneTokenHint('old ↓ 4k tokens\ncurrent ↓ 5.5k tokens'), 5_500)
assert.equal(parsePaneTokenHint('gpt-5.6-sol high · context 81% left'), null)
assert.equal(parsePaneTokenHint('tokens: unknown'), null)
assert.equal(parsePaneTokenHint(null), null)

console.log('seat usage repro: 7/7 green')
