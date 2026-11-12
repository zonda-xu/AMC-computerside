#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Please install Node.js 24.13+ (24.x).' 'https://nodejs.org/en/download/archive/v24.18.0' 'See START-HERE.html for the setup guide.'
  exit 1
fi
exec node launch.mjs
