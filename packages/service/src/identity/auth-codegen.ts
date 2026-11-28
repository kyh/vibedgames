import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { mcp } from "@better-auth/mcp";
import { oauthDeviceAuthorization } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer, jwt, oAuthProxy } from "better-auth/plugins";

export const auth = betterAuth({
  baseURL: "https://www.vibedgames.com",
  database: memoryAdapter({ oauthResource: [] }),
  emailAndPassword: { enabled: true },
  plugins: [
    oAuthProxy(),
    bearer(),
    expo(),
    admin(),
    apiKey(),
    jwt(),
    mcp({
      consentPage: "/oauth/consent",
      loginPage: "/auth/login",
      resource: "https://www.vibedgames.com/mcp",
    }),
    oauthDeviceAuthorization(),
  ],
  rateLimit: { enabled: true, storage: "database" },
  user: {
    additionalFields: {
      invitedByCode: { input: false, required: false, type: "string" },
    },
  },
});
