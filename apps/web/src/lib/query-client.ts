import { RPCSerializer } from "@orpc/client";
import { QueryClient } from "@tanstack/react-query";

import { toast } from "@repo/ui/components/sonner";

// oRPC's own serializer, so dehydrated data round-trips every type the RPC
// protocol supports (Date, Map, Set, BigInt, URL, RegExp) — plain JSON would
// hand the client a string where the server had a Date.
const serializer = new RPCSerializer();

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
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
        // FormData cannot ride the hydration payload into the browser, so keep
        // blobs inline in the JSON.
        serializeData: (data) => serializer.serialize(data, { useFormDataForBlobFields: false }),
        shouldDehydrateQuery: (query) =>
          query.state.status === "pending" || query.state.status === "success",
      },
      hydrate: {
        deserializeData: (data) => serializer.deserialize(data),
      },
    },
  });
}
