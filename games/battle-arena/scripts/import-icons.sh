#!/usr/bin/env bash
# Import + compress the HUD icon set from the outlast skill-icon library.
#
# Sources: 300 hand-painted 256x256 PNGs in three volumes.
#   vol1/vol2 name their files "skill N.png"; vol3 uses "skill icon N.png".
# Dest:    public/icons/{name}.webp — ability/item/attack at 128px
#          (54px display @2x DPR), status chips at 64px.
#
# Converter preference: cwebp (q82) → ImageMagick (magick/convert) → sips.
# sips cannot emit webp; that path writes .png and the icon URL contract in
# src/data/icons.ts (`/icons/{name}.webp`) would need to change — avoid it.
#
# Usage: scripts/import-icons.sh [source-root]   (default: ~/Desktop/vg/outlast/skills)
set -euo pipefail

SRC="${1:-$HOME/Desktop/vg/outlast/skills}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/icons"
mkdir -p "$DEST"

if command -v cwebp >/dev/null 2>&1; then
  TOOL=cwebp
elif command -v magick >/dev/null 2>&1; then
  TOOL=magick
elif command -v convert >/dev/null 2>&1; then
  TOOL=convert
elif command -v sips >/dev/null 2>&1; then
  TOOL=sips
  echo "WARNING: no webp encoder found; falling back to sips (PNG output)." >&2
  echo "WARNING: src/data/icons.ts expects .webp — install cwebp (brew install webp)." >&2
else
  echo "ERROR: need one of cwebp / magick / convert / sips on PATH." >&2
  exit 1
fi

# one icon: $1=vol/N  $2=dest name (no extension)  $3=pixel size
icon() {
  local vol="${1%%/*}" n="${1##*/}" name="$2" px="$3" src
  case "$vol" in
    vol3) src="$SRC/$vol/skill icon $n.png" ;;
    *) src="$SRC/$vol/skill $n.png" ;;
  esac
  [[ -f "$src" ]] || { echo "ERROR: missing source $src" >&2; exit 1; }
  case "$TOOL" in
    cwebp) cwebp -quiet -q 82 -resize "$px" "$px" "$src" -o "$DEST/$name.webp" ;;
    magick) magick "$src" -resize "${px}x${px}" -quality 82 "$DEST/$name.webp" ;;
    convert) convert "$src" -resize "${px}x${px}" -quality 82 "$DEST/$name.webp" ;;
    sips) sips -z "$px" "$px" -s format png "$src" --out "$DEST/$name.png" >/dev/null ;;
  esac
}

# ---- Abilities (24) — {champ}-{q|w|e|r}, hue family matches champ tint ----
icon vol3/68 knight-q 128        # shield + impact sparks
icon vol3/67 knight-w 128        # blue arrow punching through
icon vol2/52 knight-e 128        # blue crystal shield
icon vol3/74 knight-r 128        # radial blade pinwheel
icon vol3/51 ranger-q 128        # green energy bow
icon vol3/57 ranger-w 128        # teal evasive swoosh
icon vol2/45 ranger-e 128        # literal green bear trap
icon vol3/43 ranger-r 128        # green arrow volley falling
icon vol3/22 mage-q 128          # orange comet ball
icon vol3/59 mage-w 128          # ice crystal burst
icon vol3/2 mage-e 128           # magenta teleport streak
icon vol3/32 mage-r 128          # gold column + falling debris
icon vol3/52 rogue-q 128         # poison-dripping blade
icon vol3/14 rogue-w 128         # dagger hilt in shadow plumes
icon vol3/9 rogue-e 128          # pale wisps vanishing
icon vol3/91 rogue-r 128         # dagger + blood splash
icon vol1/64 barbarian-q 128     # war axe with orange trail
icon vol3/33 barbarian-w 128     # ground-slam rock burst
icon vol2/70 barbarian-e 128     # fanged lips, blood
icon vol2/64 barbarian-r 128     # flexing figure in flame ring
icon vol2/43 necromancer-q 128   # dark piercing spearheads
icon vol2/62 necromancer-w 128   # green skulls
icon vol2/97 necromancer-e 128   # hands rising from rotting ground
icon vol3/42 necromancer-r 128   # green soul-wisp skull

