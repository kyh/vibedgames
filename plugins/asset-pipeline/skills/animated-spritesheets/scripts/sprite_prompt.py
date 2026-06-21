#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# Model-facing prompt builders for directional anchors and image-to-video motion
# clips. The constraint wording — per-direction facing locks, per-action cadence
# paragraphs, the no-baked-shadow litany — is the craft that makes the generated
# sprites well-formed; do not paraphrase it. Standalone PEP723 CLI; no model
# invocation.
"""Build model-facing prompts for the sprite animation pipeline.

Three prompt families, each printed to stdout:

  anchor      single-frame directional anchor sprite (game-view + role + direction)
  video       an in-place image-to-video motion clip (the generation path)
  pose-board  a labeled pose-board spritesheet (the IMAGE generation path)

The wording is deliberately verbose: the litanies (no baked shadow, no scenery,
no palette drift) and the per-direction facing locks are the craft. Do not
paraphrase them.

Usage:
  sprite_prompt.py anchor --direction w [--game-view platformer] [--role character] \\
      [--anchor-context "..."] [--style lobit-v1] [--chroma '#00FF00']
  sprite_prompt.py video --action walk --direction w [--style ...] [--chroma '#00FF00']
  sprite_prompt.py pose-board --action attack --direction e --frames 8 \\
      [--pose-board standard] [--frame-prompt-style specific] [--style ...] [--chroma '#00FF00']
  sprite_prompt.py --selftest
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass


# --------------------------------------------------------------------------- #
# Minimal Direction model.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Direction:
    id: str
    label: str
    prompt_name: str
    screen_facing: str


DIRECTIONS: dict[str, Direction] = {
    "n": Direction("n", "North", "north / back-facing", "back-facing, away from the viewer"),
    "ne": Direction("ne", "North-East", "north-east / back-right-facing", "diagonal back-right-facing, away from the viewer"),
    "s": Direction("s", "South", "south / front-facing", "front-facing, toward the viewer"),
    "se": Direction("se", "South-East", "south-east / front-right-facing", "diagonal front-right-facing, toward screen-right"),
    "e": Direction("e", "East", "east / right-facing", "profile facing screen-right"),
    "sw": Direction("sw", "South-West", "south-west / front-left-facing", "diagonal front-left-facing, toward screen-left"),
    "w": Direction("w", "West", "west / left-facing", "profile facing screen-left"),
    "nw": Direction("nw", "North-West", "north-west / back-left-facing", "diagonal back-left-facing, away toward screen-left"),
}


def get_direction(direction_id: str) -> Direction:
    resolved = (direction_id or "").strip().lower()
    try:
        return DIRECTIONS[resolved]
    except KeyError as exc:
        known = ", ".join(DIRECTIONS)
        raise SystemExit(f"unknown direction {direction_id!r}; expected one of: {known}") from exc


# --------------------------------------------------------------------------- #
# Anchor game-views + roles.
# --------------------------------------------------------------------------- #
ANCHOR_GAME_VIEWS: dict[str, str] = {
    "platformer": "side-scrolling / side-view platformer or action game",
    "adventure": "point-and-click adventure character view",
    "point-and-click": "point-and-click adventure character view",
    "top-down": "experimental loose top-down or three-quarter top-down game",
    "rts-oblique": "Warcraft-like elevated oblique RTS unit camera",
    "isometric": "experimental true isometric tactics / diamond-tile game",
    "generic": "generic 2D game asset pipeline",
}

ANCHOR_ROLES: dict[str, str] = {
    "character": "playable or NPC character",
    "enemy": "enemy or creature",
    "prop": "small interactive or decorative prop",
    "turret": "planted turret or mechanical hazard",
    "object": "non-character game object",
}


def resolve_anchor_game_view(game_view: str | None) -> str:
    resolved = (game_view or "platformer").strip().lower()
    if resolved == "side-scroller":
        resolved = "platformer"
    if resolved in {"point-and-click", "point_and_click", "pnc", "adventure-game"}:
        resolved = "adventure"
    if resolved in {"rts", "rts-oblique", "rts_oblique", "warcraft", "warcraft-rts", "oblique-rts", "isometric-rts", "iso-rts", "isometric_rts"}:
        resolved = "rts-oblique"
    if resolved not in ANCHOR_GAME_VIEWS:
        known = ", ".join(sorted(ANCHOR_GAME_VIEWS))
        raise SystemExit(f"unknown anchor game view {game_view!r}; expected one of: {known}")
    return resolved


def resolve_anchor_role(anchor_role: str | None) -> str:
    resolved = (anchor_role or "character").strip().lower()
    if resolved not in ANCHOR_ROLES:
        known = ", ".join(sorted(ANCHOR_ROLES))
        raise SystemExit(f"unknown anchor role {anchor_role!r}; expected one of: {known}")
    return resolved


# --------------------------------------------------------------------------- #
# Minimal action model. Only the id matters for the prompt builders; the full
# timing/selection contract lives in sprite_presets.py (kept separate).
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ActionPreset:
    id: str


# Valid action ids. Frames/fps/timing/selectionPolicy live in sprite_presets.py;
# the prompt builder only needs the id (cadence/labels key off it).
ACTION_PRESETS: dict[str, ActionPreset] = {
    name: ActionPreset(name)
    for name in (
        "idle", "hurt", "jump", "crouch", "attack", "death", "walk", "run",
        "roll", "dash", "talk", "interact", "pick_up", "use", "examine", "give",
        "shrug", "walk_forward", "walk_backward", "block_high", "block_low",
        "knockdown", "get_up", "light_attack", "heavy_attack",
    )
}


def get_action(action_id: str) -> ActionPreset:
    # sprite_presets.py owns the canonical action set; this builder stays id-agnostic
    # so it can never drift from it. Any id works — the cadence/exclusion lookups all
    # have a generic fallback. ACTION_PRESETS below is just the common-case list.
    resolved = (action_id or "").strip().lower()
    if not resolved:
        raise SystemExit("an action id is required (e.g. walk, run, attack)")
    return ACTION_PRESETS.get(resolved) or ActionPreset(resolved)


# --------------------------------------------------------------------------- #
# Style presets. The blocks spell out the visual constraints so the project preset
# name itself is never sent to a model.
# --------------------------------------------------------------------------- #
def style_block(style: str | None) -> str:
    if style is None:
        return ""
    if style == "lobit-v1":
        return """
