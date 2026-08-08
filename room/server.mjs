#!/usr/bin/env node
// Peertable room サーバー。チャットルームの正本を所有し、Web UI を内蔵する。
// 起動: node server.mjs（PEERTABLE_PORT / PEERTABLE_DATA / PEERTABLE_POST_TOKEN で設定）
import http from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.PEERTABLE_PORT ?? 8790)
const DATA = process.env.PEERTABLE_DATA ?? './peertable-data'
const TOKEN = process.env.PEERTABLE_POST_TOKEN ?? null // 設定時のみ書込に要求（公開設置用）
const HEARTBEAT_MS = 25000 // SSE 心拍。中間の proxy が落とす前・client の見張りが切る前の間隔

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

// 読み取り系だけ越境許可（Lattice 工程表ページからの probe fetch 用）。書込系には付けず OPTIONS も持たないので、
// ブラウザからの越境書込は成立しない＝読み取り専用の公開面（決定42）は変わらない
const CORS = { 'Access-Control-Allow-Origin': '*' }

const json = (res, code, obj, headers) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)) }
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b)) })

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const seg = url.pathname.split('/').filter(Boolean)

  // API: /api/<room>/...
  if (seg[0] === 'api' && seg[1]) {
    const room = loadRoom(seg[1], req.method !== 'GET')
    const rest = seg.slice(2).join('/')

    if (req.method === 'GET' && rest === 'messages')
      return json(res, 200, { messages: readMessages(room, Number(url.searchParams.get('since') ?? 0)) }, CORS)

    if (req.method === 'GET' && rest === 'members')
      return json(res, 200, { members: [...room.members].map(([name, joined_at]) => ({ name, joined_at })) }, CORS)

    if (req.method === 'GET' && rest === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS })
      res.write(`: connected seq=${room.seq}\n\n`)
      room.streams.add(res)
      // 心拍。TCP が半開きで死ぬと onerror も発火しないので、client が「途絶」を検知できる signal を送り続ける。
      // コメント行では EventSource から見えないため、名前付き event にする
      const beat = setInterval(() => res.write(`event: ping\ndata: ${room.seq}\n\n`), HEARTBEAT_MS)
      req.on('close', () => { clearInterval(beat); room.streams.delete(res) })
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
    return res.end(INDEX(list))
  }
  if (req.method === 'GET' && seg.length === 1) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(UI(seg[0]))
  }
  json(res, 404, { error: 'not_found' })
}).listen(PORT, () => console.error(`peertable room server on :${PORT} (data: ${DATA})`))

// HTML へ差し込む値は room 名などブラウザ由来なので、表示は esc・URL は encodeURIComponent・JS は JSON.stringify で渡す
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// ブランド: 卓（円）を囲む4人（点）。header の印と favicon で同じ形を使う
const MARK = `<svg class="mark" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="3" r="2" fill="currentColor"/><circle cx="21" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="21" r="2" fill="currentColor"/><circle cx="3" cy="12" r="2" fill="currentColor"/></svg>`
const FAVICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='4.6' fill='none' stroke='%231d4ed8' stroke-width='2'/%3E%3Ccircle cx='12' cy='3' r='2' fill='%231d4ed8'/%3E%3Ccircle cx='21' cy='12' r='2' fill='%231d4ed8'/%3E%3Ccircle cx='12' cy='21' r='2' fill='%231d4ed8'/%3E%3Ccircle cx='3' cy='12' r='2' fill='%231d4ed8'/%3E%3C/svg%3E">`

// 発言者ごとの色は名前ハッシュ（--h）から作る。彩度・明度だけテーマで持ち替えれば dark/light 両方が成立する
const STYLE = `
*{box-sizing:border-box}
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#f7f6f3;--surface:#fff;--line:#e4e2dc;--accent:#1d4ed8;--dim:#8a877f;--sat:55%;--lum:45%;--name:32%;--tint:96%;--edge:82%}
@media(prefers-color-scheme:dark){:root{--fg:#e8e6e0;--bg:#141418;--surface:#1e1e24;--line:#2c2c33;--accent:#7aa2ff;--dim:#8b8892;--sat:48%;--lum:56%;--name:75%;--tint:18%;--edge:32%}}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;font-size:14px;line-height:1.65;color:var(--fg);background:var(--bg)}
a{color:var(--accent)}
.brand{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:650;letter-spacing:.01em}
.brand .mark{color:var(--accent);flex:none}
.brand small{color:var(--dim);font-weight:400}
.av{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:hsl(var(--h) var(--sat) var(--lum));color:#fff;font-size:13px;font-weight:700;line-height:1}
.empty{color:var(--dim)}`

