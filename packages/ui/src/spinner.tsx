import * as React from "react";

import { cn } from "./utils";

const variants = [
  "default",
  "wave",
  "spiral",
  "chase",
  "rain",
  "star",
  "crosshair",
  "snake",
] as const;

type SpinnerVariant = (typeof variants)[number];

type SpinnerProps = React.HTMLAttributes<HTMLDivElement> & {
  size?: number;
  gridSize?: number;
  variant?: SpinnerVariant;
};

// Get animation delay based on variant and position
const getAnimationDelay = (
  variant: SpinnerVariant,
  x: number,
  y: number,
  gridSize: number,
): string => {
  const center = (gridSize - 1) / 2;

  switch (variant) {
    case "default":
      // Diagonal wave from top-left
      return `${0.05 * (x + y)}s`;

    case "wave":
      // Horizontal wave
      return `${0.1 * x}s`;

    case "spiral": {
      // Spiral from center outward
      const dx = x - center;
      const dy = y - center;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const normalizedAngle = (angle + Math.PI) / (2 * Math.PI);
      return `${(distance * 0.15 + normalizedAngle * 0.3).toFixed(2)}s`;
    }

    case "chase": {
      // Chase around the perimeter
      const isTop = y === 0;
      const isBottom = y === gridSize - 1;
      const isLeft = x === 0;
      const isRight = x === gridSize - 1;
      const isEdge = isTop || isBottom || isLeft || isRight;

      if (!isEdge) return "0s";

      let order = 0;
      if (isTop) order = x;
      else if (isRight) order = gridSize - 1 + y;
      else if (isBottom) order = 2 * (gridSize - 1) + (gridSize - 1 - x);
      else if (isLeft) order = 3 * (gridSize - 1) + (gridSize - 1 - y);

      const perimeter = 4 * (gridSize - 1);
      return `${(order / perimeter) * 0.8}s`;
    }

    case "rain":
      // Rain falling from top, each column offset
      return `${y * 0.1 + x * 0.05}s`;

    case "star": {
      // Star pattern - radiates outward from center along cross and diagonals
      const centerIdx = Math.floor(gridSize / 2);
      const dx = x - centerIdx;
      const dy = y - centerIdx;
      const isCross = x === centerIdx || y === centerIdx;
      const isDiagonal = Math.abs(dx) === Math.abs(dy);
      if (!isCross && !isDiagonal) return "0s";

      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      return `${dist * 0.12}s`;
    }

    case "crosshair": {
      // Center row and column animate outward from center
      const centerIdx = Math.floor(gridSize / 2);
      const isCenterRow = y === centerIdx;
      const isCenterCol = x === centerIdx;
      if (!isCenterRow && !isCenterCol) return "0s";

      const distFromCenter = isCenterRow
        ? Math.abs(x - centerIdx)
        : Math.abs(y - centerIdx);
      return `${distFromCenter * 0.1}s`;
    }

    case "snake": {
      // Snake pattern (alternating direction per row)
      const effectiveX = y % 2 === 0 ? x : gridSize - 1 - x;
      return `${(y * gridSize + effectiveX) * 0.05}s`;
    }

    default:
      return `${0.05 * (x + y)}s`;
  }
};

// Get animation name for variant
const getAnimationName = (variant: SpinnerVariant): string => {
  switch (variant) {
    case "chase":
      return "pixel-chase";
    case "rain":
      return "pixel-rain";
    case "crosshair":
      return "pixel-crosshair";
    default:
      return "pixel-scale";
  }
};

// Get animation duration for variant
const getAnimationDuration = (variant: SpinnerVariant): string => {
  switch (variant) {
    case "chase":
      return "0.8s";
    case "rain":
      return "0.8s";
    case "crosshair":
      return "0.6s";
    case "snake":
      return "1.5s";
    default:
      return "1s";
  }
};

// Check if pixel should be visible for certain variants
const shouldShowPixel = (
  variant: SpinnerVariant,
  x: number,
  y: number,
  gridSize: number,
): boolean => {
  if (variant === "chase") {
    const isTop = y === 0;
    const isBottom = y === gridSize - 1;
    const isLeft = x === 0;
    const isRight = x === gridSize - 1;
    return isTop || isBottom || isLeft || isRight;
  }

  if (variant === "star") {
    const centerIdx = Math.floor(gridSize / 2);
    const dx = x - centerIdx;
    const dy = y - centerIdx;
    const isCross = x === centerIdx || y === centerIdx;
    const isDiagonal = Math.abs(dx) === Math.abs(dy);
    const isCorner =
      (x === 0 || x === gridSize - 1) && (y === 0 || y === gridSize - 1);
    return (isCross || isDiagonal) && !isCorner;
  }

  if (variant === "crosshair") {
    const centerIdx = Math.floor(gridSize / 2);
    return x === centerIdx || y === centerIdx;
  }

  return true;
};

export const Spinner = React.forwardRef<HTMLDivElement, SpinnerProps>(
  ({ className, size = 8, gridSize = 3, variant = "default", ...props }, ref) => {
    const squareSize = `${size}px`;
    const gridArray = Array.from({ length: gridSize }, (_, i) => i);

    return (
      <div
        ref={ref}
        className={cn("inline-flex flex-col gap-0", className)}
        style={{ "--square-size": squareSize } as React.CSSProperties}
        {...props}
      >
        {gridArray.map((y) => (
          <div key={y} className="flex gap-0">
            {gridArray.map((x) => {
              const show = shouldShowPixel(variant, x, y, gridSize);
              return (
                <div
                  key={x}
                  className="relative inline-block animate-[hue-rotate_10s_linear_infinite]"
                  style={{
                    width: "var(--square-size)",
                    height: "var(--square-size)",
                  }}
                >
                  {show && (
                    <div
                      className="absolute top-0 left-0 bg-[#ff0] [box-shadow:0_0_10px_#ff0,0_0_20px_#ff0,0_0_40px_#ff0]"
                      style={{
                        width: "var(--square-size)",
                        height: "var(--square-size)",
                        animation: `${getAnimationName(variant)} ${getAnimationDuration(variant)} linear infinite`,
                        animationDelay: getAnimationDelay(variant, x, y, gridSize),
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  },
);

Spinner.displayName = "Spinner";

export { variants as spinnerVariants };
export type { SpinnerVariant };
