# Complete-session quality report

Implemented plan: [per-game scope and acceptance](session-quality-plan.md).

This pass follows the [collection polish](polish-report.md) and the
[Bomberman/Starfall graphics upgrades](graphics-upgrade-report.md). Their existing
art, effects, input paths and verification remain the baseline.

## Verification record

Implementation and browser verification proceeded one game at a time. Sections
below record observed behavior, fixtures and remaining limits.

### Pong

The ink start/result panel now states first-to-seven, exposes a focusable
Serve/Rematch action, and reports final score plus authoritative longest rally.
Score/rally labels, visible sound state, reconnect wording and live-controls copy
complete the flow. Mute/pause stop active and scheduled notes immediately. The
touch-scroll review caught and fixed accidental confirmation inside the card.

Typecheck, build, seven spin tests, scoped lint/format and architect review pass.
Browser checks covered real serve/steering/keyboard actions, seven winning and
seven losing goal crossings through the actual update path, three rematches,
synthetic hand flick/confirm, repeated guest snapshots, migration and reconnect
seams. Offline pause froze ball/frame exactly; live-controls pause kept play
advancing. Four queued audio notes stopped on mute/pause; paused unmute admitted
none. Portrait 390×844 and scrollable 568×240 results fit with a 44px action.
No uncaught errors; headless camera denial used the existing mouse fallback.
Peer, touch and camera checks here are seams/fixtures, not physical hardware or
a live two-client latency test.

### Flappy Dragons

The existing crash beat now leads into a score/gates/coins/best card, using the
original retry and race-return deadlines. Camera status reports actual warmup,
tracking loss and jump/arm readiness without driving recognition. Existing
samples provide countdown, milestone and record phrases with one owned pending
note. Pause/mute/revive/shutdown cancel it. Results and the complete camera preview
fit together in portrait and short landscape.

Typecheck, build, two readiness test groups, scoped lint/format, diff check and
review pass. A frame-driven pose pilot flew the real seeded course for 13 seconds:
four gates, three coins, seven points and 23 accepted flaps. Synthetic pose speeds
remain −480/−720/−600, including reduced motion. Deadline fixtures passed at
119/120 ms reveal, 279/280 ms solo retry and 1299/1300 ms race return; race position
did not rewind. Camera Space consumed both key edges. Audio cancelled without
stale notes; online-fixture world continued. Portrait 390×844 and expanded-camera
landscape 667×375 fit without overlap. Real scene shutdown cleared owned timers
and its resize listener; subsequent resize produced no page errors. Physical
camera and live-network behavior remain outside these fixtures.

### Farm

Contextual tool/target hints now explain accepted and blocked actions. Notices
coalesce and cap at three. A parchment morning card reports shipping completed
this visit; Continue names the validated saved day and season. The title farmer
sizes to its visible pixels instead of transparent sprite-sheet padding.

Custom audio now owns every source and one scene-owned music scheduler. Mute and
wrapper pause cancel current/future notes; unmute respects pause. Routine sources
reserve room for rewards, and old scene cleanup cannot stop newer music.

Fresh typecheck/build, five audio lifecycle test groups, scoped lint/format and
source review pass. Existing-action fixtures tilled soil for two energy, shipped
255g once, held gold/count unchanged on empty repeat, then advanced to day two
with restored energy and the exact receipt. Overnight added no extra gold.
Forty distinct notices held at three and expired to zero. Runtime mute stopped
six sources; wrapper pause froze the observed frame and cleared owned notes.
Paused unmute admitted none. The stress run observed a 32-source peak.
Actual Farm → mine 1 → mine 2 → Farm transitions retained music ownership.
Repeated scheduler cleanup also passed model tests. Desktop, portrait 390×844 and
landscape 844×390 layouts fit; ordinary New Farm/reload/Continue displayed and
loaded the real saved day. Final captures used a CUA fallback after CLI driver
stalls; its console error log was empty. Browsers and server closed.
The transaction fixtures use existing scene actions; malformed browser-driver
letter keys were not worked around in product controls.

### Pacman

A brief lesson confirms accepted steps/turns and explains walls. One reusable
capture echo, reappearance settle and win beat stay cosmetic. Results show the
existing score/best, local ghosts chomped and current maze remainder. Shared-maze
guests wait for the host; score corrections refresh the result without replaying
celebration. Narrow HUD flow and short-landscape results leave the camera intact.

Typecheck/build, scoped lint/format and source review pass. The extracted-method
harness matches 522 pre-change control traces; five lifecycle groups cover reset,
authority, initial title, effect reuse and lesson expiry. Browser checks confirmed
real step/turn input, exact 899/900 ms READY boundary, solo three-life loss,
immediate race respawn and unchanged 1000 ms grace. Peer fixtures verified guest
wait, authenticated score200→190 correction and host round reset. Repeated result
renders kept one celebration. Pause froze presentation clocks; reduced motion
suppressed new transforms. Desktop, portrait390×844 and landscape667×375 fit with
expanded camera; no page errors. Browser/server closed. Peer/gesture fixtures do
not establish physical recognition or live-network behavior.

