/**
 * Analytics Page — aggregated engagement metrics per platform.
 *
 * Supports URL query params: /analytics?days=7&platform=youtube
 */

import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StaggeredContainer, StaggeredItem } from "@/components/motion/staggered-list";
import { HoverCard } from "@/components/motion/hover-card";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; days?: string }>;
}) {
  const params = await searchParams;
  const supabase = getSupabaseClient();

  const days = parseInt(params.days || "30", 10);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let query = supabase
    .from("engagement_metrics")
    .select("*")
    .gte("snapshot_at", since)
    .order("snapshot_at", { ascending: false })
    .limit(200);

  if (params.platform) query = query.eq("platform", params.platform);

  const { data: metrics } = await query;

  // Aggregate totals per platform
  const totals: Record<
    string,
    { views: number; likes: number; comments: number; shares: number }
  > = {};
  for (const m of metrics || []) {
    if (!totals[m.platform]) {
      totals[m.platform] = { views: 0, likes: 0, comments: 0, shares: 0 };
    }
    totals[m.platform].views += m.views || 0;
    totals[m.platform].likes += m.likes || 0;
    totals[m.platform].comments += m.comments || 0;
    totals[m.platform].shares += m.shares || 0;
  }

  return (
    <AppShell>
      <div className="mb-6">
        <h2 className="text-lg font-medium">Analytics</h2>
        <p className="text-sm text-muted-foreground">
          Last {days} days
          {params.platform && <span> &middot; {params.platform}</span>}
          <span className="ml-2 text-zinc-600">
            Filter with ?days=7 or ?platform=youtube
          </span>
        </p>
      </div>

      {Object.keys(totals).length === 0 ? (
        <p className="text-muted-foreground">No metrics data yet.</p>
      ) : (
        <StaggeredContainer className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Object.entries(totals).map(([platform, t]) => (
            <StaggeredItem key={platform}>
            <HoverCard>
            <Card>
              <CardHeader>
                <CardTitle className="capitalize">{platform}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Views</dt>
                    <dd className="font-medium">{t.views.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Likes</dt>
                    <dd className="font-medium">{t.likes.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Comments</dt>
                    <dd className="font-medium">
                      {t.comments.toLocaleString()}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Shares</dt>
                    <dd className="font-medium">{t.shares.toLocaleString()}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
            </HoverCard>
            </StaggeredItem>
          ))}
        </StaggeredContainer>
      )}
    </AppShell>
  );
}
