/**
 * Obligation Tracker — automated task accountability for OpenClaw coordinators.
 *
 * Lifecycle:
 *   sessions_spawn  →  after_tool_call   →  REGISTER obligation (RUNNING)
 *   subagent done   →  subagent_ended    →  UPDATE status (ARRIVED / TIMEOUT / FAILED)
 *   every turn      →  before_prompt_build →  INJECT pending obligations into prompt
 *   coordinator msg →  message_sending   →  DETECT delivery, mark DELIVERED
 *
 * No step depends on LLM compliance — the gateway enforces all four.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

interface Obligation {
  id: string;
  taskLabel: string;
  taskSummary: string;
  targetAgent: string;
  childSessionKey: string;
  runId: string;
  spawnedAt: string;       // ISO
  runTimeoutSec: number;
  status: ObligationStatus;
  resultArrivedAt?: string;
  deliveredAt?: string;
  timeoutAt?: string;
  retryCount: number;
  outcome?: string;        // from subagent_ended
  error?: string;
}

type ObligationStatus =
  | "RUNNING"
  | "ARRIVED"
  | "DELIVERED"
  | "TIMEOUT"
  | "FAILED";

interface PluginConfig {
  coordinatorAgentIds: string[];
  storagePath: string;
  deliveredTtlHours: number;
  timeoutGraceSec: number;
  injectPriority: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function genId(): string {
  return `obl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}min ago`;
}

function extractTaskSummary(params: Record<string, unknown>): string {
  const task = typeof params.task === "string" ? params.task : "";
  // Extract first meaningful line, truncate
  const firstLine = task
    .split("\n")
    .map((l: string) => l.trim())
    .find((l: string) => l.length > 10 && !l.startsWith("[") && !l.startsWith("```"));
  if (firstLine) return firstLine.slice(0, 120);
  // Fallback: first 120 chars
  return task.replace(/\n/g, " ").slice(0, 120) || "(no task description)";
}

// ── Store ──────────────────────────────────────────────────────────────────

class ObligationStore {
  private dir: string;

  constructor(basePath: string) {
    this.dir = resolveHome(basePath);
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(coordinatorId: string): string {
    return join(this.dir, `${coordinatorId}.json`);
  }

  load(coordinatorId: string): Obligation[] {
    const fp = this.filePath(coordinatorId);
    if (!existsSync(fp)) return [];
    try {
      return JSON.parse(readFileSync(fp, "utf-8"));
    } catch {
      return [];
    }
  }

  save(coordinatorId: string, obligations: Obligation[]): void {
    writeFileSync(this.filePath(coordinatorId), JSON.stringify(obligations, null, 2), "utf-8");
  }

  add(coordinatorId: string, obligation: Obligation): void {
    const list = this.load(coordinatorId);
    list.push(obligation);
    this.save(coordinatorId, list);
  }

  update(
    coordinatorId: string,
    childSessionKey: string,
    patch: Partial<Obligation>,
  ): boolean {
    const list = this.load(coordinatorId);
    const idx = list.findIndex((o) => o.childSessionKey === childSessionKey);
    if (idx === -1) return false;
    list[idx] = { ...list[idx], ...patch };
    this.save(coordinatorId, list);
    return true;
  }

  /** Get active (non-delivered, non-expired) obligations */
  pending(coordinatorId: string): Obligation[] {
    return this.load(coordinatorId).filter(
      (o) => o.status !== "DELIVERED",
    );
  }

  /** Remove delivered obligations older than ttlHours */
  gc(coordinatorId: string, ttlHours: number): number {
    const list = this.load(coordinatorId);
    const cutoff = Date.now() - ttlHours * 3600_000;
    const before = list.length;
    const kept = list.filter((o) => {
      if (o.status !== "DELIVERED") return true;
      const deliveredMs = o.deliveredAt ? new Date(o.deliveredAt).getTime() : 0;
      return deliveredMs > cutoff;
    });
    if (kept.length < before) {
      this.save(coordinatorId, kept);
    }
    return before - kept.length;
  }

  /** Check RUNNING obligations for timeout */
  checkTimeouts(coordinatorId: string, graceSec: number): number {
    const list = this.load(coordinatorId);
    const now = Date.now();
    let count = 0;
    for (const o of list) {
      if (o.status !== "RUNNING") continue;
      const deadline = new Date(o.spawnedAt).getTime() + (o.runTimeoutSec + graceSec) * 1000;
      if (now > deadline) {
        o.status = "TIMEOUT";
        o.timeoutAt = new Date().toISOString();
        count++;
      }
    }
    if (count > 0) this.save(coordinatorId, list);
    return count;
  }
}

