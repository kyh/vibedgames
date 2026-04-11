// S shape: Left arm up and right arm out
const isSShape =
  kp.leftWrist.y < kp.leftShoulder.y - 100 && // Left arm raised
  Math.abs(kp.rightWrist.x - kp.rightShoulder.x) > 150 && // Right arm extended
  kp.rightWrist.y > kp.rightShoulder.y && // Right arm not raised
  Math.abs(kp.leftWrist.x - kp.leftShoulder.x) < 50; // Left arm not extended

// Z shape: Right arm up and left arm out
const isZShape =
  kp.rightWrist.y < kp.rightShoulder.y - 100 && // Right arm raised
  Math.abs(kp.leftWrist.x - kp.leftShoulder.x) > 150 && // Left arm extended
  kp.leftWrist.y > kp.leftShoulder.y && // Left arm not raised
  Math.abs(kp.rightWrist.x - kp.rightShoulder.x) < 50; // Right arm not extended

// L shape: Left arm up, right arm down
const isLShape =
  kp.leftWrist.y < kp.leftShoulder.y - 150 && // Left arm raised high
  kp.rightWrist.y > kp.rightShoulder.y + 50 && // Right arm below shoulder
  Math.abs(kp.rightWrist.x - kp.rightShoulder.x) < 30 && // Right arm at side
  Math.abs(kp.leftWrist.x - kp.leftShoulder.x) < 30; // Left arm at side

// J shape: Right arm up, left arm down
const isJShape =
  kp.rightWrist.y < kp.rightShoulder.y - 150 && // Right arm raised high
  kp.leftWrist.y > kp.leftShoulder.y + 50 && // Left arm below shoulder
  Math.abs(kp.leftWrist.x - kp.leftShoulder.x) < 30 && // Left arm at side
  Math.abs(kp.rightWrist.x - kp.rightShoulder.x) < 30; // Right arm at side
