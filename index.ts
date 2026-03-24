/**
 * Obligation Tracker — automated task accountability for OpenClaw coordinators.
 *
 * Lifecycle:
 *   sessions_spawn  →  after_tool_call     →  REGISTER obligation (RUNNING)
 *   subagent done   →  subagent_ended      →  UPDATE status (ARRIVED / TIMEOUT / FAILED / CANCELLED)
 *   every turn      →  before_prompt_build  →  INJECT pending obligations into prompt
 *   coordinator msg →  message_sending     →  DETECT [DELIVER:id] / [DISMISS:id] tags
 *
 * Resolution is tag-based, not NLP-heuristic. The coordinator must include
 * explicit tags [DELIVER:obl-xxx] or [DISMISS:obl-xxx] in its message to Boss.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

interface Obligation {
  id: string;
  taskLabel: string;
  taskSummary: string;
  targetAgent: string;
  childSessionKey: string;
  runId: string;
  spawnedAt: string; // ISO
  runTimeoutSec: number;
  status: ObligationStatus;
  resultArrivedAt?: string;
  deliveredAt?: string;
  dismissedAt?: string;
  timeoutAt?: string;
  retryCount: number;
  outcome?: string; // from subagent_ended
  error?: string;
  errorDetail?: string; // extended error context
}

type ObligationStatus =
  | "RUNNING"
  | "ARRIVED"
  | "DELIVERED"
  | "DISMISSED"
  | "TIMEOUT"
  | "FAILED"
  | "CANCELLED";

interface PluginConfig {
  coordinatorAgentIds: string[];
  deliveredTtlHours: number;
  timeoutGraceSec: number;
  injectPriority: number;
}

/** Filename stored inside each coordinator's workspace */
const OBLIGATIONS_FILE = "obligations.json";

/** Tag patterns for explicit obligation resolution */
const DELIVER_TAG_RE = /\[DELIVER:(obl-[a-z0-9-]+)\]/gi;
const DISMISS_TAG_RE = /\[DISMISS:(obl-[a-z0-9-]+)\]/gi;

/**
 * Extract the logical tool result payload from the hook event.
 *
 * Gateway wraps tool results in pi-agent content blocks:
 *   { content: [{ type: "text", text: '{"status":"accepted",...}' }] }
 *
 * This helper unwraps that structure and parses the inner JSON so
 * the plugin can read fields like `result.status` and `result.childSessionKey`.
 */
function unwrapToolResult(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;

  // Direct object with .status — already unwrapped (future-proof)
  if (typeof record.status === "string") return record;

  // pi-agent content-block wrapper
  const content = Array.isArray(record.content) ? record.content : undefined;
  if (!content) return undefined;

  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      try {
        const parsed = JSON.parse((block as Record<string, unknown>).text as string);
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        // not JSON — skip
      }
    }
  }
  return undefined;
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
    .find(
      (l: string) =>
        l.length > 10 && !l.startsWith("[") && !l.startsWith("```"),
    );
  if (firstLine) return firstLine.slice(0, 120);
  // Fallback: first 120 chars
  return task.replace(/\n/g, " ").slice(0, 120) || "(no task description)";
}

/**
 * Deterministic fallback workspace path for when the in-memory cache
 * is lost (e.g. after gateway restart).
 */
function fallbackWorkspaceDir(agentId: string): string {
  return resolveHome(`~/.openclaw/workspace-${agentId}`);
}

// ── Store ──────────────────────────────────────────────────────────────────

/**
 * Workspace-local obligation store.
 *
 * Each coordinator's obligations live inside its own workspace directory
 * (e.g. ~/.openclaw/workspace-chat/obligations.json).
 * The workspace path comes from ctx.workspaceDir in hook context,
 * with a deterministic fallback for resilience across gateway restarts.
 */
