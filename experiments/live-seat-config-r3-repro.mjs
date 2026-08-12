#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const helper = resolve(root, 'skill/scripts/ensure-codex-room-mcp.mjs')
const run = (action, project, repo = root) => execFileSync(
  process.execPath, [helper, action, project, repo], { encoding: 'utf8' },
)

const fixture = mkdtempSync(join(tmpdir(), 'peertable-r3-'))
try {
  execFileSync('git', ['init', '-q', fixture])
  mkdirSync(join(fixture, '.codex'))
  const original = 'model = "fixture"'
  writeFileSync(join(fixture, '.codex/config.toml'), original)

  run('ensure', fixture)
  const configured = readFileSync(join(fixture, '.codex/config.toml'), 'utf8')
  assert.ok(configured.startsWith(`${original}\n# BEGIN PEERTABLE ROOM MCP added_newline=1`))
  assert.match(configured, /^\[mcp_servers\.room\]$/mu)
  assert.match(configured, /room\/client\.mjs/)
  assert.match(configured, /"PEERTABLE_MEMBER"/)
  assert.match(configured, /"TMUX_PANE"/)
  const exclude = readFileSync(join(fixture, '.git/info/exclude'), 'utf8')
  assert.match(exclude, /# peertable:codex-room-mcp\n\/\.codex\/config\.toml/)

  run('remove', fixture)
  assert.equal(readFileSync(join(fixture, '.codex/config.toml'), 'utf8'), original)
  assert.doesNotMatch(readFileSync(join(fixture, '.git/info/exclude'), 'utf8'), /peertable:codex-room-mcp/)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

const setup = readFileSync(resolve(root, 'skill/scripts/setup.sh'), 'utf8')
const launch = readFileSync(resolve(root, 'skill/scripts/launch-seat.sh'), 'utf8')
const teardown = readFileSync(resolve(root, 'skill/scripts/teardown.sh'), 'utf8')
assert.match(setup, /ensure-codex-room-mcp\.mjs" ensure/)
assert.match(launch, /\[ "\$vendor" = codex \].*ensure "\$proj"/)
assert.match(teardown, /ensure-codex-room-mcp\.mjs" remove/)

try {
  run('ensure', root)
  const listed = execFileSync('codex', ['mcp', 'list'], { cwd: root, encoding: 'utf8' })
  assert.match(listed, /^room\s+node\s+.*room\/client\.mjs/mu)
} finally {
  run('remove', root)
}
assert.equal(existsSync(resolve(root, '.codex/config.toml')), false)

console.log('live-seat-config r3 boundary: 13/13 green')
