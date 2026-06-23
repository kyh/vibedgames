// Draws a tetromino footprint as a little isometric cube cluster on a 2D
// canvas — the NEXT / HOLD HUD previews. Faux-3D (no second WebGL context):
// each cell is an iso cube whose three visible faces use the same top/side
// shading as the in-well cube material, so the previews read as the real piece.

const TOP_SHADE = 1.0;
const LEFT_SHADE = 0.6;
const RIGHT_SHADE = 0.82;

function shade(hex: number, f: number): string {
  const r = Math.min(255, ((hex >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((hex >> 8) & 255) * f) | 0;
  const b = Math.min(255, (hex & 255) * f) | 0;
  return `rgb(${r},${g},${b})`;
}

/** Cells (col, row) that are filled in the footprint. */
function cells(footprint: number[][]): { c: number; r: number }[] {
  const out: { c: number; r: number }[] = [];
  for (let r = 0; r < footprint.length; r++) {
    const row = footprint[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (row[c]) out.push({ c, r });
    }
  }
  return out;
}

/** Render (or clear, if footprint is null) a preview into the canvas. */
export function drawPiecePreview(
  canvas: HTMLCanvasElement,
  footprint: number[][] | null,
  colorHex: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!footprint) return;

  const pts = cells(footprint);
  if (pts.length === 0) return;

  // Iso projection: a unit cell is `tw` wide, `tw/2` tall; cube height `d`.
  // Pick tw so the whole cluster fits with padding.
  const colsSpan = footprint[0]?.length ?? 1;
  const rowsSpan = footprint.length;
  const isoW = colsSpan + rowsSpan; // diamond width in half-tiles
  const tw = Math.min((W - 8) / (isoW * 0.5), (H - 10) / (isoW * 0.5 + 1));
  const hw = tw / 2;
  const hh = tw / 4; // 2:1 iso
  const d = tw * 0.5; // cube vertical height

  // Cluster bounds in iso space, to centre it.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { c, r } of pts) {
    const cx = (c - r) * hw;
    const cy = (c + r) * hh;
    minX = Math.min(minX, cx - hw);
    maxX = Math.max(maxX, cx + hw);
    minY = Math.min(minY, cy - hh);
    maxY = Math.max(maxY, cy + hh + d);
  }
  const ox = W / 2 - (minX + maxX) / 2;
  const oy = H / 2 - (minY + maxY) / 2;

  const top = shade(colorHex, TOP_SHADE);
  const left = shade(colorHex, LEFT_SHADE);
  const right = shade(colorHex, RIGHT_SHADE);
  const edge = "rgba(10,11,18,0.55)";

  // Back-to-front: smaller (c + r) is further away, draw it first.
  pts.sort((a, b) => a.c + a.r - (b.c + b.r));
  for (const { c, r } of pts) {
    const cx = ox + (c - r) * hw;
    const cy = oy + (c + r) * hh;
    const face = (path: [number, number][], fill: string): void => {
      ctx.beginPath();
      const first = path[0];
      if (!first) return;
      ctx.moveTo(first[0], first[1]);
      for (let i = 1; i < path.length; i++) {
        const p = path[i];
        if (p) ctx.lineTo(p[0], p[1]);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    // left face, right face, then top diamond on top
    face(
      [
        [cx - hw, cy],
        [cx, cy + hh],
        [cx, cy + hh + d],
        [cx - hw, cy + d],
      ],
      left,
    );
    face(
      [
        [cx + hw, cy],
        [cx, cy + hh],
        [cx, cy + hh + d],
        [cx + hw, cy + d],
      ],
      right,
    );
    face(
      [
        [cx, cy - hh],
        [cx + hw, cy],
        [cx, cy + hh],
        [cx - hw, cy],
      ],
      top,
    );
  }
}
