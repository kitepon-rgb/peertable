#!/usr/bin/env node
// teardown.sh の `run list` 解釈が、**CLI の失敗を「active run なし」へ化かさない**ことを測る。
//
// usage: node experiments/teardown-run-list-parser-repro.mjs [--lattice <path/to/lattice.mjs> --project <dir>]
//   `--lattice` と `--project` を両方渡した時だけ、実 CLI を使った正側（⑤）も走る。
//
// **parser を写経しない。** `skill/scripts/teardown.sh` から**その場で抜き出して**叩くので、
// 製品側を直せば repro が自動で追従し、**別実装を測ってしまう**ことが起きない
// （akari の懸念）。同時に、証跡の文章では再実行できないという問題も消える（mio の懸念）。
//
// 抜き出しに失敗したら**空を測って green にしない**——marker が変わったら loud に落ちる。
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const teardown = resolve(here, '..', 'skill', 'scripts', 'teardown.sh')

const OPEN = `elif ! run_refs=$(printf '%s' "$run_list_json" | python3 -c '`
const CLOSE = `' 2>&1); then`

function extractParser() {
  const source = readFileSync(teardown, 'utf8')
  const at = source.indexOf(OPEN)
  if (at < 0) {
    throw new Error(`REPRO_MARKER_MISSING: teardown.sh から parser の開始 marker を見つけられない。`
      + `**この repro は製品の parser を抜き出して測る**ので、marker が変わったら空を測るのではなく落ちる。`
      + `teardown.sh 側の該当行を見て marker を直すこと`)
  }
  const from = at + OPEN.length
  const to = source.indexOf(CLOSE, from)
  if (to < 0) throw new Error('REPRO_MARKER_MISSING: parser の終端 marker が見つからない')
  // shell の単引用符内なので `\"` で書かれている。python へ渡す前に戻す
  const body = source.slice(from, to).replaceAll('\\"', '"')
  if (body.trim().length === 0) throw new Error('REPRO_PARSER_EMPTY: 抜き出した parser が空')
  return body
}

const dir = mkdtempSync(join(tmpdir(), 'teardown-parser-'))
const parserPath = join(dir, 'parser.py')
writeFileSync(parserPath, extractParser())

// python の rc と stdout/stderr を素で取る。**pipeline を挟まない**——
// この repro が測りたいのは「rc がどちらのものか」なので、測る側が同じ罠を踏んではいけない
function runParser(input) {
  try {
    const stdout = execFileSync('python3', [parserPath], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { rc: 0, stdout, stderr: '' }
  } catch (error) {
    return { rc: error.status ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'OK' : 'NG'} ${label} — ${detail}`)
}

// ---- 負側4つ: どれも「active run なし」へ化けてはいけない ----
const negatives = [
  ['① CLI の typed error JSON', '{"schema":"lattice.cli_error.v2","code":"INVALID_RUN_STORE"}'],
  ['② JSON でない出力', 'ERROR: lattice CLI が落ちた'],
  ['③ 別 schema', '{"schema":"lattice.other.v1","active_runs":[]}'],
  ['④ active_runs が配列でない', '{"schema":"lattice.run_list.v1","active_runs":null}'],
]
for (const [label, input] of negatives) {
  const { rc, stdout, stderr } = runParser(input)
  const silentEmpty = rc === 0 && stdout.trim().length === 0
  check(label, rc !== 0 && !silentEmpty,
    silentEmpty ? '**空を返して rc=0**（active run なしへ化けた）' : `rc=${rc} ${stderr.trim().split('\n')[0] ?? ''}`)
}

// ---- 正側: 実 CLI の出力を通す（引数が揃った時だけ） ----
const argv = process.argv.slice(2)
const latticeAt = argv.indexOf('--lattice')
const projectAt = argv.indexOf('--project')
if (latticeAt >= 0 && projectAt >= 0) {
  const cli = argv[latticeAt + 1]
  const project = argv[projectAt + 1]
  let listed
  try {
    listed = execFileSync(process.execPath, [cli, 'run', 'list', '--json'],
      { cwd: project, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    check('⑤ 実 CLI の正側', false, `run list が失敗した: ${String(error.stderr ?? error.message).split('\n')[0]}`)
    listed = null
  }
  if (listed !== null) {
    const { rc, stdout, stderr } = runParser(listed)
    const refs = stdout.split('\n').filter(Boolean)
    check('⑤ 実 CLI の正側', rc === 0 && refs.every(ref => ref.startsWith('.lattice/runs/')),
      rc === 0 ? `rc=0 / ${refs.length} 件抽出` : `rc=${rc} ${stderr.trim().split('\n')[0] ?? ''}`)
  }
} else {
  console.log('-- ⑤ 実 CLI の正側は飛ばした（--lattice と --project を両方渡すと走る）')
}

rmSync(dir, { recursive: true, force: true })
const failed = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} green`)
process.exit(failed.length === 0 ? 0 : 1)
