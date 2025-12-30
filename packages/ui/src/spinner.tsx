import * as React from "react";

import { cn } from "./utils";

type SpinnerProps = React.HTMLAttributes<HTMLDivElement> & {
  size?: number;
  gridSize?: number;
};

export const Spinner = React.forwardRef<HTMLDivElement, SpinnerProps>(
  ({ className, size = 8, gridSize = 3, ...props }, ref) => {
    const squareSize = `${size}px`;
    const gridArray = Array.from({ length: gridSize }, (_, i) => i + 1);

    return (
      <div
        ref={ref}
        className={cn("inline-flex flex-col gap-0", className)}
        style={{ "--square-size": squareSize } as React.CSSProperties}
        {...props}
      >
        {gridArray.map((y) => (
          <div
            key={y}
            className="flex gap-0"
            style={{ "--y": y } as React.CSSProperties}
          >
            {gridArray.map((i) => (
              <div
                key={i}
                className="relative inline-block animate-[hue-rotate_10s_linear_infinite]"
                style={
                  {
                    "--i": i,
                    width: "var(--square-size)",
                    height: "var(--square-size)",
                  } as React.CSSProperties
                }
              >
                <div
                  className="absolute top-0 left-0 animate-[pixel-scale_1s_linear_infinite] bg-[#ff0] [box-shadow:0_0_10px_#ff0,0_0_20px_#ff0,0_0_40px_#ff0]"
                  style={
                    {
                      width: "var(--square-size)",
                      height: "var(--square-size)",
                      animationDelay: `calc(0.05s * (var(--i) + var(--y)))`,
                    } as React.CSSProperties
                  }
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  },
);

Spinner.displayName = "Spinner";
