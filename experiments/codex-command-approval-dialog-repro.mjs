#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blocksCodexReady, keysForCodexPane } from '../skill/scripts/codex-dialog.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wakeup = readFileSync(join(root, 'skill/scripts/wakeup-bridge.mjs'), 'utf8')
const launch = readFileSync(join(root, 'skill/scripts/launch-seat.sh'), 'utf8')

const pane = `  Would you like to run the following command?

  Environment: local

  $ python3 web-server/test_server.py

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`python3 web-
     server/test_server.py\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`

const action = keysForCodexPane(pane)
assert.equal(action?.kind, 'command-approval')
assert.deepEqual(action.keys, ['Down', 'Enter'])
assert.equal(blocksCodexReady(pane), true)
assert.equal(keysForCodexPane('Ask Codex to do anything')?.kind, undefined)

const mcp = `Allow the room MCP server to run tool "members"?
  › 1. Allow
    2. Allow for this session
    3. Always allow
`
assert.equal(keysForCodexPane(mcp)?.kind, 'mcp-allow')

assert.match(wakeup, /if \(dialog\) \{/)
assert.doesNotMatch(wakeup, /dialog\?\.kind === 'mcp-allow'/)
assert.match(launch, /Would you like to run the following command\?/)
assert.match(launch, /codex command approval: don't ask again/)

console.log('codex command approval dialog: green')
