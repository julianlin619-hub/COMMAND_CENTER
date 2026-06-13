/**
 * YouTube (2nd) Studio-First Scheduling Page
 *
 * Shows a table of videos the daily cron has discovered in YouTube Studio
 * (as Private drafts) and scheduled for publishing. The cron writes one
 * `posts` row per scheduled video (platform='youtube',
 * metadata.source='studio'); this page reads them ordered newest-first.
 *
 * Each row shows the original title, the transcript-generated title pushed
 * to YouTube, the assigned publish slot in both UTC and America/Los_Angeles,
 * and a link back to the video in YouTube Studio.
 *
 * URL note: this page is named /youtube-second because the active channel
 * behind the YOUTUBE_* OAuth credentials is the 2nd channel. The "primary"
 * /youtube slot is archived.
 */

import { ExternalLinkIcon } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { DetailPageHeader } from "@/components/command-center/detail-page-header";
import { PlatformIcon } from "@/components/platform-icon";
import { RunYouTubeCronButton } from "@/components/run-youtube-cron-button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSupabaseClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type StudioPost = {
  id: string;
  platform_post_id: string | null;
  status: string;
  title: string | null;
  created_at: string;
  metadata: {
    source?: string;
    original_title?: string;
    // New field (transcript-based generator). `cleaned_title` is kept for
    // the fallback render of old rows written by the previous cleaner flow.
    generated_title?: string;
    cleaned_title?: string;
    publish_at?: string;
    transcript_chars?: number;
    caption_track_kind?: string;
    // "fallback" = the scheduler gave up waiting for ASR and scheduled
    // with a cleaned version of the original Studio title. Needs review.
    title_source?: "generated" | "fallback";
    fallback_skip_count?: number;
  } | null;
};

function StatusBadge({ status }: { status: string }) {
  if (status === "scheduled") {
    return <Badge variant="secondary">scheduled</Badge>;
  }
  if (status === "published") {
    // Published → the shared "ok" pill (green) tokens, replacing the old
    // ad-hoc sage hex so it matches every other ok-state surface.
    return (
      <Badge
        className="border-transparent"
        style={{
          backgroundColor: "var(--pill-ok-bg)",
          color: "var(--pill-ok-fg)",
        }}
      >
        published
      </Badge>
    );
  }
  if (status === "failed") {
    return <Badge variant="destructive">failed</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

function formatPublishAt(iso: string | undefined | null): {
  utc: string;
  pt: string;
} {
  if (!iso) return { utc: "-", pt: "" };
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return { utc: iso, pt: "" };
  const utc = dt.toISOString().replace(/\.\d+Z$/, "Z");
  const pt = dt.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return { utc, pt };
}

function formatCreatedAt(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function YouTubePage() {
  const supabase = getSupabaseClient();

  // Filter with metadata->>source='studio' via the Postgres ->> operator so
  // we only surface rows the studio-first cron wrote (distinct from rows
  // that might land here from a future direct-upload flow).
  const { data, error } = await supabase
    .from("posts")
    .select(
      "id, platform_post_id, status, title, created_at, metadata"
    )
    .eq("platform", "youtube")
    .filter("metadata->>source", "eq", "studio")
    .order("created_at", { ascending: false })
    .limit(100);

  const posts = (data ?? []) as StudioPost[];
  const scheduledCount = posts.filter((p) => p.status === "scheduled").length;
  const publishedCount = posts.filter((p) => p.status === "published").length;
  const failedCount = posts.filter((p) => p.status === "failed").length;

  return (
    // Wider column than the home 1100 — this page is a six-column table that
    // needs room to breathe, so it opts into the AppShell maxWidth escape
    // hatch rather than horizontally scrolling inside the home column.
    <AppShell maxWidth="1280px">
      {/* Shared hero header. The summary counts move into the header's stat
          cluster (published/failed tinted to their pill tokens) and the
          "Run cron" button rides in the header's actions slot. */}
      <div className="cc-reveal">
        <DetailPageHeader
          icon={<PlatformIcon platform="youtube" className="size-8" />}
          eyebrow="Platform · Studio-scheduled"
          title="YouTube"
          subtitle="Drafts discovered in Studio and scheduled into canonical slots"
          stats={[
            { label: "Total", value: posts.length },
            { label: "Scheduled", value: scheduledCount },
            { label: "Published", value: publishedCount, pip: "static", pipColor: "var(--pill-ok-fg)" },
            { label: "Failed", value: failedCount, pip: "static", pipColor: "var(--pill-warn-fg)" },
          ]}
          actions={<RunYouTubeCronButton />}
        />
      </div>

      {error && (
        <Card className="mb-4 mt-7 p-4">
          <p className="text-sm text-destructive">
            Failed to load posts: {error.message}
          </p>
        </Card>
      )}

      <Card
        className="mt-7 overflow-hidden cc-reveal"
        style={{ animationDelay: "0.06s" } as React.CSSProperties}
      >
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead>Created</TableHead>
              <TableHead>Original title</TableHead>
              <TableHead>Generated title</TableHead>
              <TableHead>Publish at</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[80px]">Video</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {posts.map((post) => {
              const original = post.metadata?.original_title ?? post.title ?? "-";
              // Prefer the new transcript-based field; fall back to the old
              // cleaner output for rows written before the migration.
              const generated =
                post.metadata?.generated_title ??
                post.metadata?.cleaned_title ??
                post.title ??
                "-";
              const trackKind = post.metadata?.caption_track_kind;
              const isFallback = post.metadata?.title_source === "fallback";
              const fallbackSkipCount = post.metadata?.fallback_skip_count;
              const publish = formatPublishAt(post.metadata?.publish_at);
              const videoUrl = post.platform_post_id
                ? `https://studio.youtube.com/video/${post.platform_post_id}/edit`
                : null;
              return (
                <TableRow key={post.id} className="border-border align-top">
                  <TableCell className="whitespace-nowrap font-mono tabular text-muted-foreground">
                    {formatCreatedAt(post.created_at)}
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <div className="truncate" title={original}>
                      {original}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <div className="truncate font-medium" title={generated}>
                      {generated}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      {trackKind && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {trackKind === "asr" ? "ASR" : trackKind}
                        </span>
                      )}
                      {/* Fallback = needs review → warn pill tokens. */}
                      {isFallback && (
                        <Badge
                          className="border-transparent text-[10px] font-normal"
                          style={{
                            backgroundColor: "var(--pill-warn-bg)",
                            color: "var(--pill-warn-fg)",
                          }}
                        >
                          {fallbackSkipCount
                            ? `fallback — skipped ${fallbackSkipCount}×`
                            : "fallback"}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-mono tabular text-xs">{publish.utc}</div>
                    {publish.pt && (
                      <div className="font-mono tabular text-[11px] text-muted-foreground">
                        {publish.pt}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={post.status} />
                  </TableCell>
                  <TableCell>
                    {videoUrl ? (
                      <a
                        href={videoUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <span className="font-mono">
                          {post.platform_post_id?.slice(0, 6)}
                        </span>
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {posts.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-24 text-center text-muted-foreground"
                >
                  No studio-scheduled videos yet. The cron runs daily at 10:00 UTC.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </AppShell>
  );
}
