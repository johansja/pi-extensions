/**
 * Team Extension — Dynamic LLM-orchestrated multi-agent workflows
 *
 * Compose a team from any agents discovered via .md files. The orchestrator
 * (the main pi session) uses LLM reasoning to decide which agent to dispatch
 * next and when to re-dispatch.
 *
 * All worker communication routes through the orchestrator — workers never
 * talk to each other directly.
 *
 * Commands:
 *   /team init <name> [<agent>...]   — Create team, become orchestrator (omitting agents loads all)
 *   /team status [name]              — Show workflow state
 *   /team redo <name> <agent> [msg]  — Re-dispatch an agent (manual override)
 *   /team shutdown [name]            — Graceful shutdown of all workers
 *   /team resume [name]              — Resume an interrupted team session
 *   /team complete [name]            — Mark team as completed and clean up
 *   /team list                       — List available agents
 *   /team history [name]             — Show dispatch history
 *   /team cleanup                    — Remove shutdown/completed/orphaned teams
 *
 * Tools (registered for LLM use):
 *   team_orchestrate  — Dispatch an agent (orchestrator only)
 *   team_report       — Report work completion back to orchestrator (worker only)
 *   team_message      — Send challenge/notify/ack to orchestrator (worker) or agent (orchestrator)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { discoverAgents, type AgentConfig } from "./agents.js";
import { Text } from "@mariozechner/pi-tui";

const execFileAsync = promisify(execFile);

// ─── Module-level state ───────────────────────────────────────────────────

const activeWatchers: fs.FSWatcher[] = [];

// ─── Types & Constants ───────────────────────────────────────────────────────



interface AgentRosterEntry {
	name: string;
	description: string;
	source: "user" | "project";
	model?: string;
	tools?: string[];
	thinking?: string;
	filePath: string;
}

interface DispatchEntry {
	agent: string;
	instructions: string;
	timestamp: number;
	result?: string;
	questions?: string[];
}

interface TeamState {
	task: string;
	role: "orchestrator";
	status: "active" | "shutdown" | "completed";
	agents: AgentRosterEntry[];
	agentStatus: Record<string, "idle" | "working">;
	orchestratorPaneId: string | null;
	surfaceIds: Record<string, string>;
	dispatchHistory: DispatchEntry[];
	pendingResumeContext?: string;
	pendingTeamResume?: number; // timestamp (Date.now()) — auto-expires after 5 minutes
}

interface WorkerState {
	task: string;
	role: string;
}

interface TeamMessage {
	type: "dispatch" | "challenge" | "done" | "notify" | "ack" | "shutdown";
	from: string;
	to: string;
	body?: string;          // challenge/notify/ack/shutdown message content
	instructions?: string;  // dispatch instructions
	summary?: string;       // done report summary
	questions?: string[];   // done report questions
	timestamp: number;
}

// ─── File path helpers ───────────────────────────────────────────────────────

function workflowDir(cwd: string, task: string): string {
	return path.join(cwd, ".pi", "workflow", task);
}

function statePath(cwd: string, task: string): string {
	return path.join(workflowDir(cwd, task), "state.json");
}

function mailboxDir(cwd: string, task: string): string {
	return path.join(workflowDir(cwd, task), "mailbox");
}

function mailboxPath(cwd: string, task: string, agent: string): string {
	return path.join(mailboxDir(cwd, task), `${agent}.json`);
}

// ─── Session meta helpers ─────────────────────────────────────────────────

function agentSessionDir(cwd: string, task: string): string {
	return path.join(workflowDir(cwd, task), "sessions");
}

function agentSessionMetaPath(cwd: string, task: string, agentName: string): string {
	return path.join(agentSessionDir(cwd, task), `${agentName}.json`);
}

function saveAgentSessionMeta(cwd: string, task: string, agentName: string, sessionFile: string): void {
	const dir = agentSessionDir(cwd, task);
	fs.mkdirSync(dir, { recursive: true });
	const metaPath = agentSessionMetaPath(cwd, task, agentName);
	fs.writeFileSync(metaPath, JSON.stringify({ sessionFile }), { encoding: "utf-8" });
}

function loadAgentSessionMeta(cwd: string, task: string, agentName: string): string | null {
	try {
		const metaPath = agentSessionMetaPath(cwd, task, agentName);
		const content = fs.readFileSync(metaPath, "utf-8").trim();
		if (!content) return null;
		const meta = JSON.parse(content) as { sessionFile: string };
		if (meta.sessionFile && fs.existsSync(meta.sessionFile)) {
			return meta.sessionFile;
		}
		return null;
	} catch {
		return null;
	}
}

// ─── State persistence ───────────────────────────────────────────────────────

function saveState(cwd: string, state: TeamState): void {
	const sp = statePath(cwd, state.task);
	fs.writeFileSync(sp, JSON.stringify(state, null, 2), { encoding: "utf-8" });
}

function loadState(cwd: string, task: string): TeamState | null {
	const sp = statePath(cwd, task);
	try {
		const content = fs.readFileSync(sp, "utf-8").trim();
		if (!content) return null;
		const state = JSON.parse(content) as TeamState;
		// Backward compat: state files created before orchestratorPaneId was added
		if (state.orchestratorPaneId === undefined) {
			(state as any).orchestratorPaneId = null;
		}
		// Backward compat: state files created before status was added
		if (state.status === undefined) {
			(state as any).status = "active";
		}
		return state;
	} catch {
		return null;
	}
}

function saveSessionState(pi: ExtensionAPI, state: TeamState): void {
	pi.appendEntry("team-orchestrator", { task: state.task });
}

function loadSessionTask(ctx: ExtensionContext): string | null {
	const entries = ctx.sessionManager.getEntries();
	// Iterate from newest to oldest, returning the first task whose state file exists.
	// This avoids stale entries from old sessions that no longer have a workflow.
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type: string; customType?: string; data?: { task: string } };
		if (e.type === "custom" && e.customType === "team-orchestrator" && e.data?.task) {
			if (fs.existsSync(statePath(ctx.cwd, e.data.task))) {
				return e.data.task;
			}
		}
	}
	return null;
}

function saveWorkerState(pi: ExtensionAPI, state: WorkerState): void {
	pi.appendEntry("team-worker", state);
}

function loadWorkerState(ctx: ExtensionContext): WorkerState | null {
	const entries = ctx.sessionManager.getEntries();
	const entry = entries
		.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "team-worker")
		.pop() as { data?: WorkerState } | undefined;
	return entry?.data ?? null;
}

function agentConfigToRosterEntry(agent: AgentConfig): AgentRosterEntry {
	return {
		name: agent.name,
		description: agent.description,
		source: agent.source,
		model: agent.model,
		tools: agent.tools,
		thinking: agent.thinking,
		filePath: agent.filePath,
	};
}

// ─── Mailbox helpers ─────────────────────────────────────────────────────────

function readMailbox(filePath: string): TeamMessage[] {
	try {
		const content = fs.readFileSync(filePath, "utf-8").trim();
		if (!content) return [];
		return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function appendToMailbox(filePath: string, message: TeamMessage): void {
	const line = JSON.stringify(message) + "\n";
	fs.appendFileSync(filePath, line, { encoding: "utf-8" });
}

function clearMailbox(filePath: string): void {
	// Truncate in place — do NOT rename/replace the file.
	// fs.watch() on macOS watches the inode; renaming a new file over
	// the original replaces the inode and silently breaks the watcher,
	// causing all subsequent mailbox messages to be missed.
	fs.writeFileSync(filePath, "", { encoding: "utf-8" });
}

// ─── cmux CLI helpers ────────────────────────────────────────────────────────

async function cmuxExec(...args: string[]): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execFileAsync("cmux", args, { timeout: 10000 });
	} catch (err: any) {
		throw new Error(`cmux ${args.join(" ")} failed: ${err.message}`);
	}
}

async function cmuxNewSurface(paneId: string): Promise<string | null> {
	try {
		const { stdout } = await cmuxExec("new-surface", "--pane", paneId);
		const match = stdout.match(/surface:(\d+)/i);
		return match ? `surface:${match[1]}` : null;
	} catch {
		return null;
	}
}

async function cmuxGetPaneId(): Promise<string | null> {
	try {
		const { stdout } = await cmuxExec("identify");
		const match = stdout.match(/pane:(\d+)/i);
		return match ? `pane:${match[1]}` : null;
	} catch {
		return null;
	}
}

async function cmuxSendToSurface(surfaceId: string, text: string): Promise<void> {
	try {
		await cmuxExec("send", "--surface", surfaceId, text);
	} catch (err: any) {
		throw new Error(`cmux send failed: ${err.message}`);
	}
}

async function cmuxCloseSurface(surfaceId: string): Promise<void> {
	try {
		await cmuxExec("close-surface", "--surface", surfaceId);
	} catch {
		// Best effort
	}
}

async function cmuxRenameTab(surfaceId: string | undefined, title: string): Promise<void> {
	try {
		const sid = surfaceId ?? process.env.CMUX_SURFACE_ID;
		if (!sid) return;
		await cmuxExec("rename-tab", "--surface", sid, title);
	} catch {
		// Best effort
	}
}

async function cmuxSurfaceExists(surfaceId: string): Promise<boolean> {
	try {
		const { stdout } = await cmuxExec("identify", "--surface", surfaceId);
		return stdout.includes(surfaceId);
	} catch {
		return false;
	}
}

async function cmuxNotify(title: string, body: string): Promise<void> {
	try {
		await cmuxExec("notify", "--title", title, "--body", body);
	} catch {
		// Best effort
	}
}

async function cmuxLog(level: string, message: string): Promise<void> {
	try {
		await cmuxExec("log", "--level", level, "--source", "team", "--", message);
	} catch {
		// cmux not available
	}
}

// ─── Notification helper ─────────────────────────────────────────────────────

function terminalNotify(title: string, body: string): void {
	if (process.env.KITTY_WINDOW_ID) {
		process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
		process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
	} else {
		process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
	}
}

// ─── Team resumption helpers ──────────────────────────────────────────────────

interface AvailableTeam {
	task: string;
	status: "active" | "shutdown" | "completed";
	agentCount: number;
	lastActivity: number;
	hasWorkingAgents: boolean;
}

function listAvailableTeams(cwd: string): AvailableTeam[] {
	const workflowRoot = path.join(cwd, ".pi", "workflow");
	const teams: AvailableTeam[] = [];

	try {
		if (!fs.existsSync(workflowRoot)) return teams;

		const entries = fs.readdirSync(workflowRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const sp = path.join(workflowRoot, entry.name, "state.json");
			try {
				const content = fs.readFileSync(sp, "utf-8").trim();
				if (!content) continue;
				const state = JSON.parse(content) as TeamState;
				const hasWorkingAgents = Object.values(state.agentStatus ?? {}).some(s => s === "working");
				let lastActivity = 0;
				for (const d of (state.dispatchHistory ?? [])) {
					if (d.timestamp > lastActivity) lastActivity = d.timestamp;
				}
				// Fallback to file mtime for new teams with no dispatches
				if (lastActivity === 0) {
					try { lastActivity = fs.statSync(sp).mtimeMs; } catch { /* ignore */ }
				}
				teams.push({
					task: state.task ?? entry.name,
					status: state.status ?? "active",
					agentCount: (state.agents ?? []).length,
					lastActivity,
					hasWorkingAgents,
				});
			} catch {
				// Invalid state file, skip
			}
		}
	} catch {
		// workflow dir not readable
	}

	// Sort by last activity descending (most recent first)
	teams.sort((a, b) => b.lastActivity - a.lastActivity);
	return teams;
}

