import { getSupabaseClient } from "@/lib/supabase";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

export const dynamic = "force-dynamic";

const PLATFORMS = [
  "youtube",
  "instagram",
  "tiktok",
  "linkedin",
  "x",
  "threads",
] as const;

async function getPlatformSummary(platform: string) {
  const supabase = getSupabaseClient();

  const [lastPostResult, nextScheduleResult, cronResult] = await Promise.all([
    supabase
      .from("posts")
      .select("published_at")
      .eq("platform", platform)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(1),
    supabase
      .from("schedules")
      .select("scheduled_for, posts!inner(platform)")
      .eq("posts.platform", platform)
      .is("picked_up_at", null)
      .order("scheduled_for", { ascending: true })
      .limit(1),
    supabase
      .from("cron_runs")
      .select("status, started_at")
      .eq("platform", platform)
      .order("started_at", { ascending: false })
      .limit(1),
  ]);

  return {
    platform,
    lastPost: lastPostResult.data?.[0]?.published_at ?? null,
    nextScheduled: nextScheduleResult.data?.[0]?.scheduled_for ?? null,
    cronHealthy: cronResult.data?.[0]?.status === "success",
    lastCronAt: cronResult.data?.[0]?.started_at ?? null,
  };
}

export default async function DashboardHome() {
  const summaries = await Promise.all(PLATFORMS.map(getPlatformSummary));

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Command Center</h1>
        <div className="flex items-center gap-4">
          <nav className="flex gap-4 text-sm">
            <Link href="/posts" className="hover:underline">
              Posts
            </Link>
            <Link href="/schedule" className="hover:underline">
              Schedule
            </Link>
            <Link href="/analytics" className="hover:underline">
              Analytics
            </Link>
            <Link href="/upload" className="hover:underline">
              Upload
            </Link>
            <Link href="/cron-logs" className="hover:underline">
              Cron Logs
            </Link>
          </nav>
          <UserButton />
        </div>
      </header>

      <main className="p-6">
        <h2 className="text-lg font-medium mb-4">Platform Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {summaries.map((s) => (
            <div key={s.platform} className="bg-white rounded-lg border p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium capitalize">{s.platform}</h3>
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    s.cronHealthy ? "bg-green-500" : "bg-red-500"
                  }`}
                  title={s.cronHealthy ? "Cron healthy" : "Cron failing"}
                />
              </div>
              <dl className="text-sm text-gray-600 space-y-1">
                <div className="flex justify-between">
                  <dt>Last post</dt>
                  <dd>
                    {s.lastPost
                      ? new Date(s.lastPost).toLocaleDateString()
                      : "None"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Next scheduled</dt>
                  <dd>
                    {s.nextScheduled
                      ? new Date(s.nextScheduled).toLocaleDateString()
                      : "None"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Last cron run</dt>
                  <dd>
                    {s.lastCronAt
                      ? new Date(s.lastCronAt).toLocaleString()
                      : "Never"}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
