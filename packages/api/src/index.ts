import type { InferRouterInputs, InferRouterOutputs } from "@orpc/server";
import type { AppRouter } from "./root-router";

export { type AppRouter, appRouter } from "./root-router";
export { createORPCContext } from "./orpc";

/**
 * Inference helpers for input types
 * @example
 * type PostByIdInput = RouterInputs['post']['byId']
 *      ^? { id: number }
 **/
export type RouterInputs = InferRouterInputs<AppRouter>;

/**
 * Inference helpers for output types
 * @example
 * type AllPostsOutput = RouterOutputs['post']['all']
 *      ^? Post[]
 **/
export type RouterOutputs = InferRouterOutputs<AppRouter>;