function buildResumeContext(state: TeamState): string {
	const lines: string[] = [];

	lines.push("🔄 **Session Resumed — Team \"" + state.task + "\"**");
	lines.push("");

	lines.push("**Do NOT re-dispatch agents whose work was already completed (result is not '[Session interrupted]').**");
	lines.push("");

	// Completed work
	const completedDispatches = state.dispatchHistory.filter(d => d.result && d.result !== "[Session interrupted]" && d.result !== "[Team completed]");
	const interruptedDispatches = state.dispatchHistory.filter(d => d.result === "[Session interrupted]");

	if (completedDispatches.length > 0) {
		lines.push("**Completed work (these agents already have results — do not re-dispatch them for the same task):**");
		for (const d of completedDispatches) {
			lines.push(`  ✅ ${d.agent}: ${(d.result ?? "").substring(0, 120)}${(d.result ?? "").length > 120 ? "..." : ""}`);
		}
		lines.push("");
	}

	if (interruptedDispatches.length > 0) {
		lines.push("**Interrupted tasks (these agents were working when the session ended and their work was not completed):**");
		for (const d of interruptedDispatches) {
			lines.push(`  ⚠️ ${d.agent}: ${(d.instructions ?? "").substring(0, 120)}${(d.instructions ?? "").length > 120 ? "..." : ""}`);
		}
		lines.push("");
	}

	// Agent roster
	lines.push("**Agents:**");
	for (const agent of state.agents) {
		const status = state.agentStatus[agent.name] ?? "idle";
		const icon = statusIcon(status);
		lines.push(`  ${icon} ${agent.name} (${status}) — ${agent.description}`);
	}
	lines.push("");

	// Status summary
	if (completedDispatches.length > 0 && interruptedDispatches.length === 0) {
		lines.push("All previously dispatched work has been completed. No re-dispatch is necessary.");
	} else if (interruptedDispatches.length > 0) {
		lines.push("The interrupted agents have been marked idle. Their previous tasks were not completed.");
	} else {
		lines.push("Use the `team_orchestrate` tool to dispatch an agent.");
	}

	return lines.join("\n");
}

async function resumeTeam(pi: ExtensionAPI, ctx: ExtensionContext, taskName: string): Promise<TeamState | null> {
	const state = loadState(ctx.cwd, taskName);
	if (!state) {
		ctx.ui.notify(`No workflow state found for "${taskName}"`, "error");
		return null;
	}

	if (state.status === "completed") {
		ctx.ui.notify(`Team "${taskName}" is already completed. Use /team init to start a new team.`, "warning");
		return null;
	}

	// Guard for empty/undefined agents
	if (!state.agents || state.agents.length === 0) {
		ctx.ui.notify(`Team "${taskName}" has no agents. Use /team init to create a new team.`, "warning");
		return null;
	}

	// Clean up stale watchers before setting up new ones
	for (const watcher of activeWatchers) {
		try { watcher.close(); } catch { /* best effort */ }
	}
	activeWatchers.length = 0;

	// Repair stale state
	// 1. Mark all agents idle
	for (const agent of state.agents) {
		state.agentStatus[agent.name] = "idle";
	}

	// 2. Add synthetic "[Session interrupted]" results for mid-task dispatches
	for (const entry of state.dispatchHistory) {
		if (!entry.result) {
			entry.result = "[Session interrupted]";
		}
	}

	// 3. Clear surfaceIds (surfaces are stale after session end)
	state.surfaceIds = {};

	// 4. Clear orchestratorPaneId (stale after session end)
	state.orchestratorPaneId = null;

	// 5. Mark as active
	state.status = "active";

	// Save repaired state
	saveState(ctx.cwd, state);

	// Save session state
	saveSessionState(pi, state);

	// Clear stale mailbox messages before re-spawning agents
	for (const agent of state.agents) {
		const mp = mailboxPath(ctx.cwd, taskName, agent.name);
		try {
			clearMailbox(mp);
		} catch {
			// Best effort — missing/inaccessible mailbox is not fatal
		}
	}

	// Salvage completed results from orchestrator mailbox BEFORE clearing it
	const orchMp = mailboxPath(ctx.cwd, taskName, "orchestrator");
	try {
		const orchMessages = readMailbox(orchMp);
		for (const msg of orchMessages) {
			if (msg.type === "done" && msg.summary) {
				for (let i = state.dispatchHistory.length - 1; i >= 0; i--) {
					const entry = state.dispatchHistory[i];
					if (entry.agent === msg.from && (!entry.result || entry.result === "[Session interrupted]")) {
						entry.result = msg.summary;
						if (msg.questions && msg.questions.length > 0) {
							entry.questions = msg.questions;
						}
						break;
					}
				}
			}
		}
		saveState(ctx.cwd, state);
	} catch { /* best effort */ }

	// Clear orchestrator's stale mailbox before setting up watcher
	try { clearMailbox(orchMp); } catch { /* best effort */ }

	// Set up mailbox watching
	setupMailboxWatching(pi, ctx, taskName, "orchestrator");

	// Re-resolve orchestrator pane ID
	state.orchestratorPaneId = await cmuxGetPaneId();

	// Re-spawn all agent tabs
	for (const agent of state.agents) {
		const sessionFile = loadAgentSessionMeta(ctx.cwd, taskName, agent.name);
		const { surfaceId } = await spawnAgent(
			pi, ctx, agent, taskName,
			state.orchestratorPaneId,
			async () => {
				state.orchestratorPaneId = await cmuxGetPaneId();
				return state.orchestratorPaneId;
			},
			sessionFile ?? undefined,
		);

		if (surfaceId) {
			state.surfaceIds[agent.name] = surfaceId;
		}
	}

	// Save state with new surface IDs
	saveState(ctx.cwd, state);

	// Set session name and update widget
	const orchLabel = `🔷 orchestrator: ${taskName}`;
	pi.setSessionName(orchLabel);
	await cmuxRenameTab(undefined, orchLabel);

	updateTeamWidget(ctx, state);

	// Store resume context as system-level info (not a user message) to avoid re-execution
	const resumeContext = buildResumeContext(state);
	state.pendingResumeContext = resumeContext;
	saveState(ctx.cwd, state);

	ctx.ui.notify(`Team "${taskName}" resumed. ${state.agents.length} agents re-spawned.`, "info");
	await cmuxLog("info", `Team "${taskName}" resumed with ${state.agents.length} agents`);

	return state;
}

