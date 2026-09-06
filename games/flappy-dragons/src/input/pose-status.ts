/** A read-only projection of tracking; these labels never arm or gate controls. */
export function poseStatus(
  warming: boolean,
  samples: number,
  required: number,
  noseVisible: boolean,
  armsVisible: boolean,
) {
  if (warming) {
    return noseVisible
      ? {
          label: `CENTER ${samples}/${required}`,
          detail: `Centering ${samples}/${required} · stand naturally`,
        }
      : { label: "FIND FACE", detail: "Step into view to center your pose" };
  }
  if (noseVisible && armsVisible) {
    return { label: "POSE READY", detail: "Ready · jump or flap your arms" };
  }
  if (noseVisible) return { label: "JUMP READY", detail: "Jump ready · show wrists to flap too" };
  if (armsVisible)
    return { label: "ARMS READY", detail: "Arms ready · show your face to jump too" };
  return { label: "FIND YOU", detail: "Step into view · keyboard and tap still work" };
}
