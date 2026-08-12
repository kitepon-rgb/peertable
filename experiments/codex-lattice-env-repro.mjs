// Codex席から起動したaiterm MCPへ、Lattice用の非秘密envが届く契約を測る。
//
// 欠陥版は席自身のshellへ6値を入れるだけで、CodexのclosedなMCP子processへ
// session-level env_varsを渡さない。修正版はaitermだけへ6名を明示し、room MCPの
// closed envやcredential値を広げない。
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname)
const LAUNCH_SOURCE = await readFile(join(REPO, 'skill/scripts/launch-seat.sh'), 'utf8')
const INJECTED_ENV = [
  'PEERTABLE_MEMBER',
  'PEERTABLE_PLAN',
  'LATTICE_CLI',
  'LATTICE_TODO_ACTOR_HOST',
  'LATTICE_TODO_ACTOR_SESSION',
  'LATTICE_TODO_ACTOR_AGENT',
]
const injectionBlock = `    if [ "$mode" = lattice ]; then
      cmd="$cmd -c 'mcp_servers.aiterm.env_vars=[\\"PEERTABLE_MEMBER\\",\\"PEERTABLE_PLAN\\",\\"LATTICE_CLI\\",\\"LATTICE_TODO_ACTOR_HOST\\",\\"LATTICE_TODO_ACTOR_SESSION\\",\\"LATTICE_TODO_ACTOR_AGENT\\"]'"
    fi`
assert.ok(LAUNCH_SOURCE.includes(injectionBlock), 'aiterm env_varsの実装契約が見つかる')

const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
const root = await mkdtemp(join(tmpdir(), 'peertable-codex-lattice-env-'))
const project = join(root, 'project')
const bin = join(root, 'bin')
const tmuxSocket = join(root, 'tmux.sock')
const tmuxLog = join(root, 'tmux.log')
const paneLog = join(root, 'pane.log')
const codexArgs = join(root, 'codex-args')
const codexInvoked = join(root, 'codex-invoked')
const codexEnv = join(root, 'codex-env')
const childEnv = join(root, 'aiterm-child-env')
const memberState = join(root, 'member-state')
const credentialHelper = join(root, 'seat-credential.mjs')
const credentialFile = join(project, '.team', 'credentials', 'fixture.token')
const credentialSentinel = 'J1_SECRET_MUST_NOT_REACH_CODEX_ARGS'
const fixedLaunch = join(root, 'launch-seat-fixed.sh')
const legacyLaunch = join(root, 'launch-seat-legacy.sh')
const name = 'fixture-seat'
const plan = 'peertable-codex-lattice-env-fx5-20260811'
const latticeCli = join(bin, 'lattice')

const envValue = {
  PEERTABLE_MEMBER: name,
  PEERTABLE_PLAN: plan,
  LATTICE_CLI: latticeCli,
  LATTICE_TODO_ACTOR_HOST: 'mac',
  LATTICE_TODO_ACTOR_SESSION: name,
  LATTICE_TODO_ACTOR_AGENT: name,
}

await mkdir(join(project, '.team', 'seats'), { recursive: true })
await mkdir(bin)
await writeFile(join(root, '.zshrc'), `export PATH=${bin}:$PATH\n`)
await writeFile(join(project, '.team/setup-state.json'), JSON.stringify({
  room: 'fixture',
  server_url: 'http://127.0.0.1:1',
  mode: 'lattice',
  plan_key: plan,
}) + '\n')
await writeFile(join(root, 'tmux-socket.mjs'),
  'process.stdout.write(process.env.PEERTABLE_TMUX_SOCKET || "")\n')
await writeFile(join(root, 'ensure-bridge.sh'), '#!/bin/bash\nexit 0\n')
await chmod(join(root, 'ensure-bridge.sh'), 0o755)
await writeFile(credentialHelper, `#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const [action, ...args] = process.argv.slice(2)
if (action === 'prepare') {
  const project = args[0]
  const path = ${JSON.stringify(credentialFile)}
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, ${JSON.stringify(credentialSentinel + '\n')}, { mode: 0o600 })
  process.stdout.write(path + '\\n')
} else if (action === 'remove') {
  rmSync(args[1], { force: true })
} else if (action === 'request') {
  process.stdout.write('{}')
} else {
  process.exit(2)
}
`)
await chmod(credentialHelper, 0o755)

await writeFile(join(bin, 'tmux'), `#!/bin/bash
real_tmux=${JSON.stringify(realTmux)}
printf '%s\\n' "$*" >> "$TMUX_LOG"
if [[ "$*" == *capture-pane* ]]; then
  pane=$($real_tmux "$@")
  printf '%s\\n---\\n' "$pane" >> "$PANE_LOG"
  printf '%s\\n' "$pane"
  exit 0
fi
exec "$real_tmux" "$@"
`)
await writeFile(join(bin, 'curl'), `#!/bin/bash
if [ -f "$MEMBER_STATE" ]; then
  printf '%s\\n' '{"members":[{"name":"fixture-seat","model":"gpt-5.6-luna","observe":{"tmux_target":"peer-fixture-seat"}}]}'
else
  printf '%s\\n' '{"members":[]}'
fi
`)
await writeFile(join(bin, 'codex'), `#!/bin/bash
 : > "$CODEX_INVOKED"
if [ "$1" = exec ]; then
  exit 0
fi
printf '%s\\n' "$*" > "$CODEX_ARGS"
for variable in ${INJECTED_ENV.join(' ')}; do
  printf '%s=%s\\n' "$variable" "\${!variable-}" >> "$CODEX_ENV"
done
if [[ "$*" == *"mcp_servers.aiterm.env_vars="* ]]; then
  for variable in ${INJECTED_ENV.join(' ')}; do
    printf '%s=%s\\n' "$variable" "\${!variable-}" >> "$CHILD_ENV"
  done
fi
: > "$MEMBER_STATE"
printf 'OpenAI Codex (v0.147.0)\\n'
while :; do sleep 1; done
`)
await Promise.all(['tmux', 'curl', 'codex'].map((file) => chmod(join(bin, file), 0o755)))