// ─── Orchestrator context builder ────────────────────────────────────────────

function statusIcon(status: string): string {
	switch (status) {
		case "working": return "🟡";
		case "idle": return "🔵";
		default: return "⚪";
	}
}

function updateTeamWidget(ctx: ExtensionContext, state: TeamState): void {
	const lines: string[] = [];
	lines.push(`🔷 Team: ${state.task} (${state.status ?? "active"})`);
	lines.push("");

	for (const agent of state.agents) {
		const status = state.agentStatus[agent.name] ?? "idle";
		const icon = statusIcon(status);
		lines.push(`   ${icon} ${agent.name} (${status})`);
	}

	lines.push("");

	ctx.ui.setWidget("team-dashboard", (tui, theme) => {
		return new Text(lines.map(l => theme.fg("muted", l)).join("\n"), 0, 0);
	});
}

/**
 * Infer an agent's role category from its name and description.
 * Returns a set of role tags like "planning", "review", "implementation", "research".
 */
function inferAgentRoles(name: string, description: string): Set<string> {
	const roles = new Set<string>();
	const text = `${name} ${description}`.toLowerCase();

	// Planning keywords
	if (/\b(planner|planning|plan|architect|strategy|strategist|design|lead)\b/.test(text)) {
		roles.add("planning");
	}
	// Review keywords
	if (/\b(reviewer|review|audit|inspect|quality|qa|critic|checker)\b/.test(text)) {
		roles.add("review");
	}
	// Implementation keywords
	if (/\b(worker|implement|build|code|develop|execute|doer|coder|engineer)\b/.test(text)) {
		roles.add("implementation");
	}
	// Research keywords
	if (/\b(researcher|research|investigate|explore|analyze|analysis)\b/.test(text)) {
		roles.add("research");
	}
	// Testing keywords
	if (/\b(tester|testing|test|qa|verify|validation)\b/.test(text)) {
		roles.add("testing");
	}

	return roles;
}

/**
 * Build delegation constraints based on available agent roles.
 * Returns lines that tell the orchestrator what NOT to do itself.
 */
function buildDelegationRules(agents: AgentRosterEntry[]): string[] {
	const roleToAgents = new Map<string, string[]>();

	for (const agent of agents) {
		const roles = inferAgentRoles(agent.name, agent.description);
		for (const role of roles) {
			if (!roleToAgents.has(role)) roleToAgents.set(role, []);
			roleToAgents.get(role)!.push(agent.name);
		}
	}

	if (roleToAgents.size === 0) return [];

	const rules: string[] = [];
	rules.push("**Delegation Rules — You must NOT do these yourself, delegate them:**");

	const roleDescriptions: Record<string, string> = {
		planning: "Do NOT plan, architect, or design solutions — dispatch the planner",
		review: "Do NOT review code, audit quality, or check correctness — dispatch the reviewer",
		implementation: "Do NOT implement, code, or make changes — dispatch the worker",
		research: "Do NOT research or investigate the codebase — dispatch the researcher",
		testing: "Do NOT write or run tests — dispatch the tester",
	};

	for (const [role, agentNames] of roleToAgents) {
		const desc = roleDescriptions[role];
		if (desc) {
			rules.push(`  - ${desc} (${agentNames.join(", ")})`);
		}
	}

	rules.push("");
	rules.push("Your ONLY job is to: (1) understand the task, (2) decide which agent to dispatch next, (3) pass relevant context. Never do the work yourself when a capable agent exists.");

	return rules;
}

function buildOrchestratorContext(state: TeamState, extraInfo?: string): string {
	const lines: string[] = [];

	lines.push(`📋 **Team Orchestration — ${state.task}**`);
	lines.push("");

	// Agent roster
	lines.push("**Agents:**");
	for (const agent of state.agents) {
		const status = state.agentStatus[agent.name] ?? "idle";
		const icon = statusIcon(status);
		lines.push(`  ${icon} ${agent.name} (${status}) — ${agent.description}`);
	}
	lines.push("");

	// Delegation rules
	const delegationRules = buildDelegationRules(state.agents);
	if (delegationRules.length > 0) {
		lines.push(...delegationRules);
		lines.push("");
	}

	// Completed work summary
	lines.push("### Completed Work");
	const agentsWithResults = new Map<string, string[]>();
	for (const entry of state.dispatchHistory) {
		if (entry.result && entry.result !== "[Session interrupted]" && entry.result !== "[Team completed]") {
			if (!agentsWithResults.has(entry.agent)) agentsWithResults.set(entry.agent, []);
			agentsWithResults.get(entry.agent)!.push(entry.result);
		}
	}
	if (agentsWithResults.size > 0) {
		for (const [agentName, results] of agentsWithResults) {
			const summary = results.map((r, i) => `#${i + 1}: ${r.substring(0, 100)}${r.length > 100 ? "..." : ""}`).join("; ");
			lines.push(`- ${agentName}: ${summary}`);
		}
	} else {
		lines.push("- No completed work yet");
	}
	lines.push("");

	// Extra info (e.g., challenge details)
	if (extraInfo) {
		lines.push(extraInfo);
		lines.push("");
	}

	lines.push("Use the `team_orchestrate` tool to dispatch an agent.");

	return lines.join("\n");
}


// ─── Agent spawn ─────────────────────────────────────────────────────────────

async function spawnAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agent: AgentRosterEntry,
	task: string,
	paneId?: string | null,
	resolvePaneId?: () => Promise<string | null>,
	sessionFile?: string,
): Promise<{ surfaceId: string | null }> {
	// Generate context temp file
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-team-"));
	const contextFile = path.join(tmpDir, `context-${agent.name}.md`);
	const contextContent = [
		`# Team Working Protocol — ${agent.name}`,
		``,
		`You are the **${agent.name}** agent for task **${task}**.`,
		``,
		`## Workflow Resources`,
		``,
		`- Workflow directory: \`.pi/workflow/${task}/\``,
		`- Your mailbox: \`.pi/workflow/${task}/mailbox/${agent.name}.json\``,
		``,
		`## Communication Protocol`,
		``,
		`All communication routes through the orchestrator — you never talk directly to other agents.`,
		``,
		`- **Reporting completion**: Call \`team_report\` with a clear summary of what you accomplished. Include questions in the \`questions\` parameter if you need clarification or decisions from the orchestrator.`,
		`- **Challenging instructions**: Use \`team_message\` with type \`challenge\` if you think instructions are unreasonable, can be simplified, or improved. Address to "orchestrator".`,
		`- **Notifications**: Use \`team_message\` with type \`notify\` for informational updates the orchestrator should know about.`,
		`- **Acknowledgments**: Use \`team_message\` with type \`ack\` to acknowledge receipt of a message.`,
		``,
		`## Handoff Protocol`,
		``,
		`1. **Wait for dispatch** — Do not start work yet. The task instructions will arrive as a dispatch message from the orchestrator.`,
		`2. **Do your work** — Execute your responsibilities as defined by your role.`,
		`3. **Report completion** — Call \`team_report\` with a summary. Include questions if needed.`,
		`4. **Wait** — After reporting, wait for further instructions from the orchestrator.`,
	].join("\n");
	await fs.promises.writeFile(contextFile, contextContent, { encoding: "utf-8", mode: 0o600 });

	// Build the pi command
	const args: string[] = [];
	if (sessionFile) args.push("--session", sessionFile);
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0 && !agent.tools.includes("all")) {
		args.push("--tools", agent.tools.join(","));
	}
	if (agent.thinking) args.push("--thinking", agent.thinking);
	args.push("--append-system-prompt", agent.filePath);
	args.push("--append-system-prompt", contextFile);

	// Set env vars for team identity
	const envPrefix = `PI_TEAM_TASK=${task} PI_TEAM_ROLE=${agent.name}`;

	// Try cmux new-surface (tab within the orchestrator's pane)
	// If the pane ID is stale (pane was recreated), retry once with a fresh ID
	let surfaceId: string | null = null;
	if (paneId) {
		surfaceId = await cmuxNewSurface(paneId);
		if (!surfaceId && resolvePaneId) {
			const freshPaneId = await resolvePaneId();
			if (freshPaneId) {
				surfaceId = await cmuxNewSurface(freshPaneId);
			}
		}
	}

	if (surfaceId) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const command = `${envPrefix} pi ${args.join(" ")}\n`;
		await cmuxSendToSurface(surfaceId, command);

		// Rename tab
		const tabTitle = `⚪ ${agent.name}: ${task}`;
		await cmuxRenameTab(surfaceId, tabTitle);
	} else {
		// No cmux — print manual command
		const command = `${envPrefix} pi ${args.join(" ")}`;
		ctx.ui.notify(`cmux not available. Run manually:\n${command}`, "info");
	}

	return { surfaceId };
}

