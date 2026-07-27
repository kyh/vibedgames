#!/usr/bin/env bash
# Fetch the UNTRUNCATED OSM tags for every ground-class area in the SF
# peninsula. extract-landuse-obj.mjs needs this to decode the licensed OBJ's
# 10-character-truncated object names (`landuse=g1`, `leisure=p0`, ...) by
# matching each OBJ polygon to a real OSM way/relation.
#
# Wider than fetch-landuse.sh in two ways that matter: it is not restricted to
# green tags (residential/commercial/industrial/retail/amenity/man_made/power
# all come through), and it pulls RELATIONS as well as ways — Golden Gate Park
# and the Presidio are multipolygon relations and are invisible to a way-only
# query.
set -euo pipefail
cd "$(dirname "$0")"
BBOX="37.700,-122.520,37.815,-122.353"
read -r -d '' QUERY <<OQL || true
[out:json][timeout:300];
(
  nwr["landuse"](${BBOX});
  nwr["leisure"](${BBOX});
  nwr["amenity"~"^(parking|parking_space|school|university|college|kindergarten|hospital|place_of_worship|fountain|shelter|motorcycle_parking|bicycle_parking)\$"](${BBOX});
  nwr["natural"](${BBOX});
  nwr["tourism"](${BBOX});
  nwr["man_made"](${BBOX});
  nwr["power"](${BBOX});
  nwr["place"~"^(square|neighbourhood|island|islet)\$"](${BBOX});
  nwr["waterway"](${BBOX});
  nwr["railway"](${BBOX});
  nwr["barrier"](${BBOX});
);
out geom;
OQL
for server in https://overpass.kumi.systems/api/interpreter https://overpass-api.de/api/interpreter; do
  for attempt in 1 2 3; do
    code=$(curl -sS --max-time 400 "$server" \
      -H "User-Agent: vibedgames-sf-map/1.0" -H "Accept: application/json" \
      --data-urlencode "data=$QUERY" -o sf-osm-tags.raw.json -w "%{http_code}") && :
    if [ "$code" = "200" ] && [ "$(wc -c <sf-osm-tags.raw.json)" -gt 1000000 ]; then
      echo "OK ($(wc -c <sf-osm-tags.raw.json) bytes from $server)"; exit 0
    fi
    echo "attempt $attempt on $server -> HTTP $code; retrying in $((attempt*5))s"
    sleep $((attempt*5))
  done
done
echo "failed" >&2; exit 1
