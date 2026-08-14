import { roundHalfToEven } from "../pymath.js";

/**
 * Prompt builders for the two generation steps: a single directional *anchor*
 * sprite, and a *pose board* whose grid cells become animation frames.
 *
 * The wording here is craft, not decoration. The alternating-pixel guide role,
 * the implied-grid layout, the per-cell safe area, the facing lock and the full
 * chroma/no-shadow litany are what keep a generated board sliceable — a model
 * given looser wording returns a contact sheet with borders, drifting scale, or
 * a mirrored frame, none of which the deterministic pipeline can repair. Do not
 * paraphrase these strings.
 */

export type Direction = {
  id: string;
  label: string;
  promptName: string;
  screenFacing: string;
};

export const DIRECTIONS: Record<string, Direction> = {
  n: {
    id: "n",
    label: "North",
    promptName: "north / back-facing",
    screenFacing: "back-facing, away from the viewer",
  },
  ne: {
    id: "ne",
    label: "North-East",
    promptName: "north-east / back-right-facing",
    screenFacing: "diagonal back-right-facing, away from the viewer",
  },
  s: {
    id: "s",
    label: "South",
    promptName: "south / front-facing",
    screenFacing: "front-facing, toward the viewer",
  },
  se: {
    id: "se",
    label: "South-East",
    promptName: "south-east / front-right-facing",
    screenFacing: "diagonal front-right-facing, toward screen-right",
  },
  e: {
    id: "e",
    label: "East",
    promptName: "east / right-facing",
    screenFacing: "profile facing screen-right",
  },
  sw: {
    id: "sw",
    label: "South-West",
    promptName: "south-west / front-left-facing",
    screenFacing: "diagonal front-left-facing, toward screen-left",
  },
  w: {
    id: "w",
    label: "West",
    promptName: "west / left-facing",
    screenFacing: "profile facing screen-left",
  },
  nw: {
    id: "nw",
    label: "North-West",
    promptName: "north-west / back-left-facing",
    screenFacing: "diagonal back-left-facing, away toward screen-left",
  },
};

export function getDirection(directionId: string): Direction {
  const resolved = (directionId || "").trim().toLowerCase();
  const direction = DIRECTIONS[resolved];
  if (!direction) {
    throw new Error(
      `unknown direction '${directionId}'; expected one of: ${Object.keys(DIRECTIONS).join(", ")}`,
    );
  }
  return direction;
}

export const ANCHOR_GAME_VIEWS: Record<string, string> = {
  platformer: "side-scrolling / side-view platformer or action game",
  adventure: "point-and-click adventure character view",
  "point-and-click": "point-and-click adventure character view",
  "top-down": "experimental loose top-down or three-quarter top-down game",
  "rts-oblique": "Warcraft-like elevated oblique RTS unit camera",
  isometric: "experimental true isometric tactics / diamond-tile game",
  generic: "generic 2D game asset pipeline",
};

export const ANCHOR_ROLES: Record<string, string> = {
  character: "playable or NPC character",
  enemy: "enemy or creature",
  prop: "small interactive or decorative prop",
  turret: "planted turret or mechanical hazard",
  object: "non-character game object",
};

const VIEW_ALIASES: Record<string, string> = {
  "side-scroller": "platformer",
  "point-and-click": "adventure",
  point_and_click: "adventure",
  pnc: "adventure",
  "adventure-game": "adventure",
  rts: "rts-oblique",
  "rts-oblique": "rts-oblique",
  rts_oblique: "rts-oblique",
  warcraft: "rts-oblique",
  "warcraft-rts": "rts-oblique",
  "oblique-rts": "rts-oblique",
  "isometric-rts": "rts-oblique",
  "iso-rts": "rts-oblique",
  isometric_rts: "rts-oblique",
};

export function resolveAnchorGameView(gameView: string | null): string {
  let resolved = (gameView || "platformer").trim().toLowerCase();
  resolved = VIEW_ALIASES[resolved] ?? resolved;
  if (!(resolved in ANCHOR_GAME_VIEWS)) {
    const known = Object.keys(ANCHOR_GAME_VIEWS).sort().join(", ");
    throw new Error(`unknown anchor game view '${gameView}'; expected one of: ${known}`);
  }
  return resolved;
}

