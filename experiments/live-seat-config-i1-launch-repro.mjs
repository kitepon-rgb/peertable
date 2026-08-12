#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const adapter = join(root, 'skill/scripts/aiterm-launch.mjs')
const fixture = mkdtempSync(join(tmpdir(), 'peertable-i1-launch-'))
const sdkServer = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js')
const sdkStdio = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js')
const sdkTypes = import.meta.resolve('@modelcontextprotocol/sdk/types.js')
const fake = join(fixture, 'aiterm-mcp')

writeFileSync(fake, `#!/usr/bin/env node
import { Server } from ${JSON.stringify(sdkServer)}
import { StdioServerTransport } from ${JSON.stringify(sdkStdio)}
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(sdkTypes)}
const residue = process.env.FIXTURE_RESIDUE === 'true' ? true
  : process.env.FIXTURE_RESIDUE === 'false' ? false : null
const receipt = {
  schema: process.env.FIXTURE_INVALID === '1' ? 'invalid' : 'aiterm.agent-launch-result.v1',
  provider: 'codex', session_id: 'peer-fixture', submit_residue: residue,
}
const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt,
}))
await server.connect(new StdioServerTransport())
`)
chmodSync(fake, 0o755)

const run = (extra = {}) => spawnSync(process.execPath, [
  adapter, 'peer-fixture', 'codex', 'gpt-5.6-terra', 'high', root, '着任指示',
], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`, ...extra },
})

try {
  for (const value of ['true', 'false', 'null']) {
    const result = run({ FIXTURE_RESIDUE: value })
    assert.equal(result.status, 0, `submit_residue=${value}: ${result.stderr}`)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.submit_residue, value === 'true' ? true : value === 'false' ? false : null)
  }

  const invalid = run({ FIXTURE_INVALID: '1' })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /SEAT_AITERM_LAUNCH_RECEIPT_INVALID/)

  console.log('live-seat-config i1 launch receipt: 4/4 green')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
