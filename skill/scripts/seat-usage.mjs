const TOKEN_HINT = /[↓↑]\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmM]?)\s*tokens\b/gu

const TOKEN_MULTIPLIER = Object.freeze({
  '': 1,
  k: 1_000,
  m: 1_000_000,
})

export function supportsMemberObservation(payload) {
  return payload?.capabilities?.member_observation_v1 === true
}

/**
 * launch-seat.sh:14 と同じ解決規則で aiterm-mcp の tmux ソケットを決める。
 * 規則を二重に書かない——片方だけ直すと同じ穴がもう一度開く。
 */
export function resolveTmuxSocket(env) {
  return env.PEERTABLE_TMUX_SOCKET || `${env.TMPDIR}claude-tmux-sockets/claude.sock`
}

/**
 * tmux セッションが見つからない席の扱いを決める。**tmux 席を持たない member（親など）は
 * 一度も観測できない**ので `null`（送らない）。**過去に観測できていた席が消えたら実際に落ちた**
 * ので `dead` を返す。previous は直前に送信できた観測（`{status,...}` か undefined）。
 */
export function deriveMissingSession(previous) {
  return previous ? { status: 'dead', busySince: null, paneTokenHint: null } : null
}

// launch-seat.sh:74-77 と docs/plan.md §11 が実測で記録した既知ダイアログ文言の集合
export const BLOCKED_MARKERS = [
  '1. Yes, I trust this folder',
  '1. I am using this for local development',
  '1. Yes, continue',
  'Do you want to proceed?',
]

/**
 * pane 末尾の生文字列から画面状態を判定する。判定順は busy → blocked → idle
 * （承認プロンプト表示中は `esc to interrupt` が消えるので busy を先に見る）。
 */
export function classifyPaneTail(tail) {
  if (typeof tail !== 'string') return 'idle'
  if (tail.includes('esc to interrupt')) return 'busy'
  if (BLOCKED_MARKERS.some(marker => tail.includes(marker))) return 'blocked'
  return 'idle'
}

/**
 * paneのstatus行が公開しているtoken値だけを読む。
 * vendor固有のログや課金単価は推測せず、表示が無い席はnullのままにする。
 */
export function parsePaneTokenHint(pane) {
  if (typeof pane !== 'string') return null
  let latest = null
  for (const match of pane.matchAll(TOKEN_HINT)) {
    const multiplier = TOKEN_MULTIPLIER[match[2].toLowerCase()]
    const value = Math.round(Number(match[1]) * multiplier)
    if (Number.isSafeInteger(value) && value >= 0) latest = value
  }
  return latest
}
