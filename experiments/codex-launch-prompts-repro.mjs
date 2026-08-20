#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const launch = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../skill/scripts/launch-seat.sh'),
  'utf8',
)
assert.match(launch, /Hooks need review/)
assert.match(launch, /codex hooks prompt: trust all/)
assert.match(launch, /Update now/)
assert.match(launch, /Yes, continue/)
assert.match(launch, /pane-on-fail\.txt/)
assert.match(launch, /seat-identity\.mjs" "\$pane_pid"\) \|\| seat_ident=""/)
assert.doesNotMatch(launch, /seat-identity\.mjs" "\$pane_pid" 2>\/dev\/null/)

console.log('codex launch prompts: 7/7 green')
