import type { AppRouter } from "./root-router";
import type { InferRouterInputs, InferRouterOutputs } from "@orpc/server";
import { appRouter } from "./root-router";
import { createORPCContext } from "./orpc";

/**
 * Inference helpers for input types
 * @example
 * type PostByIdInput = RouterInputs['post']['byId']
 *      ^? { id: number }
 **/
type RouterInputs = InferRouterInputs<AppRouter>;

/**
 * Inference helpers for output types
 * @example
 * type AllPostsOutput = RouterOutputs['post']['all']
 *      ^? Post[]
 **/
type RouterOutputs = InferRouterOutputs<AppRouter>;

export { createORPCContext, appRouter };
export type { AppRouter, RouterInputs, RouterOutputs };
