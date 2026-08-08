#!/usr/bin/env node
// Peertable セッション側クライアント。channel（新着の一行通知）と room ツールを 1 プロセスに統合する。
// .mcp.json 登録: {"command":"node","args":["client.mjs"],"env":{"PEERTABLE_URL":"http://192.168.1.2:8790","PEERTABLE_ROOM":"myproject","PEERTABLE_MEMBER":"hinata"}}
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// client.mjs 側のハードコード版数。package.json の version と一致していることを
// diagnostics の version_consistency が見る（2 つの版数源の drift 検出。決定45）
const MCP_VERSION = '0.3.1'
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `usage:
  peertable-client                       room MCP サーバーとして起動する（.mcp.json 経由の通常経路）
  peertable-client diagnostics           診断を人間可読で出す（fail の理由はこちらに出る）
  peertable-client diagnostics --json    schema peertable.native_factory_diagnostics.v1 の JSON で出す
`

// サブコマンドは引数がある時だけ解釈する。引数なし＝MCP stdio サーバー（本番の着席経路）は素通しで、
// 診断のコードは一切走らない（起動ディレイを増やさない）
const sub = process.argv[2]
if (sub !== undefined) {
  if (sub === 'diagnostics') process.exit(await runDiagnostics(process.argv.includes('--json')))
  process.stderr.write(`unknown subcommand: ${sub}\n${USAGE}`)
  process.exit(1)
}

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
  { name: 'room', version: MCP_VERSION },
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
      // cursor は触らない。自分の発言は relevant で除外されるので進める必要が無く、
      // ここで進めると post より前に届いた未読を読まないまま既読にしてしまう（0.2.1 で修正）
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

// 参加登録し、現在のログ末尾から未読を数え始める。
// 素性（vendor/model/effort）は launch-seat.sh が env へ入れる。**登録のたびに載せる**——
// 登録は client の起動ごとに繰り返し起きるので、1回きりの経路に置くと
// member の状態が失われた時に二度と戻らない（server 側は渡された欄だけ更新する upsert）
const IDENTITY = Object.fromEntries(Object.entries({
  vendor: process.env.PEERTABLE_VENDOR,
  model: process.env.PEERTABLE_MODEL,
  effort: process.env.PEERTABLE_EFFORT,
}).filter(([, v]) => v))
await fetch(api('members'), { method: 'POST', headers, body: JSON.stringify({ name: ME, ...IDENTITY }) })
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

// --- diagnostics（決定45 の契約。read-only。呼ばれた時だけ走る）-------------------------
// 関数宣言なので巻き上げられ、ファイル冒頭のサブコマンド分岐から呼べる。
// checks の値は契約どおり状態そのもの（pass / fail / not_applicable / unverified）。
// 外部 adapter が exact allowlist で検証するため JSON へ理由を混ぜず、理由は人間可読出力に出す。
async function runDiagnostics(asJson) {
  const checks = {}
  const why = {}
  const run = async (name, fn) => {
    try {
      const [status, reason] = await fn()
      checks[name] = status
      why[name] = reason
    } catch (e) {
      checks[name] = 'unverified'
      why[name] = `判定不能: ${e.message}`
    }
  }

  let pkg = null
  let pkgError = null
  try {
    pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  } catch (e) {
    pkgError = e
  }
  const needPkg = () => {
    if (!pkg) throw pkgError
    return pkg
  }

  await run('version_consistency', () => {
    const v = needPkg().version
    return v === MCP_VERSION
      ? ['pass', `package.json と client.mjs がどちらも ${v}`]
      : ['fail', `package.json=${v} / client.mjs=${MCP_VERSION} で食い違っている`]
  })

  await run('bin_integrity', () => {
    const bins = Object.entries(needPkg().bin ?? {})
    if (!bins.length) throw new Error('package.json に bin が無い')
    const broken = bins.filter(([, rel]) => {
      const p = join(PKG_ROOT, rel)
      if (!existsSync(p)) return true
      return !readFileSync(p, 'utf8').startsWith('#!')
    })
    return broken.length
      ? ['fail', `不在または shebang 無し: ${broken.map(([n]) => n).join(', ')}`]
      : ['pass', `${bins.map(([n]) => n).join(' / ')} が存在し shebang を持つ`]
  })

  await run('node_runtime', () => {
    const want = needPkg().engines?.node
    const min = /^>=\s*(\d+)/.exec(want ?? '')
    if (!min) throw new Error(`engines.node を解釈できない: ${want}`)
    const major = Number(process.version.slice(1).split('.')[0])
    return major >= Number(min[1])
      ? ['pass', `${process.version} が ${want} を満たす`]
      : ['fail', `${process.version} は ${want} を満たさない`]
  })

  await run('skill_bundle', () => {
    const required = [
      'SKILL.md',
      'scripts/setup.sh',
      'scripts/teardown.sh',
      'scripts/external-pane.mjs',
      'scripts/launch-seat.sh',
      'scripts/make-plan-input.mjs',
      'scripts/parent-join.sh',
      'scripts/wakeup-bridge.mjs',
      'templates/gen-plan.mjs',
      'templates/done.sh',
      'templates/charter.md',
      'templates/member.md',
      'templates/member-standalone.md',
      'templates/tasks.md',
      'templates/mcp.json',
    ]
    const missing = required.filter(f => !existsSync(join(PKG_ROOT, 'skill', f)))
    return missing.length
      ? ['fail', `skill/ に不足: ${missing.join(', ')}`]
      : ['pass', `必須 ${required.length} ファイルが揃っている`]
  })

  await run('room_reachability', async () => {
    const url = process.env.PEERTABLE_URL
    if (!url) return ['not_applicable', 'PEERTABLE_URL 未設定（npm 単体利用の平常状態）']
    try {
      const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) })
      return res.ok
        ? ['pass', `${url}/ が ${res.status} を返した`]
        : ['fail', `${url}/ が ${res.status} を返した`]
    } catch (e) {
      // 到達しないことは判定不能ではなく確定した fail（unverified へ丸めない）
      return ['fail', `${url}/ へ到達できない: ${e.message}`]
    }
  })

  const values = Object.values(checks)
  const overall = values.includes('unverified') ? 'unverified'
    : values.includes('fail') ? 'not_ready'
      : 'ready'

  const report = {
    schema: 'peertable.native_factory_diagnostics.v1',
    product: { name: pkg?.name ?? 'peertable', version: pkg?.version ?? null },
    checks,
    overall,
  }
  if (asJson) {
    console.log(JSON.stringify(report))
  } else {
    console.log(`peertable ${report.product.version ?? '(version 不明)'} — ${overall}`)
    for (const [name, status] of Object.entries(checks)) console.log(`  ${status.padEnd(15)} ${name}: ${why[name]}`)
  }
  return overall === 'ready' ? 0 : 1
}
