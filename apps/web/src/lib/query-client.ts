import { RPCSerializer } from "@orpc/client";
import { QueryClient } from "@tanstack/react-query";

import { toast } from "@repo/ui/components/sonner";

const serializer = new RPCSerializer();

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      dehydrate: {
        serializeData: (data) => serializer.serialize(data, { useFormDataForBlobFields: false }),
        shouldDehydrateQuery: (query) =>
          query.state.status === "pending" || query.state.status === "success",
      },
      hydrate: {
        deserializeData: (data) => serializer.deserialize(data),
      },
      mutations: {
        onError: (error) => {
          toast.error(error.message);
        },
      },
      queries: {
        staleTime: 30 * 1000,
      },
    },
  });
