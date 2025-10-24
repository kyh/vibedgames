"use client";

import { AnimatePresence, motion } from "motion/react";

import { useUiStore } from "@/app/(home)/_components/ui-state";

type PreviewCardProps = {
  index: number;
  total: number;
  showStack: boolean;
  children: React.ReactNode;
};

export const PreviewCard = ({
  index,
  total,
  showStack,
  children,
}: PreviewCardProps) => {
  const { currentIndex, isMobile } = useUiStore();
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

export const PreviewStack = <T extends { id: string | number }>({
  data,
  render,
  showStack,
}: Props<T>) => {
  return (
    <section className="pointer-events-none relative h-full w-full perspective-[150vw]">
      <div className="grid h-full w-full place-items-center transform-3d">
        <AnimatePresence>
          {data.map((item, index) => {
            return (
              <PreviewCard
                key={item.id}
                index={index}
                total={data.length}
                showStack={showStack}
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
