#!/usr/bin/env bash
# Fetch the SF ground-class polygons (what every square metre of the city
# ACTUALLY is) into sf-landuse.raw.json. bake-landuse.mjs rasterizes them into
# the per-cell class grid src/world/sf-landuse.ts.
#
# This used to ask only for green + beach, which is why 72% of the city's land
# cells painted as one literal grey: schoolyards, rail yards, container aprons,
# parking lots, plazas and bare rock all fell through to "unclassified". Widened
# to the classes the ground painter can distinguish — and `relation` is now in
# the pull, because Golden Gate Park and the Presidio are multipolygons and are
# invisible to a way-only query.
set -euo pipefail
cd "$(dirname "$0")"
BBOX="37.700,-122.520,37.815,-122.353"
LEISURE='^(park|garden|pitch|golf_course|playground|common|nature_reserve|dog_park|recreation_ground|stadium|track|marina|sports_centre)$'
LANDUSE='^(grass|recreation_ground|cemetery|meadow|forest|village_green|allotments|orchard|industrial|railway|brownfield|construction|retail|commercial|military|port|quarry)$'
NATURAL='^(wood|scrub|grassland|heath|beach|sand|bare_rock|cliff|water|wetland)$'
AMENITY='^(parking|school|hospital|university|college)$'
MANMADE='^(pier|works|quay|breakwater)$'
read -r -d '' QUERY <<OQL || true
[out:json][timeout:300];
(
  way["leisure"~"${LEISURE}"](${BBOX});
  relation["leisure"~"${LEISURE}"](${BBOX});
  way["landuse"~"${LANDUSE}"](${BBOX});
  relation["landuse"~"${LANDUSE}"](${BBOX});
  way["natural"~"${NATURAL}"](${BBOX});
  relation["natural"~"${NATURAL}"](${BBOX});
  way["amenity"~"${AMENITY}"](${BBOX});
  relation["amenity"~"${AMENITY}"](${BBOX});
  way["man_made"~"${MANMADE}"](${BBOX});
  way["highway"="pedestrian"](${BBOX});
  way["place"="square"](${BBOX});
);
out geom;
OQL
for server in https://overpass.kumi.systems/api/interpreter https://overpass-api.de/api/interpreter; do
  for attempt in 1 2 3; do
    code=$(curl -sS --max-time 400 "$server" \
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
