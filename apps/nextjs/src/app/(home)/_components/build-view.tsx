"use client";

import { useCallback, useEffect, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@repo/ui/conversation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  dropdownMenuItemVariants,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@repo/ui/input-group";
import {
  BugIcon,
  CheckIcon,
  EyeIcon,
  FileTextIcon,
  HelpCircleIcon,
  MenuIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  SettingsIcon,
  TerminalIcon,
  TrashIcon,
} from "lucide-react";
import { motion } from "motion/react";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";
import { useSharedChatContext } from "@/components/chat/chat-context";
import { Message } from "@/components/chat/message";
import { useSandboxStore } from "@/components/chat/sandbox-store";
import { useUiStore } from "./ui-store";

export const BuildView = () => {
  const [input, setInput] = useState("");
  const [showErrorState, setShowErrorState] = useState(false);
  const [showLoggingState, setShowLoggingState] = useState(false);
  const [showCommandLogs, setShowCommandLogs] = useState(false);

  const { chat } = useSharedChatContext();
  const { messages, sendMessage, status } = useChat<ChatUIMessage>({ chat });
  const { setChatStatus, reset, commands } = useSandboxStore();
  const { refreshPreviewIframe } = useUiStore();

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

      {/* Debug Windows */}
      {showErrorState && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="border-border bg-muted/20 border-t p-4"
        >
          <div className="mb-2 flex items-center gap-2">
            <BugIcon />
            <h3 className="font-mono text-sm font-semibold">Error State</h3>
          </div>
          <div className="text-muted-foreground font-mono text-xs">
            Error monitoring is active. Check console for details.
          </div>
        </motion.div>
      )}

      {showLoggingState && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="border-border bg-muted/20 border-t p-4"
        >
          <div className="mb-2 flex items-center gap-2">
            <FileTextIcon />
            <h3 className="font-mono text-sm font-semibold">Logging State</h3>
          </div>
          <div className="text-muted-foreground font-mono text-xs">
            Logging is enabled. All activities are being tracked.
          </div>
        </motion.div>
      )}

      {showCommandLogs && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="border-border bg-muted/20 border-t p-4"
        >
          <div className="mb-2 flex items-center gap-2">
            <TerminalIcon />
            <h3 className="font-mono text-sm font-semibold">Command Logs</h3>
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto">
            {commands.length === 0 ? (
              <div className="text-muted-foreground font-mono text-xs">
                No commands executed yet.
              </div>
            ) : (
              commands.map((command) => (
                <div key={command.cmdId} className="font-mono text-xs">
                  <span className="text-muted-foreground">
                    [{new Date(command.startedAt).toLocaleTimeString()}]
                  </span>{" "}
                  <span className="text-foreground">
                    {command.command} {command.args.join(" ")}
                  </span>
                </div>
              ))
            )}
          </div>
        </motion.div>
      )}
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
          className="text-foreground items-start border-none bg-transparent text-sm"
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
                    onClick={() => {
                      // Create new game - reset sandbox and clear input
                      reset();
                      setInput("");
                    }}
                  >
                    <PlusIcon />
                    Create New Game
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger
                      className={dropdownMenuItemVariants()}
                    >
                      <EyeIcon />
                      View
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem
                        onClick={() => setShowErrorState(!showErrorState)}
                      >
                        <BugIcon />
                        Error State
                        {showErrorState && (
                          <span className="ml-auto text-xs">
                            <CheckIcon />
                          </span>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setShowLoggingState(!showLoggingState)}
                      >
                        <FileTextIcon />
                        Logging State
                        {showLoggingState && (
                          <span className="ml-auto text-xs">
                            <CheckIcon />
                          </span>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setShowCommandLogs(!showCommandLogs)}
                      >
                        <TerminalIcon />
                        Command Logs
                        {showCommandLogs && (
                          <span className="ml-auto text-xs">
                            <CheckIcon />
                          </span>
                        )}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem onClick={() => refreshPreviewIframe()}>
                    <RefreshCwIcon />
                    Refresh Preview
                  </DropdownMenuItem>

                  <DropdownMenuItem
                    onClick={() => {
                      // Reset sandbox
                      reset();
                    }}
                  >
                    <TrashIcon />
                    Reset Sandbox
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
            <InputGroupTextarea
              className="py-2.5 font-mono text-xs md:text-xs"
              placeholder="What game would you like to build?"
              disabled={status === "streaming" || status === "submitted"}
              onChange={(e) => setInput(e.target.value)}
              value={input}
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
            />
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