# ---- New champions (12) — paladin gold, blackknight dark crimson, vampire blood red ----
icon vol3/25 paladin-q 128       # molten gold hammer strike (Hammer Verdict)
icon vol3/18 paladin-w 128       # gold ground circle, rising light (Consecration)
icon vol3/27 paladin-e 128       # ornate gold shield sigil (Aegis of Dawn)
icon vol3/29 paladin-r 128       # radiant cross over grasping dead (Judgement)
icon vol1/14 blackknight-q 128   # dark crimson arc slashes (Executioner's Arc)
icon vol1/4 blackknight-w 128    # dark flame wraith advancing (Dread March)
icon vol1/90 blackknight-e 128   # iron gauntlets clasped (Iron Bastion)
icon vol3/34 blackknight-r 128   # black monolith ground slam (Oblivion Slam)
icon vol3/89 vampire-q 128       # red slashes + blood petals (Bloodletting)
icon vol2/92 vampire-w 128       # swirl of bats, dark magenta (Bat Rush)
icon vol3/83 vampire-e 128       # glossy blood heart (Blood Rite)
icon vol2/10 vampire-r 128       # red fanged maw (Crimson Feast)
icon vol2/8 witch-q 128          # hurled hex bolt, magenta swirl
icon vol2/58 witch-w 128         # corked green brew potion (cauldron zone)
icon vol2/72 witch-e 128         # flight streak + spin rings (broom dash)
icon vol3/15 witch-r 128         # butterflies (mass polymorph)

# ---- Basic attacks (3) — keyed by ChampDef.attackKind ----
icon vol1/67 attack-melee 128    # crossed swords
icon vol2/68 attack-arrow 128    # bow + arrow
icon vol2/6 attack-bolt 128      # blue energy orb

# ---- Items (15) — dest names MUST equal ItemDef.icon strings in src/data/items.ts ----
icon vol3/80 item-boots 128      # running legs
icon vol1/62 item-vitality 128   # heart + cross
icon vol3/26 item-whetstone 128  # gleaming sword
icon vol2/13 item-ringmail 128   # gold shield burst
icon vol2/12 item-wardstone 128  # pink hex ward
icon vol1/24 item-quiver 128     # bow + quiver
icon vol1/85 item-tome 128       # open spellbook
icon vol3/93 item-vampiric 128   # red fangs
icon vol2/7 item-arcaneorb 128   # purple orb
icon vol1/74 item-reaver 128     # heavy cleaver
icon vol3/86 item-elixir 128     # red potion + crosses
icon vol2/51 item-talisman 128   # hands + gold cross
icon vol1/15 item-swiftboots 128 # blue dashing figure
icon vol3/1 item-bulwark 128     # hex dome
icon vol1/41 item-phaseband 128  # cyan teleport beacon

# ---- Status chips (12) — buff/debuff row, 64px ----
icon vol3/30 status-stun 64          # halo + stars over head
icon vol3/49 status-root 64          # vine wrap
icon vol1/7 status-slow 64           # blue clock
icon vol3/62 status-speed 64         # speed streaks
icon vol3/78 status-stealth 64       # hooded figure, glowing eyes
icon vol1/86 status-shield 64        # geodesic sphere
icon vol3/48 status-dot 64           # green splat
icon vol1/30 status-heal 64          # green crosses
icon vol1/16 status-damage-amp 64    # red arcane eye
icon vol1/44 status-attack-speed 64  # spiral drill rings
icon vol1/61 status-armor 64         # bronze shield frame
icon vol3/92 status-empower 64       # flaming fist

echo "icons written to $DEST ($TOOL)"
