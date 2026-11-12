#!/bin/sh
cd "$(dirname "$0")" || exit 1
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Please install Node.js 24.13+ (24.x).' 'https://nodejs.org/en/download/archive/v24.18.0' 'See START-HERE.html for the setup guide.'
  read -r reply
  exit 1
fi
node launch.mjs
result=$?
if [ "$result" -ne 0 ]; then printf '%s\n' 'Press Enter to close.'; read -r reply; fi
exit "$result"
