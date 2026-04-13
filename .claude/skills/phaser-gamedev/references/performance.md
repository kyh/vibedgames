# Performance Optimization

Strategies for maintaining smooth 60fps in Phaser 3 games.

## Object Pooling

The most impactful optimization for games with many spawning/despawning objects.

### Why Pool?

Creating/destroying objects causes:
- Memory allocation overhead
- Garbage collection pauses (stutters)
- Texture rebinding costs

### Implementation Pattern

```javascript
class BulletPool {
  constructor(scene) {
    this.scene = scene;
    this.pool = scene.physics.add.group({
      defaultKey: 'bullet',
      maxSize: 100,
      runChildUpdate: true
    });
  }

  spawn(x, y, velocityX, velocityY) {
    const bullet = this.pool.get(x, y);

    if (!bullet) return null;  // Pool exhausted

    bullet.setActive(true);
    bullet.setVisible(true);
    bullet.body.enable = true;
    bullet.body.reset(x, y);
    bullet.setVelocity(velocityX, velocityY);

    return bullet;
  }

  kill(bullet) {
    bullet.setActive(false);
    bullet.setVisible(false);
    bullet.body.enable = false;
    bullet.body.stop();
  }
}

// Usage
this.bulletPool = new BulletPool(this);

// Spawn
const bullet = this.bulletPool.spawn(player.x, player.y, 500, 0);

// Kill (in collision callback or update)
this.bulletPool.kill(bullet);
```

### Built-in Group Pooling

```javascript
// Configure group for pooling
const enemies = this.physics.add.group({
  maxSize: 50,
  classType: Enemy,
  createCallback: (enemy) => {
    enemy.setName('enemy' + enemies.getLength());
  },
  removeCallback: (enemy) => {
    enemy.setName('');
  }
});

// Get inactive member (or create if under maxSize)
const enemy = enemies.get(x, y);

// Return to pool (don't destroy)
enemy.setActive(false);
enemy.setVisible(false);
```

## Texture Atlases

Combine sprites into atlases to reduce draw calls.

### Why Atlases?

- Single texture bind per atlas
- Reduced HTTP requests
- Better GPU memory usage

### Using TexturePacker

Export as Phaser 3 JSON Hash format.

```javascript
// Load atlas
this.load.atlas('sprites', 'atlas/sprites.png', 'atlas/sprites.json');

// Use frames
this.add.sprite(x, y, 'sprites', 'player-idle-1');

// Animation from atlas
this.anims.create({
  key: 'walk',
  frames: this.anims.generateFrameNames('sprites', {
    prefix: 'player-walk-',
    start: 1,
    end: 8,
    zeroPad: 2
  }),
  frameRate: 10,
  repeat: -1
});
```

## Camera Culling

Only render what's visible.

### Automatic Culling

Phaser culls off-camera objects by default for:
- Sprites
- Images
- TileSprites

Disable if needed:
```javascript
sprite.setScrollFactor(0);  // Fixed to camera (no culling)
```

### Manual Culling for Custom Objects

```javascript
update() {
  const cam = this.cameras.main;
  const bounds = cam.worldView;

  this.enemies.children.iterate(enemy => {
    if (Phaser.Geom.Rectangle.Contains(bounds, enemy.x, enemy.y)) {
      enemy.setActive(true);
      enemy.setVisible(true);
    } else {
      enemy.setActive(false);
      enemy.setVisible(false);
    }
  });
}
```

## Physics Optimization

### Reduce Collision Checks

```javascript
// Only check relevant collisions
this.physics.add.collider(player, groundLayer);
this.physics.add.collider(enemies, groundLayer);
this.physics.add.overlap(player, enemies, hitEnemy);

// DON'T: enemies vs enemies if not needed
// this.physics.add.collider(enemies, enemies);
```

### Disable Physics When Not Needed

```javascript
// Disable body temporarily
sprite.body.enable = false;

// Re-enable
sprite.body.enable = true;

// For off-screen objects
if (!cam.worldView.contains(enemy.x, enemy.y)) {
  enemy.body.enable = false;
} else {
  enemy.body.enable = true;
}
```

### Use Spatial Hash for Many Objects

```javascript
physics: {
  arcade: {
    useTree: true,      // Enable quadtree (default)
    maxEntries: 16      // Tune for your object count
  }
}

// For >5000 dynamic bodies, disable tree
// useTree: false
```

### Simplify Collision Shapes

```javascript
// Use circles for round objects (faster than rectangles)
sprite.body.setCircle(16);

// Reduce body size for tighter collisions
sprite.body.setSize(24, 32);  // Smaller than sprite
```

