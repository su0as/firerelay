#!/bin/bash
# FireRelay pipeline step 0b: pull the current year (not yet in the yearly archive) from the FIRMS area API,
# 5 days per request (API maximum), throttled to stay under the 5000-transactions-per-10-minutes MAP_KEY limit.
# Standard (SP) data is used where it exists; NRT fills the most recent months (see data_availability).
# Usage: MAP_KEY=... fetch_api.sh <SOURCE> <startDate YYYY-MM-DD> <endDate YYYY-MM-DD>   (CSV to stdout)
set -u
SRC=$1; D0=$2; D1=$3
API=https://firms.modaps.eosdis.nasa.gov/api/area/csv/$MAP_KEY
d=$D0
while [[ "$d" < "$D1" || "$d" == "$D1" ]]; do
  while true; do
    cur=$(curl -s "https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=$MAP_KEY" | sed -E 's/.*"current_transactions": ([0-9]+).*/\1/')
    if [[ "$cur" =~ ^[0-9]+$ ]] && (( cur < 4700 )); then break; fi
    echo "throttle: $cur transactions, waiting" >&2; sleep 30
  done
  for attempt in 1 2 3; do
    out=$(curl -s --max-time 180 "$API/$SRC/world/5/$d")
    if [[ "$out" == latitude* ]]; then printf '%s\n' "$out"; echo "ok $SRC $d $(printf '%s\n' "$out" | wc -l)" >&2; break; fi
    echo "retry $SRC $d: ${out:0:80}" >&2; sleep 20
  done
  d=$(date -j -v+5d -f "%Y-%m-%d" "$d" "+%Y-%m-%d")
done
