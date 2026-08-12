#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const change = await readFile(resolve(root, 'skill/scripts/change-seat.sh'), 'utf8')
const client = await readFile(resolve(root, 'room/client.mjs'), 'utf8')
const adapter = await readFile(resolve(root, 'skill/scripts/aiterm-configure.mjs'), 'utf8')

assert.match(client, /aiterm_session_id: process\.env\.AITERM_SESSION_ID/)
assert.match(adapter, /name: 'agent_configure'/)
assert.match(adapter, /aiterm\.agent-configure-result\.v1/)
assert.match(change, /SEAT_CHANGE_AITERM_SESSION_MISSING/)
assert.match(change, /configure_args=\("\$aiterm_session_id"\)/)
assert.match(change, /\[ -z "\$opt_model" \] \|\| configure_args\+=\(--model "\$model"\)/)
assert.match(change, /\[ -z "\$opt_effort" \] \|\| configure_args\+=\(--effort "\$effort"\)/)
assert.match(change, /change_method="同一sessionを維持"/)
assert.match(change, /change_method="席を再起動"/)
assert.match(change, /if \[ "\$vendor" = "\$old_vendor" \]; then/)
assert.match(change, /credential_helper" request "\$credential_file" POST \\\n+\s+"\$url\/api\/\$room\/members" "\$identity"/)
assert.doesNotMatch(change, /curl -sf -X POST[^\n]+\/members/)

console.log('live-seat-config c2 boundary: 11/11 green')
