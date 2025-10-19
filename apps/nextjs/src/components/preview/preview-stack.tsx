"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  animate,
  easeIn,
  mix,
  motion,
  progress,
  useMotionValue,
  wrap,
} from "motion/react";

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
  currentIndex: number;
  total: number;
  minDistance?: number;
  minSpeed?: number;
  setNextPost: () => void;
  children: React.ReactNode;
};

export const PreviewCard = ({
  index,
  currentIndex,
  total,
  setNextPost,
  minDistance = 400,
  minSpeed = 50,
  children,
}: PreviewCardProps) => {
  const x = useMotionValue(0);
  const zIndex = total - wrap(total, 0, index - currentIndex + 1);

  const onDragEnd = () => {
    const distance = Math.abs(x.get());
    const speed = Math.abs(x.getVelocity());

    if (distance > minDistance || speed > minSpeed) {
      setNextPost();

      animate(x, 0, {
        type: "spring",
        stiffness: 600,
        damping: 50,
      });
    } else {
      animate(x, 0, {
        type: "spring",
        stiffness: 300,
        damping: 50,
      });
    }
  };

  const opacity = progress(total * 0.25, total * 0.75, zIndex);

  const progressInStack = progress(0, total - 1, zIndex);
  const scale = mix(0.5, 1, easeIn(progressInStack));

  return (
    <motion.div
      className="absolute top-0 h-full w-full cursor-grab overflow-auto"
      style={{
        zIndex,
        x,
      }}
      initial={{ opacity: 0, scale: 0.3 }}
      animate={{ opacity, scale }}
      whileTap={index === currentIndex ? { scale: 0.98 } : {}}
      transition={{
        type: "spring",
        stiffness: 600,
        damping: 30,
      }}
      drag={index === currentIndex ? "x" : false}
      onDragEnd={onDragEnd}
    >
      <motion.div className="bg-card h-fit w-full shadow-sm">
        {children}
      </motion.div>
    </motion.div>
  );
};

type Props<T> = {
  data: T[];
  render: (d: T) => React.ReactNode;
  onLoadMore?: () => void;
  hasNextPage?: boolean;
};

export const PreviewStack = <T extends { id: string }>({
  data,
  render,
  hasNextPage,
  onLoadMore,
}: Props<T>) => {
  const { currentIndex, setCurrentIndex } = usePreviewStack();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);

  useEffect(() => {
    if (!ref.current) return;
    setWidth(ref.current.offsetWidth);
  }, []);

  const handleSetNextPost = () => {
    const postsLeft = data.length - currentIndex - 1;
    if (postsLeft <= 1 && hasNextPage && onLoadMore) onLoadMore();
    const newIndex = wrap(0, data.length, currentIndex + 1);
    setCurrentIndex(newIndex);
  };

  return (
    <div ref={ref} className="relative h-full w-full">
      {data.map((item, index) => {
        return (
          <PreviewCard
            key={item.id}
            minDistance={width * 0.5}
            index={index}
            currentIndex={currentIndex}
            total={data.length}
            setNextPost={handleSetNextPost}
          >
            {render(item)}
          </PreviewCard>
        );
      })}
    </div>
  );
};
