import { StandardRPCJsonSerializer } from "@orpc/client/standard";
import { hashKey, QueryClient } from "@tanstack/react-query";

import { toast } from "@repo/ui/components/sonner";

// oRPC's own serializer, so dehydrated data round-trips every type the RPC
// protocol supports (Date, Map, Set, BigInt, URL, RegExp).
const serializer = new StandardRPCJsonSerializer();

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Inputs can contain non-JSON values, so keys have to hash through the
        // same serializer the data does. Two canonicalizations are needed, not
        // one: `hashKey` sorts object keys but leaves array order alone, and the
        // serializer emits one meta entry per rich value in traversal order. Sort
        // the meta too, or `{ from: Date, to: Date }` and `{ to: Date, from: Date }`
        // hash differently and each gets its own cache entry. The default sort is
        // code-unit order — `localeCompare` would let a server and a browser on
        // different locales disagree, and hydration would miss the server's key.
        queryKeyHashFn: (queryKey) => {
          const [json, meta] = serializer.serialize(queryKey);
          return hashKey([json, meta.map(hashKey).toSorted()]);
        },
        staleTime: 30 * 1000,
      },
      mutations: {
        // No default `onSuccess`. Every mutation invalidates exactly the
        // query keys it touches in its own `onSuccess` — a blanket
        // `invalidateQueries()` refetches every mounted query on every
        // write, and (because react-query shallow-merges these defaults)
        // it silently stops applying the moment a call site declares its
        // own handler, so it was never a net you could rely on anyway.
        //
        // `onError` is the opposite case: it IS the app-wide error surface.
        // Don't restate it at a call site — that only overrides this with an
        // identical toast, and a call site that also toasts by hand (say,
        // from a rejected `mutateAsync`) shows the error twice.
        onError: (error) => {
          toast.error(error.message);
        },
      },
      dehydrate: {
        serializeData: (data) => {
          const [json, meta] = serializer.serialize(data);
          return { json, meta };
        },
        shouldDehydrateQuery: (query) =>
          query.state.status === "pending" || query.state.status === "success",
      },
      hydrate: {
        deserializeData: (data) => serializer.deserialize(data.json, data.meta),
      },
    },
  });
}
