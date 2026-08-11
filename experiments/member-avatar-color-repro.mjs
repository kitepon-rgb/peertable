#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../room/server.mjs', import.meta.url), 'utf8')
const start = source.indexOf('const AVATAR_PALETTE=')
const end = source.indexOf('const initial=', start)
assert.ok(start >= 0 && end > start, 'avatar color helper must be present in the Web UI script')

const helper = source.slice(start, end)
const { AVATAR_PALETTE, avatarColor, avatarAssignments, chooseAvatarIndex, hueDistance, syncAvatarAssignments } =
  runInNewContext(`${helper};({AVATAR_PALETTE,avatarColor,avatarAssignments,chooseAvatarIndex,hueDistance,syncAvatarAssignments})`)

assert.equal(AVATAR_PALETTE.length, 8, 'the high-distance palette must have eight fixed colors')
assert.ok(AVATAR_PALETTE.every(color => color.bg && color.fg), 'each avatar color must define a readable background/foreground pair')
assert.match(source, /background:var\(--av-bg,hsl\(var\(--h\) var\(--sat\) var\(--lum\)\)\)/, 'avatar CSS must retain a readable fallback')
assert.match(source, /syncAvatarAssignments\(r\.members\.map\(m=>m\.name\)\)/, 'member refresh must synchronize the active name set')
assert.match(source, /await refreshMembers\(\)\n    let added=0\n    for\(const m of r\.messages\)/, 'catch-up must assign member colors before rendering messages')
assert.doesNotMatch(source, /hue\(m\.(?:name|from)\)/, 'old direct name-hash color assignment must be gone')

const legacyHue = name => {
  let h = 5381
  for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}
const legacyCandidates = Array.from({ length: 40 }, (_, i) => `seat-${i}`)
let legacyPair = null
for (const left of legacyCandidates) {
  for (const right of legacyCandidates) {
    if (left >= right) continue
    if (hueDistance(legacyHue(left), legacyHue(right)) <= 12) legacyPair = [left, right]
  }
}
assert.ok(legacyPair, 'fixture must contain a close-color pair for the old hash mapping')

const names = [...legacyPair, ...legacyCandidates.filter(name => !legacyPair.includes(name)).slice(0, 4)]
syncAvatarAssignments(names)
const first = new Map(names.map(name => [name, avatarColor(name)]))
const newDistances = []
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) newDistances.push(hueDistance(first.get(names[i]).h, first.get(names[j]).h))
}
assert.ok(Math.min(...newDistances) >= 45, 'active members must receive visibly separated palette hues')

const stableBefore = names.map(name => [name, first.get(name).h])
syncAvatarAssignments([...names].reverse())
const stableAfter = names.map(name => [name, avatarColor(name).h])
assert.deepEqual(stableAfter, stableBefore, 'refresh/order changes must preserve member color assignments')

const used = new Set(names.slice(0, 3).map(name => first.get(name).h))
const usedIndexes = new Set(names.slice(0, 3).map(name => AVATAR_PALETTE.findIndex(color => color.h === first.get(name).h)))
const selectedIndex = chooseAvatarIndex('new-seat', usedIndexes)
const selectedDistance = usedIndexes.size
  ? Math.min(...[...usedIndexes].map(index => hueDistance(AVATAR_PALETTE[selectedIndex].h, AVATAR_PALETTE[index].h)))
  : 360
const bestDistance = Math.max(...AVATAR_PALETTE.map(color => usedIndexes.size
  ? Math.min(...[...usedIndexes].map(index => hueDistance(color.h, AVATAR_PALETTE[index].h)))
  : 360))
assert.equal(selectedDistance, bestDistance, 'new members must receive the farthest available palette color')

syncAvatarAssignments(Array.from({ length: AVATAR_PALETTE.length + 2 }, (_, i) => `many-${i}`))
const manyColors = Array.from(avatarAssignments.values())
assert.equal(new Set(manyColors.slice(0, AVATAR_PALETTE.length)).size, AVATAR_PALETTE.length, 'palette colors must be unique before exhaustion')
assert.ok(manyColors.slice(AVATAR_PALETTE.length).some(index => manyColors.slice(0, AVATAR_PALETTE.length).includes(index)), 'palette exhaustion must reuse a color')

console.log('member avatar color repro: green')
