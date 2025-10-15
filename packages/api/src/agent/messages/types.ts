import type { UIMessage } from "ai";

import type { ToolSet } from "../tools";
import type { DataPart } from "./data-parts";
import type { Metadata } from "./metadata";

export type ChatUIMessage = UIMessage<Metadata, DataPart, ToolSet>;
