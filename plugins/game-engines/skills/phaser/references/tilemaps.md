# Tilemaps Reference

Comprehensive expert guide for Phaser 3 tilemap integration with Tiled Map Editor.

---

## Tiled Map Editor Fundamentals

### Tileset Types

| Type | Description | Use Case |
|------|-------------|----------|
| **Image-based** | Single image with fixed tile size, margin, spacing | Standard tilesets, consistent tile sizes |
| **Collection-based** | Each tile is separate image file | Variable-size tiles, sprites as tiles |

### Layer Types

| Layer | Purpose | Phaser Access |
|-------|---------|---------------|
| **Tile Layer** | Grid-based tile storage with flip flags | `map.createLayer()` |
| **Object Layer** | Free-positioned shapes, points, polygons, tile objects | `map.getObjectLayer()` |
| **Image Layer** | Background/foreground images with repeat | `map.images` array |
| **Group Layer** | Hierarchical organization | Flattened on export |

### Recommended Layer Structure (Top to Bottom in Tiled)

```
Foreground      (renders above player, depth: 10+)
├── Trees-Top
├── Roof-Tops
Objects         (spawn points, triggers, collision zones)
├── Enemies
├── Collectibles
├── Triggers
Player-Ref      (reference layer, not exported)
Ground          (main collision layer)
├── Platforms
├── Walls
Background      (decoration, no collision)
├── Decorations
├── Parallax-Far
├── Parallax-Near
```

---

## Tiled JSON Format Structure

Understanding the JSON format is critical for debugging and advanced manipulation.

### Map Root Object

```javascript
{
  "width": 100,              // Map width in tiles
  "height": 50,              // Map height in tiles
  "tilewidth": 16,           // Tile width in pixels
  "tileheight": 16,          // Tile height in pixels
  "orientation": "orthogonal", // "orthogonal", "isometric", "staggered", "hexagonal"
  "renderorder": "right-down",
  "infinite": false,
  "layers": [...],           // Array of layer objects
  "tilesets": [...],         // Array of tileset references
  "properties": [...]        // Custom map properties
}
```

### Layer Object

```javascript
{
  "type": "tilelayer",       // "tilelayer", "objectgroup", "imagelayer", "group"
  "name": "Ground",
  "id": 1,
  "data": [1, 2, 0, 5, ...], // Global Tile IDs (GIDs) - tilelayer only
  "width": 100,
  "height": 50,
  "x": 0, "y": 0,
  "offsetx": 0, "offsety": 0,
  "opacity": 1,
  "visible": true,
  "parallaxx": 1,            // Parallax factor X (1 = normal scroll)
  "parallaxy": 1,            // Parallax factor Y
  "tintcolor": "#ffffff",    // Layer tint color
  "properties": [...]
}
```

### Tileset Reference

```javascript
{
  "firstgid": 1,             // First Global ID for this tileset
  "source": "terrain.tsx",   // External tileset file (or inline)
  "name": "terrain",
  "tilewidth": 16,
  "tileheight": 16,
  "tilecount": 256,
  "columns": 16,
  "margin": 0,               // Border around tileset image
  "spacing": 0,              // Gap between tiles
  "image": "terrain.png",
  "imagewidth": 256,
  "imageheight": 256
}
```

---

## Global Tile IDs (GIDs)

Critical concept for understanding tilemap data.

### How GIDs Work

- **GID 0** = Empty tile
- **GID 1+** = References tiles across all tilesets
- Each tileset has a `firstgid` - the GID of its first tile (local ID 0)
- **Local ID** = GID - tileset.firstgid

### Flip Flags (Stored in High Bits)

```javascript
const FLIPPED_HORIZONTALLY = 0x80000000;  // Bit 32
const FLIPPED_VERTICALLY   = 0x40000000;  // Bit 31
const FLIPPED_DIAGONALLY   = 0x20000000;  // Bit 30 (rotation)
const ROTATED_HEX_120      = 0x10000000;  // Bit 29 (hexagonal only)

// Extract flags then clear them
function parseGID(rawGid) {
  const flipH = (rawGid & FLIPPED_HORIZONTALLY) !== 0;
  const flipV = (rawGid & FLIPPED_VERTICALLY) !== 0;
  const flipD = (rawGid & FLIPPED_DIAGONALLY) !== 0;
  const gid = rawGid & ~(0xF0000000);  // Clear all flags
  return { gid, flipH, flipV, flipD };
}
```

### Mapping GID to Tileset

