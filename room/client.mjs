#!/usr/bin/env node
// Peertable セッション側クライアント。channel（新着の一行通知）と room ツールを 1 プロセスに統合する。
// .mcp.json 登録: {"command":"node","args":["client.mjs"],"env":{"PEERTABLE_URL":"http://192.168.1.2:8790","PEERTABLE_ROOM":"myproject","PEERTABLE_MEMBER":"hinata"}}
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const URL_BASE = process.env.PEERTABLE_URL
const ROOM = process.env.PEERTABLE_ROOM
const ME = process.env.PEERTABLE_MEMBER
const TOKEN = process.env.PEERTABLE_POST_TOKEN ?? null
if (!URL_BASE || !ROOM || !ME) throw new Error('PEERTABLE_URL / PEERTABLE_ROOM / PEERTABLE_MEMBER を設定すること')

const api = p => `${URL_BASE}/api/${ROOM}/${p}`
const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Peertable-Token': TOKEN } : {}) }
const relevant = m => m.from !== ME && (m.to === 'all' || m.to === ME)

let cursor = 0 // read_unread 用。参加時点から数える

const mcp = new Server(
  { name: 'room', version: '0.2.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions:
      `あなたは Peertable room「${ROOM}」のメンバー「${ME}」である。` +
      '<channel source="room"> の通知は「新着あり」の合図であり、本文は read_unread ツールで読む。' +
      '発言は post ツール（to: "all" は全員宛、メンバー名で個別宛=DM）。',
  },
)

const text = s => ({ content: [{ type: 'text', text: s }] })

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'post',
      description: 'room へ発言する。to は "all"（全員宛）またはメンバー名（個別宛=DM）',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '"all" またはメンバー名' },
          message: { type: 'string' },
        },
        required: ['to', 'message'],
      },
    },
    { name: 'read_unread', description: '未読メッセージ（全員宛と自分宛）を読む。読んだ位置は記憶される', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_log', description: 'room ログの直近 count 件を読む（既定 50。全宛先を含む）', inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
    { name: 'members', description: 'room に居るメンバーの一覧', inputSchema: { type: 'object', properties: {} } },
  ],
}))

const fmt = m => `[${m.seq}] ${m.from} → ${m.to} (${m.ts}): ${m.body}`

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments ?? {}
  switch (req.params.name) {
    case 'post': {
      const r = await fetch(api('messages'), { method: 'POST', headers, body: JSON.stringify({ from: ME, to: args.to, body: args.message }) })
      const msg = await r.json()
      if (!r.ok) return text(`送信失敗: ${JSON.stringify(msg)}`)
      cursor = Math.max(cursor, msg.seq)
      return text(`sent [${msg.seq}]`)
    }
    case 'read_unread': {
      const { messages } = await (await fetch(api(`messages?since=${cursor}`))).json()
      if (messages.length) cursor = messages[messages.length - 1].seq
      const mine = messages.filter(relevant)
      return text(mine.length ? mine.map(fmt).join('\n') : '未読なし')
    }
    case 'read_log': {
      const { messages } = await (await fetch(api('messages'))).json()
      return text(messages.slice(-(args.count ?? 50)).map(fmt).join('\n') || '（ログなし）')
    }
    case 'members': {
      const { members } = await (await fetch(api('members'))).json()
      return text(members.map(m => `${m.name}（参加 ${m.joined_at}）`).join('\n') || '（誰も居ない）')
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

await mcp.connect(new StdioServerTransport())

// 参加登録し、現在のログ末尾から未読を数え始める
await fetch(api('members'), { method: 'POST', headers, body: JSON.stringify({ name: ME }) })
{
  const { messages } = await (await fetch(api('messages'))).json()
  cursor = messages.length ? messages[messages.length - 1].seq : 0
}

// SSE 購読 → 自分に関係する新着だけ一行通知へ変換。切断は外部境界なので再接続する
async function subscribe() {
  for (;;) {
    try {
      const res = await fetch(api(`events`))
      let buf = ''
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8')
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('')
          if (!data) continue
          const m = JSON.parse(data)
          if (!relevant(m)) continue
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: { content: `room に新着あり（${m.from} → ${m.to}）。read_unread で読むこと。`, meta: { from: m.from, to: m.to, seq: String(m.seq) } },
          })
        }
      }
    } catch {
      // サーバー断。少し待って再接続（会話は止まるが工程はローカル Lattice で続く）
    }
    await new Promise(r => setTimeout(r, 3000))
  }
}
subscribe()
