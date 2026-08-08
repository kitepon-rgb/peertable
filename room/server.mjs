#!/usr/bin/env node
// Peertable room サーバー。チャットルームの正本を所有し、Web UI を内蔵する。
// 起動: node server.mjs（PEERTABLE_PORT / PEERTABLE_DATA / PEERTABLE_POST_TOKEN で設定）
import http from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.PEERTABLE_PORT ?? 8790)
const DATA = process.env.PEERTABLE_DATA ?? './peertable-data'
const TOKEN = process.env.PEERTABLE_POST_TOKEN ?? null // 設定時のみ書込に要求（公開設置用）

mkdirSync(DATA, { recursive: true })

// room 状態はプロセスが所有する（正本ファイルへの書込はこのプロセスだけ）
const rooms = new Map() // name -> { seq, members: Map<name, joined_at>, streams: Set<res> }

// create=true は書込系だけが渡す。読み取りは room を作らない
function loadRoom(name, create = false) {
  const cached = rooms.get(name)
  if (cached) {
    if (create) mkdirSync(cached.dir, { recursive: true })
    return cached
  }
  const dir = join(DATA, name)
  if (create) mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'log.jsonl')
  const seq = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0
  const membersPath = join(dir, 'members.json')
  const members = new Map(existsSync(membersPath) ? Object.entries(JSON.parse(readFileSync(membersPath, 'utf8'))) : [])
  const room = { name, dir, logPath, membersPath, seq, members, streams: new Set() }
  rooms.set(name, room)
  return room
}

function saveMembers(room) {
  writeFileSync(room.membersPath, JSON.stringify(Object.fromEntries(room.members)) + '\n')
}

function readMessages(room, since = 0) {
  if (!existsSync(room.logPath)) return []
  return readFileSync(room.logPath, 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(m => m.seq > since)
}

function post(room, from, to, body) {
  const msg = { seq: ++room.seq, ts: new Date().toISOString(), from, to, body }
  appendFileSync(room.logPath, JSON.stringify(msg) + '\n')
  const chunk = `data: ${JSON.stringify(msg)}\n\n`
  for (const res of room.streams) res.write(chunk)
  return msg
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b)) })

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const seg = url.pathname.split('/').filter(Boolean)

  // API: /api/<room>/...
  if (seg[0] === 'api' && seg[1]) {
    const room = loadRoom(seg[1], req.method !== 'GET')
    const rest = seg.slice(2).join('/')

    if (req.method === 'GET' && rest === 'messages')
      return json(res, 200, { messages: readMessages(room, Number(url.searchParams.get('since') ?? 0)) })

    if (req.method === 'GET' && rest === 'members')
      return json(res, 200, { members: [...room.members].map(([name, joined_at]) => ({ name, joined_at })) })

    if (req.method === 'GET' && rest === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(`: connected seq=${room.seq}\n\n`)
      room.streams.add(res)
      req.on('close', () => room.streams.delete(res))
      return
    }

    // 書込系。TOKEN 設定時は一致を要求する（外部公開設置のための最小ゲート）
    const body = await readBody(req)
    if (TOKEN !== null && (req.headers['x-peertable-token'] ?? url.searchParams.get('token')) !== TOKEN)
      return json(res, 403, { error: 'token_required' })

    if (req.method === 'POST' && rest === 'messages') {
      const { from, to, body: text } = JSON.parse(body)
      return json(res, 200, post(room, from, to ?? 'all', text))
    }
    if (req.method === 'POST' && rest === 'members') {
      const { name } = JSON.parse(body)
      if (!room.members.has(name)) { room.members.set(name, new Date().toISOString()); saveMembers(room) }
      post(room, 'system', 'all', `${name} が参加した`)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'DELETE' && seg[2] === 'members' && seg[3]) {
      room.members.delete(decodeURIComponent(seg[3])); saveMembers(room)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'DELETE' && seg.length === 2) {
      for (const s of room.streams) s.end()
      rooms.delete(room.name); rmSync(room.dir, { recursive: true, force: true })
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'not_found' })
  }

  // UI: / は room 一覧、/<room> はライブビュー
  if (req.method === 'GET' && seg.length === 0) {
    const list = readdirSync(DATA, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`<!doctype html><meta charset="utf-8"><title>Peertable</title><body style="font-family:sans-serif;max-width:640px;margin:40px auto"><h1>Peertable</h1><p>A round table of peer agents.</p><ul>${list.map(r => `<li><a href="/${r}">${r}</a></li>`).join('') || '<li>(no rooms yet)</li>'}</ul>`)
  }
  if (req.method === 'GET' && seg.length === 1) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(UI(seg[0]))
  }
  json(res, 404, { error: 'not_found' })
}).listen(PORT, () => console.error(`peertable room server on :${PORT} (data: ${DATA})`))