export function resolveAnchorRole(anchorRole: string | null): string {
  const resolved = (anchorRole || "character").trim().toLowerCase();
  if (!(resolved in ANCHOR_ROLES)) {
    const known = Object.keys(ANCHOR_ROLES).sort().join(", ");
    throw new Error(`unknown anchor role '${anchorRole}'; expected one of: ${known}`);
  }
  return resolved;
}

/** Valid action ids; any other id still works via a generic fallback. */
export const ACTION_IDS = [
  "idle",
  "hurt",
  "jump",
  "crouch",
  "attack",
  "death",
  "walk",
  "run",
  "roll",
  "dash",
  "talk",
  "interact",
  "pick_up",
  "use",
  "examine",
  "give",
  "shrug",
  "walk_forward",
  "walk_backward",
  "block_high",
  "block_low",
  "knockdown",
  "get_up",
  "light_attack",
  "heavy_attack",
];

export function getActionId(actionId: string): string {
  const resolved = (actionId || "").trim().toLowerCase();
  if (!resolved) throw new Error("an action id is required (e.g. walk, run, attack)");
  return resolved;
}

/**
 * Style presets. The blocks spell out the visual constraints so the project's
 * own preset name is never sent to a model.
 */
export function styleBlock(style: string | null): string {
  if (style === null || style === undefined) return "";
  if (style === "lobit-v1") {
    return `
Style constraints (low-bit pixel-sprite production art):
- Deliberately simple low-bit pixel-sprite production art.
- Limited 8 to 12 color feeling.
- Big readable pixel clusters and clean stepped edges.
- Compact silhouettes that remain readable inside 256x256 runtime cells.
- Broad identity preservation only, with tiny details collapsed into a few big visual cues.
- No ornate trim, jewelry, stitching, buttons, buckles, texture noise, fabric weave, cloth-fold detail, or layered micro-props.
- Native snapped height should feel roughly 100-130px; do not produce overly tall or dense detail.
`;
  }
  if (style === "high-fidelity-v1") {
    return `
Style constraints (high-fidelity / mixel pixel-art):
- High-fidelity 2D pixel-art-inspired game sprite.
- Richer color ramps and texture are acceptable.
- Mixed pixels are acceptable at the target game resolution.
- Preserve more of the source identity and style than a low-bit treatment.
- Still keep one centered full-body/object subject on an exact flat chroma matte.
- No scenery, shadows, checkerboards, faux transparency, or cropped limbs.
`;
  }
  if (style === "preserve-reference-v1") {
    return `
Style constraints (source-faithful preservation):
- The source/reference image is strict visual authority, not just broad identity input.
- Do not redesign, mature, de-chibi, normalize, westernize, or reinterpret.
- Only adapt canvas, background, and facing as required.
- Pixel snapping and palette cleanup may happen later, but they must not imply an aesthetic redesign.
- Preserve chibi proportions, head/body ratio, silhouette, outfit, palette, line weight, rendering style, facial design, and shape language.
- Still keep one centered character/object on an exact flat chroma matte.
`;
  }
  throw new Error(
    `unknown style '${style}'; expected one of: lobit-v1, high-fidelity-v1, preserve-reference-v1`,
  );
}

export function withStyle(prompt: string, style: string | null): string {
  const block = styleBlock(style);
  return block ? `${prompt}${block}` : prompt;
}

function chromaPhrase(chroma: string): string {
  const names: Record<string, string> = {
    "#00FF00": "chroma green #00FF00",
    "#FF00FF": "chroma magenta #FF00FF",
    "#0000FF": "chroma blue #0000FF",
  };
  return names[chroma.toUpperCase()] ?? `chroma color ${chroma}`;
}

