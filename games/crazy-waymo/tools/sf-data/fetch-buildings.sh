#!/usr/bin/env bash
# Fetch every building footprint in the SF peninsula from Overpass, with the
# tags the parcel bake reads (height, building:levels, building=*). Ways AND
# multipolygon relations — the big footprints (piers, malls, the Ferry
# Building) are relations and invisible to a way-only query. Output is
# gitignored like the other raws; bake-parcels.mts turns it into the binary
# the game ships.
set -euo pipefail
cd "$(dirname "$0")"
BBOX="37.700,-122.520,37.815,-122.353"
read -r -d '' QUERY <<OQL || true
[out:json][timeout:600];
(
  way["building"](${BBOX});
  relation["building"](${BBOX});
);
out geom;
OQL
for server in https://overpass.kumi.systems/api/interpreter https://overpass-api.de/api/interpreter; do
  for attempt in 1 2 3; do
    code=$(curl -sS --max-time 900 "$server" \
      -H "User-Agent: vibedgames-sf-map/1.0" -H "Accept: application/json" \
      --data-urlencode "data=$QUERY" -o sf-buildings.raw.json -w "%{http_code}") && :
    if [ "$code" = "200" ] && [ "$(wc -c <sf-buildings.raw.json)" -gt 10000000 ]; then
      echo "OK ($(wc -c <sf-buildings.raw.json) bytes from $server)"; exit 0
    fi
    echo "attempt $attempt on $server -> HTTP $code; retrying in $((attempt*10))s"
    sleep $((attempt*10))
  done
done
echo "failed" >&2; exit 1
