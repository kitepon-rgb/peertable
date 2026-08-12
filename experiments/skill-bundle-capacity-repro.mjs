#!/usr/bin/env node
// h9/k1 skill bundle の配布契約を、現行greenと欠損negativeの両方で測る。
// 欠損時にdiagnosticsがgreenへ丸められないことと、fixtureの作業ディレクトリを残さないことを固定する。
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(REPO, '.tmp-skill-bundle-capacity-'))
const client = join(root, 'room', 'client.mjs')
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'pass' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}
const diagnostics = () => spawnSync(process.execPath, [client, 'diagnostics', '--json'], {
  cwd: root,
  encoding: 'utf8',
})
const parse = result => {
  try { return JSON.parse(result.stdout.trim()) } catch { return null }
}

let rootGone = false
try {
  await mkdir(join(root, 'room'), { recursive: true })
  await cp(join(REPO, 'room', 'client.mjs'), client)
  await cp(join(REPO, 'room', 'server.mjs'), join(root, 'room', 'server.mjs'))
  await cp(join(REPO, 'package.json'), join(root, 'package.json'))
  await cp(join(REPO, 'skill'), join(root, 'skill'), { recursive: true })

  const present = diagnostics()
  const presentJson = parse(present)
  check('h9 capacity 2本を含むskill_bundleがgreen', present.status === 0
    && presentJson?.checks?.skill_bundle === 'pass'
    && presentJson?.overall === 'ready', present.stdout.trim() || present.stderr.trim())

  await rm(join(root, 'skill', 'scripts', 'capacity-advisor.mjs'))
  await rm(join(root, 'skill', 'scripts', 'capacity-bridge.mjs'))
  const missing = diagnostics()
  const missingJson = parse(missing)
  check('capacity 2本の欠損negativeが非zeroになる', missing.status !== 0, missing.stdout.trim() || missing.stderr.trim())
  check('欠損negativeがskill_bundle failを返す', missingJson?.checks?.skill_bundle === 'fail'
    && missingJson?.overall !== 'ready', missing.stdout.trim() || missing.stderr.trim())
} catch (error) {
  console.error(`HARNESS ERROR: ${error.stack ?? error.message}`)
  good = false
} finally {
  await rm(root, { recursive: true, force: true })
  rootGone = !existsSync(root)
}

check('skill bundle fixtureの残骸がゼロ', rootGone)
console.log(good ? 'skill bundle capacity repro: green' : 'skill bundle capacity repro: RED')
process.exit(good ? 0 : 1)
