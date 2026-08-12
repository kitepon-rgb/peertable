// 席設定変更（model / effort 共通操作）の再現ハーネス。
//
// 測るのは change-seat.sh の契約:
//   自然文依頼でも完全一致DMを要求しない / model-only・effort-only・同時変更 / 同値no-op /
//   busy保護 / vendor変更 / live catalogでの検証（hardcodeへ落ちない）/ 再起動 /
//   metadataの読み返し / room履歴 / 失敗時に旧設定へ1回だけの明示rollback。
//
// 罠: 旧 change-effort.sh は本人→親の単独DMが `[effort変更依頼] <level>` と**完全一致**することを
// 再検証していたため、意味の一意な自然文依頼（「effort を max に上げてほしい」）を
// EFFORT_CHANGE_REQUEST_REQUIRED で拒否した（2026-08-11 実測）。この harness は room に依頼DMを
// 一切置かないまま変更が通ることで、その機械判定が戻っていないことを見る。
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname)
const root = await mkdtemp(join(tmpdir(), 'peertable-seat-change-'))
const project = join(root, 'project')
const scripts = join(root, 'scripts')
const bin = join(root, 'bin')
const data = join(root, 'data')
const screen = join(root, 'screen.txt')
const launchLog = join(root, 'launch.log')
const failModel = join(root, 'fail-model')
const credentialHelper = join(root, 'seat-credential.mjs')
const port = 19200 + Math.floor(Math.random() * 500)
const base = `http://127.0.0.1:${port}`
const token = 'test-token'

await Promise.all([mkdir(join(project, '.team'), { recursive: true }), mkdir(scripts), mkdir(bin), mkdir(data)])
await writeFile(join(project, '.team/setup-state.json'), JSON.stringify({ room: 'fixture', server_url: base }) + '\n')
for (const script of ['change-seat.sh', 'change-effort.sh', 'leave-seat.sh']) {
  await cp(join(REPO, 'skill/scripts', script), join(scripts, script))
  await chmod(join(scripts, script), 0o755)
}
await writeFile(screen, 'idle\n')

await writeFile(join(bin, 'tmux'), `#!/bin/bash
case " $* " in
  *" has-session "*) [ -f "$SEAT_MISSING" ] && exit 1; exit 0 ;;
  *" kill-session "*) touch "$SEAT_MISSING"; exit 0 ;;
  *" list-sessions "*) exit 0 ;;
  *" capture-pane "*) cat "$FAKE_SCREEN"; exit 0 ;;
esac
exit 1
`)
// live catalog の面。claude は --help が effort 水準を列挙し、codex は debug models が
// model と effort の両方を持つ。**この harness は script 側へ水準表を持たせない**——
// hardcode へ落ちていれば、catalog を壊した時に素通りして落ちる。
await writeFile(join(bin, 'claude'), `#!/bin/bash
if [ "$1" = "--help" ]; then
  [ -n "\${CLAUDE_HELP_BROKEN:-}" ] && exit 1
  printf '%s\\n' '  --effort <level>                      Effort level for the current session'
  printf '%s\\n' '                                        (low, medium, high, xhigh, max)'
  exit 0
fi
exit 1
`)
await writeFile(join(bin, 'codex'), `#!/bin/bash
if [ "$1 $2" = "debug models" ]; then
  [ -n "\${CODEX_CATALOG_BROKEN:-}" ] && exit 1
  printf '%s\\n' '{"models":[{"slug":"gpt-5.6-sol","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"},{"effort":"ultra"}]},{"slug":"gpt-5.6-luna","supported_reasoning_levels":[{"effort":"high"},{"effort":"max"}]}]}'
  exit 0
fi
exit 1
`)
// 席の再起動は launch-seat.sh が担う。ここでは呼ばれ方（引数）と、席の素性がroomへ載ることだけを模す。
// FAIL_MODEL に書いた model での起動だけ失敗する＝「catalog上は正しいが live では起動しない model」。
await writeFile(join(scripts, 'launch-seat.sh'), `#!/bin/bash
printf '%s|%s|%s|%s|%s|%s\\n' "$1" "$2" "$3" "$4" "$5" "$6" >> "$LAUNCH_LOG"
if [ -f "$FAIL_MODEL" ] && [ "$3" = "$(cat "$FAIL_MODEL")" ]; then exit 9; fi
rm -f "$SEAT_MISSING"
vendor="$4"
effort="$5"
[ -n "\${STALE_VENDOR:-}" ] && vendor="\$STALE_VENDOR"
[ -n "\${STALE_META:-}" ] && effort="\$STALE_META"
payload=$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1],"vendor":sys.argv[2],"model":sys.argv[3],"effort":sys.argv[4]}))' "$2" "\$vendor" "$3" "\$effort")
curl -sf -o /dev/null -X POST "$PEERTABLE_URL/api/fixture/members" -H "X-Peertable-Token: ${token}" -H 'content-type: application/json' -d "$payload"
`)
await writeFile(credentialHelper, `#!/usr/bin/env node
const [action, ...args] = process.argv.slice(2)
if (action === 'path') process.stdout.write(args[0] + '/.team/fixture.token\\n')
else if (action === 'prepare') process.stdout.write(args[0] + '/.team/fixture.token\\n')
else if (action === 'remove') process.exit(0)
else if (action === 'request') {
  const response = await fetch(args[2], { method: args[1], headers: { 'content-type': 'application/json', 'X-Peertable-Token': ${JSON.stringify(token)} }, ...(args[3] ? { body: args[3] } : {}) })
  const responseBody = await response.text()
  if (!response.ok) process.exit(1)
  if (process.env.HISTORY_READBACK_BROKEN === '1' && args[1] === 'GET' && args[2].endsWith('/messages')) {
    const payload = JSON.parse(responseBody)
    const latest = payload.messages && payload.messages[payload.messages.length - 1]
    if (latest) latest.body = 'readback-mismatch'
    process.stdout.write(JSON.stringify(payload))
  } else {
    process.stdout.write(responseBody)
  }
} else process.exit(2)
`)
await Promise.all(['tmux', 'claude', 'codex'].map(name => chmod(join(bin, name), 0o755)))
await chmod(join(scripts, 'launch-seat.sh'), 0o755)