function directionLine(direction: Direction, gameView: string): string {
  if (gameView === "adventure") {
    const lines: Record<string, string> = {
      s: "south / front-facing adventure standing view",
      se: "south-east / front-right three-quarter adventure view",
      sw: "south-west / front-left three-quarter adventure view",
      e: "east / screen-right adventure profile",
      w: "west / screen-left adventure profile",
      n: "north / back-facing adventure standing view",
      ne: "north-east / back-right three-quarter adventure view",
      nw: "north-west / back-left three-quarter adventure view",
    };
    return lines[direction.id] ?? direction.screenFacing;
  }
  if (gameView === "rts-oblique") {
    const lines: Record<string, string> = {
      n: "north / back-facing as a compact unit rotated on an oblique RTS ground plane",
      ne: "north-east / back-right-facing as a compact unit rotated on an oblique RTS ground plane",
      e: "east / screen-right-facing from the fixed elevated RTS camera, not a pure side profile",
      se: "south-east / front-right-facing as a compact unit rotated on an oblique RTS ground plane",
      s: "south / front-facing from the fixed elevated RTS camera, not a straight-on portrait",
      sw: "south-west / front-left-facing as a compact unit rotated on an oblique RTS ground plane",
      w: "west / screen-left-facing from the fixed elevated RTS camera, not a pure side profile",
      nw: "north-west / back-left-facing as a compact unit rotated on an oblique RTS ground plane",
    };
    return lines[direction.id] ?? direction.screenFacing;
  }
  return direction.screenFacing;
}

function anchorCompositionGuidance(gameView: string): string {
  if (gameView === "adventure") {
    return `- One isolated full-height point-and-click adventure character centered on the canvas.
- Whole body visible from head to feet with a clear grounded standing silhouette.
- The visible character should occupy roughly 65-80% of the 1024 canvas height.
- Use generous empty chroma matte around the character on all sides.
- Feet should feel planted for click-to-walk navigation, but do not draw a floor, ellipse, or shadow.`;
  }
  if (gameView === "rts-oblique") {
    return `- One isolated small RTS unit sprite centered on the canvas.
- Whole unit visible, including head, weapon, hands, body, and feet, but not drawn as a tall full-height character turnaround.
- Compact squat footprint; the visible unit should occupy roughly 35-45% of the 1024 canvas height.
- Generous empty chroma matte around the unit on all sides.
- Feet planted on an implied RTS ground plane, but do not draw the ground plane.`;
  }
  return `- One isolated full-body sprite centered on the canvas.
- Full body visible from head to feet.`;
}

function anchorAvoidGuidance(gameView: string): string {
  if (gameView === "adventure") {
    return `- not a side-view platformer profile unless direction is explicitly east or west
- not an overhead top-down unit
- not a squat RTS unit
- not a fighting-game combat stance
- not a portrait crop`;
  }
  if (gameView === "rts-oblique") {
    return `- not a tall full-height character turnaround
- not a side-view platformer sprite
- not a fighting-game character sprite
- not a portrait pose
- not a paper-doll front view
- not a large character illustration`;
  }
  return "";
}

function directionViewGuidance(direction: Direction, gameView: string): string {
  if (gameView === "adventure") {
    if (direction.id === "sw" || direction.id === "se") {
      const side = direction.id === "sw" ? "screen-left" : "screen-right";
      return `- Use a classic point-and-click adventure character camera: orthographic or near-orthographic, slightly above eye level, full-body, grounded, and asset-focused.
- Make this a clean front three-quarter standing view angled toward ${side}.
- Keep enough face, chest, and body front visible for dialogue and object-interaction readability.
- Direction must be ${directionLine(direction, gameView)}.
- Do not make a true side-scrolling profile, overhead unit, RTS unit, fighting-game combat pose, or portrait.`;
    }
    return `- Use a classic point-and-click adventure character camera: orthographic or near-orthographic, slightly above eye level, full-body, grounded, and asset-focused.
- Direction must be ${directionLine(direction, gameView)}.
- Keep the pose neutral and suitable for click-to-walk navigation, dialogue, and object interaction.
- Do not make an overhead unit, squat RTS unit, fighting-game combat pose, or portrait.`;
  }
  if (gameView === "rts-oblique") {
    return `- Use an elevated oblique RTS camera, similar to Warcraft-like unit sprites, not a platformer, fighting-game, or strict tactics-isometric camera.
- The sprite should read as a small RTS unit standing on an implied RTS ground plane.
- Keep the camera above the unit enough that the top planes of the head, shoulders, armor, weapon, and boots are visible.
- Use foreshortened, compact, squat body proportions appropriate for an RTS unit; do not create a tall full-height character.
- Direction must be ${directionLine(direction, gameView)}.
- Keep feet planted on the implied RTS ground plane with clear ground contact.
- Do not make a pure side-view platformer profile, a straight-on front portrait, a paper-doll turnaround, or a large character illustration.`;
  }
  if (gameView === "isometric") {
    return `- Experimental true isometric / tactics-style camera. This path is less tested than platformer and rts-oblique.
- Aim for a diamond-tile tactics view with visible top planes and compact foreshortened proportions.
- Direction must be ${direction.screenFacing} from a consistent isometric tactics camera.
- Do not make a pure side-view platformer profile or a straight-on front portrait.`;
  }
  if (gameView === "platformer") {
    if (direction.id === "w") {
      return `- Make this a true side-view profile for a side-scrolling game, facing screen-left.
- Do not leave it front-facing or three-quarter-facing.
- Only the side of the head, side of the torso, and one side of the body should read clearly.`;
    }
    if (direction.id === "e") {
      return `- Make this a true side-view profile for a side-scrolling game, facing screen-right.
- Do not leave it front-facing or three-quarter-facing.
- Only the side of the head, side of the torso, and one side of the body should read clearly.`;
    }
    if (direction.id === "s") {
      return `- Make this a front-facing orthographic sprite view for a side-scroller turnaround.
- Do not make an overhead or top-down camera view.`;
    }
    if (direction.id === "n") {
      return `- Make this a back-facing orthographic sprite view for a side-scroller turnaround.
- Do not make an overhead or top-down camera view.`;
    }
  }
  if (gameView === "top-down") {
    return `- Experimental top-down or three-quarter top-down camera. This path is less tested than platformer.
- Make the facing readable for a top-down or three-quarter top-down game.
- Preserve the gameplay direction clearly without switching to a side-scroller profile unless the requested direction calls for profile readability.`;
  }
  return `- Make the requested direction readable as a neutral 2D game sprite view.
- Keep the camera orthographic and asset-focused.`;
}

