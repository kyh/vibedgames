"use client";

import { useCallback, useState } from "react";
import { useParams } from "next/navigation";
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
import { useMutation } from "@tanstack/react-query";
import {
  CheckIcon,
  FileIcon,
  GamepadIcon,
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
import { FileExplorer } from "@/components/file-explorer/file-explorer";
import { MyGames } from "@/components/my-games/my-games";
import { DraggablePanel } from "@/components/ui/draggable-panel";
import { useTRPC } from "@/trpc/react";
import { useUiStore } from "./ui-store";

export const BuildView = () => {
  const trpc = useTRPC();
  const [input, setInput] = useState("");
  const { chat } = useSharedChatContext();
  const { messages, sendMessage, status } = useChat<ChatUIMessage>({ chat });
  const params = useParams<{ gameId?: string[] }>();
  const {
    reset,
    sandpackFiles,
    refreshPreviewIframe,
    showFileExplorer,
    setShowFileExplorer,
    showBuildMenu,
    setShowBuildMenu,
    showMyGames,
    setShowMyGames,
  } = useUiStore();

  const createBuild = useMutation(trpc.game.createBuild.mutationOptions());

  const validateAndSubmitMessage = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      // Check if we're looking at a new game (no gameId in URL)
      const gameId = params.gameId?.[0];
      const isNewGame = !gameId;

      if (isNewGame) {
        // Create a new game first
        const filesArray = Object.entries(sandpackFiles).map(
          ([path, content]) => ({
            path,
            content,
          }),
        );

        try {
          const result = await createBuild.mutateAsync({
            files: filesArray,
          });

          // Update URL without triggering a rerender
          window.history.replaceState(
            {
              ...window.history.state,
              as: `/${result.build.id}`,
              url: `/${result.build.id}`,
            },
            "",
            `/${result.build.id}`,
          );
        } catch (error) {
          console.error("Failed to create game:", error);
          // Still try to send the message even if game creation fails
        }
      }

      // Send the message
      void sendMessage({ text });
      setInput("");
    },
    [sendMessage, setInput, params.gameId, sandpackFiles, createBuild],
  );

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
      <form
        className="relative pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          void validateAndSubmitMessage(input);
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
                  <DropdownMenuItem onClick={() => refreshPreviewIframe()}>
                    <RefreshCwIcon />
                    Refresh Preview
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => reset()}>
                    <TrashIcon />
                    Reset
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
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
                  void validateAndSubmitMessage(input);
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
    </>
  );
};
