"use client";

import { useCallback, useEffect, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { gameTypesArray } from "@repo/api/agent/agent-schema";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@repo/ui/conversation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
} from "@repo/ui/input-group";
import { Mention, MentionsInput } from "@repo/ui/mentions-input";
import {
  CheckIcon,
  FileIcon,
  HelpCircleIcon,
  MenuIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  SettingsIcon,
  TrashIcon,
} from "lucide-react";
import { motion } from "motion/react";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";
import { useSharedChatContext } from "@/components/chat/chat-context";
import { Message } from "@/components/chat/message";
import { useWorkspaceStore } from "@/components/chat/workspace-store";
import { FileExplorer } from "@/components/file-explorer/file-explorer";
import { DraggablePanel } from "@/components/ui/draggable-panel";
import { useUiStore } from "./ui-store";

export const BuildView = () => {
  const [input, setInput] = useState("");

  const { chat } = useSharedChatContext();
  const { messages, sendMessage, status } = useChat<ChatUIMessage>({ chat });
  const { setChatStatus, reset } = useWorkspaceStore();
  const {
    refreshPreviewIframe,
    showFileExplorer,
    setShowFileExplorer,
    showBuildMenu,
    setShowBuildMenu,
  } = useUiStore();

  const validateAndSubmitMessage = useCallback(
    (text: string) => {
      if (text.trim()) {
        void sendMessage({ text });
        setInput("");
      }
    },
    [sendMessage, setInput],
  );

  useEffect(() => {
    setChatStatus(status);
  }, [status, setChatStatus]);

  return (
    <>
      <Conversation className="relative w-full">
        <ConversationContent className="space-y-1">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <DraggablePanel
        title="File Explorer"
        icon={<FileIcon className="h-4 w-4" />}
        isOpen={showFileExplorer}
        onClose={() => setShowFileExplorer(false)}
        initialPosition={{ x: 440, y: 20 }}
        initialSize={{ width: 300, height: 200 }}
      >
        <FileExplorer />
      </DraggablePanel>

      <form
        className="relative pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          validateAndSubmitMessage(input);
        }}
      >
        <motion.div
          layoutId="compose-view"
          className="bg-input/40 absolute inset-0 mb-4 rounded-md backdrop-blur-sm"
        />
        <InputGroup
          className="text-foreground max-h-max items-start border-none bg-transparent text-sm"
          asChild
        >
          <motion.div
            transition={{ type: "spring", bounce: 0.1 }}
            initial={{ opacity: 0, filter: "blur(5px)" }}
            animate={{
              opacity: 1,
              filter: "blur(0px)",
              transition: { delay: 0.05 },
            }}
          >
            <InputGroupAddon>
              <DropdownMenu
                open={showBuildMenu}
                onOpenChange={setShowBuildMenu}
              >
                <DropdownMenuTrigger asChild>
                  <InputGroupButton type="button" size="icon-xs">
                    <MenuIcon />
                  </InputGroupButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem
                    onClick={() => setShowFileExplorer(!showFileExplorer)}
                  >
                    <FileIcon />
                    File Explorer
                    {showFileExplorer && (
                      <span className="ml-auto text-xs">
                        <CheckIcon />
                      </span>
                    )}
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem onClick={() => refreshPreviewIframe()}>
                    <RefreshCwIcon />
                    Refresh Preview
                  </DropdownMenuItem>

                  <DropdownMenuItem
                    onClick={() => {
                      reset();
                    }}
                  >
                    <TrashIcon />
                    Reset Workspace
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    onClick={() => {
                      // Create new game - reset workspace and clear input
                      reset();
                      setInput("");
                    }}
                  >
                    <PlusIcon />
                    Create New Game
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem>
                    <SettingsIcon />
                    Settings
                  </DropdownMenuItem>

                  <DropdownMenuItem>
                    <HelpCircleIcon />
                    Help
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </InputGroupAddon>
            <MentionsInput
              placeholder="What game would you like to build?"
              disabled={status === "streaming" || status === "submitted"}
              value={input}
              suggestionsPlacement="above"
              onMentionsChange={(changeEvent) => setInput(changeEvent.value)}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === "Enter" &&
                  !e.shiftKey
                ) {
                  e.preventDefault();
                  validateAndSubmitMessage(input);
                }
              }}
            >
              <Mention
                trigger="+"
                data={gameTypesArray}
                displayTransform={(_, display) => `+${display}`}
                className="rounded-none bg-indigo-900 text-indigo-100"
              />
            </MentionsInput>
            <InputGroupAddon className="mt-auto" align="inline-end">
              <InputGroupButton type="submit" size="icon-xs">
                <SendIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </motion.div>
        </InputGroup>
      </form>
    </>
  );
};
