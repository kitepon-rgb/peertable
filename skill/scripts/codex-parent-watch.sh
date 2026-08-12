#!/bin/sh
set -eu

project=${1:?usage: codex-parent-watch.sh <project> [parent]}
parent=${2:-bell}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

exec node "$here/parent-watch.mjs" "$project" "$parent" --poll
