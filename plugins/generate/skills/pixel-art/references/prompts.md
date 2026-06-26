# Pixel-art prompt templates

Exact prompt strings referenced by `pixel-art/SKILL.md`. Each recipe step in the
SKILL uses these as shell variables (`$CHARACTER_STYLE_PROMPT`, `$WALK_PROMPT`,
etc.). Copy them verbatim — the wording is tuned for the model.

---

## Recipe 1 — character

```bash
CHARACTER_STYLE_PROMPT="Generate a single character only, centered in the frame on a plain white background. The character should be rendered in detailed 32-bit pixel art style (like PlayStation 1 / SNES era games). Include proper shading, highlights, and anti-aliased edges for a polished look. The character should have well-defined features, expressive details, and rich colors. Show in a front-facing or 3/4 view pose, standing idle, suitable for sprite sheet animation."

IMAGE_TO_PIXEL_PROMPT="Transform this character into detailed 32-bit pixel art style (like PlayStation 1 / SNES era games). IMPORTANT: Must be a FULL BODY shot showing the entire character from head to feet. Keep the character centered in the frame on a plain white background. Include proper shading, highlights, and anti-aliased edges for a polished look. The character should have well-defined features, expressive details, and rich colors. Show in a front-facing or 3/4 view pose, standing idle, suitable for sprite sheet animation. Maintain the character's key features, colors, and identity while converting to pixel art."
```

---

## Recipe 2 — side-scroller sprite sheets (4-frame 2×2)

```bash
WALK_PROMPT="Create a 4-frame pixel art walk cycle sprite sheet of this character. Arrange the 4 frames in a 2x2 grid on white background. The character is walking to the right. Top row (frames 1-2): Frame 1 (top-left): Right leg forward, left leg back - stride position. Frame 2 (top-right): Legs close together, passing/crossing - transition. Bottom row (frames 3-4): Frame 3 (bottom-left): Left leg forward, right leg back - opposite stride. Frame 4 (bottom-right): Legs close together, passing/crossing - transition back. Each frame shows a different phase of the walking motion. This creates a smooth looping walk cycle. Use detailed 32-bit pixel art style with proper shading and highlights. Same character design in all frames. Character facing right."

WALK_PROMPT_GPT="Create a 4-frame pixel art walk cycle sprite sheet of this character. Character orientation (critical): The character is shown in SIDE PROFILE, with their face, chest, and front foot pointing toward the RIGHT edge of the image. The character's back is on the LEFT side of the image. This is the same side-profile orientation used in classic 2D platformers like Super Mario Bros or Mega Man moving rightward across the screen. Arrange the 4 frames in a 2x2 grid on white background. Top row (frames 1-2): Frame 1 (top-left): Front leg (right leg) extended forward toward the right edge of the image, back leg extended behind toward the left edge. Frame 2 (top-right): Legs close together, passing pose. Bottom row (frames 3-4): Frame 3 (bottom-left): Opposite stride, back leg (left leg) now forward toward the right edge. Frame 4 (bottom-right): Legs close together, passing pose. Use detailed 32-bit pixel art style with proper shading and highlights. Same character design in all frames. All 4 frames must show the character from the SAME side profile angle, facing the RIGHT edge of the image."

JUMP_PROMPT="Create a 4-frame pixel art jump animation sprite sheet of this character. Arrange the 4 frames in a 2x2 grid on white background. The character is jumping. Top row (frames 1-2): Frame 1 (top-left): Crouch/anticipation - character slightly crouched, knees bent, preparing to jump. Frame 2 (top-right): Rising - character in air, legs tucked up, arms up, ascending. Bottom row (frames 3-4): Frame 3 (bottom-left): Apex/peak - character at highest point of jump, body stretched or tucked. Frame 4 (bottom-right): Landing - character landing, slight crouch to absorb impact. Use detailed 32-bit pixel art style with proper shading and highlights. Same character design in all frames. Character facing right."

ATTACK_PROMPT="Create a 4-frame pixel art attack animation sprite sheet of this character. Arrange the 4 frames in a 2x2 grid on white background. The character is performing an attack that fits their design - could be a sword slash, magic spell, punch, kick, or energy blast depending on what suits the character best. Top row (frames 1-2): Frame 1 (top-left): Wind-up/anticipation - character preparing to attack, pulling back weapon or gathering energy. Frame 2 (top-right): Attack in motion - the strike or spell being unleashed. Bottom row (frames 3-4): Frame 3 (bottom-left): Impact/peak - maximum extension of attack, weapon fully swung or spell at full power. Frame 4 (bottom-right): Recovery - returning to ready stance. Use detailed 32-bit pixel art style with proper shading and highlights. Same character design in all frames. Character facing right. Make the attack visually dynamic and exciting."

IDLE_PROMPT="Create a 4-frame pixel art idle/breathing animation sprite sheet of this character. Arrange the 4 frames in a 2x2 grid on white background. The character is standing still but with subtle idle animation. Top row (frames 1-2): Frame 1 (top-left): Neutral standing pose - relaxed stance. Frame 2 (top-right): Slight inhale - chest/body rises subtly, maybe slight arm movement. Bottom row (frames 3-4): Frame 3 (bottom-left): Full breath - slight upward posture. Frame 4 (bottom-right): Exhale - returning to neutral, slight settle. Keep movements SUBTLE - this is a gentle breathing/idle loop, not dramatic motion. Character should look alive but relaxed. Use detailed 32-bit pixel art style with proper shading and highlights. Same character design in all frames. Character facing right."
```

GPT walk uses `WALK_PROMPT_GPT`, not `WALK_PROMPT` — GPT needs the explicit
side-profile orientation to get direction right.

---

## Recipe 2 — isometric RPG sprite sheets (3/4 overhead)

```bash
WALK_DOWN_PROMPT="Create a 4-frame pixel art walk cycle sprite sheet of this character walking DOWNWARD (toward the camera) in a top-down isometric RPG perspective (3/4 overhead view, like a classic top-down RPG). Arrange the 4 frames in a 2x2 grid on white background. The character is walking toward the viewer (south/down). Top row: Frame 1 (top-left): Left foot forward stride, arms swinging naturally. Frame 2 (top-right): Feet together, passing/transition pose. Bottom row: Frame 3 (bottom-left): Right foot forward stride, arms swinging naturally. Frame 4 (bottom-right): Feet together, passing/transition back. We see the character's front/face. Top-down 3/4 view - we see the top of their head slightly. Use detailed 32-bit pixel art style with proper shading and highlights. Same character design in all frames."

WALK_UP_PROMPT="Create a 4-frame pixel art walk cycle sprite sheet of this character walking UPWARD (away from the camera) in a top-down isometric RPG perspective (3/4 overhead view, like a classic top-down RPG). Arrange the 4 frames in a 2x2 grid on white background. CRITICAL: ALL 4 frames must show the character from EXACTLY the same angle, their BACK, facing directly away from the camera. Do NOT rotate or twist the character between frames. The ONLY difference between frames should be the leg and arm positions. Top row: Frame 1 (top-left): Left foot forward. BACK VIEW. Frame 2 (top-right): Feet together. BACK VIEW. Bottom row: Frame 3 (bottom-left): Right foot forward. BACK VIEW. Frame 4 (bottom-right): Feet together. BACK VIEW. Use detailed 32-bit pixel art style. Same character design in all frames."

WALK_SIDE_PROMPT="Create a 4-frame pixel art walk cycle sprite sheet of this character WALKING TO THE RIGHT in a top-down isometric RPG perspective (3/4 overhead view, like a classic top-down RPG). Arrange the 4 frames in a 2x2 grid on white background. The character is FACING RIGHT and WALKING RIGHT. Top row: Frame 1 (top-left): Right leg forward, left leg back - stride, arms swinging. Frame 2 (top-right): Legs close together, passing - transition. Bottom row: Frame 3 (bottom-left): Left leg forward, right leg back - opposite stride, arms swinging. Frame 4 (bottom-right): Legs close together, passing - transition back. We see the character's RIGHT-facing side profile from a top-down 3/4 overhead angle. Use detailed 32-bit pixel art style. Same character design in all frames."

ATTACK_DOWN_PROMPT="Create a 4-frame pixel art ATTACK animation sprite sheet of this character attacking DOWNWARD (toward the camera) in a top-down isometric RPG perspective (3/4 overhead view). Arrange the 4 frames in a 2x2 grid on white background. Top row: Frame 1 (top-left): Wind-up/anticipation - preparing to strike. Frame 2 (top-right): Attack in motion - strike unleashed toward camera. Bottom row: Frame 3 (bottom-left): Impact/peak - maximum extension. Frame 4 (bottom-right): Recovery. We see the character's front/face. The attack should fit the character's design. Use detailed 32-bit pixel art style. Make the attack visually dynamic."

ATTACK_UP_PROMPT="Create a 4-frame pixel art ATTACK animation sprite sheet of this character attacking UPWARD (away from the camera) in a top-down isometric RPG perspective. I've also sent you a reference of the same character's front-facing attack. Use the EXACT SAME attack type, weapon, and visual effects - just show it from behind. Arrange the 4 frames in a 2x2 grid on white background. Top row: Frame 1 (top-left): Wind-up from behind. Frame 2 (top-right): Attack unleashed upward/away. Bottom row: Frame 3 (bottom-left): Impact/peak. Frame 4 (bottom-right): Recovery. We see the character's back. MUST use the same attack style as the reference image. Use detailed 32-bit pixel art style."

ATTACK_SIDE_PROMPT="Create a 4-frame pixel art ATTACK animation sprite sheet of this character attacking SIDEWAYS (to the right) in a top-down isometric RPG perspective. I've also sent you a reference of the same character's front-facing attack. Use the EXACT SAME attack type, weapon, and visual effects - just show it from the side profile. Arrange the 4 frames in a 2x2 grid on white background. Character faces RIGHT. Top row: Frame 1 (top-left): Wind-up from side, facing right. Frame 2 (top-right): Strike unleashed to the right. Bottom row: Frame 3 (bottom-left): Impact/peak. Frame 4 (bottom-right): Recovery. IMPORTANT: Show the character's SIDE PROFILE facing RIGHT. MUST use the same attack style as the reference image. Use detailed 32-bit pixel art style."

IDLE_ISO_PROMPT="Create a 4-frame pixel art idle/breathing animation sprite sheet of this character in a top-down isometric RPG perspective (3/4 overhead view). Arrange the 4 frames in a 2x2 grid on white background. Character is FACING TOWARD THE CAMERA (south/down). Top row: Frame 1 (top-left): Neutral standing pose, facing down. Frame 2 (top-right): Slight inhale - body rises subtly. Bottom row: Frame 3 (bottom-left): Full breath - slight upward posture. Frame 4 (bottom-right): Exhale - returning to neutral. Keep movements SUBTLE. Use detailed 32-bit pixel art style. Same character design in all frames."
```

