# GLTF Loading Guide for Three.js

Modern patterns for loading, managing, and displaying 3D models in Three.js applications.

---

## Quick Start: The Minimal Pattern

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GLTF Loader</title>
    <style>
        * { margin: 0; padding: 0; }
        body { overflow: hidden; background: #000; }
        canvas { display: block; }
    </style>
</head>
<body>
    <script type="importmap">
    {
        "imports": {
            "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
            "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
        }
    }
    </script>

    <script type="module">
        import * as THREE from 'three';
        import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

        // Scene setup
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer({ antialias: true });

        renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(renderer.domElement);

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(5, 10, 7);
        scene.add(directionalLight);

        // Load model
        const loader = new GLTFLoader();
        loader.load(
            'path/to/model.gltf',
            (gltf) => {
                console.log('Model loaded:', gltf);
                scene.add(gltf.scene);
                camera.position.z = 5;
            },
            (progress) => {
                console.log((progress.loaded / progress.total * 100).toFixed(0) + '%');
            },
            (error) => {
                console.error('Failed to load model:', error);
            }
        );

        // Animation loop
        renderer.setAnimationLoop(() => {
            renderer.render(scene, camera);
        });

        // Handle resize
        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });
    </script>
</body>
</html>
```

---

## Core Concepts

### Import Maps (Essential for ES Modules)

Always use import maps to resolve Three.js module paths correctly:

```html
<script type="importmap">
{
    "imports": {
        "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
        "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
    }
}
</script>
```

This allows clean imports:
```javascript
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
```

---

## Pattern 1: Basic Loading

Simplest approach - load a single model and display it.

```javascript
const loader = new GLTFLoader();

loader.load(
    'models/character.gltf',
    (gltf) => {
        // Success callback
        const model = gltf.scene;

        // Optional: enable shadows
        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        scene.add(model);
    },
    (progress) => {
        // Progress callback (optional)
        const percentComplete = (progress.loaded / progress.total * 100);
        console.log(percentComplete + '% loaded');
    },
    (error) => {
        // Error callback
        console.error('Failed to load model:', error);
    }
);
```

---

## Pattern 2: Promise-Based Loading

For cleaner async/await syntax and easier error handling:

```javascript
const loader = new GLTFLoader();

function loadModel(path) {
    return new Promise((resolve, reject) => {
        loader.load(
            path,
            (gltf) => {
                gltf.scene.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });
                resolve(gltf.scene);
            },
            (progress) => {
                const pct = (progress.loaded / progress.total * 100).toFixed(0);
                console.log(`Loading: ${pct}%`);
            },
            (error) => {
                console.error('Load error:', error);
                reject(error);
            }
        );
    });
}

// Usage
async function init() {
    try {
        const model = await loadModel('models/character.gltf');
        scene.add(model);
    } catch (error) {
        console.error('Failed to initialize:', error);
    }
}

init();
```

---

## Pattern 3: Loading with Fallbacks

Production-ready pattern that gracefully falls back to procedural geometry if GLTF fails:

```javascript
const loader = new GLTFLoader();

function loadModel(path, fallbackGeometry, fallbackMaterial) {
    return new Promise((resolve) => {
        loader.load(
            path,
            (gltf) => {
                gltf.scene.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });
                resolve(gltf.scene);
            },
            undefined,
            (error) => {
                console.warn(`Failed to load ${path}, using fallback:`, error);

                // Create fallback mesh
                const mesh = new THREE.Mesh(fallbackGeometry, fallbackMaterial);
                mesh.castShadow = true;
                resolve(mesh);
            }
        );
    });
}

// Usage
async function init() {
    const playerFallback = new THREE.BoxGeometry(0.4, 0.6, 0.3);
    const playerMat = new THREE.MeshStandardMaterial({ color: 0xE9F2FF });

    const player = await loadModel(
        'assets/Character_Male_1.gltf',
        playerFallback,
        playerMat
    );

    scene.add(player);
}

