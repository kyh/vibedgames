const TOP_SHADE = 1;
const LEFT_SHADE = 0.6;
const RIGHT_SHADE = 0.82;

/* oxlint-disable no-bitwise -- unpacking the 0xRRGGBB channels of a color word */
const shade = (hex: number, f: number) => {
  const r = Math.trunc(Math.min(255, ((hex >> 16) & 255) * f));
  const g = Math.trunc(Math.min(255, ((hex >> 8) & 255) * f));
  const b = Math.trunc(Math.min(255, (hex & 255) * f));

  return `rgb(${r},${g},${b})`;
};
/* oxlint-enable no-bitwise */

const cells = (footprint: number[][]) => {
  const out: { c: number; r: number }[] = [];

  for (let r = 0; r < footprint.length; r += 1) {
    const row = footprint[r] ?? [];

    for (let c = 0; c < row.length; c += 1) {
      if ((row[c] ?? 0) !== 0) {
        out.push({ c, r });
      }
    }
  }

  return out;
};

/** Render (or clear, if footprint is null) a preview into the canvas. */
export const drawPiecePreview = (
  canvas: HTMLCanvasElement,
  footprint: number[][] | null,
  colorHex: number,
) => {
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return;
  }

  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!footprint) {
    return;
  }

  const pts = cells(footprint);

  if (pts.length === 0) {
    return;
  }

  const colsSpan = footprint[0]?.length ?? 1;
  const rowsSpan = footprint.length;
  const isoW = colsSpan + rowsSpan;
  const tw = Math.min((W - 8) / (isoW * 0.5), (H - 10) / (isoW * 0.5 + 1));
  const hw = tw / 2;
  const hh = tw / 4;
  const d = tw * 0.5;

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

  pts.sort((a, b) => a.c + a.r - (b.c + b.r));

  for (const { c, r } of pts) {
    const cx = ox + (c - r) * hw;
    const cy = oy + (c + r) * hh;

    const face = (path: [number, number][], fill: string) => {
      ctx.beginPath();
      const [first] = path;

      if (!first) {
        return;
      }

      ctx.moveTo(first[0], first[1]);

      for (let i = 1; i < path.length; i += 1) {
        const p = path[i];

        if (p) {
          ctx.lineTo(p[0], p[1]);
        }
      }

      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

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
};