class ObligationStore {
  /** agentId → resolved workspace dir */
  private workspaceDirs = new Map<string, string>();
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
  }

  registerWorkspace(agentId: string, workspaceDir: string): void {
    this.workspaceDirs.set(agentId, workspaceDir);
  }

  private filePath(agentId: string): string {
    const dir =
      this.workspaceDirs.get(agentId) ?? fallbackWorkspaceDir(agentId);
    return join(dir, OBLIGATIONS_FILE);
  }

  load(agentId: string): Obligation[] {
    const fp = this.filePath(agentId);
    if (!existsSync(fp)) return [];
    let raw: string;
    try {
      raw = readFileSync(fp, "utf-8");
    } catch {
      return [];
    }
    try {
      return JSON.parse(raw);
    } catch {
      // File is corrupted — back it up for manual recovery
      const corruptedPath = fp.replace(/\.json$/, ".corrupted.json");
      try {
        renameSync(fp, corruptedPath);
        this.logger.error(
          `obligation-tracker: ${fp} corrupted, backed up to ${corruptedPath}`,
        );
      } catch {
        this.logger.error(
          `obligation-tracker: ${fp} corrupted and backup failed`,
        );
      }
      return [];
    }
  }

  save(agentId: string, obligations: Obligation[]): void {
    const fp = this.filePath(agentId);
    const dir = dirname(fp);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Atomic write: write to .tmp then rename
    const tmpPath = fp.replace(/\.json$/, ".tmp.json");
    writeFileSync(tmpPath, JSON.stringify(obligations, null, 2), "utf-8");
    renameSync(tmpPath, fp);
  }

  add(agentId: string, obligation: Obligation): void {
    const list = this.load(agentId);
    list.push(obligation);
    this.save(agentId, list);
  }

  update(
    agentId: string,
    childSessionKey: string,
    patch: Partial<Obligation>,
  ): boolean {
    const list = this.load(agentId);
    const idx = list.findIndex((o) => o.childSessionKey === childSessionKey);
    if (idx === -1) return false;
    list[idx] = { ...list[idx], ...patch };
    this.save(agentId, list);
    return true;
  }

  updateById(
    agentId: string,
    obligationId: string,
    patch: Partial<Obligation>,
  ): boolean {
    const list = this.load(agentId);
    const idx = list.findIndex((o) => o.id === obligationId);
    if (idx === -1) return false;
    list[idx] = { ...list[idx], ...patch };
    this.save(agentId, list);
    return true;
  }

  pending(agentId: string): Obligation[] {
    return this.load(agentId).filter(
      (o) => o.status !== "DELIVERED" && o.status !== "DISMISSED",
    );
  }

  gc(agentId: string, ttlHours: number): number {
    const list = this.load(agentId);
    const cutoff = Date.now() - ttlHours * 3600_000;
    const before = list.length;
    const kept = list.filter((o) => {
      if (o.status !== "DELIVERED" && o.status !== "DISMISSED") return true;
      const closedAt = o.deliveredAt || o.dismissedAt;
      const closedMs = closedAt ? new Date(closedAt).getTime() : 0;
      return closedMs > cutoff;
    });
    if (kept.length < before) {
      this.save(agentId, kept);
    }
    return before - kept.length;
  }

  checkTimeouts(agentId: string, graceSec: number): number {
    const list = this.load(agentId);
    const now = Date.now();
    let count = 0;
    for (const o of list) {
      if (o.status !== "RUNNING") continue;
      const deadline =
        new Date(o.spawnedAt).getTime() + (o.runTimeoutSec + graceSec) * 1000;
      if (now > deadline) {
        o.status = "TIMEOUT";
        o.timeoutAt = new Date().toISOString();
        count++;
      }
    }
    if (count > 0) this.save(agentId, list);
    return count;
  }

  /** Find which coordinator owns this childSessionKey */
  findCoordinator(childSessionKey: string): string | undefined {
    for (const agentId of this.workspaceDirs.keys()) {
      if (
        this.load(agentId).some((o) => o.childSessionKey === childSessionKey)
      ) {
        return agentId;
      }
    }
    return undefined;
  }

  /** Find coordinator by scanning fallback dirs for all known coordinator IDs */
  findCoordinatorWithFallback(
    childSessionKey: string,
    coordinatorIds: string[],
  ): string | undefined {
    // First try cached dirs
    const cached = this.findCoordinator(childSessionKey);
    if (cached) return cached;
    // Fallback: check deterministic paths for all coordinators
    for (const agentId of coordinatorIds) {
      if (this.workspaceDirs.has(agentId)) continue; // already checked
      const fp = join(fallbackWorkspaceDir(agentId), OBLIGATIONS_FILE);
      if (!existsSync(fp)) continue;
      // Temporarily register so load() works
      this.registerWorkspace(agentId, fallbackWorkspaceDir(agentId));
      if (
        this.load(agentId).some((o) => o.childSessionKey === childSessionKey)
      ) {
        return agentId;
      }
    }
    return undefined;
  }
}

// ── Prompt Renderer ────────────────────────────────────────────────────────

