"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";

import { useUiStore } from "@/app/[[...gameId]]/_components/ui-store";

// Animation constants
const ANIMATION_DURATION = 0.6;
const BLUR_AMOUNT = "5px";

// Mobile breakpoint
const MOBILE_BREAKPOINT = 640;

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
  children,
}: GameCardProps) => {
  const isActive = index === currentIndex;
  const isNext = index === (currentIndex + 1) % total;
  const isPrevious = index === (currentIndex - 1 + total) % total;
  const [hasCompletedExit, setHasCompletedExit] = useState(true);

  const cardsBehind = (index - currentIndex + total) % total;

  const variants = useMemo(
    () =>
      getCardVariants(
        isActive,
        isNext,
        isPrevious,
        cardsBehind,
        showStack,
        isMobile,
      ),
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

  return (
    <motion.div
      className="pointer-events-auto col-span-full row-span-full h-full w-full"
      initial={false}
      animate={variants}
      exit={variants}
      transition={{ type: "spring", duration: ANIMATION_DURATION }}
      onAnimationComplete={handleAnimationComplete}
    >
      {children}
    </motion.div>
  );
};

type Props<T extends { preview: string; name: string }> = {
  data: T[];
  showStack: boolean;
  // Note: Next.js may warn about Server Actions, but this is a client component callback
  onPreviewClick?: (game: T) => void;
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

export const GameStack = <T extends { preview: string; name: string }>({
  data,
  showStack,
  onPreviewClick,
}: Props<T>) => {
  const { discoverGameIndex } = useUiStore();
  const isMobile = useIsMobile();

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
              currentIndex={discoverGameIndex}
              isMobile={isMobile}
            >
              <motion.button
                className="absolute inset-0 overflow-clip rounded-xl shadow-lg"
                onClick={() => onPreviewClick?.(item)}
                initial={{ opacity: 0, filter: `blur(${BLUR_AMOUNT})` }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: `blur(${BLUR_AMOUNT})` }}
                transition={{ duration: 0.2 }}
              >
                <Image
                  className="object-cover"
                  src={item.preview}
                  alt={item.name}
                  fill
                />
              </motion.button>
            </GameCard>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
};
