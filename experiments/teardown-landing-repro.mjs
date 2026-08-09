#!/usr/bin/env node
// teardownが、close済みだが未着地・未pushの実Lattice runをexit 0のまま表示する回帰検査。
//
// usage: node experiments/teardown-landing-repro.mjs [<Lattice repo>] [<teardown.sh>|--head-teardown]
// 既定はsiblingの../Latticeと現行teardown。`--head-teardown`は作業開始時HEADの補修前版を
// 使い、landing reportを出せず負のコントロールとして落ちる。本番room・本番projectは触らない。
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
let teardown = path.resolve(teardownArgument ?? path.join(ROOT, 'skill', 'scripts', 'teardown.sh'))
const latticeCli = path.join(latticeRepo, 'bin', 'lattice.mjs')
const sourceRun = path.join(latticeRepo, '.lattice', 'runs', 't7-accept-7')

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
  if (teardownArgument === '--head-teardown') {
    const oldScripts = path.join(temporaryRoot, 'skill', 'scripts')
    await cp(path.join(ROOT, 'skill', 'scripts'), oldScripts, { recursive: true })
    teardown = path.join(oldScripts, 'teardown.sh')
    const before = spawnSync('git', ['show', 'HEAD:skill/scripts/teardown.sh'], {
      cwd: ROOT, encoding: 'utf8',
    })
    assert.equal(before.status, 0, before.stderr)
    await writeFile(teardown, before.stdout, { mode: 0o700 })
  }
  await mkdir(project, { recursive: true })
  const alternateObjects = path.join(latticeRepo, '.git', 'objects')
  const env = { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects }
  git(['init', '--quiet', '--initial-branch=main'], project, env)

  const request = JSON.parse(await readFile(path.join(sourceRun, 'request.json'), 'utf8'))
  const baseSha = request.repo.base_sha
  // 保存runのreceipt HEADは後からorigin/mainへ着地済みなので、使い捨てremoteだけを
  // その親へ戻し「close済み・まだpushしていない当時」の境界を再現する。
  const remoteBaseSha = git(['rev-parse', `${baseSha}^`], latticeRepo, process.env)
  const currentHead = git(['rev-parse', 'HEAD'], latticeRepo, process.env)
  git(['update-ref', 'refs/heads/main', currentHead], project, env)
  git(['init', '--bare', '--quiet', remote], temporaryRoot, env)
  git(['remote', 'add', 'origin', remote], project, env)
  git(['push', '--quiet', 'origin', `${remoteBaseSha}:refs/heads/main`], project, env)
  git(['update-ref', 'refs/remotes/origin/main', remoteBaseSha], project, env)
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], project, env)
  git(['config', 'branch.main.remote', 'origin'], project, env)
  git(['config', 'branch.main.merge', 'refs/heads/main'], project, env)
  git(['config', 'remote.pushDefault', 'origin'], project, env)

  const copiedRun = path.join(project, '.lattice', 'runs', 't7-accept-7')
  await mkdir(path.dirname(copiedRun), { recursive: true })
  await cp(sourceRun, copiedRun, { recursive: true })

  const baseline = spawnSync(latticeCli, ['run', 'landing', '--run', path.join('.lattice', 'runs', 't7-accept-7')], {
    cwd: project, env, encoding: 'utf8',
  })
  assert.equal(baseline.status, 0, baseline.stderr)
  const baselineReport = JSON.parse(baseline.stdout)
  assert.equal(baselineReport.landed, false, 'fixtureは未着地でなければならない')
  assert.ok(baselineReport.repository.unpushed_commits > 0, 'fixtureは未push commitを持つこと')

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
      LATTICE_CLI: latticeCli,
      PEERTABLE_TMUX_SOCKET: path.join(temporaryRoot, 'missing-tmux.sock'),
    },
  })
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const output = `${result.stdout}\n${result.stderr}`
  const match = output.match(/run landing (\{[^\n]+\})/u)
  assert.ok(match, `teardownがlanding reportを出していない\n${output}`)
  const report = JSON.parse(match[1])
  assert.equal(report.landed, false)
  assert.equal(report.repository.unpushed_commits, baselineReport.repository.unpushed_commits)
  assert.ok(output.indexOf('run-bridge 停止') < output.indexOf('run landing {'),
    'landingはrun-bridge停止後でなければならない')
  assert.ok(output.indexOf('run landing {') < output.indexOf('.lattice/runtime/ 撤去'),
    'landingはruntime撤去前でなければならない')
  assert.equal(await readFile(path.join(copiedRun, 'events.json'), 'utf8'),
    await readFile(path.join(sourceRun, 'events.json'), 'utf8'), 'landingはrun storeを書き換えない')

  process.stdout.write(`OK teardown landing: landed=false unpushed_commits=${report.repository.unpushed_commits} exit=0\n`)
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(temporaryRoot, { recursive: true, force: true })
}