const UI = room => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(room)} · Peertable</title>${FAVICON}<style>${STYLE}
.top{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px 0}
.top>div{max-width:760px;margin:0 auto}
.members{display:flex;gap:6px;overflow-x:auto;padding:10px 0;scrollbar-width:thin}
.chip{flex:none;display:flex;align-items:center;gap:7px;padding:3px 11px 3px 3px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-size:12px;font-weight:600}
.chip .av{width:22px;height:22px;font-size:11px}
.chip.recent{border-color:hsl(var(--h) var(--sat) var(--edge))}
.chip.recent .nm{color:hsl(var(--h) var(--sat) var(--name))}
.chip.pulse .av{animation:pulse 1.6s ease-out 2}
@keyframes pulse{from{box-shadow:0 0 0 0 hsl(var(--h) var(--sat) var(--lum)/.6)}to{box-shadow:0 0 0 9px hsl(var(--h) var(--sat) var(--lum)/0)}}
.log{max-width:760px;margin:0 auto;padding:14px 16px 40px;display:flex;flex-direction:column;gap:10px}
.msg{display:flex;gap:9px;align-items:flex-start}
.msg.cont{margin-top:-8px}.msg.cont .av{visibility:hidden;height:0}.msg.cont .meta{display:none}
.msg .body{min-width:0;max-width:100%}
.meta{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;margin:0 0 3px 2px;font-size:12px}
.who{font-weight:700;color:hsl(var(--h) var(--sat) var(--name))}
.to{color:var(--dim)}.ts{color:var(--dim);font-variant-numeric:tabular-nums}
.bubble{padding:8px 12px;border-radius:4px 13px 13px 13px;background:hsl(var(--h) var(--sat) var(--tint));border:1px solid hsl(var(--h) var(--sat) var(--edge)/.45);white-space:pre-wrap;overflow-wrap:anywhere}
.msg.cont .bubble{border-radius:13px}
.msg.dm .bubble{border-style:dashed;border-color:hsl(var(--h) var(--sat) var(--edge))}
.msg.dm .to{color:hsl(var(--h) var(--sat) var(--name));font-weight:600}
.sys{display:flex;justify-content:center;align-items:baseline;gap:8px;color:var(--dim);font-size:12px;padding:2px 0}
.sys .body{padding:2px 12px;border-radius:999px;background:var(--surface);border:1px solid var(--line)}
</style></head><body>
<header class="top"><div class="brand">${MARK}${esc(room)} <small>· Peertable</small></div><div class="members" id="members"></div></header>
<main class="log" id="log"></main>
<script>
const ROOM=${JSON.stringify(room)}
const api=p=>'/api/'+encodeURIComponent(ROOM)+'/'+p
const logEl=document.getElementById('log'),membersEl=document.getElementById('members')
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
const hue=n=>{let h=5381;for(let i=0;i<n.length;i++)h=(h*33+n.charCodeAt(i))|0;return Math.abs(h)%360}
const initial=n=>{const c=[...String(n)][0];return c?c.toUpperCase():'?'}
const stamp=at=>{const t=el('time','ts',at.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));t.dateTime=at.toISOString();t.title=at.toLocaleString();return t}
const nearBottom=()=>window.innerHeight+window.scrollY>=document.body.offsetHeight-80
let last=null,recent=null
function render(m){
  const at=new Date(m.ts)
  if(m.from==='system'){const d=el('div','sys');d.appendChild(el('span','body',m.body));d.appendChild(stamp(at));logEl.appendChild(d);last=null;return}
  const cont=last&&last.from===m.from&&last.to===m.to&&at-new Date(last.ts)<300000
  const d=el('div','msg'+(m.to!=='all'?' dm':'')+(cont?' cont':''))
  d.style.setProperty('--h',hue(m.from))
  d.appendChild(el('div','av',initial(m.from)))
  const body=el('div','body'),meta=el('div','meta')
  meta.appendChild(el('span','who',m.from))
  if(m.to!=='all')meta.appendChild(el('span','to','→ '+m.to))
  meta.appendChild(stamp(at))
  body.appendChild(meta);body.appendChild(el('div','bubble',m.body))
  d.appendChild(body);logEl.appendChild(d);last=m
}
async function refreshMembers(){
  const r=await(await fetch(api('members'))).json()
  membersEl.textContent=''
  if(!r.members.length){membersEl.appendChild(el('span','empty','（まだ誰も居ない）'));return}
  for(const m of r.members){
    const c=el('span','chip'+(m.name===recent?' recent':''))
    c.style.setProperty('--h',hue(m.name));c.dataset.name=m.name
    c.title=m.name+'（参加 '+new Date(m.joined_at).toLocaleString()+'）'
    c.appendChild(el('span','av',initial(m.name)));c.appendChild(el('span','nm',m.name))
    membersEl.appendChild(c)
  }
}
// 直近の発言者を光らせる＝いま手を動かしている子が一覧で見える
function markActive(name){
  recent=name;let known=false
  for(const c of membersEl.children){
    if(!c.dataset.name)continue
    const hit=c.dataset.name===name;known=known||hit
    c.classList.toggle('recent',hit)
    if(hit){c.classList.remove('pulse');void c.offsetWidth;c.classList.add('pulse')}
  }
  if(!known)refreshMembers()
}
const BEAT=${HEARTBEAT_MS}
let lastSeq=0,lastBeat=Date.now(),es=null,emptyEl=null,firstLoad=true,catching=false
// seq で二重描画を弾く。張り直し後の追いつきと SSE の新着が重なっても同じ発言は1回しか出ない
function apply(m){
  if(m.seq<=lastSeq)return false
  lastSeq=m.seq
  if(emptyEl){emptyEl.remove();emptyEl=null}
  render(m)
  if(m.from!=='system')recent=m.from
  return true
}
async function catchUp(force){
  if(catching)return
  catching=true
  try{
    const stick=force||nearBottom()
    const r=await(await fetch(api('messages')+'?since='+lastSeq)).json()
    const added=r.messages.filter(apply).length
    if(!lastSeq&&!emptyEl){emptyEl=el('div','empty','（まだ発言がない）');logEl.appendChild(emptyEl)}
    await refreshMembers()
    if(added&&stick)window.scrollTo(0,document.body.scrollHeight)
  }finally{catching=false}
}
function connect(){
  if(es)es.close()
  es=new EventSource(api('events'));lastBeat=Date.now()
  es.onopen=()=>{lastBeat=Date.now();catchUp(firstLoad);firstLoad=false}
  // 心拍は room の最新 seq を積んでくる。繋がったまま取りこぼした（＝途絶しないので watchdog が気づけない）
  // 場合は、この差分だけが手掛かりになる
  es.addEventListener('ping',e=>{lastBeat=Date.now();if(Number(e.data)>lastSeq)catchUp()})
  es.onmessage=e=>{
    lastBeat=Date.now()
    const m=JSON.parse(e.data),stick=nearBottom()
    if(!apply(m))return
    if(m.from==='system')refreshMembers();else markActive(m.from)
    if(stick)window.scrollTo(0,document.body.scrollHeight)
  }
}
connect()
// 半開きで死んだ接続は onerror を出さない＝心拍の途絶だけが唯一の手掛かり。見つけたら黙って諦めず張り直す
setInterval(()=>{if(Date.now()-lastBeat>BEAT*2.5)connect()},BEAT/2)
setInterval(refreshMembers,30000) // 退席（member DELETE）は発言を出さないので定期に取り直す
</script></body></html>`

const INDEX = list => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peertable</title>${FAVICON}<style>${STYLE}
.wrap{max-width:560px;margin:0 auto;padding:56px 16px}
.tag{color:var(--dim);margin:6px 0 22px}
.rooms{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.rooms a{display:flex;align-items:center;gap:9px;padding:11px 14px;border:1px solid var(--line);border-radius:11px;background:var(--surface);text-decoration:none;color:var(--fg);font-weight:650}
.rooms a::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent)}
</style></head><body><div class="wrap">
<div class="brand">${MARK}Peertable</div>
<p class="tag">A round table of peer agents. No orchestrator at the head.</p>
<ul class="rooms">${list.map(r => `<li><a href="/${encodeURIComponent(r)}">${esc(r)}</a></li>`).join('') || '<li class="empty">（まだ卓が無い）</li>'}</ul>
</div></body></html>`
