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
  // members の値は `{ joined_at, …任意欄 }`。旧形式（値が ISO 文字列）もそのまま読める
  const stored = existsSync(membersPath) ? Object.entries(JSON.parse(readFileSync(membersPath, 'utf8'))) : []
  const members = new Map(stored.map(([n, v]) => [n, typeof v === 'string' ? { joined_at: v } : v]))
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

const recipientError = (code, message) => ({
  schema: 'peertable.error.v1', code, message,
})

// broadcast は protocol 境界で拒否する。複数人宛は `to_names` だけを正本にし、`to: 'all'` へ
// 倒さない。既存ログの `to: 'all'` 行は readMessages がそのまま返すので、読み出し互換は残る。
function normalizeAudience(to, toNames) {
  if (to === 'all' || (Array.isArray(to) && to.includes('all'))) return {
    error: recipientError('EXPLICIT_RECIPIENT_REQUIRED', 'broadcast_recipient_not_allowed'),
  }
  const list = Array.isArray(to) ? to : Array.isArray(toNames) ? toNames : null
  if (list === null) {
    if (typeof to !== 'string' || to.length === 0 || to === 'all') return {
      error: recipientError('EXPLICIT_RECIPIENT_REQUIRED', 'broadcast_recipient_not_allowed'),
    }
    return { to, to_names: null }
  }
  if (!list.every(n => typeof n === 'string' && n.length > 0 && n !== 'all')) return {
    error: recipientError('EXPLICIT_RECIPIENT_REQUIRED', 'broadcast_recipient_not_allowed'),
  }
  const names = [...new Set(list)]
  if (names.length === 0) return {
    error: recipientError('EXPLICIT_RECIPIENT_REQUIRED', 'recipient_list_empty'),
  }
  if (names.length === 1) return { to: names[0], to_names: null }
  return { to: null, to_names: names }
}

