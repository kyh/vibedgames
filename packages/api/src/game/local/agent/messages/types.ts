import type { UIMessage } from "ai";

import type { ToolSet } from "@repo/api/game/local/agent/tools/index";
import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import type { Metadata } from "@repo/api/game/local/agent/messages/metadata";

export type ChatUIMessage = UIMessage<Metadata, DataPart, ToolSet>;