Style constraints (low-bit pixel-sprite production art):
- Deliberately simple low-bit pixel-sprite production art.
- Limited 8 to 12 color feeling.
- Big readable pixel clusters and clean stepped edges.
- Compact silhouettes that remain readable inside 256x256 runtime cells.
- Broad identity preservation only, with tiny details collapsed into a few big visual cues.
- No ornate trim, jewelry, stitching, buttons, buckles, texture noise, fabric weave, cloth-fold detail, or layered micro-props.
- Native snapped height should feel roughly 100-130px; do not produce overly tall or dense detail.
"""
    if style == "high-fidelity-v1":
        return """
Style constraints (high-fidelity / mixel pixel-art):
- High-fidelity 2D pixel-art-inspired game sprite.
- Richer color ramps and texture are acceptable.
- Mixed pixels are acceptable at the target game resolution.
- Preserve more of the source identity and style than a low-bit treatment.
- Still keep one centered full-body/object subject on an exact flat chroma matte.
- No scenery, shadows, checkerboards, faux transparency, or cropped limbs.
"""
    if style == "preserve-reference-v1":
        return """
Style constraints (source-faithful preservation):
- The source/reference image is strict visual authority, not just broad identity input.
- Do not redesign, mature, de-chibi, normalize, westernize, or reinterpret.
- Only adapt canvas, background, and facing as required.
- Pixel snapping and palette cleanup may happen later, but they must not imply an aesthetic redesign.
- Preserve chibi proportions, head/body ratio, silhouette, outfit, palette, line weight, rendering style, facial design, and shape language.
- Still keep one centered character/object on an exact flat chroma matte.
"""
    known = "lobit-v1, high-fidelity-v1, preserve-reference-v1"
    raise SystemExit(f"unknown style {style!r}; expected one of: {known}")


def _with_style(prompt: str, style: str | None) -> str:
    block = style_block(style)
    if not block:
        return prompt
    return f"{prompt}{block}"


# --------------------------------------------------------------------------- #
# Chroma naming (ported verbatim).
# --------------------------------------------------------------------------- #
def _chroma_phrase(chroma: str) -> str:
    normalized = chroma.upper()
    names = {
        "#00FF00": "chroma green #00FF00",
        "#FF00FF": "chroma magenta #FF00FF",
        "#0000FF": "chroma blue #0000FF",
    }
    return names.get(normalized, f"chroma color {chroma}")


# --------------------------------------------------------------------------- #
# Anchor prompt builder.
# --------------------------------------------------------------------------- #
def render_anchor_prompt(
    direction: Direction,
    *,
    game_view: str = "platformer",
    anchor_role: str = "character",
    anchor_context: str | None = None,
) -> str:
    resolved_view = resolve_anchor_game_view(game_view)
    resolved_role = resolve_anchor_role(anchor_role)
    view_guidance = _direction_view_guidance(direction, resolved_view)
    direction_line = _direction_line(direction, resolved_view)
    composition_guidance = _anchor_composition_guidance(resolved_view)
    avoid_guidance = _anchor_avoid_guidance(resolved_view)
    role_guidance = _anchor_role_guidance(resolved_role)
    context_guidance = _anchor_context_guidance(anchor_context)
    return f"""Intended use: a reusable single-frame directional anchor sprite for a 2D game asset pipeline.

Game view: {ANCHOR_GAME_VIEWS[resolved_view]}.
Asset role: {ANCHOR_ROLES[resolved_role]}.
{context_guidance}

Image 1 role: identity anchor. Preserve the exact approved asset identity, silhouette, proportions, palette blocks, and pixel-art readability from this reference image.
Image 2 role: pixel-style guide. Use this only to reinforce the crisp pixelated treatment, chunky pixel texture, square canvas discipline, and sprite readability. Do not copy guide pixels, checker patterns, borders, labels, or layout marks into the output.

Primary request: generate a single-frame {direction.prompt_name} anchor sprite.

Subject:
- Same game asset as image 1.
- Direction: {direction_line}.
- Keep this as the same asset, not a redesign.
{view_guidance}
{role_guidance}
- Preserve a weapon, tool, barrel, arm, claw, base, or other functional part only if it is clearly part of image 1.
- Do not invent new equipment, limbs, weapons, wheels, legs, scenery, or effects.

Look and rendering:
- Pixelated game-sprite art with crisp chunky edges.
- Preserve the visual family of image 1.
- No painterly shading, no blur, no soft gradients.

Background and composition:
- 1024x1024 square canvas.
{composition_guidance}
- Use an opaque exact flat chroma green background: #00FF00.
- No gradients, texture, anti-aliased haze, lighting effects, checkerboards, faux transparency, or background shadows.
- No cast shadow, ground shadow, contact shadow, glow, particles, or effects touching the background.
- No scenery, UI, labels, text, props, borders, shadows, or extra characters.
- Do not create an animation sheet; deliver one anchor pose only.

