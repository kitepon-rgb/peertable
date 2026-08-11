#!/usr/bin/env node
// t3: provider-neutral な親 role の配線を測る再現ハーネス。
//
// 確認すること:
//   1. setup.sh が .team/roles/parent.md を生成する（vendor を問わず読める role 文書）
//   2. parent-join.sh は mode=lattice の setup-state.json では .team/parent-env.sh を生成し、
//      LATTICE_TODO_ACTOR_HOST/SESSION/AGENT を親名で export する
//      （owner裁定[46]④: 子processのexportは親shellへ伝播しないため、親が自分でsourceする
//      持続ファイルが要る）
//   3. mode=standalone では parent-env.sh を生成しない（Lattice を持ち込まない卓を汚さない）
//   4. vendor=codex を渡すと member 登録の vendor が codex になる
//   5. token 未設定の新 shell が parent.md の再着卓ブロックだけで正規 config を source し、
//      秘密値を出力せず Unicode room の read / post へ到達する
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(ROOT, 'skill', 'scripts', 'setup.sh');
const PARENT_JOIN = path.join(ROOT, 'skill', 'scripts', 'parent-join.sh');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixtureServer() {
  const registered = [];
  const messages = [];
  const requests = [];
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    requests.push({ method: request.method, url: request.url, token: request.headers['x-peertable-token'] });
    if (request.method === 'POST' && request.url?.endsWith('/members')) {
      let body = '';
      request.on('data', (c) => { body += c; });
      request.on('end', () => {
        registered.push(JSON.parse(body));
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (request.method === 'GET' && request.url?.includes('/messages')) {
      response.end(JSON.stringify({ messages, latest_seq: messages.length }));
      return;
    }
    if (request.method === 'POST' && request.url?.endsWith('/messages')) {
      let body = '';
      request.on('data', (c) => { body += c; });
      request.on('end', () => {
        const message = { seq: messages.length + 1, ...JSON.parse(body) };
        messages.push(message);
        response.end(JSON.stringify({ ok: true, message }));
      });
      return;
    }
    if (request.method === 'GET' && request.url?.endsWith('/members')) {
      response.end(JSON.stringify({ members: registered.map((m) => ({ name: m.name })) }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, registered, messages, requests };
}

let ok = true;
const check = (name, pass, detail) => { console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!pass) ok = false; };

const work = await mktempWork();
async function mktempWork() { return mkdtemp(path.join(tmpdir(), 'peertable-parent-role-')); }

try {
  // 1. setup.sh（単独円卓モード）が .team/roles/parent.md を生成すること
  const proj = path.join(work, 'proj');
  await mkdir(proj, { recursive: true });
  await run('git', ['init', '-q'], { cwd: proj });
  await run('git', ['config', 'user.email', 'fixture@example.com'], { cwd: proj });
  await run('git', ['config', 'user.name', 'fixture'], { cwd: proj });
  await writeFile(path.join(proj, 'README.md'), '# fixture\n');
  await run('git', ['add', '-A'], { cwd: proj });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: proj });
  const tasksFile = path.join(work, 'tasks.txt');
  await writeFile(tasksFile, '- ダミー: 何もしない\n');

  const setupResult = await run('bash', [SETUP, proj, 'fixture-room', 'http://127.0.0.1:1', '-', ROOT, tasksFile]);
  check('setup.sh（単独）が成功する', setupResult.code === 0, setupResult.stderr.trim().slice(-300));
  const parentMd = await readFile(path.join(proj, '.team/roles/parent.md'), 'utf8').catch(() => null);
  check('.team/roles/parent.md が生成される', parentMd !== null);
  check('parent.md が親の行わないことを明記', parentMd?.includes('親が行わないこと') ?? false);
  check('parent.md が vendor 分岐（Claude/Codex の新着検知）を明記', (parentMd?.includes('Claude') && parentMd?.includes('Codex')) ?? false);

  // 2. parent-join.sh: mode=lattice の setup-state.json で parent-env.sh が生成される
  const { server, url, registered, messages, requests } = await fixtureServer();
  try {
    const latticeProj = path.join(work, 'lattice-proj');
    await mkdir(path.join(latticeProj, '.team'), { recursive: true });
    await writeFile(path.join(latticeProj, '.team/setup-state.json'), JSON.stringify({ room: 'r', server_url: url, mode: 'lattice' }));
    const childEnv = { PEERTABLE_POST_TOKEN: 'x' };
    const joinResult = await run('bash', [PARENT_JOIN, latticeProj, 'nagi-test', '', '', 'codex'], { env: childEnv });
    check('parent-join.sh（lattice）が成功する', joinResult.code === 0, joinResult.stderr.trim().slice(-300));
    const envFile = await readFile(path.join(latticeProj, '.team/parent-env.sh'), 'utf8').catch(() => null);
    check('mode=lattice で .team/parent-env.sh が生成される', envFile !== null);
    check('parent-env.sh が LATTICE_TODO_ACTOR_* を親名でexportする',
      (envFile?.includes('LATTICE_TODO_ACTOR_HOST=mac') && envFile?.includes('LATTICE_TODO_ACTOR_SESSION=nagi-test') && envFile?.includes('LATTICE_TODO_ACTOR_AGENT=nagi-test')) ?? false);
    check('vendor=codex が member 登録へ反映される', registered.some((m) => m.vendor === 'codex'));
    // TMUX 環境変数はこの harness プロセス自身から継承される（fixture が TMUX 外なら observe は無い）。
    const codexMember = registered.find((m) => m.name === 'nagi-test');
    if (process.env.TMUX) {
      check('親が tmux 内なら observe（tmux_socket/tmux_target）を自己申告する',
        typeof codexMember?.observe?.tmux_target === 'string' && codexMember.observe.tmux_target.length > 0,
        JSON.stringify(codexMember?.observe));
      check('observe が在れば wakeup-bridge 起動を試みる（ensure-bridge.sh 呼び出しの痕跡）',
        joinResult.stdout.includes('wakeup-bridge') || joinResult.stderr.includes('wakeup-bridge'));
    } else {
      check('親が tmux 外なら observe を送らず制約を明示する',
        codexMember?.observe === undefined && joinResult.stderr.includes('外部注入面が無いhost'));
    }

    // 3. mode=standalone では parent-env.sh を作らない
    const standaloneProj = path.join(work, 'standalone-proj');
    await mkdir(path.join(standaloneProj, '.team'), { recursive: true });
    await writeFile(path.join(standaloneProj, '.team/setup-state.json'), JSON.stringify({ room: 'r', server_url: url, mode: 'standalone' }));
    const joinResult2 = await run('bash', [PARENT_JOIN, standaloneProj, 'bell'], { env: childEnv });
    check('parent-join.sh（standalone）が成功する', joinResult2.code === 0, joinResult2.stderr.trim().slice(-300));
    const envFile2 = await readFile(path.join(standaloneProj, '.team/parent-env.sh'), 'utf8').catch(() => null);
    check('mode=standalone では .team/parent-env.sh を作らない', envFile2 === null);

    // 4. 再着卓: token を持たない新 shell が role の正規ブロックから read / post まで到達する
    const rejoinProj = path.join(work, 'rejoin-proj');
    const fixtureHome = path.join(work, 'home');
    const secret = 'fixture-parent-secret';
    await mkdir(path.join(rejoinProj, '.team'), { recursive: true });
    await mkdir(path.join(fixtureHome, '.config'), { recursive: true });
    await writeFile(path.join(rejoinProj, '.team/setup-state.json'), JSON.stringify({ room: '卓-あ', server_url: url, mode: 'lattice' }));
    await writeFile(path.join(fixtureHome, '.config/peertable.env'), `export PEERTABLE_POST_TOKEN=${secret}\n`);

    const start = '<!-- parent-rejoin-shell:start -->';
    const end = '<!-- parent-rejoin-shell:end -->';
    const marked = parentMd?.slice(parentMd.indexOf(start) + start.length, parentMd.indexOf(end)) ?? '';
    const shellBlock = marked.match(/```sh\n([\s\S]*?)\n```/)?.[1];
    check('parent.md に実行可能な再着卓 shell ブロックがある', typeof shellBlock === 'string');
    const rejoinScript = path.join(work, 'rejoin.sh');
    await writeFile(rejoinScript, `${shellBlock ?? 'exit 99'}\npeertable_parent_read 0\npeertable_parent_post nagi '再着卓テスト'\n`);
    const rejoin = await run('env', ['-u', 'PEERTABLE_POST_TOKEN', 'bash', rejoinScript], {
      env: { HOME: fixtureHome, PEERTABLE_PROJECT: rejoinProj, PEERTABLE_PARENT_NAME: 'bell' },
    });
    check('token 未設定の新 shell から再着卓 read/post が成功する', rejoin.code === 0, rejoin.stderr.trim().slice(-300));
    check('再着卓の標準出力・標準エラーへ秘密値を出さない', !`${rejoin.stdout}\n${rejoin.stderr}`.includes(secret));
    check('Unicode room path を percent-encode して読む', requests.some((r) => r.method === 'GET' && r.url?.includes('/api/%E5%8D%93-%E3%81%82/messages')));
    check('正規 token と安全なJSONで親の投稿が届く',
      messages.some((m) => m.from === 'bell' && m.to === 'nagi' && m.body === '再着卓テスト')
      && requests.some((r) => r.method === 'POST' && r.token === secret));
  } finally {
    server.close();
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(ok ? 'parent role repro: green' : 'parent role repro: RED');
process.exit(ok ? 0 : 1);
