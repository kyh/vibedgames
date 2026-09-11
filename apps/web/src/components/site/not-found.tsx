import { useRouterState } from "@tanstack/react-router";

import { Prose } from "@/components/site/prose";
import { notFoundDoc } from "@/content/not-found";

/** HTML representation of a 404. The markdown one is `notFoundMarkdown`. */
export const NotFoundPage = () => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <Prose doc={notFoundDoc(pathname)} />;
};
