# Diagnosis after R3

Three FAILs on the same six criteria. A fresh diagnoser read the verdicts and captures.

Root causes:

- **C1**: wrong rung. Surfaces have grain, but the sky fill and environment are so strong that the sun's shadows vanish. The additive glow disc under each kart (added for C9) replaced its shadow.
- **C2**: one primitive per object; each round swapped a named box for another box. Boards are blank, the barrier run has gaps, the verge is empty.
- **C5**: real defects. The chase camera has no occlusion handling; barrier spacing ignores curvature, so blocks interpenetrate; item-box glyphs tumble upside down; bloom on emissive paint makes haze.
- **C6**: approach ceiling as built. Flat single-colour primitives, zero-thickness plates, no number from behind.
- **C7**: one material reused across every panel.
- **C9**: ceiling of the paint representation. Colour is nearest-sampled, so colour-to-colour borders stair-step; paint has no normal, so no sheen; "lights what is near it" was faked with an additive disc and bloom.

Stop: swapping individual props, adding grain under flat light, raising emissive or bloom for "glow", reshaping HUD outlines, retuning the wobble.

Steer: re-key the light; drop the glow disc; fix the paint data and give it a rim; make paint tint what is beside it; clamp the camera and space barriers by curvature; livery and numbers on karts; printed faces on boards; a material per HUD panel.

Honest ceiling: C1, C5, C7, C9 are reachable procedurally. C2 probably. C6 is doubtful without an authored or generated model and livery.
