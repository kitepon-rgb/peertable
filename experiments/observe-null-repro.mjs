#!/usr/bin/env node
// client が observe:null を送ると記述子が消え、wakeup-bridge が席を飛ばす。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const client = readFileSync(resolve(root, 'room/client.mjs'), 'utf8')
const server = readFileSync(resolve(root, 'room/server.mjs'), 'utf8')

assert.match(client, /v != null/)
assert.match(client, /PEERTABLE_TMUX_SOCKET/)
assert.doesNotMatch(client, /v !== undefined && v !== '' && !\(Array\.isArray\(v\) && v\.length === 0\)\)\)/)
assert.match(server, /meta\.observe == null && known\?\.observe/)

const known = { name: 'nagi', observe: { tmux_target: 'peer-nagi', tmux_socket: 'aiterm' } }
const meta = { status: 'idle', observe: null }
if (meta.observe == null && known.observe) delete meta.observe
const merged = { ...known, ...meta }
assert.equal(merged.observe.tmux_target, 'peer-nagi')
assert.equal(merged.status, 'idle')

console.log('observe-null repro: green')
