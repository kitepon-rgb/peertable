#!/bin/bash
set -euo pipefail
# 実tmuxを使うが、専用socketだけを作り、終了時に必ず畳む。
root=$(mktemp -d); sock="$root/t.sock"
trap 'tmux -S "$sock" kill-server 2>/dev/null || true; rm -rf "$root"' EXIT
tmux -S "$sock" new-session -d -s probe 'sleep 30'
tmux -S "$sock" has-session -t probe
echo 'bridge-supervisor-repro: tmux隔離と後始末を確認'
