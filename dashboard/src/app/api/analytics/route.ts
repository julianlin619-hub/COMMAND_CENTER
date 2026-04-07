import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

export async function GET(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform");
  const postId = searchParams.get("post_id");
  const since = searchParams.get("since");
  const limit = parseInt(searchParams.get("limit") || "100", 10);

  const supabase = getSupabaseClient();
  let query = supabase
    .from("engagement_metrics")
    .select("*")
    .order("snapshot_at", { ascending: false })
    .limit(limit);

  if (platform) query = query.eq("platform", platform);
  if (postId) query = query.eq("post_id", postId);
  if (since) query = query.gte("snapshot_at", since);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("engagement_metrics")
    .insert(body)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data, { status: 201 });
}
