#!/usr/bin/env node
// teardown の room URL 表示が、room 名を shell 変数名へ誤吸収しないことを測る。
// 既定は現行 script の ASCII / 日本語 room smoke。--without-boundary は旧式
// `$url/$room）` へ戻した変異を実行し、byte 完全な URL assertion が落ちることを確認する。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEARDOWN = path.join(ROOT, 'skill', 'scripts', 'teardown.sh')
const mutation = process.argv.includes('--without-boundary')
const rooms = process.argv.includes('--ascii-only') ? ['ascii-room'] : ['ascii-room', '卓-あ']

function run(command, args, options) {
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

async function makeFixture(room) {
  const root = await mkdtemp(path.join(tmpdir(), 'peertable-teardown-room-url-'))
  const project = path.join(root, 'project')
  const fakeLattice = path.join(root, 'lattice')
  await mkdir(path.join(project, '.team'), { recursive: true })
  await mkdir(path.join(project, '.git', 'info'), { recursive: true })
  await writeFile(path.join(project, '.git', 'info', 'exclude'), '')
  await writeFile(fakeLattice, `#!/bin/sh
if [ "$1" = run ] && [ "$2" = list ] && [ "$3" = --json ]; then
  printf '%s\\n' '{"schema":"lattice.run_list.v1","active_runs":[]}'
fi
`)
  await chmod(fakeLattice, 0o700)

  const state = {
    room,
    server_url: '',
    added_exclude: false,
    lattice_preexisting: true,
    runtime_preexisting: true,
    added_runtime_exclude: false,
    work_order_adapter: false,
    work_order_spool_ref: '',
    added_root_mcp: false,
    added_mcp_exclude: false,
    external_pane: false,
    project_json_preexisting: false,
  }
  let memberDeleted = 0
  let roomDeleted = 0
  let messagePosts = 0
  const server = createServer((request, response) => {
    const requestPath = new URL(request.url, 'http://fixture.invalid').pathname
    if (request.method === 'GET' && requestPath.endsWith('/messages')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ messages: [{
        seq: 1,
        from: 'fixture',
        to: 'tsubaki',
        body: 'URL boundary fixture',
        ts: '2026-08-11T00:00:00.000Z',
      }] }))
      return
    }
    if (request.method === 'GET' && requestPath.endsWith('/members')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ members: [{ name: 'fixture-seat' }] }))
      return
    }
    if (request.method === 'POST' && requestPath.endsWith('/messages')) {
      messagePosts += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    if (request.method === 'DELETE' && requestPath.includes('/members/')) {
      memberDeleted += 1
      response.writeHead(200)
      response.end()
      return
    }
    if (request.method === 'DELETE' && requestPath === `/api/${room}`) {
      roomDeleted += 1
      response.writeHead(200)
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  state.server_url = `http://127.0.0.1:${port}`
  await writeFile(path.join(project, '.team', 'setup-state.json'), `${JSON.stringify(state)}\n`)
  return {
    root,
    project,
    fakeLattice,
    server,
    state,
    get memberDeleted() { return memberDeleted },
    get roomDeleted() { return roomDeleted },
    get messagePosts() { return messagePosts },
  }
}

let teardown = TEARDOWN
let mutationRoot
if (mutation) {
  mutationRoot = await mkdtemp(path.join(tmpdir(), 'peertable-teardown-room-url-mutant-'))
  const mutationScripts = path.join(mutationRoot, 'skill', 'scripts')
  await cp(path.join(ROOT, 'skill', 'scripts'), mutationScripts, { recursive: true })
  teardown = path.join(mutationScripts, 'teardown.sh')
  const source = await readFile(teardown, 'utf8')
  const mutant = source.replace('（${url}/${room}）', '（$url/$room）')
  assert.notEqual(mutant, source, 'URL境界の変異を作れない')
  await writeFile(teardown, mutant, { mode: 0o700 })
}

try {
  for (const room of rooms) {
    const fixture = await makeFixture(room)
    try {
      const result = await run('bash', [teardown, fixture.project, '--archive'], {
        cwd: ROOT,
        env: {
          ...process.env,
          LATTICE_CLI: fixture.fakeLattice,
          PEERTABLE_POST_TOKEN: 'teardown-room-url-token',
        },
      })
      const output = `${result.stdout}\n${result.stderr}`
      const expected = `teardown: [実施] メンバー登録の解除（1名）— **部屋と過去ログは残す**（${fixture.state.server_url}/${room}）`
      assert.equal(result.code, 0, output)
      assert.ok(Buffer.from(output, 'utf8').includes(Buffer.from(expected, 'utf8')),
        `byte完全なroom URLが出ない: ${JSON.stringify(output)}`)
      assert.equal(fixture.memberDeleted, 1, 'member解除が1回実施されること')
      assert.equal(fixture.roomDeleted, 0, 'archive modeでroom原本を削除しないこと')
      assert.equal(fixture.messagePosts, 1,
        `解散の区切りをroomへ1回投稿すること: ${output}`)
      const archiveDir = path.join(fixture.project, 'docs', 'archive')
      const archives = await readdir(archiveDir)
      assert.equal(archives.length, 1, 'roomログの控えが1件書かれること')
      const archive = await readFile(path.join(archiveDir, archives[0]), 'utf8')
      assert.ok(archive.includes('room `' + room + '`'), 'room原本の控えが残ること')
      console.log(`  pass  ${room} のURL表示・member解除・archive保持`)
    } finally {
      await fixture.server.close()
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
  console.log(mutation ? 'teardown room URL repro: unexpected green' : 'teardown room URL repro: green')
  process.exit(mutation ? 1 : 0)
} catch (error) {
  console.error(mutation ? 'teardown room URL repro: mutant caught' : 'teardown room URL repro: RED')
  console.error(error.stack || error)
  process.exit(mutation ? 1 : 1)
} finally {
  if (mutationRoot) await rm(mutationRoot, { recursive: true, force: true })
}
