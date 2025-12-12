"use client";

import { createContext, useContext } from "react";

type Props = {
  children: React.ReactNode;
};

/**
 * Error monitor placeholder - command execution has been removed,
 * so there are no command logs to monitor for errors.
 * This component is kept for API compatibility but does not perform any monitoring.
 */
export const ErrorMonitor = ({ children }: Props) => {
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
