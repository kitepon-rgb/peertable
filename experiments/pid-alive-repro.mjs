#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = join(dirname(fileURLToPath(import.meta.url)), '../skill/scripts/pid-alive.mjs')
const live = spawnSync(process.execPath, [helper, String(process.pid)], { encoding: 'utf8' })
assert.equal(live.status, 0, live.stderr)
const dead = spawnSync(process.execPath, [helper, '999999901'], { encoding: 'utf8' })
assert.notEqual(dead.status, 0)
const bad = spawnSync(process.execPath, [helper, 'nope'], { encoding: 'utf8' })
assert.equal(bad.status, 2)

console.log('pid-alive: 3/3 green')