init();
```

---

## Pattern 4: Batch Loading Multiple Models

Load several models sequentially with status updates:

```javascript
const loader = new GLTFLoader();

async function loadAssets(assetList) {
    const loaded = {};

    for (const asset of assetList) {
        try {
            console.log(`Loading ${asset.name}...`);

            const gltf = await new Promise((resolve, reject) => {
                loader.load(asset.path, resolve, undefined, reject);
            });

            // Configure the model
            gltf.scene.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            loaded[asset.name] = gltf.scene;
            console.log(`✓ Loaded: ${asset.name}`);

        } catch (error) {
            console.error(`✗ Failed: ${asset.name}`, error);
            // Optionally use fallback here
        }
    }

    return loaded;
}

// Usage
const assets = [
    { name: 'player', path: 'models/character.gltf' },
    { name: 'enemy', path: 'models/skeleton.gltf' },
    { name: 'ground', path: 'models/tile.gltf' }
];

loadAssets(assets).then((models) => {
    scene.add(models.player);
    scene.add(models.enemy);
    // ... position and use models
});
```

---

## Pattern 5: Caching & Reuse (with Animation Support)

Load once, clone many times for performance. **CRITICAL:** Use `SkeletonUtils.clone()` for animated/skinned models!

```javascript
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

class ModelCache {
    constructor() {
        this.loader = new GLTFLoader();
        this.cache = new Map();
    }

    async load(path) {
        if (this.cache.has(path)) {
            return this.cache.get(path);
        }

        return new Promise((resolve, reject) => {
            this.loader.load(
                path,
                (gltf) => {
                    gltf.scene.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    // Store both scene and animations
                    this.cache.set(path, {
                        scene: gltf.scene,
                        animations: gltf.animations
                    });
                    resolve(this.cache.get(path));
                },
                undefined,
                reject
            );
        });
    }

    clone(path) {
        const cached = this.cache.get(path);
        if (!cached) {
            throw new Error(`Model ${path} not in cache. Load it first.`);
        }

        // CRITICAL: Use SkeletonUtils.clone for animated models!
        // Regular .clone() breaks skeleton bone references
        const hasAnimations = cached.animations && cached.animations.length > 0;
        return hasAnimations
            ? SkeletonUtils.clone(cached.scene)
            : cached.scene.clone();
    }

    getAnimations(path) {
        return this.cache.get(path)?.animations || [];
    }
}

// Usage
const cache = new ModelCache();
const mixers = []; // Track animation mixers for update loop

async function init() {
    await cache.load('models/enemy.gltf');

    // Spawn multiple animated instances
    for (let i = 0; i < 5; i++) {
        const enemy = cache.clone('models/enemy.gltf');
        enemy.position.x = i * 3;
        scene.add(enemy);

        // Setup independent animation for each clone
        const animations = cache.getAnimations('models/enemy.gltf');
        if (animations.length > 0) {
            const mixer = new THREE.AnimationMixer(enemy);
            mixer.clipAction(animations[0]).play();
            mixers.push(mixer);
        }
    }
}

// In animation loop
function animate() {
    const delta = clock.getDelta();
    mixers.forEach(mixer => mixer.update(delta));
    renderer.render(scene, camera);
}
```

**Why SkeletonUtils.clone() is required:**
- Regular `.clone()` doesn't properly duplicate skeleton/bone hierarchies
- Cloned skinned meshes reference the original skeleton's bones
- This causes cloned models to stay at origin or move with the original
- `SkeletonUtils.clone()` creates independent bone hierarchies for each clone

---

## Pattern 6: Model Normalization

Scale and position GLTF models consistently.

**CRITICAL:** Do NOT use `box.setFromObject(model)` for animated GLTF models! It includes invisible armature bones, helpers, and skeleton rigs which extend far beyond the visible mesh. This causes models to float above the ground.

```javascript
// ❌ WRONG - includes bones/armatures, model will float
function badNormalize(model, targetSize) {
    const box = new THREE.Box3().setFromObject(model); // Includes skeleton!
    // ... model will be positioned incorrectly
}

