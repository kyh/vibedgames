#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# Action timing semantics + genre profiles for sprite animation.
"""Single source of truth for *how* each animation should be generated and curated.

The core insight: an animation's *type* should drive
both how many frames it needs and how frames are selected from a motion clip.

- timing          : loop | one_shot | transition | hold  -> the animation's shape.
- selectionPolicy : how frame_select.py should pick frames from extracted video:
                      cycle                     -> compact loop window (idle/walk/run)
                      action_window             -> the meaningful action span (attack)
                      full_duration_include_end -> sample whole clip, KEEP final frame
                                                   (jump/death/get_up land on an end pose)
                      hold_pose                 -> a stable held pose, little motion
                                                   (crouch/block)
- defaultFrames / recommendedFrames / fps : runtime frame budget + playback rate.

Usage:
  sprite_presets.py --action walk [--profile platformer] [--json]
  sprite_presets.py --profile fighting-game --list [--json]
  sprite_presets.py --list-profiles [--json]
  sprite_presets.py --selftest
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class ActionPreset:
    action: str
    defaultFrames: int
    recommendedFrames: tuple[int, ...]
    fps: int
    timing: str  # loop | one_shot | transition | hold
    loopable: bool
    selectionPolicy: str  # cycle | action_window | full_duration_include_end | hold_pose


# Generic engine action vocabulary. SDK/game-facing names (light-punch, heavy-kick)
# map onto these underlying motion contracts; keep CLI action ids generic.
_A = ActionPreset
ACTIONS: dict[str, ActionPreset] = {
    "idle": _A("idle", 10, (8, 10, 12), 6, "loop", True, "cycle"),
    "hurt": _A("hurt", 6, (4, 5, 6, 8), 8, "one_shot", False, "action_window"),
    "jump": _A("jump", 6, (6, 8, 10), 8, "transition", False, "full_duration_include_end"),
    "crouch": _A("crouch", 6, (5, 6, 8), 8, "hold", True, "hold_pose"),
    "attack": _A("attack", 8, (6, 8, 10, 12), 10, "one_shot", False, "action_window"),
    "death": _A("death", 10, (8, 10, 12), 8, "transition", False, "full_duration_include_end"),
    "walk": _A("walk", 8, (8, 10, 12), 10, "loop", True, "cycle"),
    "run": _A("run", 8, (8, 10, 12), 12, "loop", True, "cycle"),
    "roll": _A("roll", 8, (6, 8, 10), 14, "one_shot", False, "action_window"),
    "dash": _A("dash", 6, (5, 6, 8), 14, "one_shot", False, "action_window"),
    "talk": _A("talk", 12, (8, 10, 12), 8, "loop", True, "cycle"),
    "interact": _A("interact", 10, (8, 10, 12), 8, "one_shot", False, "action_window"),
    "pick_up": _A("pick_up", 12, (8, 10, 12), 8, "one_shot", False, "action_window"),
    "use": _A("use", 10, (8, 10, 12), 8, "one_shot", False, "action_window"),
    "examine": _A("examine", 10, (8, 10, 12), 8, "one_shot", False, "action_window"),
    "give": _A("give", 10, (8, 10, 12), 8, "one_shot", False, "action_window"),
    "shrug": _A("shrug", 10, (8, 10, 12), 8, "one_shot", False, "action_window"),
    "walk_forward": _A("walk_forward", 12, (8, 10, 12), 10, "loop", True, "cycle"),
    "walk_backward": _A("walk_backward", 12, (8, 10, 12), 10, "loop", True, "cycle"),
    "block_high": _A("block_high", 8, (4, 6, 8, 10), 10, "hold", True, "hold_pose"),
    "block_low": _A("block_low", 8, (4, 6, 8, 10), 10, "hold", True, "hold_pose"),
    "knockdown": _A("knockdown", 12, (8, 10, 12), 8, "transition", False, "full_duration_include_end"),
    "get_up": _A("get_up", 12, (6, 8, 10, 12), 8, "transition", False, "full_duration_include_end"),
    "light_attack": _A("light_attack", 8, (6, 8, 10, 12), 12, "one_shot", False, "action_window"),
    "heavy_attack": _A("heavy_attack", 12, (6, 8, 10, 12), 10, "one_shot", False, "action_window"),
}


@dataclass(frozen=True)
class Profile:
    profile: str
    description: str
    direction: str  # default anchor direction for the genre
    actions: tuple[str, ...]
    frameOverrides: dict[str, int]  # per-profile runtime frame-count overrides


PROFILES: dict[str, Profile] = {
    "platformer": Profile(
        "platformer",
        "Side-view platformer defaults: loops, jumps, attacks, reactions, death.",
        "w",
        ("idle", "walk", "run", "jump", "roll", "attack", "hurt", "crouch", "death"),
        {},
    ),
    "fighting-game": Profile(
        "fighting-game",
        "Side-view brawler/fighter: longer loops, blocks, knockdown/get-up transitions.",
        "w",
        (
            "idle", "walk", "run", "jump", "crouch", "hurt",
            "walk_forward", "walk_backward",
            "light_attack", "heavy_attack", "attack",
            "block_high", "block_low", "knockdown", "get_up", "death",
        ),
        # Core loops widen to 12; hurt/jump/crouch widen to 8 (source FRAME_COUNT_PROFILES).
        {"idle": 12, "walk": 12, "run": 12, "attack": 12, "death": 12, "hurt": 8, "jump": 8, "crouch": 8},
    ),
    "point-and-click": Profile(
        "point-and-click",
        "Classic adventure character: dialogue + object-interaction gestures, video-first.",
        "sw",
        ("idle", "walk", "talk", "interact", "pick_up", "use", "examine", "give", "shrug"),
        {},
    ),
}
# alias
PROFILES["adventure"] = PROFILES["point-and-click"]


def resolve_profile(profile_id: str | None) -> Profile:
    key = profile_id or "platformer"
    if key not in PROFILES:
        known = ", ".join(sorted(p for p in PROFILES if p != "adventure"))
        raise SystemExit(f"unknown profile {key!r}; expected one of: {known}")
    return PROFILES[key]


def action_facts(action_id: str, profile: Profile | None = None) -> dict:
    if action_id not in ACTIONS:
        known = ", ".join(sorted(ACTIONS))
        raise SystemExit(f"unknown action {action_id!r}; expected one of: {known}")
    facts = asdict(ACTIONS[action_id])
    facts["recommendedFrames"] = list(facts["recommendedFrames"])
    # Runtime anchor policy follows the timing: transitions (jump/death/get_up)
    # keep their vertical travel; everything else lands feet on a shared baseline.
    facts["anchorPolicy"] = "preserve-motion" if facts["timing"] == "transition" else "grounded"
    if profile is not None and action_id in profile.frameOverrides:
        facts["defaultFrames"] = profile.frameOverrides[action_id]
        facts["profileOverride"] = True
    return facts


def coerce_frame_count(action_id: str, requested: int) -> tuple[int, str | None]:
    """Snap an unsupported frame count to the nearest recommended value (their rule).

    Tie-break matches the source: on an equidistant request, prefer the LARGER
    (more-frames) value — `-v` in the sort key. e.g. walk requested 9 -> 10.
    """
    rec = ACTIONS[action_id].recommendedFrames
    if requested in rec:
        return requested, None
    nearest = min(rec, key=lambda v: (abs(v - requested), -v))
    return nearest, f"frame count {requested} not recommended for {action_id}; coerced to {nearest} (recommended: {rec})"


def _emit(obj: object, as_json: bool) -> None:
    if as_json:
        print(json.dumps(obj, indent=2))
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            print(f"{k}: {v}")
    elif isinstance(obj, list):
        for row in obj:
            print(json.dumps(row) if not isinstance(row, str) else row)
    else:
        print(obj)


def selftest() -> int:
    # Timing/selection invariants must hold.
    assert ACTIONS["jump"].selectionPolicy == "full_duration_include_end", "jump must keep its end pose"
    assert ACTIONS["death"].timing == "transition"
    assert ACTIONS["walk"].selectionPolicy == "cycle"
    assert ACTIONS["attack"].timing == "one_shot" and ACTIONS["attack"].selectionPolicy == "action_window"
    assert ACTIONS["crouch"].selectionPolicy == "hold_pose" and ACTIONS["crouch"].timing == "hold"
    # Profiles reference only real actions; fighting-game widens core loops to 12.
    for p in PROFILES.values():
        for a in p.actions:
            assert a in ACTIONS, f"profile {p.profile} references unknown action {a}"
    assert action_facts("idle", PROFILES["fighting-game"])["defaultFrames"] == 12
    assert action_facts("idle", PROFILES["platformer"])["defaultFrames"] == 10
    # fighting-game widens hurt/jump/crouch to 8 (source FRAME_COUNT_PROFILES).
    for a in ("hurt", "jump", "crouch"):
        assert action_facts(a, PROFILES["fighting-game"])["defaultFrames"] == 8, f"{a} fg override"
        assert action_facts(a, PROFILES["platformer"])["defaultFrames"] == 6, f"{a} platformer default"
    # Frame coercion snaps to nearest recommended; ties resolve to MORE frames (source rule).
    snapped, warn = coerce_frame_count("walk", 9)
    assert snapped == 10 and warn is not None, "equidistant tie must prefer the larger count"
    assert coerce_frame_count("walk", 10) == (10, None)
    assert coerce_frame_count("walk", 7)[0] == 8  # nearer to 8
    print("sprite_presets selftest: OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Action timing semantics + genre profiles for sprite animation.")
    ap.add_argument("--action", help="report facts for one action id")
    ap.add_argument("--profile", help="genre profile context (applies frame overrides)")
    ap.add_argument("--list", action="store_true", help="list all actions in --profile (or all actions)")
    ap.add_argument("--list-profiles", action="store_true")
    ap.add_argument("--coerce-frames", type=int, help="with --action: snap N to nearest recommended count")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if args.list_profiles:
        canonical = [k for k in PROFILES if k != "adventure"]
        rows = [
            {
                "profile": PROFILES[k].profile,
                "description": PROFILES[k].description,
                "direction": PROFILES[k].direction,
                "actions": list(PROFILES[k].actions),
            }
            for k in canonical
        ]
        _emit(rows, args.json)
        return 0

    profile = resolve_profile(args.profile) if args.profile else None

    if args.action:
        facts = action_facts(args.action, profile)
        if args.coerce_frames is not None:
            snapped, warn = coerce_frame_count(args.action, args.coerce_frames)
            facts["requestedFrames"] = args.coerce_frames
            facts["coercedFrames"] = snapped
            if warn:
                facts["frameWarning"] = warn
        _emit(facts, args.json)
        return 0

    if args.list:
        ids = profile.actions if profile else tuple(ACTIONS)
        rows = [action_facts(a, profile) for a in ids]
        _emit(rows, args.json)
        return 0

    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
