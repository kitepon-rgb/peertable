#!/usr/bin/env node
// V1 検証用の最小 channel サーバー（一方向）。
// HTTP POST の body をそのまま notifications/claude/channel で注入する。
import http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const mcp = new Server(
  { name: 'room', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Events from the room channel arrive as <channel source="room" ...>. ' +
      'They are one-way notifications: follow the instruction in the message body.',
  },
)

await mcp.connect(new StdioServerTransport())

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', async () => {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: body, meta: { sent_at: String(Date.now()) } },
      })
      res.end('ok')
    })
  })
  .listen(8788, '127.0.0.1')
