"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  MoreHorizontalIcon,
  ExternalLinkIcon,
  CopyIcon,
  Trash2Icon,
  LoaderIcon,
} from "lucide-react";

export function PostActions({
  permalink,
  postId,
}: {
  permalink: string | null;
  postId: string;
}) {
  const router = useRouter();
  const [showDelete, setShowDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/posts/${postId}`, { method: "DELETE" });
      if (!res.ok) {
        // Surface the API's error message when present, otherwise a generic
        // message. `.catch(() => null)` guards against non-JSON bodies.
        const data = await res.json().catch(() => null);
        setDeleteError(data?.error || "Failed to delete post.");
        return;
      }
      // Only close and refresh on 2xx — the dialog must stay open on error
      // so the user sees what went wrong on a destructive action.
      setShowDelete(false);
      router.refresh();
    } catch (err) {
      setDeleteError((err as Error).message || "Failed to delete post.");
    } finally {
      setIsDeleting(false);
    }
  }

  // Block the dialog from closing mid-request (Escape / backdrop click) so
  // a slow DELETE can't be abandoned without the user seeing the outcome.
  function handleOpenChange(open: boolean) {
    if (isDeleting) return;
    if (!open) setDeleteError(null);
    setShowDelete(open);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-xs">
              <MoreHorizontalIcon className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {permalink && (
            <DropdownMenuItem
              render={
                <a href={permalink} target="_blank" rel="noopener noreferrer" />
              }
            >
              <ExternalLinkIcon className="size-3.5 mr-2" />
              View on platform
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => navigator.clipboard.writeText(postId)}
          >
            <CopyIcon className="size-3.5 mr-2" />
            Copy ID
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => setShowDelete(true)}
          >
            <Trash2Icon className="size-3.5 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete confirmation dialog */}
      <Dialog open={showDelete} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete post?</DialogTitle>
            <DialogDescription>
              This will permanently remove this post from the database. This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {deleteError}
            </div>
          )}
          <div className="flex justify-end gap-2 mt-2">
            <Button
              variant="outline"
              onClick={() => setShowDelete(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <LoaderIcon className="size-3 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
