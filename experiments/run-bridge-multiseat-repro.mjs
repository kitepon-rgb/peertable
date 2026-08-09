#!/usr/bin/env node
// 配車ブリッジの複数席まわり（t8）の repro。
//
// usage: node experiments/run-bridge-multiseat-repro.mjs
//
// 確かめること（すべて対照込み）:
//   ① busy な席が居ても **idle な席が先に選ばれる**（busy 判定は pane の `esc to interrupt`）
//   ② `[辞退]` で **別の idle 席へ配り直す**（辞退した席へは戻さない）
//   ③ 全席 busy でも配車は止めない（席が辞退できるので、止めると卓が進まなくなる）
//   ④ `lattice run observe` の結果を room へ1行で返し、**変化が無い間は鳴らさない**
//
// **実 Lattice は使わない。** ここで見るのは bridge の席選定と room 投稿だけで、
// order/report の契約と一気通貫は `run-bridge-e2e-repro.mjs`（t7）が実物で見ている。
// observe は stub CLI（JSON を吐くだけの script）を `--lattice` で差して測る。
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, '..', 'skill', 'scripts', 'run-bridge.mjs');
const ROOM = 'multiseat';
const TOKEN = 'tk';
const SEATS = ['msbusy', 'msidle1', 'msidle2'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'NG  '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad += 1;
};

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'run-bridge-multiseat-')));
const proj = path.join(root, 'proj');
const spool = path.join(root, 'spool');
const sock = path.join(root, 'tmux.sock');
await mkdir(path.join(proj, '.team'), { recursive: true });
await mkdir(path.join(spool, 'orders'), { recursive: true });
await mkdir(path.join(spool, 'reports'), { recursive: true });

// ---- 偽 room server ----
const messages = [];
const streams = new Set();
let seq = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === `/api/${ROOM}/events`) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': connected\n\n');
    const ping = setInterval(() => res.write(`event: ping\ndata: ${seq}\n\n`), 2000);
    streams.add(res);
    req.on('close', () => { clearInterval(ping); streams.delete(res); });
    return;
  }
  if (req.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: messages.filter((m) => m.seq > since) }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const { from, to, body: text } = JSON.parse(body);
    const msg = { seq: ++seq, ts: new Date().toISOString(), from, to: to ?? 'all', body: text };
    messages.push(msg);
    for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
    res.writeHead(200); res.end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const urlBase = `http://127.0.0.1:${server.address().port}`;
await writeFile(path.join(proj, '.team', 'setup-state.json'),
  JSON.stringify({ room: ROOM, server_url: urlBase }) + '\n');
