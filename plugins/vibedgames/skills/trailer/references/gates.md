# Gates every cut passes before a person watches it

Thresholds assume a ~60 s trailer at 60 fps; scale for other lengths. A
failure is fixed, or listed as open in the message that sends the cut. A
montage drops the silence and equal-length rules.

## Structure

- [ ] First event (a hit +15 dB, a cut, a flash or a question image) within
      0.5 s; no studio logo first.
- [ ] Hook, promise, escalation, turn, payoff and button are all on screen.
- [ ] The hero/boss full reveal at or after 40% of runtime.
- [ ] The fastest 10 s of cutting is in the last 40% before the title.
- [ ] No cut within 6 frames before a hero impact.
- [ ] One breath shot ≥ 1.5 s between 50% and 70% of runtime.
- [ ] Every must-show item has a shot; a new mechanic holds ≥ 70 frames.

## Sync

- [ ] ≥ 30% of cuts within ±50 ms of an audio onset.
- [ ] Action peaks within ±2 frames of a beat on hero shots.
- [ ] No single shot length over 40% of cuts; ≤ 4 equal lengths in a row.

## Motion

- [ ] ≥ 6 legible, eased speed ramps; at most one long slow-motion beat.
- [ ] 0% duplicated frames (`ffmpeg -vf mpdecimate` drops nothing).
- [ ] Every frame moves ≥ 1 px/frame at 1080p unless a hold pays off within
      0.3 s; the first frame after every cut moves too.
- [ ] Hero inside 12–85% of frame height on every follow frame (from the
      state probe).
- [ ] Screen direction holds; no cut breaks the 180° line.

## Sound

- [ ] 2–4 designed holes (≥ 20 dB under the previous 2 s, 0.3–2.4 s), each
      followed within 0.25 s by a hit ≥ 15 dB up, and starting on its cut.
- [ ] The loudest 50 ms is the boss, an explosion or the title.
- [ ] Integrated −14 ± 1 LUFS, true peak ≤ −1 dBTP measured on the final AAC,
      short-term spread ≥ 8 LU across the body.
- [ ] A slow-motion hit is heard on the frame its flash is seen.
- [ ] No outgoing sound drops > 20 dB within 2 frames of a cut unless designed.
- [ ] Voice: gaps ≥ 8 frames, nothing on the drop, each line within 0.3 s of
      its picture, every line transcribed correctly from the mix.

## Picture

- [ ] Flat white ≤ 0.5% of held frames; ≤ 3 full-frame flashes per second.
- [ ] A sharp subject in every shot; no defocused occluder over 10% of frame.
- [ ] No placeholder meshes, idle characters, debug text or unplanned HUD.
- [ ] No two shots in one act frame the same subject at the same scale.

## Delivery

- [ ] Correct resolution, frame rate, colour tags (bt709), and file size
      target per deliverable.
- [ ] Title is the game's logo in the world of its shot; a button sound ends
      the film.

## Measuring

```bash
# loudness and true peak on the delivered file
ffmpeg -i master.mp4 -af ebur128=peak=true -f null - 2>&1 | tail -12
# scene cuts with timestamps
ffmpeg -i master.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep pts_time
# audio onsets: use a beat/onset tracker on the mix, or the silencedetect filter for holes
ffmpeg -i master.mp4 -af silencedetect=noise=-40dB:d=0.3 -f null - 2>&1 | grep silence_
# duplicated frames: frames kept by mpdecimate vs total (equal means none dropped)
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 master.mp4
ffmpeg -i master.mp4 -vf mpdecimate -f null - 2>&1 | grep -oE "frame= *[0-9]+" | tail -1
# frame by index for a still check
ffmpeg -i master.mp4 -vf "select=eq(n\,1548)" -vframes 1 f1548.png
```
