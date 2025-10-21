"use client";

import { createContext, useContext, useState } from "react";
import { motion } from "framer-motion";

type PreviewStackContextType = {
  currentIndex: number;
  setCurrentIndex: (index: number) => void;
};

const PreviewStackContext = createContext<PreviewStackContextType | undefined>(
  undefined,
);

export const PreviewStackProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);

  const value: PreviewStackContextType = {
    currentIndex,
    setCurrentIndex,
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
  zoomed: boolean;
  children: React.ReactNode;
};

export const PreviewCard = ({
  index,
  total,
  zoomed,
  children,
}: PreviewCardProps) => {
  const { currentIndex } = usePreviewStack();
  const [isVisible, setIsVisible] = useState(true);
  const isActive = index === currentIndex;
  const isNext = index === (currentIndex + 1) % total;
  const isPrevious = index === (currentIndex - 1 + total) % total;

  const getAnimateVariants = () => {
    if (isActive) return { z: zoomed ? "-10vw" : "0vw", y: 0 };
    if (isNext) return { z: zoomed ? "-70vw" : "-60vw", y: "-5vh" };
    if (isPrevious) return { z: zoomed ? "-10vw" : "0vw", y: "120vh" };
    return { z: zoomed ? "-130vw" : "-120vw", y: "-10vh" };
  };

  return (
    <motion.div
      className="col-span-full row-span-full h-full w-full"
      initial={false}
      animate={getAnimateVariants()}
      transition={{ type: "spring", duration: 0.6 }}
      onAnimationStart={() => setIsVisible(true)}
      onAnimationComplete={() => {
        if (!isActive) setIsVisible(false);
      }}
      style={{ display: isVisible ? "block" : "none" }}
    >
      {children}
    </motion.div>
  );
};

type Props<T> = {
  data: T[];

  render: (d: T) => React.ReactNode;
  zoomed: boolean;
};

export const PreviewStack = <T extends { id: string | number }>({
  data,
  render,
  zoomed,
}: Props<T>) => {
  return (
    <section className="relative h-full w-full perspective-[150vw]">
      <div className="grid h-full w-full place-items-center transform-3d">
        {data.map((item, index) => {
          return (
            <PreviewCard
              key={item.id}
              index={index}
              total={data.length}
              zoomed={zoomed}
            >
              {render(item)}
            </PreviewCard>
          );
        })}
      </div>
    </section>
  );
};
