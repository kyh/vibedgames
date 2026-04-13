# Initial fal Video Model Notes

These are the first three models this repo should compare for pirate sprite animation tests.

## Seedance

Model page:

- https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/image-to-video/api

Important schema notes:

- endpoint: `fal-ai/bytedance/seedance/v1/pro/image-to-video`
- input image field: `image_url`
- useful controls:
  - `duration`
  - `resolution`
  - `aspect_ratio`
  - `camera_fixed`
  - `seed`

Initial repo defaults:

- `duration=6`
- `resolution=720p`
- `aspect_ratio=auto`
- `camera_fixed=true`

## Kling

Model page:

- https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api

Important schema notes:

- endpoint: `fal-ai/kling-video/v3/pro/image-to-video`
- input image field: `start_image_url`
- useful controls:
  - `duration`
  - `generate_audio`
  - `negative_prompt`
  - `cfg_scale`

Initial repo defaults:

- `duration=6`
- `generate_audio=false`
- `negative_prompt="blur, distort, low quality, camera drift, extra limbs, duplicate body parts"`
- `cfg_scale=0.5`

## Hailuo

Model page:

- https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video/api

Important schema notes:

- endpoint: `fal-ai/minimax/hailuo-02/standard/image-to-video`
- input image field: `image_url`
- useful controls:
  - `duration`
  - `resolution`
  - `prompt_optimizer`

Initial repo defaults:

- `duration=6`
- `resolution=768P`
- `prompt_optimizer=false`

## Comparison Rule

The fair comparison target is:

- same anchor image
- same task prompt
- same general motion goal
- same “no scenery / no UI / black background” constraint set

The comparison is not:

- identical parameter names
- identical output resolution
- identical provider-native defaults

