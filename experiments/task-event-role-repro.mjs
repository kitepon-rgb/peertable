#!/usr/bin/env node
// a4: task eventを受けた生成roleが、ackを返さず自律ループへ戻る契約を測る。
// setup.shで実際に生成した lattice member / standalone member / parent の三roleを
// templateと突合し、started/completedの受信規律が生成物へ届くことを確認する。
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const ROOT = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url))
const SETUP = join(ROOT, 'skill', 'scripts', 'setup.sh')
const SEAT_BRIDGE = join(ROOT, 'skill', 'scripts', 'seat-status-bridge.mjs')

const run = (command, args, options = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  child.on('error', reject)
  child.on('close', code => resolveRun({ code, stdout, stderr }))
})

const makeGitProject = async project => {
  await mkdir(project, { recursive: true })
  await run('git', ['init', '-q'], { cwd: project })
  await run('git', ['config', 'user.email', 'a4-fixture@example.test'], { cwd: project })
  await run('git', ['config', 'user.name', 'a4 fixture'], { cwd: project })
  await writeFile(join(project, 'README.md'), '# a4 fixture\n')
  await run('git', ['add', 'README.md'], { cwd: project })
  await run('git', ['commit', '-q', '-m', 'fixture'], { cwd: project })
}

const work = await mkdtemp(join(tmpdir(), 'peertable-task-event-role-'))
const latticeProject = join(work, 'lattice-project')
const standaloneProject = join(work, 'standalone-project')
const fakeLattice = join(work, 'lattice')
const tasks = join(work, 'tasks.md')
const fixtureHome = join(work, 'home')
const fixtureSocket = join(work, 'tmux.sock')
await mkdir(fixtureHome, { recursive: true })
await writeFile(fakeLattice, '#!/bin/sh\nexit 0\n')
await chmod(fakeLattice, 0o755)
await writeFile(tasks, '- a4 fixture task\n')
await makeGitProject(latticeProject)
await makeGitProject(standaloneProject)

const fixtureEnv = {
  HOME: fixtureHome,
  LATTICE_CLI: fakeLattice,
  PEERTABLE_POST_TOKEN: '',
  PEERTABLE_TMUX_SOCKET: fixtureSocket,
}

const stopBridge = async project => {
  try {
    await readFile(join(project, '.team', 'seat-status-bridge.json'))
  } catch {
    return
  }
  await run(process.execPath, [SEAT_BRIDGE, project, '--stop'], { env: fixtureEnv })
}

let ok = true
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

try {
  const latticeSetup = await run('bash', [SETUP, latticeProject, 'a4-lattice', 'http://127.0.0.1:9', 'fixture-plan', ROOT], { env: fixtureEnv })
  check('Lattice併用modeのrole生成が成功する', latticeSetup.code === 0, latticeSetup.stderr.trim().slice(-300))

  const standaloneSetup = await run('bash', [SETUP, standaloneProject, 'a4-standalone', 'http://127.0.0.1:9', '-', ROOT, tasks], { env: fixtureEnv })
  check('単独modeのrole生成が成功する', standaloneSetup.code === 0, standaloneSetup.stderr.trim().slice(-300))

  const memberTemplate = await readFile(join(ROOT, 'skill', 'templates', 'member.md'), 'utf8')
  const standaloneTemplate = await readFile(join(ROOT, 'skill', 'templates', 'member-standalone.md'), 'utf8')
  const parentTemplate = await readFile(join(ROOT, 'skill', 'templates', 'parent.md'), 'utf8')
  const generatedLatticeMember = await readFile(join(latticeProject, '.team', 'roles', 'member.md'), 'utf8')
  const generatedStandaloneMember = await readFile(join(standaloneProject, '.team', 'roles', 'member.md'), 'utf8')
  const generatedParent = await readFile(join(latticeProject, '.team', 'roles', 'parent.md'), 'utf8')
  const scope = 'この卓の claim 範囲は plan 全体（phase 指定なしで立っている）。'
  const expectedLatticeMember = memberTemplate
    .replaceAll('{{PLAN_KEY}}', 'fixture-plan')
    .replaceAll('{{CLAIM_SCOPE}}', scope)
  check('生成Lattice memberがtemplateと一致する', generatedLatticeMember === expectedLatticeMember)
  check('生成standalone memberがtemplateと一致する', generatedStandaloneMember === standaloneTemplate)
  check('生成parentがtemplateと一致する', generatedParent === parentTemplate)

  const members = [generatedLatticeMember, generatedStandaloneMember]
  for (const [index, role] of members.entries()) {
    const label = index === 0 ? 'Lattice member' : 'standalone member'
    check(`${label}がstarted受信後の状態再読を明記`, role.includes('`started` を受けたら') && role.includes('読み直す'))
    check(`${label}がcompleted後にready/監査候補を探す`, role.includes('`completed` を受けたら') && role.includes('新しく開いた ready') && role.includes('監査候補'))
    check(`${label}がack/追認返信を禁止`, role.includes('「了解」「受け取った」「追認」') && role.includes('定型返信を room へ投稿しない'))
    check(`${label}がイベントtaskの横取りを禁止`, role.includes('イベントの task を自動的に横取り・再 claim しない'))
    check(`${label}が自律探索順へ戻る`, role.includes('active → ready → 文脈近接 peer audit → 待機'))
  }
  check('parentがstartedでは観測だけに留まる', generatedParent.includes('`started` では観測だけを行う') && generatedParent.includes('工程管理へ降りず'))
  check('parentがstartedで配車・不足監査をしない', generatedParent.includes('作業の配車') && generatedParent.includes('peer audit の不足補充'))
  check('parentがcompleted後だけ黙って照合する', generatedParent.includes('`completed` でだけ') && generatedParent.includes('黙った照合'))
  check('parentがeventへのack/追認を返さない', generatedParent.includes('「了解」「追認」などを返さず'))
} finally {
  await stopBridge(latticeProject)
  await stopBridge(standaloneProject)
  await rm(work, { recursive: true, force: true })
}

console.log(ok ? 'task event role repro: green' : 'task event role repro: RED')
process.exit(ok ? 0 : 1)