// ─── Mailbox watching ────────────────────────────────────────────────────────

function processOrchestratorMailbox(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	messages: TeamMessage[],
): void {
	const state = loadState(ctx.cwd, task);
	if (!state) return;

	// Process each message and build combined context
	const parts: string[] = [];
	let hasActionableMessage = false;

	for (const msg of messages) {
		if (msg.type === "done") {
			hasActionableMessage = true;
			// Update dispatch history with result and questions
			for (let i = state.dispatchHistory.length - 1; i >= 0; i--) {
				if (state.dispatchHistory[i].agent === msg.from && !state.dispatchHistory[i].result) {
					state.dispatchHistory[i].result = msg.summary ?? "";
					if (msg.questions && msg.questions.length > 0) {
						state.dispatchHistory[i].questions = msg.questions;
					}
					break;
				}
			}
			// Update agent status back to idle
			state.agentStatus[msg.from] = "idle";
			saveState(ctx.cwd, state);

			parts.push(`**Agent "${msg.from}" completed:** ${msg.summary ?? "No summary provided"}`);
			if (msg.questions && msg.questions.length > 0) {
				parts.push(`**Questions from ${msg.from}:**`);
				for (const q of msg.questions) {
					parts.push(`  - ${q}`);
				}
			}
		} else if (msg.type === "challenge") {
			hasActionableMessage = true;
			parts.push(`**⚠️ Challenge from "${msg.from}":** ${msg.body ?? ""}`);
		} else if (msg.type === "notify") {
			// Notifies don't always need to trigger a turn, but include them
			parts.push(`**📢 ${msg.from} notifies:** ${msg.body ?? ""}`);
			hasActionableMessage = true; // Still trigger so orchestrator is aware
		} else if (msg.type === "ack") {
			parts.push(`**✅ ${msg.from} acknowledged:** ${msg.body ?? ""}`);
		}
	}

	if (hasActionableMessage) {
		updateTeamWidget(ctx, state);

		// Send a user message to trigger the orchestrator's next turn
		let reason = "Agent update";
		if (messages.some(m => m.type === "done") && messages.some(m => m.type === "challenge")) {
			reason = "Agent reported completion and raised a challenge";
		} else if (messages.some(m => m.type === "done")) {
			reason = "Agent reported completion";
		} else if (messages.some(m => m.type === "challenge")) {
			reason = "Agent raised a challenge";
		} else if (messages.some(m => m.type === "notify")) {
			reason = "Agent sent a notification";
		}
		const fullMessage = parts.length > 0
			? `🔄 Team update: ${reason}\n\n${parts.join("\n\n")}`
			: `🔄 Team update: ${reason}`;
		pi.sendUserMessage(fullMessage, { deliverAs: "followUp" });
	}
}

function processWorkerMailbox(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	role: string,
	messages: TeamMessage[],
): void {
	for (const msg of messages) {
		if (msg.type === "dispatch") {
			pi.sendUserMessage(msg.instructions ?? msg.body ?? "New task from orchestrator", { deliverAs: "followUp" });
		} else if (msg.type === "shutdown") {
			ctx.ui.notify("🛑 Shutdown requested by orchestrator. Wrapping up.", "info");
		} else if (msg.type === "notify") {
			ctx.ui.notify(`📢 ${msg.from}: ${msg.body}`, "info");
		} else if (msg.type === "ack") {
			pi.sendUserMessage(`✅ ${msg.from} acknowledged: ${msg.body}`, { deliverAs: "followUp" });
		}
	}
}

function setupMailboxWatching(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	role: string,
): void {
	const mp = mailboxPath(ctx.cwd, task, role);

	// Ensure mailbox file exists
	if (!fs.existsSync(mp)) {
		fs.mkdirSync(path.dirname(mp), { recursive: true });
		fs.writeFileSync(mp, "", { encoding: "utf-8" });
	}

	let lastSize = fs.statSync(mp).size;

	// Check for existing messages (dispatch written before watcher was set up)
	const existingMessages = readMailbox(mp);
	if (existingMessages.length > 0) {
		if (role === "orchestrator") {
			processOrchestratorMailbox(pi, ctx, task, existingMessages);
		} else {
			processWorkerMailbox(pi, ctx, task, role, existingMessages);
		}
		clearMailbox(mp);
		lastSize = 0;
	}

	try {
		const watcher = fs.watch(mp, () => {
			try {
				const stat = fs.statSync(mp);
				if (stat.size === lastSize) return;
				lastSize = stat.size;

				const messages = readMailbox(mp);
				if (messages.length === 0) return;

				if (role === "orchestrator") {
					processOrchestratorMailbox(pi, ctx, task, messages);
				} else {
					processWorkerMailbox(pi, ctx, task, role, messages);
				}
				clearMailbox(mp);
			} catch {
				// Mailbox file might be temporarily unavailable
			}
		});

		activeWatchers.push(watcher);
	} catch {
		// fs.watch may fail on some systems
	}

	// Polling fallback — fs.watch is unreliable on some platforms and may
	// silently stop firing events. Poll every 2s as a safety net.
	const pollInterval = setInterval(() => {
		try {
			const stat = fs.statSync(mp);
			if (stat.size === lastSize || stat.size === 0) return;
			lastSize = stat.size;

			const messages = readMailbox(mp);
			if (messages.length === 0) return;

			if (role === "orchestrator") {
				processOrchestratorMailbox(pi, ctx, task, messages);
			} else {
				processWorkerMailbox(pi, ctx, task, role, messages);
			}
			clearMailbox(mp);
		} catch {
			// Mailbox file might be temporarily unavailable
		}
	}, 2000);

	// Store interval so it can be cleaned up on session shutdown
	activeWatchers.push({ close: () => clearInterval(pollInterval) } as unknown as fs.FSWatcher);
}

// ─── Main extension ──────────────────────────────────────────────────────────

