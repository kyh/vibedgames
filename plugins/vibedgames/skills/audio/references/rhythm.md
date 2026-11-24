# Rhythm and music games

A chart feels right when every note is a note you can hear. Most "the notes
feel random" complaints come from charts transcribed off a mixed recording.

## Own the music the chart follows

- **Chart from the notes, not the mix.** Write the song as data first (a part
  per instrument with pitch and time), render the audio from it, and derive
  the chart from the featured part. Automatic onset detection on a finished
  mix never gets past "close". If the music is generated
  (`elevenlabs/music/v2.5`), split stems with `fal-ai/demucs` and chart from
  the featured stem, then check every note by ear and by onset.
- **Every charted attack is audible over the full mix** at its charted time.
  If the featured part is buried, the mix is wrong, not the chart.
- **Strip codec padding.** MP3/AAC add silence at the start; trim it or offset
  the song clock by the measured amount.

## Levels nest

- Every note of an easier level sits on a note of the level above, at the same
  time and key. Chords lose keys on the way down, never gain them.
- Difficulty comes from density, spacing and chords, never from removing
  lanes. Every level uses every lane.
- No level asks for more than two hands can do: no three-lane jumps on one
  hand, no fast repeats on one key (roll them instead).
- Pitch maps to position inside a phrase: higher is further right, the same
  note is the same key, and a repeated phrase returns on the same keys.
- Chords only where two notes are heard; holds only on notes that ring.

## Timing

- **Judge against the audio clock.** Song time is
  `ctx.currentTime - songStart - outputLatency`, never frame time. Judge each
  press at its own event `timeStamp` converted to the audio clock, so a slow
  frame never makes a hit late.
- **Windows are the same on every level** (e.g. perfect ±35 ms, good ±70 ms,
  ok ±110 ms) and the player can widen them. Levels differ in density and note
  travel time; note speed changes travel only.
- **Calibrate before the first song**: a visual landing lined up against a
  heard click, in plain words. Never answer a chart complaint with "calibrate".

## The board

- Notes, catchers and the strike line draw sharp every frame, with no bloom,
  blur or shake on them, and nothing from the world covers a lane.
- The streak multiplier is the second thing the eye reads after the notes.
- The world reacts on bars and phrases; the board itself never moves.
- A setlist rises in tiers by measured note density, each tier closing on a
  standout song; previews start at the song's best part.

## Check every chart through the game

Run each chart through the real judge with a bot that presses exactly on time
(should score 100%) and one that presses 60 ms late (should drop to the outer
window). A chart the bot cannot clear on time is broken data, and a missing
chart is an error the player sees, never a guessed replacement.