const server = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data, PEERTABLE_POST_TOKEN: token },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  PEERTABLE_POST_TOKEN: token,
  PEERTABLE_CREDENTIAL_HELPER: credentialHelper,
  PEERTABLE_URL: base,
  PEERTABLE_TMUX_SOCKET: join(root, 'tmux.sock'),
  FAKE_SCREEN: screen,
  LAUNCH_LOG: launchLog,
  FAIL_MODEL: failModel,
  SEAT_MISSING: join(root, 'seat-missing'),
}

const api = async (path, init) => {
  const res = await fetch(`${base}/api/fixture/${path}`, init)
  assert.ok(res.ok, `${path}: HTTP ${res.status}`)
  return res.json()
}
let ready = false
for (let i = 0; i < 50; i++) {
  try { await api('members'); ready = true; break } catch { await new Promise(r => setTimeout(r, 40)) }
}
assert.equal(ready, true, 'fixture room serverが起動する')

const member = body => api('members', {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-Peertable-Token': token },
  body: JSON.stringify({ name: 'koharu', observe: { tmux_socket: env.PEERTABLE_TMUX_SOCKET, tmux_target: 'peer-koharu' }, ...body }),
})
const seat = async () => (await api('members')).members.find(x => x.name === 'koharu')
const run = (args, extra = {}) => spawnSync(join(scripts, 'change-seat.sh'), [project, 'koharu', ...args], {
  env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000,
})
const runCompat = (effort) => spawnSync(join(scripts, 'change-effort.sh'), [project, 'koharu', effort, 'bell'], {
  env, encoding: 'utf8', timeout: 20_000,
})
const launchLines = async () => {
  try { return (await readFile(launchLog, 'utf8')).trim().split('\n').filter(Boolean) } catch { return [] }
}
const messages = async () => (await api('messages')).messages
let checks = 0
const check = (label, fn) => { fn(); checks += 1; console.log(`  ok: ${label}`) }

