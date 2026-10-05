import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

// oauthProviderClient carries a signed OAuth authorize query from the login,
// register and consent pages into sign-in/sign-up/consent, so finishing any of
// them resumes an MCP connector's sign-in.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });
