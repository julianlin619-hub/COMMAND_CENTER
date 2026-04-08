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
import {
  MoreHorizontalIcon,
  ExternalLinkIcon,
  CopyIcon,
  Trash2Icon,
} from "lucide-react";

export function PostActions({
  permalink,
  postId,
}: {
  permalink: string | null;
  postId: string;
}) {
  const [showDelete, setShowDelete] = useState(false);

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
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete post?</DialogTitle>
            <DialogDescription>
              This will permanently remove this post from the database. This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => setShowDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => setShowDelete(false)}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
