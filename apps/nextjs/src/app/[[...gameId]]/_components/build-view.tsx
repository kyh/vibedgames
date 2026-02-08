"use client";

import { useCallback, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { gameTypesArray } from "@repo/api/game/local/agent/agent-schema";
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
  GamepadIcon,
  HelpCircleIcon,
  MenuIcon,
  RefreshCwIcon,
  SendIcon,
  SettingsIcon,
  TerminalIcon,
} from "lucide-react";
import { motion } from "motion/react";

import type { ChatUIMessage } from "@repo/api/game/local/agent/messages/types";
import { useSharedChatContext } from "@/components/chat/chat-context";
import { Message } from "@/components/chat/message";
import { FileExplorer } from "@/components/file-explorer/file-explorer";
import { MyGames } from "@/components/my-games/my-games";
import { DraggablePanel } from "@/components/ui/draggable-panel";
import { useUiStore } from "./ui-store";

export const BuildView = () => {
  const [input, setInput] = useState("");
  const { chat } = useSharedChatContext();
  const { messages, sendMessage, status } = useChat<ChatUIMessage>({ chat });
  const {
    sandpackFiles,
    refreshIframe,
    showFileExplorer,
    setShowFileExplorer,
    showMyGames,
    setShowMyGames,
    showLogs,
    setShowLogs,
    logs,
    v0ChatId,
  } = useUiStore();

  const validateAndSubmitMessage = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      void sendMessage({ text }, { body: { v0ChatId } });
      setInput("");
    },
    [sendMessage, v0ChatId],
  );

  return (
    <>
      <Conversation className="relative w-full">
        <ConversationContent className="space-y-1 pb-2">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <InputGroupButton type="button" size="icon-xs">
                    <MenuIcon />
                  </InputGroupButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem
                    onClick={() => setShowMyGames(!showMyGames)}
                  >
                    <GamepadIcon />
                    My Games
                    {showMyGames && (
                      <span className="ml-auto text-xs">
                        <CheckIcon />
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
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
                  <DropdownMenuItem onClick={() => setShowLogs(!showLogs)}>
                    <TerminalIcon />
                    Logs
                    {showLogs && (
                      <span className="ml-auto text-xs">
                        <CheckIcon />
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => refreshIframe()}>
                    <RefreshCwIcon />
                    Refresh Preview
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
      <DraggablePanel
        title="File Explorer"
        icon={<FileIcon className="size-4" />}
        isOpen={showFileExplorer}
        onClose={() => setShowFileExplorer(false)}
        initialPosition={{ x: 440, y: 20 }}
        initialSize={{ width: 300, height: 200 }}
      >
        <FileExplorer files={sandpackFiles} />
      </DraggablePanel>
      <DraggablePanel
        title="My Games"
        icon={<GamepadIcon className="size-4" />}
        isOpen={showMyGames}
        onClose={() => setShowMyGames(false)}
        initialPosition={{ x: 760, y: 20 }}
        initialSize={{ width: 320, height: 400 }}
      >
        <MyGames />
      </DraggablePanel>
      <DraggablePanel
        title="Logs"
        icon={<TerminalIcon className="size-4" />}
        isOpen={showLogs}
        onClose={() => setShowLogs(false)}
        initialPosition={{ x: 1080, y: 20 }}
        initialSize={{ width: 400, height: 300 }}
      >
        <div className="space-y-1 p-3 font-mono text-xs">
          {logs.length === 0 ? (
            <div className="text-muted-foreground">No logs yet</div>
          ) : (
            logs.map((log, index) => (
              <div key={index} className="text-foreground/80">
                {log}
              </div>
            ))
          )}
        </div>
      </DraggablePanel>
    </>
  );
};
