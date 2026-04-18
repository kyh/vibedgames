# Spritesheets and Nine-Slice UI Panels

## Philosophy: Measure Before You Code

Spritesheet loading seems simple until it breaks. A few pixels off in frame size or a missing parameter causes silent corruption that manifests as broken visuals. **Always inspect the source asset before writing loader code.**

---

## Spritesheet Loading

### Basic Loading

```javascript
this.load.spritesheet('player', 'assets/player.png', {
  frameWidth: 32,
  frameHeight: 48
});
```

### Spritesheets with Gaps (Spacing)

Many asset packs include spacing between frames for visual clarity in the source file:

```javascript
// Asset is 448x448 with 3x3 grid of 144px frames and 8px gaps
this.load.spritesheet('ui-wood-table', 'assets/wood-table.png', {
  frameWidth: 144,
  frameHeight: 144,
  spacing: 8          // Gap between frames
});
```

### Spritesheets with Margins

Some spritesheets have padding around the entire image:

```javascript
this.load.spritesheet('icons', 'assets/icons.png', {
  frameWidth: 32,
  frameHeight: 32,
  margin: 4,          // Padding around entire sheet
  spacing: 2          // Gap between frames
});
```

### Calculating Frame Dimensions

**Formula**:
```
imageWidth = (frameWidth × cols) + (spacing × (cols - 1)) + (margin × 2)
imageHeight = (frameHeight × rows) + (spacing × (rows - 1)) + (margin × 2)
```

**CRITICAL: Check for Square Frames First**

Character spritesheets commonly use **square frames** (frameWidth = frameHeight). Before assuming different width/height:

```
Image: 448×392 pixels

WRONG approach (assuming 8x8 grid):
  - 448/8 = 56 (width) ✓
  - 392/8 = 49 (height) ← Produces bleeding artifacts!

CORRECT approach (try square frames first):
  - Try 56×56: 448/56 = 8 cols ✓, 392/56 = 7 rows ✓
  - This is an 8×7 grid with square 56×56 frames
```

**Verification Steps**:
1. Calculate frameWidth from image width and visible column count
2. **Try using that same value for frameHeight** (square frames)
3. Check if height divides evenly: `imageHeight / frameWidth = integer?`
4. Only use different height if square doesn't work

**Example Calculation**:
```
448px image with 3 columns:
  - If spacing=0: 448/3 = 149.33 (not clean - wrong assumption)
  - If spacing=8: (448 - 16) / 3 = 144 (clean - correct!)

Verify: 144*3 + 8*2 = 432 + 16 = 448 ✓
```

---

## Asset Inspection Protocol

Before writing spritesheet loader code:

1. **Open the asset file** in an image viewer or editor
2. **Note total dimensions** (e.g., 448×448 pixels)
3. **Count rows and columns** (e.g., 3×3 grid)
4. **Measure one frame's actual size** (zoom in, use pixel ruler)
5. **Check for gaps** between frames (that's your `spacing` value)
6. **Check for padding** around edges (that's your `margin` value)
7. **Calculate and verify** the dimensions add up

### Red Flags

- Image dimension doesn't divide evenly by expected frame count
- Calculated frame size has decimals
- Visual inspection shows gaps between frame content
- **frameWidth ≠ frameHeight for character sprites** - most character animations use square frames; non-square dimensions are a warning sign to re-verify
- **Assuming row count matches column count** - an 8-column sheet is NOT necessarily 8 rows; count rows visually or test if `imageHeight / frameWidth` gives an integer

---

## Nine-Slice UI Panels

Nine-slice (or 9-patch) panels allow UI elements to scale while preserving corner/edge details.

### Frame Layout (3x3 Grid)

```
[0] [1] [2]   ← Top row (corners 0,2 don't scale)
[3] [4] [5]   ← Middle row (3,5 stretch vertically)
[6] [7] [8]   ← Bottom row (corners 6,8 don't scale)
     ↑
  1,4,7 stretch horizontally
```

### Manual Nine-Slice Assembly

When Phaser's built-in NineSlice doesn't work (e.g., frames with transparent edges):

```javascript
showNineSlicePanel(framesKey, frameSize, panelWidth, panelHeight, bgColor) {
  const centerX = this.cameras.main.width / 2;
  const centerY = this.cameras.main.height / 2;

  // Panel bounds
  const left = centerX - panelWidth / 2;
  const top = centerY - panelHeight / 2;
  const right = left + panelWidth;
  const bottom = top + panelHeight;

  // Position corners inward from panel edges
  const cornerInset = frameSize * 0.3;
  const overlap = frameSize * 0.5;  // Extra size to fill gaps

  const container = this.add.container(0, 0);

  // 1. Solid background (fills transparent gaps)
  container.add(this.add.rectangle(centerX, centerY, panelWidth, panelHeight, bgColor));

  // 2. Center fill (scaled to panel size)
  const center = this.add.image(centerX, centerY, framesKey, 4);
  center.setDisplaySize(panelWidth + overlap, panelHeight + overlap);
  container.add(center);

  // 3. Edges (stretched)
  const topEdge = this.add.image(centerX, top + cornerInset, framesKey, 1);
  topEdge.setDisplaySize(panelWidth + overlap, frameSize);
  container.add(topEdge);

  const bottomEdge = this.add.image(centerX, bottom - cornerInset, framesKey, 7);
  bottomEdge.setDisplaySize(panelWidth + overlap, frameSize);
  container.add(bottomEdge);

  const leftEdge = this.add.image(left + cornerInset, centerY, framesKey, 3);
  leftEdge.setDisplaySize(frameSize, panelHeight + overlap);
  container.add(leftEdge);

  const rightEdge = this.add.image(right - cornerInset, centerY, framesKey, 5);
  rightEdge.setDisplaySize(frameSize, panelHeight + overlap);
  container.add(rightEdge);

  // 4. Corners (not scaled, positioned last/on top)
  container.add(this.add.image(left + cornerInset, top + cornerInset, framesKey, 0));
  container.add(this.add.image(right - cornerInset, top + cornerInset, framesKey, 2));
  container.add(this.add.image(left + cornerInset, bottom - cornerInset, framesKey, 6));
  container.add(this.add.image(right - cornerInset, bottom - cornerInset, framesKey, 8));

  return container;
}
```

### Asset-Specific Parameters

Different assets need different values. Don't hardcode - configure per asset:

```javascript
const UI_PANEL_CONFIG = {
  'paper-regular': {
    frameSize: 106,
    spacing: 0,
    cornerInset: 0.28,
    overlap: 55,
    bgColor: 0xF5E6C8  // Beige
  },
  'paper-special': {
    frameSize: 106,
    spacing: 0,
    cornerInset: 0.28,
    overlap: 55,
    bgColor: 0x4A5568  // Dark blue-gray
  },
  'wood-table': {
    frameSize: 144,
    spacing: 8,
    cornerInset: 0.35,
    overlap: 80,
    bgColor: 0x8B5A2B  // Brown
  }
};
```

---

## Common Pitfalls

### 1. Wrong Frame Dimensions

**Symptom**: Frames display corrupted, shifted, or partial content

**Cause**: Frame width/height doesn't match actual asset layout

**Fix**: Open asset, measure frames, calculate with spacing/margin

### 2. Missing Spacing Parameter

**Symptom**: First frame looks correct, subsequent frames are offset

**Cause**: Asset has gaps between frames that weren't specified

**Fix**: Add `spacing: N` to spritesheet config

### 3. Wrong Background Color for Nine-Slice

**Symptom**: Different color showing through transparent edges

**Cause**: Background fill color doesn't match asset's interior color

**Fix**: Sample color from center frame (frame 4), use per-asset config

### 4. Assuming Similar Assets Are Identical

**Symptom**: One variant works, another doesn't

**Cause**: Different assets in same pack may have different layouts

**Example**:
- Paper assets: 320×320, 106px frames, no spacing
- Wood Table: 448×448, 144px frames, 8px spacing

**Fix**: Inspect and configure each asset type individually

### 5. Internal Padding Inside Frames (“Side Bars”)

**Symptom**: Paper-like UI panels show opaque bands just inside the edges.

**Cause**: The art in each 3×3 cell is centered with transparent padding, so the edge tiles contribute interior fill when stretched.

**Fix**: Trim each tile to the actual painted bounds (alpha bbox), composite/cache a texture at the target size, and add a small overlap (≈1px, smoothing off) to avoid seams.

### 6. Scaling Discontinuous UI Art (Ribbons / Banners)

**Symptom**: A ribbon looks broken or the fill disappears when scaled.

**Cause**: The source row is actually three separate slices (left cap, center bar, right cap) with transparent gutters. Scaling the entire crop includes the gutters, making the UI look segmented or blank.

**Fix**: Treat it as a multi-slice (usually 3-slice). Draw left cap, stretched center, right cap into a canvas at the desired width; disable smoothing and include small seam overlaps so the stitched texture feels seamless.

```javascript
function createRibbonSlice(scene, srcKey, width, height, row, slices) {
  const key = `${srcKey}_3slice_${row}_${width}x${height}`;
  if (scene.textures.exists(key)) return key;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const sy = row * slices.frameH;
  const leftW = Math.round(slices.left.w * (height / slices.frameH));
  const rightW = Math.round(slices.right.w * (height / slices.frameH));
  const centerW = Math.max(1, width - leftW - rightW);
  const seam = 1;

  const src = scene.textures.get(srcKey).getSourceImage();
  ctx.drawImage(src, slices.left.x, sy, slices.left.w, slices.frameH, 0, 0, leftW + seam, height);
  ctx.drawImage(src, slices.center.x, sy, slices.center.w, slices.frameH, leftW - seam, 0, centerW + seam * 2, height);
  ctx.drawImage(src, slices.right.x, sy, slices.right.w, slices.frameH, leftW + centerW - seam, 0, rightW + seam, height);

  scene.textures.addCanvas(key, canvas);
  return key;
}
```

### 7. Assuming Uniform Frame Sizes Across Animations

**Symptom**: First animation (e.g., idle) looks correct, other animations (run, attack) are corrupted or shifted

**Cause**: Different animations of the same character often have different frame sizes to accommodate varying poses. A run cycle needs wider frames for the stride; an attack needs extra width for the weapon swing.

**Example**:
```
Boss Character Spritesheets:
- Idle:   64x80 pixels per frame (compact standing pose)
- Run:    80x80 pixels per frame (wider stride)
- Attack: 96x80 pixels per frame (extended sword swing)
```

**Fix**: Measure EACH animation spritesheet independently. Never assume frame width transfers between animations of the same character.

**How to verify**:
```
For each spritesheet:
  1. Open image, note total width
  2. Count frames visually
  3. Calculate: frameWidth = totalWidth / frameCount
  4. Verify result is a clean integer
```

---

## Debugging Spritesheets

### Raw Frame Visualization

Always include a test mode that displays extracted frames:

```javascript
showRawFrames(key, frameCount) {
  for (let i = 0; i < frameCount; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 100 + col * 120;
    const y = 100 + row * 120;

    this.add.image(x, y, key, i);
    this.add.text(x, y + 50, `${i}`, { fontSize: '12px' }).setOrigin(0.5);
  }
}
```

If frames look wrong here, the loader config is wrong. Fix it before proceeding.

### Animation Test Scene Pattern

For characters with multiple animation spritesheets, create a dedicated test scene to verify each animation in isolation before integrating into gameplay:

```javascript
// Access via URL parameter: ?scene=AnimTest
class AnimTestScene extends Phaser.Scene {
  private currentIndex = 0;
  private sprite: Phaser.GameObjects.Sprite;
  private label: Phaser.GameObjects.Text;

  // Define each animation's spritesheet config
  private spritesheets = [
    { key: "boss-idle", path: "assets/boss/idle.png", fw: 64, fh: 80, frames: 4 },
    { key: "boss-run", path: "assets/boss/run.png", fw: 80, fh: 80, frames: 8 },
    { key: "boss-attack", path: "assets/boss/attack.png", fw: 96, fh: 80, frames: 8 },
  ];

  preload() {
    this.spritesheets.forEach(s => {
      this.load.spritesheet(s.key, s.path, { frameWidth: s.fw, frameHeight: s.fh });
    });
  }

  create() {
    // Create animations
    this.spritesheets.forEach(s => {
      this.anims.create({
        key: `${s.key}-anim`,
        frames: this.anims.generateFrameNumbers(s.key, { start: 0, end: s.frames - 1 }),
        frameRate: 10,
        repeat: -1
      });
    });

    // Display sprite and info
    this.sprite = this.add.sprite(400, 300, this.spritesheets[0].key);
    this.sprite.play(`${this.spritesheets[0].key}-anim`);
    this.label = this.add.text(400, 450, '', { fontSize: '16px' }).setOrigin(0.5);
    this.updateLabel();

    // Arrow keys to cycle animations
    this.input.keyboard.on('keydown-LEFT', () => this.cycleAnim(-1));
    this.input.keyboard.on('keydown-RIGHT', () => this.cycleAnim(1));
  }

  cycleAnim(dir: number) {
    this.currentIndex = (this.currentIndex + dir + this.spritesheets.length) % this.spritesheets.length;
    const s = this.spritesheets[this.currentIndex];
    this.sprite.play(`${s.key}-anim`);
    this.updateLabel();
  }

  updateLabel() {
    const s = this.spritesheets[this.currentIndex];
    this.label.setText(`${s.key} | ${s.fw}x${s.fh} | ${s.frames} frames\n← → to cycle`);
  }
}
```

**Why this helps**: Isolating each animation reveals frame dimension errors immediately. A corrupted run animation is obvious when viewed alone, but may be missed in a busy game scene.

### Checklist When Frames Look Wrong

1. Open source asset in image editor
2. Measure actual frame dimensions
3. Check for gaps between frames
4. Check for padding around edges
5. Recalculate: does math add up to image dimensions?
6. Update loader with correct frameWidth, frameHeight, spacing, margin

---

## Asset Documentation Template

Document each spritesheet's structure:

```javascript
/**
 * UI Panel Assets - Tiny Swords Pack
 *
 * Regular Paper: 320×320, 3×3 grid, 106px frames, no spacing
 * Special Paper: 320×320, 3×3 grid, 106px frames, no spacing
 * Wood Table:    448×448, 3×3 grid, 144px frames, 8px spacing
 *
 * All use nine-slice layout:
 *   [0][1][2]  corners=0,2,6,8 (don't scale)
 *   [3][4][5]  edges=1,3,5,7 (stretch one axis)
 *   [6][7][8]  center=4 (scales both axes)
 */
```

---

## Remember

- **Measure the asset** before writing loader code
- **Different assets need different configs** even in the same pack
- **Test raw frames first** before building complex UI
- **Document asset parameters** for future reference
- A few pixels off cascades into completely broken rendering
