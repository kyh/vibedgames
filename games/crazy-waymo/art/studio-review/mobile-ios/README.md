# iOS Safari compatibility

Tested Mobile Safari 26.5 in an isolated iPhone 17 Pro simulator. Native Appium/XCUITest touch input. This verifies the Safari engine, controls and layout. It does not establish physical iPhone GPU speed, battery use or thermal behavior.

`index-DqNjIu5I.js`: startup, Start/countdown, hold/drag driving, pause/resume/restart, boost, portrait and landscape all passed. Touch events were trusted. Dashboard reached 67 mph; a native boost hold drained the meter from 100% to 33%. No captured runtime exceptions. Production dev hook absent.

- [Portrait driving](portrait-drive.png): 402 × 714 CSS viewport, DPR 3.
- [Landscape driving](landscape-drive.png): 874 × 338 CSS viewport, DPR 3. Safari safe areas respected.
- [Structured results](report.json).

Both layouts fit without horizontal overflow. These captures include Safari browser chrome. Simulator startup ran alongside other verification work; no loading-time or frame-rate claim is made.

The full controls run above predates the final runtime caching and mobile memory-budget refinements. The deployed release receives a separate Safari startup smoke check.
