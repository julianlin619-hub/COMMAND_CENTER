/**
 * Posts Listing Page — shows all posts with tab-based status filtering,
 * dropdown actions per row, and a detail dialog.
 *
 * This is a server component for the data fetching, but it renders
 * several client sub-components (Tabs, DropdownMenu, Dialog).
 */

import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  StaggeredTableBody,
  StaggeredTableRow,
} from "@/components/motion/staggered-list";
import { PostActions } from "./post-actions";

export const dynamic = "force-dynamic";

const PLATFORM_INITIALS: Record<string, string> = {
  youtube: "YT",
  instagram: "IG",
  tiktok: "TK",
  linkedin: "LI",
  facebook: "FB",
  threads: "TH",
};

function StatusBadge({ status }: { status: string }) {
  if (status === "published") {
    return (
      <Badge className="bg-[#8ca082]/15 text-[#8ca082] border-[#8ca082]/25">
        published
      </Badge>
    );
  }
  if (status === "failed") {
    return <Badge variant="destructive">failed</Badge>;
  }
  return <Badge variant="secondary">{status}</Badge>;
}

type Post = {
  id: string;
  platform: string;
  title: string | null;
  caption: string | null;
  status: string;
  published_at: string | null;
  permalink: string | null;
  created_at: string;
  media_urls: string[] | null;
  metadata: Record<string, unknown> | null;
};

// Posts whose metadata.source === 'manual_upload' belong to the Manual
// Upload workflow (user-driven crosspost via /manual-upload page).
// Everything else is pipeline-generated (tiktok_pipeline, youtube_cron, etc.).
function isManualUpload(post: Post) {
  return (post.metadata as { source?: string } | null)?.source === "manual_upload";
}

function PostsTable({ posts }: { posts: Post[] }) {
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead>Platform</TableHead>
            <TableHead>Title / Caption</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Published</TableHead>
            <TableHead className="w-[50px]" />
          </TableRow>
        </TableHeader>
        <StaggeredTableBody>
          {posts.map((post) => (
            <StaggeredTableRow key={post.id} className="border-border">
              <TableCell>
                <div className="flex items-center gap-2">
                  <Avatar size="sm">
                    <AvatarFallback className="text-[10px] font-bold">
                      {PLATFORM_INITIALS[post.platform] || "?"}
                    </AvatarFallback>
                  </Avatar>
                  <span className="capitalize">{post.platform}</span>
                </div>
              </TableCell>
              <TableCell className="max-w-xs truncate">
                {post.title || post.caption || "-"}
              </TableCell>
              <TableCell>
                <StatusBadge status={post.status} />
              </TableCell>
              <TableCell>
                {post.published_at
                  ? new Date(post.published_at).toLocaleDateString()
                  : "-"}
              </TableCell>
              <TableCell>
                <PostActions
                  permalink={post.permalink}
                  postId={post.id}
                  status={post.status}
                  canRequeue={
                    // Only show Requeue when we have everything _resend needs:
                    // a buffer_replay payload with channel_id + media_type, and
                    // a storage path in media_urls.
                    !!(
                      post.media_urls?.[0] &&
                      (post.metadata?.buffer_replay as Record<string, unknown> | undefined)
                        ?.channel_id &&
                      (post.metadata?.buffer_replay as Record<string, unknown> | undefined)
                        ?.media_type
                    )
                  }
                />
              </TableCell>
            </StaggeredTableRow>
          ))}
          {posts.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={5}
                className="h-24 text-center text-muted-foreground"
              >
                No posts found.
              </TableCell>
            </TableRow>
          )}
        </StaggeredTableBody>
      </Table>
    </Card>
  );
}

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; status?: string }>;
}) {
  const params = await searchParams;
  const supabase = getSupabaseClient();

  const { data: allPosts } = await supabase
    .from("posts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  const posts = (allPosts || []) as Post[];

  /* Split by workflow */
  const manualPosts = posts.filter(isManualUpload);
  const pipelinePosts = posts.filter((p) => !isManualUpload(p));

  /* Status splits for summary badges */
  const published = posts.filter((p) => p.status === "published");
  const failed = posts.filter(
    (p) => p.status === "failed" || p.status === "buffer_error"
  );

  return (
    <AppShell>
      <div className="mb-6">
        <h2 className="text-lg font-medium">Posts</h2>
        <p className="text-sm text-muted-foreground">
          Manage posts across all platforms
        </p>
      </div>

      {/* Summary badges */}
      <div className="flex items-center gap-3 mb-4">
        <Badge variant="outline">{posts.length} total</Badge>
        <Separator orientation="vertical" className="h-4" />
        <Badge className="bg-[#8ca082]/15 text-[#8ca082] border-[#8ca082]/25">
          {published.length} published
        </Badge>
        <Badge variant="destructive">{failed.length} failed</Badge>
      </div>

      {/* Workflow tabs */}
      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="manual">
            Manual Upload
            {manualPosts.length > 0 && (
              <span className="ml-1.5 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px]">
                {manualPosts.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="pipeline">
            Pipeline
            {pipelinePosts.length > 0 && (
              <span className="ml-1.5 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px]">
                {pipelinePosts.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all">
          <PostsTable posts={posts} />
        </TabsContent>

        <TabsContent value="manual">
          <PostsTable posts={manualPosts} />
        </TabsContent>

        <TabsContent value="pipeline">
          <PostsTable posts={pipelinePosts} />
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
