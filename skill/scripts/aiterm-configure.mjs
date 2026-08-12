#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [session_id, ...args] = process.argv.slice(2)
let model = null
let reasoning_effort = null
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--model') model = args[i + 1] ?? null
  else if (args[i] === '--effort') reasoning_effort = args[i + 1] ?? null
  else throw new Error('SEAT_AITERM_CONFIGURE_ARGS_INVALID')
}
if (!session_id || (!model && !reasoning_effort)) {
  throw new Error('SEAT_AITERM_CONFIGURE_ARGS_INVALID')
}
// Aiterm のmanaged session metadataは実行時state root（macOSではTMPDIR）にある。
// stdio transportの既定環境は親のTMPDIRを落とすため、同じ公開serverへ明示継承する。
const transport = new StdioClientTransport({ command: 'aiterm-mcp', env: process.env })
const client = new Client({ name: 'peertable-seat-configure', version: '0.3.10' })
await client.connect(transport)
const result = await client.callTool({
  name: 'agent_configure',
  arguments: { session_id, ...(model ? { model } : {}), ...(reasoning_effort ? { reasoning_effort } : {}) },
})
await client.close()
if (result.isError) throw new Error(result.content?.[0]?.text ?? 'SEAT_AITERM_CONFIGURE_FAILED')
const receipt = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}')
if (receipt?.schema !== 'aiterm.agent-configure-result.v1' || receipt.session_id !== session_id) {
  throw new Error('SEAT_AITERM_CONFIGURE_RECEIPT_INVALID')
}
console.log(JSON.stringify(receipt))