function anchorRoleGuidance(anchorRole: string): string {
  if (anchorRole === "enemy") {
    return `- Preserve the enemy's core body plan, threat shape, and readable attack silhouette.
- Do not turn it into a different creature type, vehicle, turret, quadruped, or humanoid unless image 1 already establishes that shape.`;
  }
  if (anchorRole === "turret") {
    return `- Preserve the planted base, barrel/muzzle orientation, and mechanical silhouette.
- Do not add legs, a humanoid body, a face, hands, or walking anatomy unless image 1 already has them.`;
  }
  if (anchorRole === "prop" || anchorRole === "object") {
    return `- Preserve the object's simple physical form and readable silhouette.
- Do not anthropomorphize it, add a face, add limbs, or turn it into a character.`;
  }
  return `- Preserve the character's body plan, outfit blocks, readable pose language, and silhouette.
- Do not add or remove major anatomy.`;
}

function anchorContextGuidance(anchorContext: string | null): string {
  const context = (anchorContext || "").trim();
  return context
    ? `Additional game context: ${context}`
    : "Additional game context: none supplied.";
}

export function renderAnchorPrompt(
  direction: Direction,
  options: { gameView?: string; anchorRole?: string; anchorContext?: string | null } = {},
): string {
  const { gameView = "platformer", anchorRole = "character", anchorContext = null } = options;
  const resolvedView = resolveAnchorGameView(gameView);
  const resolvedRole = resolveAnchorRole(anchorRole);

  return `Intended use: a reusable single-frame directional anchor sprite for a 2D game asset pipeline.

Game view: ${ANCHOR_GAME_VIEWS[resolvedView]}.
Asset role: ${ANCHOR_ROLES[resolvedRole]}.
${anchorContextGuidance(anchorContext)}

Image 1 role: identity anchor. Preserve the exact approved asset identity, silhouette, proportions, palette blocks, and pixel-art readability from this reference image.
Image 2 role: pixel-style guide. Use this only to reinforce the crisp pixelated treatment, chunky pixel texture, square canvas discipline, and sprite readability. Do not copy guide pixels, checker patterns, borders, labels, or layout marks into the output.

Primary request: generate a single-frame ${direction.promptName} anchor sprite.

Subject:
- Same game asset as image 1.
- Direction: ${directionLine(direction, resolvedView)}.
- Keep this as the same asset, not a redesign.
${directionViewGuidance(direction, resolvedView)}
${anchorRoleGuidance(resolvedRole)}
- Preserve a weapon, tool, barrel, arm, claw, base, or other functional part only if it is clearly part of image 1.
- Do not invent new equipment, limbs, weapons, wheels, legs, scenery, or effects.

Look and rendering:
- Pixelated game-sprite art with crisp chunky edges.
- Preserve the visual family of image 1.
- No painterly shading, no blur, no soft gradients.

Background and composition:
- 1024x1024 square canvas.
${anchorCompositionGuidance(resolvedView)}
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
${anchorAvoidGuidance(resolvedView)}
`;
}