Avoid:
- realism
- redesigns
- costume changes
- body-plan changes
- tiny framing
- cropped feet or cropped hair
- floor shadows or environment backdrops
- non-green backgrounds
{avoid_guidance}
"""


def _direction_line(direction: Direction, game_view: str) -> str:
    if game_view == "adventure":
        return {
            "s": "south / front-facing adventure standing view",
            "se": "south-east / front-right three-quarter adventure view",
            "sw": "south-west / front-left three-quarter adventure view",
            "e": "east / screen-right adventure profile",
            "w": "west / screen-left adventure profile",
            "n": "north / back-facing adventure standing view",
            "ne": "north-east / back-right three-quarter adventure view",
            "nw": "north-west / back-left three-quarter adventure view",
        }.get(direction.id, direction.screen_facing)
    if game_view == "rts-oblique":
        return {
            "n": "north / back-facing as a compact unit rotated on an oblique RTS ground plane",
            "ne": "north-east / back-right-facing as a compact unit rotated on an oblique RTS ground plane",
            "e": "east / screen-right-facing from the fixed elevated RTS camera, not a pure side profile",
            "se": "south-east / front-right-facing as a compact unit rotated on an oblique RTS ground plane",
            "s": "south / front-facing from the fixed elevated RTS camera, not a straight-on portrait",
            "sw": "south-west / front-left-facing as a compact unit rotated on an oblique RTS ground plane",
            "w": "west / screen-left-facing from the fixed elevated RTS camera, not a pure side profile",
            "nw": "north-west / back-left-facing as a compact unit rotated on an oblique RTS ground plane",
        }.get(direction.id, direction.screen_facing)
    return direction.screen_facing


def _anchor_composition_guidance(game_view: str) -> str:
    if game_view == "adventure":
        return """- One isolated full-height point-and-click adventure character centered on the canvas.
- Whole body visible from head to feet with a clear grounded standing silhouette.
- The visible character should occupy roughly 65-80% of the 1024 canvas height.
- Use generous empty chroma matte around the character on all sides.
- Feet should feel planted for click-to-walk navigation, but do not draw a floor, ellipse, or shadow."""
    if game_view == "rts-oblique":
        return """- One isolated small RTS unit sprite centered on the canvas.
- Whole unit visible, including head, weapon, hands, body, and feet, but not drawn as a tall full-height character turnaround.
- Compact squat footprint; the visible unit should occupy roughly 35-45% of the 1024 canvas height.
- Generous empty chroma matte around the unit on all sides.
- Feet planted on an implied RTS ground plane, but do not draw the ground plane."""
    return """- One isolated full-body sprite centered on the canvas.
- Full body visible from head to feet."""


def _anchor_avoid_guidance(game_view: str) -> str:
    if game_view == "adventure":
        return """- not a side-view platformer profile unless direction is explicitly east or west
- not an overhead top-down unit
- not a squat RTS unit
- not a fighting-game combat stance
- not a portrait crop"""
    if game_view == "rts-oblique":
        return """- not a tall full-height character turnaround
- not a side-view platformer sprite
- not a fighting-game character sprite
- not a portrait pose
- not a paper-doll front view
- not a large character illustration"""
    return ""


def _direction_view_guidance(direction: Direction, game_view: str) -> str:
    if game_view == "adventure":
        if direction.id in {"sw", "se"}:
            side = "screen-left" if direction.id == "sw" else "screen-right"
            return f"""- Use a classic point-and-click adventure character camera: orthographic or near-orthographic, slightly above eye level, full-body, grounded, and asset-focused.
- Make this a clean front three-quarter standing view angled toward {side}.
- Keep enough face, chest, and body front visible for dialogue and object-interaction readability.
- Direction must be {_direction_line(direction, game_view)}.
- Do not make a true side-scrolling profile, overhead unit, RTS unit, fighting-game combat pose, or portrait."""
        return f"""- Use a classic point-and-click adventure character camera: orthographic or near-orthographic, slightly above eye level, full-body, grounded, and asset-focused.
- Direction must be {_direction_line(direction, game_view)}.
- Keep the pose neutral and suitable for click-to-walk navigation, dialogue, and object interaction.
- Do not make an overhead unit, squat RTS unit, fighting-game combat pose, or portrait."""
    if game_view == "rts-oblique":
        return f"""- Use an elevated oblique RTS camera, similar to Warcraft-like unit sprites, not a platformer, fighting-game, or strict tactics-isometric camera.
- The sprite should read as a small RTS unit standing on an implied RTS ground plane.
- Keep the camera above the unit enough that the top planes of the head, shoulders, armor, weapon, and boots are visible.
- Use foreshortened, compact, squat body proportions appropriate for an RTS unit; do not create a tall full-height character.
- Direction must be {_direction_line(direction, game_view)}.
- Keep feet planted on the implied RTS ground plane with clear ground contact.
- Do not make a pure side-view platformer profile, a straight-on front portrait, a paper-doll turnaround, or a large character illustration."""
    if game_view == "isometric":
        return f"""- Experimental true isometric / tactics-style camera. This path is less tested than platformer and rts-oblique.
- Aim for a diamond-tile tactics view with visible top planes and compact foreshortened proportions.
- Direction must be {direction.screen_facing} from a consistent isometric tactics camera.
- Do not make a pure side-view platformer profile or a straight-on front portrait."""
    if game_view == "platformer":
        if direction.id == "w":
            return """- Make this a true side-view profile for a side-scrolling game, facing screen-left.
- Do not leave it front-facing or three-quarter-facing.
- Only the side of the head, side of the torso, and one side of the body should read clearly."""
        if direction.id == "e":
            return """- Make this a true side-view profile for a side-scrolling game, facing screen-right.
- Do not leave it front-facing or three-quarter-facing.
- Only the side of the head, side of the torso, and one side of the body should read clearly."""
        if direction.id == "s":
            return """- Make this a front-facing orthographic sprite view for a side-scroller turnaround.
- Do not make an overhead or top-down camera view."""
        if direction.id == "n":
            return """- Make this a back-facing orthographic sprite view for a side-scroller turnaround.
- Do not make an overhead or top-down camera view."""
    if game_view == "top-down":
        return """- Experimental top-down or three-quarter top-down camera. This path is less tested than platformer.
- Make the facing readable for a top-down or three-quarter top-down game.
- Preserve the gameplay direction clearly without switching to a side-scroller profile unless the requested direction calls for profile readability."""
    return """- Make the requested direction readable as a neutral 2D game sprite view.