try {
  await member({ vendor: 'claude', model: 'opus', effort: 'high' })

  // 1. 自然文依頼: roomに依頼DMを一切置かないまま effort-only 変更が通る（旧exact DM検査の不在）
  let result = run(['--effort', 'max'])
  check('自然文依頼（依頼DMなし）で effort-only 変更が通る', () => {
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /SEAT_CHANGE_OK: koharu effort high → max/)
    assert.doesNotMatch(result.stderr, /REQUEST_REQUIRED/)
  })
  let lines = await launchLines()
  check('再起動は同じ vendor / model で1回だけ', () => {
    assert.equal(lines.length, 1)
    assert.match(lines[0], /\|koharu\|opus\|claude\|max\|/)
  })
  assert.equal((await seat()).effort, 'max', 'member metadata が effort=max を読み返せる')

  // 2. model-only 変更（effortは据え置き）
  result = run(['--model', 'sonnet'])
  check('model-only 変更が通り、effort は据え置かれる', () => {
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /SEAT_CHANGE_OK: koharu model opus → sonnet/)
    assert.doesNotMatch(result.stdout, /effort/)
  })
  lines = await launchLines()
  assert.match(lines.at(-1), /\|koharu\|sonnet\|claude\|max\|/)
  assert.equal((await seat()).model, 'sonnet')
  assert.equal((await seat()).effort, 'max')

  // 3. model + effort の同時変更
  result = run(['--model', 'opus', '--effort', 'high'])
  check('model と effort を同時に変更できる', () => {
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /model sonnet → opus \/ effort max → high/)
  })
  assert.equal((await seat()).model, 'opus')
  assert.equal((await seat()).effort, 'high')

  // 4. 同値 no-op: 席を止めない
  const beforeNoop = (await launchLines()).length
  result = run(['--model', 'opus', '--effort', 'high'])
  check('同値変更は no-op で席を再起動しない', () => {
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /SEAT_CHANGE_NOOP/)
  })
  assert.equal((await launchLines()).length, beforeNoop, 'no-op で launch が増えない')

  // 5. busy 席は停止しない
  await writeFile(screen, 'Working… esc to interrupt\n')
  result = run(['--effort', 'max'])
  check('busy 席は停止しない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_SEAT_BUSY/)
  })
  assert.equal((await launchLines()).length, beforeNoop)
  await writeFile(screen, 'idle\n')

  // 6. 未知vendorは席を触らずにtyped拒否する
  result = run(['--vendor', 'warp', '--model', 'gpt-5.6-luna', '--effort', 'max'])
  check('未知vendorは拒否される', () => {
    assert.equal(result.status, 2)
    assert.match(result.stderr, /SEAT_CHANGE_VENDOR_UNSUPPORTED/)
  })
  assert.equal((await launchLines()).length, beforeNoop)

  // 7. busy席はvendor交代でも停止しない
  await writeFile(screen, 'Working… esc to interrupt\n')
  const beforeVendorBusy = (await launchLines()).length
  result = run(['--vendor', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'max'])
  check('busy席はvendor交代でも停止しない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_SEAT_BUSY/)
  })
  assert.equal((await launchLines()).length, beforeVendorBusy)
  await writeFile(screen, 'idle\n')

  // 8. Claude→Codexの交代はtarget metadata・起動履歴・room履歴を一回で揃える
  const beforeVendorChange = (await launchLines()).length
  result = run(['--vendor', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'max', '--reason', 'Codex工程へ移管'])
  check('ClaudeからCodexへvendor交代できる', () => {
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /vendor claude → codex \/ model opus → gpt-5\.6-luna \/ effort high → max/)
  })
  lines = await launchLines()
  assert.equal(lines.length, beforeVendorChange + 1)
  assert.match(lines.at(-1), /\|koharu\|gpt-5\.6-luna\|codex\|max\|/)
  assert.equal((await seat()).vendor, 'codex')
  assert.equal((await seat()).model, 'gpt-5.6-luna')
  assert.equal((await seat()).effort, 'max')
  const vendorHistory = JSON.parse(spawnSync('curl', ['-sf', `${base}/api/fixture/messages`], { encoding: 'utf8' }).stdout).messages
    .filter(x => x.from === 'bell' && x.to === 'koharu' && x.body.startsWith('[席設定変更]'))
    .filter(x => x.body.includes('vendor claude → codex'))
  check('vendor交代履歴は一回だけ残る', () => {
    assert.equal(vendorHistory.length, 1)
    assert.match(vendorHistory[0].body, /理由: Codex工程へ移管/)
  })

  // 9. 新vendorの起動失敗は旧vendorへ一回だけ明示rollbackする
  await writeFile(failModel, 'fable')
  const beforeVendorRollback = (await launchLines()).length
  result = run(['--vendor', 'claude', '--model', 'fable', '--effort', 'high'])
  check('vendor交代の起動失敗は旧vendorへrollbackする', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_RESTART_FAILED/)
    assert.match(result.stderr, /SEAT_CHANGE_ROLLED_BACK/)
  })
  lines = await launchLines()
  assert.equal(lines.length, beforeVendorRollback + 2, 'vendor交代失敗1回 + 旧vendor rollback1回')
  assert.match(lines.at(-2), /\|koharu\|fable\|claude\|high\|/)
  assert.match(lines.at(-1), /\|koharu\|gpt-5\.6-luna\|codex\|max\|/)
  assert.equal((await seat()).vendor, 'codex', 'rollback後は旧vendor')
  assert.equal((await seat()).model, 'gpt-5.6-luna')
  assert.equal((await seat()).effort, 'max')
  await rm(failModel, { force: true })
  await member({ vendor: 'claude', model: 'opus', effort: 'high' })

  // 10. 引数不足（--model も --effort も無い）は席を触らない
  const beforePostVendorChecks = (await launchLines()).length
  result = run([])
  check('--model / --effort が無ければ席を触らずに落ちる', () => {
    assert.equal(result.status, 2)
    assert.match(result.stderr, /SEAT_CHANGE_ARGS_INVALID/)
  })
  assert.equal((await launchLines()).length, beforePostVendorChecks)

  // 8. claude の effort は live な --help から取る（hardcodeへ落ちない）
  result = run(['--effort', 'ultra'])
  check('claude の live catalog に無い effort は拒否される', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_EFFORT_UNSUPPORTED: claude/)
    assert.match(result.stderr, /live: low medium high xhigh max/)
  })
  result = run(['--effort', 'xhigh'], { CLAUDE_HELP_BROKEN: '1' })
  check('catalog を読めない時は hardcode へ落ちずに止まる', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_EFFORT_CATALOG_UNAVAILABLE/)
  })
  assert.equal((await launchLines()).length, beforePostVendorChecks, 'catalog不明で席を再起動しない')

  // 9. live で起動しない model は、起動失敗→旧設定へ1回だけ rollback（fable-5 と同じ形）
  await writeFile(failModel, 'fable')
  const beforeRollback = (await launchLines()).length
  result = run(['--model', 'fable'])
  check('起動しない model は旧設定へ1回だけ rollback される', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_RESTART_FAILED/)
    assert.match(result.stderr, /SEAT_CHANGE_ROLLED_BACK/)
  })
  lines = await launchLines()
  assert.equal(lines.length, beforeRollback + 2, '失敗1回 + rollback1回だけ')
  assert.match(lines.at(-2), /\|koharu\|fable\|claude\|high\|/)
  assert.match(lines.at(-1), /\|koharu\|opus\|claude\|high\|/)
  assert.equal((await seat()).model, 'opus', 'rollback 後は旧 model')
  assert.equal((await seat()).effort, 'high')

  // 10. rollback も失敗したら黙らない
  await writeFile(failModel, 'opus')
  await member({ vendor: 'claude', model: 'opus', effort: 'high' })
  result = run(['--model', 'opus', '--effort', 'low'])
  check('rollback 失敗を握りつぶさない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_ROLLBACK_FAILED/)
  })
  assert.equal(await seat(), undefined, 'rollback失敗後に旧memberを生存扱いしない')
  await rm(failModel, { force: true })

  // 11. metadata の読み返しが target と食い違えば成功にしない
  await member({ vendor: 'claude', model: 'opus', effort: 'high' })
  await rm(join(root, 'seat-missing'), { force: true })
  result = run(['--effort', 'low'], { STALE_META: 'high' })
  check('metadata が target と違えば成功扱いにしない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_CHANGED_BUT_UNVERIFIED/)
  })

  // 12. metadata の vendor が target と食い違っても成功にしない
  await member({ vendor: 'claude', model: 'opus', effort: 'high' })
  result = run(['--vendor', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'max'], { STALE_VENDOR: 'claude' })
  check('vendor metadata が target と違えば成功扱いにしない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_CHANGED_BUT_UNVERIFIED/)
    assert.match(result.stderr, /vendor=codex/)
  })
  assert.equal((await seat()).vendor, 'claude', '不一致metadataは履歴確定前に検出する')

  // 13. room 履歴が残る
  await member({ vendor: 'claude', model: 'opus', effort: 'high' })
  result = run(['--effort', 'low', '--reason', '判断が軽い工程へ移ったため'])
  assert.equal(result.status, 0, result.stderr)
  const history = (await messages()).filter(x => x.from === 'bell' && x.to === 'koharu' && x.body.startsWith('[席設定変更]'))
  const changed = history.at(-1)
  check('room 履歴に変更と理由が残る', () => {
    assert.ok(changed)
    assert.match(changed.body, /effort high → low/)
    assert.match(changed.body, /理由: 判断が軽い工程へ移ったため/)
  })

  // 14. room履歴の読返し不一致は、履歴が存在していても成功扱いにしない
  await member({ vendor: 'claude', model: 'opus', effort: 'high' })
  result = run(['--effort', 'max'], { HISTORY_READBACK_BROKEN: '1' })
  check('room履歴の読返し不一致を成功扱いにしない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_CHANGED_BUT_HISTORY_FAILED/)
    assert.match(result.stderr, /読返しがtargetと一致しない/)
  })
  assert.equal((await seat()).effort, 'max', '履歴読返し不一致でも実席の変更自体は維持される')

  // 15. codex 席は catalog が model / effort の両方を検証する
  await member({ vendor: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
  result = run(['--model', 'gpt-5.6-luna', '--effort', 'max'])
  check('codex の model + effort 同時変更が catalog 検証を通る', () => {
    assert.equal(result.status, 0, result.stderr)
    assert.match((`${result.stdout}`), /model gpt-5\.6-sol → gpt-5\.6-luna \/ effort high → max/)
  })
  assert.match((await launchLines()).at(-1), /\|gpt-5\.6-luna\|codex\|max\|/)
  result = run(['--effort', 'ultra'])
  check('catalog が提供しない effort は codex でも拒否される', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_EFFORT_UNSUPPORTED: codex\/gpt-5\.6-luna/)
  })
  result = run(['--model', 'gpt-9-unknown'])
  check('catalog に無い model は codex で拒否される', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_MODEL_UNSUPPORTED/)
  })
  result = run(['--effort', 'high'], { CODEX_CATALOG_BROKEN: '1' })
  check('codex catalog を読めない時は席を触らずに止まる', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_MODEL_CATALOG_UNAVAILABLE/)
  })

  // 15. 席が居なければ何もしない
  await writeFile(join(root, 'seat-missing'), 'yes\n')
  result = run(['--effort', 'high'])
  check('席が無ければ SEAT_CHANGE_SEAT_MISSING で止まる', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SEAT_CHANGE_SEAT_MISSING/)
  })
  await rm(join(root, 'seat-missing'), { force: true })

  // 16. 互換入口（配布済み change-effort.sh）が DM 無しで動く
  await member({ vendor: 'claude', model: 'opus', effort: 'high' })
  const beforeCompat = (await launchLines()).length
  const compat = runCompat('max')
  check('互換入口 change-effort.sh が依頼DMなしで通る', () => {
    assert.equal(compat.status, 0, compat.stderr)
    assert.match(compat.stdout, /SEAT_CHANGE_OK: koharu effort high → max/)
  })
  assert.equal((await launchLines()).length, beforeCompat + 1)
  assert.equal((await seat()).effort, 'max')

  // 17. 配布面: diagnostics が両入口の梱包漏れを検出する
  const clientSource = await readFile(join(REPO, 'room/client.mjs'), 'utf8')
  check('diagnostics が change-seat.sh / change-effort.sh を必須にする', () => {
    assert.match(clientSource, /'scripts\/change-seat\.sh'/)
    assert.match(clientSource, /'scripts\/change-effort\.sh'/)
  })
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  check('npm files が skill/ 配下を梱包する', () => {
    assert.ok(pkg.files.includes('skill/'))
  })

  console.log(`seat-change repro: ${checks}/${checks} green`)
} finally {
  server.kill('SIGTERM')
  await new Promise(done => server.once('exit', done))
  await rm(root, { recursive: true, force: true })
}
