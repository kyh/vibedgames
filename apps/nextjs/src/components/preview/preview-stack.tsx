"use client";

import { AnimatePresence, motion } from "motion/react";

import { useUiStore } from "@/app/[[...gameId]]/_components/ui-store";

type PreviewCardProps = {
  index: number;
  total: number;
  showStack: boolean;
  currentIndex: number;
  children: React.ReactNode;
};

export const PreviewCard = ({
  index,
  total,
  showStack,
  currentIndex,
  children,
}: PreviewCardProps) => {
  const { isMobile } = useUiStore();
  const isActive = index === currentIndex;
  const isNext = index === (currentIndex + 1) % total;
  const isPrevious = index === (currentIndex - 1 + total) % total;

  const getAnimateVariants = () => {
    const cardsBehind = (index - currentIndex + total) % total;

    if (isMobile) {
      if (isActive) return { z: showStack ? "-20vw" : "0vw", y: 0 };
      if (isNext) return { z: showStack ? "-30vw" : "-10vw", y: "-5vh" };
      if (isPrevious) return { z: showStack ? "-20vw" : "0vw", y: "150vh" };
      return {
        z: showStack
          ? `calc(-40vw - ${cardsBehind * 1}px)`
          : `calc(-20vw - ${cardsBehind * 1}px)`,
        y: "-10vh",
      };
    }

    if (isActive) return { z: showStack ? "-70vw" : "0vw", y: 0 };
    if (isNext) return { z: showStack ? "-80vw" : "-10vw", y: "-5vh" };
    if (isPrevious) return { z: showStack ? "-70vw" : "0vw", y: "150vh" };
    return {
      z: showStack
        ? `calc(-90vw - ${cardsBehind * 1}px)`
        : `calc(-20vw - ${cardsBehind * 1}px)`,
      y: "-10vh",
    };
  };

  if (!showStack && !isActive) {
    return null;
  }

  return (
    <motion.div
      className="pointer-events-auto col-span-full row-span-full h-full w-full"
      initial={false}
      animate={getAnimateVariants()}
      exit={getAnimateVariants()}
      transition={{ type: "spring", duration: 0.6 }}
    >
      {children}
    </motion.div>
  );
};

type Props<T> = {
  data: T[];
  render: (d: T) => React.ReactNode;
  showStack: boolean;
};

export const PreviewStack = <T extends { gameId: string }>({
  data,
  render,
  showStack,
}: Props<T>) => {
  const { gameId } = useUiStore();
  // Find the current index based on gameId
  const currentIndex = gameId
    ? data.findIndex((item) => item.gameId === gameId)
    : 0;
  // If gameId not found, default to 0
  const activeIndex = currentIndex >= 0 ? currentIndex : 0;

  return (
    <section className="pointer-events-none relative h-full w-full perspective-[150vw]">
      <div className="grid h-full w-full place-items-center transform-3d">
        <AnimatePresence>
          {data.map((item, index) => {
            return (
              <PreviewCard
                key={item.gameId}
                index={index}
                total={data.length}
                showStack={showStack}
                currentIndex={activeIndex}
              >
                {render(item)}
              </PreviewCard>
            );
          })}
        </AnimatePresence>
      </div>
    </section>
  );
};
