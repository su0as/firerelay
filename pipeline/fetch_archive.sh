#!/bin/bash
# FireRelay pipeline step 0: download FIRMS yearly "all countries" archives (standard, science-quality
# data, no login needed) and stream them through aggregate.mjs. Each zip is deleted after aggregation,
# so peak disk use stays under ~1 GB.
# Usage: fetch_archive.sh <family> <firstYear> <lastYear> <workDir> <outDir>
set -u
FAM=$1; Y0=$2; Y1=$3; WORK=$4; OUT=$5
NODE=${NODE:-node}
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE=https://firms.modaps.eosdis.nasa.gov/data/country/zips
mkdir -p "$WORK" "$OUT"
for Y in $(seq $Y0 $Y1); do
  F="${FAM}_${Y}_all_countries.zip"
  if [ -f "$OUT/stats_${FAM}_${Y}.json" ]; then echo "skip $F (done)"; continue; fi
  for attempt in 1 2 3; do
    code=$(curl -s -w '%{http_code}' -o "$WORK/$F" "$BASE/$F")
    if [ "$code" = "200" ]; then break; fi
    echo "HTTP $code for $F (attempt $attempt)"; rm -f "$WORK/$F"
    if [ "$code" = "404" ]; then break; fi
    sleep 5
  done
  if [ ! -s "$WORK/$F" ]; then echo "MISSING $F"; continue; fi
  unzip -p "$WORK/$F" '*.csv' | "$NODE" "$HERE/aggregate.mjs" "$FAM" "$Y" "$OUT"
  rm -f "$WORK/$F"
done
echo "LANE DONE $FAM"