// ✓ CORRECT - only visible mesh geometry
function normalizeModel(model, targetSize = 1.5) {
    // Reset transforms
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);

    // Compute bounding box ONLY from visible mesh geometry
    const box = new THREE.Box3();
    model.traverse((child) => {
        if (child.isMesh && child.geometry) {
            child.geometry.computeBoundingBox();
            const meshBox = child.geometry.boundingBox.clone();
            meshBox.applyMatrix4(child.matrixWorld);
            box.union(meshBox);
        }
    });

    // Fallback for models without mesh children
    if (box.isEmpty()) {
        box.setFromObject(model);
    }

    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    // Apply uniform scale
    const scale = targetSize / maxDim;
    model.scale.setScalar(scale);

    // Update world matrices after scaling
    model.updateMatrixWorld(true);

    // Recompute bounds after scale (mesh-only)
    const scaledBox = new THREE.Box3();
    model.traverse((child) => {
        if (child.isMesh && child.geometry) {
            const meshBox = child.geometry.boundingBox.clone();
            meshBox.applyMatrix4(child.matrixWorld);
            scaledBox.union(meshBox);
        }
    });

    if (scaledBox.isEmpty()) {
        scaledBox.setFromObject(model);
    }

    // Position so bottom of visible mesh sits at y=0
    model.position.y = -scaledBox.min.y;

    return model;
}

// Usage
loader.load('models/character.gltf', (gltf) => {
    normalizeModel(gltf.scene, 2.0); // 2 units tall, feet on ground
    scene.add(gltf.scene);
});
```

**Why this matters:**
- GLTF characters have skeleton armatures for animation
- Armature bones (hips, spine, etc.) are positioned at body center, not feet
- `setFromObject()` includes these invisible bones in the bounding box
- Result: `box.min.y` is much lower than actual feet → model floats

---

## Common Pitfalls & Solutions

### ❌ GLTF Won't Load - File Not Found

**Problem**: 404 errors for GLTF files

**Solutions**:
- Verify the file path is correct (relative to HTML file)
- Use a local web server (`python3 -m http.server 8000`)
- Check browser console for exact error

```bash
# Start local server in your project directory
python3 -m http.server 8080

# Visit http://localhost:8080
```

### ❌ Models Look Wrong - Incorrect Scale/Rotation

**Problem**: Model is huge, tiny, or upside down

**Solution**: Use the normalization pattern above, or adjust manually:

```javascript
loader.load('model.gltf', (gltf) => {
    const model = gltf.scene;

    // Debug: log original bounds
    const box = new THREE.Box3().setFromObject(model);
    console.log('Bounds:', box);

    // Adjust scale and rotation
    model.scale.set(0.5, 0.5, 0.5);
    model.rotation.x = Math.PI / 2; // Rotate 90°

    scene.add(model);
});
```

### ❌ Animated Model Floats Above Ground

**Problem**: Character model hovers above the floor after positioning

**Cause**: `Box3.setFromObject()` includes invisible skeleton bones/armatures in the bounding box calculation. Armature origins are typically at hip level, not feet.

**Solution**: Compute bounds only from visible mesh geometry:

```javascript
// ❌ WRONG
const box = new THREE.Box3().setFromObject(model);
model.position.y = -box.min.y; // Model floats!

