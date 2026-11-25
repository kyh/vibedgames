const PRELUDE = String.raw`
import bpy, json, math, os, re, sys
from mathutils import Matrix, Quaternion, Vector

ARGS = json.load(open(sys.argv[sys.argv.index("--") + 1]))
P = ARGS["params"]
IN = ARGS["files"]
OUT = ARGS["out"]
WORK = ARGS["work"]


def fail(message):
    raise SystemExit("recipe error: " + message)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_model(path):
    before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path, use_anim=True, automatic_bone_orientation=False)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        fail("cannot import " + ext + " files; give GLB, FBX or OBJ")
    objects = [o for o in bpy.data.objects if o not in before]
    actions = [a for a in bpy.data.actions if a not in actions_before]
    return objects, actions


def export_glb(path, objects=None):
    bpy.ops.object.select_all(action="DESELECT")
    if objects is not None:
        for o in objects:
            o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=objects is not None,
        export_yup=True,
        export_apply=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_image_format="AUTO",
    )


def write_result(value):
    with open(ARGS["result"], "w") as f:
        json.dump(value, f)


def meshes(objects):
    return [o for o in objects if o.type == "MESH"]


def armatures(objects):
    return [o for o in objects if o.type == "ARMATURE"]


def bounds(objects):
    points = []
    for o in meshes(objects):
        points += [o.matrix_world @ Vector(c) for c in o.bound_box]
    if not points:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi
`;

const FBX_TO_GLB = String.raw`
reset()
objects, actions = import_model(IN["model_url"])
export_glb(os.path.join(OUT, "model.glb"))
write_result({
    "actions": [a.name for a in bpy.data.actions],
    "armatures": len(armatures(objects)),
    "meshes": len(meshes(objects)),
})
`;

