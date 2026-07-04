#!/usr/bin/env bash
# Ganti preset lalu restart agent.
# Pakai: ./switch-preset.sh <meridian|arcana|emperor>
set -e
cd "$(dirname "$0")"
node switch-preset.js "$1"
pm2 restart meridian --update-env >/dev/null 2>&1
echo "meridian di-restart dengan preset $1"
grep -E '"preset"|"defaultBinsBelow"|"minBinsBelow"|"trailingTriggerPct"|"trailingDropPct"|"stopLossPct"' user-config.json