export default function teamExtension(pi: ExtensionAPI) {
	let currentTeamState: TeamState | null = null;
	let currentWorkerState: WorkerState | null = null;


	// ─── team_orchestrate tool (orchestrator only) ────────────────────────

	pi.registerTool({
		name: "team_orchestrate",
		label: "Orchestrate Team",
		description:
			"Orchestrate the team by dispatching an agent with instructions. " +
			"You are a PURE DELEGATOR — your ONLY job is to decide which agent to dispatch next and pass context. " +
			"Never do work that a team agent specializes in (planning, reviewing, implementing, etc.). " +
			"Only available when you are the orchestrator.",
		promptSnippet: "Dispatch an agent with instructions",
		promptGuidelines: [
			"Always dispatch one agent at a time. After dispatching, STOP and wait. You will be automatically re-invoked when the agent reports back via team_report.",
			"You are a PURE DELEGATOR. Your job is ONLY to decide which agent to dispatch next and provide them with clear instructions. Never do work that a team agent can do — if a planner exists, you do NOT plan; if a reviewer exists, you do NOT review; if a worker exists, you do NOT implement.",
			"When an agent reports completion, briefly note their result and dispatch the next agent. Do NOT re-analyze, re-plan, or re-review their work yourself — delegate to the appropriate specialist.",
			"If an agent raises a challenge or question, address it by dispatching the right agent to handle it. Do not attempt to solve the challenge yourself.",
			"Give each agent clear, specific instructions about what you need them to do. Include relevant context from previous agents' reports.",
		],
		parameters: Type.Object({
			action: StringEnum(["dispatch"] as const, {
				description: "Action to take: 'dispatch' sends a task to an agent",
			}),
			agent: Type.Optional(Type.String({
				description: "Name of the agent to dispatch (required for 'dispatch' action)",
			})),
			instructions: Type.Optional(Type.String({
				description: "Clear instructions for the agent (required for 'dispatch' action). Include relevant context from previous agents' work.",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const envRole = process.env.PI_TEAM_ROLE;
			const isOrchestrator = envRole === "orchestrator" || currentTeamState !== null;

			if (!isOrchestrator) {
				return {
					content: [{ type: "text", text: "Only the orchestrator can use team_orchestrate." }],
					isError: true,
				};
			}

			const task = process.env.PI_TEAM_TASK ?? currentTeamState?.task;
			if (!task) {
				return {
					content: [{ type: "text", text: "No active team task." }],
					isError: true,
				};
			}

			const state = loadState(ctx.cwd, task);
			if (!state) {
				return {
					content: [{ type: "text", text: `No workflow state found for "${task}".` }],
					isError: true,
				};
			}

			if (params.action === "dispatch") {
				// Validate agent
				if (!params.agent) {
					const available = state.agents
						.filter((a) => state.agentStatus[a.name] !== "working")
						.map((a) => a.name);
					return {
						content: [{ type: "text", text: `Must specify an agent. Available (not working): ${available.join(", ") || "none"}` }],
						isError: true,
					};
				}

				const rosterEntry = state.agents.find((a) => a.name === params.agent);
				if (!rosterEntry) {
					const available = state.agents.map((a) => a.name);
					return {
						content: [{ type: "text", text: `Unknown agent "${params.agent}". Available: ${available.join(", ")}` }],
						isError: true,
					};
				}

				if (state.agentStatus[params.agent] === "working") {
					return {
						content: [{ type: "text", text: `Agent "${params.agent}" is already working. Wait for them to report back.` }],
						isError: true,
					};
				}

				if (!params.instructions) {
					return {
						content: [{ type: "text", text: "Must provide instructions for the agent." }],
						isError: true,
					};
				}

				// Record dispatch
				state.agentStatus[params.agent] = "working";
				state.dispatchHistory.push({
					agent: params.agent,
					instructions: params.instructions,
					timestamp: Date.now(),
				});

				// Write dispatch to agent's mailbox (agent is already running and watching)
				const agentMailbox = mailboxPath(ctx.cwd, task, params.agent);
				appendToMailbox(agentMailbox, {
					type: "dispatch",
					from: "orchestrator",
					to: params.agent,
					instructions: params.instructions,
					timestamp: Date.now(),
				});

				// Spawn agent if no surface exists (surface was closed, agent crashed, etc.)
				const existingSurfaceId = state.surfaceIds[params.agent];
				if (existingSurfaceId && !(await cmuxSurfaceExists(existingSurfaceId))) {
					delete state.surfaceIds[params.agent];
				}
				if (!state.surfaceIds[params.agent]) {
					// Resolve orchestrator pane ID if not yet known
					if (!state.orchestratorPaneId) {
						state.orchestratorPaneId = await cmuxGetPaneId();
					}

					const { surfaceId } = await spawnAgent(
						pi, ctx, rosterEntry, task,
						state.orchestratorPaneId,
						async () => {
							state.orchestratorPaneId = await cmuxGetPaneId();
							return state.orchestratorPaneId;
						},
						loadAgentSessionMeta(ctx.cwd, task, rosterEntry.name) ?? undefined,
					);

					if (surfaceId) {
						state.surfaceIds[params.agent] = surfaceId;
					}
				}

				saveState(ctx.cwd, state);
				currentTeamState = state;

				updateTeamWidget(ctx, state);

				return {
					content: [{
						type: "text",
						text: `✅ Dispatched "${params.agent}" with instructions.\n\n⏳ Wait for the agent to report back. You will be automatically re-invoked when they report back — do not poll or check for updates.`,
					}],
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${params.action}` }],
				isError: true,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = theme.fg("toolTitle", theme.bold("team_orchestrate "));
			content += theme.fg("accent", args.action);
			if (args.agent) content += theme.fg("muted", ` → ${args.agent}`);
			text.setText(content);
			return text;
		},
		renderResult(result, { expanded }, theme, context) {
			let text = result.isError
				? theme.fg("error", "✗ Error")
				: theme.fg("success", "✓ Done");
			if (expanded && result.content[0]) {
				text += "\n  " + theme.fg("dim", (result.content[0] as { text: string }).text.substring(0, 200));
			}
			return new Text(text, 0, 0);
		},
	});

	// ─── team_report tool (worker only) ───────────────────────────────────

	pi.registerTool({
		name: "team_report",
		label: "Report Task Completion",
		description:
			"Report that you have completed your assigned work. Call this when you're done with the task " +
			"given to you by the orchestrator. Your summary will be sent to the orchestrator who will " +
			"decide the next step. You can also include questions for the orchestrator.",
		promptSnippet: "Report task completion to orchestrator",
		promptGuidelines: [
			"Call this when you have finished the task given to you by the orchestrator.",
			"Provide a clear, concise summary of what you accomplished.",
			"Include questions if you need clarification or decisions from the orchestrator.",
			"After calling this, wait for further instructions from the orchestrator.",
		],
		parameters: Type.Object({
			summary: Type.String({
				description: "Clear summary of what you accomplished",
			}),
			questions: Type.Optional(Type.Array(Type.String(), {
				description: "Questions for the orchestrator (e.g., clarifications, decisions needed)",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = process.env.PI_TEAM_TASK ?? currentWorkerState?.task;
			const role = process.env.PI_TEAM_ROLE ?? currentWorkerState?.role;

			if (!task || !role) {
				return {
					content: [{ type: "text", text: "Not in a team session. Use /team commands to set up." }],
					isError: true,
				};
			}

			// Update state
			const state = loadState(ctx.cwd, task);
			if (state) {
				state.agentStatus[role] = "idle";
				// Update dispatch history result and questions
				for (let i = state.dispatchHistory.length - 1; i >= 0; i--) {
					if (state.dispatchHistory[i].agent === role && !state.dispatchHistory[i].result) {
						state.dispatchHistory[i].result = params.summary;
						if (params.questions && params.questions.length > 0) {
							state.dispatchHistory[i].questions = params.questions;
						}
						break;
					}
				}
				saveState(ctx.cwd, state);
			}

			// Send done message to orchestrator mailbox
			const orchestratorMailbox = mailboxPath(ctx.cwd, task, "orchestrator");
			appendToMailbox(orchestratorMailbox, {
				type: "done",
				from: role,
				to: "orchestrator",
				summary: params.summary,
				questions: params.questions,
				timestamp: Date.now(),
			});

			// Notify
			terminalNotify("Pi", `${role} done for ${task}`);
			try {
				await cmuxNotify("Pi", `${role} done for ${task}`);
			} catch {
				// cmux not available
			}

			return {
				content: [{
					type: "text",
					text: "✅ Report submitted. Wait for further instructions from the orchestrator.",
				}],
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("team_report ")) + theme.fg("muted", args.summary.substring(0, 60) + (args.summary.length > 60 ? "..." : "")));
			return text;
		},
		renderResult(result, { expanded }, theme, context) {
			const text = result.isError
				? theme.fg("error", "✗ Report failed")
				: theme.fg("success", "✓ Report submitted");
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "team_message",
		label: "Team Message",
		description:
			"Send a message to the orchestrator (for workers) or to an agent (for orchestrator). " +
			"Use 'challenge' to raise a concern or disagreement, 'notify' for informational updates, " +
			"or 'ack' to acknowledge receipt of a message.",
		promptSnippet: "Send a message to the orchestrator",
		parameters: Type.Object({
			to: Type.String({
				description: "Recipient name (workers: use 'orchestrator'; orchestrator: use an agent name from your team)",
			}),
			type: StringEnum(["challenge", "notify", "ack"] as const, {
				description: "Type of message: challenge (disagreement/concern), notify (informational), or ack (acknowledge receipt/action)",
			}),
			body: Type.String({ description: "Message content" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = process.env.PI_TEAM_TASK ?? currentWorkerState?.task ?? currentTeamState?.task;
			const role = process.env.PI_TEAM_ROLE ?? currentWorkerState?.role ?? "orchestrator";

			if (!task || !role) {
				return {
					content: [{ type: "text", text: "Not in a team session." }],
					isError: true,
				};
			}

			// Validate recipient
			const state = loadState(ctx.cwd, task);
			if (state) {
				if (role !== "orchestrator" && params.to !== "orchestrator") {
					return {
						content: [{ type: "text", text: "Workers can only send messages to the orchestrator. Set 'to' to 'orchestrator'." }],
						isError: true,
					};
				}

				if (role === "orchestrator") {
					const agentExists = state.agents.some((a) => a.name === params.to);
					if (!agentExists) {
						return {
							content: [{ type: "text", text: `Unknown agent "${params.to}". Available: ${state.agents.map((a) => a.name).join(", ")}` }],
							isError: true,
						};
					}
				}
			}

			const mp = mailboxPath(ctx.cwd, task, params.to);
			appendToMailbox(mp, {
				type: params.type,
				from: role,
				to: params.to,
				body: params.body,
				timestamp: Date.now(),
			});

			return {
				content: [{ type: "text", text: `✉️ ${params.type} sent to ${params.to}` }],
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const typeIcons: Record<string, string> = { challenge: "⚠️", notify: "📢", ack: "✅" };
			text.setText(theme.fg("toolTitle", theme.bold("team_message ")) + `${typeIcons[args.type] ?? ""} ${args.type} → ${args.to}`);
			return text;
		},
			renderResult(result, { expanded }, theme, context) {
			return new Text(result.isError ? theme.fg("error", "✗ Failed") : theme.fg("success", "✓ Sent"), 0, 0);
		},
	});


	// ─── Session start: restore state ─────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Check for pending team resume (set by /team resume before switchSession)
		const resumeTask = loadSessionTask(ctx);
		if (resumeTask) {
			const state = loadState(ctx.cwd, resumeTask);
			const PENDING_RESUME_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

			if (state?.pendingTeamResume) {
				const elapsed = Date.now() - state.pendingTeamResume;
				if (elapsed > PENDING_RESUME_EXPIRY_MS) {
					// Flag is stale (pi likely crashed between /team resume and switchSession)
					state.pendingTeamResume = undefined;
					saveState(ctx.cwd, state);
					// Fall through to normal session_start logic
				} else {
					// Clear the flag
					state.pendingTeamResume = undefined;
					saveState(ctx.cwd, state);

					// Perform the actual resume (repair state, re-spawn workers)
					const resumed = await resumeTeam(pi, ctx, resumeTask);
					if (resumed) currentTeamState = resumed;

					// Update orchestrator session meta (new session file after switchSession)
					if (ctx.sessionManager?.getSessionFile) {
						const newSessionFile = ctx.sessionManager.getSessionFile();
						if (newSessionFile) {
							saveAgentSessionMeta(ctx.cwd, resumeTask, "orchestrator", newSessionFile);
						}
					}

					return; // Skip the rest of session_start logic
				}
			}
		}

		// Path 1: Worker with env vars (set by spawn)
		const envTask = process.env.PI_TEAM_TASK;
		const envRole = process.env.PI_TEAM_ROLE;

		if (envTask && envRole && envRole !== "orchestrator") {
			currentWorkerState = { task: envTask, role: envRole };
			saveWorkerState(pi, currentWorkerState);
			setupMailboxWatching(pi, ctx, envTask, envRole);
			pi.setSessionName(`⚪ ${envRole}: ${envTask}`);
			ctx.ui.notify(`Team session: ${envRole} for ${envTask}`, "info");

			// Save session file path for resume
			if (ctx.sessionManager?.getSessionFile) {
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (sessionFile) {
					saveAgentSessionMeta(ctx.cwd, envTask, envRole, sessionFile);
				}
			}

			return;
		}

		// Path 2: Orchestrator session state found — notify but don't auto-resume
		const sessionTask = loadSessionTask(ctx);
		if (sessionTask) {
			const state = loadState(ctx.cwd, sessionTask);
			if (state) {
				ctx.ui.notify(`🔄 Previous team "${sessionTask}" found. Use /team resume ${sessionTask} to resume.`, "info");
			}
			return;
		}

		// Path 3: Notify about available teams from .pi/workflow/
		const availableTeams = listAvailableTeams(ctx.cwd).filter(t => t.status === "active");

		if (availableTeams.length >= 1) {
			const lines: string[] = availableTeams.length === 1
				? ["🔄 Active team found:"]
				: ["🔄 Multiple active teams found:"];
			for (const team of availableTeams) {
				const timeStr = team.lastActivity > 0 ? new Date(team.lastActivity).toLocaleString() : "unknown";
				lines.push(`  🟢 ${team.task} — Agents: ${team.agentCount} | Last: ${timeStr}`);
			}
			lines.push("");
			lines.push("Use /team resume <task-name> to resume a team.");
			ctx.ui.notify(lines.join("\n"), "info");
		}
	});

	// ─── Agent end: warn if agent didn't report ───────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		const task = process.env.PI_TEAM_TASK ?? currentWorkerState?.task;
		const role = process.env.PI_TEAM_ROLE ?? currentWorkerState?.role;

		if (!task || !role || role === "orchestrator") return;

		// Check if the worker reported via team_report
		const state = loadState(ctx.cwd, task);
		if (state && state.agentStatus[role] === "working") {
			// Worker ended without calling team_report — notify orchestrator
			const orchestratorMailbox = mailboxPath(ctx.cwd, task, "orchestrator");
			appendToMailbox(orchestratorMailbox, {
				type: "notify",
				from: role,
				to: "orchestrator",
				body: `Agent "${role}" ended without calling team_report. They may have encountered an issue. Consider re-dispatching with /team redo ${task} ${role}.`,
				timestamp: Date.now(),
			});

			// Mark as idle so they can be re-dispatched
			state.agentStatus[role] = "idle";
			saveState(ctx.cwd, state);
		}
	});

	// ─── Session shutdown: cleanup resources ────────────────────────────────

	pi.on("session_shutdown", async (_event, ctx) => {
		// Close all active file watchers
		for (const watcher of activeWatchers) {
			try {
				watcher.close();
			} catch {
				// Best effort
			}
		}
		activeWatchers.length = 0;

		// If orchestrator: send shutdown messages and close cmux surfaces
		if (currentTeamState) {
			const state = currentTeamState;
			for (const agent of state.agents) {
				const mp = mailboxPath(ctx.cwd, state.task, agent.name);
				appendToMailbox(mp, {
					type: "shutdown",
					from: "orchestrator",
					to: agent.name,
					body: "Session shutting down.",
					timestamp: Date.now(),
				});
			}

			// Close cmux surfaces
			for (const surfaceId of Object.values(state.surfaceIds)) {
				await cmuxCloseSurface(surfaceId);
			}
		}

		// Clean up temp context files for this session's task only
		const shutdownTask = currentTeamState?.task ?? process.env.PI_TEAM_TASK;
		if (shutdownTask) {
			try {
				const tmpEntries = await fs.promises.readdir(os.tmpdir());
				for (const entry of tmpEntries) {
					if (entry.startsWith("pi-team-") && entry.includes(shutdownTask)) {
						const fullPath = path.join(os.tmpdir(), entry);
						try {
							await fs.promises.rm(fullPath, { recursive: true, force: true });
						} catch {
							// Best effort
						}
					}
				}
			} catch {
				// tmpdir may not be accessible
			}
		}

		// Clear team status and widget
		ctx.ui.setWidget("team-dashboard", undefined);
	});

	// ─── Before agent start: inject orchestrator context ────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		// Only inject for orchestrator sessions
		if (!currentTeamState) return;
		const task = currentTeamState.task;

		const state = loadState(ctx.cwd, task);
		if (!state) return;

		// Build and inject orchestrator context on every turn
		const context = buildOrchestratorContext(state);

		// Inject pending resume context as system-level info (not a user message)
		let resumeContext = "";
		if (state.pendingResumeContext) {
			resumeContext = "\n\n" + state.pendingResumeContext;
			state.pendingResumeContext = undefined;
			saveState(ctx.cwd, state);
		}

		currentTeamState = state;
		updateTeamWidget(ctx, state);

		return {
			systemPrompt: event.systemPrompt + "\n\n" + context + resumeContext,
		};
	});

	// ─── /team command ────────────────────────────────────────────────────

	pi.registerCommand("team", {
		description: "Manage dynamic multi-agent team workflows",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["init", "status", "redo", "shutdown", "resume", "complete", "list", "history", "cleanup"];
			return subcommands
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0];

			switch (subcommand) {
				// ─── /team init ─────────────────────────────────────────
				case "init": {
					const taskName = parts[1];
					const agentNames = parts.slice(2);

					if (!taskName) {
						ctx.ui.notify("Usage: /team init <task-name> [<agent>...]", "warning");
						return;
					}

					// Discover available agents
					const discovery = discoverAgents(ctx.cwd, "both");

					let roster: AgentRosterEntry[];

					if (agentNames.length === 0) {
						// No agents specified — load all discovered agents
						if (discovery.agents.length === 0) {
							ctx.ui.notify("No agents found.\n\nAdd agent .md files to:\n  ~/.pi/agent/team/ (user-level)\n  .pi/team/ (project-level)", "error");
							return;
						}
						roster = discovery.agents.map(agentConfigToRosterEntry);
					} else {
						roster = [];
						const notFound: string[] = [];

						for (const name of agentNames) {
							const agent = discovery.agents.find((a) => a.name === name);
							if (!agent) {
								notFound.push(name);
							} else {
								roster.push(agentConfigToRosterEntry(agent));
							}
						}

						if (notFound.length > 0) {
							const available = discovery.agents.map((a) => a.name).join(", ") || "none";
							ctx.ui.notify(`Unknown agent(s): ${notFound.join(", ")}\nAvailable agents: ${available}`, "error");
							return;
						}
					}

					// Create workflow directory structure
					const dir = workflowDir(ctx.cwd, taskName);
					const mdir = mailboxDir(ctx.cwd, taskName);
					const sdir = agentSessionDir(ctx.cwd, taskName);
					fs.mkdirSync(dir, { recursive: true });
					fs.mkdirSync(mdir, { recursive: true });
					fs.mkdirSync(sdir, { recursive: true });

					// Initialize mailbox files
					for (const agent of roster) {
						const mp = path.join(mdir, `${agent.name}.json`);
						if (!fs.existsSync(mp)) {
							fs.writeFileSync(mp, "", { encoding: "utf-8" });
						}
					}
					// Orchestrator mailbox
					const omp = path.join(mdir, "orchestrator.json");
					if (!fs.existsSync(omp)) {
						fs.writeFileSync(omp, "", { encoding: "utf-8" });
					}

					// Initialize state
					const agentStatus: Record<string, "idle" | "working"> = {};
					for (const agent of roster) {
						agentStatus[agent.name] = "idle";
					}

					currentTeamState = {
						task: taskName,
						role: "orchestrator",
						status: "active",
						agents: roster,
						agentStatus,
						orchestratorPaneId: null,
						surfaceIds: {},
						dispatchHistory: [],
					};
					saveState(ctx.cwd, currentTeamState);
					saveSessionState(pi, currentTeamState);

					// Start watching orchestrator mailbox
					setupMailboxWatching(pi, ctx, taskName, "orchestrator");

					// Resolve orchestrator pane ID if not yet known
					if (!currentTeamState.orchestratorPaneId) {
						currentTeamState.orchestratorPaneId = await cmuxGetPaneId();
					}

					// Spawn all agents as tabs in the orchestrator's pane
					for (let i = 0; i < roster.length; i++) {
						const agent = roster[i];

						const { surfaceId } = await spawnAgent(
							pi, ctx, agent, taskName,
							currentTeamState.orchestratorPaneId,
							async () => {
								currentTeamState.orchestratorPaneId = await cmuxGetPaneId();
								return currentTeamState.orchestratorPaneId;
							},
						);

						if (surfaceId) {
							currentTeamState.surfaceIds[agent.name] = surfaceId;
						}
					}



					saveState(ctx.cwd, currentTeamState);

					updateTeamWidget(ctx, currentTeamState);

					// Name the session
					const orchLabel = `🔷 orchestrator: ${taskName}`;
					pi.setSessionName(orchLabel);
					await cmuxRenameTab(undefined, orchLabel);

					// Save orchestrator session file for resume
					if (ctx.sessionManager?.getSessionFile) {
						const orchSession = ctx.sessionManager.getSessionFile();
						if (orchSession) {
							saveAgentSessionMeta(ctx.cwd, taskName, "orchestrator", orchSession);
						}
					}

					const agentList = roster.map((a) => `  🔵 ${a.name} — ${a.description}`).join("\n");
					ctx.ui.notify(`Team initialized for "${taskName}"\nAgents:\n${agentList}\n\nDispatch agents using team_orchestrate or use /team redo to re-dispatch.`, "info");
					await cmuxLog("info", `Team initialized for ${taskName} with agents: ${roster.map((a) => a.name).join(", ")}`);
					break;
				}

				// ─── /team status ───────────────────────────────────────
				case "status": {
					const taskName = parts[1] ?? currentTeamState?.task ?? loadSessionTask(ctx);

					if (!taskName) {
						ctx.ui.notify("Usage: /team status <task-name>", "warning");
						return;
					}

					const state = loadState(ctx.cwd, taskName);
					if (!state) {
						ctx.ui.notify(`No workflow found for "${taskName}"`, "warning");
						return;
					}

					const lines: string[] = [`📋 Team: ${taskName} (${state.status ?? "active"})`];

					lines.push("\n👥 Agents:");
					for (const agent of state.agents) {
						const status = state.agentStatus[agent.name] ?? "idle";
						const icon = statusIcon(status);
						const surface = state.surfaceIds[agent.name] ? ` (surface: ${state.surfaceIds[agent.name]})` : "";
						lines.push(`  ${icon} ${agent.name} — ${status}${surface}`);
					}

					// Reports
					const completedReports = state.dispatchHistory.filter(e => e.result);
					if (completedReports.length > 0) {
						lines.push("\n📄 Reports:");
						for (const entry of completedReports) {
							lines.push(`  ✅ ${entry.agent}`);
						}
					}

					// Mailboxes
					const mdir = mailboxDir(ctx.cwd, taskName);
					if (fs.existsSync(mdir)) {
						lines.push("\n📬 Mailboxes:");
						const mailboxFiles = fs.readdirSync(mdir).filter((f) => f.endsWith(".json"));
						for (const mf of mailboxFiles) {
							const mp = path.join(mdir, mf);
							const messages = readMailbox(mp);
							const unread = messages.length;
							const name = mf.replace(".json", "");
							lines.push(`  ${unread > 0 ? "🔴" : "🟢"} ${name}: ${unread} message${unread !== 1 ? "s" : ""}`);
						}
					}


					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				// ─── /team redo ─────────────────────────────────────────
				case "redo": {
					const taskName = parts[1];
					const agentName = parts[2];
					const message = parts.slice(3).join(" ");

					if (!taskName || !agentName) {
						ctx.ui.notify("Usage: /team redo <task-name> <agent> [message]", "warning");
						return;
					}

					const state = currentTeamState ?? loadState(ctx.cwd, taskName);
					if (!state) {
						ctx.ui.notify(`No workflow found for "${taskName}"`, "warning");
						return;
					}

					const rosterEntry = state.agents.find((a) => a.name === agentName);
					if (!rosterEntry) {
						ctx.ui.notify(`Unknown agent "${agentName}". Available: ${state.agents.map((a) => a.name).join(", ")}`, "error");
						return;
					}

					if (state.agentStatus[agentName] === "working") {
						ctx.ui.notify(`Agent "${agentName}" is currently working. Wait for them to finish first.`, "warning");
						return;
					}

					// Re-dispatch the agent
					const instructions = message || `Re-do your previous task. Review your earlier work and improve on it.`;

					state.agentStatus[agentName] = "working";
					state.dispatchHistory.push({
						agent: agentName,
						instructions,
						timestamp: Date.now(),
					});

					// Write dispatch to mailbox
					const agentMailbox = mailboxPath(ctx.cwd, taskName, agentName);
					appendToMailbox(agentMailbox, {
						type: "dispatch",
						from: "orchestrator",
						to: agentName,
						instructions: instructions,
						timestamp: Date.now(),
					});

					// Spawn agent if no surface exists (surface was closed, agent crashed, etc.)
					const existingSurfaceId = state.surfaceIds[agentName];
					if (existingSurfaceId && !(await cmuxSurfaceExists(existingSurfaceId))) {
						delete state.surfaceIds[agentName];
					}
					if (!state.surfaceIds[agentName]) {
						// Resolve orchestrator pane ID if not yet known
						if (!state.orchestratorPaneId) {
							state.orchestratorPaneId = await cmuxGetPaneId();
						}

						const { surfaceId } = await spawnAgent(
							pi, ctx, rosterEntry, taskName,
							state.orchestratorPaneId,
							async () => {
								state.orchestratorPaneId = await cmuxGetPaneId();
								return state.orchestratorPaneId;
							},
							loadAgentSessionMeta(ctx.cwd, taskName, rosterEntry.name) ?? undefined,
						);

						if (surfaceId) {
							state.surfaceIds[agentName] = surfaceId;
						}
					}

					saveState(ctx.cwd, state);
					currentTeamState = state;

					updateTeamWidget(ctx, state);

					ctx.ui.notify(`🔁 Re-dispatched "${agentName}" for "${taskName}"`, "info");
					await cmuxLog("info", `Re-dispatched ${agentName} for ${taskName}`);
					break;
				}

				// ─── /team shutdown ─────────────────────────────────────
				case "shutdown": {
					const taskName = parts[1] ?? currentTeamState?.task ?? loadSessionTask(ctx);

					if (!taskName) {
						ctx.ui.notify("Usage: /team shutdown <task-name>", "warning");
						return;
					}

					const state = currentTeamState ?? loadState(ctx.cwd, taskName);

					// Send shutdown to all agents
					if (state) {
						state.status = "shutdown";

						for (const agent of state.agents) {
							const mp = mailboxPath(ctx.cwd, taskName, agent.name);
							appendToMailbox(mp, {
								type: "shutdown",
								from: "orchestrator",
								to: agent.name,
								body: "Workflow shutdown requested.",
								timestamp: Date.now(),
							});
						}

						// Close cmux surfaces
						for (const [agentName, surfaceId] of Object.entries(state.surfaceIds)) {
							await cmuxCloseSurface(surfaceId);
						}

						saveState(ctx.cwd, state);
					}

					ctx.ui.setWidget("team-dashboard", undefined);
					if (currentTeamState?.task === taskName) {
						currentTeamState = null;
					}
					ctx.ui.notify(`Shutdown sent for "${taskName}"`, "info");
					break;
				}

				// ─── /team resume ──────────────────────────────────────
				case "resume": {
					const taskName = parts[1];

					if (!taskName) {
						// No arg — list available teams
						const teams = listAvailableTeams(ctx.cwd);
						if (teams.length === 0) {
							ctx.ui.notify("No teams found in .pi/workflow/", "info");
							return;
						}

						const lines: string[] = ["🔄 Available Teams:\n"];
						for (const team of teams) {
							const statusIcon = team.status === "active" ? "🟢" : team.status === "shutdown" ? "🔴" : "✅";
							const workingTag = team.hasWorkingAgents ? " (has working agents)" : "";
							const timeStr = team.lastActivity > 0 ? new Date(team.lastActivity).toLocaleString() : "unknown";
							lines.push(`  ${statusIcon} ${team.task} — ${team.status}${workingTag}`);
							lines.push(`     Agents: ${team.agentCount} | Last activity: ${timeStr}`);
						}

						lines.push("");
						lines.push("Use /team resume <task-name> to resume a team.");

						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}

					// Try to load orchestrator session for conversation history restoration
					const orchSessionFile = loadAgentSessionMeta(ctx.cwd, taskName, "orchestrator");
					if (orchSessionFile) {
						// Set pending flag so session_start auto-resumes after switchSession
						const state = loadState(ctx.cwd, taskName);
						if (state) {
							state.pendingTeamResume = Date.now();
							saveState(ctx.cwd, state);
						}

						// Switch to the old session — this loads full conversation history
						// and triggers session_start, which detects pendingTeamResume and calls resumeTeam()
						await ctx.switchSession(orchSessionFile);
						return; // switchSession may not return normally
					} else {
						// No saved session file — fall back to direct resume (no history)
						const resumed = await resumeTeam(pi, ctx, taskName);
						if (resumed) currentTeamState = resumed;
					}
					break;
				}

				// ─── /team complete ────────────────────────────────────
				case "complete": {
					const taskName = parts[1] ?? currentTeamState?.task ?? loadSessionTask(ctx);

					if (!taskName) {
						ctx.ui.notify("Usage: /team complete [task-name]", "warning");
						return;
					}

					const state = currentTeamState ?? loadState(ctx.cwd, taskName);
					if (!state) {
						ctx.ui.notify(`No workflow found for "${taskName}"`, "warning");
						return;
					}

					// Mark any in-progress dispatches as completed
					for (const entry of state.dispatchHistory) {
						if (!entry.result) {
							entry.result = "[Team completed]";
						}
					}

					// Mark all agents idle
					for (const agent of state.agents) {
						state.agentStatus[agent.name] = "idle";
					}

					state.status = "completed";

					// Send shutdown to all agents
					for (const agent of state.agents) {
						const mp = mailboxPath(ctx.cwd, taskName, agent.name);
						appendToMailbox(mp, {
							type: "shutdown",
							from: "orchestrator",
							to: agent.name,
							body: "Team completed. Thank you!",
							timestamp: Date.now(),
						});
					}

					// Close cmux surfaces
					for (const surfaceId of Object.values(state.surfaceIds)) {
						await cmuxCloseSurface(surfaceId);
					}

					saveState(ctx.cwd, state);

					// Clear widget and session state
					ctx.ui.setWidget("team-dashboard", undefined);
					if (currentTeamState?.task === taskName) {
						currentTeamState = null;
					}

					ctx.ui.notify(`✅ Team "${taskName}" marked as completed.`, "info");
					await cmuxLog("info", `Team "${taskName}" marked as completed`);
					break;
				}

				// ─── /team list ─────────────────────────────────────────
				case "list": {
					const discovery = discoverAgents(ctx.cwd, "both");

					if (discovery.agents.length === 0) {
						ctx.ui.notify("No agents found.\n\nAdd agent .md files to:\n  ~/.pi/agent/team/ (user-level)\n  .pi/team/ (project-level)", "info");
						return;
					}

					const lines: string[] = ["🤖 Available Agents:\n"];
					for (const agent of discovery.agents) {
						const source = agent.source === "user" ? "👤" : "📁";
						const model = agent.model ? ` [${agent.model}]` : "";
						const tools = agent.tools
							? agent.tools.includes("all")
								? " (tools: all)"
								: ` (tools: ${agent.tools.join(", ")})`
							: "";
						lines.push(`  ${source} ${agent.name}${model}${tools}`);
						lines.push(`     ${agent.description}`);
					}

					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				// ─── /team history ──────────────────────────────────────
				case "history": {
					const taskName = parts[1] ?? currentTeamState?.task ?? loadSessionTask(ctx);

					if (!taskName) {
						ctx.ui.notify("Usage: /team history <task-name>", "warning");
						return;
					}

					const state = loadState(ctx.cwd, taskName);
					if (!state) {
						ctx.ui.notify(`No workflow found for "${taskName}"`, "warning");
						return;
					}

					const lines: string[] = [`📜 Dispatch History: ${taskName}\n`];

					if (state.dispatchHistory.length === 0) {
						lines.push("No dispatches yet.");
					} else {
						for (let i = 0; i < state.dispatchHistory.length; i++) {
							const entry = state.dispatchHistory[i];
							const time = new Date(entry.timestamp).toLocaleTimeString();
							const resultIcon = entry.result ? "✅" : "🟡";
							lines.push(`${i + 1}. ${resultIcon} ${entry.agent} — ${time}`);
							lines.push(`   Instructions: ${entry.instructions.substring(0, 100)}${entry.instructions.length > 100 ? "..." : ""}`);
							if (entry.result) {
								lines.push(`   Result: ${entry.result.substring(0, 100)}${entry.result.length > 100 ? "..." : ""}`);
							}
						}
					}

					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				// ─── /team cleanup ──────────────────────────────────────
				case "cleanup": {
					const wfDir = path.join(ctx.cwd, ".pi", "workflow");

					if (!fs.existsSync(wfDir)) {
						ctx.ui.notify("No teams to clean up.", "info");
						break;
					}

					const dirEntries = fs.readdirSync(wfDir, { withFileTypes: true });
					const deletable: { name: string; status: string }[] = [];

					for (const entry of dirEntries) {
						if (!entry.isDirectory()) continue;
						const name = entry.name;

						// Skip the currently active team
						if (currentTeamState?.task === name) continue;

						const sp = path.join(wfDir, name, "state.json");
						let status: string | null = null;

						try {
							const content = fs.readFileSync(sp, "utf-8").trim();
							if (content) {
								const state = JSON.parse(content);
								status = state.status ?? null;
							}
						} catch {
							// No state.json or invalid — deletable
						}

						// Deletable if shutdown, completed, or no status/state.json
						if (status === "shutdown" || status === "completed" || status === null) {
							deletable.push({ name, status: status ?? "(no state)" });
						}
					}

					if (deletable.length === 0) {
						ctx.ui.notify("No teams to clean up.", "info");
						break;
					}

					// Show preview
					const previewLines = deletable.map(d => `  🗑️ ${d.name} (${d.status})`);
					ctx.ui.notify(`Teams to clean up:\n${previewLines.join("\n")}`, "info");

					// Confirm
					const confirmed = await ctx.ui.confirm(
						"Team Cleanup",
						`Delete ${deletable.length} team${deletable.length !== 1 ? "s" : ""}?`,
					);
					if (!confirmed) {
						ctx.ui.notify("Cleanup cancelled.", "info");
						break;
					}

					// Delete confirmed teams
					let deletedCount = 0;
					for (const team of deletable) {
						// Close cmux surfaces before deletion (best effort)
						try {
							const sp = path.join(wfDir, team.name, "state.json");
							const content = fs.readFileSync(sp, "utf-8");
							const state = JSON.parse(content);
							for (const surfaceId of Object.values(state.surfaceIds ?? {})) {
								await cmuxCloseSurface(surfaceId).catch(() => {});
							}
						} catch { /* best effort */ }

						await fs.promises.rm(path.join(wfDir, team.name), { recursive: true, force: true });
						deletedCount++;
					}

					// Clean /tmp/pi-team-* temp dirs (best-effort)
					let tempCleaned = 0;
					try {
						const tmpEntries = await fs.promises.readdir(os.tmpdir());
						for (const entry of tmpEntries) {
							if (entry.startsWith("pi-team-")) {
								const fullPath = path.join(os.tmpdir(), entry);
								try {
									await fs.promises.rm(fullPath, { recursive: true, force: true });
									tempCleaned++;
								} catch {
									// Best effort
								}
							}
						}
					} catch {
						// Best effort
					}

					ctx.ui.notify(`🧹 Cleaned up ${deletedCount} team${deletedCount !== 1 ? "s" : ""}${tempCleaned > 0 ? ` and ${tempCleaned} temp dir${tempCleaned !== 1 ? "s" : ""}` : ""}`, "info");
					await cmuxLog("info", `Cleaned up ${deletedCount} team(s)`);
					break;
				}

				default: {
					ctx.ui.notify(
						"Unknown command. Usage:\n" +
							"  /team init <team-name> [<agent>...]\n" +
							"  /team status [team-name]\n" +
							"  /team redo <team-name> <agent> [message]\n" +
							"  /team shutdown [team-name]\n" +
							"  /team resume [task-name]\n" +
							"  /team complete [task-name]\n" +
							"  /team cleanup\n" +
							"  /team list\n" +
							"  /team history [team-name]",
						"info",
					);
				}
			}
		},
	});
}
