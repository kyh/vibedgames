#!/usr/bin/env bash
# Bakes Sunnyside source art into the game's public/assets/ folder.
# - composites character layers (base + hair + tools) into single action strips
# - extracts ground tiles from the atlas
# - builds uniform per-crop growth strips
# - copies/extracts objects, UI icons, vfx
set -euo pipefail

PACK="/Users/kyh/Desktop/vg/stardew/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets"
H="$PACK/Characters/Human"
CR="$PACK/Elements/Crops"
ATLAS="$PACK/Tileset/spr_tileset_sunnysideworld_16px.png"
OUT="/Users/kyh/Desktop/vg/stardew/game/public/assets"
HAIR="shorthair"

rm -rf "$OUT"
mkdir -p "$OUT/char" "$OUT/tiles" "$OUT/crops" "$OUT/obj" "$OUT/ui" "$OUT/vfx"

echo "== characters =="
# name:folder:filetoken:frames  (frame size always 96x64)
comp() {
  local name="$1" dir="$2" tok="$3"
  local b="$H/$dir/base_${tok}.png"
  local hh="$H/$dir/${HAIR}_${tok}.png"
  local t="$H/$dir/tools_${tok}.png"
  magick "$b" "$hh" -composite "$t" -composite "$OUT/char/${name}.png"
  echo "  char/${name}.png"
}
comp idle    IDLE     idle_strip9
comp walk    WALKING  walk_strip8
comp run     RUN      run_strip8
comp dig     DIG      dig_strip13
comp water   WATERING watering_strip5
comp axe     AXE      axe_strip10
comp mine    MINING   mining_strip10
comp doing   DOING    doing_strip8
comp attack  ATTACK   attack_strip10
comp carry   CARRY    carry_strip8
comp casting CASTING  casting_strip15
comp reeling REELING  reeling_strip13
comp caught  CAUGHT   caught_strip10
comp hurt    HURT     hurt_strip8
comp death   DEATH    death_strip13
comp roll    ROLL     roll_strip10

echo "== enemies (skeleton, single sheets 96x64) =="
mkdir -p "$OUT/enemy"
SK="$PACK/Characters/Skeleton/PNG"
cp "$SK/skeleton_idle_strip6.png"   "$OUT/enemy/skel_idle.png"
cp "$SK/skeleton_walk_strip8.png"   "$OUT/enemy/skel_walk.png"
cp "$SK/skeleton_attack_strip7.png" "$OUT/enemy/skel_attack.png"
cp "$SK/skeleton_hurt_strip7.png"   "$OUT/enemy/skel_hurt.png"
cp "$SK/skeleton_death_strip10.png" "$OUT/enemy/skel_death.png"

echo "== ground tiles (16x16 from atlas) =="
tile() { magick "$ATLAS" -crop "16x16+$1+$2" +repage "$OUT/tiles/$3.png"; }
tile 16 32 grass0
tile 32 32 grass1
tile 48 32 grass2
tile 80 32 grass3
tile 16 48 grass4
tile 32 48 grass5
tile 64 16 water
tile 48 16 sand

echo "== crops (uniform 16x16 bottom-anchored, 6-stage strips) =="
crop_strip() {
  local crop="$1"; local frames=()
  for i in 0 1 2 3 4 5; do
    local f="$CR/${crop}_0${i}.png"
    magick "$f" -background none -gravity South -extent 16x16 +repage "/tmp/_cs_${i}.png"
    frames+=("/tmp/_cs_${i}.png")
  done
  magick "${frames[@]}" +append +repage "$OUT/crops/${crop}.png"
  echo "  crops/${crop}.png"
}
for c in parsnip potato cauliflower kale carrot cabbage beetroot radish pumpkin wheat sunflower; do
  crop_strip "$c"
done

