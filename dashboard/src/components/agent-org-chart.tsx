"use client";

/**
 * Agent Org Chart — visualizes the hierarchy of AI agents and workflows
 * that run through the Media Command Center across all 6 platforms.
 *
 * Layout:
 *   Orchestrator (top)
 *     → 6 per-platform agent columns
 *
 * Uses CSS pseudo-elements for tree connector lines and framer-motion
 * for staggered entrance animations.
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import {
  BotIcon,
  RefreshCwIcon,
  UploadIcon,
  SearchIcon,
  RepeatIcon,
  ShieldCheckIcon,
  ImageIcon,
  SendIcon,
  TrendingUpIcon,
  ChevronDownIcon,
} from "lucide-react";

/* ─── Data ──────────────────────────────────────────────────────────── */

type AgentStatus = "active" | "planned" | "placeholder";

interface AgentNode {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  icon: React.ElementType;
}

interface PlatformAgents {
  platform: string;
  initials: string;
  color: string; // tailwind color for the avatar ring
  agents: AgentNode[];
}

/* Per-platform agent definitions — active platforms first, inactive at the end */
const ACTIVE_PLATFORM_AGENTS: PlatformAgents[] = [
  {
    platform: "Threads",
    initials: "TH",
    color: "text-purple-400",
    agents: [
      { id: "th-source", name: "Content Sourcer", description: "Pulls content from configured sources for repurposing", status: "active", icon: SearchIcon },
      { id: "th-publish", name: "Publisher", description: "Creates text/image posts via Threads API", status: "active", icon: SendIcon },
      { id: "th-metrics", name: "Metrics Collector", description: "Pulls views, likes, replies, reposts", status: "planned", icon: TrendingUpIcon },
      { id: "th-auth", name: "Auth Refresher", description: "Refreshes long-lived access tokens", status: "active", icon: ShieldCheckIcon },
    ],
  },
];

const INACTIVE_PLATFORM_AGENTS: PlatformAgents[] = [
  {
    platform: "YouTube",
    initials: "YT",
    color: "text-red-500",
    agents: [
      { id: "yt-publish", name: "Publisher", description: "Uploads videos and sets metadata via YouTube Data API", status: "planned", icon: UploadIcon },
      { id: "yt-metrics", name: "Metrics Collector", description: "Pulls view counts, watch time, subscribers", status: "planned", icon: TrendingUpIcon },
      { id: "yt-auth", name: "Auth Refresher", description: "Refreshes OAuth tokens before expiry", status: "planned", icon: ShieldCheckIcon },
    ],
  },
  {
    platform: "Instagram",
    initials: "IG",
    color: "text-[#ae5630]",
    agents: [
      { id: "ig-publish", name: "Publisher", description: "Posts images/reels via Instagram Graph API", status: "planned", icon: ImageIcon },
      { id: "ig-metrics", name: "Metrics Collector", description: "Pulls likes, comments, reach, impressions", status: "planned", icon: TrendingUpIcon },
      { id: "ig-auth", name: "Auth Refresher", description: "Refreshes long-lived tokens", status: "planned", icon: ShieldCheckIcon },
    ],
  },
  {
    platform: "TikTok",
    initials: "TK",
    color: "text-[#c4683f]",
    agents: [
      { id: "tk-publish", name: "Publisher", description: "Uploads videos via TikTok Content Posting API", status: "planned", icon: UploadIcon },
      { id: "tk-metrics", name: "Metrics Collector", description: "Pulls views, likes, shares, comments", status: "planned", icon: TrendingUpIcon },
      { id: "tk-auth", name: "Auth Refresher", description: "Refreshes OAuth2 credentials", status: "planned", icon: ShieldCheckIcon },
    ],
  },
  {
    platform: "LinkedIn",
    initials: "LI",
    color: "text-[#c4683f]",
    agents: [
      { id: "li-publish", name: "Publisher", description: "Creates posts and articles via LinkedIn API", status: "planned", icon: SendIcon },
      { id: "li-metrics", name: "Metrics Collector", description: "Pulls impressions, clicks, engagement rate", status: "planned", icon: TrendingUpIcon },
      { id: "li-auth", name: "Auth Refresher", description: "Refreshes OAuth tokens", status: "planned", icon: ShieldCheckIcon },
    ],
  },
  {
    platform: "X",
    initials: "X",
    color: "text-[var(--overview-fg)]/85",
    agents: [
      { id: "x-publish", name: "Publisher", description: "Posts tweets and threads via X API v2", status: "planned", icon: SendIcon },
      { id: "x-metrics", name: "Metrics Collector", description: "Pulls impressions, retweets, likes, bookmarks", status: "planned", icon: TrendingUpIcon },
      { id: "x-auth", name: "Auth Refresher", description: "Refreshes OAuth 2.0 PKCE tokens", status: "planned", icon: ShieldCheckIcon },
    ],
  },
];

const PLATFORM_AGENTS = [...ACTIVE_PLATFORM_AGENTS, ...INACTIVE_PLATFORM_AGENTS];

/* Shared workflow patterns that connect orchestrator to platform agents */
const WORKFLOW_PATTERNS = [
  {
    name: "Publish Flow",
    description: "Schedule → Orchestrator → Platform Publisher → Supabase update",
    icon: RepeatIcon,
  },
  {
    name: "Metrics Sync",
    description: "Cron trigger → Orchestrator → Platform Collectors → engagement_metrics table",
    icon: RefreshCwIcon,
  },
  {
    name: "Auth Lifecycle",
    description: "Token expiry check → Platform Auth Refresher → env var / secret update",
    icon: ShieldCheckIcon,
  },
];

