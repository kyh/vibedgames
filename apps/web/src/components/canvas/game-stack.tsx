import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { PanInfo } from "motion/react";

const ANIMATION_DURATION = 0.6;
const FADE_OUT_DURATION = 0.25;
const BLUR_AMOUNT = "5px";

const MOBILE_BREAKPOINT = 640;

const SWIPE_DISTANCE = 80;
const SWIPE_VELOCITY = 400;
const TAP_SLOP = 8;

const past = (value: number, threshold: number) => Math.abs(value) > threshold;

const isSwipe = ({ offset, velocity }: PanInfo) =>
  past(Math.hypot(offset.x, offset.y), SWIPE_DISTANCE) ||
  past(Math.hypot(velocity.x, velocity.y), SWIPE_VELOCITY);

const Z_DEPTHS = {
  desktop: {
    active: { stacked: "-70vw", unstacked: "0vw" },
    behind: { stacked: "-90vw", unstacked: "-20vw" },
    next: { stacked: "-80vw", unstacked: "-10vw" },
    previous: { stacked: "-70vw", unstacked: "0vw" },
  },
  mobile: {
    active: { stacked: "-20vw", unstacked: "0vw" },
    behind: { stacked: "-40vw", unstacked: "-20vw" },
    next: { stacked: "-30vw", unstacked: "-10vw" },
    previous: { stacked: "-20vw", unstacked: "0vw" },
  },
} as const;

const Y_POSITIONS = {
  active: 0,
  behind: "-10vh",
  next: "-5vh",
  previous: "150vh",
} as const;

/**
 * How the stack behaves on the current route.
 *
 * - `stack` — the browsable deck (discover).
 * - `zoom`  — the active card flies at the camera and hands off to the game (play). The zoom
 *   only reads as a transition because the iframe lands on top of it, so it belongs to
 *   discover <-> play and nowhere else.
 * - `hidden` — every other route: the deck fades out where it stands, no zoom.
 */
export type StackMode = "stack" | "zoom" | "hidden";

interface GameCardProps {
  index: number;
  total: number;
  mode: StackMode;
  currentIndex: number;
  isMobile: boolean;
  swipedRef: React.RefObject<boolean>;
  onSwipe?: () => void;
  children: React.ReactNode;
}

const getCardVariants = (
  isActive: boolean,
  isNext: boolean,
  isPrevious: boolean,
  cardsBehind: number,
  stacked: boolean,
  isMobile: boolean,
) => {
  const depths = isMobile ? Z_DEPTHS.mobile : Z_DEPTHS.desktop;

  if (isActive) {
    return {
      y: Y_POSITIONS.active,
      z: stacked ? depths.active.stacked : depths.active.unstacked,
    };
  }

  if (isNext) {
    return {
      y: Y_POSITIONS.next,
      z: stacked ? depths.next.stacked : depths.next.unstacked,
    };
  }

  if (isPrevious) {
    return {
      y: Y_POSITIONS.previous,
      z: stacked ? depths.previous.stacked : depths.previous.unstacked,
    };
  }

  const baseZ = stacked ? depths.behind.stacked : depths.behind.unstacked;

  return {
    y: Y_POSITIONS.behind,
    z: `calc(${baseZ} - ${cardsBehind}px)`,
  };
};

const GameCard = ({
  currentIndex,
  index,
  total,
  mode,
  isMobile,
  swipedRef,
  onSwipe,
  children,
}: GameCardProps) => {
  const isActive = index === currentIndex;
  const isNext = index === (currentIndex + 1) % total;
  const isPrevious = index === (currentIndex - 1 + total) % total;
  const [hasCompletedExit, setHasCompletedExit] = useState(true);

  const cardsBehind = (index - currentIndex + total) % total;

  const stacked = mode !== "zoom";

  const variants = useMemo(
    () => getCardVariants(isActive, isNext, isPrevious, cardsBehind, stacked, isMobile),
    [isActive, isNext, isPrevious, cardsBehind, stacked, isMobile],
  );

  const [armedFor, setArmedFor] = useState(mode);

  if (armedFor !== mode) {
    setArmedFor(mode);

    if (mode === "stack") {
      setHasCompletedExit(false);
    }
  }

  const handleAnimationComplete = () => {
    if (mode !== "stack") {
      setHasCompletedExit(true);
    }
  };

  if (mode === "zoom" && !isActive) {
    return null;
  }

  if (mode !== "stack" && hasCompletedExit) {
    return null;
  }

  const isDraggable = isMobile && mode === "stack" && isActive && !!onSwipe;

  const handleDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    swipedRef.current = Math.hypot(info.offset.x, info.offset.y) > TAP_SLOP;

    if (isSwipe(info)) {
      onSwipe?.();
    }
  };

  return (
    <motion.div
      className={
        mode === "hidden"
          ? "pointer-events-none col-span-full row-span-full h-full w-full"
          : "pointer-events-auto col-span-full row-span-full h-full w-full"
      }
      initial={false}
      animate={{ ...variants, opacity: mode === "hidden" ? 0 : 1 }}
      exit={variants}
      transition={{
        duration: ANIMATION_DURATION,
        opacity: { duration: FADE_OUT_DURATION },
        type: "spring",
      }}
      onAnimationComplete={handleAnimationComplete}
    >
      <motion.div
        className="h-full w-full"
        drag={isDraggable}
        dragSnapToOrigin
        dragElastic={0.4}
        dragMomentum={false}
        onPointerDownCapture={() => (swipedRef.current = false)}
        onDragEnd={handleDragEnd}
      >
        {children}
      </motion.div>
    </motion.div>
  );
};

interface Props<
  T extends { preview: string; previewPortrait?: string; name: string; slug: string },
> {
  data: T[];
  activeSlug?: string;
  mode: StackMode;
  onPreviewClick?: (game: T) => void;
  onSwipe?: (game: T) => void;
}

const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };

    checkMobile();

    window.addEventListener("resize", checkMobile);

    return () => {
      window.removeEventListener("resize", checkMobile);
    };
  }, []);

  return isMobile;
};

export const GameStack = <
  T extends { preview: string; previewPortrait?: string; name: string; slug: string },
>({
  data,
  activeSlug,
  mode,
  onPreviewClick,
  onSwipe,
}: Props<T>) => {
  const isMobile = useIsMobile();
  const swipedRef = useRef(false);

  const foundIndex = data.findIndex((item) => item.slug === activeSlug);
  const currentIndex = Math.max(foundIndex, 0);

  const handleSwipe = onSwipe
    ? () => {
        const next = data[(currentIndex + 1) % data.length];

        if (next) {
          onSwipe(next);
        }
      }
    : undefined;

  return (
    <section className="pointer-events-none relative h-full w-full perspective-[150vw]">
      <div className="grid h-full w-full place-items-center transform-3d">
        <AnimatePresence>
          {data.map((item, index) => (
            <GameCard
              key={item.name}
              index={index}
              total={data.length}
              mode={mode}
              currentIndex={currentIndex}
              isMobile={isMobile}
              swipedRef={swipedRef}
              onSwipe={handleSwipe}
            >
              <motion.button
                className="absolute inset-0 overflow-clip rounded-xl shadow-lg"
                onClick={() => {
                  if (swipedRef.current) {
                    swipedRef.current = false;

                    return;
                  }

                  onPreviewClick?.(item);
                }}
                initial={{ filter: `blur(${BLUR_AMOUNT})`, opacity: 0 }}
                animate={{ filter: "blur(0px)", opacity: 1 }}
                exit={{ filter: `blur(${BLUR_AMOUNT})`, opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <picture>
                  {item.previewPortrait !== undefined && item.previewPortrait !== "" && (
                    <source media="(orientation: portrait)" srcSet={item.previewPortrait} />
                  )}
                  <img
                    className="absolute inset-0 h-full w-full object-cover"
                    src={item.preview}
                    alt={item.name}
                    draggable={false}
                  />
                </picture>
              </motion.button>
            </GameCard>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
};