- Keep the camera orthographic and asset-focused."""


def _anchor_role_guidance(anchor_role: str) -> str:
    if anchor_role == "enemy":
        return """- Preserve the enemy's core body plan, threat shape, and readable attack silhouette.
- Do not turn it into a different creature type, vehicle, turret, quadruped, or humanoid unless image 1 already establishes that shape."""
    if anchor_role == "turret":
        return """- Preserve the planted base, barrel/muzzle orientation, and mechanical silhouette.
- Do not add legs, a humanoid body, a face, hands, or walking anatomy unless image 1 already has them."""
    if anchor_role in {"prop", "object"}:
        return """- Preserve the object's simple physical form and readable silhouette.
- Do not anthropomorphize it, add a face, add limbs, or turn it into a character."""
    return """- Preserve the character's body plan, outfit blocks, readable pose language, and silhouette.
- Do not add or remove major anatomy."""


def _anchor_context_guidance(anchor_context: str | None) -> str:
    context = (anchor_context or "").strip()
    if not context:
        return "Additional game context: none supplied."
    return f"Additional game context: {context}"


# --------------------------------------------------------------------------- #
# Video prompt builder.
# --------------------------------------------------------------------------- #
def render_video_prompt(
    action: ActionPreset,
    direction: Direction,
    *,
    chroma: str = "#00FF00",
) -> str:
    chroma_phrase = _chroma_phrase(chroma)
    motion = action.id
    looping_actions = {"idle", "run", "walk", "walk_forward", "walk_backward", "talk"}
    motion_kind = "cycle" if action.id in looping_actions else "animation"
    facing_lock = _video_facing_lock_for_motion(direction, motion=motion)
    cadence = _video_cadence(action.id)
    equipment_guidance = _video_equipment_guidance(action.id)
    exclusions = _video_action_exclusions(action.id)
    return f"""Animate this single character into a simple {direction.prompt_name} in-place {motion} {motion_kind} for a 2D game sprite.

Use the input image as a strict first-frame identity, palette, scale, and sprite-style reference.
Preserve the exact costume colors, pixel-art color blocks, outline weight, facial proportions, hair shape, boots, gloves, belts, buckles, pouches, scarf, cloak edges, goggles, patches, stitching, and other small outfit details.
Do not redesign, repaint, recolor, simplify, smooth, airbrush, modernize, replace, remove, or invent character details.

The character must face {direction.prompt_name} for the entire clip.
Do not turn toward any other direction.
Do not pivot, rotate, or show a quarter-turn view.
{facing_lock}

Keep the camera fixed and centered.
Keep the framing unchanged.
Keep the full-body character large in the frame at the same apparent scale as the input image, with head-to-boot detail still readable.
Keep the plain background as one uninterrupted flat exact {chroma_phrase} plate.
The sprite source must not include baked shadows; the game engine will add shadows separately if needed.
Do not add a cast shadow, contact shadow, ground shadow, ambient-occlusion blob, base ellipse, reflection, footprint, dust puff, floor line, ground line, platform edge, or any visible mark under the character.
Do not turn the background into a floor, room, horizon, scene, contact surface, floor plane, platform, or perspective grid.
Do not add lighting gradients, texture, matte-color spill, background motion, motion blur, defocus blur, smear frames, cinematic lighting, color grading, or ground-contact effects.
Treat foot-down timing as character pose only, never as a visible floor/shadow cue.

Make the motion low-fidelity, readable, and suited to a game sprite reference.
Use a {'looping' if action.id in looping_actions else 'short'} in-place {motion} {motion_kind} with readable game-animation key poses, controlled vertical bobbing, and light clothing/equipment sway.
{cadence}
Preserve the sprite-like pixelated look and the exact character identity in every frame.
Preserve any existing held or worn equipment from the reference as attached parts of the character.
{equipment_guidance}

One character only.
Flat chroma background only.
No scene.
No new props.
No effects.
{exclusions}
No palette drift.
No costume drift.
No boot simplification.
"""


def _video_facing_lock_for_motion(direction: Direction, *, motion: str) -> str:
    if motion == "idle":
        movement = "Keep the body rooted in one spot: feet stay fused to the ground, the body stays centered, and the character does not travel across the frame, slide, or take steps. Use only subtle breathing, tiny hand shifts, blink, and light cloth/equipment sway."
    elif motion in {"run", "walk", "walk_forward", "walk_backward"}:
        movement = "Move arms and legs in a side-view locomotion plane, forward and backward across the screen, not toward the viewer."
    else:
        movement = "Keep the action in the same fixed view plane, centered in frame, without moving toward the viewer."
    if direction.id == "w":
        return f"""Maintain a pure side-profile silhouette facing screen-left in every frame.
Only the side of the head and side of the torso should be visible; do not reveal both eyes, the full front of the chest, or both shoulders.
{movement}"""
    if direction.id == "e":
        return f"""Maintain a pure side-profile silhouette facing screen-right in every frame.
Only the side of the head and side of the torso should be visible; do not reveal both eyes, the full front of the chest, or both shoulders.
{movement}"""
    if direction.id == "n":
        return f"""Maintain a back-facing silhouette in every frame.
Do not reveal the face, front of the torso, or a side-profile turn.
{movement if motion == "idle" else "Move arms and legs as a back-view cycle without rotating the body."}"""
    if direction.id == "s":
        return f"""Maintain a front-facing silhouette in every frame.
