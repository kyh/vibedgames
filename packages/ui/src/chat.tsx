import { useCallback, useEffect, useRef, useState } from "react";
import { delay, wrap } from "motion";
import { Typewriter } from "motion-plus/react";

import { Avatar, AvatarFallback, AvatarImage } from "./avatar";
import { Button } from "./button";
import { cn } from "./utils";

export type MessageProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

const Message = ({ children, className, ...props }: MessageProps) => (
  <div className={cn("flex justify-start gap-3", className)} {...props}>
    {children}
  </div>
);

export type MessageAvatarProps = {
  src: string;
  alt: string;
  fallback?: string;
  delayMs?: number;
  className?: string;
};

const MessageAvatar = ({
  src,
  alt,
  fallback,
  delayMs,
  className,
}: MessageAvatarProps) => {
  return (
    <Avatar className={cn("h-8 w-8 shrink-0", className)}>
      <AvatarImage src={src} alt={alt} />
      {fallback && (
        <AvatarFallback delayMs={delayMs}>{fallback}</AvatarFallback>
      )}
    </Avatar>
  );
};

export type MessageContentProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => {
  const classNames = cn(
    "text-muted-foreground bg-muted/40 max-w-[85%] flex-1 rounded-lg p-2 break-words whitespace-normal shadow-lg backdrop-blur-xs sm:max-w-[75%]",
    className,
  );

  return (
    <div className={classNames} {...props}>
      {children}
    </div>
  );
};

const useAutoScroll = (
  containerRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
) => {
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const lastScrollTopRef = useRef(0);
  const autoScrollingRef = useRef(false);

  const isAtBottom = (element: HTMLDivElement) => {
    const { scrollTop, scrollHeight, clientHeight } = element;
    return scrollHeight - scrollTop - clientHeight <= 2;
  };

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const container = containerRef.current;
    if (!container) return;

    autoScrollingRef.current = true;

    const targetScrollTop = container.scrollHeight - container.clientHeight;

    if (behavior === "smooth") {
      container.scrollTo({
        top: targetScrollTop,
        behavior: "smooth",
      });

      const checkScrollEnd = () => {
        if (Math.abs(container.scrollTop - targetScrollTop) < 2) {
          autoScrollingRef.current = false;
          return;
        }

        requestAnimationFrame(checkScrollEnd);
      };

      requestAnimationFrame(checkScrollEnd);

      const safetyTimeout = setTimeout(() => {
        autoScrollingRef.current = false;
      }, 500);

      try {
        const handleScrollEnd = () => {
          autoScrollingRef.current = false;
          clearTimeout(safetyTimeout);
          container.removeEventListener("scrollend", handleScrollEnd);
        };

        container.addEventListener("scrollend", handleScrollEnd, {
          once: true,
        });
      } catch (e) {
        // scrollend event not supported in this browser, fallback to requestAnimationFrame
      }
    } else {
      container.scrollTop = targetScrollTop;
      autoScrollingRef.current = false;
    }
  };

  useEffect(() => {
    if (!enabled) return;

    const container = containerRef.current;
    if (!container) return;

    lastScrollTopRef.current = container.scrollTop;

    const handleScroll = () => {
      if (autoScrollingRef.current) return;

      const currentScrollTop = container.scrollTop;

      if (currentScrollTop < lastScrollTopRef.current && autoScrollEnabled) {
        setAutoScrollEnabled(false);
      }

      if (isAtBottom(container) && !autoScrollEnabled) {
        setAutoScrollEnabled(true);
      }

      lastScrollTopRef.current = currentScrollTop;
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && autoScrollEnabled) {
        setAutoScrollEnabled(false);
      }
    };

    const handleTouchStart = () => {
      lastScrollTopRef.current = container.scrollTop;
    };

    const handleTouchMove = () => {
      if (container.scrollTop < lastScrollTopRef.current && autoScrollEnabled) {
        setAutoScrollEnabled(false);
      }

      lastScrollTopRef.current = container.scrollTop;
    };

    const handleTouchEnd = () => {
      if (isAtBottom(container) && !autoScrollEnabled) {
        setAutoScrollEnabled(true);
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    container.addEventListener("touchmove", handleTouchMove, { passive: true });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
    };
  }, [containerRef, enabled, autoScrollEnabled]);

  return {
    autoScrollEnabled,
    scrollToBottom,
    isScrolling: autoScrollingRef.current,
  };
};

export type MessagesContainerProps = {
  children: React.ReactNode;
  className?: string;
  autoScroll?: boolean;
  scrollToRef?: React.RefObject<HTMLDivElement | null>;
  ref?: React.RefObject<HTMLDivElement | null>;
} & React.HTMLAttributes<HTMLDivElement>;

const MessagesContainer = ({
  className,
  children,
  autoScroll = true,
  scrollToRef,
  ref,
  ...props
}: MessagesContainerProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const localBottomRef = useRef<HTMLDivElement>(null);
  const bottomRef = scrollToRef || localBottomRef;
  const MessagesContainerRef = ref || containerRef;

  const { autoScrollEnabled, scrollToBottom, isScrolling } = useAutoScroll(
    MessagesContainerRef,
    autoScroll,
  );

  useEffect(() => {
    if (autoScroll && autoScrollEnabled && !isScrolling) {
      requestAnimationFrame(() => {
        scrollToBottom("smooth");
      });
    }
  }, [children, autoScroll, autoScrollEnabled, isScrolling, scrollToBottom]);

  return (
    <div
      className={cn("flex flex-col overflow-y-auto", className)}
      role="log"
      ref={MessagesContainerRef}
      {...props}
    >
      {children}
      <div
        ref={bottomRef}
        className="h-[1px] w-full flex-shrink-0 scroll-mt-4"
        aria-hidden="true"
      />
    </div>
  );
};

type ChatTextareaProps = {
  className?: string;
  input: string;
  setInput: (input: string) => void;
  onSubmit: () => void;
  loading: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
};

const text = [
  "Build a 3D platformer where players navigate through a vibrant world",
  "Create a top-down shooter game with fast-paced action and unique weapons",
  "Develop a racing game with customizable vehicles and dynamic tracks",
  "Make a flight simulation game set in the city of San Francisco",
];

const ChatTextarea = ({
  className,
  input,
  setInput,
  onSubmit,
  loading,
  onFocus,
  onBlur,
}: ChatTextareaProps) => {
  const [focused, setFocused] = useState(false);
  const [index, setIndex] = useState(0);

  const handleFocus = useCallback(() => {
    setFocused(true);
    if (onFocus) onFocus();
  }, [onFocus]);
  const handleBlur = useCallback(() => {
    setFocused(false);
    if (onBlur) onBlur();
  }, [onBlur]);

  return (
    <div className={cn("bg-muted/50 rounded-[20px] p-3", className)}>
      {!focused && !input && (
        <Typewriter
          as="div"
          className="text-muted-foreground pointer-events-none absolute text-sm"
          speed="fast"
          onComplete={() =>
            delay(() => setIndex(wrap(0, text.length, index + 1)), 1)
          }
        >
          {text[index]}
        </Typewriter>
      )}
      <textarea
        className="w-full resize-none outline-none"
        onChange={(e) => setInput(e.target.value)}
        value={input}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="flex items-center gap-2 pt-2">
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs"
          onClick={onSubmit}
          loading={loading}
        >
          <span>⌘</span>
          <kbd>Enter</kbd>
        </Button>
      </div>
    </div>
  );
};

export {
  Message,
  MessageAvatar,
  MessageContent,
  MessagesContainer,
  ChatTextarea,
};
