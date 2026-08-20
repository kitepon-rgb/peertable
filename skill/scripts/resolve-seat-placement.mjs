#!/usr/bin/env node
// 02_models.md の役割→1位〜3位から、着席可能な vendor / model / effort を解決する。
// 具体モデル名はここに持たない。台帳と順位表をその場で読む。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const EFFORT = /×\s*(none|low|medium|high|xhigh|max|ultra)/iu
const vendorOf = (modelName) => {
  const name = String(modelName).trim()
  if (/^claude\b/iu.test(name)) return 'claude'
  if (/^gpt\b|^gpt-/iu.test(name)) return 'codex'
  if (/^grok\b/iu.test(name)) return 'grok'
  return null
}

const fail = (code, message) => {
  process.stderr.write(`${code}: ${message}\n`)
  process.exit(2)
}

export function findModelsDoc({ env = process.env, exists = existsSync, scriptDir = here } = {}) {
  if (env.PEERTABLE_MODELS_DOC) return resolve(env.PEERTABLE_MODELS_DOC)
  if (env.DOTAGENTS_ROOT) return join(resolve(env.DOTAGENTS_ROOT), 'docs/02_models.md')
  const sibling = resolve(scriptDir, '../../../dotagents/docs/02_models.md')
  if (exists(sibling)) return sibling
  return null
}

const stripCell = (cell) => String(cell ?? '').replace(/\*\*/g, '').trim()

const parseMarkdownTable = (block) => {
  const lines = block.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|'))
  if (lines.length < 3) return []
  const headers = lines[0].split('|').slice(1, -1).map((cell) => stripCell(cell))
  return lines.slice(2).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => stripCell(cell))
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
  })
}

const section = (markdown, heading) => {
  const start = markdown.indexOf(`## ${heading}`)
  if (start < 0) return ''
  const rest = markdown.slice(start)
  const next = rest.search(/\n## /)
  return next < 0 ? rest : rest.slice(0, next)
}

const slugOf = (cell) => {
  const alias = cell.match(/alias\s+`([^`]+)`/u)
  if (alias) return alias[1]
  const slug = cell.match(/`([^`]+)`/u)
  return slug ? slug[1] : null
}

export function parseLedger(markdown) {
  const rows = parseMarkdownTable(section(markdown, 'モデル台帳'))
  return rows.flatMap((row) => {
    const name = row['モデル']
    const slug = slugOf(row['slug'] ?? '')
    const vendor = vendorOf(name)
    if (!name || !slug || !vendor) return []
    return [{ name, slug, vendor }]
  })
}

const parseCell = (cell) => {
  const raw = stripCell(cell)
  if (!raw || raw === '—' || raw === '-') return null
  if (raw.includes('オーナー指定')) return { skip: 'owner-pin', cell: raw }
  if (/^ChatGPT/iu.test(raw) || raw.includes('gpt-connector')) return { skip: 'not-a-seat', cell: raw }
  const effortMatch = raw.match(EFFORT)
  const modelKey = raw.split('×')[0]
    .replace(/（[^）]*）/gu, '')
    .replace(/\([^)]*\)/gu, '')
    .trim()
  if (!modelKey) return { skip: 'unparseable', cell: raw }
  return {
    modelKey,
    effort: effortMatch ? effortMatch[1].toLowerCase() : null,
    cell: raw,
  }
}

const matchLedger = (modelKey, ledger) => {
  const key = modelKey.toLowerCase()
  const exact = ledger.find((row) => row.name.toLowerCase() === key)
  if (exact) return exact
  const contained = ledger.filter((row) => row.name.toLowerCase().includes(key) || key.includes(row.name.toLowerCase()))
  if (contained.length === 1) return contained[0]
  const token = ledger.filter((row) => row.name.toLowerCase().split(/\s+/u).includes(key))
  if (token.length === 1) return token[0]
  return null
}

export function resolveSeatPlacement(role, markdown, { source = '' } = {}) {
  const wanted = String(role ?? '').trim()
  if (!wanted) {
    return { error: 'SEAT_ROLE_REQUIRED', message: 'role が空（02_models の役割名が要る）' }
  }
  const ranks = parseMarkdownTable(section(markdown, '順位表（役割→1位〜3位）'))
  const row = ranks.find((item) => item['役割'] === wanted)
  if (!row) {
    const known = ranks.map((item) => item['役割']).filter(Boolean)
    return { error: 'SEAT_ROLE_UNKNOWN', message: `未知の役割: ${wanted}（${known.join(' / ')}）` }
  }
  const ledger = parseLedger(markdown)
  const dropped = []
  for (const rank of [1, 2, 3]) {
    const parsed = parseCell(row[`${rank}位`])
    if (!parsed) continue
    if (parsed.skip) {
      dropped.push({ rank, reason: parsed.skip, cell: parsed.cell })
      continue
    }
    const hit = matchLedger(parsed.modelKey, ledger)
    if (!hit) {
      dropped.push({ rank, reason: 'not-in-ledger', cell: parsed.cell })
      continue
    }
    if (hit.slug === 'haiku') {
      return { role: wanted, rank, vendor: hit.vendor, model: hit.slug, effort: '', source, dropped }
    }
    if (!parsed.effort) {
      dropped.push({ rank, reason: 'effort-missing', cell: parsed.cell })
      continue
    }
    return {
      role: wanted,
      rank,
      vendor: hit.vendor,
      model: hit.slug,
      effort: parsed.effort,
      source,
      dropped,
    }
  }
  return {
    error: 'SEAT_PLACEMENT_UNRESOLVABLE',
    message: `${wanted} を着席可能な vendor/model/effort へ解決できない`,
    dropped,
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const role = process.argv[2]
  const doc = findModelsDoc()
  if (!doc) {
    fail('SEAT_MODELS_DOC_MISSING', '02_models.md が見つからない（PEERTABLE_MODELS_DOC または DOTAGENTS_ROOT を渡す）')
  }
  if (!existsSync(doc)) {
    fail('SEAT_MODELS_DOC_MISSING', `02_models.md が無い: ${doc}`)
  }
  const result = resolveSeatPlacement(role, readFileSync(doc, 'utf8'), { source: doc })
  if (result.error) fail(result.error, result.message)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