export type PoseBoardPreset = {
  id: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
};

export const POSE_BOARD_PRESETS: Record<string, PoseBoardPreset> = {
  standard: { id: "standard", width: 1536, height: 1152, columns: 4, rows: 3 },
  hires: { id: "hires", width: 2048, height: 1536, columns: 4, rows: 3 },
};

export const cellWidth = (p: PoseBoardPreset) => Math.floor(p.width / p.columns);
export const cellHeight = (p: PoseBoardPreset) => Math.floor(p.height / p.rows);
export const totalCells = (p: PoseBoardPreset) => p.columns * p.rows;

export function resolvePoseBoardPreset(presetId: string | null): PoseBoardPreset {
  const resolved = presetId || "standard";
  const preset = POSE_BOARD_PRESETS[resolved];
  if (!preset) {
    const known = Object.keys(POSE_BOARD_PRESETS).sort().join(", ");
    throw new Error(`unknown pose board preset '${resolved}'; expected one of: ${known}`);
  }
  if (preset.width % preset.columns || preset.height % preset.rows) {
    throw new Error(`pose board preset '${preset.id}' does not divide evenly into its grid`);
  }
  return preset;
}

/**
 * Map frame `index` onto a label list. When the requested frame count differs
 * from the list length the labels are sampled evenly, so a 6-frame attack still
 * walks the same arc as a 10-frame one rather than truncating it.
 */
function labelForIndex(labels: string[], index: number, frameCount: number): string {
  if (frameCount <= 1) return labels[0]!;
  if (frameCount === labels.length) return labels[index - 1]!;
  return labels[roundHalfToEven(((index - 1) * (labels.length - 1)) / (frameCount - 1))]!;
}

const LABELS: Record<string, string[]> = {
  idle: [
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
  ],
  hurt: [
    "idle start",
    "impact anticipation",
    "impact recoil",
    "hit peak",
    "recover balance",
    "return to guard",
  ],
  jump: [
    "ready stance",
    "crouch anticipation",
    "takeoff",
    "airborne peak",
    "falling",
    "landing recovery",
  ],
  crouch: [
    "upright ready stance",
    "crouch anticipation",
    "lowering into crouch",
    "lowest crouched hold",
    "rising from crouch",
    "return to ready stance",
  ],
  death: [
    "idle start",
    "hit reaction",
    "stagger",
    "collapse start",
    "falling",
    "impact",
    "settle",
    "still pose",
    "final still",
    "final hold",
  ],
  // Spatial-progression labels (a single arc, not abstract beats) so the model
  // advances the weapon monotonically along one swing instead of drawing N poses.
  attack: [
    "ready stance, weapon held back",
    "anticipation, weapon drawing back and up",
    "wind-up peak, weapon at the top of the back-swing",
    "swing begins, weapon starting forward along the strike arc",
    "mid-strike, weapon sweeping across the body centerline",
    "contact, weapon at the far forward end of the arc",
    "follow-through, weapon overshooting past contact",
    "recovery, weapon returning toward the ready guard",
    "settle toward ready",
    "return to ready stance",
  ],
  talk: [
    "settled speaking idle",
    "small head turn",
    "hand gesture begins",
    "gesture opens",
    "gesture peak",
    "soft emphasis",
    "gesture relaxes",
    "hand returns",
    "near speaking idle",
    "loop hold matching frame 1",
  ],
  interact: [
    "idle start",
    "anticipate reach",
    "arm extends",
    "operate or take peak",
    "brief contact hold",
    "release",
    "arm returns",
    "settle",
    "return to idle",
    "idle hold",
  ],
  pick_up: [
    "idle start",
    "look toward target",
    "bend begins",
    "reach downward",
    "lowest reach",
    "grasp implied object",
    "lift begins",
    "rise with hand close",
    "settle upright",
    "return to idle",
    "idle hold",
    "loop-safe idle",
  ],
  use: [
    "idle start",
    "anticipate reach",
    "reach outward",
    "hand meets implied control",
    "operate peak",
    "brief hold",
    "release",
    "arm returns",
    "settle",
    "return to idle",
  ],
  examine: [
    "idle start",
    "attention shift",
    "lean begins",
    "peer forward",
    "examine peak",
    "thoughtful hold",
    "lean eases back",
    "head returns",
    "settle",
    "return to idle",
  ],
  give: [
    "idle start",
    "prepare item hand",
    "arm extends",
    "offering pose",
    "offer hold",
    "release or accept beat",
    "arm retracts",
    "hand returns",
    "settle",
    "return to idle",
  ],
  shrug: [
    "idle start",
    "confused anticipation",
    "shoulders lift",
    "palms open",
    "shrug peak",
    "head tilt hold",
    "shoulders relax",
    "hands lower",
    "settle",
    "return to idle",
  ],
};

