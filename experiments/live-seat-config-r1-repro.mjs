#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const launch = await readFile(resolve(root, 'skill/scripts/launch-seat.sh'), 'utf8')
const adapter = await readFile(resolve(root, 'skill/scripts/aiterm-launch.mjs'), 'utf8')

assert.match(adapter, /new StdioClientTransport\(\{ command: 'aiterm-mcp', env: process\.env \}\)/)
assert.match(adapter, /name: `\$\{vendor\}_agent`/)
assert.match(adapter, /schema !== 'aiterm\.agent-launch-result\.v1'/)
assert.match(adapter, /receipt\.session_id !== session_name/)
assert.doesNotMatch(adapter, /submit_residue !== false/)
assert.match(launch, /aiterm_launch_helper=.*aiterm-launch\.mjs/)
assert.match(launch, /node "\$aiterm_launch_helper" "\$sess" "\$vendor" "\$model" "\$effort" "\$proj" "\$brief"/)
assert.match(launch, /SEAT_AITERM_LAUNCH_FAILED/)
assert.ok(launch.indexOf('seat_created=true', launch.indexOf('SEAT_CODEX_ROOM_MCP_INVALID'))
  < launch.indexOf('launch_receipt=$(env -u PEERTABLE_POST_TOKEN'),
'Aiterm launcher失敗時も作成済みsessionをrollback対象として先に所有する')
assert.match(launch, /'aiterm_session_id': aiterm_session_id/)
assert.match(launch, /'role': role/)
assert.doesNotMatch(launch, /cmd="(?:claude|codex) /)

console.log('live-seat-config r1 boundary: 12/12 green')
