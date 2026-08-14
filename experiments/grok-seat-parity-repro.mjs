#!/usr/bin/env node
// Grok席をClaude/Codex席と同じAiterm公開経路へ載せる契約。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const adapter = join(root, 'skill/scripts/aiterm-launch.mjs')
const fixture = mkdtempSync(join(tmpdir(), 'peertable-grok-seat-'))
const sdkServer = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js')
const sdkStdio = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js')
const sdkTypes = import.meta.resolve('@modelcontextprotocol/sdk/types.js')
const fake = join(fixture, 'aiterm-mcp')
const callFile = join(fixture, 'call.json')

writeFileSync(fake, `#!/usr/bin/env node
import { Server } from ${JSON.stringify(sdkServer)}
import { StdioServerTransport } from ${JSON.stringify(sdkStdio)}
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(sdkTypes)}
import { writeFileSync } from 'node:fs'
const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  writeFileSync(process.env.CALL_FILE, JSON.stringify(request.params))
  const receipt = { schema: 'aiterm.agent-launch-result.v1', provider: 'grok', session_id: 'peer-grok-fixture', managed_completion: true, event_cursor: null, wait_command: null, submit_residue: null }
  return { content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt }
})
await server.connect(new StdioServerTransport())
`)
chmodSync(fake, 0o755)

try {
  const result = spawnSync(process.execPath, [
    adapter, 'peer-grok-fixture', 'grok', 'grok-4.6', 'high', root, '着任指示',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`, CALL_FILE: callFile },
  })
  assert.equal(result.status, 0, result.stderr)
  const call = JSON.parse(readFileSync(callFile, 'utf8'))
  assert.equal(call.name, 'grok_agent')
  assert.equal(call.arguments.model, 'grok-4.6')
  assert.equal(call.arguments.reasoning_effort, 'high')

  const launch = readFileSync(join(root, 'skill/scripts/launch-seat.sh'), 'utf8')
  const change = readFileSync(join(root, 'skill/scripts/change-seat.sh'), 'utf8')
  assert.match(launch, /grok --model "\$model" --reasoning-effort "\$effort" -p "ping"/)
  assert.match(launch, /Do you trust the contents of this directory\?/)
  assert.match(launch, /send-keys -t "\$sess" y/)
  assert.match(launch, /if \[ "\$vendor" = codex \] \|\| \[ "\$vendor" = grok \]; then[\s\S]*ensure-bridge\.sh" "\$proj" wakeup/)
  assert.match(change, /claude\|codex\|grok/)
  assert.match(change, /grok models/)

  console.log('grok seat parity: 9/9 green')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