const RETARGET = String.raw`
SIDES = [
    (re.compile(r"(^|[^a-z])(left|l)([^a-z]|$)"), "l"),
    (re.compile(r"(^|[^a-z])(right|r)([^a-z]|$)"), "r"),
]
PARTS = [
    ("thumb", "thumb"), ("index", "index"), ("middle", "middle"), ("ring", "ring"),
    ("pinky", "pinky"), ("little", "pinky"),
    ("upleg", "thigh"), ("upperleg", "thigh"), ("thigh", "thigh"),
    ("lowerleg", "shin"), ("calf", "shin"), ("shin", "shin"), ("knee", "shin"), ("leg", "shin"),
    ("toe", "toe"), ("ball", "toe"), ("foot", "foot"), ("ankle", "foot"),
    ("clavicle", "clavicle"), ("collar", "clavicle"), ("shoulder", "clavicle"),
    ("forearm", "forearm"), ("lowerarm", "forearm"), ("elbow", "forearm"),
    ("upperarm", "upperarm"), ("arm", "upperarm"),
    ("hand", "hand"), ("wrist", "hand"),
    ("head", "head"), ("neck", "neck"),
    ("hips", "hips"), ("pelvis", "hips"), ("hip", "thigh"),
    ("chest", "spine"), ("spine", "spine"), ("torso", "spine"),
]
PREFIXES = re.compile(r"^(mixamorig\d*[:_]|armature[|_]|def[-_]|bip\d*[ _]|j_bip_[a-z]_|cc_base_|b_)")


def plain(name):
    n = name.lower()
    n = n.split("|")[-1]
    n = PREFIXES.sub("", n)
    return n


def canon(name, collar=False):
    n = plain(name)
    side = ""
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", name).lower()
    for pattern, s in SIDES:
        if pattern.search(spaced.replace(".", " ").replace("_", " ")):
            side = s
    if n.startswith("left"):
        side = "l"
    elif n.startswith("right"):
        side = "r"
    squashed = re.sub(r"[^a-z]", "", n.replace("left", "").replace("right", ""))
    for key, part in PARTS:
        if key in squashed:
            if key == "shoulder" and collar:
                part = "upperarm"
            digits = re.findall(r"\d+", n)
            index = digits[-1] if digits and part in ("thumb", "index", "middle", "ring", "pinky") else ""
            return side + ":" + part + index
    return None


def has_collar(arm):
    return any("collar" in plain(b.name) for b in arm.data.bones)


def chain(arm, part):
    found = []
    collar = has_collar(arm)
    for bone in arm.data.bones:
        if canon(bone.name, collar) == ":" + part:
            found.append(bone)
    found.sort(key=lambda b: len(b.parent_recursive))
    return found


def build_map(src, dst):
    mapping = {}
    src_plain = {plain(b.name): b.name for b in src.data.bones}
    for bone in dst.data.bones:
        match = src_plain.get(plain(bone.name))
        if match:
            mapping[bone.name] = match
    if len(mapping) >= max(8, len(dst.data.bones) // 2):
        return mapping
    mapping = {}
    src_canon = {}
    s_collar, d_collar = has_collar(src), has_collar(dst)
    for bone in src.data.bones:
        key = canon(bone.name, s_collar)
        if key and key not in src_canon and not key.endswith(":spine"):
            src_canon[key] = bone.name
    for bone in dst.data.bones:
        key = canon(bone.name, d_collar)
        if key and key in src_canon and not key.endswith(":spine"):
            mapping[bone.name] = src_canon[key]
    s_spine, d_spine = chain(src, "spine"), chain(dst, "spine")
    if s_spine and d_spine:
        for i, bone in enumerate(d_spine):
            j = round(i * (len(s_spine) - 1) / max(1, len(d_spine) - 1))
            mapping[bone.name] = s_spine[j].name
    return mapping


reset()
dst_objects, _ = import_model(IN["character_url"])
dst = next(iter(armatures(dst_objects)), None)
if dst is None:
    fail("character_url has no armature; rig it first (generate animate-3d)")
for o in dst_objects:
    if o.animation_data:
        o.animation_data.action = None

src_objects, src_actions = import_model(IN["clip_url"])
src = next(iter(armatures(src_objects)), None)
if src is None:
    fail("clip_url has no armature")
action = (src.animation_data.action if src.animation_data else None) or (src_actions[0] if src_actions else None)
if action is None:
    fail("clip_url holds no animation")
if not src.animation_data:
    src.animation_data_create()
src.animation_data.action = None

mapping = build_map(src, dst)
if len(mapping) < 6:
    fail("only %d bones of the character match the clip's skeleton" % len(mapping))

scene = bpy.context.scene
start, end = (int(round(v)) for v in action.frame_range)

for pb in src.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
for pb in dst.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()


def world_rot(arm, bone):
    return (arm.matrix_world @ bone.matrix).to_quaternion()


offsets = {}
for d_name, s_name in mapping.items():
    d_rest = world_rot(dst, dst.pose.bones[d_name])
    s_rest = world_rot(src, src.pose.bones[s_name])
    offsets[d_name] = s_rest.inverted() @ d_rest

hips = next((n for n in mapping if canon(n, has_collar(dst)) == ":hips"), None)
if hips is None:
    roots = [b.name for b in dst.data.bones if b.parent is None and b.name in mapping]
    hips = roots[0] if roots else None
src_hips = mapping.get(hips) if hips else None
scale = 1.0
if hips and src_hips:
    d_h = (dst.matrix_world @ dst.pose.bones[hips].head).z - bounds(dst_objects)[0].z
    s_h = (src.matrix_world @ src.pose.bones[src_hips].head).z - bounds(src_objects)[0].z
    if s_h > 1e-4 and d_h > 1e-4:
        scale = d_h / s_h
    d_rest_loc = dst.matrix_world @ dst.pose.bones[hips].head
    s_rest_loc = src.matrix_world @ src.pose.bones[src_hips].head

src.animation_data.action = action

new_action = bpy.data.actions.new(P.get("clip_name") or action.name.split("|")[-1])
dst.animation_data_create()
dst.animation_data.action = new_action
for pb in dst.pose.bones:
    pb.rotation_mode = "QUATERNION"

order = sorted(mapping, key=lambda n: len(dst.data.bones[n].parent_recursive))
depths = {}
for n in order:
    depths.setdefault(len(dst.data.bones[n].parent_recursive), []).append(n)

for frame in range(start, end + 1):
    scene.frame_set(frame)
    for level in sorted(depths):
        for d_name in depths[level]:
            pb = dst.pose.bones[d_name]
            s_rot = world_rot(src, src.pose.bones[mapping[d_name]])
            target = s_rot @ offsets[d_name]
            current = dst.matrix_world @ pb.matrix
            loc = current.to_translation()
            if d_name == hips and src_hips:
                s_loc = src.matrix_world @ src.pose.bones[src_hips].head
                delta = (s_loc - s_rest_loc) * scale
                if P.get("in_place"):
                    delta.x = 0.0
                    delta.y = 0.0
                loc = d_rest_loc + delta
            world = Matrix.LocRotScale(loc, target, current.to_scale())
            pb.matrix = dst.matrix_world.inverted() @ world
        bpy.context.view_layer.update()
    for d_name in order:
        pb = dst.pose.bones[d_name]
        pb.keyframe_insert("rotation_quaternion", frame=frame, group=d_name)
        if d_name == hips:
            pb.keyframe_insert("location", frame=frame, group=d_name)

for o in src_objects:
    bpy.data.objects.remove(o, do_unlink=True)
for a in src_actions:
    if a != new_action and a.users == 0:
        bpy.data.actions.remove(a)

track = dst.animation_data.nla_tracks.new()
track.strips.new(new_action.name, start, new_action)
dst.animation_data.action = None
export_glb(os.path.join(OUT, "model.glb"), dst_objects)
unmapped = [b.name for b in dst.data.bones if b.name not in mapping]
write_result({
    "animation": new_action.name,
    "frames": end - start + 1,
    "fps": scene.render.fps,
    "mapped_bones": len(mapping),
    "unmapped_bones": unmapped[:64],
})
`;

