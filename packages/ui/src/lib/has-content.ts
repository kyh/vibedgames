import type { ReactNode } from "react";

/** Whether `node` renders anything: what `{node && …}` means for text, numbers and elements. */
export const hasContent = (node: ReactNode) =>
  node !== undefined && node !== null && node !== false && node !== "";