## Rendering Optimization

### Batch Similar Sprites

Group sprites using same texture for batching:

```javascript
// Good: All use same atlas
const coins = this.add.group({
  key: 'atlas',
  frame: 'coin',
  repeat: 100
});

// Bad: Mixed textures break batching
```

### Reduce Blend Modes

```javascript
// Normal blend mode is fastest
sprite.setBlendMode(Phaser.BlendModes.NORMAL);

// Avoid if possible:
// - ADD, MULTIPLY, SCREEN cause extra draw calls
```

### Use Static Images for Backgrounds

```javascript
// TileSprite for repeating backgrounds (efficient)
this.add.tileSprite(0, 0, 800, 600, 'background').setOrigin(0);

// Don't animate large backgrounds in update()
```

### Limit Particle Count

```javascript
const emitter = this.add.particles(x, y, 'particle', {
  speed: 100,
  lifespan: 500,
  quantity: 2,       // Particles per emit
  maxParticles: 100, // Hard limit
  frequency: 50      // ms between emits
});
```

## Memory Management

### Destroy Unused Objects

```javascript
// Properly destroy sprites
sprite.destroy();

// Clear groups
group.clear(true, true);  // Remove from scene, destroy

// Scene cleanup
shutdown() {
  this.enemies.destroy(true);
  this.bulletPool.destroy(true);
}
```

### Unload Unused Assets

```javascript
// Remove texture
this.textures.remove('unused-texture');

// Remove audio
this.sound.remove('unused-sound');

// In scene shutdown
shutdown() {
  this.cache.tilemap.remove('level1');
}
```

### Monitor Memory

```javascript
// Check texture memory (approximate)
console.log(this.textures.list);

// Chrome DevTools:
// - Memory tab for heap snapshots
// - Performance tab for frame timing
```

## Update Loop Optimization

### Throttle Expensive Operations

```javascript
create() {
  this.lastAIUpdate = 0;
  this.aiUpdateInterval = 100; // ms
}

update(time, delta) {
  // Every frame (required for smooth movement)
  this.updatePlayerMovement();

  // Throttled (AI, pathfinding)
  if (time - this.lastAIUpdate > this.aiUpdateInterval) {
    this.updateEnemyAI();
    this.lastAIUpdate = time;
  }
}
```

### Avoid Creating Objects in Update

```javascript
// BAD: Creates new object every frame
update() {
  const velocity = { x: 100, y: 0 };  // GC pressure
  sprite.setVelocity(velocity.x, velocity.y);
}

// GOOD: Reuse or use primitives
update() {
  sprite.setVelocity(100, 0);
}

// Or pre-create
create() {
  this.tempVec = new Phaser.Math.Vector2();
}

update() {
  this.tempVec.set(100, 0);
  sprite.body.velocity.copy(this.tempVec);
}
```

### Use Delta Time

```javascript
// Framerate-independent movement
update(time, delta) {
  const speed = 200;  // pixels per second
  sprite.x += speed * (delta / 1000);
}
```

## Profiling

### Built-in Stats

```javascript
const config = {
  // ...
  fps: {
    target: 60,
    forceSetTimeOut: false,
    smoothStep: true
  }
};

// Add FPS display
this.add.text(10, 10, '', { fontSize: '16px' }).setScrollFactor(0);
this.fpsText = this.add.text(10, 10, '');

update() {
  this.fpsText.setText('FPS: ' + Math.round(this.game.loop.actualFps));
}
```

### Chrome DevTools

1. **Performance Tab**: Record gameplay, identify frame drops
2. **Memory Tab**: Track heap size, find leaks
3. **Console**: `Phaser.GAMES[0].loop.actualFps`

### Common Bottlenecks

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Gradual slowdown | Memory leak | Check destroy() calls |
| Periodic stutters | GC pauses | Object pooling |
| Low FPS always | Too many objects | Culling, pooling |
| Spikes on spawn | Object creation | Pre-pool objects |
| Slow collisions | Too many checks | Spatial partitioning |

## Quick Wins Checklist

- [ ] Use texture atlases (not individual images)
- [ ] Pool frequently spawned objects
- [ ] Disable physics for off-screen objects
- [ ] Use appropriate physics shapes (circles are faster)
- [ ] Throttle AI/pathfinding updates
- [ ] Avoid object creation in update loop
- [ ] Use delta time for movement
- [ ] Destroy objects when done
- [ ] Limit particle counts
- [ ] Profile before optimizing
