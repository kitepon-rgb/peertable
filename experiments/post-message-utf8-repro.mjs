#!/usr/bin/env node
// Windows python3 の stdout は cp932 になり、日本語 JSON が room で壊れる。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const poster = resolve(root, 'skill/scripts/post-message.mjs')
const body = 'すずね再着席。監査はすずね。'
const utf8 = Buffer.from(JSON.stringify({ from: 'bell', to: 'all', body }), 'utf8')

const node = spawnSync(process.execPath, [poster, 'bell', 'all', body], { encoding: 'buffer' })
assert.equal(node.status, 0, node.stderr.toString('utf8'))
assert.ok(node.stdout.includes(Buffer.from('すずね', 'utf8')), 'node が UTF-8 で出さない')
assert.deepEqual(JSON.parse(node.stdout.toString('utf8')), { from: 'bell', to: 'all', body })

const py = spawnSync('python3', ['-c', 'import json,sys; print(json.dumps({"from":sys.argv[1],"to":sys.argv[2],"body":sys.argv[3]},ensure_ascii=False))', 'bell', 'all', body], { encoding: 'buffer' })
if (py.status === 0 && py.stdout.length > 0 && !py.stdout.includes(Buffer.from('すずね', 'utf8'))) {
  assert.ok(true, 'python3 stdout は UTF-8 ではない（cp932 経路）')
}

const change = readFileSync(resolve(root, 'skill/scripts/change-seat.sh'), 'utf8')
assert.match(change, /post-message\.mjs/)
assert.doesNotMatch(change, /json\.dumps\(\{"from":sys\.argv\[1\],"to":sys\.argv\[2\],"body":sys\.argv\[3\]\}/)

console.log('post-message utf8 repro: green')
