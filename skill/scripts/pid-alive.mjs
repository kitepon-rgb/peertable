#!/usr/bin/env node
// Windows Git Bash の kill -0 は Win32 pid を見ない。Node の process.kill は見る。
const pid = Number(process.argv[2])
if (!Number.isInteger(pid) || pid <= 0) process.exit(2)
try {
  process.kill(pid, 0)
  process.exit(0)
} catch {
  process.exit(1)
}
