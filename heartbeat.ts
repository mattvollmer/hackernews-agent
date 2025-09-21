import blink from "blink";

const TTL_MS = 1000 * 60 * 60; // 1h
const REG_KEY = (teamId: string) => `agent_registry_last_${teamId}`;

export interface AgentManifest {
  version: "v1";
  team_id: string;
  agent_user_id: string; // Slack user ID (context.botUserId)
  agent_name: string;
  summary: string;
  skills: string[];
  examples: string[];
}

export async function registerIfStale(
  teamId: string,
  agentUserId: string,
  manifest: Omit<AgentManifest, "version" | "team_id" | "agent_user_id">,
) {
  const url = process.env.CONDUCTOR_REGISTRY_URL;
  const token = process.env.CONDUCTOR_REGISTRY_TOKEN;
  if (!url || !token) return; // silently no-op if not configured

  const lastRaw = await blink.storage.get(REG_KEY(teamId));
  const last = lastRaw ? Number(lastRaw) : 0;
  if (Date.now() - last < TTL_MS) return;

  const body: AgentManifest = {
    version: "v1",
    team_id: teamId,
    agent_user_id: agentUserId,
    ...manifest,
  };

  // Normalize to base webhook path: strip trailing /registry if present
  let target = url;
  try {
    const u = new URL(url);
    if (u.pathname.endsWith("/registry")) {
      u.pathname = u.pathname.replace(/\/registry\/?$/, "");
      target = u.toString();
    }
  } catch {
    if (url.endsWith("/registry")) {
      target = url.replace(/\/registry\/?$/, "");
    }
  }

  await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-conductor-registry": "1",
    },
    body: JSON.stringify(body),
  });

  await blink.storage.set(REG_KEY(teamId), String(Date.now()));
}
