#!/usr/bin/env bash
# Fetch SF landuse/leisure/natural polygons (ground-truth green vs paved).
set -euo pipefail
cd "$(dirname "$0")"
read -r -d '' QUERY <<'OQL' || true
[out:json][timeout:120];
(
  way["leisure"~"^(park|garden|pitch|golf_course|playground|common)$"](37.700,-122.520,37.815,-122.353);
  way["landuse"~"^(grass|recreation_ground|cemetery|meadow|forest|village_green)$"](37.700,-122.520,37.815,-122.353);
  way["natural"~"^(wood|scrub|grassland|beach|sand)$"](37.700,-122.520,37.815,-122.353);
);
out geom;
OQL
for server in https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter; do
  for attempt in 1 2 3; do
    code=$(curl -sS --max-time 200 "$server" \
      -H "User-Agent: vibedgames-sf-map/1.0" -H "Accept: application/json" \
      --data-urlencode "data=$QUERY" -o sf-landuse.raw.json -w "%{http_code}") && :
    if [ "$code" = "200" ] && [ "$(wc -c <sf-landuse.raw.json)" -gt 100000 ]; then
      echo "OK ($(wc -c <sf-landuse.raw.json) bytes from $server)"; exit 0
    fi
    echo "attempt $attempt on $server -> HTTP $code; retrying in $((attempt*5))s"
    sleep $((attempt*5))
  done
done
echo "failed" >&2; exit 1
