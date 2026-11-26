import type * as Workers from "@cloudflare/workers-types";

declare global {
  type D1Database = Workers.D1Database;

  type D1DatabaseSession = Workers.D1DatabaseSession;

  type D1PreparedStatement = Workers.D1PreparedStatement;

  type D1Response = Workers.D1Response;

  type D1Result<T = unknown> = Workers.D1Result<T>;

  type D1Meta = Workers.D1Meta;

  type D1SessionBookmark = Workers.D1SessionBookmark;

  type D1SessionConstraint = Workers.D1SessionConstraint;

  type RequestInfo = Request | string;
}
