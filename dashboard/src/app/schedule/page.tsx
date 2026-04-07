import { getSupabaseClient } from "@/lib/supabase";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const supabase = getSupabaseClient();

  const { data: schedules } = await supabase
    .from("schedules")
    .select("*, posts(*)")
    .is("picked_up_at", null)
    .order("scheduled_for", { ascending: true })
    .limit(50);

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          <Link href="/">Command Center</Link> / Schedule
        </h1>
        <UserButton />
      </header>

      <main className="p-6">
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left p-3">Platform</th>
                <th className="text-left p-3">Title / Caption</th>
                <th className="text-left p-3">Scheduled For</th>
                <th className="text-left p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {schedules?.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="p-3 capitalize">{s.posts?.platform}</td>
                  <td className="p-3 max-w-xs truncate">
                    {s.posts?.title || s.posts?.caption || "-"}
                  </td>
                  <td className="p-3">
                    {new Date(s.scheduled_for).toLocaleString()}
                  </td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                      {s.posts?.status || "scheduled"}
                    </span>
                  </td>
                </tr>
              ))}
              {(!schedules || schedules.length === 0) && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-gray-500">
                    No upcoming scheduled posts.
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
