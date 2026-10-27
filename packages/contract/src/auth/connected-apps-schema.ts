import { z } from "zod";

export const revokeConnectedAppInput = z.object({ clientId: z.string().min(1) });
