import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

// The OAuth provider plugin carries the signed authorize query from the
// login and consent pages into sign-in and consent calls, so a connecting
// app's flow resumes where it left off.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });
