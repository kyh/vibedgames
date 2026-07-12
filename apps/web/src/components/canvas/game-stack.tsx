import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, type PanInfo } from "motion/react";

// Animation constants
const ANIMATION_DURATION = 0.6;
const BLUR_AMOUNT = "5px";

// Mobile breakpoint
const MOBILE_BREAKPOINT = 640;

// Swipe: distance (px) or flick velocity (px/s) past which a drag advances the stack.
const SWIPE_DISTANCE = 80;
const SWIPE_VELOCITY = 400;
// Movement past this is a swipe, not a tap — used to suppress the click that follows a drag.
const TAP_SLOP = 8;

const past = (value: number, threshold: number) => Math.abs(value) > threshold;

/**
 * The card is dragged freely on both axes. Throwing it far or fast enough in ANY direction
 * deals the next card — direction carries no meaning, so there is no way to swipe backwards.
 */
const isSwipe = ({ offset, velocity }: PanInfo) =>
  past(Math.hypot(offset.x, offset.y), SWIPE_DISTANCE) ||
  past(Math.hypot(velocity.x, velocity.y), SWIPE_VELOCITY);

// Z-depth values for card stacking
const Z_DEPTHS = {
  mobile: {
    active: { stacked: "-20vw", unstacked: "0vw" },
    next: { stacked: "-30vw", unstacked: "-10vw" },
    previous: { stacked: "-20vw", unstacked: "0vw" },
    behind: { stacked: "-40vw", unstacked: "-20vw" },
  },
  desktop: {
    active: { stacked: "-70vw", unstacked: "0vw" },
    next: { stacked: "-80vw", unstacked: "-10vw" },
    previous: { stacked: "-70vw", unstacked: "0vw" },
    behind: { stacked: "-90vw", unstacked: "-20vw" },
  },
} as const;

// Y positions
const Y_POSITIONS = {
  active: 0,
  next: "-5vh",
  previous: "150vh",
  behind: "-10vh",
} as const;

type GameCardProps = {
  index: number;
  total: number;
  showStack: boolean;
  currentIndex: number;
  isMobile: boolean;
  /** Set while a drag is in flight, so the trailing click doesn't launch the game. */
  swipedRef: React.RefObject<boolean>;
  onSwipe?: () => void;
  children: React.ReactNode;
};

const getCardVariants = (
  isActive: boolean,
  isNext: boolean,
  isPrevious: boolean,
  cardsBehind: number,
  showStack: boolean,
  isMobile: boolean,
) => {
  const depths = isMobile ? Z_DEPTHS.mobile : Z_DEPTHS.desktop;

  if (isActive) {
    return {
      z: showStack ? depths.active.stacked : depths.active.unstacked,
      y: Y_POSITIONS.active,
    };
  }

  if (isNext) {
    return {
      z: showStack ? depths.next.stacked : depths.next.unstacked,
      y: Y_POSITIONS.next,
    };
  }

  if (isPrevious) {
    return {
      z: showStack ? depths.previous.stacked : depths.previous.unstacked,
      y: Y_POSITIONS.previous,
    };
  }

  const baseZ = showStack ? depths.behind.stacked : depths.behind.unstacked;
  return {
    z: `calc(${baseZ} - ${cardsBehind}px)`,
    y: Y_POSITIONS.behind,
  };
};

export const GameCard = ({
  currentIndex,
  index,
  total,
  showStack,
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

  const variants = useMemo(
    () => getCardVariants(isActive, isNext, isPrevious, cardsBehind, showStack, isMobile),
    [isActive, isNext, isPrevious, cardsBehind, showStack, isMobile],
  );

  // Reset exit completion when showStack becomes true
  // Note: This effect synchronizes animation state with prop changes
  useEffect(() => {
    if (showStack) {
      setHasCompletedExit(false);
    }
  }, [showStack]);

  const handleAnimationComplete = () => {
    if (!showStack && isActive) {
      setHasCompletedExit(true);
    }
  };

  // Hide non-active cards immediately, hide active card after exit animation completes
  if (!showStack && (!isActive || hasCompletedExit)) {
    return null;
  }

  // Only the front card of the stack is swipeable, and only on touch-sized screens.
  const isDraggable = isMobile && showStack && isActive && !!onSwipe;

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    swipedRef.current = Math.hypot(info.offset.x, info.offset.y) > TAP_SLOP;

    if (isSwipe(info)) onSwipe?.();
  };

  return (
    <motion.div
      className="pointer-events-auto col-span-full row-span-full h-full w-full"
      initial={false}
      animate={variants}
      exit={variants}
      transition={{ type: "spring", duration: ANIMATION_DURATION }}
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

type Props<T extends { preview: string; previewPortrait?: string; name: string; slug: string }> = {
  data: T[];
  activeSlug?: string;
  showStack: boolean;
  onPreviewClick?: (game: T) => void;
  onSwipe?: (game: T) => void;
};

const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };

    // Set initial value
    checkMobile();

    // Listen for resize events
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  return isMobile;
};

export const GameStack = <
  T extends { preview: string; previewPortrait?: string; name: string; slug: string },
>({
  data,
  activeSlug,
  showStack,
  onPreviewClick,
  onSwipe,
}: Props<T>) => {
  const isMobile = useIsMobile();
  const swipedRef = useRef(false);

  const foundIndex = data.findIndex((item) => item.slug === activeSlug);
  const currentIndex = foundIndex >= 0 ? foundIndex : 0;

  const handleSwipe = onSwipe
    ? () => {
        const next = data[(currentIndex + 1) % data.length];
        if (next) onSwipe(next);
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
              showStack={showStack}
              currentIndex={currentIndex}
              isMobile={isMobile}
              swipedRef={swipedRef}
              onSwipe={handleSwipe}
            >
              <motion.button
                className="absolute inset-0 overflow-clip rounded-xl shadow-lg"
                onClick={() => {
                  // A drag ends with a click; only a tap should launch the game.
                  if (swipedRef.current) {
                    swipedRef.current = false;
                    return;
                  }
                  onPreviewClick?.(item);
                }}
                initial={{ opacity: 0, filter: `blur(${BLUR_AMOUNT})` }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: `blur(${BLUR_AMOUNT})` }}
                transition={{ duration: 0.2 }}
              >
                <picture>
                  {item.previewPortrait && (
                    <source media="(orientation: portrait)" srcSet={item.previewPortrait} />
                  )}
                  <img
                    className="absolute inset-0 h-full w-full object-cover"
                    src={item.preview}
                    alt={item.name}
                    // Native image drag cancels the pointer stream and kills the swipe gesture.
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
