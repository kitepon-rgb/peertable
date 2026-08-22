#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repairSplicedBegin } from '../skill/scripts/codex-seat-toml.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ensureSrc = readFileSync(join(root, 'skill/scripts/ensure-codex-room-mcp.mjs'), 'utf8')
assert.match(ensureSrc, /# BEGIN PEERTABLE ROOM MCP added_newline=\$\{/)
assert.match(ensureSrc, /repairSplicedBegin/)
assert.match(ensureSrc, /codex-seat-toml\.mjs/)
assert.doesNotMatch(
  ensureSrc,
  /replace\('# BEGIN PEERTABLE ROOM MCP'/,
)

const broken = `# BEGIN PEERTABLE ROOM MCP
approval_policy = "never"
sandbox_mode = "danger-full-access" added_newline=0
[mcp_servers.room]
command = "node"
# END PEERTABLE ROOM MCP
`
const fixed = repairSplicedBegin(broken)
assert.match(fixed, /^# BEGIN PEERTABLE ROOM MCP added_newline=0$/m)
assert.match(fixed, /^sandbox_mode = "danger-full-access"$/m)
assert.doesNotMatch(fixed, /danger-full-access" added_newline/)
assert.doesNotMatch(fixed, /^# BEGIN PEERTABLE ROOM MCP$/m)

console.log('codex seat toml splice: green')