export function frameLabel(action: string, index: number, frameCount: number): string {
  if (action === "knockdown") return labelForIndex(LABELS.death!, index, frameCount);
  if (action === "light_attack" || action === "heavy_attack") {
    return labelForIndex(LABELS.attack!, index, frameCount);
  }
  const labels = LABELS[action];
  if (labels) return labelForIndex(labels, index, frameCount);
  return `${action} pose ${index}`;
}

const ADVENTURE_ACTIONS = new Set([
  "talk",
  "interact",
  "pick_up",
  "use",
  "examine",
  "give",
  "shrug",
]);

export function renderFrameGuidance(
  action: string,
  frameCount: number,
  framePromptStyle: string,
): string {
  if (framePromptStyle !== "specific" && framePromptStyle !== "loose") {
    throw new Error("frame_prompt_style must be specific or loose");
  }
  if (framePromptStyle === "specific") {
    return Array.from(
      { length: frameCount },
      (_, i) => `- Frame ${i + 1}: ${frameLabel(action, i + 1, frameCount)}`,
    ).join("\n");
  }
  if (action === "attack") {
    return `Motion guidance:
- Create ${frameCount} readable attack poses that feel like one coherent short game animation.
- Use a clear beginning, anticipation, active strike, follow-through, and recovery back toward the starting stance.
- Let the model choose the exact in-between poses; do not force a named pose into every frame.
- Keep the same attacking side, weapon hand, weapon silhouette, and facing direction across all frames.
- The first frame should read as ready/idle and the final frame should return toward that same ready stance for looping.`;
  }
  if (ADVENTURE_ACTIONS.has(action)) {
    return `Motion guidance:
- Create ${frameCount} readable point-and-click adventure ${action} poses that feel like one coherent character animation.
- Use clear beginning, anticipation, main gesture, follow-through, and recovery or loop poses as appropriate for the action.
- Keep the performance grounded and conversational, not combat-focused.
- Let the model choose exact in-betweens while preserving identity, scale, facing direction, and foot baseline.`;
  }
  return `Motion guidance:
- Create ${frameCount} readable ${action} poses that feel like one coherent short game animation.
- Use clear beginning, middle, and end poses with smooth in-betweens.
- Let the model choose the exact in-between poses; do not force a named pose into every frame.
- Keep identity, scale, facing direction, and foot baseline consistent across all frames.`;
}

const LOOPING_ACTIONS = new Set(["idle", "run", "walk", "walk_forward", "walk_backward", "talk"]);

/**
 * The instruction that turns N standalone poses into N frames of ONE motion.
 * Without it the model reads each grid cell as an independent dramatic pose;
 * with it, it samples a single continuous motion at evenly-spaced instants.
 */
function motionContinuityBlock(actionId: string, frameCount: number): string {
  const ending = LOOPING_ACTIONS.has(actionId)
    ? `Frame ${frameCount} returns toward frame 1 so the cycle loops seamlessly.`
    : `Frame 1 is the start of the motion and frame ${frameCount} is its end.`;
  return (
    `\nCritical — read the used cells in order (left to right, top to bottom) as ONE continuous ` +
    `${actionId} motion sampled as ${frameCount} consecutive film frames, not ${frameCount} ` +
    `separate poses. Each cell is the very next instant in time, a small even step after the one ` +
    `before it. Between adjacent frames the pose changes only a little: the same limbs, body, held ` +
    `items, and cloth travel a bit further along the SAME single path, weight shifts gradually, and ` +
    `feet plant or lift in sequence. Flipping through the cells in order must look like smooth, ` +
    `continuous movement with no sudden jumps or unrelated poses. Do not draw ${frameCount} ` +
    `different dramatic poses; draw the SAME motion decomposed into ${frameCount} evenly spaced ` +
    `in-between frames. ${ending}\n`
  );
}

