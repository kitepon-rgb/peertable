#!/usr/bin/env node
// todo-extraction-from-plan.mjs が親shellの手入力envへ依存せず、Peertable setup stateから
// Lattice CLIを解決することのfocused repro。
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repoRoot, 'skill/scripts/todo-extraction-from-plan.mjs')
let latticeCli = process.env.LATTICE_CLI
if (!latticeCli) {
  try {
    const realState = JSON.parse(await readFile(join(repoRoot, '.team/setup-state.json'), 'utf8'))
    latticeCli = realState.lattice_cli
  } catch {}
}
if (!latticeCli) latticeCli = execFileSync('sh', ['-c', 'command -v lattice'], { encoding: 'utf8' }).trim()
if (!latticeCli) throw new Error('fixtureに使う lattice CLIを解決できない')

const fixture = await mkdtemp(join(tmpdir(), 'peertable-todo-extraction-'))
const plan = join(fixture, 'docs/plan_fixture.md')
const state = join(fixture, '.team/setup-state.json')
const output = join(fixture, 'extraction.json')

const run = (command, args, env = process.env) => spawnSync(command, args, {
  cwd: fixture,
  encoding: 'utf8',
  env,
})
const envWithoutCli = { ...process.env }
delete envWithoutCli.LATTICE_CLI
const check = (condition, label, detail = '') => {
  if (!condition) {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
    process.exitCode = 1
  } else {
    console.log(`  pass  ${label}`)
  }
}

try {
  await mkdir(dirname(plan), { recursive: true })
  await mkdir(dirname(state), { recursive: true })
  await writeFile(plan, '# Fixture campaign\n\n## Tasks\n\n### z1 setup-state resolution\n\n親shellのenvなしで抽出する。\n')
  await writeFile(state, `${JSON.stringify({ mode: 'lattice', lattice_cli: latticeCli })}\n`)
  run('git', ['init', '-q'])
  run('git', ['config', 'user.email', 'fixture@example.invalid'])
  run('git', ['config', 'user.name', 'fixture'])
  run('git', ['add', 'docs/plan_fixture.md'])
  run('git', ['commit', '-qm', 'fixture plan'])

  const success = run(process.execPath, [script, plan, 'fixture-plan', '--project', 'fixture', '--agent', 'nagi', '--out', output], envWithoutCli)
  check(success.status === 0, 'LATTICE_CLI未設定でもsetup-stateから抽出できる', success.stderr)
  if (success.status === 0) {
    const extraction = JSON.parse(await readFile(output, 'utf8'))
    check(extraction.tasks.length === 1 && extraction.tasks[0].task_id === 'z1', 'task見出しと本文を抽出する')
    check(extraction.extraction_digest !== '0'.repeat(64), 'Lattice本体でdigestを生成する')
  }

  await unlink(state)
  const missing = run(process.execPath, [script, plan, 'missing-state', '--project', 'fixture', '--agent', 'nagi', '--out', output], envWithoutCli)
  check(missing.status !== 0 && missing.stderr.includes('LATTICE_CLI_UNRESOLVED:'), 'stateもenvも無い時はtyped診断で停止する', missing.stderr)
  check(missing.stderr.includes('.team/setup-state.json') && missing.stderr.includes('next:'), 'typed診断が正規設定入口を示す')

  await writeFile(state, '{broken json\n')
  const malformed = run(process.execPath, [script, plan, 'malformed-state', '--project', 'fixture', '--agent', 'nagi', '--out', output], envWithoutCli)
  check(malformed.status !== 0 && malformed.stderr.includes('PEERTABLE_SETUP_STATE_INVALID:'), '壊れたsetup-stateはtyped診断で停止する', malformed.stderr)

  await writeFile(state, `${JSON.stringify({ mode: 'lattice' })}\n`)
  const missingKey = run(process.execPath, [script, plan, 'missing-cli-key', '--project', 'fixture', '--agent', 'nagi', '--out', output], envWithoutCli)
  check(missingKey.status !== 0 && missingKey.stderr.includes('LATTICE_CLI_UNRESOLVED:'), 'lattice_cli欠落はtyped診断で停止する', missingKey.stderr)

  await writeFile(state, `${JSON.stringify({ mode: 'lattice', lattice_cli: join(fixture, 'missing-lattice') })}\n`)
  const invalid = run(process.execPath, [script, plan, 'invalid-cli', '--project', 'fixture', '--agent', 'nagi', '--out', output], envWithoutCli)
  check(invalid.status !== 0 && invalid.stderr.includes('LATTICE_CLI_INVALID:'), 'stateのCLIが無効ならtyped診断で停止する', invalid.stderr)

  await unlink(state)
  const explicit = run(process.execPath, [script, plan, 'explicit-env', '--project', 'fixture', '--agent', 'nagi', '--out', output], { ...envWithoutCli, LATTICE_CLI: latticeCli })
  check(explicit.status === 0, '明示LATTICE_CLIの互換入口も維持する', explicit.stderr)
} finally {
  await rm(fixture, { recursive: true, force: true })
}

if (process.exitCode) process.exit(process.exitCode)
console.log('todo extraction from plan repro: green')
