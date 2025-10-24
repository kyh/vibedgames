"use client";

import { createContext, useContext, useState } from "react";
import { useMediaQuery } from "@repo/ui/utils";
import { AnimatePresence, motion } from "motion/react";

type PreviewStackContextType = {
  currentIndex: number;
  setCurrentIndex: (index: number) => void;
  isMobile: boolean;
};

const PreviewStackContext = createContext<PreviewStackContextType | undefined>(
  undefined,
);

export const PreviewStackProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const isMobile = useMediaQuery("(max-width: 640px)");
  const [currentIndex, setCurrentIndex] = useState(0);

  const value: PreviewStackContextType = {
    currentIndex,
    setCurrentIndex,
    isMobile,
  };

  return (
    <PreviewStackContext.Provider value={value}>
      {children}
    </PreviewStackContext.Provider>
  );
};

export const usePreviewStack = () => {
  const context = useContext(PreviewStackContext);
  if (context === undefined) {
    throw new Error(
      "usePreviewStack must be used within a PreviewStackProvider",
    );
  }
  return context;
};

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
  const { currentIndex, isMobile } = usePreviewStack();
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