function post(room, from, to, body, toNames = null) {
  const msg = {
    seq: ++room.seq, ts: new Date().toISOString(), from, body,
    ...(to === null ? {} : { to }),
    ...(toNames ? { to_names: toNames } : {}),
  }
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
      return json(res, 200, {
        members: [...room.members].map(([name, meta]) => ({ name, ...meta })),
        capabilities: { member_observation_v1: true },
      }, CORS)

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
      const { from, to, to_names: toNames, body: text } = JSON.parse(body)
      // 本文が無ければ **書かずに 400**。ここを素通しにすると `JSON.stringify` が欄ごと落として、
      // append-only の正本へ**本文の無い行**が入る——しかも送信側には 200 と seq が返るので
      // 「送れた」と表示される（2026-08-08 に本番で2件実測。消せない）
      if (typeof text !== 'string') return json(res, 400, { error: 'body_required' })
      const audience = normalizeAudience(to, toNames)
      if (audience.error) return json(res, 400, audience.error)
      return json(res, 200, post(room, from, audience.to, text, audience.to_names))
    }
    if (req.method === 'POST' && rest === 'members') {
      const { name, ...meta } = JSON.parse(body)
      // 素性（vendor/model/effort）や稼働状態は、名前以外の欄をそのまま任意欄として持つ。
      // **渡された欄だけ更新し、渡されなかった欄は既存を保つ**——席の client は `{name}` だけで
      // 登録するので、これが無いと再接続のたびに素性が消える。`joined_at` は最初の登録を保つ。
      const known = room.members.get(name)
      room.members.set(name, { joined_at: known?.joined_at ?? new Date().toISOString(), ...known, ...meta })
      saveMembers(room)
      // **system 発言は本当に新規の時だけ**。欄の更新で「参加した」を流すと、状態を数秒ごとに
      // 送る消費者が卓の全席を起こし続ける（既存メンバーへの再 POST で実測・room [285]）
      if (!known) post(room, 'system', name, `${name} が参加した`)
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
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#f7f6f3;--surface:#fff;--line:#e4e2dc;--accent:#1d4ed8;--dim:#8a877f;--sat:55%;--lum:45%;--name:32%;--tint:96%;--edge:82%;--busy:#1f9d55;--idle:#b9b6ae;--dead:#d03b3b}
@media(prefers-color-scheme:dark){:root{--fg:#e8e6e0;--bg:#141418;--surface:#1e1e24;--line:#2c2c33;--accent:#7aa2ff;--dim:#8b8892;--sat:48%;--lum:56%;--name:75%;--tint:18%;--edge:32%;--busy:#3ecf7e;--idle:#4d4b52;--dead:#ff6b6b}}
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
.chip.has-meta{cursor:pointer}
/* 稼働状態の点。報告が途絶えたら unknown（中空）へ落として、古い状態を出し続けない */
.chip .st{flex:none;width:7px;height:7px;border-radius:50%;margin-left:1px;background:var(--dim)}
.chip .st.busy{background:var(--busy)}
.chip .st.idle{background:var(--idle)}
.chip .st.dead{background:var(--dead)}
.chip .st.unknown{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dim)}
.metapop{position:fixed;z-index:20;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.18);max-width:70vw}
.metapop .metaname{font-weight:600;margin-bottom:2px}
.metapop .metaline{color:var(--dim)}
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
.seq{color:var(--dim);font:500 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;user-select:all;white-space:nowrap}
.msg .seq{display:block;width:max-content;margin:2px 3px 0 auto}
.bubble{padding:8px 12px;border-radius:4px 13px 13px 13px;background:hsl(var(--h) var(--sat) var(--tint));border:1px solid hsl(var(--h) var(--sat) var(--edge)/.45);overflow-wrap:anywhere}
.bubble>*{margin:0}.bubble>*+*{margin-top:7px}
.bubble code{font:500 .92em ui-monospace,SFMono-Regular,Menlo,monospace;background:hsl(var(--h) var(--sat) var(--edge)/.22);border-radius:3px;padding:.1em .35em}
.bubble pre{background:hsl(var(--h) var(--sat) var(--edge)/.16);border:1px solid hsl(var(--h) var(--sat) var(--edge)/.4);border-radius:5px;padding:7px 10px;overflow-x:auto}
.bubble pre code{background:none;padding:0;white-space:pre}
.bubble ul{padding-left:1.25em}.bubble li{margin:1px 0}
.bubble table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;font-size:.94em}
.bubble th,.bubble td{border:1px solid hsl(var(--h) var(--sat) var(--edge)/.5);padding:3px 8px;text-align:left;vertical-align:top}
.bubble th{background:hsl(var(--h) var(--sat) var(--edge)/.18);font-weight:650}
.msg.cont .bubble{border-radius:13px}
.msg.dm .bubble{border-style:dashed;border-color:hsl(var(--h) var(--sat) var(--edge))}
.msg.dm .to{color:hsl(var(--h) var(--sat) var(--name));font-weight:600}
.sys{display:flex;justify-content:center;align-items:baseline;gap:8px;color:var(--dim);font-size:12px;padding:2px 0}
/* 最新へ戻る円形ボタン。最下部に居る時は hidden で消える（表示条件は追従と同じ nearBottom） */
.to-bottom{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:3;display:grid;place-items:center;width:40px;height:40px;padding:0;border:1px solid var(--line);border-radius:50%;background:var(--surface);color:var(--fg);font-size:17px;line-height:1;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18)}
.to-bottom:hover{border-color:var(--accent);color:var(--accent)}
.to-bottom:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.to-bottom[hidden]{display:none}
.sys .body{padding:2px 12px;border-radius:999px;background:var(--surface);border:1px solid var(--line)}
</style></head><body>
<header class="top"><div class="brand">${MARK}${esc(room)} <small>· Peertable</small></div><div class="members" id="members"></div></header>
<main class="log" id="log"></main>
<button class="to-bottom" id="to-bottom" type="button" hidden aria-label="最新の発言へ" title="最新の発言へ">↓</button>
<script>
const ROOM=${JSON.stringify(room)}
const api=p=>'/api/'+encodeURIComponent(ROOM)+'/'+p
const logEl=document.getElementById('log'),membersEl=document.getElementById('members')
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
// Markdown サブセットを DOM で組む。文字列を連結して innerHTML へ入れる形は取らない——
// エスケープを1箇所忘れた瞬間に穴が開く構造を選ばない（本文は常に textContent 経由で入る）。
// 対応: fenced code / 表 / 箇条書き / インラインコード / **強調** / 改行。リンクは入れない。
const RE_FENCE=/^\\u0060{3}/,RE_ROW=/^\\s*\\|.*\\|\\s*$/,RE_SEP=/^\\s*\\|[-: |]+\\|\\s*$/,RE_LI=/^\\s*[-*]\\s+/
const RE_INLINE=/\\u0060([^\\u0060\\n]+)\\u0060|\\*\\*([^*\\n]+)\\*\\*/g
function inline(parent,text){
  RE_INLINE.lastIndex=0
  let i=0,m
  while((m=RE_INLINE.exec(text))){
    if(m.index>i)parent.appendChild(document.createTextNode(text.slice(i,m.index)))
    parent.appendChild(m[1]!=null?el('code',null,m[1]):el('strong',null,m[2]))
    i=RE_INLINE.lastIndex
  }
  if(i<text.length)parent.appendChild(document.createTextNode(text.slice(i)))
}
const isTable=(ls,i)=>RE_ROW.test(ls[i])&&i+1<ls.length&&RE_SEP.test(ls[i+1])
function md(src){
  const frag=document.createDocumentFragment(),ls=String(src).split('\\n')
  let i=0
  while(i<ls.length){
    if(RE_FENCE.test(ls[i])){
      const buf=[];i++
      while(i<ls.length&&!RE_FENCE.test(ls[i]))buf.push(ls[i++])
      i++
      const pre=el('pre');pre.appendChild(el('code',null,buf.join('\\n')));frag.appendChild(pre);continue
    }
    if(isTable(ls,i)){
      const cells=r=>r.trim().replace(/^\\||\\|$/g,'').split('|').map(c=>c.trim())
      const table=el('table'),head=el('tr')
      cells(ls[i]).forEach(c=>{const th=el('th');inline(th,c);head.appendChild(th)})
      const thead=el('thead');thead.appendChild(head);table.appendChild(thead)
      const tbody=el('tbody');i+=2
      while(i<ls.length&&RE_ROW.test(ls[i])){
        const tr=el('tr');cells(ls[i++]).forEach(c=>{const td=el('td');inline(td,c);tr.appendChild(td)});tbody.appendChild(tr)
      }
      table.appendChild(tbody);frag.appendChild(table);continue
    }
    if(RE_LI.test(ls[i])){
      const ul=el('ul')
      while(i<ls.length&&RE_LI.test(ls[i])){const li=el('li');inline(li,ls[i++].replace(RE_LI,''));ul.appendChild(li)}
      frag.appendChild(ul);continue
    }
    if(!ls[i].trim()){i++;continue}
    const buf=[]
    while(i<ls.length&&ls[i].trim()&&!RE_FENCE.test(ls[i])&&!RE_LI.test(ls[i])&&!isTable(ls,i))buf.push(ls[i++])
    const p=el('p')
    buf.forEach((l,k)=>{if(k)p.appendChild(el('br'));inline(p,l)})
    frag.appendChild(p)
  }
  return frag
}
const hue=n=>{let h=5381;for(let i=0;i<n.length;i++)h=(h*33+n.charCodeAt(i))|0;return Math.abs(h)%360}
const initial=n=>{const c=[...String(n)][0];return c?c.toUpperCase():'?'}
const stamp=at=>{const t=el('time','ts',at.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));t.dateTime=at.toISOString();t.title=at.toLocaleString();return t}
const compactCount=n=>n>=1000000?(Math.round(n/100000)/10)+'M':n>=1000?(Math.round(n/100)/10)+'k':String(n)
const elapsed=ms=>{const min=Math.floor(ms/60000);return min<1?'<1m':min>=60?Math.floor(min/60)+'h '+(min%60)+'m':min+'m'}
const nearBottom=()=>window.innerHeight+window.scrollY>=document.body.offsetHeight-80
// ボタンの出し入れと SSE の自動追従は同じ nearBottom で判断する。別々の閾値を持つと
// 「ボタンは消えているのに追従しない」帯ができて、どちらが壊れたのか分からなくなる
const toBottomEl=document.getElementById('to-bottom')
const syncToBottom=()=>{toBottomEl.hidden=nearBottom()}
const toBottom=()=>{window.scrollTo(0,document.body.scrollHeight);syncToBottom()}
toBottomEl.addEventListener('click',toBottom)
window.addEventListener('scroll',syncToBottom,{passive:true})
window.addEventListener('resize',syncToBottom,{passive:true})
let last=null,recent=null
function render(m){
  const at=new Date(m.ts)
  const seq=()=>el('span','seq','['+m.seq+']')
  if(m.from==='system'){const d=el('div','sys');d.appendChild(el('span','body',m.body));d.appendChild(seq());d.appendChild(stamp(at));logEl.appendChild(d);last=null;return}
  const aud=m=>Array.isArray(m.to_names)?m.to_names.join(', '):m.to
  const cont=last&&last.from===m.from&&aud(last)===aud(m)&&at-new Date(last.ts)<300000
  const d=el('div','msg'+(aud(m)!=='all'?' dm':'')+(cont?' cont':''))
  d.style.setProperty('--h',hue(m.from))
  d.appendChild(el('div','av',initial(m.from)))
  const body=el('div','body'),meta=el('div','meta')
  meta.appendChild(el('span','who',m.from))
  if(aud(m)!=='all')meta.appendChild(el('span','to','→ '+aud(m)))
  meta.appendChild(stamp(at))
  const bub=el('div','bubble');bub.appendChild(md(m.body))
  body.appendChild(meta);body.appendChild(bub);body.appendChild(seq())
  d.appendChild(body);logEl.appendChild(d);last=m
}
async function refreshMembers(){
  const r=await(await fetch(api('members'))).json()
  membersEl.textContent=''
  if(!r.members.length){membersEl.appendChild(el('span','empty','（まだ誰も居ない）'));return}
  for(const m of r.members){
    const c=el('span','chip'+(m.name===recent?' recent':''))
    c.style.setProperty('--h',hue(m.name));c.dataset.name=m.name
    // 素性は任意欄。名乗っていない席は行ごと出ない（空欄を「不明」として見せない）
    const meta=[m.model&&(m.vendor?m.vendor+' / '+m.model:m.model),m.effort&&('effort '+m.effort)].filter(Boolean)
    // 稼働状態は**報告が新しい時だけ**採る。途絶えたら unknown へ落とす——古い状態を出し続けるのが
    // いちばん悪い（動いていない席を「動いている」と見せる）。閾値は bridge の心拍30秒の3倍
    const age=m.status_at?Date.now()-Date.parse(m.status_at):Infinity
    const st=(m.status&&age<STATUS_STALE_MS)?m.status:(m.status?'unknown':null)
    if(st)meta.push('状態 '+({busy:'作業中',idle:'待機',dead:'停止',unknown:'不明（報告が途絶えている）'}[st]??st))
    const usage=[]
    const busyAge=m.busy_since?Date.now()-Date.parse(m.busy_since):NaN
    if(st==='busy'&&Number.isFinite(busyAge)&&busyAge>=0)usage.push('継続 '+elapsed(busyAge))
    if(Number.isSafeInteger(m.pane_token_hint)&&m.pane_token_hint>=0)usage.push(compactCount(m.pane_token_hint)+' tokens')
    if(usage.length)meta.push('消費目安 '+usage.join(' / ')+'（pane観測）')
    c.title=m.name+'（参加 '+new Date(m.joined_at).toLocaleString()+'）'+(meta.length?'\\n'+meta.join('\\n'):'')
    c.appendChild(el('span','av',initial(m.name)));c.appendChild(el('span','nm',m.name))
    if(st)c.appendChild(el('span','st '+st))
    // タップ環境には hover が無いので、押した時に同じ内容を出す（ホバーは title が担う）
    if(meta.length){c.classList.add('has-meta');c.addEventListener('click',ev=>{ev.stopPropagation();showMeta(c,m,meta)})}
    membersEl.appendChild(c)
  }
}
// タップ用の popover。hover が無い環境でも素性が読める。中身は title と同じ
let metaPop=null
function hideMeta(){if(metaPop){metaPop.remove();metaPop=null}}
function showMeta(chip,m,lines){
  if(metaPop&&metaPop.dataset.name===m.name){hideMeta();return}
  hideMeta()
  const p=el('div','metapop');p.dataset.name=m.name
  p.appendChild(el('div','metaname',m.name))
  for(const t of lines)p.appendChild(el('div','metaline',t))
  document.body.appendChild(p)
  const r=chip.getBoundingClientRect()
  p.style.left=Math.max(8,Math.min(r.left,innerWidth-p.offsetWidth-8))+'px'
  p.style.top=(r.bottom+6)+'px'
  metaPop=p
}
addEventListener('click',hideMeta)
addEventListener('scroll',hideMeta,true)

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
const STATUS_STALE_MS=90000 // 稼働状態の鮮度。これを過ぎた報告は unknown（bridge 心拍30秒の3倍）
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
    // 発言が増えると body が伸びる＝scroll イベントなしで「最下部か」が変わる。ここで取り直す
    if(added)syncToBottom()
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
    syncToBottom()
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