/** Keep every cell facing the same way — the model loves to mirror frame 1. */
function poseBoardFacingLock(direction: Direction): string {
  let base =
    `Facing lock: every single cell must keep the SAME facing — ${direction.screenFacing}. ` +
    `Never mirror, flip, rotate, or reverse the body to face the other way in any frame, including ` +
    `the first and last. A wind-up, recoil, reach, or step that moves backward keeps this same ` +
    `facing; do not turn the character around.`;
  if (direction.id === "e" || direction.id === "w") {
    const side = direction.id === "e" ? "screen-right" : "screen-left";
    base +=
      ` Hold a consistent side profile facing ${side} in every frame: do not present a mirrored ` +
      `profile, a front view, or a back view in any cell.`;
  }
  return base;
}

export function renderPoseBoardPrompt(
  actionId: string,
  direction: Direction,
  frameCount: number,
  options: {
    poseBoard?: PoseBoardPreset | null;
    framePromptStyle?: string;
    chroma?: string;
  } = {},
): string {
  const { poseBoard = null, framePromptStyle = "specific", chroma = "#00FF00" } = options;
  const board = poseBoard ?? resolvePoseBoardPreset("standard");
  const phrase = chromaPhrase(chroma);
  const frameLines = renderFrameGuidance(actionId, frameCount, framePromptStyle);

  return `Intended use: a reusable ${actionId} animation spritesheet for a 2D game.

Image 1 role: identity anchor. Preserve the exact approved anchor sprite identity.
Image 2 role: black-and-white alternating-pixel pose-board geometry guide at the exact target size. Use it only to preserve the output aspect ratio, full-board composition, pixel texture, and implied ${board.columns} column x ${board.rows} row pose-board layout. It is not a background, style, contact-sheet, border, or grid-line reference. Do not copy its black pixels, white pixels, checker pattern, grid lines, borders, labels, or presentation-sheet look into the final output.

Subject:
- Same already-approved sprite character.
- Direction: ${direction.screenFacing}.
- ${poseBoardFacingLock(direction)}
- Keep this as the same character, not a redesign.

Primary request: create a ${frameCount}-frame ${actionId} sequence on a ${board.width}x${board.height} pose board. Place the animation frames in the first ${frameCount} cells of an implied ${board.columns} column x ${board.rows} row grid, reading left to right, top to bottom.
${frameLines}
${motionContinuityBlock(actionId, frameCount)}
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
- Exact canvas size: ${board.width}x${board.height}.
- Exact implied grid: ${board.columns} columns x ${board.rows} rows, ${totalCells(board)} cells total.
- Each implied generation cell is ${cellWidth(board)}x${cellHeight(board)} pixels.
- Each used cell contains one centered 256x256 runtime safe area.
- Put frames 1 through ${frameCount} in cells 1 through ${frameCount}, reading left to right, top to bottom.
- Cells after frame ${frameCount} must remain entirely flat ${chroma} with no character, marks, shadows, labels, or texture.
- Exactly one character figure per used frame cell.
- Keep every full-body figure entirely inside the canvas and entirely inside its own implied frame area.
- Leave clear empty ${phrase} margin around the left edge, right edge, top, bottom, and between neighboring figures.
- The first and last figures must not touch or crop against the canvas edge.
- Scale lock: the character must be the EXACT same size in every cell — same height, same body proportions, same distance from one fixed imaginary camera, as if filmed without zooming in or out. Changing pose is fine; changing the character's scale is not. Do not draw any frame noticeably larger or smaller than the others.
- Anchor every figure to the same foot baseline: feet rest on the same horizontal line across all cells, so the character does not float, sink, or drift up and down between frames.
- Center each character inside the 256x256 safe area of its implied ${cellWidth(board)}x${cellHeight(board)} cell.
- Keep the figures separated and fully readable.
- No overlapping between frame areas.
- Use an opaque exact flat ${phrase} background.
- Every non-character pixel must be exact solid ${chroma}, including the outer edges, gutters between sprites, and unused cells.
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
`;
}
