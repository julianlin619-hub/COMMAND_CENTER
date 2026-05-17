/**
 * L1 Q&A — Automation Map
 *
 * Static visual diagram of the planned L1 Q&A pipeline. There's no backend
 * behind it yet: the cron doesn't exist, no rows are written to `posts` or
 * `cron_runs`, no Supabase fetch happens here. This page exists so the
 * design is the source of truth while the actual workflow is being scoped
 * — when the pipeline ships, this file is the natural home for a richer
 * detail view (status, last-run timing, platform health, etc.) that reads
 * from `cron_runs` like the other platform pages do.
 *
 * Layout: a three-stage horizontal pipeline (Segment → Syncer → Editor),
 * each stage rendered as a card with a numbered eyebrow, an icon, and a
 * short bullet list of the sub-steps inside it. Stages are separated by
 * chevron connectors so the directionality of the flow reads at a glance.
 * On narrow viewports the row breaks and the chevrons rotate 90° so the
 * flow re-stacks vertically without losing the visual link.
 *
 * Why a static array instead of inline JSX: the connectors need to render
 * *between* stages, not after each one. Mapping over an array with an
 * index check is more readable than hand-writing chevrons between literal
 * blocks — and edits later (adding a stage, reordering) touch one place.
 * This is data shape, not abstraction.
 */
import Link from "next/link";
import {
  ArrowLeftIcon,
  AudioWaveformIcon,
  ChevronRightIcon,
  ClapperboardIcon,
  ScissorsIcon,
  type LucideIcon,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";

// Short-category accent (matches the home page tile). Reused for stage
// numbers and the icon ring so the page reads as "this is the Short ▸ L1
// Q&A surface" without us needing to wire it through a context.
const ACCENT = "#16B68A";

interface Stage {
  id: string;
  title: string;
  icon: LucideIcon;
  // Bullet copy inside the stage card. Plain strings — no links, no
  // status — until the pipeline ships and we have something real to
  // surface. Keep each line short (~5 words) so cards stay scannable.
  steps: string[];
}

// Step numbers are derived from array index at render time, so reordering
// or inserting a stage never strands a wrong number on the wrong card.
const STAGES: Stage[] = [
  {
    id: "segment",
    title: "Segment",
    icon: ScissorsIcon,
    steps: [
      "Select MP4 (A-cam)",
      "Deepgram transcribes (word-level timestamps)",
      "Segmenter LLM prompt",
      "Manual edit",
      "Export A-cam as MP4",
    ],
  },
  {
    id: "syncer",
    title: "Syncer",
    icon: AudioWaveformIcon,
    steps: [
      "Extract audio from B+ cams",
      "Cross-correlate vs A → offset",
      "Apply A's cuts with offset",
      "Render additional cams",
    ],
  },
  {
    id: "editor",
    title: "Editor",
    icon: ClapperboardIcon,
    steps: [
      "Place all cams into DaVinci (auto-aligned)",
      "Transcribe (built-in)",
      "Iterate LLM prompt in Claude until happy",
      "Apply back to timeline via Intelliscript",
      "Make fine cuts",
    ],
  },
];

export default function L1QAPage() {
  return (
    <AppShell>
      {/* Header block — mirrors the language of the home page's
          PageHeader (small uppercase wordmark, title, muted subtitle)
          so navigating between / and /l1-qa feels continuous. */}
      <div className="mb-10">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-[12px] text-white/55 transition-colors hover:text-white/85"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          Back to Command Center
        </Link>

        <div className="mt-6 flex items-baseline gap-3">
          {/* Same 3px×14px rail used on the home page's category bands —
              keeps the visual language consistent and signals which
              category this detail page belongs to. */}
          <span
            aria-hidden
            className="h-[18px] w-[3px] rounded-sm"
            style={{ backgroundColor: ACCENT }}
          />
          <h1 className="text-[28px] font-semibold leading-none tracking-tight text-[var(--overview-fg)]">
            L1 Q&amp;A
          </h1>
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em]"
            style={{
              color: ACCENT,
              backgroundColor: `${ACCENT}1f`, // ~12% accent tint
            }}
          >
            Planning
          </span>
        </div>
        <p className="mt-2 text-[13px] text-white/55">
          Visual map of the planned automation. Nothing here is wired up
          yet — edit{" "}
          <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-white/75">
            dashboard/src/app/l1-qa/page.tsx
          </code>{" "}
          to refine the flow.
        </p>
      </div>

      {/* The pipeline canvas itself. flex-row on wide screens, flex-col on
          narrow ones — chevron connectors rotate accordingly via the
          `rotate-90 md:rotate-0` class on each connector. The outer
          wrapper has a subtle inset border so the diagram reads as a
          dedicated surface rather than floating directly on the page
          background. */}
      <section
        className="rounded-2xl p-6 md:p-8"
        style={{
          backgroundColor: "var(--card-warm-bg)",
          border: "0.5px solid var(--card-warm-border)",
        }}
      >
        <div className="flex flex-col items-stretch gap-4 md:flex-row md:items-stretch md:gap-2">
          {STAGES.map((stage, i) => (
            <Stage
              key={stage.id}
              stage={stage}
              step={i + 1}
              isLast={i === STAGES.length - 1}
            />
          ))}
        </div>
      </section>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Stage card + connector. Split out as small inline components rather than
// further-nested JSX so the parent `STAGES.map(...)` stays readable.
// ---------------------------------------------------------------------------

function Stage({
  stage,
  step,
  isLast,
}: {
  stage: Stage;
  step: number;
  isLast: boolean;
}) {
  const Icon = stage.icon;

  // flex-1 so all stages share width equally on wide screens; on narrow
  // screens each card just goes full-width via the parent's flex-col.
  // The connector is rendered as a sibling after the card so the chain
  // reads card→arrow→card→arrow→card.
  return (
    <>
      <div
        className="flex flex-1 flex-col gap-4 rounded-xl p-5 transition-colors"
        style={{
          backgroundColor: "rgba(255,255,255,0.025)",
          border: "0.5px solid rgba(255,255,255,0.06)",
        }}
      >
        <div className="flex items-center justify-between">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.2em]"
            style={{ color: ACCENT }}
          >
            Step {step}
          </span>
          {/* Icon ring — the tinted backdrop ties the icon to the stage
              accent without making the whole card teal. */}
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-full"
            style={{
              color: ACCENT,
              backgroundColor: `${ACCENT}1a`,
            }}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        </div>

        <div className="text-[16px] font-semibold leading-tight text-[var(--overview-fg)]">
          {stage.title}
        </div>

        <ul className="flex flex-col gap-1.5">
          {stage.steps.map((s) => (
            <li
              key={s}
              className="flex items-start gap-2 text-[12px] leading-snug text-white/70"
            >
              {/* Tiny accent dot in place of a bullet — quieter than • */}
              <span
                aria-hidden
                className="mt-[6px] h-1 w-1 shrink-0 rounded-full"
                style={{ backgroundColor: ACCENT }}
              />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </div>

      {!isLast && <Connector />}
    </>
  );
}

function Connector() {
  // Rotates 90° on narrow viewports so vertical stacking still reads as
  // a directed flow. Color is muted — the connector should support the
  // diagram, not compete with the stage cards.
  return (
    <div className="flex items-center justify-center self-center text-white/30">
      <ChevronRightIcon className="h-5 w-5 rotate-90 md:rotate-0" />
    </div>
  );
}