`attack-up` and `attack-side` both reference the front-facing `attack-down`
result as a second image, so generate `attack-down` first.

---

## Recipe 4 — backgrounds

The character's environment is keyed off `<character_desc>` / `$CHARACTER_DESC`.
Layers 2 and 3 are image-to-video edits that reference the prior layers.

```bash
LAYER1_SKY_PROMPT="Create the SKY/BACKDROP layer for a side-scrolling pixel art game parallax background. This is for a character: <character_desc>. Create an environment that fits this character's world. This is the FURTHEST layer - only sky and very distant elements (distant mountains, clouds, horizon). Style: Pixel art, 32-bit retro game aesthetic. Wide panoramic scene."

LAYER2_MID_PROMPT="Create the MIDDLE layer of a 3-layer parallax background for a side-scrolling pixel art game. I've sent you images of: 1) the character, 2) the sky layer already created. Create the character's ICONIC/CANONICAL location from their story, home village, famous landmarks, signature battlegrounds. Elements should fill the frame from middle down to bottom. Style: Pixel art matching the other images. IMPORTANT: Use a transparent background so this layer can overlay the others."

LAYER3_FG_PROMPT="Create the FOREGROUND layer of a 3-layer parallax background for a side-scrolling pixel art game. I've sent you images of: 1) the character, 2) the sky layer, 3) the middle layer. Create the closest foreground elements (ground, grass, rocks, platforms) that complete the scene. Style: Pixel art matching the other images. IMPORTANT: Use a transparent background so this layer can overlay the others."

ISO_MAP_PROMPT="Create a large, detailed top-down isometric pixel art game world map for a character: $CHARACTER_DESC. Do not place the character on the map. Style: Classic RPG top-down map, 3/4 overhead perspective. Include: winding dirt/stone paths connecting areas, a small body of water, a few buildings or structures that fit the character's world, rocky areas or hills, various terrain types. Single large continuous map image (NOT tiled, NOT a tileset). Complete explorable game world viewed from above. Detailed 32-bit pixel art style. Fill the entire image with map content, no empty borders."
```

---

## Recipe 5 — animated FX (explosion on pure black)

```bash
EXPLOSION_PROMPT="A single fiery explosion fireball erupting in the dead center of the frame on a SOLID PURE BLACK background. Bright orange, yellow and white flames burst outward then dissipate. Completely static locked-off camera, no camera movement, no smoke, no grey haze, no debris, no text. Pure black everywhere except the central fireball."
```
