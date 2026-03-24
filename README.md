# Obligation Tracker

OpenClaw plugin that enforces task accountability for coordinator agents. Tracks spawned subagent obligations at the gateway level — no LLM compliance required.

## Problem

Coordinator agents (like Hubo) delegate work to subagents via `sessions_spawn` and promise results to the user. But LLMs are stateless — they can forget promises, miss subagent completions, or fail to deliver results. Prompt instructions ("always update ACTIVE_TASKS.md") are suggestions, not guarantees.

## Solution

Four gateway hooks create a closed accountability loop:

```
sessions_spawn  →  after_tool_call   →  AUTO-REGISTER (status: RUNNING)
subagent done   →  subagent_ended    →  AUTO-UPDATE   (status: ARRIVED/TIMEOUT/FAILED)
every turn      →  before_prompt_build →  INJECT        pending obligations into prompt
message to user →  message_sending   →  AUTO-RESOLVE  (status: DELIVERED)
```

**No step depends on LLM compliance.** The gateway enforces all four.

### What the coordinator sees

Every turn, the plugin injects a `<pending-obligations>` block into the coordinator's prompt:

```xml
<pending-obligations>
⚠ 1 obligation(s) with RESULTS READY — deliver to Boss BEFORE any new work:

  → [RESULT_ARRIVED] research-russian-stories (researcher, spawned 8min ago)
    Task: Find scholarly sources on Russian short story literature...
    Action: Read the result and deliver a synthesis to Boss NOW.

1 obligation(s) still RUNNING:

  ⏳ [RUNNING] fix-nginx-config (artie, spawned 3min ago, timeout 600s)
    Task: Fix nginx proxy configuration for API endpoint...

Rule: RESULT_ARRIVED obligations MUST be resolved before starting new work.
Rule: TIMEOUT/FAILED obligations MUST be reported to Boss (retry or explain).
</pending-obligations>
```

The LLM cannot opt out — this is part of the prompt, injected by the gateway.

## Install

```bash
# Clone into extensions
git clone https://github.com/nbakulev/obligation-tracker.git \
  ~/.openclaw/extensions/obligation-tracker

# Register in openclaw.json
```

Add to `openclaw.json`:

```json
{
  "plugins": {
    "load": { "paths": ["extensions/obligation-tracker"] },
    "allow": ["obligation-tracker"],
    "entries": {
      "obligation-tracker": {
        "enabled": true,
        "config": {
          "coordinatorAgentIds": ["chat"]
        }
      }
    }
  }
}
```

Then restart:

```bash
openclaw gateway restart
```

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `coordinatorAgentIds` | string[] | `["chat"]` | Agent IDs to track obligations for |
| `storagePath` | string | `~/.openclaw/obligations` | Directory for obligation state files |
| `deliveredTtlHours` | number | `48` | Hours to keep delivered obligations before cleanup |
| `timeoutGraceSec` | number | `60` | Grace period after `runTimeout` before marking TIMEOUT |
| `injectPriority` | number | `18` | Priority for `before_prompt_build` hook |

## Obligation Lifecycle

```
RUNNING → ARRIVED → DELIVERED → (cleanup after TTL)
    ↓
TIMEOUT / FAILED → (retry resets to RUNNING)
```

| Status | Trigger | Auto? |
|--------|---------|-------|
| `RUNNING` | `sessions_spawn` accepted | Yes — `after_tool_call` |
| `ARRIVED` | Subagent completes successfully | Yes — `subagent_ended` |
| `TIMEOUT` | Subagent exceeds `runTimeout + grace` | Yes — `before_prompt_build` maintenance |
| `FAILED` | Subagent ends with error/killed | Yes — `subagent_ended` |
| `DELIVERED` | Coordinator sends message referencing the task | Yes — `message_sending` heuristic |

### Retry detection

When a coordinator re-spawns with the same `label` after a TIMEOUT/FAILED, the plugin:
- Increments `retryCount`
- Replaces the old failed entry (no duplicates)
- Resets status to `RUNNING`

### Auto-resolve heuristic

When the coordinator sends a message, the plugin checks if the content references any `ARRIVED` obligation by matching task label keywords or target agent name. If matched, the obligation is marked `DELIVERED`.

## Storage

Obligations are stored as JSON files per coordinator:

```
~/.openclaw/obligations/
  chat.json       # Hubo's obligations
  editor.json     # Editor's obligations (if configured)
```

Files survive gateway restarts. On startup, `RUNNING` obligations past their timeout are automatically marked `TIMEOUT`.

## License

MIT
