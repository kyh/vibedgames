import { defineRelations } from "drizzle-orm";

import * as schema from "./drizzle-schema";
import * as schemaAuth from "./drizzle-schema-auth";

export const relations = defineRelations({ ...schema, ...schemaAuth }, (r) => ({
  creditEntry: {
    user: r.one.user({ from: r.creditEntry.userId, to: r.user.id }),
  },
  deployment: {
    files: r.many.deploymentFile({ from: r.deployment.id, to: r.deploymentFile.deploymentId }),
    game: r.one.game({ from: r.deployment.gameId, to: r.game.id }),
  },
  deploymentFile: {
    deployment: r.one.deployment({ from: r.deploymentFile.deploymentId, to: r.deployment.id }),
  },
  game: {
    deployments: r.many.deployment({ from: r.game.id, to: r.deployment.gameId }),
    user: r.one.user({ from: r.game.userId, to: r.user.id }),
  },
  generation: {
    user: r.one.user({ from: r.generation.userId, to: r.user.id }),
  },
  inviteCode: {
    creator: r.one.user({ from: r.inviteCode.createdBy, to: r.user.id }),
  },
  waitlist: {
    user: r.one.user({ from: r.waitlist.userId, to: r.user.id }),
  },
}));
