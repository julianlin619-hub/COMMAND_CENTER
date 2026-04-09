/**
 * Command Center page — org chart view showing all AI agents and
 * workflows that run through the system across all 6 platforms.
 *
 * This is a high-level visualization to help reason about the
 * agent architecture. Platform columns expand to show individual agents.
 */

import { AppShell } from "@/components/app-shell";
import { AgentOrgChart } from "@/components/agent-org-chart";

export default function CommandCenterPage() {
  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Agent Org Chart</h1>
        <p className="text-sm text-muted-foreground mt-1">
          High-level view of all agents and workflows running through the Command Center.
          Click a platform to expand its agent tree.
        </p>
      </div>
      <AgentOrgChart />
    </AppShell>
  );
}
