# City action reel

Open `?trailer=1`. Eight short cuts mix two charged drifts, a fast hill descent
and landmark drives. Gameplay uses the normal chase camera/HUD; camera cuts use
roadside and tracking views. About 27 seconds of action before capture timing.
Golden Gate leads into the original Twin Peaks crane pullback for the ending.
No hero shots, title cards or promotional overlays.

| Shot                  | View     | Location                                          |
| --------------------- | -------- | ------------------------------------------------- |
| `intersection-drift`  | Roadside | Broad downtown junction; drift and turbo release  |
| `north-beach`         | Gameplay | Coit Tower / North Beach approach                 |
| `ferry-building`      | Tracking | Embarcadero / Ferry Building                      |
| `gameplay-drift`      | Gameplay | Second junction; charged drift and exit           |
| `hill-descent`        | Gameplay | Fast descent down a city hill                     |
| `palace-of-fine-arts` | Tracking | Palace of Fine Arts                               |
| `golden-gate`         | Camera   | Golden Gate crossing                              |
| `twin-peaks-vista`    | Crane    | Twin Peaks road; pull back to reveal city and bay |

Driving uses ordinary car inputs and Rapier. Streets resolve against the actual
vector road network. Traffic uses its normal routing and collision behavior.
Only the two drift scenes stage a traffic reaction. The other cuts leave room for
driving and landmarks. The jokes use the game's dialogue pool and bubble renderer.
Drifts must charge, release a real mini-turbo and avoid wall contact or playback
reports a failed take. Trailer sessions stay offline and never write the saved best.

`&manual=1` waits for Play trailer (unlocks sound), `&loop=1` repeats, and Escape
returns to the game. `&scene=ferry-building` selects one shot. `&clean=1` removes
HUD and speech bubbles for video-model input while retaining the same camera views.

## Capture

```sh
# From the repo root. Builds, starts preview, records footage and clean references.
node games/crazy-waymo/tools/capture-trailer.mjs --out /tmp/crazy-waymo-trailer

# Reuse a running dev server.
node games/crazy-waymo/tools/capture-trailer.mjs \
  --url http://localhost:5194 --out /tmp/crazy-waymo-trailer
```

Requires Chrome, `ffmpeg`, and `ffprobe`. Keep capture Chrome foregrounded;
run one browser capture at a time. `--no-clean` skips the second pass.
`--scene <id>` captures one shot. `--reencode <raw-directory>` repeats encoding
without another browser run. Raw captures are retained at the reported path.

Outputs:

- `crazy-waymo-trailer.mp4`: 1920×1080 H.264, AAC game sound/music; gameplay HUD and NPC comments.
- `crazy-waymo-clean.mp4`: same shot list, HUD and dialogue hidden.
- `clean-shots/`: individual reference clips and three stills per shot.
- `review/`: individual footage clips, stills and contact sheet.
- `report.json`: dimensions, frame rate, audio peak, timeline, alignment, removed stalls and errors.

The recorder preserves Chrome's native 25 fps footage; it invents no motion frames.
Each shot is trimmed using its reported visible interval, removing scenery-loading
holds. Near-identical recorded frames held for at least 240 ms are reduced to one
frame; the matching audio span is cut with them. Shot clips copy the master at
forced keyframes, avoiding another lossy encode.
Audio comes from the game's final WebAudio output. A temporary white plate
synchronizes audio/video and is excluded from the export. Alignment is accurate
to about one recorded frame plus audio encoder latency.

## Video model input

Use one clean shot per generation, paired with its still. Keep the HUD/comment
version as the reference for game behavior. Add hero shots, titles and text in the
later edit. Generated city detail and vehicle motion need comparison against the
source; do not assume the model preserved geography, contacts or driving rules.

Suggested direction:

> Preserve the input shot's camera path, vehicle silhouette, driving direction,
> timing, road layout and landmark positions. Improve lighting and surface detail.
> Keep the same vehicles and actions. No added roads, stunts, logos, text or UI.

Current reference workflows support targeted video restyling and image guidance:
[Runway video editing](https://help.runwayml.com/hc/en-us/articles/52150503729171-Aleph-2-0-Prompting-Guide),
[Veo reference images and first/last frames](https://deepmind.google/models/veo/).
