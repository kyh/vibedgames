import { createFileRoute } from "@tanstack/react-router";

import { getSkillIndex } from "@/lib/agent-skills";

const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

export const Route = createFileRoute("/.well-known/agent-skills/index.json")({
  server: {
    handlers: {
      GET: async () => {
        const skills = await getSkillIndex();
        return new Response(JSON.stringify({ $schema: SCHEMA, skills }, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
