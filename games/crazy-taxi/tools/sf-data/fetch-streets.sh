#!/usr/bin/env bash
# Download the real San Francisco street network from OpenStreetMap (Overpass)
# into sf-streets.raw.json. Regenerate the baked mask afterwards with rasterize.mjs.
#
# The raw dump (~15 MB) is gitignored; this script reproduces it on demand.
set -euo pipefail
cd "$(dirname "$0")"

# Peninsula bbox: south,west,north,east. Drivable street classes only
# (paths/service/pedestrian excluded — they add noise, not streets).
read -r -d '' QUERY <<'OQL' || true
[out:json][timeout:180];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street)$"]
    (37.700,-122.520,37.815,-122.353);
);
out geom;
OQL

echo "Fetching SF streets from Overpass…"
for attempt in 1 2 3 4 5 6; do
  code=$(curl -sS --max-time 200 "https://overpass-api.de/api/interpreter" \
    -H "User-Agent: vibedgames-sf-map/1.0" -H "Accept: application/json" \
    --data-urlencode "data=$QUERY" -o sf-streets.raw.json -w "%{http_code}") && :
  if [ "$code" = "200" ]; then
    echo "OK ($(wc -c <sf-streets.raw.json) bytes)"; exit 0
  fi
  echo "attempt $attempt -> HTTP $code; the public Overpass server is often busy (429/504). Retrying in $((attempt*4))s…"
  sleep $((attempt*4))
done
echo "Failed after retries. Try again later or use a mirror (overpass.kumi.systems)." >&2
exit 1