// ✓ CORRECT
const box = new THREE.Box3();
model.traverse((child) => {
    if (child.isMesh && child.geometry) {
        child.geometry.computeBoundingBox();
        const meshBox = child.geometry.boundingBox.clone();
        meshBox.applyMatrix4(child.matrixWorld);
        box.union(meshBox);
    }
});
model.position.y = -box.min.y; // Feet on ground
```

See **Pattern 6: Model Normalization** for the complete solution.

### ❌ Cloned Animated Model Stays at Origin

**Problem**: You clone a GLTF model but the clone stays at position (0,0,0) and won't move, or moves with the original model instead of independently. May also flicker or render incorrectly.

**Cause**: Regular `.clone()` doesn't properly duplicate skeleton/bone hierarchies. The cloned skinned mesh still references the original model's bones.

**Solution**: Use `SkeletonUtils.clone()` for any animated/skinned model:

```javascript
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// ❌ WRONG - clone stays at origin, animations broken
const badClone = model.clone();
badClone.position.x = 5; // Won't work!

// ✓ CORRECT - fully independent clone
const goodClone = SkeletonUtils.clone(model);
goodClone.position.x = 5; // Works!

// Each clone needs its own AnimationMixer
const mixer = new THREE.AnimationMixer(goodClone);
mixer.clipAction(animations[0]).play();
```

**Detection**: If your model has `gltf.animations.length > 0`, it likely has a skeleton and needs `SkeletonUtils.clone()`.

---

### ❌ No Shadows on GLTF Models

**Problem**: Models don't cast or receive shadows

**Solution**: Enable shadows on all meshes:

```javascript
loader.load('model.gltf', (gltf) => {
    gltf.scene.traverse((child) => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });
    scene.add(gltf.scene);
});
```

### ❌ Slow Loading - Large Models Block Scene

**Problem**: Page freezes while loading

**Solution**: Load in background, show progress:

```javascript
const loadingBar = document.getElementById('loading');

loader.load(
    'huge-model.glb',
    (gltf) => {
        scene.add(gltf.scene);
        loadingBar.style.display = 'none';
    },
    (progress) => {
        const pct = (progress.loaded / progress.total * 100);
        loadingBar.style.width = pct + '%';
    },
    (error) => {
        loadingBar.textContent = 'Load failed';
    }
);
```

---

## Advanced: Draco Compression

Load compressed GLTF files for smaller file sizes:

```html
<script type="importmap">
{
    "imports": {
        "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
        "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
    }
}
</script>

<script type="module">
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

    const loader = new GLTFLoader();
    const dracoLoader = new DRACOLoader();

    // Point to Draco decoder
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
    loader.setDRACOLoader(dracoLoader);

    loader.load('model.glb', (gltf) => {
        scene.add(gltf.scene);
    });
</script>
```

---

## Best Practices Summary

| Practice | Benefit |
|----------|---------|
| **Use import maps** | Cleaner imports, works with CDN modules |
| **Wrap in promises** | Better error handling, easier async/await |
| **Add fallbacks** | Graceful degradation if models fail |
| **Cache & clone** | Better performance when spawning many instances |
| **SkeletonUtils.clone()** | **Required** for animated/skinned models - regular clone breaks bones |
| **Enable shadows** | Traverse & set castShadow/receiveShadow |
| **Normalize scale** | Consistent sizing across different models |
| **Mesh-only bounds** | Use mesh geometry, not setFromObject() for animated models |
| **Show progress** | Better UX for large models |
| **Use local server** | Avoid CORS, proper relative paths |

---

## Reference: GLTFLoader Callback Signature

```javascript
loader.load(
    url,              // string: path to .gltf or .glb file
    onLoad,           // function(gltf): called on success
    onProgress,       // function(progress): called during load
    onError           // function(error): called on failure
);
```

**gltf object contents:**
```javascript
{
    scene: Group,              // The root scene group
    scenes: Array<Group>,      // All scenes in the file
    animations: Array<Clip>,   // Animation clips
    cameras: Array<Camera>,    // Cameras in the file
    asset: Object,             // Asset metadata
    parser: GLTFParser,        // Internal parser (advanced use)
    userData: Object           // Custom data from file
}
```

**progress object:**
```javascript
{
    loaded: number,   // Bytes loaded
    total: number     // Total bytes to load
}
```

