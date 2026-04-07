import { getSupabaseClient } from "@/lib/supabase";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

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

  // Aggregate totals by platform
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
    <div className="min-h-screen">
      <header className="border-b bg-white px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          <Link href="/">Command Center</Link> / Analytics
        </h1>
        <UserButton />
      </header>

      <main className="p-6">
        <p className="text-sm text-gray-500 mb-4">
          Last {days} days. Add <code>?days=7</code> or{" "}
          <code>?platform=youtube</code> to filter.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {Object.entries(totals).map(([platform, t]) => (
            <div key={platform} className="bg-white rounded-lg border p-4">
              <h3 className="font-medium capitalize mb-2">{platform}</h3>
              <dl className="text-sm text-gray-600 space-y-1">
                <div className="flex justify-between">
                  <dt>Views</dt>
                  <dd>{t.views.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Likes</dt>
                  <dd>{t.likes.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Comments</dt>
                  <dd>{t.comments.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Shares</dt>
                  <dd>{t.shares.toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          ))}
          {Object.keys(totals).length === 0 && (
            <p className="text-gray-500 col-span-full">
              No metrics data yet.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
