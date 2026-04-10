/**
 * POST /api/templates/preview
 *
 * Renders a live preview of a quote card template. Takes sample text and a
 * template config, returns a base64-encoded PNG image. Used by the template
 * designer for real-time preview as the user tweaks design settings.
 *
 * Body: { text: string, config: TemplateConfig }
 * Returns: { image: "data:image/png;base64,..." }
 *
 * No Supabase Storage upload — this is a transient preview only.
 */

import { NextRequest, NextResponse } from "next/server";
import { renderSquareQuoteCard } from "@/lib/square-canvas-render";
import { verifyApiAuth } from "@/lib/auth";
import type { TemplateConfig } from "@/lib/template-types";

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { text, config } = (await req.json()) as {
      text: string;
      config: TemplateConfig;
    };

    if (!text || !config) {
      return NextResponse.json(
        { error: "text and config are required" },
        { status: 400 }
      );
    }

    const pngBuffer = await renderSquareQuoteCard(text, config);
    const base64 = pngBuffer.toString("base64");

    return NextResponse.json({
      image: `data:image/png;base64,${base64}`,
    });
  } catch (e) {
    console.error("Template preview error:", e);
    return NextResponse.json(
      { error: "Failed to render preview" },
      { status: 500 }
    );
  }
}