```javascript
// Example tilesets in map:
// TilesetA: firstgid=1, tilecount=64   → GIDs 1-64
// TilesetB: firstgid=65, tilecount=50  → GIDs 65-114
// TilesetC: firstgid=115, tilecount=100 → GIDs 115-214

function findTileset(gid, tilesets) {
  // Find tileset with largest firstgid <= gid
  for (let i = tilesets.length - 1; i >= 0; i--) {
    if (tilesets[i].firstgid <= gid) {
      return {
        tileset: tilesets[i],
        localId: gid - tilesets[i].firstgid
      };
    }
  }
  return null;
}
```

---

## Loading Tilemaps in Phaser

### JSON Format (Recommended)

```javascript
preload() {
  // Load tilemap JSON (exported from Tiled)
  this.load.tilemapTiledJSON('level1', 'assets/tilemaps/level1.json');

  // Load tileset image(s)
  this.load.image('tiles', 'assets/tilesets/tileset.png');

  // For multiple tilesets
  this.load.image('terrain', 'assets/tilesets/terrain.png');
  this.load.image('props', 'assets/tilesets/props.png');
}
```

### CSV Format

```javascript
preload() {
  this.load.tilemapCSV('map', 'assets/map.csv');
  this.load.image('tiles', 'assets/tileset.png');
}

create() {
  // Must specify tile dimensions for CSV
  const map = this.make.tilemap({
    key: 'map',
    tileWidth: 16,
    tileHeight: 16
  });
}
```

### Extruded Tilesets (Prevent Bleeding)

When tiles show thin lines between them, use extruded tilesets:

```javascript
// Tileset was extruded by 1px (use tile-extruder tool)
// margin: 1 (border around entire image)
// spacing: 2 (gap between tiles = 2 * extrusion)
const tileset = map.addTilesetImage('tileset-name', 'tiles', 16, 16, 1, 2);
```

---

## Creating the Map

### Basic Setup

```javascript
create() {
  // Create tilemap from loaded JSON
  const map = this.make.tilemap({ key: 'level1' });

  // Add tileset image (name MUST match Tiled tileset name exactly!)
  const tileset = map.addTilesetImage('tileset-name-in-tiled', 'tiles');

  // Create layers (names MUST match Tiled layer names)
  const bgLayer = map.createLayer('Background', tileset, 0, 0);
  const groundLayer = map.createLayer('Ground', tileset, 0, 0);
  const fgLayer = map.createLayer('Foreground', tileset, 0, 0);

  // Set depth for render order
  bgLayer.setDepth(0);
  groundLayer.setDepth(5);
  fgLayer.setDepth(10);  // Renders above player
}
```

### Multiple Tilesets Per Layer

```javascript
const terrainTileset = map.addTilesetImage('terrain', 'terrain-img');
const propsTileset = map.addTilesetImage('props', 'props-img');
const decorTileset = map.addTilesetImage('decorations', 'decor-img');

// Layer can use array of tilesets
const groundLayer = map.createLayer('Ground', [
  terrainTileset,
  propsTileset,
  decorTileset
]);
```

### Layer Properties

```javascript
// Scale
layer.setScale(2);  // 2x zoom
layer.setScale(1, 0.5);  // Different X/Y scale

// Position offset
layer.setPosition(100, 50);

// Alpha/visibility
layer.setAlpha(0.8);
layer.setVisible(false);

// Tint (multiply color)
layer.setTint(0xff8888);  // Reddish tint

// Scroll factor (parallax)
layer.setScrollFactor(0.5);  // Scrolls at 50% camera speed
```

---

## Collision Setup

### By Custom Property (Recommended)

Set properties in Tiled: Tileset Editor → Select tile → Add Property

```javascript
// Collide tiles with "collides: true" property
groundLayer.setCollisionByProperty({ collides: true });

// Multiple property conditions (AND logic)
groundLayer.setCollisionByProperty({
  solid: true,
  type: 'wall'
});

// Array of possible values (OR logic for that property)
groundLayer.setCollisionByProperty({
  collides: true,
  type: ['wall', 'platform', 'ground']
});
```

### By Tile Index

```javascript
// Single tile index
groundLayer.setCollision(1);

// Multiple specific tiles
groundLayer.setCollision([1, 2, 3, 4, 5]);

// Range of tiles (inclusive)
groundLayer.setCollisionBetween(1, 100);

// All tiles EXCEPT these (good for empty tiles)
groundLayer.setCollisionByExclusion([-1, 0]);
```

### One-Way Platforms