### Tetris

A floor diagram teaches clears along both horizontal axes. The rescue meter
reads the existing deadline, including pause adjustment. Results show actual
score, lines, placed pieces, successful rescues, largest clear and a local best.
Small-screen cards scroll safely with a phase-gated Play action. The full camera
preview clears the spawning piece and rescue meter during portrait play.

Typecheck/build, 31 core checks, seven audio lifecycle groups, scoped formatting
and source review pass. The 13 core/input/camera/physics files match the baseline.
Browser actions covered move, rotate, orbit, hold and drop; clear/power fixtures
kept their original scoring. A 950 ms rescue window stayed fixed through a
14-second pause and resumed at 949 ms. Keyboard and synthetic hands-up catches
succeeded; packed-stack failure awarded no rescue. Retry cleared board, stats
and effects while retaining the verified best of 240. Mute cancelled all six
owned rescue sources, including three future notes; paused unmute stayed quiet.
Desktop, 390×844 portrait, 667×375 landscape and a scrollable 390×390 card fit.
An opaque camera fixture confirmed clear spawn/meter geometry. No page errors;
expected camera denial used keyboard fallback. Browser/server closed. Physical
camera recognition, native touch and subjective mix remain untested.

### Lunerfall

The hub shows the actual last descent, banked shards and score; co-op guests see
only their observed run, with no invented earnings. Door unlocks respond once per
state edge. Boss arrival, payoff, objective and critical banners have explicit
priority and bounded pending work. Existing sound recipes now own all current and
future sources, with reserved critical capacity and one pause-safe music clock.

Fresh typecheck/build, 80 existing simulation checks, 24 focused lifecycle groups,
scoped lint/format and source review pass. Five existing files plus one typed
recap helper changed; gameplay, assets, controls and network schema remain intact.
An isolated Playwright browser completed real movement, three banked death/return
cycles, guest return, forge open/close and stale-recap cleanup. The first receipt
reported exactly 27 earned shards; repeated rendering added no reward. Offline
pause froze frames; an online fixture kept them advancing while audio stopped.
Paused unmute stayed quiet. Boss identity announced once; priority/door fixtures
retained one visual owner. Destroy left zero sources and schedulers. Desktop and
portrait captures fit; the existing portrait letterbox still makes the whole hub
small. No page errors. Browser/server closed. Earlier CLI synthetic-key flooding
was isolated to that driver and did not trigger product input/audio workarounds.

### Ancients of Eldermoor

Six spell families now have distinct accepted-cast cues and camera-distance
attenuation; actual local victims keep priority. Complete phrases own all sources,
including future notes. Objective notices retain priority/FIFO order with one
active and three pending entries. Results use the stable screen HUD, existing
faction portrait and actual K/D/A, level, last hits, denies, held gold and match
time. Missing local heroes get neutral completion. Result inputs cannot issue
combat commands; replay/menu clears old presentation and sound.

Typecheck/build, 25 existing simulation checks, 15 result/queue/button groups,
eight actual cast/snapshot groups, five view/audio boundary groups and 11 audio
lifecycle groups pass. Scoped lint/format and independent review pass; existing
warnings remain. Exactly six session files changed; sim/data/net/assets match
the baseline. Isolated Playwright drove movement, six accepted native Q casts,
shop/Escape precedence, exact result fixtures, two replays and a third menu return.
A four-note phrase with three future notes cancelled on pause; paused unmute had
no backlog. A touch-emulated result returned to Menu in 105.8 ms with pending
victory notes cancelled. Desktop, portrait, short landscape, longest hero name,
Dire portrait and reduced motion passed. Screen HUD stayed upright over a tilted,
zoomed world camera. No page errors; browser/server closed. End states, nearby
targets and live-pause policy used explicit fixtures, not a natural full match or
live second client. Existing elected-guest ending/takeover behavior remains a
separate release concern recorded in the roadmap.

### Battle Arena

Champion selection coordinates existing details and icons with the model's
transition, cancelling superseded motion. Priority announcements and kill-feed
entries have bounded presentation lifetimes. Results clear old combat overlays,
report held gold accurately and block gameplay commands. A surviving guest's new
round clears old streaks, notices and sound before its first fresh event.

Local win/loss determines the authored result chord; unassigned outcomes stay
silent. Sound owns every current/future source, modulation node and scheduler.
Original recipes and music patterns remain, with reserved local-hit capacity.
Pause, mute, round replacement and disposal cancel old work.

Typecheck/build, 60 combat-timing checks, four particle groups, six menu groups,
11 Hud groups, 11 integration groups and 18 audio lifecycle groups pass. All 74
baseline cue cases match, including six champions and 36 cast variants. Continuous
music/ambience traces stayed below their budgets without normal-load drops.
The original playing music driver matched 2,400 variable-dt frames; simulation,
data and assets match the saved baseline. Scoped lint/format and added-line type
safety checks pass; unrelated existing warnings remain. Isolated Playwright
verified six menu selections, native movement/casting, priority notices, actual
local win/loss fixtures, result-input suppression, Play Again and Change Hero.
Desktop, portrait and short-landscape results fit. Pause cancelled all owned
sources and schedulers; the online-policy fixture kept the world advancing.
Same-context round replacement discarded the previous music/streaks before fresh
events. Neutral outcomes stayed silent; disposal was idempotent. The touch pass
caught and fixed first-unmute gesture propagation. Native touch unmute, accepted
ability input, reduced motion and terminal silence then passed. No page errors;
browsers/server closed. The software-rendered loop advanced slowly, so an explicit
intro fixture preceded native inputs; these checks do not establish hardware
performance. Outcomes and online policy were fixtures, not a natural full match
or live second client.

