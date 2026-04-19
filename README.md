# Pi Extensions

Custom extensions for [pi](https://github.com/MarioZechner/pi-coding-agent), the coding agent harness.

> **Attribution:** These extensions are derived from example extensions in the [pi-mono](https://github.com/MarioZechner/pi-mono) repository:
> - **ai-permission-gate** evolved from pi-mono's `permission-gates` example — replacing regex-based pattern matching with LLM-powered classification and CWD-aware risk assessment.
> - **team** evolved from pi-mono's `subagent` example — expanding from a simple subagent spawner into a full multi-role workflow orchestrator with phase tracking, file-based mailboxes, and auto-orchestration.

## Extensions

### ai-permission-gate

Uses an LLM (spawned as a child pi process) to classify bash commands by risk level before execution. Instead of maintaining regex patterns, a fast model judges each command with CWD-aware context — project-local operations are treated as less risky than system-wide equivalents.

**Configuration (environment variables):**

| Variable | Default | Description |
|---|---|---|
| `PI_AI_PERM_GATE_MODEL` | pi's default | Model to use for classification |
| `PI_AI_PERM_GATE_BLOCK_LEVEL` | `low` | Minimum risk level to block: `low` \| `medium` \| `high` |
| `PI_AI_PERM_GATE_TIMEOUT` | `10000` | Timeout in ms for the LLM call |
| `PI_AI_PERM_GATE_FALLBACK` | `confirm` | What to do if LLM fails: `allow` \| `block` \| `confirm` |

**Install:** Symlink `ai-permission-gate.ts` into `~/.pi/agent/extensions/`.

**Test:** `node --test ai-permission-gate.test.mjs`

### team

Orchestrates multi-role development workflows across cmux panes. Each role (planner, coder, reviewer) runs as a full pi session with its own pane, model, tools, and file-based mailbox for inter-role communication.

**Commands:**

| Command | Description |
|---|---|
| `/team init <task>` | Create workflow, become orchestrator |
| `/team spawn <role> <task>` | Spawn a role in a new cmux pane |
| `/team status [task]` | Show workflow state |
| `/team send <role> <task> <msg>` | Send a message to a role's mailbox |
| `/team approve <task>` | Approve plan, advance to implementing |
| `/team reject <task> <fb>` | Reject plan, send feedback to planner |
| `/team redo <role> <task>` | Re-dispatch a role |
| `/team shutdown [task]` | Graceful shutdown of all workers |
| `/team auto` | Toggle auto-orchestration |
| `/team history [task]` | Show phase transition history |

**Workflow phases:** `planning` → `plan-review` → `implementing` → `reviewing` → `fixing` → `final-review` → `done`

**Install:** Symlink the `team/` directory into `~/.pi/agent/extensions/team/`.

#### Agent Configuration

The team extension discovers agent definitions from markdown files with YAML frontmatter. Copy the examples from `team/examples/` into `~/.pi/agent/team/` and customize them:

```bash
# Copy examples and edit with your model and preferences
cp team/examples/*.md ~/.pi/agent/team/
```

Each agent file has this frontmatter:

```yaml
---
name: planner           # Role name (planner, coder, reviewer)
description: ...        # Short description
tools: read, bash, ...  # Comma-separated tool whitelist
model: <your-model>     # Model identifier for this role
thinking: high          # Thinking level: low, medium, high
---
```

The body is the system prompt for that role. Key customization points:
- **model**: Set to your preferred LLM (can differ per role)
- **tools**: Restrict what each role can do (e.g., reviewer doesn't need `edit`/`write`)
- **thinking**: Higher for planning/review, lower for coding
- **System prompt**: Adjust responsibilities, rules, and deliverable format to your workflow

## Installation

```bash
# Clone and symlink
 git clone <repo-url> ~/projects/pi-extensions

# ai-permission-gate
ln -sf ~/projects/pi-extensions/ai-permission-gate.ts ~/.pi/agent/extensions/ai-permission-gate.ts

# team
ln -sf ~/projects/pi-extensions/team ~/.pi/agent/extensions/team

# Agent configuration for team (required)
mkdir -p ~/.pi/agent/team
cp ~/projects/pi-extensions/team/examples/*.md ~/.pi/agent/team/
# Then edit ~/.pi/agent/team/*.md to set your model and preferences
```

The symlinks ensure edits in this repo are immediately reflected in pi without copying.