await writeFile(fixedLaunch, LAUNCH_SOURCE)
await chmod(fixedLaunch, 0o755)
await writeFile(legacyLaunch, LAUNCH_SOURCE.replace(injectionBlock, ''))
await chmod(legacyLaunch, 0o755)

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  PEERTABLE_CREDENTIAL_HELPER: credentialHelper,
  LATTICE_CLI: latticeCli,
  PEERTABLE_TMUX_SOCKET: tmuxSocket,
  TMUX_LOG: tmuxLog,
  PANE_LOG: paneLog,
  CODEX_ARGS: codexArgs,
  CODEX_INVOKED: codexInvoked,
  CODEX_ENV: codexEnv,
  CHILD_ENV: childEnv,
  MEMBER_STATE: memberState,
  TMPDIR: root,
  HOME: root,
  ZDOTDIR: root,
  NODE_DISABLE_COMPILE_CACHE: '1',
}
for (const variable of [
  'PEERTABLE_MEMBER',
  'PEERTABLE_PLAN',
  'LATTICE_TODO_ACTOR_HOST',
  'LATTICE_TODO_ACTOR_SESSION',
  'LATTICE_TODO_ACTOR_AGENT',
]) delete env[variable]

const clearFixture = async () => {
  spawnSync(realTmux, ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' })
  await Promise.all([
    rm(tmuxLog, { force: true }),
    rm(paneLog, { force: true }),
    rm(codexArgs, { force: true }),
    rm(codexInvoked, { force: true }),
    rm(codexEnv, { force: true }),
    rm(childEnv, { force: true }),
    rm(memberState, { force: true }),
    rm(credentialFile, { force: true }),
    rm(join(project, '.team/seats', `${name}.json`), { force: true }),
  ])
}

const run = (script) => spawnSync(script,
  [project, name, 'gpt-5.6-luna', 'codex', 'high'],
  { env, encoding: 'utf8', timeout: 30_000 })

let checks = 0
const check = (label, fn) => {
  fn()
  checks += 1
  console.log(`  ok: ${label}`)
}

try {
  await clearFixture()
  const legacy = run(legacyLaunch)
  const legacyArgs = existsSync(codexArgs) ? readFileSync(codexArgs, 'utf8') : ''
  const legacyLog = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : ''
  const legacyPane = existsSync(paneLog) ? readFileSync(paneLog, 'utf8') : ''
  check('欠陥版はCodexを起動するがaiterm env_varsを配らない', () => {
    assert.equal(legacy.status, 0,
      legacy.stderr + '\nstdout=' + legacy.stdout + '\nerror=' + (legacy.error?.message ?? '')
      + '\nargs=' + legacyArgs + '\ninvoked=' + existsSync(codexInvoked)
      + '\nlog=' + legacyLog + '\npane=' + legacyPane)
    assert.doesNotMatch(legacyArgs, /mcp_servers\.aiterm\.env_vars=/u)
    assert.equal(existsSync(childEnv), false)
  })
  check('欠陥版でもroom MCPへLattice actorを混ぜない', () => {
    assert.match(legacyArgs, /mcp_servers\.room\.env=/u)
    assert.doesNotMatch(legacyArgs, /mcp_servers\.room\.env=.*PEERTABLE_PLAN/u)
    assert.doesNotMatch(legacyArgs, /mcp_servers\.room\.env=.*LATTICE_TODO_ACTOR/u)
  })
  await clearFixture()

  const fixed = run(fixedLaunch)
  const fixedArgs = existsSync(codexArgs) ? readFileSync(codexArgs, 'utf8') : ''
  const fixedEnv = existsSync(codexEnv) ? readFileSync(codexEnv, 'utf8') : ''
  const forwardedEnv = existsSync(childEnv) ? readFileSync(childEnv, 'utf8') : ''
  check('修正版はCodex起動引数へaitermの非秘密6変数名を渡す', () => {
    assert.equal(fixed.status, 0,
      fixed.stderr + '\nstdout=' + fixed.stdout + '\nargs=' + fixedArgs)
    const expected = `mcp_servers.aiterm.env_vars=[${INJECTED_ENV.map((name) => `"${name}"`).join(',')}]`
    assert.match(fixedArgs, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
  check('修正版は席shellの6値をaiterm子processへforwardする', () => {
    for (const [key, value] of Object.entries(envValue)) {
      assert.match(fixedEnv, new RegExp(`^${key}=${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mu'))
      assert.match(forwardedEnv, new RegExp(`^${key}=${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mu'))
    }
  })
  check('credential値はCodex引数・env配達へ出ない', () => {
    const observed = [fixedArgs, fixedEnv, forwardedEnv].join('\n')
    assert.doesNotMatch(observed, new RegExp(credentialSentinel))
  })
  check('Lattice fallbackはstateのCLI値を維持する', () => {
    assert.match(fixedEnv, new RegExp(`^LATTICE_CLI=${latticeCli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mu'))
  })
  console.log(`codex-lattice-env repro: ${checks}/${checks} green`)
} finally {
  spawnSync(realTmux, ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' })
  await rm(root, { recursive: true, force: true })
}
