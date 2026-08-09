#!/usr/bin/env node
// 配車ブリッジ（skill/scripts/run-bridge.mjs）の一気通貫 repro。
//
// usage: [LATTICE_ROOT=/path/to/Lattice] node experiments/run-bridge-e2e-repro.mjs
//
// 何を通すか: 偽 room server ＋ **実 tmux 席2つ** ＋ **実 bridge** ＋ **実 Lattice controller**
// （`spawnWorkOrderWorker`）で、配車 → 辞退 → 再配車 → 受諾 → 完了 → observed diff まで。
//
// 何を確かめるか（すべて対照込み）:
//   ① bridge が order を room へ配車する
//   ② 注入文の7項目が work order と一致する（bridge が勝手に値を作っていない）
//   ③ **受諾前に report を書かない**（辞退後も書かない）——書くと worker_pid が早く固定され、
//      辞退→再配車ができなくなる
//   ④ worker_pid が**受諾した席の process group leader**（pane の shell ではない）
//   ⑤ report が 0600
//   ⑥ 席が worktree へ書いた変更を **Lattice が独立に観測**して terminal receipt を組む
//
// **偽 room server を使う。** 本物（room/server.mjs）との差は心拍周期・`?since=` の意味・
// system 発言で、実 room・実席での受入は t7 が行う。ここが green でも t7 の代わりにはならない。
//
// 後片付け: tmux session（専用 socket）・偽 server・temp repo を必ず畳む。**他の卓の席は触らない**
// （socket を temp dir に切っているので、`peer-*` の名前が衝突しても実害が出ない）。
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, '..', 'skill', 'scripts', 'run-bridge.mjs');
const LATTICE_ROOT = process.env.LATTICE_ROOT ?? path.join(here, '..', '..', 'Lattice');

let lattice;
try {
  lattice = {
    selfDigest: (await import(path.join(LATTICE_ROOT, 'src/runtime-contracts.mjs'))).selfDigest,
    spawnWorkOrderWorker: (await import(path.join(LATTICE_ROOT, 'src/runtime-work-order-controller.mjs')))
      .spawnWorkOrderWorker,
  };
} catch (error) {
  console.error(`Lattice を読めない（LATTICE_ROOT=${LATTICE_ROOT}）: ${error.message}`);
  console.error('LATTICE_ROOT で Lattice repo の場所を指すこと。この repro は実 controller を使うので、'
    + 'Lattice 無しでは動かない（偽物で代替しない）');
  process.exit(2);
}

const SEAT = 'e2eseat';
const SEAT2 = 'e2eseat2';
const ROOM = 'e2eroom';
const TOKEN = 'e2e-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'NG  '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad += 1;
};

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'run-bridge-e2e-')));
const proj = path.join(root, 'proj');
const repo = path.join(proj, 'repo');
const spool = path.join(root, 'spool');
const sock = path.join(root, 'tmux.sock');
await mkdir(path.join(proj, '.team'), { recursive: true });
await mkdir(path.join(repo, 'src'), { recursive: true });
await mkdir(path.join(spool, 'orders'), { recursive: true });
await mkdir(path.join(spool, 'reports'), { recursive: true });

// ---- 偽 room server（本物と同じ3面だけ: SSE / GET messages / POST messages） ----
const messages = [];
const streams = new Set();
let seq = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === `/api/${ROOM}/events`) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // **接続直後に1バイト流す。** header を出さないと fetch が返らず、bridge は正しく待ったまま
    // 何もしない（本物は心拍を流すので起きない。偽物を作る側の落とし穴）
    res.write(': connected\n\n');
    const ping = setInterval(() => res.write(`event: ping\ndata: ${seq}\n\n`), 2000);
    streams.add(res);
    req.on('close', () => { clearInterval(ping); streams.delete(res); });
    return;
  }
  if (req.method === 'GET' && url.pathname === `/api/${ROOM}/messages`) {
    const since = Number(url.searchParams.get('since') ?? 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: messages.filter((m) => m.seq > since) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === `/api/${ROOM}/messages`) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers['x-peertable-token'] !== TOKEN) { res.writeHead(403); res.end('{}'); return; }
      const { from, to, body: text } = JSON.parse(body);
      const msg = { seq: ++seq, ts: new Date().toISOString(), from, to: to ?? 'all', body: text };
      messages.push(msg);
      for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(msg));
    });
    return;
  }
  res.writeHead(404); res.end('{}');
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

// ---- 実 tmux の席2つ。pane の shell の子に独立 process group の node を置く＝実席と同じ形 ----
const tmux = (...args) => execFileSync('tmux', ['-S', sock, ...args], { encoding: 'utf8' });
for (const name of [SEAT, SEAT2]) {
  tmux('new-session', '-d', '-s', `peer-${name}`, '-x', '200', '-y', '50');
  tmux('send-keys', '-t', `peer-${name}`, `node -e 'setTimeout(()=>{},600000)'`, 'Enter');
}
await sleep(1500);
const panePids = [SEAT, SEAT2].map((n) => Number(tmux('list-panes', '-t', `peer-${n}`, '-F', '#{pane_pid}').trim()));
const leaders = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
  .split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  .filter(([pid, ppid, pgid]) => panePids.includes(ppid) && pid === pgid).map(([pid]) => pid);