const BAKE = String.raw`
reset()
high, _ = import_model(IN["high_url"])
low, _ = import_model(IN["low_url"])
low_meshes = meshes(low)
if not low_meshes:
    fail("low_url has no mesh")
bpy.ops.object.select_all(action="DESELECT")
for o in low_meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = low_meshes[0]
if len(low_meshes) > 1:
    bpy.ops.object.join()
target = bpy.context.view_layer.objects.active
if not target.data.uv_layers:
    fail("low_url has no UVs; unwrap it first")

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
size = P["size"]

if not target.data.materials:
    target.data.materials.append(bpy.data.materials.new("baked"))

images = {}
for kind in P["maps"]:
    img = bpy.data.images.new(target.name + "_" + kind, size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    images[kind] = img

for kind, img in images.items():
    for mat in target.data.materials:
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        node = nodes.new("ShaderNodeTexImage")
        node.name = "bake_" + kind
        node.image = img
        nodes.active = node
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes(high):
        o.select_set(True)
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    scene.cycles.samples = 1 if kind == "normal" else 64
    bpy.ops.object.bake(
        type="NORMAL" if kind == "normal" else "AO",
        use_selected_to_active=True,
        cage_extrusion=P["extrusion"],
        margin=8,
        normal_space="TANGENT",
    )
    path = os.path.join(WORK, img.name + ".png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()

for mat in target.data.materials:
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None) or nodes.new("ShaderNodeOutputMaterial")
        links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    if "normal" in images:
        tex = nodes["bake_normal"]
        nmap = nodes.new("ShaderNodeNormalMap")
        links.new(tex.outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    if "ao" in images:
        group = bpy.data.node_groups.get("glTF Material Output")
        if group is None:
            group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
            group.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
        gnode = nodes.new("ShaderNodeGroup")
        gnode.node_tree = group
        links.new(nodes["bake_ao"].outputs["Color"], gnode.inputs["Occlusion"])

for o in high:
    bpy.data.objects.remove(o, do_unlink=True)
export_glb(os.path.join(OUT, "model.glb"))
write_result({"maps": list(images), "size": size})
`;

const RENDER = String.raw`
reset()
objects, _ = import_model(IN["model_url"])
if not meshes(objects):
    fail("model_url has no mesh")
scene = bpy.context.scene
lo, hi = bounds(objects)
center = (lo + hi) / 2
radius = max((hi - lo).length / 2, 1e-3)

VIEWS = {"front": (0, 12), "three-quarter": (45, 20), "side": (90, 8), "back": (180, 12), "top": (0, 80)}
azimuth, elevation = VIEWS[P["view"]]

pivot = bpy.data.objects.new("pivot", None)
scene.collection.objects.link(pivot)
pivot.location = center
cam_data = bpy.data.cameras.new("camera")
cam_data.lens = 50
cam = bpy.data.objects.new("camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
fov = cam_data.angle
distance = radius / math.sin(fov / 2) * 1.08
a, e = math.radians(azimuth), math.radians(elevation)
cam.location = center + Vector((distance * math.cos(e) * math.sin(a), -distance * math.cos(e) * math.cos(a), distance * math.sin(e)))
direction = center - cam.location
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
cam.parent = pivot
cam.matrix_parent_inverse = pivot.matrix_world.inverted()
cam_data.clip_start = distance / 100
cam_data.clip_end = distance * 10

sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.collection.objects.link(sun)
world = bpy.data.worlds.new("world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.6, 0.62, 0.66, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
scene.world = world

scene.render.resolution_x = P["size"]
scene.render.resolution_y = P["size"]
scene.render.resolution_percentage = 100
if P["engine"] == "workbench":
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
else:
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = P["samples"]
    scene.cycles.use_denoising = True

frames = P["frames"]
if frames == 1:
    scene.render.film_transparent = P["transparent"]
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if P["transparent"] else "RGB"
    scene.render.filepath = os.path.join(OUT, "render.png")
    bpy.ops.render.render(write_still=True)
    files = ["render.png"]
else:
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.fps = 30
    pivot.rotation_euler = (0, 0, 0)
    pivot.keyframe_insert("rotation_euler", frame=1)
    pivot.rotation_euler = (0, 0, math.radians(360 * frames / (frames + 1)))
    pivot.keyframe_insert("rotation_euler", frame=frames)
    for fc in pivot.animation_data.action.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    scene.render.filepath = os.path.join(OUT, "turntable.mp4")
    bpy.ops.render.render(animation=True)
    files = ["turntable.mp4"]
write_result({"bounds": {"max": list(hi), "min": list(lo)}, "files": files, "frames": frames})
`;

export const BLENDER_SCRIPTS = {
  bake: PRELUDE + BAKE,
  "fbx-to-glb": PRELUDE + FBX_TO_GLB,
  render: PRELUDE + RENDER,
  retarget: PRELUDE + RETARGET,
} as const;

export type BlenderRecipe = keyof typeof BLENDER_SCRIPTS;
