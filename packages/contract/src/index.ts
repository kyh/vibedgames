import type {
  InferContractRouterInputs,
  InferContractRouterOutputs,
  RouterContractClient,
} from "@orpc/contract";

import { adminContract } from "./admin/admin-contract";
import { apiKeyContract } from "./auth/api-key-contract";
import { authContract } from "./auth/auth-contract";
import { creditsContract } from "./credits/credits-contract";
import { deployContract } from "./deploy/deploy-contract";
import { generateContract } from "./generate/generate-contract";
import { playtestContract } from "./playtest/playtest-contract";
import { waitlistContract } from "./waitlist/waitlist-contract";

/** The API's single source of truth: @repo/service implements it, clients type against it. */
export const contract = {
  admin: adminContract,
  apiKeys: apiKeyContract,
  auth: authContract,
  credits: creditsContract,
  deploy: deployContract,
  generate: generateContract,
  playtest: playtestContract,
  waitlist: waitlistContract,
};

export type Contract = typeof contract;

export type ContractClient = RouterContractClient<Contract>;

/**
 * Inference helpers for input types
 * @example
 * type ForwardInput = RouterInputs['generate']['forward']
 *      ^? { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; … }
 **/
export type RouterInputs = InferContractRouterInputs<Contract>;

/**
 * Inference helpers for output types
 * @example
 * type MeOutput = RouterOutputs['auth']['me']
 *      ^? { email: string; id: string; name: string; role: string | null }
 **/
export type RouterOutputs = InferContractRouterOutputs<Contract>;
