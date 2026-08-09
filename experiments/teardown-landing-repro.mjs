#!/usr/bin/env node
// done/teardownが、push済みだが未着地の実Lattice runをexit 0のままreceipt単位で表示する回帰検査。
//
// usage: node experiments/teardown-landing-repro.mjs [<Lattice repo>]
//        [<teardown.sh>|--without-landing|--failing-cli|--unusable-cli]
// 既定はsiblingの../Latticeと現行teardown。`--without-landing`は現行scriptからlanding段だけを
// 明示除去したdurableな欠陥版を作り、landing report欠落で落ちる。旧名`--head-teardown`も同義。
// CLIの非0終了・実行不能も別modeでloud failureを検証する。本番room・本番projectは触らない。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const latticeRepo = path.resolve(process.argv[2] ?? path.join(ROOT, '..', 'Lattice'))
const teardownArgument = process.argv[3]
const mode = teardownArgument?.startsWith('--') ? teardownArgument : 'normal'
let teardown = path.resolve(mode === 'normal'
  ? (teardownArgument ?? path.join(ROOT, 'skill', 'scripts', 'teardown.sh'))
  : path.join(ROOT, 'skill', 'scripts', 'teardown.sh'))
const latticeCli = path.join(latticeRepo, 'bin', 'lattice.mjs')
const doneTemplate = path.join(ROOT, 'skill', 'templates', 'done.sh')
let teardownLatticeCli = latticeCli
const sourceRun = path.join(latticeRepo, '.lattice', 'runs', 't19-live-1')
const runId = path.basename(sourceRun)
const runRef = path.join('.lattice', 'runs', runId)

function git(args, cwd, env) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`)
  return result.stdout.trim()
}

function runAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'peertable-teardown-landing-'))
const project = path.join(temporaryRoot, 'project')
const remote = path.join(temporaryRoot, 'remote.git')
let server

try {
  if (mode === '--without-landing' || mode === '--head-teardown') {
    const brokenScripts = path.join(temporaryRoot, 'skill', 'scripts')
    await cp(path.join(ROOT, 'skill', 'scripts'), brokenScripts, { recursive: true })
    teardown = path.join(brokenScripts, 'teardown.sh')
    const source = await readFile(teardown, 'utf8')
    const startMarker = '# run の close は成果が既定branchへ着地した証拠ではない。'
    const endMarker = '# setupが新しく作ったhost固有runtimeだけを撤去する。'
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker)
    assert.ok(start >= 0 && end > start, 'landing段を除去するmarkerが見つからない')
    const broken = source.slice(0, start) + source.slice(end)
    assert.doesNotMatch(broken, /run landing/u, '欠陥版からlanding段を除去できていない')
    await writeFile(teardown, broken, { mode: 0o700 })
  } else if (mode === '--failing-cli') {
    teardownLatticeCli = path.join(temporaryRoot, 'failing-lattice')
    const activeList = JSON.stringify({
      schema: 'lattice.run_list.v1',
      active_runs: [{ run_id: runId, run_ref: runRef, selection: 'pull', plan_key: 'roundtable-closeout' }],
    })
    await writeFile(teardownLatticeCli, `#!/bin/sh
if [ "$1" = run ] && [ "$2" = list ] && [ "$3" = --json ]; then
  printf '%s\\n' '${activeList}'
  exit 0
fi
echo FORCED_LANDING_FAILURE >&2
exit 17
`, { mode: 0o700 })
  } else if (mode === '--unusable-cli') {
    teardownLatticeCli = path.join(temporaryRoot, 'unusable-lattice')
    await writeFile(teardownLatticeCli, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
  } else if (mode !== 'normal') {
    assert.fail(`未知のmode: ${mode}`)
  }
  await mkdir(project, { recursive: true })
  const alternateObjects = path.join(latticeRepo, '.git', 'objects')
  const env = { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects }
  git(['init', '--quiet', '--initial-branch=main'], project, env)

  const currentHead = git(['rev-parse', 'HEAD'], latticeRepo, process.env)
  git(['update-ref', 'refs/heads/main', currentHead], project, env)
  git(['init', '--bare', '--quiet', remote], temporaryRoot, env)
  git(['remote', 'add', 'origin', remote], project, env)
  git(['push', '--quiet', 'origin', `${currentHead}:refs/heads/main`], project, env)
  git(['push', '--quiet', 'origin', `${currentHead}:refs/heads/work`], project, env)
  git(['update-ref', 'refs/remotes/origin/main', currentHead], project, env)
  git(['update-ref', 'refs/remotes/origin/work', currentHead], project, env)
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], project, env)
  git(['config', 'branch.main.remote', 'origin'], project, env)
  git(['config', 'branch.main.merge', 'refs/heads/work'], project, env)
  git(['config', 'remote.pushDefault', 'origin'], project, env)
  git(['config', 'push.default', 'upstream'], project, env)

  const copiedRun = path.join(project, runRef)
  await mkdir(path.dirname(copiedRun), { recursive: true })
  await cp(sourceRun, copiedRun, { recursive: true })

  // 保存runは再現証拠としてclose済み。teardownが使う公開run listだけをwrapperでactiveとして返し、
  // landing本体は実Lattice CLI・実run storeへそのまま委譲する。
  if (mode === 'normal' || mode === '--without-landing' || mode === '--head-teardown') {
    const listedCli = path.join(temporaryRoot, 'listed-lattice')
    const activeList = JSON.stringify({
      schema: 'lattice.run_list.v1',
      active_runs: [{ run_id: runId, run_ref: runRef, selection: 'pull', plan_key: 'roundtable-closeout' }],
    })
    await writeFile(listedCli, `#!/bin/sh
if [ "$1" = run ] && [ "$2" = list ] && [ "$3" = --json ]; then
  printf '%s\\n' '${activeList}'
  exit 0