/* ─── Status badge helper ───────────────────────────────────────────── */

function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <span
          className={cn("inline-block size-2 rounded-full", {
            "bg-[#8ca082]": status === "active",
            "bg-[#ae5630]": status === "planned",
            "bg-white/[0.15]": status === "placeholder",
          })}
        />
      </TooltipTrigger>
      <TooltipContent>
        {status === "active" && "Active — running in production"}
        {status === "planned" && "Planned — not yet implemented"}
        {status === "placeholder" && "Placeholder — scaffold only"}
      </TooltipContent>
    </Tooltip>
  );
}

/* ─── Tree connector line (vertical) ────────────────────────────────── */

function ConnectorLine({ className }: { className?: string }) {
  return (
    <div className={cn("mx-auto w-px h-6 bg-white/[0.10]", className)} />
  );
}

/* ─── Expandable platform column ─────────────────────────────────────── */

function PlatformColumn({ data }: { data: PlatformAgents }) {
  const [expanded, setExpanded] = useState(false);
  const activeCount = data.agents.filter((a) => a.status === "active").length;

  return (
    <div className="flex flex-col items-center min-w-[160px]">
      {/* Platform header node */}
      <motion.button
        onClick={() => setExpanded(!expanded)}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.98 }}
        className="w-full"
      >
        <Card className="cursor-pointer hover:ring-[#ae5630]/40 transition-shadow">
          <CardHeader className="pb-0">
            <div className="flex items-center gap-2">
              <Avatar size="sm">
                <AvatarFallback className={cn("text-[10px] font-bold", data.color)}>
                  {data.initials}
                </AvatarFallback>
              </Avatar>
              <CardTitle className="text-sm">{data.platform}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {data.agents.length} agents
              </span>
              <div className="flex items-center gap-1.5">
                {activeCount > 0 && (
                  <Badge className="bg-[#8ca082]/15 text-[#8ca082] border-[#8ca082]/25 text-[10px] px-1.5">
                    {activeCount} live
                  </Badge>
                )}
                <motion.span
                  animate={{ rotate: expanded ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                </motion.span>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.button>

      {/* Expanded agent list */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden w-full"
          >
            <ConnectorLine />
            <div className="space-y-2">
              {data.agents.map((agent, i) => (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.2 }}
                >
                  <Tooltip>
                    <TooltipTrigger className="w-full text-left">
                      <Card size="sm" className="bg-black/30">
                        <CardContent className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            <agent.icon className="size-3.5 text-muted-foreground shrink-0" />
                            <span className="text-xs font-medium truncate">
                              {agent.name}
                            </span>
                            <StatusDot status={agent.status} />
                          </div>
                        </CardContent>
                      </Card>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {agent.description}
                    </TooltipContent>
                  </Tooltip>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Main org chart component ──────────────────────────────────────── */

export function AgentOrgChart() {
  return (
    <div className="space-y-8">
      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Status:</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-[#8ca082]" />
          Active
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-[#ae5630]" />
          Planned
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-white/[0.15]" />
          Placeholder
        </span>
      </div>

      {/* ── Level 0: Orchestrator ─────────────────────────────────── */}
      <div className="flex flex-col items-center">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="w-full max-w-md"
        >
          <Card className="ring-[#ae5630]/30">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center size-10 rounded-lg bg-[#ae5630]/15">
                  <BotIcon className="size-5 text-[#ae5630]" />
                </div>
                <div>
                  <CardTitle>Command Center Orchestrator</CardTitle>
                  <CardDescription>
                    Central coordinator — routes work to platform agents, manages retries and error handling
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>
        </motion.div>

        {/* Vertical connector */}
        <div className="w-px h-8 bg-white/[0.10]" />

        {/* Horizontal connector bar to platforms */}
        <div className="w-full h-px bg-white/[0.10]" />
        <div className="w-px h-4 bg-white/[0.10]" />
      </div>

      {/* ── Platform agents ─────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.4 }}
      >
        <h3 className="text-sm font-medium text-muted-foreground mb-4">
          Platform Agents — click to expand
        </h3>

        {/* Active platforms */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {ACTIVE_PLATFORM_AGENTS.map((platform, i) => (
            <motion.div
              key={platform.platform}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 + i * 0.05, duration: 0.3 }}
            >
              <PlatformColumn data={platform} />
            </motion.div>
          ))}
        </div>

        {/* Inactive platforms — greyed out */}
        <h4 className="text-xs font-medium text-muted-foreground mt-6 mb-3">Coming soon</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 opacity-40 grayscale">
          {INACTIVE_PLATFORM_AGENTS.map((platform, i) => (
            <motion.div
              key={platform.platform}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 + i * 0.05, duration: 0.3 }}
            >
              <PlatformColumn data={platform} />
            </motion.div>
          ))}
        </div>
      </motion.div>

      <Separator />

      {/* ── Workflow patterns ─────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 0.4 }}
      >
        <h3 className="text-sm font-medium text-muted-foreground mb-4">
          Workflow Patterns
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {WORKFLOW_PATTERNS.map((wf) => (
            <Card key={wf.name} size="sm" className="bg-black/30">
              <CardContent className="py-3">
                <div className="flex items-start gap-2">
                  <wf.icon className="size-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium">{wf.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {wf.description}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
