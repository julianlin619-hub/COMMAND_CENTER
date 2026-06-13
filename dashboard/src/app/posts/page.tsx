/**
 * Posts Listing Page — shows all posts with tab-based status filtering,
 * dropdown actions per row, and a detail dialog.
 *
 * This is a server component for the data fetching, but it renders
 * several client sub-components (Tabs, DropdownMenu, Dialog).
 */

import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { DetailPageHeader } from "@/components/command-center/detail-page-header";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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

// Status → pill token mapping. We drive the pill colors entirely off the
// design-system pill-* CSS variables (see globals.css) rather than
// hand-rolled hex, so published/scheduled/failed read consistently with
// the rest of the warm dark surface:
//   published → ok (green wash)
//   failed / buffer_error → warn (red wash)
//   everything else (scheduled, queued, …) → idle (neutral)
function StatusBadge({ status }: { status: string }) {
  const isOk = status === "published";
  const isWarn = status === "failed" || status === "buffer_error";

  // Pick the matching pill token pair. The font-mono + uppercase voice
  // matches the eyebrow/label treatment used across the design system.
  const tokens = isOk
    ? { bg: "var(--pill-ok-bg)", fg: "var(--pill-ok-fg)" }
    : isWarn
      ? { bg: "var(--pill-warn-bg)", fg: "var(--pill-warn-fg)" }
      : { bg: "var(--pill-idle-bg)", fg: "var(--pill-idle-fg)" };

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]"
      style={{ backgroundColor: tokens.bg, color: tokens.fg }}
    >
      {/* A small pip echoes the pill color so status reads at a glance even
          before the label is parsed. */}
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: tokens.fg }}
      />
      {status}
    </span>
  );
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
    // The shadcn Card is already restyled to the warm gradient surface, so
    // the table just needs to read cleanly on top of it. We override the
    // header/row borders to the design-system surface-border token (the
    // default `border-border` resolves to the same value, but referencing
    // the token directly keeps the intent explicit on this warm surface).
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow
            className="hover:bg-transparent"
            style={{ borderColor: "var(--surface-border)" }}
          >
            {/* Column headers use the mono eyebrow voice (uppercase, tracked,
                faint) so they sit quietly above the data rows. */}
            {["Platform", "Title / Caption", "Status", "Published"].map((h) => (
              <TableHead
                key={h}
                className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-white/40"
              >
                {h}
              </TableHead>
            ))}
            <TableHead className="w-[50px]" />
          </TableRow>
        </TableHeader>
        <StaggeredTableBody>
          {posts.map((post) => (
            // Rows inherit the component's border-border (≈ surface-border)
            // and warm to the raised surface on hover via the built-in
            // hover:bg-muted/50 → --muted token. No per-row overrides needed.
            <StaggeredTableRow key={post.id}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Avatar size="sm">
                    <AvatarFallback className="font-mono text-[10px] font-bold">
                      {PLATFORM_INITIALS[post.platform] || "?"}
                    </AvatarFallback>
                  </Avatar>
                  <span className="capitalize text-[#edeae0]">
                    {post.platform}
                  </span>
                </div>
              </TableCell>
              <TableCell className="max-w-xs truncate text-white/55">
                {post.title || post.caption || "-"}
              </TableCell>
              <TableCell>
                <StatusBadge status={post.status} />
              </TableCell>
              {/* Dates get tabular numerals so the column doesn't jitter as
                  digit widths vary row to row. font-mono + faint text keeps
                  it as supporting metadata. */}
              <TableCell className="tabular font-mono text-[12px] text-white/55">
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
                className="h-24 text-center font-mono text-[12px] uppercase tracking-[0.12em] text-white/40"
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

export default async function PostsPage() {
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
      {/* Shared hero header. The total/published/failed figures that used to
          sit in a separate summary row now ride in the header's stat cluster
          — the same instrument-panel tally treatment as the home page — with
          published/failed pips tinted to their pill-status tokens. */}
      <div className="cc-reveal">
        <DetailPageHeader
          eyebrow="Publishing Log"
          title="Posts"
          subtitle="Manage posts across all platforms"
          stats={[
            { label: "Total", value: posts.length },
            { label: "Published", value: published.length, pip: "static", pipColor: "var(--pill-ok-fg)" },
            { label: "Failed", value: failed.length, pip: "static", pipColor: "var(--pill-warn-fg)" },
          ]}
        />
      </div>

      {/* Workflow tabs */}
      <Tabs
        defaultValue="all"
        className="cc-reveal mt-7"
        style={{ animationDelay: "0.06s" }}
      >
        {/* The default TabsList bg resolves to --muted (warm surface-raised),
            so the tabs already sit on the right tone; the active tab picks up
            --background per the shadcn dark styles. */}
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="manual">
            Manual Upload
            {manualPosts.length > 0 && (
              <span className="tabular ml-1.5 rounded-full bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">
                {manualPosts.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="pipeline">
            Pipeline
            {pipelinePosts.length > 0 && (
              <span className="tabular ml-1.5 rounded-full bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">
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