```javascript
// Only collide from above
groundLayer.forEachTile(tile => {
  if (tile.properties.oneWay) {
    tile.collideDown = false;
    tile.collideLeft = false;
    tile.collideRight = false;
  }
});
```

### Physics Collider

```javascript
// Basic collision
this.physics.add.collider(player, groundLayer);

// With callback
this.physics.add.collider(player, hazardLayer, this.onHazardHit, null, this);

onHazardHit(player, tile) {
  console.log('Hit hazard at tile', tile.x, tile.y);
  console.log('Tile properties:', tile.properties);
  player.damage(tile.properties.damage || 10);
}

// Tile index callback (triggers when stepping on specific tiles)
groundLayer.setTileIndexCallback([77, 78], (sprite, tile) => {
  console.log('Stepped on special tile!');
  return true;  // Return true to allow collision processing
}, this);

// Location callback (specific tile coordinates)
groundLayer.setTileLocationCallback(10, 5, 3, 3, (sprite, tile) => {
  console.log('Entered trigger zone!');
}, this);
```

### Matter.js Collision

```javascript
// Convert tilemap layer to Matter bodies
this.matter.world.convertTilemapLayer(groundLayer);

// With custom collision shapes from Tiled
// (Set collision shapes in Tileset → Tile Collision Editor)
this.matter.world.convertTilemapLayer(groundLayer, {
  // Options
});
```

---

## Object Layers

### Reading Objects

```javascript
// Get entire object layer
const objectLayer = map.getObjectLayer('Objects');
const objects = objectLayer.objects;

objects.forEach(obj => {
  console.log(obj.name, obj.type);  // Name and class/type
  console.log(obj.x, obj.y);        // Position (pixels)
  console.log(obj.width, obj.height);  // Size
  console.log(obj.rotation);        // Rotation in degrees
  console.log(obj.properties);      // Custom properties array
});

// Find specific object by name
const spawnPoint = map.findObject('Objects', obj => obj.name === 'PlayerSpawn');
if (spawnPoint) {
  player.setPosition(spawnPoint.x, spawnPoint.y);
}

// Filter objects by type/class
const enemies = map.filterObjects('Enemies', obj => obj.type === 'goblin');
const triggers = map.filterObjects('Objects', obj => obj.type === 'trigger');
```

### Accessing Custom Properties

Properties in Tiled are stored as array of `{name, type, value}`:

```javascript
const door = map.findObject('Objects', o => o.name === 'door');

// Helper function to get property value
function getProperty(obj, propName) {
  if (!obj.properties) return undefined;
  const prop = obj.properties.find(p => p.name === propName);
  return prop ? prop.value : undefined;
}

const isLocked = getProperty(door, 'locked');       // boolean
const requiredKey = getProperty(door, 'keyType');   // string
const damage = getProperty(door, 'damage');         // int/float
```

### Creating Sprites from Objects

```javascript
// Create sprites from object layer
const coins = map.createFromObjects('Collectibles', {
  name: 'coin',           // Object name in Tiled
  key: 'coin',            // Texture key in Phaser
  classType: Phaser.Physics.Arcade.Sprite  // Optional custom class
});

// Enable physics on created sprites
coins.forEach(coin => {
  this.physics.add.existing(coin);
  coin.body.setAllowGravity(false);
  coin.body.setImmovable(true);
});

// With custom class
class Goblin extends Phaser.Physics.Arcade.Sprite {
  constructor(scene, x, y, texture) {
    super(scene, x, y, texture);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.health = 100;
  }
}

const enemies = map.createFromObjects('Enemies', {
  name: 'goblin',
  key: 'goblin',
  classType: Goblin
});
```

### Object Shapes

```javascript
map.getObjectLayer('Collision').objects.forEach(obj => {
  if (obj.rectangle) {
    // Rectangle: use obj.x, obj.y, obj.width, obj.height
    this.physics.add.existing(
      this.add.zone(obj.x + obj.width/2, obj.y + obj.height/2, obj.width, obj.height)
    );
  }

  if (obj.ellipse) {
    // Ellipse: use same properties, but it's circular/elliptical
  }

  if (obj.polygon) {
    // Polygon: obj.polygon is array of {x, y} points
    const points = obj.polygon.map(p => `${p.x} ${p.y}`).join(' ');
  }

  if (obj.polyline) {
    // Polyline: obj.polyline is array of {x, y} points (open path)
  }

  if (obj.point) {
    // Point: just obj.x, obj.y (no size)
  }

  if (obj.gid) {
    // Tile object: references a tile from tileset
  }
});
```

