import { createFileRoute } from "@tanstack/react-router";

import { getAgentSkill } from "@/lib/agent-skills";

export const Route = createFileRoute("/.well-known/agent-skills/$slug/SKILL.md")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const skill = getAgentSkill(params.slug);
        if (!skill) return new Response("Not found", { status: 404 });
        return new Response(skill.content, {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