Do not rotate into side profile or back view.
{movement if motion == "idle" else "Move arms and legs as a front-view cycle without turning the body."}"""
    return ""


def _video_cadence(action_id: str) -> str:
    if action_id == "idle":
        return "Use a quiet looping idle where the character stays planted in one spot with feet fused to the ground and the body centered: the only motion is a subtle breathing rise/fall of the body and cap, tiny scarf or cloak sway, and an optional blink. Keep both feet down with no stepping and no travel across the frame. Do not make a walk, run, attack, stagger, or bounce-only cycle."
    if action_id == "crouch":
        return "Use a compact crouch or duck animation: start upright, bend knees and lower the body, hold the crouched pose briefly, then return toward the starting stance. Keep both feet planted in place. Do not step, walk, run, jump, attack, slide, or turn toward the camera."
    if action_id == "walk":
        return "Use clear alternating left/right stride poses: left foot forward while right foot back, then right foot forward while left foot back. Arms counter-swing opposite the legs. Show foot-down timing through limb pose only. Do not move both arms forward together. Do not move both feet together. Do not make a shuffle, wiggle, bounce-only idle, marching-in-place twitch, or synchronized arm-and-foot sway."
    if action_id == "walk_forward":
        return "Use a fighting-game walk-forward cycle: guarded upper body, confident forward pressure, alternating stride poses, arms ready to defend, and feet sliding only through pose timing. Do not run, hop, attack, or turn toward the camera."
    if action_id == "walk_backward":
        return "Use a fighting-game walk-backward cycle: guarded upper body, cautious retreating footwork, alternating stride poses, arms ready to defend, and feet sliding only through pose timing. Do not run, hop, attack, or turn toward the camera."
    if action_id == "run":
        return "Use clear alternating left/right running stride poses with readable foot-down and passing poses. Arms counter-swing opposite the legs. Show foot-down timing through limb pose only. Do not move both arms forward together. Do not move both feet together. Do not make a bounce-only idle or synchronized arm-and-foot sway."
    if action_id == "roll":
        return "Use a quick evasive forward roll/dodge: drop low, tuck the body and tumble forward along the ground in a compact ball, then rise back to a ready stance. The character stays low through the middle of the move. Keep it fast and grounded. Do not float, fly, leave a motion trail, or add effects."
    if action_id == "dash":
        return "Use a fast horizontal dash burst: a sharp lean into a quick forward lunge that holds a streamlined low pose, then settles to a ready stance. Keep feet near the ground and the body committed forward. Do not float, fly, leave a motion trail, or add speed-line effects."
    if action_id == "block_high":
        return "Use a high block animation: raise guard to protect head and torso, absorb impact in place, then return toward guard. Keep feet planted. Do not attack, walk, crouch, or fall."
    if action_id == "block_low":
        return "Use a low block animation: lower stance and guard the legs/body, absorb impact in place, then return toward guard. Keep feet planted. Do not attack, walk, jump, or fall."
    if action_id == "knockdown":
        return "Use a knockdown animation: impact recoil, loss of balance, fall to the ground, and settle into a readable downed pose. Keep it compact and do not bounce back up."
    if action_id == "get_up":
        return "Use a get-up recovery animation: start from a downed pose, push up, regain footing, and return to fighting guard. Do not turn toward the camera or become a jump."
    if action_id == "light_attack":
        return "Use a quick light attack animation: short anticipation, fast jab or kick, crisp contact pose, and quick recovery to guard. Keep it compact with no projectile or large VFX."
    if action_id == "heavy_attack":
        return "Use a heavier attack animation: readable wind-up, committed strike, follow-through, and recovery to guard. Keep one clear attack only with no projectile or large VFX."
    if action_id == "talk":
        return "Use a looping dialogue gesture: small head movement, hand emphasis, subtle torso rhythm, and return to a natural speaking stance. Do not create lip-sync text, speech bubbles, or a combat action."
    if action_id == "interact":
        return "Use a short context-sensitive adventure interaction: reach toward an object, operate or take it, then recover to idle. Keep it generic enough to cover use and take verbs."
    if action_id == "pick_up":
        return "Use a short pick-up animation: bend or lean, reach down or forward, grasp an object-sized target, and return toward idle. Do not add a visible object unless it is already in the reference."
    if action_id == "use":
        return "Use a short operate/use animation: reach out, press, turn, pull, or manipulate an implied object, then return toward idle. Do not add scenery or a visible device."
    if action_id == "examine":
        return "Use a short examine animation: lean in, peer, hand-to-chin or thoughtful look, then return toward idle. Keep feet planted and do not turn into a walk."
    if action_id == "give":
        return "Use a short hand-over animation: extend one hand forward as if offering an item, hold briefly, then return toward idle. Do not invent a detailed prop unless already present."
    if action_id == "shrug":
        return "Use a short confused reaction: shoulders lift, hands open or head tilts, then return toward idle. Keep it readable as a point-and-click 'that does not work' response."
    return "Use clear readable key poses for the requested action while keeping it compact and game-sprite-like. Show weight shifts through character pose only; do not add a visible floor, ground line, contact mark, dust, shadow, impact effect, or extra prop."


def _video_action_exclusions(action_id: str) -> str:
    if action_id in {"attack", "light_attack", "heavy_attack"}:
        return "No detached weapon, projectile, muzzle flash, slash trail, or VFX unless it is already part of the requested character action."
    if action_id in {"talk", "interact", "pick_up", "use", "examine", "give", "shrug"}:
        return "No attack animation.\nNo combat VFX.\nNo speech bubble, caption, UI, or visible room object."
    return "No attack animation.\nNo weapon or held-item swing."


def _video_equipment_guidance(action_id: str) -> str:
    if action_id in {"attack", "light_attack", "heavy_attack"}:
        return "If the reference includes a held item, keep it gripped by the same hand in every frame; it may move only as part of the requested attack and must not float, detach, or duplicate."
    if action_id in {"interact", "pick_up", "use", "give"}:
        return "If the reference includes a held item, keep it attached to the same hand or let the hand gesture around it; it must not float, detach, duplicate, or become a new object."
    return "If the reference includes a held item, keep it gripped by the same hand in every frame; it must not float, detach, duplicate, or swing as an attack."


# --------------------------------------------------------------------------- #
# Pose-board prompt builder.
#
# The IMAGE method: one generation lays the same character out in a uniform grid
# of poses (a "pose board"), which the pipeline then slices into frames. This
# holds identity far better than video at the cost of fewer frames. The wording
# below — the alternating-pixel guide role, the implied grid layout, the
# per-cell safe-area discipline, and the full chroma + no-shadow litany — is the
# craft that keeps the board sliceable; do not paraphrase it.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PoseBoardPreset:
    id: str
    width: int
    height: int
    columns: int
    rows: int

    @property
    def cell_width(self) -> int:
        return self.width // self.columns

    @property
    def cell_height(self) -> int:
        return self.height // self.rows

    @property
    def total_cells(self) -> int:
        return self.columns * self.rows


POSE_BOARD_PRESETS: dict[str, PoseBoardPreset] = {
    "standard": PoseBoardPreset("standard", 1536, 1152, 4, 3),
    "hires": PoseBoardPreset("hires", 2048, 1536, 4, 3),
}


def resolve_pose_board_preset(preset_id: str | None) -> PoseBoardPreset:
    resolved = preset_id or "standard"
    try:
        preset = POSE_BOARD_PRESETS[resolved]
    except KeyError as exc:
        known = ", ".join(sorted(POSE_BOARD_PRESETS))
        raise SystemExit(f"unknown pose board preset {resolved!r}; expected one of: {known}") from exc
    if preset.width % preset.columns or preset.height % preset.rows:
        raise SystemExit(f"pose board preset {preset.id!r} does not divide evenly into its grid")
    return preset


def _label_for_index(labels: list[str], index: int, frame_count: int) -> str:
    if frame_count <= 1:
        return labels[0]
    if frame_count == len(labels):
        return labels[index - 1]
    label_index = round((index - 1) * (len(labels) - 1) / (frame_count - 1))
    return labels[label_index]


def frame_label(action: str, index: int, frame_count: int) -> str:
    if action == "idle":
        labels = [
            "settled idle",
            "tiny breathing rise",
            "breathing rise",
            "breathing peak",
            "soft blink or cloth sway",
            "small breathing fall",
            "settling fall",
            "near neutral",
            "return to settled idle",
            "loop hold matching frame 1",
        ]
        return _label_for_index(labels, index, frame_count)
    if action == "hurt":
        labels = ["idle start", "impact anticipation", "impact recoil", "hit peak", "recover balance", "return to guard"]
        return _label_for_index(labels, index, frame_count)
    if action == "jump":
        labels = ["ready stance", "crouch anticipation", "takeoff", "airborne peak", "falling", "landing recovery"]
        return _label_for_index(labels, index, frame_count)
    if action == "crouch":
        labels = ["upright ready stance", "crouch anticipation", "lowering into crouch", "lowest crouched hold", "rising from crouch", "return to ready stance"]
        return _label_for_index(labels, index, frame_count)
    if action in {"death", "knockdown"}:
        labels = ["idle start", "hit reaction", "stagger", "collapse start", "falling", "impact", "settle", "still pose", "final still", "final hold"]
        return _label_for_index(labels, index, frame_count)
    if action in {"attack", "light_attack", "heavy_attack"}:
        labels = ["ready idle", "anticipation", "wind-up", "aim set", "strike or shot", "recoil", "follow-through", "recovery", "settle", "return to idle"]
        return _label_for_index(labels, index, frame_count)
    if action == "talk":
        labels = ["settled speaking idle", "small head turn", "hand gesture begins", "gesture opens", "gesture peak", "soft emphasis", "gesture relaxes", "hand returns", "near speaking idle", "loop hold matching frame 1"]
        return _label_for_index(labels, index, frame_count)
    if action == "interact":
        labels = ["idle start", "anticipate reach", "arm extends", "operate or take peak", "brief contact hold", "release", "arm returns", "settle", "return to idle", "idle hold"]
        return _label_for_index(labels, index, frame_count)
    if action == "pick_up":
        labels = ["idle start", "look toward target", "bend begins", "reach downward", "lowest reach", "grasp implied object", "lift begins", "rise with hand close", "settle upright", "return to idle", "idle hold", "loop-safe idle"]
        return _label_for_index(labels, index, frame_count)
    if action == "use":
        labels = ["idle start", "anticipate reach", "reach outward", "hand meets implied control", "operate peak", "brief hold", "release", "arm returns", "settle", "return to idle"]
        return _label_for_index(labels, index, frame_count)
    if action == "examine":
        labels = ["idle start", "attention shift", "lean begins", "peer forward", "examine peak", "thoughtful hold", "lean eases back", "head returns", "settle", "return to idle"]
        return _label_for_index(labels, index, frame_count)
    if action == "give":
        labels = ["idle start", "prepare item hand", "arm extends", "offering pose", "offer hold", "release or accept beat", "arm retracts", "hand returns", "settle", "return to idle"]
        return _label_for_index(labels, index, frame_count)
    if action == "shrug":
        labels = ["idle start", "confused anticipation", "shoulders lift", "palms open", "shrug peak", "head tilt hold", "shoulders relax", "hands lower", "settle", "return to idle"]
        return _label_for_index(labels, index, frame_count)
    return f"{action} pose {index}"


def render_frame_guidance(action: str, frame_count: int, frame_prompt_style: str) -> str:
    if frame_prompt_style not in {"specific", "loose"}:
        raise SystemExit("frame_prompt_style must be specific or loose")
    if frame_prompt_style == "specific":
        return "\n".join(f"- Frame {index}: {frame_label(action, index, frame_count)}" for index in range(1, frame_count + 1))
    if action == "attack":
        return f"""Motion guidance:
