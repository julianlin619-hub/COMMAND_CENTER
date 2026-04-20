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
};

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
                <PostActions permalink={post.permalink} postId={post.id} />
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

  /* Split posts by status for the tab views */
  const published = posts.filter((p) => p.status === "published");
  const drafts = posts.filter((p) => p.status === "draft");
  const failed = posts.filter((p) => p.status === "failed");

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
        <Badge variant="secondary">{drafts.length} draft</Badge>
        <Badge variant="destructive">{failed.length} failed</Badge>
      </div>

      {/* Tabs for status filtering */}
      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="published">Published</TabsTrigger>
          <TabsTrigger value="draft">Draft</TabsTrigger>
          <TabsTrigger value="failed">Failed</TabsTrigger>
        </TabsList>

        <TabsContent value="all">
          <PostsTable posts={posts} />
        </TabsContent>

        <TabsContent value="published">
          <PostsTable posts={published} />
        </TabsContent>

        <TabsContent value="draft">
          <PostsTable posts={drafts} />
        </TabsContent>

        <TabsContent value="failed">
          <PostsTable posts={failed} />
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
