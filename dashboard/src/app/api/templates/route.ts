/**
 * GET /api/templates?platform=facebook — fetch the active template for a platform
 * PUT /api/templates — update a template's config
 *
 * Templates are stored in the `templates` table and control how content is
 * rendered (colors, fonts, layout). The template designer UI reads and writes
 * through these endpoints.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";
import type { TemplateConfig } from "@/lib/template-types";

export async function GET(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const platform = req.nextUrl.searchParams.get("platform");
  if (!platform) {
    return NextResponse.json(
      { error: "platform query param required" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseClient();
  const { data: template, error } = await supabase
    .from("templates")
    .select("id, platform, name, config, is_active")
    .eq("platform", platform)
    .eq("is_active", true)
    .limit(1)
    .single();

  if (error || !template) {
    return NextResponse.json(
      { error: `No active template found for ${platform}` },
      { status: 404 }
    );
  }

  return NextResponse.json({ template });
}

export async function PUT(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, config } = (await req.json()) as {
    id: string;
    config: TemplateConfig;
  };

  if (!id || !config) {
    return NextResponse.json(
      { error: "id and config are required" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseClient();
  const { data: template, error } = await supabase
    .from("templates")
    .update({ config, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, platform, name, config, is_active")
    .single();

  if (error || !template) {
    return NextResponse.json(
      { error: `Failed to update template: ${error?.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ template });
}