- Create {frame_count} readable attack poses that feel like one coherent short game animation.
- Use a clear beginning, anticipation, active strike, follow-through, and recovery back toward the starting stance.
- Let the model choose the exact in-between poses; do not force a named pose into every frame.
- Keep the same attacking side, weapon hand, weapon silhouette, and facing direction across all frames.
- The first frame should read as ready/idle and the final frame should return toward that same ready stance for looping."""
    if action in {"talk", "interact", "pick_up", "use", "examine", "give", "shrug"}:
        return f"""Motion guidance:
- Create {frame_count} readable point-and-click adventure {action} poses that feel like one coherent character animation.
- Use clear beginning, anticipation, main gesture, follow-through, and recovery or loop poses as appropriate for the action.
- Keep the performance grounded and conversational, not combat-focused.
- Let the model choose exact in-betweens while preserving identity, scale, facing direction, and foot baseline."""
    return f"""Motion guidance:
- Create {frame_count} readable {action} poses that feel like one coherent short game animation.
- Use clear beginning, middle, and end poses with smooth in-betweens.
- Let the model choose the exact in-between poses; do not force a named pose into every frame.
- Keep identity, scale, facing direction, and foot baseline consistent across all frames."""


def render_pose_board_prompt(
    action: ActionPreset,
    direction: Direction,
    frame_count: int,
    *,
    pose_board: PoseBoardPreset | None = None,
    frame_prompt_style: str = "specific",
    chroma: str = "#00FF00",
) -> str:
    chroma_phrase = _chroma_phrase(chroma)
    pose_board = pose_board or resolve_pose_board_preset("standard")
    frame_lines = render_frame_guidance(action.id, frame_count, frame_prompt_style)
    total_cells = pose_board.total_cells
    return f"""Intended use: a reusable {action.id} animation spritesheet for a 2D game.

