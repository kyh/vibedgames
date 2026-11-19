# Text-to-Motion Endpoints

Animation clips from a prompt, with no mesh. **HunyuanMotion** is the default. Verify with `vg generate models --endpoint_id <id> --json` before running.

- `fal-ai/hunyuan-motion`: Tencent · HunyuanMotion 1B (the default)
- `fal-ai/hunyuan-motion/fast`: Tencent · HunyuanMotion 0.46B, faster and looser

## What comes back

- `fbx_file`: an FBX clip on a 52-bone SMPL-H skeleton, root `Pelvis`, 30 fps. Read the length from the file.
- `motion_json`: the same joint data as JSON when `output_format: dict`.
- Inputs: `prompt`, `duration` (0.5–12 s, default 5), `seed`, `guidance_scale` (1–10, default 5).

## Pick the cheaper path first

- **A stock move on a generated character** (idle, walk, run, dance, attack): rig it with Meshy (`meshy/v7.1/image-to-3d`, `enable_rigging: true`) and take `basic_animations` or one `animation_action_id` preset. The clip is already on the model's skeleton: nothing to retarget.
- **A move no preset covers** (a specific combo, an emote, a cutscene beat): generate it here, then retarget it onto the rig.

## Retargeting in Three.js

The clip's bones are SMPL-H names, so it plays on nothing until mapped:

1. Load the clip with `FBXLoader` and the character with `GLTFLoader`.
2. Map each of the character's bones to its SMPL-H counterpart (`Pelvis`, `L_Hip`, `L_Knee`, `Spine1`, `Neck`, `Head`, `L_Shoulder`, `L_Elbow`, `L_Wrist`, …); read both skeletons' names off `object.traverse` rather than guessing.
3. `SkeletonUtils.retargetClip(characterMesh, clipSkeletonMesh, clip, { names })` from `three/addons/utils/SkeletonUtils.js` bakes a clip for the character.
4. Rig the character in a T- or A-pose (`pose_mode`) so the rest poses line up; a mismatch shows as bent elbows and twisted hips.

## Prompting

- One actor, one action, in sequence: "a person draws a sword, slashes twice, then steps back".
- Name the tempo and weight: "a slow, heavy stomp" beats "a stomp".
- Loops: generate a little longer than one cycle and trim to the frame where the pose repeats.