fi
exec '${latticeCli}' "$@"
`, { mode: 0o700 })
    teardownLatticeCli = listedCli
  }

  const baseline = spawnSync(latticeCli, ['run', 'landing', '--run', runRef], {
    cwd: project, env, encoding: 'utf8',
  })
  assert.equal(baseline.status, 0, baseline.stderr)
  const baselineReport = JSON.parse(baseline.stdout)
  assert.equal(baselineReport.landed, false, 'fixtureは未着地でなければならない')
  assert.equal(baselineReport.repository.unpushed_commits, 0,
    'fixtureはpush済みだがreceipt未着地の2軸分離を再現すること')
  const expectedUnlanded = baselineReport.accepted_receipts.filter(receipt => !receipt.landed).length
  assert.ok(expectedUnlanded > 0, 'fixtureは未着地receiptを持つこと')

  if (mode === 'normal') {
    const landingOnly = spawnSync('bash', [doneTemplate, '--landing-run', runRef], {
      cwd: project, env: { ...env, LATTICE_CLI: latticeCli }, encoding: 'utf8',
    })
    assert.equal(landingOnly.status, 0, landingOnly.stderr)
    assert.match(`${landingOnly.stdout}\n${landingOnly.stderr}`,
      new RegExp(`未着地 ${expectedUnlanded}本`, 'u'))

    git(['config', '--unset', 'branch.main.remote'], project, env)
    git(['config', '--unset', 'branch.main.merge'], project, env)
    git(['config', '--unset', 'remote.pushDefault'], project, env)
    const noUpstream = spawnSync('bash', [doneTemplate, '--landing-run', runRef], {
      cwd: project, env: { ...env, LATTICE_CLI: latticeCli }, encoding: 'utf8',
    })
    assert.equal(noUpstream.status, 0, `upstream未設定でlanding-onlyが壊れた\n${noUpstream.stderr}`)
    assert.match(`${noUpstream.stdout}\n${noUpstream.stderr}`,
      new RegExp(`未着地 ${expectedUnlanded}本`, 'u'))
    git(['config', 'branch.main.remote', 'origin'], project, env)
    git(['config', 'branch.main.merge', 'refs/heads/work'], project, env)
    git(['config', 'remote.pushDefault', 'origin'], project, env)

    const receiptHeads = baselineReport.accepted_receipts.map(receipt => receipt.head_sha)
    const tree = git(['rev-parse', `${currentHead}^{tree}`], project, env)
    const landedHead = git(['commit-tree', tree, '-p', currentHead,
      ...receiptHeads.flatMap(head => ['-p', head])], project, {
      ...env,
      GIT_AUTHOR_NAME: 'Peertable landing repro',
      GIT_AUTHOR_EMAIL: 'landing-repro@example.invalid',
      GIT_COMMITTER_NAME: 'Peertable landing repro',
      GIT_COMMITTER_EMAIL: 'landing-repro@example.invalid',
    })
    git(['update-ref', 'refs/remotes/origin/main', landedHead], project, env)
    const green = spawnSync('bash', [doneTemplate, '--landing-run', runRef], {
      cwd: project, env: { ...env, LATTICE_CLI: latticeCli }, encoding: 'utf8',
    })
    assert.equal(green.status, 0, green.stderr)
    assert.doesNotMatch(`${green.stdout}\n${green.stderr}`, /未着地/u,
      'pushとreceipt着地が両方greenなら警告してはならない')
    git(['update-ref', 'refs/remotes/origin/main', currentHead], project, env)
  }

  const token = 'landing-repro-token'
  server = createServer((request_, response) => {
    if (request_.method === 'GET' && request_.url === '/api/landing-repro/members') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ members: [{ name: 'landing-repro-seat' }] }))
      return
    }
    if (request_.method === 'DELETE' && request_.url === '/api/landing-repro') {
      response.writeHead(request_.headers['x-peertable-token'] === token ? 200 : 403)
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port

  const team = path.join(project, '.team')
  const spoolRef = path.join('.lattice', 'runtime', 'work-order-adapter', 'spool')
  const orders = path.join(project, spoolRef, 'orders')
  await mkdir(team, { recursive: true })
  await mkdir(orders, { recursive: true })
  await writeFile(path.join(team, 'setup-state.json'), `${JSON.stringify({
    room: 'landing-repro',
    server_url: `http://127.0.0.1:${port}`,
    added_exclude: true,
    lattice_preexisting: true,
    runtime_preexisting: false,
    added_runtime_exclude: true,
    added_root_mcp: true,
    added_mcp_exclude: true,
    external_pane: false,
    project_json_preexisting: false,
    work_order_adapter: true,
    work_order_spool_ref: spoolRef,
  })}\n`)
  await writeFile(path.join(team, 'run-bridge.json'), '{"pid":99999999}\n')
  await writeFile(path.join(project, '.mcp.json'), '{}\n')
  await appendFile(path.join(project, '.git', 'info', 'exclude'),
    '.team/\n/.mcp.json\n/.lattice/runtime/\n')
  await writeFile(path.join(orders, 'order.json'), `${JSON.stringify({
    worktree_path: path.join(copiedRun, 'worktrees', 'landing-repro'),
  })}\n`)

  const result = await runAsync('bash', [teardown, project, '--purge'], {
    cwd: ROOT,
    env: {
      ...env,
      PEERTABLE_POST_TOKEN: token,
      LATTICE_CLI: teardownLatticeCli,
      PEERTABLE_TMUX_SOCKET: path.join(temporaryRoot, 'missing-tmux.sock'),
    },
  })
  const output = `${result.stdout}\n${result.stderr}`
  if (mode === '--failing-cli') {
    assert.notEqual(result.code, 0, 'landing CLIの非0終了をteardownが成功へ丸めた')
    assert.ok(output.includes(`[未実施] run landing ${runRef} — FORCED_LANDING_FAILURE`), output)
    process.stdout.write(`OK failing landing CLI: teardown exit=${result.code}\n`)
  } else if (mode === '--unusable-cli') {
    assert.notEqual(result.code, 0, '実行不能なLATTICE_CLIをteardownが成功へ丸めた')
    assert.match(output,
      /\[未実施\] run landing — LATTICE_CLIが実行可能fileを指さず、着地状態を読めない:/u)
    process.stdout.write(`OK unusable landing CLI: teardown exit=${result.code}\n`)
  } else {
    assert.equal(result.code, 0, output)
    const match = output.match(/run landing (\{[^\n]+\})/u)
    assert.ok(match, `teardownがlanding reportを出していない\n${output}`)
    const report = JSON.parse(match[1])
    assert.equal(report.landed, false)
    assert.equal(report.repository.unpushed_commits, baselineReport.repository.unpushed_commits)
    assert.match(output, new RegExp(`未着地 ${expectedUnlanded}本`, 'u'))
    assert.ok(output.indexOf('run-bridge 停止') < output.indexOf('run landing {'),
      'landingはrun-bridge停止後でなければならない')
    assert.ok(output.indexOf('run landing {') < output.indexOf('.lattice/runtime/ 撤去'),
      'landingはruntime撤去前でなければならない')
    assert.equal(await readFile(path.join(copiedRun, 'events.json'), 'utf8'),
      await readFile(path.join(sourceRun, 'events.json'), 'utf8'), 'landingはrun storeを書き換えない')

    process.stdout.write(`OK done/teardown landing: unlanded=${expectedUnlanded} unpushed_commits=${report.repository.unpushed_commits} exit=0\n`)
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(temporaryRoot, { recursive: true, force: true })
}