Image 1 role: identity anchor. Preserve the exact approved anchor sprite identity.
Image 2 role: black-and-white alternating-pixel pose-board geometry guide at the exact target size. Use it only to preserve the output aspect ratio, full-board composition, pixel texture, and implied {pose_board.columns} column x {pose_board.rows} row pose-board layout. It is not a background, style, contact-sheet, border, or grid-line reference. Do not copy its black pixels, white pixels, checker pattern, grid lines, borders, labels, or presentation-sheet look into the final output.

Subject:
- Same already-approved sprite character.
- Direction: {direction.screen_facing}.
- Keep this as the same character, not a redesign.

Primary request: create a {frame_count}-frame {action.id} sequence on a {pose_board.width}x{pose_board.height} pose board. Place the animation frames in the first {frame_count} cells of an implied {pose_board.columns} column x {pose_board.rows} row grid, reading left to right, top to bottom.
{frame_lines}

Look and rendering:
- High-resolution pixelated sprite art.
- Crisp chunky sprite edges.
- Preserve visible pixel structure.
- No painterly rendering, no airbrushing, no soft gradients.
- Keep the sprite large and centered in each frame area.

Composition and background constraints:
- Use the full canvas as a model-friendly pose board, not a packed runtime spritesheet.
- The visible output must be only separate character sprites on one uninterrupted solid chroma background.
- Do not render a contact sheet, proof sheet, storyboard page, panel layout, framed sheet, margin, border, white page, gray page, checkerboard, or visible guide.
- Exact canvas size: {pose_board.width}x{pose_board.height}.
- Exact implied grid: {pose_board.columns} columns x {pose_board.rows} rows, {total_cells} cells total.
- Each implied generation cell is {pose_board.cell_width}x{pose_board.cell_height} pixels.
- Each used cell contains one centered 256x256 runtime safe area.
- Put frames 1 through {frame_count} in cells 1 through {frame_count}, reading left to right, top to bottom.
- Cells after frame {frame_count} must remain entirely flat {chroma} with no character, marks, shadows, labels, or texture.
- Exactly one character figure per used frame cell.
- Keep every full-body figure entirely inside the canvas and entirely inside its own implied frame area.
- Leave clear empty {chroma_phrase} margin around the left edge, right edge, top, bottom, and between neighboring figures.
- The first and last figures must not touch or crop against the canvas edge.
- Keep scale consistent across all frames.
- Keep the same foot baseline across all frames.
- Center each character inside the 256x256 safe area of its implied {pose_board.cell_width}x{pose_board.cell_height} cell.
- Keep the figures separated and fully readable.
- No overlapping between frame areas.
- Use an opaque exact flat {chroma_phrase} background.
- Every non-character pixel must be exact solid {chroma}, including the outer edges, gutters between sprites, and unused cells.
- No white, gray, black, neutral, paper, studio, transparent, or checkerboard background.
- No gradients, texture, anti-aliased haze, lighting effects, checkerboards, or faux transparency on the background.
- No cast shadow, ground shadow, contact shadow, glow, particles, or effects touching the background.
- No matte-color spill on the character.
- Keep effects compact and away from frame edges.
- Do not add scenery, props, text, UI, labels, frame numbers, guide marks, grid lines, cell outlines, borders, decorative effects, or extra characters.

