"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@repo/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Textarea } from "@repo/ui/textarea";
import { toast } from "@repo/ui/toast";
import { cn } from "@repo/ui/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GamepadIcon, LoaderIcon, PencilIcon, TrashIcon } from "lucide-react";

import { useTRPC } from "@/trpc/react";

type Build = {
  id: string;
  title: string | null;
  description: string | null;
  createdAt: Date | number;
  [key: string]: unknown;
};

type GameItemProps = {
  build: Build;
  onRename: (build: {
    id: string;
    title: string | null;
    description: string | null;
  }) => void;
  onDelete: (build: {
    id: string;
    title: string | null;
    description: string | null;
  }) => void;
};

const GameItem = ({ build, onRename, onDelete }: GameItemProps) => {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            "w-full px-4 py-3 text-left transition-colors",
            "hover:bg-muted/50 focus:bg-muted/50 focus:outline-none",
          )}
          onClick={() => {
            window.location.href = `/${build.id}`;
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <GamepadIcon className="text-muted-foreground size-4 shrink-0" />
                <h4 className="truncate text-sm font-medium">
                  {build.title ?? `Game ${build.id.slice(0, 8)}`}
                </h4>
              </div>
              {build.description && (
                <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                  {build.description}
                </p>
              )}
              <p className="text-muted-foreground/70 mt-1 text-xs">
                {new Date(build.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onRename({
              id: build.id,
              title: build.title,
              description: build.description,
            });
          }}
        >
          <PencilIcon className="size-4" />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onDelete({
              id: build.id,
              title: build.title,
              description: build.description,
            });
          }}
          variant="destructive"
        >
          <TrashIcon className="size-4" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export const MyGames = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedBuild, setSelectedBuild] = useState<{
    id: string;
    title: string | null;
    description: string | null;
  } | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameDescription, setRenameDescription] = useState("");

  const listBuildsQuery = trpc.game.listBuilds.queryOptions({ limit: 50 });
  const { data, isLoading, error } = useQuery(listBuildsQuery);

  const updateBuild = useMutation(trpc.game.updateBuild.mutationOptions());
  const deleteBuild = useMutation(trpc.game.deleteBuild.mutationOptions());

  const handleRenameClick = (build: {
    id: string;
    title: string | null;
    description: string | null;
  }) => {
    setSelectedBuild(build);
    setRenameTitle(build.title ?? "");
    setRenameDescription(build.description ?? "");
    setRenameDialogOpen(true);
  };

  const handleRenameSubmit = () => {
    if (!selectedBuild) return;

    toast.promise(
      updateBuild
        .mutateAsync({
          buildId: selectedBuild.id,
          title: renameTitle.trim() || undefined,
          description: renameDescription.trim() || undefined,
        })
        .then(() => {
          void queryClient.invalidateQueries({
            queryKey: listBuildsQuery.queryKey,
          });
          setRenameDialogOpen(false);
          setSelectedBuild(null);
          setRenameTitle("");
          setRenameDescription("");
        }),
      {
        loading: "Renaming game...",
        success: "Game renamed successfully",
        error: "Failed to rename game",
      },
    );
  };

  const handleDeleteClick = (build: {
    id: string;
    title: string | null;
    description: string | null;
  }) => {
    setSelectedBuild(build);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (!selectedBuild) return;

    toast.promise(
      deleteBuild.mutateAsync({ buildId: selectedBuild.id }).then(() => {
        void queryClient.invalidateQueries({
          queryKey: listBuildsQuery.queryKey,
        });
        setDeleteDialogOpen(false);
        setSelectedBuild(null);
      }),
      {
        loading: "Deleting game...",
        success: "Game deleted successfully",
        error: "Failed to delete game",
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoaderIcon className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-destructive p-4 text-sm">
        Failed to load games. Please try again.
      </div>
    );
  }

  if (!data || data.builds.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <GamepadIcon className="text-muted-foreground mb-2 size-8" />
        <p className="text-muted-foreground text-sm">No saved games yet</p>
        <p className="text-muted-foreground/70 mt-1 text-xs">
          Create a game to see it here
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col">
        <div className="divide-border divide-y">
          {data.builds.map((build) => (
            <GameItem
              key={build.id}
              build={build}
              onRename={handleRenameClick}
              onDelete={handleDeleteClick}
            />
          ))}
        </div>
      </div>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Game</DialogTitle>
            <DialogDescription>
              Update the title and description for this game.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                placeholder="Enter game title"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleRenameSubmit();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={renameDescription}
                onChange={(e) => setRenameDescription(e.target.value)}
                placeholder="Enter game description (optional)"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRenameDialogOpen(false);
                setSelectedBuild(null);
                setRenameTitle("");
                setRenameDescription("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRenameSubmit}
              disabled={updateBuild.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Game</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "
              {selectedBuild?.title ?? `Game ${selectedBuild?.id.slice(0, 8)}`}
              "? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteBuild.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
