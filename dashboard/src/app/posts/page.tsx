import { getSupabaseClient } from "@/lib/supabase";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; status?: string }>;
}) {
  const params = await searchParams;
  const supabase = getSupabaseClient();

  let query = supabase
    .from("posts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (params.platform) query = query.eq("platform", params.platform);
  if (params.status) query = query.eq("status", params.status);

  const { data: posts } = await query;

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          <Link href="/">Command Center</Link> / Posts
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
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Published</th>
                <th className="text-left p-3">Link</th>
              </tr>
            </thead>
            <tbody>
              {posts?.map((post) => (
                <tr key={post.id} className="border-b last:border-0">
                  <td className="p-3 capitalize">{post.platform}</td>
                  <td className="p-3 max-w-xs truncate">
                    {post.title || post.caption || "-"}
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        post.status === "published"
                          ? "bg-green-100 text-green-800"
                          : post.status === "failed"
                            ? "bg-red-100 text-red-800"
                            : "bg-yellow-100 text-yellow-800"
                      }`}
                    >
                      {post.status}
                    </span>
                  </td>
                  <td className="p-3">
                    {post.published_at
                      ? new Date(post.published_at).toLocaleDateString()
                      : "-"}
                  </td>
                  <td className="p-3">
                    {post.permalink ? (
                      <a
                        href={post.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        View
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))}
              {(!posts || posts.length === 0) && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-gray-500">
                    No posts yet.
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