// ── Prompt Renderer ────────────────────────────────────────────────────────

function renderObligations(obligations: Obligation[]): string {
  if (obligations.length === 0) return "";

  const arrived = obligations.filter((o) => o.status === "ARRIVED");
  const running = obligations.filter((o) => o.status === "RUNNING");
  const failed = obligations.filter((o) => o.status === "TIMEOUT" || o.status === "FAILED");

  const lines: string[] = ["<pending-obligations>"];

  if (arrived.length > 0) {
    lines.push(
      `⚠ ${arrived.length} obligation(s) with RESULTS READY — deliver to Boss BEFORE any new work:\n`,
    );
    for (const o of arrived) {
      lines.push(
        `  → [RESULT_ARRIVED] ${o.taskLabel} (${o.targetAgent}, spawned ${ago(o.spawnedAt)})`,
        `    Task: ${o.taskSummary}`,
        `    Action: Read the result and deliver a synthesis to Boss NOW.`,
        "",
      );
    }
  }

  if (running.length > 0) {
    lines.push(`${running.length} obligation(s) still RUNNING:\n`);
    for (const o of running) {
      lines.push(
        `  ⏳ [RUNNING] ${o.taskLabel} (${o.targetAgent}, spawned ${ago(o.spawnedAt)}, timeout ${o.runTimeoutSec}s)`,
        `    Task: ${o.taskSummary}`,
        "",
      );
    }
  }

  if (failed.length > 0) {
    lines.push(`${failed.length} obligation(s) FAILED/TIMEOUT — inform Boss and decide on retry:\n`);
    for (const o of failed) {
      const reason = o.error || o.outcome || "unknown";
      lines.push(
        `  ✗ [${o.status}] ${o.taskLabel} (${o.targetAgent}, reason: ${reason})`,
        `    Task: ${o.taskSummary}`,
        "",
      );
    }
  }

  lines.push(
    "Rule: RESULT_ARRIVED obligations MUST be resolved before starting new work.",
    "Rule: TIMEOUT/FAILED obligations MUST be reported to Boss (retry or explain).",
    "</pending-obligations>",
  );

  return lines.join("\n");
}

// ── Plugin Entry Point ─────────────────────────────────────────────────────