const UI = room => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${room} · Peertable</title><style>
  :root{--fg:#1a1a1a;--bg:#fafaf8;--line:#e4e2dc;--accent:#1d4ed8;--dim:#8a877f}
  @media(prefers-color-scheme:dark){:root{--fg:#e8e6e0;--bg:#16161a;--line:#2c2c33;--accent:#7aa2ff;--dim:#77747c}}
  body{font-family:ui-sans-serif,system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:760px;margin:0 auto;padding:24px 16px}
  h1{font-size:18px;margin:0 0 4px}h1 small{color:var(--dim);font-weight:normal}
  #members{color:var(--dim);font-size:13px;margin-bottom:16px}
  #log{border-top:1px solid var(--line)}
  .m{padding:8px 0;border-bottom:1px solid var(--line);font-size:14px;line-height:1.6}
  .m .h{color:var(--dim);font-size:12px}.m .h b{color:var(--accent);font-weight:600}
  .m.dm .h::after{content:" · DM";color:var(--dim)}
  .m.system{color:var(--dim);font-style:italic}
  form{display:flex;gap:8px;margin-top:16px}
  input,select{font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
  #body{flex:1}button{font:inherit;padding:8px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
</style></head><body>
<h1>${room} <small>· Peertable</small></h1><div id="members"></div><div id="log"></div>
<form id="f"><input id="name" placeholder="名前" size="8" required><select id="to"><option value="all">全員宛</option></select><input id="body" placeholder="発言（Enter で送信）" required autocomplete="off"><button>送る</button></form>
<script>
const log=document.getElementById('log'),membersEl=document.getElementById('members'),toEl=document.getElementById('to')
const render=m=>{const d=document.createElement('div');d.className='m'+(m.to!=='all'?' dm':'')+(m.from==='system'?' system':'')
  d.innerHTML='<div class="h"><b></b> → '+m.to+' · '+new Date(m.ts).toLocaleTimeString()+'</div><div class="b"></div>'
  d.querySelector('b').textContent=m.from;d.querySelector('.b').textContent=m.body;log.appendChild(d);window.scrollTo(0,document.body.scrollHeight)}
const refreshMembers=async()=>{const r=await(await fetch('/api/${room}/members')).json()
  membersEl.textContent='卓に居る: '+(r.members.map(m=>m.name).join('、')||'（まだ誰も居ない）')
  toEl.innerHTML='<option value="all">全員宛</option>'+r.members.map(m=>'<option>'+m.name+'</option>').join('')}
fetch('/api/${room}/messages').then(r=>r.json()).then(r=>r.messages.forEach(render))
new EventSource('/api/${room}/events').onmessage=e=>{render(JSON.parse(e.data));refreshMembers()}
refreshMembers()
document.getElementById('f').onsubmit=async e=>{e.preventDefault()
  const token=localStorage.peertableToken??''
  const r=await fetch('/api/${room}/messages',{method:'POST',headers:{'X-Peertable-Token':token},body:JSON.stringify({from:document.getElementById('name').value,to:toEl.value,body:document.getElementById('body').value})})
  if(r.status===403){localStorage.peertableToken=prompt('書込トークン');return}
  document.getElementById('body').value=''}
</script></body></html>`
