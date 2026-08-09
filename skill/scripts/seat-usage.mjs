const TOKEN_HINT = /[↓↑]\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmM]?)\s*tokens\b/gu

const TOKEN_MULTIPLIER = Object.freeze({
  '': 1,
  k: 1_000,
  m: 1_000_000,
})

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
