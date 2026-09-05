# iOS Safari compatibility

Production bundle **`index-DNNghrpq.js`** passed all **13 checks** in Mobile Safari 26.5, using an isolated iPhone 17 Pro simulator and native Appium/XCUITest input. These results cover the final touch, spawn and camera fixes. They establish Safari compatibility, not physical iPhone GPU speed, battery use or thermal behavior.

Startup, native Start, trusted hold/drag driving, hidden-title focus/touch exclusion and simultaneous steering plus boost passed. Two touch pointers remained active while the boost meter drained from 100% to 45%. No captured JavaScript exceptions, resource errors or development hooks. [Structured results](report.json).

Three native pause → restart → straight-drive recoveries showed a clear, upright car and unobstructed road in screenshots captured during the held gesture:

| Restart      | Orientation | Visible speed progression | Selected moving frame                  |
| ------------ | ----------- | ------------------------- | -------------------------------------- |
| Ingleside    | Portrait    | 47 → 64 MPH               | [Portrait drive](portrait-drive.png)   |
| The Mission  | Portrait    | 42 → 64 MPH               | [Mission drive](portrait-mission.png)  |
| Hayes Valley | Landscape   | 42 → 63 MPH               | [Landscape drive](landscape-drive.png) |

The raw simulator framebuffer retains its portrait pixel orientation, so the landscape driving capture appears sideways. It remains unedited. The separate [landscape layout capture](landscape-layout.png) is oriented by the native screenshot API after the gesture.

Portrait is 402 × 714 CSS pixels; landscape is 874 × 338. Both use DPR 3, respect Safari safe areas and fit without horizontal overflow. These captures include browser chrome. No frame-rate claim is made for the simulator.

The full suite ran against the local production preview. Deployment uploads that same built bundle, followed by a separate live Safari smoke check.