echo "== objects =="
cp "$PACK/Elements/Plants/spr_deco_tree_01_strip4.png" "$OUT/obj/tree.png"
cp "$PACK/Elements/Plants/spr_deco_tree_02_strip4.png" "$OUT/obj/tree2.png"
cp "$PACK/Elements/Plants/spr_deco_mushroom_red_01_strip4.png"  "$OUT/obj/mushroom_red.png"
cp "$PACK/Elements/Plants/spr_deco_mushroom_blue_01_strip4.png" "$OUT/obj/mushroom_blue.png"
cp "$CR/soil_00.png"   "$OUT/obj/soil.png"
cp "$CR/crate_base.png" "$OUT/obj/crate_base.png"
cp "$CR/crate_top.png"  "$OUT/obj/crate_top.png"
cp "$CR/seeds_generic.png" "$OUT/obj/seeds.png"
cp "$CR/wood.png" "$OUT/obj/wood.png"
cp "$CR/rock.png" "$OUT/obj/stone.png"
cp "$CR/egg.png"  "$OUT/obj/egg.png"
cp "$CR/milk.png" "$OUT/obj/milk.png"
# rock node + buildings (extracted from atlas)
magick "$ATLAS" -crop 30x32+782+338 +repage -trim +repage "$OUT/obj/rock.png"
magick "$ATLAS" -crop 32x58+517+166 +repage -trim +repage "$OUT/obj/house.png"  # blue cottage
magick "$ATLAS" -crop 32x58+517+292 +repage -trim +repage "$OUT/obj/shop.png"   # green cottage
# animals (strip4)
cp "$PACK/Elements/Animals/spr_deco_chicken_01_strip4.png" "$OUT/obj/chicken.png"
cp "$PACK/Elements/Animals/spr_deco_cow_strip4.png"        "$OUT/obj/cow.png"
cp "$PACK/Elements/Animals/spr_deco_pig_01_strip4.png"     "$OUT/obj/pig.png"
cp "$PACK/Elements/Animals/spr_deco_sheep_01_strip4.png"   "$OUT/obj/sheep.png"
cp "$PACK/Elements/Animals/spr_deco_duck_01_strip4.png"    "$OUT/obj/duck.png"
cp "$PACK/Elements/Animals/spr_deco_bird_01_strip4.png"    "$OUT/obj/bird.png"
cp "$CR/fish.png" "$OUT/obj/fish.png"

echo "== ore rocks + ore drop icons (from atlas rock grid) =="
# rock grid: big nodes leftmost (~x782), rows: stone y338, coal y372, crystal y406, copper y440
ore(){ magick "$ATLAS" -crop "$1" +repage -trim +repage "$OUT/obj/$2.png"; }
ore 26x30+782+370 ore_coal
ore 26x32+782+404 ore_crystal
ore 26x32+782+438 ore_copper

echo "== barn / coop (clean hue-shifts of the blue house cottage) =="
# blue roof (~210deg) -> orange barn (hue 0 => -180deg) and red coop (hue 165)
magick "$OUT/obj/house.png" -modulate 100,112,0   "$OUT/obj/barn.png"
magick "$OUT/obj/house.png" -modulate 100,118,162 "$OUT/obj/coop.png"

echo "== produce icons (final crop stage, padded 16x16) =="
for c in parsnip potato cauliflower kale carrot cabbage beetroot radish pumpkin wheat sunflower; do
  magick "$CR/${c}_05.png" -background none -gravity Center -extent 16x16 +repage "$OUT/crops/${c}_icon.png"
done

echo "== ui icons =="
U="$PACK/UI"
for n in axe pickaxe shovel water rod hammer sword basket; do
  [ -f "$U/$n.png" ] && cp "$U/$n.png" "$OUT/ui/$n.png" || true
done
cp "$U/itemdisc_01.png" "$OUT/ui/slot.png"
cp "$U/itemdisc_02.png" "$OUT/ui/slot_sel.png"
cp "$U/cursor_01.png"   "$OUT/ui/cursor.png" 2>/dev/null || true
cp "$U/indicator.png"   "$OUT/ui/indicator.png" 2>/dev/null || true

echo "== world decorations (clean strips) =="
OTH="$PACK/Elements/Other"
cp "$OTH/spr_deco_windmill_strip9.png"  "$OUT/obj/windmill.png"   # 112x112/frame x9
cp "$OTH/spr_deco_coracle_strip4.png"   "$OUT/obj/coracle.png"    # 48x37/frame x4
cp "$OTH/spr_deco_coracle_land.png"     "$OUT/obj/coracle_land.png"

echo "== flower decals + fence + bushes (from atlas) =="
dec16(){ magick "$ATLAS" -crop "16x16+$1+$2" +repage "$OUT/obj/$3.png"; }
dec16 496 16 flower_blue
dec16 544 16 flower_blue2
dec16 544 32 flower_red
dec16 496 48 flower_yellow
dec16 544 48 flower_white
dec16 624 32 fence_h
dec16 592 32 fence_v
dec16 640 16 fence_post
magick "$ATLAS" -crop 20x22+428+12 +repage -trim +repage "$OUT/obj/bush1.png"
magick "$ATLAS" -crop 18x18+428+44 +repage -trim +repage "$OUT/obj/bush2.png"

echo "== vfx =="
cp "$PACK/Elements/VFX/Glint/spr_deco_glint_01_strip6.png" "$OUT/vfx/glint.png"
cp "$PACK/Elements/VFX/Fire/spr_deco_fire_01_strip4.png"   "$OUT/vfx/fire.png"
cp "$PACK/Elements/VFX/Chimney Smoke/chimneysmoke_01_strip30.png" "$OUT/vfx/smoke.png"  # 15x37/frame x30

echo "DONE. file count:"
find "$OUT" -type f | wc -l
du -sh "$OUT"