function renderObligations(obligations: Obligation[]): string {
  if (obligations.length === 0) return "";

  const arrived = obligations.filter((o) => o.status === "ARRIVED");
  const running = obligations.filter((o) => o.status === "RUNNING");
  const failed = obligations.filter(
    (o) =>
      o.status === "TIMEOUT" ||
      o.status === "FAILED" ||
      o.status === "CANCELLED",
  );

  const lines: string[] = ["<pending-obligations>"];

  if (arrived.length > 0) {
    lines.push(
      `⚠ ${arrived.length} obligation(s) with RESULTS READY — deliver to Boss BEFORE any new work:\n`,
    );
    for (const o of arrived) {
      lines.push(
        `  → [RESULT_ARRIVED] id=${o.id} ${o.taskLabel} (${o.targetAgent}, spawned ${ago(o.spawnedAt)})`,
        `    Task: ${o.taskSummary}`,
        `    Action: Read the result and deliver a synthesis to Boss. Include [DELIVER:${o.id}] in your message.`,
        "",
      );
    }
  }

  if (running.length > 0) {
    lines.push(`${running.length} obligation(s) still RUNNING:\n`);
    for (const o of running) {
      lines.push(
        `  ⏳ [RUNNING] id=${o.id} ${o.taskLabel} (${o.targetAgent}, spawned ${ago(o.spawnedAt)}, timeout ${o.runTimeoutSec}s)`,
        `    Task: ${o.taskSummary}`,
        "",
      );
    }
  }

  if (failed.length > 0) {
    lines.push(
      `${failed.length} obligation(s) FAILED/TIMEOUT/CANCELLED — inform Boss and decide on retry:\n`,
    );
    for (const o of failed) {
      const reason = o.errorDetail || o.error || o.outcome || "unknown";
      lines.push(
        `  ✗ [${o.status}] id=${o.id} ${o.taskLabel} (${o.targetAgent}, reason: ${reason})`,
        `    Task: ${o.taskSummary}`,
        `    Action: Report to Boss and include [DISMISS:${o.id}] to acknowledge, or retry the task.`,
        "",
      );
    }
  }

  lines.push(
    "Resolution protocol:",
    "  - To mark a successful result as delivered: include [DELIVER:<obligation-id>] in your message to Boss.",
    "  - To dismiss a FAILED/TIMEOUT/CANCELLED task after reporting: include [DISMISS:<obligation-id>].",
    "  - RESULT_ARRIVED obligations MUST be resolved before starting new work.",
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
      deliveredTtlHours:
        typeof raw.deliveredTtlHours === "number"
          ? raw.deliveredTtlHours
          : 48,
      timeoutGraceSec:
        typeof raw.timeoutGraceSec === "number" ? raw.timeoutGraceSec : 60,
      injectPriority:
        typeof raw.injectPriority === "number" ? raw.injectPriority : 18,
    };

    const store = new ObligationStore(api.logger);
    const isCoordinator = (agentId?: string) =>
      agentId != null && cfg.coordinatorAgentIds.includes(agentId);

    /** Ensure workspace dir is registered from any hook context */
    const ensureWorkspace = (ctx: any) => {
      if (ctx.agentId && ctx.workspaceDir && isCoordinator(ctx.agentId)) {
        store.registerWorkspace(ctx.agentId, ctx.workspaceDir);
      }
    };

    // Map childSessionKey → coordinatorAgentId for delivery routing
    const sessionToCoordinator = new Map<string, string>();

    api.logger.info(
      `obligation-tracker: initialized (coordinators: ${cfg.coordinatorAgentIds.join(", ")}, storage: workspace-local)`,
    );

    // ── Hook 1: AUTO-REGISTER on sessions_spawn ──────────────────────────

    api.on(
      "after_tool_call",
      (event: any, ctx: any) => {
        ensureWorkspace(ctx);
        if (event.toolName !== "sessions_spawn") return;
        if (!isCoordinator(ctx.agentId)) return;

        const result = unwrapToolResult(event.result);
        if (!result || result.status !== "accepted") return;

        const params = (event.params ?? {}) as Record<string, unknown>;
        const childSessionKey = result.childSessionKey as string;
        const coordinatorId = ctx.agentId as string;

        // Avoid duplicates (re-spawn of same session)
        const existing = store.load(coordinatorId);
        if (existing.some((o) => o.childSessionKey === childSessionKey)) return;

        const obligation: Obligation = {
          id: genId(),
          taskLabel:
            (typeof params.label === "string" ? params.label : "") ||
            `${params.agentId || "subagent"}-${Date.now().toString(36)}`,
          taskSummary: extractTaskSummary(params),
          targetAgent:
            typeof params.agentId === "string" ? params.agentId : "unknown",
          childSessionKey,
          runId: (result.runId as string) || "",
          spawnedAt: new Date().toISOString(),
          runTimeoutSec:
            typeof params.runTimeoutSeconds === "number"
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
      },
      { priority: 10 },
    );

    // ── Hook 2: AUTO-UPDATE on subagent_ended ────────────────────────────

    api.on(
      "subagent_ended",
      (event: any, _ctx: any) => {
        const childKey = event.targetSessionKey || _ctx.childSessionKey;
        if (!childKey) return;

        // Find which coordinator owns this obligation (with fallback for restarts)
        let coordinatorId = sessionToCoordinator.get(childKey);
        if (!coordinatorId) {
          coordinatorId = store.findCoordinatorWithFallback(
            childKey,
            cfg.coordinatorAgentIds,
          );
        }
        if (!coordinatorId) return;

        const outcome = event.outcome || "ok";
        const isSuccess = outcome === "ok";
        const isTimeout = outcome === "timeout";
        const isKilled = outcome === "killed";
        const isError = outcome === "error";

        let newStatus: ObligationStatus;
        if (isSuccess) newStatus = "ARRIVED";
        else if (isTimeout) newStatus = "TIMEOUT";
        else if (isKilled) newStatus = "CANCELLED";
        else if (isError) newStatus = "FAILED";
        else newStatus = "ARRIVED"; // Default: treat as arrived, let coordinator judge

        // Extract extended error detail if available
        let errorDetail: string | undefined;
        if (event.error) {
          errorDetail =
            typeof event.error === "string"
              ? event.error
              : JSON.stringify(event.error);
        }
        if (event.details) {
          const details =
            typeof event.details === "string"
              ? event.details
              : JSON.stringify(event.details);
          errorDetail = errorDetail
            ? `${errorDetail} | ${details}`
            : details;
        }
        // Truncate to keep prompt injection surface small
        if (errorDetail && errorDetail.length > 500) {
          errorDetail = errorDetail.slice(-500);
        }

        // Guard: never overwrite a terminal status (DELIVERED/DISMISSED)
        // This prevents a late subagent_ended from clobbering an already-resolved obligation
        const existing = store.load(coordinatorId);
        const current = existing.find((o) => o.childSessionKey === childKey);
        if (
          current &&
          (current.status === "DELIVERED" || current.status === "DISMISSED")
        ) {
          api.logger.info(
            `obligation-tracker: [${childKey}] subagent_ended (outcome=${outcome}) ignored — already ${current.status}`,
          );
          sessionToCoordinator.delete(childKey);
          return;
        }

        const patch: Partial<Obligation> = {
          status: newStatus,
          outcome,
          error: event.error,
          errorDetail,
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
      },
      { priority: 10 },
    );

    // ── Hook 3: INJECT obligations into coordinator prompt ───────────────

    api.on(
      "before_prompt_build",
      (_event: any, ctx: any) => {
        ensureWorkspace(ctx);
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
      },
      { priority: cfg.injectPriority },
    );

    // ── Hook 4: TAG-BASED RESOLUTION on message to Boss ──────────────────
    //
    // Note: message_sending hook context provides channelId/accountId but
    // NOT agentId (PluginHookMessageContext). We scan tags against ALL
    // coordinator stores to find matching obligation IDs.

    api.on(
      "message_sending",
      (event: any, _ctx: any) => {
        const content =
          typeof event.content === "string" ? event.content : "";
        if (content.length < 10) return;

        // Collect all obligation IDs mentioned in tags
        const deliverIds: string[] = [];
        const dismissIds: string[] = [];

        let match: RegExpExecArray | null;
        DELIVER_TAG_RE.lastIndex = 0;
        while ((match = DELIVER_TAG_RE.exec(content)) !== null) {
          deliverIds.push(match[1]);
        }
        DISMISS_TAG_RE.lastIndex = 0;
        while ((match = DISMISS_TAG_RE.exec(content)) !== null) {
          dismissIds.push(match[1]);
        }

        if (deliverIds.length === 0 && dismissIds.length === 0) return;

        // Try each coordinator store for matching obligation IDs
        for (const coordinatorId of cfg.coordinatorAgentIds) {
          for (const oblId of deliverIds) {
            const updated = store.updateById(coordinatorId, oblId, {
              status: "DELIVERED",
              deliveredAt: new Date().toISOString(),
            });
            if (updated) {
              api.logger.info(
                `obligation-tracker: [${oblId}] → DELIVERED (explicit tag)`,
              );
            }
          }

          for (const oblId of dismissIds) {
            const updated = store.updateById(coordinatorId, oblId, {
              status: "DISMISSED",
              dismissedAt: new Date().toISOString(),
            });
            if (updated) {
              api.logger.info(
                `obligation-tracker: [${oblId}] → DISMISSED (explicit tag)`,
              );
            }
          }
        }
      },
      { priority: 10 },
    );

    api.logger.info("obligation-tracker: all hooks registered");
  },
};