export default {
  register(api: any) {
    const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const cfg: PluginConfig = {
      coordinatorAgentIds: Array.isArray(raw.coordinatorAgentIds)
        ? (raw.coordinatorAgentIds as string[])
        : ["chat"],
      storagePath: typeof raw.storagePath === "string"
        ? raw.storagePath
        : "~/.openclaw/obligations",
      deliveredTtlHours: typeof raw.deliveredTtlHours === "number"
        ? raw.deliveredTtlHours
        : 48,
      timeoutGraceSec: typeof raw.timeoutGraceSec === "number"
        ? raw.timeoutGraceSec
        : 60,
      injectPriority: typeof raw.injectPriority === "number"
        ? raw.injectPriority
        : 18,
    };

    const store = new ObligationStore(cfg.storagePath);
    const isCoordinator = (agentId?: string) =>
      agentId != null && cfg.coordinatorAgentIds.includes(agentId);

    // Map childSessionKey → coordinatorAgentId for delivery routing
    const sessionToCoordinator = new Map<string, string>();

    api.logger.info(
      `obligation-tracker: initialized (coordinators: ${cfg.coordinatorAgentIds.join(", ")}, storage: ${cfg.storagePath})`,
    );

    // ── Hook 1: AUTO-REGISTER on sessions_spawn ──────────────────────────

    api.on("after_tool_call", (event: any, ctx: any) => {
      if (event.toolName !== "sessions_spawn") return;
      if (!isCoordinator(ctx.agentId)) return;

      const result = event.result as Record<string, unknown> | undefined;
      if (!result || result.status !== "accepted") return;

      const params = (event.params ?? {}) as Record<string, unknown>;
      const childSessionKey = result.childSessionKey as string;
      const coordinatorId = ctx.agentId as string;

      // Avoid duplicates (re-spawn of same session)
      const existing = store.load(coordinatorId);
      if (existing.some((o) => o.childSessionKey === childSessionKey)) return;

      const obligation: Obligation = {
        id: genId(),
        taskLabel: (typeof params.label === "string" ? params.label : "") ||
          `${params.agentId || "subagent"}-${Date.now().toString(36)}`,
        taskSummary: extractTaskSummary(params),
        targetAgent: (typeof params.agentId === "string" ? params.agentId : "unknown"),
        childSessionKey,
        runId: (result.runId as string) || "",
        spawnedAt: new Date().toISOString(),
        runTimeoutSec: typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : 600,
        status: "RUNNING",
        retryCount: 0,
      };

      // Detect retry: same label with previous TIMEOUT/FAILED
      const prev = existing.find(
        (o) =>
          o.taskLabel === obligation.taskLabel &&
          (o.status === "TIMEOUT" || o.status === "FAILED"),
      );
      if (prev) {
        obligation.retryCount = prev.retryCount + 1;
        // Remove the old failed entry — retry replaces it
        const cleaned = existing.filter((o) => o.id !== prev.id);
        cleaned.push(obligation);
        store.save(coordinatorId, cleaned);
      } else {
        store.add(coordinatorId, obligation);
      }

      sessionToCoordinator.set(childSessionKey, coordinatorId);

      api.logger.info(
        `obligation-tracker: registered [${obligation.taskLabel}] → ${obligation.targetAgent} (retry=${obligation.retryCount})`,
      );
    }, { priority: 10 });

    // ── Hook 2: AUTO-UPDATE on subagent_ended ────────────────────────────

    api.on("subagent_ended", (event: any, ctx: any) => {
      const childKey = event.targetSessionKey || ctx.childSessionKey;
      if (!childKey) return;

      // Find which coordinator owns this obligation
      let coordinatorId = sessionToCoordinator.get(childKey);
      if (!coordinatorId) {
        // Fallback: scan all coordinators
        for (const cid of cfg.coordinatorAgentIds) {
          const list = store.load(cid);
          if (list.some((o) => o.childSessionKey === childKey)) {
            coordinatorId = cid;
            break;
          }
        }
      }
      if (!coordinatorId) return;

      const outcome = event.outcome || "ok";
      const isSuccess = outcome === "ok";
      const isTimeout = outcome === "timeout";
      const isError = outcome === "error" || outcome === "killed";

      let newStatus: ObligationStatus;
      if (isSuccess) newStatus = "ARRIVED";
      else if (isTimeout) newStatus = "TIMEOUT";
      else if (isError) newStatus = "FAILED";
      else newStatus = "ARRIVED"; // Default: treat as arrived, let coordinator judge

      const patch: Partial<Obligation> = {
        status: newStatus,
        outcome,
        error: event.error,
      };

      if (newStatus === "ARRIVED") {
        patch.resultArrivedAt = new Date().toISOString();
      } else if (newStatus === "TIMEOUT") {
        patch.timeoutAt = new Date().toISOString();
      }

      const updated = store.update(coordinatorId, childKey, patch);
      if (updated) {
        api.logger.info(
          `obligation-tracker: [${childKey}] → ${newStatus} (outcome=${outcome})`,
        );
      }

      sessionToCoordinator.delete(childKey);
    }, { priority: 10 });

    // ── Hook 3: INJECT obligations into coordinator prompt ───────────────

    api.on("before_prompt_build", (_event: any, ctx: any) => {
      if (!isCoordinator(ctx.agentId)) return;

      const coordinatorId = ctx.agentId as string;

      // Run maintenance: check timeouts + GC
      store.checkTimeouts(coordinatorId, cfg.timeoutGraceSec);
      store.gc(coordinatorId, cfg.deliveredTtlHours);

      const pending = store.pending(coordinatorId);
      if (pending.length === 0) return;

      const block = renderObligations(pending);
      if (!block) return;

      return { prependContext: block };
    }, { priority: cfg.injectPriority });

    // ── Hook 4: AUTO-RESOLVE on message delivery to Boss ─────────────────

    api.on("message_sending", (event: any, ctx: any) => {
      if (!isCoordinator(ctx.agentId)) return;
      const coordinatorId = ctx.agentId as string;

      const content = typeof event.content === "string" ? event.content : "";
      if (content.length < 20) return; // Skip short messages (acks, emojis)

      const pending = store.pending(coordinatorId);
      const arrived = pending.filter((o) => o.status === "ARRIVED");
      if (arrived.length === 0) return;

      const contentLower = content.toLowerCase();

      for (const o of arrived) {
        // Heuristic: message references the task label or target agent
        const labelWords = o.taskLabel
          .toLowerCase()
          .split(/[-_\s]+/)
          .filter((w) => w.length > 2);

        const matched =
          labelWords.some((w) => contentLower.includes(w)) ||
          contentLower.includes(o.targetAgent.toLowerCase());

        if (matched) {
          store.update(coordinatorId, o.childSessionKey, {
            status: "DELIVERED",
            deliveredAt: new Date().toISOString(),
          });
          api.logger.info(
            `obligation-tracker: [${o.taskLabel}] → DELIVERED (auto-resolved via message content)`,
          );
        }
      }
    }, { priority: 10 });

    api.logger.info("obligation-tracker: all hooks registered");
  },
};
