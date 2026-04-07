import { getSupabaseClient } from "@/lib/supabase";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CronLogsPage() {
  const supabase = getSupabaseClient();

  const { data: runs } = await supabase
    .from("cron_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(100);

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          <Link href="/">Command Center</Link> / Cron Logs
        </h1>
        <UserButton />
      </header>

      <main className="p-6">
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left p-3">Platform</th>
                <th className="text-left p-3">Job Type</th>
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Started</th>
                <th className="text-left p-3">Duration</th>
                <th className="text-left p-3">Posts</th>
                <th className="text-left p-3">Error</th>
              </tr>
            </thead>
            <tbody>
              {runs?.map((run) => {
                const duration =
                  run.finished_at && run.started_at
                    ? Math.round(
                        (new Date(run.finished_at).getTime() -
                          new Date(run.started_at).getTime()) /
                          1000
                      )
                    : null;
                return (
                  <tr key={run.id} className="border-b last:border-0">
                    <td className="p-3 capitalize">{run.platform}</td>
                    <td className="p-3">{run.job_type}</td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          run.status === "success"
                            ? "bg-green-100 text-green-800"
                            : run.status === "failed"
                              ? "bg-red-100 text-red-800"
                              : "bg-yellow-100 text-yellow-800"
                        }`}
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="p-3">
                      {new Date(run.started_at).toLocaleString()}
                    </td>
                    <td className="p-3">
                      {duration !== null ? `${duration}s` : "running..."}
                    </td>
                    <td className="p-3">{run.posts_processed}</td>
                    <td className="p-3 max-w-xs truncate text-red-600">
                      {run.error_message || "-"}
                    </td>
                  </tr>
                );
              })}
              {(!runs || runs.length === 0) && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-gray-500">
                    No cron runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