Avoid:
- redesigning the character
- changing costume colors
- making the sprite tiny
- faux transparency patterns
- floor shadows or environment backdrops
- non-chroma backgrounds
"""


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _cmd_anchor(args: argparse.Namespace) -> int:
    direction = get_direction(args.direction)
    prompt = render_anchor_prompt(
        direction,
        game_view=args.game_view,
        anchor_role=args.role,
        anchor_context=args.anchor_context,
    )
    print(_with_style(prompt, args.style))
    return 0


def _cmd_video(args: argparse.Namespace) -> int:
    action = get_action(args.action)
    direction = get_direction(args.direction)
    prompt = render_video_prompt(action, direction, chroma=args.chroma)
    print(_with_style(prompt, args.style))
    return 0


def _cmd_pose_board(args: argparse.Namespace) -> int:
    action = get_action(args.action)
    direction = get_direction(args.direction)
    pose_board = resolve_pose_board_preset(args.pose_board)
    prompt = render_pose_board_prompt(
        action,
        direction,
        args.frames,
        pose_board=pose_board,
        frame_prompt_style=args.frame_prompt_style,
        chroma=args.chroma,
    )
    print(_with_style(prompt, args.style))
    return 0


_STYLE_CHOICES = ("lobit-v1", "high-fidelity-v1", "preserve-reference-v1")


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Build model-facing prompts for the sprite animation pipeline.")
    ap.add_argument("--selftest", action="store_true", help="run self-test and exit")
    sub = ap.add_subparsers(dest="command")

    anchor = sub.add_parser("anchor", help="single-frame directional anchor sprite prompt")
    anchor.add_argument("--direction", required=True, help="n,s,e,w,ne,nw,se,sw")
    anchor.add_argument("--game-view", default="platformer", help="platformer|adventure|top-down|rts-oblique|isometric|generic")
    anchor.add_argument("--role", default="character", help="character|enemy|prop|turret|object")
    anchor.add_argument("--anchor-context", default=None, help="freeform extra game context")
    anchor.add_argument("--style", default=None, choices=_STYLE_CHOICES)
    anchor.add_argument("--chroma", default="#00FF00", help="(anchor matte is fixed green; flag accepted for parity)")
    anchor.set_defaults(func=_cmd_anchor)

    video = sub.add_parser("video", help="in-place image-to-video motion clip prompt")
    video.add_argument("--action", required=True, help="action id, e.g. walk, idle, attack")
    video.add_argument("--direction", required=True, help="n,s,e,w,ne,nw,se,sw")
    video.add_argument("--style", default=None, choices=_STYLE_CHOICES)
    video.add_argument("--chroma", default="#00FF00")
    video.set_defaults(func=_cmd_video)

    pose_board = sub.add_parser("pose-board", help="labeled pose-board spritesheet prompt (IMAGE method)")
    pose_board.add_argument("--action", required=True, help="action id, e.g. attack, idle, walk")
    pose_board.add_argument("--direction", required=True, help="n,s,e,w,ne,nw,se,sw")
    pose_board.add_argument("--frames", type=int, required=True, help="number of animation frames")
    pose_board.add_argument("--pose-board", default="standard", choices=("standard", "hires"))
    pose_board.add_argument("--frame-prompt-style", default="specific", choices=("specific", "loose"))
    pose_board.add_argument("--style", default=None, choices=_STYLE_CHOICES)
    pose_board.add_argument("--chroma", default="#00FF00")
    pose_board.set_defaults(func=_cmd_pose_board)

    return ap


def selftest() -> int:
    w = DIRECTIONS["w"]

    # video walk: side-profile facing lock + no-baked-shadow litany + chroma + stride.
    walk = render_video_prompt(ACTION_PRESETS["walk"], w)
    assert "side-profile" in walk, "walk video must carry the side-profile facing lock"
    assert "shadow" in walk, "walk video must carry the no-baked-shadow litany"
    assert "chroma" in walk, "walk video must name the chroma plate"
    assert "alternating left/right stride" in walk, "walk video must describe alternating stride"

    # video idle: rooted/standing language + shadow litany.
    idle = render_video_prompt(ACTION_PRESETS["idle"], w)
    assert "feet" in idle, "idle video must mention feet"
    assert "does not travel" in idle, "idle video must say the character does not travel"
    assert "step" in idle, "idle video must address stepping (no stepping)"
    assert "shadow" in idle, "idle video must carry the no-baked-shadow litany"

    # anchor platformer w -> side-view profile; turret role -> barrel/base; rts -> RTS.
    anchor_plat = render_anchor_prompt(w, game_view="platformer", anchor_role="character")
    assert "side-view profile" in anchor_plat, "platformer w anchor must be a side-view profile"
    anchor_turret = render_anchor_prompt(w, game_view="platformer", anchor_role="turret")
    assert "barrel" in anchor_turret and "base" in anchor_turret, "turret anchor must mention barrel/base"
    anchor_rts = render_anchor_prompt(w, game_view="rts-oblique", anchor_role="character")
    assert "RTS" in anchor_rts, "rts-oblique anchor must mention RTS"

    # --style lobit-v1 injects the low-bit constraint on the video + anchor builders.
    for blk in (_with_style(walk, "lobit-v1"), _with_style(anchor_plat, "lobit-v1")):
        assert "8 to 12 color" in blk, "lobit-v1 must spell out the 8 to 12 color constraint"
        assert "big readable pixel clusters" in blk.lower(), "lobit-v1 must mention big pixel clusters"

    # chroma override flows through to the named phrase.
    magenta = render_video_prompt(ACTION_PRESETS["walk"], w, chroma="#FF00FF")
    assert "chroma magenta #FF00FF" in magenta, "chroma override must name the matte"

    e = DIRECTIONS["e"]

    # pose-board attack (specific): per-frame labeled lines + chroma constraint.
    board = render_pose_board_prompt(
        ACTION_PRESETS["attack"], e, 8, frame_prompt_style="specific", chroma="#00FF00"
    )
    assert "Frame 1" in board, "pose-board specific must label Frame 1"
    assert "Frame 8" in board, "pose-board specific must label Frame 8"
    assert "exact solid #00FF00" in board, "pose-board must carry the chroma constraint"

    # frame_label tables return sensible non-empty labels.
    assert frame_label("attack", 1, 8) == "ready idle", "attack frame 1 of 8 must read as ready idle"
    assert frame_label("idle", 1, 4) == "settled idle", "idle frame 1 of 4 must read as settled idle"

    # pose-board presets resolve to the documented sizes.
    standard = resolve_pose_board_preset("standard")
    assert (standard.width, standard.height) == (1536, 1152), "standard pose board is 1536x1152"
    assert (standard.cell_width, standard.cell_height) == (384, 384), "standard cell is 384x384"
    assert standard.total_cells == 12, "standard pose board has 12 cells"
    hires = resolve_pose_board_preset("hires")
    assert (hires.width, hires.height) == (2048, 1536), "hires pose board is 2048x1536"
    assert (hires.cell_width, hires.cell_height) == (512, 512), "hires cell is 512x512"

    # --style lobit-v1 injects the low-bit block on the pose-board builder too.
    board_lobit = _with_style(board, "lobit-v1")
    assert "8 to 12 color" in board_lobit, "lobit-v1 must inject the low-bit block on pose-board"

    print("sprite_prompt selftest: OK")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = _build_parser()
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    if not getattr(args, "command", None):
        ap.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