const say = (from, text) => fetch(`${urlBase}/api/${ROOM}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-peertable-token': TOKEN },
  body: JSON.stringify({ from, to: 'all', body: text }),
});

// ---- 席。1つだけ `esc to interrupt` を画面に出して busy に見せる ----
const tmux = (...args) => execFileSync('tmux', ['-S', sock, ...args], { encoding: 'utf8' });
for (const name of SEATS) {
  tmux('new-session', '-d', '-s', `peer-${name}`, '-x', '200', '-y', '50');
}
// **marker は pane の下端に置く。** 実席（Claude/Codex）は全画面 TUI でステータス行を最下部へ描くので、
// busy 判定は末尾14行だけを見る。ここで上端に印字すると「idle に見える」——測定器の作り方の問題で、
// 実装の欠陥ではない（この repro を書いた時に実際に踏んだ）。
tmux('send-keys', '-t', `peer-${SEATS[0]}`, `clear; printf '\\n%.0s' $(seq 1 45); printf 'Working (7m esc to interrupt)\\n'; node -e 'setTimeout(()=>{},600000)'`, 'Enter');
for (const name of SEATS.slice(1)) {
  tmux('send-keys', '-t', `peer-${name}`, `clear; node -e 'setTimeout(()=>{},600000)'`, 'Enter');
}
await sleep(1500);

// ---- stub lattice（`run observe` だけ答える） ----
const stub = path.join(root, 'lattice-stub.mjs');
const stateFile = path.join(root, 'observe-state.json');
const callFile = path.join(root, 'observe-calls.txt');
await writeFile(stateFile, JSON.stringify({ running: ['T1'], accepted: [], terminal: [], closed: false }) + '\n');
await writeFile(stub, `#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(callFile)}, 'x');   // 呼ばれた回数を数える（poll が止まったかの唯一の証拠）
const argv = process.argv.slice(2);
if (argv[0] !== 'run' || argv[1] !== 'observe') { process.stderr.write('unsupported\\n'); process.exit(2); }
const s = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
process.stdout.write(JSON.stringify({ schema: 'lattice.run_observation.v1',
  running: s.running, accepted: s.accepted, terminal: s.terminal, hold_count: 0, conflict_count: 0,
  freeze_active: false, closed: s.closed, event_count: 4 }) + '\\n');
`);
await chmod(stub, 0o755);

// ---- order（canonical JSON + self digest。bridge の validOrder を通す形で作る） ----
function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
function makeOrder(todoId, digestSeed) {
  const worktree = path.join(root, '.lattice', 'runs', 'ms-run-1', 'worktrees', `wt-${digestSeed}`, 'tree');
  const order = {
    schema: 'lattice.run_work_order.v1',
    todo_id: todoId,
    worktree_path: worktree,
    base_sha: 'a'.repeat(40),
    scope_writes: ['src/a.mjs'],
    verifier_refs: [],
    forbidden_operations: ['push'],
    packet_digest: createHash('sha256').update(digestSeed).digest('hex'),
    order_digest: '',
  };
  const { order_digest: _drop, ...rest } = order;
  order.order_digest = createHash('sha256').update(Buffer.from(canonical(rest), 'utf8')).digest('hex');
  return order;
}

const bridge = spawn(process.execPath, [BRIDGE, proj, spool, '--lattice', stub, ...SEATS], {
  env: { ...process.env, PEERTABLE_POST_TOKEN: TOKEN, PEERTABLE_TMUX_SOCKET: sock },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const bridgeLog = [];
bridge.stdout.on('data', (c) => bridgeLog.push(String(c)));
bridge.stderr.on('data', (c) => bridgeLog.push(String(c)));

const teardown = async () => {
  const stop = spawn(process.execPath, [BRIDGE, proj, '--stop'],
    { env: { ...process.env, PEERTABLE_POST_TOKEN: TOKEN }, stdio: 'ignore' });
  await new Promise((r) => stop.once('close', r));
  try { process.kill(bridge.pid, 'SIGKILL'); } catch { /* 済み */ }
  try { tmux('kill-server'); } catch { /* 済み */ }
  for (const stream of streams) stream.end();
  server.close();
  await rm(root, { recursive: true, force: true });
};

const waitFor = async (predicate, why, ms = 20_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = messages.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) { check(why, false, '来なかった'); return null; }
    await sleep(200);
  }
};

try {
  await sleep(1500);
  const order = makeOrder('T1', 'seed-one');
  await writeFile(path.join(spool, 'orders', `${order.packet_digest}.json`),
    `${canonical(order)}\n`, { mode: 0o600 });

  const first = await waitFor((m) => m.body?.startsWith('[work order] T1'), '① 配車が出る');
  if (first === null) throw new Error('配車が出ない');
  check('① busy な席を避けて idle な席へ配車する', first.to !== SEATS[0],
    `→ ${first.to}（busy に見せた席は ${SEATS[0]}）`);

  // ② 辞退 → 別の idle 席へ
  await say(first.to, '[辞退] T1 手が塞がっている');
  const second = await waitFor(
    (m) => m.to !== first.to && m.body?.startsWith('[work order] T1'), '② 辞退で別席へ配り直す',
  );
  check('② 辞退で別の席へ配り直す', second !== null && second.to !== first.to,
    second ? `${first.to} → ${second.to}` : '');
  check('②b 辞退した席へは戻さない', second?.to !== first.to);
  check('②c busy な席は最後まで選ばれない', second?.to !== SEATS[0], `→ ${second?.to}`);

  // ③ 残るのが busy な席だけになっても配車は止めない（席が辞退できるので、止めると卓が進まない）
  await say(second.to, '[辞退] T1 こちらも塞がっている');
  const third = await waitFor(
    (m) => m.to === SEATS[0] && m.body?.startsWith('[work order] T1'), '③ 全席busyでも配車する',
  );
  check('③ idle が尽きたら busy な席へ配車する（止めない）', third !== null, `→ ${third?.to}`);

  // ④ run observe の結果を room へ返す・変化が無ければ鳴らさない
  const runPosts = () => messages.filter((m) => m.body?.startsWith('[run] '));
  const firstRun = await waitFor((m) => m.body?.startsWith('[run] '), '④ run 進行が room へ出る', 25_000);
  check('④ run 進行を room へ1行で返す', firstRun !== null, firstRun?.body);
  check('④a 進行中の TODO（running）が要約に載る', firstRun?.body.includes('running=[T1]') === true,
    firstRun?.body);
  const countAfterFirst = runPosts().length;
  await sleep(12_000);
  check('④b 変化が無い間は鳴らさない', runPosts().length === countAfterFirst,
    `${countAfterFirst} → ${runPosts().length} 件`);
  await writeFile(stateFile, JSON.stringify({ running: [], accepted: ['T1'], terminal: ['T1'], closed: true }) + '\n');
  const changed = await waitFor((m) => m.body?.startsWith('[run] ') && m.body.includes('closed=true'),
    '④c 変化したら鳴らす', 25_000);
  check('④c 変化したら鳴らす', changed !== null, changed?.body);
  // ⑤ closed を観測したら poll を止める。
  // **ログ件数では測れない**——旧実装も summary 不変ならログを増やさず、`lattice run observe` だけ
  // 10秒ごとに起動し続ける（欠陥版でも PASS してしまう）。stub の呼出回数だけが止まった証拠になる。
  const calls = async () => (await readFile(callFile, 'utf8').catch(() => '')).length;
  const beforeStop = await calls();
  await sleep(22_000);
  const afterStop = await calls();
  check('⑤ closed 後は observe を呼ばない', beforeStop === afterStop,
    `stub 呼出 ${beforeStop} → ${afterStop} 回`);
  check('⑤b 止めた理由を記録する', bridgeLog.join('').includes('run 終端を観測したので poll を止める'));
} finally {
  await teardown();
  console.log('--- bridge log ---');
  console.log(bridgeLog.join('').split('\n').filter((l) => l.length > 0).slice(-14).join('\n'));
}

console.log(bad === 0 ? '全部通った' : `${bad} 件 NG`);
process.exit(bad === 0 ? 0 : 1);