---

## Tile Manipulation

### Get/Set Tiles

```javascript
// Get tile at world coordinates
const tile = groundLayer.getTileAtWorldXY(pointer.worldX, pointer.worldY);

// Get tile at tile coordinates
const tile = groundLayer.getTileAt(tileX, tileY);
const tile = map.getTileAt(tileX, tileY, true, 'Ground');  // true = include empty

// Check if tile exists
if (tile && tile.index !== -1) {
  console.log('Tile exists:', tile.index);
}

// Place tile
groundLayer.putTileAt(tileIndex, tileX, tileY);
groundLayer.putTileAtWorldXY(tileIndex, worldX, worldY);

// Remove tile
groundLayer.removeTileAt(tileX, tileY);
groundLayer.removeTileAtWorldXY(worldX, worldY);

// Replace all instances of a tile
groundLayer.replaceByIndex(oldIndex, newIndex);

// Swap two tile types
groundLayer.swapByIndex(indexA, indexB);
```

### Fill and Randomize

```javascript
// Fill rectangular area
groundLayer.fill(tileIndex, startX, startY, width, height);

// Randomize area with equal probability
groundLayer.randomize(x, y, width, height, [1, 2, 3, 4]);

// Weighted randomize
groundLayer.weightedRandomize(x, y, width, height, [
  { index: 1, weight: 10 },   // Grass (common)
  { index: 2, weight: 3 },    // Flower (uncommon)
  { index: 3, weight: 1 }     // Mushroom (rare)
]);

// Copy region
groundLayer.copy(srcX, srcY, width, height, destX, destY);

// Shuffle tiles in region
groundLayer.shuffle(x, y, width, height);
```

### Tile Properties

```javascript
if (tile) {
  // Position
  console.log(tile.x, tile.y);           // Tile coordinates
  console.log(tile.pixelX, tile.pixelY); // World position (top-left)
  console.log(tile.getCenterX(), tile.getCenterY());  // Center position

  // Dimensions
  console.log(tile.width, tile.height);  // Tile size
  console.log(tile.baseWidth, tile.baseHeight);  // Map's base tile size

  // Identity
  console.log(tile.index);               // Tile index (-1 = empty)
  console.log(tile.tileset);             // Tileset reference
  console.log(tile.properties);          // Custom properties from Tiled

  // Collision
  console.log(tile.canCollide);          // Has any collision
  console.log(tile.collideLeft, tile.collideRight);
  console.log(tile.collideUp, tile.collideDown);
  console.log(tile.faceLeft, tile.faceRight);  // Interesting faces

  // Rendering
  tile.alpha = 0.5;
  tile.tint = 0xff0000;
  tile.flipX = true;
  tile.flipY = true;
  tile.rotation = Math.PI / 4;
  tile.visible = false;
}
```

### Iterate Tiles

```javascript
// Process all tiles in layer
groundLayer.forEachTile(tile => {
  if (tile.properties.spawnEnemy) {
    spawnEnemy(tile.getCenterX(), tile.getCenterY());
    groundLayer.removeTileAt(tile.x, tile.y);
  }
});

// With filter options
groundLayer.forEachTile(callback, context,
  startX, startY, width, height,
  { isNotEmpty: true }  // Only non-empty tiles
);

// Get tiles in area
const tiles = groundLayer.getTilesWithin(x, y, width, height);
const tiles = groundLayer.getTilesWithinWorldXY(worldX, worldY, width, height);

// Get tiles in shape
const rect = new Phaser.Geom.Rectangle(100, 100, 200, 150);
const tiles = groundLayer.getTilesWithinShape(rect);

// Filter tiles
const waterTiles = groundLayer.filterTiles(tile =>
  tile.properties.type === 'water'
);
```

---

## Camera and World Bounds

```javascript
// Map dimensions
console.log(map.widthInPixels, map.heightInPixels);
console.log(map.width, map.height);  // In tiles

// Set physics world bounds to map size
this.physics.world.setBounds(0, 0, map.widthInPixels, map.heightInPixels);

// Camera bounds
this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);

// Follow player with lerp (smoothing)
this.cameras.main.startFollow(player, true, 0.1, 0.1);

// Deadzone (player can move in center without camera moving)
this.cameras.main.setDeadzone(200, 100);

// Round pixels (prevents tile seams at fractional positions)
this.cameras.main.roundPixels = true;
```

---

## Parallax Scrolling

