#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blocksCodexReady, keysForCodexPane } from '../skill/scripts/codex-dialog.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helper = join(root, 'skill/scripts/codex-dialog.mjs')
const launch = readFileSync(join(root, 'skill/scripts/launch-seat.sh'), 'utf8')
const wakeup = readFileSync(join(root, 'skill/scripts/wakeup-bridge.mjs'), 'utf8')
const mcpEnsure = readFileSync(join(root, 'skill/scripts/ensure-codex-room-mcp.mjs'), 'utf8')

const pane = `Allow the room MCP server to run tool "members"?
  › 1. Allow                   Run the tool and continue.
    2. Allow for this session  Run the tool and remember this choice for this
                               session.
    3. Always allow            Run the tool and remember this choice for
                               future tool calls.
    4. Cancel                  Cancel this tool call
  enter to submit | esc to cancel
`

const action = keysForCodexPane(pane)
assert.equal(action?.kind, 'mcp-allow')
assert.deepEqual(action.keys, ['Down', 'Down', 'Enter'])
assert.equal(blocksCodexReady(pane), true)
assert.equal(blocksCodexReady('Ask Codex to do anything\n›'), false)

let readyOk = 0
try {
  execFileSync(process.execPath, [helper, '--ready-ok'], { input: pane, encoding: 'utf8' })
} catch (error) {
  readyOk = error.status
}
assert.equal(readyOk, 2, 'MCP Allow 中は ready-ok を拒否する')

const keysOut = execFileSync(process.execPath, [helper], { input: pane, encoding: 'utf8' })
assert.match(keysOut, /"kind":"mcp-allow"/)
assert.match(keysOut, /"Down"/)

assert.match(launch, /codex-dialog\.mjs/)
assert.match(launch, /blocksCodexReady|mcp-allow|Allow the room MCP server to run tool/)
assert.match(wakeup, /codex-dialog/)
assert.match(mcpEnsure, /approval_policy = "never"/)

console.log('codex mcp allow dialog: green')
