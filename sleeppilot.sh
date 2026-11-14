#!/usr/bin/env sh
# SleepPilot launcher for Linux and macOS. Requires Node.js 20.10 or newer.
# Usage: ./sleeppilot.sh [gui|run|ask|reverse|engines|doctor|web] [options]
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "SleepPilot: Node.js 20.10 or newer is required. Install it from https://nodejs.org" >&2
  exit 1
fi
exec node src/main.mjs "$@"
