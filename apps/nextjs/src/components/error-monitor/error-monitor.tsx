"use client";

import { createContext, useContext } from "react";

type Props = {
  children: React.ReactNode;
};

/**
 * Error monitor context - simplified for sandpack-based architecture.
 * Sandpack handles errors internally in the browser.
 */
export const ErrorMonitor = ({ children }: Props) => {
  // With sandpack, errors are handled in the browser
  // This context is kept for compatibility
  return (
    <Context.Provider value={{ status: "ready" }}>{children}</Context.Provider>
  );
};

const Context = createContext<{
  status: "ready" | "pending" | "disabled";
} | null>(null);

export function useErrorMonitor() {
  const context = useContext(Context);
  if (!context) {
    throw new Error("useErrorMonitor must be used within a ErrorMonitor");
  }
  return context;
}