### In Tiled

Set `parallaxx` and `parallaxy` properties on layers:
- **1.0** = Normal scroll speed (default)
- **0.5** = Half speed (appears farther away)
- **0.0** = Fixed (doesn't scroll)
- **1.5** = Faster than camera (foreground effect)

### In Phaser

```javascript
// Set scroll factor on tilemap layers
skyLayer.setScrollFactor(0);        // Fixed background
cloudsLayer.setScrollFactor(0.2);   // Very slow
mountainsLayer.setScrollFactor(0.5); // Half speed
groundLayer.setScrollFactor(1);     // Normal (default)
foregroundLayer.setScrollFactor(1.2); // Slightly faster

// For non-tilemap backgrounds (tileSprite for infinite repeat)
const bg = this.add.tileSprite(0, 0,
  this.cameras.main.width,
  this.cameras.main.height,
  'background'
);
bg.setOrigin(0, 0);
bg.setScrollFactor(0);  // Fixed position

// Update in update() for parallax effect
update() {
  bg.tilePositionX = this.cameras.main.scrollX * 0.3;
  bg.tilePositionY = this.cameras.main.scrollY * 0.3;
}
```

### Parallax Reference Point

Tiled uses parallax origin (default 0,0) and view center distance:
- When parallax origin == view center: no parallax effect
- Distance × parallax factor = layer offset

---

## Animated Tiles

Phaser doesn't natively support Tiled tile animations. Solutions:

### Manual Animation

```javascript
// Define water animation frames
const WATER_FRAMES = [10, 11, 12, 13];
let waterFrameIndex = 0;

// Timer to cycle frames
this.time.addEvent({
  delay: 200,  // ms per frame
  callback: () => {
    waterFrameIndex = (waterFrameIndex + 1) % WATER_FRAMES.length;
    const newIndex = WATER_FRAMES[waterFrameIndex];

    waterLayer.forEachTile(tile => {
      if (WATER_FRAMES.includes(tile.index)) {
        tile.index = newIndex;
      }
    });
  },
  loop: true
});
```

### Replace with Sprites

```javascript
// Replace animated tiles with actual sprites
groundLayer.forEachTile(tile => {
  if (tile.properties.animated) {
    const sprite = this.add.sprite(
      tile.getCenterX(),
      tile.getCenterY(),
      'animatedTiles'
    );
    sprite.anims.play(tile.properties.animKey);
    groundLayer.removeTileAt(tile.x, tile.y);
  }
});
```

### Plugin: phaser-animated-tiles

```javascript
// Use community plugin for automatic Tiled animation support
// https://github.com/nkholski/phaser-animated-tiles
this.load.scenePlugin('AnimatedTiles', AnimatedTiles, 'animatedTiles', 'animatedTiles');

create() {
  const map = this.make.tilemap({ key: 'map' });
  // ... create layers
  this.animatedTiles.init(map);
}
```

---

## Procedural Tilemaps

### Create Blank Map

```javascript
// Create empty tilemap
const map = this.make.tilemap({
  tileWidth: 32,
  tileHeight: 32,
  width: 100,
  height: 50
});

// Add tileset
const tileset = map.addTilesetImage('tiles');

// Create blank layer
const layer = map.createBlankLayer('Ground', tileset);

// Fill programmatically
for (let x = 0; x < map.width; x++) {
  for (let y = 0; y < map.height; y++) {
    if (y === map.height - 1) {
      layer.putTileAt(1, x, y);  // Ground
    } else if (y === map.height - 2 && Math.random() < 0.3) {
      layer.putTileAt(2, x, y);  // Grass decoration
    }
  }
}

// Set collision
layer.setCollision([1]);
```

### Cellular Automata Cave

```javascript
function generateCave(width, height, fillPercent, iterations) {
  // Initialize with random
  let grid = Array(height).fill(null).map(() =>
    Array(width).fill(null).map(() =>
      Math.random() < fillPercent ? 1 : 0
    )
  );

  // Run cellular automata
  for (let i = 0; i < iterations; i++) {
    grid = iterate(grid);
  }

  return grid;
}

function iterate(grid) {
  const newGrid = grid.map(row => [...row]);

  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[0].length; x++) {
      const neighbors = countNeighbors(grid, x, y);
      if (neighbors > 4) newGrid[y][x] = 1;
      else if (neighbors < 4) newGrid[y][x] = 0;
    }
  }

  return newGrid;
}

// Apply to tilemap
const caveData = generateCave(100, 50, 0.45, 5);
caveData.forEach((row, y) => {
  row.forEach((cell, x) => {
    layer.putTileAt(cell === 1 ? WALL_TILE : FLOOR_TILE, x, y);
  });
});
```

---

## Debugging Tilemaps

### Visual Debug

```javascript
// Debug collision tiles
const debugGraphics = this.add.graphics();
groundLayer.renderDebug(debugGraphics, {
  tileColor: null,  // Non-colliding tiles (null = don't render)
  collidingTileColor: new Phaser.Display.Color(243, 134, 48, 200),
  faceColor: new Phaser.Display.Color(40, 39, 37, 255)  // Collision edges
});

// Toggle with key
this.input.keyboard.on('keydown-D', () => {
  debugGraphics.visible = !debugGraphics.visible;
});
```

### Tile Coordinates Overlay

```javascript
groundLayer.forEachTile(tile => {
  if (tile.index !== -1) {
    this.add.text(tile.pixelX + 2, tile.pixelY + 2,
      `${tile.x},${tile.y}`,
      { fontSize: '8px', color: '#00ff00' }
    ).setDepth(1000);
  }
});
```

### Console Logging

```javascript
// Log tile on click
this.input.on('pointerdown', (pointer) => {
  const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
  const tile = groundLayer.getTileAtWorldXY(worldPoint.x, worldPoint.y);

  if (tile) {
    console.log('Clicked tile:', {
      index: tile.index,
      position: { x: tile.x, y: tile.y },
      worldPos: { x: tile.pixelX, y: tile.pixelY },
      properties: tile.properties,
      collides: tile.canCollide,
      tileset: tile.tileset?.name
    });
  }
});
```

---

## Terrain Auto-Tiling (Tiled Feature)

Tiled's Terrain Sets enable automatic tile selection for natural-looking maps.

### Terrain Set Types

| Type | Description | Complete Set Size |
|------|-------------|-------------------|
| **Corner** | Matches at corners | 16 tiles (2 terrains) |
| **Edge** | Matches at sides (roads, fences) | 16 tiles (2 terrains) |
| **Mixed** | Both corners and edges | 256 tiles (2 terrains) |

### Workflow

1. In Tiled Tileset Editor, enable Terrain Sets mode
2. Create terrain set, add terrain types
3. Paint terrain labels on tile corners/edges
4. Use Terrain Brush on map to auto-select correct tiles

### Probability

- Set `probability` on tiles for weighted random selection
- Lower probability = less frequent (decorations, variations)
- Set probability to 0 to exclude from auto-selection but still recognize

---

## Performance Tips

1. **Use Static Layers**: If tiles don't change, layer is faster
2. **Cull Off-Screen**: Phaser automatically culls, but verify with large maps
3. **Limit Layer Count**: Merge purely visual layers when possible
4. **Use Texture Atlas**: Combine tilesets into single atlas
5. **Object Pooling**: Reuse sprites created from object layers
6. **Chunk Large Maps**: Split very large maps into loadable chunks

```javascript
// Check if layer is being culled efficiently
console.log('Visible tiles:', layer.culledTiles.length);

// Force specific culling bounds
layer.setCullPadding(2, 2);  // Extra tiles around viewport
```

---

## Quick Reference

### Map Properties

```javascript
map.width / map.height           // Size in tiles
map.widthInPixels / map.heightInPixels  // Size in pixels
map.tileWidth / map.tileHeight   // Tile size
map.layers                       // All layers
map.tilesets                     // All tilesets
map.properties                   // Custom properties
```

### Essential Layer Methods

```javascript
// Creation
map.createLayer(name, tileset, x, y)
map.createBlankLayer(name, tileset, x, y, width, height)

// Collision
layer.setCollision(indexes)
layer.setCollisionBetween(start, end)
layer.setCollisionByProperty({ prop: value })
layer.setCollisionByExclusion([-1])

// Tiles
layer.getTileAt(x, y)
layer.getTileAtWorldXY(worldX, worldY)
layer.putTileAt(index, x, y)
layer.removeTileAt(x, y)
layer.fill(index, x, y, w, h)
layer.forEachTile(callback)

// Rendering
layer.setDepth(n)
layer.setScrollFactor(x, y)
layer.setAlpha(a)
layer.setTint(color)
layer.setScale(x, y)
```

### Object Layer Methods

```javascript
map.getObjectLayer(name)
map.findObject(layerName, callback)
map.filterObjects(layerName, callback)
map.createFromObjects(layerName, config)
```