### Bomberman

The existing generated courtyard now frames its title, controls, sound choice and
round results. A real Play action permits safe scrolling. Elimination stays
distinct from a final result, and Restart round explains shared resets. Confirm
inputs cannot also bomb; restart cancels old movement tweens before the spawn
snap. Accepted local bombs and authenticated pickups pulse a separate body layer,
preserving the original walk/fire frames. Spatial blast sound selects the nearest
affected tile in each new batch; chain reactions retain their 65 ms aggregate.
Current/future notes and complete filter/panner graphs clear on pause/reset.

Typecheck/build, scoped lint/format, six preservation groups, seven session groups,
four pad-release traces, ten result-key listener traces and 12 audio groups pass.
Six original sound recipes match. Host rules, 23 selected methods, original
70/2200/480/600 ms boundaries, camera methods and all 20 assets match the baseline.
Isolated Playwright verified native sound/start/movement/bombing, six actual
pickup/cap receipts, burn silence, eliminated-to-final outcomes and three shared
round restarts. Native Space on Restart issued no bomb; future fanfare and old
position tweens did not survive reset. Solo fuse pause held; a live-policy fixture
kept the world advancing with local audio silent. Portrait 390×844 and landscape
667×375 scrolling, touch actions and eight corner-clearance cases pass. No page
errors; browsers/server closed. Pickups, outcomes, pad input and live pause include
explicit fixtures; physical controllers, phone performance and live peers remain
separate checks.

### Starfall

The existing battle effects now have a coherent session around them: sparse
flight/boss music, once-per-encounter arrival/phase/defeat cues, a live phase label,
automatic re-entry progress and an arc showing the existing protection window.
Sector recaps report earned points, session best and the actual current sector.
Play continues through the recap; recovery takes precedence without extending its
deadline. Short-screen layouts keep the active ship and minimap clear.

Typecheck/build, existing five FX groups, permanent encounter smoke, five actual
timing/reward groups, seven integration groups and four additional encounter
boundaries pass. Fourteen audio groups preserve all 23 original buffers and 46
existing playback cases. Music uses at most two voices inside a 32-source budget;
critical cues retain reserved capacity. Pause, mute, scene cuts and disposal own
current/future notes and the single scheduler. Independent review confirms 49
combat/input/camera/reward/warning methods, constants, wire, clock, existing battle
renderers and assets match the session baseline. All 26 weapon families remain.

Isolated Playwright drove native start, sound, pointer and Space actions; actual
shield drain, repeated 2.5-second recovery and two-second protection; and a boss
through its original three eight-second damage floors. One arrival, two phase
cues and one defeat fired. Offline pause held the frame, clock and recovery meter
with zero audio sources. A forward sector fixture reset points without another
award, played one cue and retained the ten-second recap deadline through recovery;
backward adoption stayed quiet. Portrait 390×844, landscape 667×375 and 390×390
fixtures with long scores/four standings rows fit. Computed reduced-motion
animation is none. Browser review caught and fixed short-screen ship occlusion;
independent review caught and fixed reduced-motion selector specificity.

A final touch browser verified the exact loaded audio singleton, native first
unmute and paused unmute through the audio API. The existing pause overlay covers
the touch sound button, so paused API behavior is not claimed as a native paused
button path. Actual spectator methods kept frames advancing without XP tax,
death count or recovery card, then returned through the existing due-now deadline.
Trailer clear left zero sources, scheduler and encounter history. At Phaser's
actual shutdown event, the reusable audio owner held zero sources; final game
destruction closed its context and cleared buffers/graphs. No page errors. All
isolated browsers and the local server closed. Guest snapshots, online pause and
rare combat states used explicit seams/fixtures, not a live second client.

## Final integration

The full `pnpm verify` gate passes: 25 typecheck tasks, lint, formatting and 15 test
tasks, including Crazy Waymo's 237 checks. Existing lint/build warnings remain.
The first aggregate typecheck exposed Farm's stale generated incremental cache;
a fresh non-incremental check passed, and clearing only that cache made the normal
command pass. No product change was needed. Every changed game also passed its
scoped build and browser verification.

Added-line type-safety review found no new `any`, casts, non-null assertions or
definite-assignment assertions. Saved source hashes verify that completed games
remain at their tested revisions and Crazy Waymo's separate work is untouched.

## Limits

Desktop browser checks do not measure physical-camera recognition, phone GPU
performance, thermal behavior or subjective fun/audio mix. No production release,
commit or push is part of this pass.