console.log(`席: pane_pid=${JSON.stringify(panePids)} group leader=${JSON.stringify(leaders)}`);
check('実席の形（pane の子に独立 PGID の leader が1席1つ）', leaders.length === 2, `${leaders.length} 件`);

// ---- 実 repo / worktree / packet ----
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '.'); git('config', 'user.email', 'e2e@example'); git('config', 'user.name', 'e2e');
await writeFile(path.join(repo, 'src/a.mjs'), 'export const a = 1;\n');
git('add', 'src'); git('commit', '-qm', 'base');
const base = git('rev-parse', 'HEAD');
const wt = path.join(root, 'tree');
git('worktree', 'add', '--detach', wt, base);
const packet = (() => {
  const v = {
    schema: 'lattice.executor_packet.v1', packet_id: 'p-1', todo_id: 'T1', task_ref: 'r',
    scope: { writes: ['src/a.mjs'] }, base_sha: base, plan_ref: 'plan', plan_epoch: 1,
    verifier_refs: ['node --test test/a.test.mjs'], forbidden_operations: ['push', 'branch'],
    context_content_digest: 'c'.repeat(64), packet_digest: '',
  };
  v.packet_digest = lattice.selfDigest(v, 'packet_digest');
  return v;
})();

// ---- 実 bridge ----
const bridge = spawn(process.execPath, [BRIDGE, proj, spool, SEAT, SEAT2], {
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
  try { process.kill(bridge.pid, 'SIGKILL'); } catch { /* 既に停止 */ }
  for (const pid of leaders) { try { process.kill(pid, 'SIGKILL'); } catch { /* 既に停止 */ } }
  try { tmux('kill-server'); } catch { /* 既に停止 */ }
  for (const stream of streams) stream.end();
  server.close();
  await rm(root, { recursive: true, force: true });
};

try {
  await sleep(1200);
  const worker = lattice.spawnWorkOrderWorker({ packet, worktreePath: wt, spoolDir: spool });

  const waitFor = async (predicate, why, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = messages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) { check(why, false, '来なかった'); return null; }
      await sleep(200);
    }
  };

  const orderPost = await waitFor((m) => m.body?.startsWith('[work order] T1'), '① 配車が room へ出る');
  if (orderPost === null) throw new Error('配車が出ないので以降を測れない');
  check('① 配車が room へ出る', true, `→ ${orderPost.to}`);

  const fields = Object.fromEntries(orderPost.body.split('\n').slice(1).filter((l) => l.includes(': '))
    .map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
  check('② 注入文の7項目が order と一致',
    fields.worktree === wt && fields.base_sha === base && fields.scope_writes === 'src/a.mjs'
    && fields.packet_digest === packet.packet_digest
    && fields.forbidden_operations === 'push, branch',
    JSON.stringify(fields.worktree));

  const reportPath = path.join(spool, 'reports', `${packet.packet_digest}.json`);
  check('③ 受諾前に report を書かない', await readFile(reportPath, 'utf8').catch(() => null) === null);

  const firstSeat = orderPost.to;
  const otherSeat = firstSeat === SEAT ? SEAT2 : SEAT;
  await say(firstSeat, '[辞退] T1 手が塞がっている');
  const redispatch = await waitFor(
    (m) => m.to === otherSeat && m.body?.startsWith('[work order] T1'), '③b 辞退で別の席へ配車し直す',
  );
  check('③b 辞退で別の席へ配車し直す', redispatch !== null, `${firstSeat} → ${otherSeat}`);
  check('③c 辞退でも report を書かない', await readFile(reportPath, 'utf8').catch(() => null) === null);

  await say(otherSeat, `[受諾] T1`);
  const binding = await Promise.race([worker, sleep(20_000).then(() => 'timeout')]);
  if (binding === 'timeout') {
    check('④ 受諾で controller が worker binding を得る', false, 'timeout');
  } else {
    check('④ worker_pid が席の process group leader', leaders.includes(binding.pid),
      `pid=${binding.pid} pgid=${binding.process_group_id} membership=${binding.process_membership}`);
    check('⑤ report が 0600', ((await stat(reportPath)).mode & 0o077) === 0);

    await writeFile(path.join(wt, 'src/a.mjs'), 'export const a = 2;\n');
    await say(otherSeat, '[完了] T1');
    const done = await Promise.race([binding.completed, sleep(20_000).then(() => 'timeout')]);
    check('⑥ Lattice が worktree の diff を独立に観測して receipt を組む',
      done !== 'timeout' && JSON.stringify(done.observedDiff) === JSON.stringify([{ path: 'src/a.mjs', change: 'modified' }]),
      done === 'timeout' ? 'timeout' : JSON.stringify(done.observedDiff));
  }
} finally {
  await teardown();
  console.log('--- bridge log ---');
  console.log(bridgeLog.join('').split('\n').filter((l) => l.length > 0).slice(-12).join('\n'));
}

console.log(bad === 0 ? '全部通った' : `${bad} 件 NG`);
process.exit(bad === 0 ? 0 : 1);
