/**
 * Team Extension — Dynamic LLM-orchestrated multi-agent workflows
 *
 * Compose a team from any agents discovered via .md files. The orchestrator
 * (the main pi session) uses LLM reasoning to decide which agent to dispatch
 * next, when to re-dispatch, and when the task is complete.
 *
 * All worker communication routes through the orchestrator — workers never
 * talk to each other directly.
 *
 * Commands:
 *   /team init <task> <agent>...     — Create team, become orchestrator
 *   /team send <task> <details>      — Send task to orchestrator, starts orchestration
 *   /team status [task]              — Show workflow state
 *   /team redo <task> <agent> [msg]  — Re-dispatch an agent (manual override)
 *   /team shutdown [task]            — Graceful shutdown of all workers
 *   /team list                       — List available agents
 *   /team history [task]             — Show dispatch history
 *
 * Tools (registered for LLM use):
 *   team_orchestrate  — Dispatch an agent or complete the task (orchestrator only)
 *   team_report       — Report task completion back to orchestrator (worker only)
 *   team_message      — Send challenge/notify/ack to orchestrator (worker) or agent (orchestrator)
 *   team_read_deliverables — Read task description and all agent reports
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { discoverAgents, type AgentConfig } from "./agents.js";

const execFileAsync = promisify(execFile);

// ─── Types & Constants ───────────────────────────────────────────────────────

const MAX_DISPATCHES = parseInt(process.env.PI_TEAM_MAX_DISPATCHES ?? "30", 10);

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
}

interface TeamState {
	task: string;
	role: "orchestrator";
	agents: AgentRosterEntry[];
	agentStatus: Record<string, "idle" | "working" | "done">;
	surfaceIds: Record<string, string>;
	taskDescription: string;
	dispatchHistory: DispatchEntry[];
	isComplete: boolean;
	dispatchCount: number;
	maxDispatches: number;
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

function reportsDir(cwd: string, task: string): string {
	return path.join(workflowDir(cwd, task), "reports");
}

function reportPath(cwd: string, task: string, agent: string): string {
	return path.join(reportsDir(cwd, task), `${agent}.md`);
}

function taskFilePath(cwd: string, task: string): string {
	return path.join(workflowDir(cwd, task), "task.md");
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
		return JSON.parse(content);
	} catch {
		return null;
	}
}

function saveSessionState(pi: ExtensionAPI, state: TeamState): void {
	pi.appendEntry("team-orchestrator", { task: state.task });
}

function loadSessionTask(ctx: ExtensionContext): string | null {
	const entries = ctx.sessionManager.getEntries();
	const entry = entries
		.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "team-orchestrator")
		.pop() as { data?: { task: string } } | undefined;
	return entry?.data?.task ?? null;
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
		return JSON.parse(content);
	} catch {
		return [];
	}
}

function appendToMailbox(filePath: string, message: TeamMessage): void {
	const messages = readMailbox(filePath);
	messages.push(message);
	fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), { encoding: "utf-8" });
}

function clearMailbox(filePath: string): void {
	fs.writeFileSync(filePath, "[]", { encoding: "utf-8" });
}

// ─── cmux CLI helpers ────────────────────────────────────────────────────────

async function cmuxExec(...args: string[]): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execFileAsync("cmux", args, { timeout: 10000 });
	} catch (err: any) {
		throw new Error(`cmux ${args.join(" ")} failed: ${err.message}`);
	}
}

async function cmuxSplitPane(direction: string = "right", splitFromSurfaceId?: string): Promise<string | null> {
	try {
		const args = splitFromSurfaceId
			? ["new-split", direction, "--surface", splitFromSurfaceId]
			: ["new-split", direction];
		const { stdout } = await cmuxExec(...args);
		const match = stdout.match(/surface:(\d+)/i);
		return match ? `surface:${match[1]}` : null;
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

async function cmuxRenameTab(surfaceId: string, title: string): Promise<void> {
	try {
		await cmuxExec("rename-tab", "--surface", surfaceId, title);
	} catch {
		// Best effort
	}
}

async function cmuxEqualizeSplits(): Promise<void> {
	try {
		await cmuxExec("rpc", "workspace.equalize_splits");
	} catch {
		// Best effort
	}
}

async function cmuxSurfaceExists(surfaceId: string): Promise<boolean> {
	try {
		const { stdout } = await cmuxExec("list-surfaces");
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

// ─── Orchestrator context builder ────────────────────────────────────────────

function statusIcon(status: string): string {
	switch (status) {
		case "done": return "✅";
		case "working": return "🟡";
		case "idle": return "🔵";
		default: return "⚪";
	}
}

function buildOrchestratorContext(state: TeamState, triggerReason: string, extraInfo?: string): string {
	const lines: string[] = [];

	lines.push(`📋 **Team Orchestration — ${state.task}**`);
	lines.push("");
	lines.push(`**Task:** ${state.taskDescription}`);
	lines.push("");

	// Agent roster
	lines.push("**Agents:**");
	for (const agent of state.agents) {
		const status = state.agentStatus[agent.name] ?? "idle";
		const icon = statusIcon(status);
		// Show summary for done agents
		const lastReport = getLastReportSummary(agent.name, state);
		const statusDetail = status === "done" && lastReport ? ` — "${lastReport}"` : "";
		lines.push(`  ${icon} ${agent.name} (${status})${statusDetail} — ${agent.description}`);
	}
	lines.push("");

	// Extra info (e.g., challenge details)
	if (extraInfo) {
		lines.push(extraInfo);
		lines.push("");
	}

	// Dispatch budget
	const remaining = state.maxDispatches - state.dispatchCount;
	lines.push(`**Dispatches:** ${state.dispatchCount}/${state.maxDispatches} used (${remaining} remaining)`);
	lines.push("");

	// Trigger reason
	lines.push(`**Reason:** ${triggerReason}`);
	lines.push("");

	if (state.isComplete) {
		lines.push("The task is marked as complete. No further action needed.");
	} else if (remaining <= 0) {
		lines.push("⚠️ No dispatches remaining. Use /team send to provide more budget or /team shutdown to end.");
	} else {
		lines.push("Use the `team_orchestrate` tool to dispatch an agent, or mark the task complete.");
	}

	return lines.join("\n");
}

function getLastReportSummary(agentName: string, state: TeamState): string | null {
	// Find the last dispatch entry for this agent that has a result
	for (let i = state.dispatchHistory.length - 1; i >= 0; i--) {
		if (state.dispatchHistory[i].agent === agentName && state.dispatchHistory[i].result) {
			return state.dispatchHistory[i].result!;
		}
	}
	return null;
}

// ─── Orchestrator trigger ────────────────────────────────────────────────────

function triggerOrchestration(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: TeamState,
	reason: string,
	extraInfo?: string,
): void {
	if (state.isComplete) return;

	const context = buildOrchestratorContext(state, reason, extraInfo);
	pi.sendUserMessage(context, { deliverAs: "followUp" });
}

// ─── Agent spawn ─────────────────────────────────────────────────────────────

async function spawnAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agent: AgentRosterEntry,
	task: string,
	splitDirection?: string,
	splitFromSurfaceId?: string,
): Promise<{ surfaceId: string | null }> {
	// Generate context temp file
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-team-"));
	const contextFile = path.join(tmpDir, `context-${agent.name}.md`);
	const contextContent = [
		`You are the **${agent.name}** agent for task **${task}**.`,
		``,
		`Workflow directory: \`.pi/workflow/${task}/\``,
		`Write your report to: \`.pi/workflow/${task}/reports/${agent.name}.md\``,
		`Your mailbox: \`.pi/workflow/${task}/mailbox/${agent.name}.json\``,
		`Task description: \`.pi/workflow/${task}/task.md\``,
		`Other agents' reports: \`.pi/workflow/${task}/reports/\``,
		``,
		`**Do not start work yet.** The task description has not been provided yet — it will arrive as a dispatch message from the orchestrator. Wait for that message before doing anything.`,
		`When you complete your work, call the \`team_report\` tool with a summary.`,
		`If you need to challenge instructions or notify the orchestrator, use the \`team_message\` tool.`,
		`All messages you send go to the orchestrator, who decides the next steps.`,
	].join("\n");
	await fs.promises.writeFile(contextFile, contextContent, { encoding: "utf-8", mode: 0o600 });

	// Build the pi command
	const args: string[] = [];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (agent.thinking) args.push("--thinking", agent.thinking);
	args.push("--append-system-prompt", agent.filePath);
	args.push("--append-system-prompt", contextFile);

	// Set env vars for team identity
	const envPrefix = `PI_TEAM_TASK=${task} PI_TEAM_ROLE=${agent.name}`;

	// Try cmux split
	let surfaceId: string | null = null;
	try {
		surfaceId = await cmuxSplitPane(splitDirection ?? "right", splitFromSurfaceId);
	} catch {
		// cmux not available
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
			// Update dispatch history with result
			for (let i = state.dispatchHistory.length - 1; i >= 0; i--) {
				if (state.dispatchHistory[i].agent === msg.from && !state.dispatchHistory[i].result) {
					state.dispatchHistory[i].result = msg.summary ?? "";
					break;
				}
			}
			// Update agent status
			state.agentStatus[msg.from] = "done";
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
		const extraInfo = parts.join("\n\n");
		triggerOrchestration(pi, ctx, state, "Agent update", extraInfo);
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
		fs.writeFileSync(mp, "[]", { encoding: "utf-8" });
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

		process.on("exit", () => watcher.close());
	} catch {
		// fs.watch may fail on some systems
	}
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
			"Orchestrate the team by dispatching an agent with instructions or marking the task complete. " +
			"Use this to decide which agent should work next based on the current state of the team. " +
			"Only available when you are the orchestrator.",
		promptSnippet: "Dispatch an agent or complete the team task",
		promptGuidelines: [
			"Always dispatch one agent at a time. Wait for the agent to report back before dispatching another.",
			"When an agent reports completion, review their summary and decide the next step.",
			"If an agent raises a challenge or question, address it before continuing.",
			"Use 'complete' action only when the overall task is fully accomplished.",
			"You have a limited number of dispatches — use them wisely.",
			"Give each agent clear, specific instructions about what you need them to do.",
			"When dispatching an agent, include relevant context from previous agents' reports in the instructions.",
		],
		parameters: Type.Object({
			action: StringEnum(["dispatch", "complete"] as const, {
				description: "Action to take: 'dispatch' sends a task to an agent, 'complete' marks the overall task as done",
			}),
			agent: Type.Optional(Type.String({
				description: "Name of the agent to dispatch (required for 'dispatch' action)",
			})),
			instructions: Type.Optional(Type.String({
				description: "Clear instructions for the agent (required for 'dispatch' action). Include relevant context from previous agents' work.",
			})),
			summary: Type.Optional(Type.String({
				description: "Summary of what was accomplished overall (required for 'complete' action)",
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

			if (state.isComplete) {
				return {
					content: [{ type: "text", text: "Task is already marked as complete." }],
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

				// Check dispatch budget
				if (state.dispatchCount >= state.maxDispatches) {
					return {
						content: [{ type: "text", text: `Dispatch limit reached (${state.maxDispatches}). Use /team send to continue with a new budget.` }],
						isError: true,
					};
				}

				// Record dispatch
				state.dispatchCount++;
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

				// Re-spawn agent if surface is missing or stale (pane was closed or agent crashed)
				const existingSurfaceId = state.surfaceIds[params.agent];
				if (existingSurfaceId && !(await cmuxSurfaceExists(existingSurfaceId))) {
					delete state.surfaceIds[params.agent];
				}
				if (!state.surfaceIds[params.agent]) {
					const existingSurfaces = Object.values(state.surfaceIds);
					const lastSurface = existingSurfaces.length > 0 ? existingSurfaces[existingSurfaces.length - 1] : undefined;

					const { surfaceId } = await spawnAgent(
						pi, ctx, rosterEntry, task,
						existingSurfaces.length === 0 ? "right" : "down",
						lastSurface,
					);

					if (surfaceId) {
						state.surfaceIds[params.agent] = surfaceId;
						await cmuxEqualizeSplits();
					}
				}

				saveState(ctx.cwd, state);
				currentTeamState = state;

				const remaining = state.maxDispatches - state.dispatchCount;
				return {
					content: [{
						type: "text",
						text: `✅ Dispatched "${params.agent}" with instructions.\nDispatches: ${state.dispatchCount}/${state.maxDispatches} (${remaining} remaining)`,
					}],
				};
			}

			if (params.action === "complete") {
				if (!params.summary) {
					return {
						content: [{ type: "text", text: "Must provide a summary when completing the task." }],
						isError: true,
					};
				}

				state.isComplete = true;
				state.dispatchHistory.push({
					agent: "orchestrator",
					instructions: `Task completed: ${params.summary}`,
					timestamp: Date.now(),
					result: params.summary,
				});

				saveState(ctx.cwd, state);
				currentTeamState = state;

				// Notify all agents
				for (const agent of state.agents) {
					const mp = mailboxPath(ctx.cwd, task, agent.name);
					appendToMailbox(mp, {
						type: "shutdown",
						from: "orchestrator",
						to: agent.name,
						body: `Task "${task}" is complete: ${params.summary}`,
						timestamp: Date.now(),
					});
				}

				ctx.ui.setStatus("team-phase", ctx.ui.theme.fg("accent", "✅ done"));

				return {
					content: [{
						type: "text",
						text: `✅ Task "${task}" marked as complete: ${params.summary}`,
					}],
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${params.action}` }],
				isError: true,
			};
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

			// Write report file
			const rp = reportPath(ctx.cwd, task, role);
			fs.mkdirSync(path.dirname(rp), { recursive: true });
			const reportContent = [
				`# Report: ${role}`,
				"",
				`## Summary`,
				params.summary,
				"",
				...(params.questions && params.questions.length > 0
					? ["## Questions", ...params.questions.map((q) => `- ${q}`), ""]
					: []),
			].join("\n");
			fs.writeFileSync(rp, reportContent, { encoding: "utf-8" });

			// Update state
			const state = loadState(ctx.cwd, task);
			if (state) {
				state.agentStatus[role] = "done";
				// Update dispatch history result
				for (let i = state.dispatchHistory.length - 1; i >= 0; i--) {
					if (state.dispatchHistory[i].agent === role && !state.dispatchHistory[i].result) {
						state.dispatchHistory[i].result = params.summary;
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
	});

	// ─── team_message tool (all roles) ────────────────────────────────────

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
	});

	// ─── team_read_deliverables tool ──────────────────────────────────────

	pi.registerTool({
		name: "team_read_deliverables",
		label: "Read Team Deliverables",
		description:
			"Read the task description and all agent reports. Use at the start of your work to get " +
			"context from previous agents, or when the orchestrator asks you to review what's been done.",
		promptSnippet: "Read task description and agent reports",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const task = process.env.PI_TEAM_TASK ?? currentWorkerState?.task ?? currentTeamState?.task;

			if (!task) {
				return {
					content: [{ type: "text", text: "Not in a team session." }],
					isError: true,
				};
			}

			const dir = workflowDir(ctx.cwd, task);
			const parts: string[] = [];

			// Read task description
			const tfp = taskFilePath(ctx.cwd, task);
			if (fs.existsSync(tfp)) {
				const content = fs.readFileSync(tfp, "utf-8");
				parts.push(`## Task Description\n\n${content}`);
			}

			// Read all reports
			const rdir = reportsDir(ctx.cwd, task);
			if (fs.existsSync(rdir)) {
				const reportFiles = fs.readdirSync(rdir).filter((f) => f.endsWith(".md"));
				for (const rf of reportFiles) {
					const content = fs.readFileSync(path.join(rdir, rf), "utf-8");
					parts.push(`## ${rf}\n\n${content}`);
				}
			}

			if (parts.length === 0) {
				return { content: [{ type: "text", text: "No task description or reports found yet." }] };
			}

			return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }] };
		},
	});

	// ─── Session start: restore state ─────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Path 1: Worker with env vars (set by spawn)
		const envTask = process.env.PI_TEAM_TASK;
		const envRole = process.env.PI_TEAM_ROLE;

		if (envTask && envRole && envRole !== "orchestrator") {
			currentWorkerState = { task: envTask, role: envRole };
			saveWorkerState(pi, currentWorkerState);
			setupMailboxWatching(pi, ctx, envTask, envRole);
			pi.setSessionName(`⚪ ${envRole}: ${envTask}`);
			ctx.ui.notify(`Team session: ${envRole} for ${envTask}`, "info");
			return;
		}

		// Path 2: Orchestrator resume from session state
		const sessionTask = loadSessionTask(ctx);
		if (sessionTask) {
			const state = loadState(ctx.cwd, sessionTask);
			if (state) {
				currentTeamState = state;
				setupMailboxWatching(pi, ctx, sessionTask, "orchestrator");
				pi.setSessionName(`🔷 Orchestrator: ${sessionTask}`);

				if (state.isComplete) {
					ctx.ui.setStatus("team-phase", ctx.ui.theme.fg("accent", "✅ done"));
				} else {
					ctx.ui.setStatus("team-phase", ctx.ui.theme.fg("accent", `🔷 orchestrating (${state.dispatchCount}/${state.maxDispatches})`));
				}
			}
		}
	});

	// ─── Agent end: warn if agent didn't report ───────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		const task = process.env.PI_TEAM_TASK ?? currentWorkerState?.task;
		const role = process.env.PI_TEAM_ROLE ?? currentWorkerState?.role;

		if (!task || !role || role === "orchestrator") return;

		// Check if the worker reported via team_report
		const state = loadState(ctx.cwd, task);
		if (state && (state.agentStatus[role] === "working" || state.agentStatus[role] === "idle")) {
			const statusDesc = state.agentStatus[role] === "working" ? "ended without calling team_report" : "exited before being dispatched";
			// Worker ended without calling team_report, or exited while still idle — notify orchestrator
			const orchestratorMailbox = mailboxPath(ctx.cwd, task, "orchestrator");
			appendToMailbox(orchestratorMailbox, {
				type: "notify",
				from: role,
				to: "orchestrator",
				body: `Agent "${role}" ${statusDesc}. They may have encountered an issue. Consider re-dispatching with /team redo ${task} ${role}.`,
				timestamp: Date.now(),
			});

			// Mark as idle so they can be re-dispatched
			state.agentStatus[role] = "idle";
			delete state.surfaceIds[role];  // Surface is gone
			saveState(ctx.cwd, state);
		}
	});

	// ─── /team command ────────────────────────────────────────────────────

	pi.registerCommand("team", {
		description: "Manage dynamic multi-agent team workflows",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["init", "send", "status", "redo", "shutdown", "list", "history"];
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
						ctx.ui.notify("Usage: /team init <task-name> <agent>...", "warning");
						return;
					}

					if (agentNames.length === 0) {
						ctx.ui.notify("Usage: /team init <task-name> <agent>...\nSpecify at least one agent. Use /team list to see available agents.", "warning");
						return;
					}

					// Discover available agents
					const discovery = discoverAgents(ctx.cwd, "both");
					const roster: AgentRosterEntry[] = [];
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

					// Create workflow directory structure
					const dir = workflowDir(ctx.cwd, taskName);
					const mdir = mailboxDir(ctx.cwd, taskName);
					const rdir = reportsDir(ctx.cwd, taskName);
					fs.mkdirSync(dir, { recursive: true });
					fs.mkdirSync(mdir, { recursive: true });
					fs.mkdirSync(rdir, { recursive: true });

					// Initialize mailbox files
					for (const agent of roster) {
						const mp = path.join(mdir, `${agent.name}.json`);
						if (!fs.existsSync(mp)) {
							fs.writeFileSync(mp, "[]", { encoding: "utf-8" });
						}
					}
					// Orchestrator mailbox
					const omp = path.join(mdir, "orchestrator.json");
					if (!fs.existsSync(omp)) {
						fs.writeFileSync(omp, "[]", { encoding: "utf-8" });
					}

					// Initialize state
					const agentStatus: Record<string, "idle" | "working" | "done"> = {};
					for (const agent of roster) {
						agentStatus[agent.name] = "idle";
					}

					currentTeamState = {
						task: taskName,
						role: "orchestrator",
						agents: roster,
						agentStatus,
						surfaceIds: {},
						taskDescription: "",
						dispatchHistory: [],
						isComplete: false,
						dispatchCount: 0,
						maxDispatches: MAX_DISPATCHES,
					};
					saveState(ctx.cwd, currentTeamState);
					saveSessionState(pi, currentTeamState);

					// Start watching orchestrator mailbox
					setupMailboxWatching(pi, ctx, taskName, "orchestrator");

					// Spawn all agents in cmux panes
					let lastSuccessfulSurfaceId: string | undefined;
					for (let i = 0; i < roster.length; i++) {
						const agent = roster[i];
						const isFirstAgent = i === 0;
						const splitDir = isFirstAgent ? "right" : "down";

						const { surfaceId } = await spawnAgent(
							pi, ctx, agent, taskName,
							splitDir, isFirstAgent ? undefined : lastSuccessfulSurfaceId,
						);

						if (surfaceId) {
							currentTeamState.surfaceIds[agent.name] = surfaceId;
							lastSuccessfulSurfaceId = surfaceId;
						}
					}

					// Equalize pane widths
					if (Object.keys(currentTeamState.surfaceIds).length > 0) {
						await cmuxEqualizeSplits();
					}

					saveState(ctx.cwd, currentTeamState);

					// Name the session
					pi.setSessionName(`🔷 Orchestrator: ${taskName}`);
					ctx.ui.setStatus("team-phase", ctx.ui.theme.fg("accent", `🔷 orchestrating (0/${MAX_DISPATCHES})`));

					const agentList = roster.map((a) => `  🔵 ${a.name} — ${a.description}`).join("\n");
					ctx.ui.notify(`Team initialized for "${taskName}"\nAgents:\n${agentList}\n\nUse /team send ${taskName} <task-details> to start.`, "info");
					await cmuxLog("info", `Team initialized for ${taskName} with agents: ${roster.map((a) => a.name).join(", ")}`);
					break;
				}

				// ─── /team send ─────────────────────────────────────────
				case "send": {
					const taskName = parts[1];
					const taskDetails = parts.slice(2).join(" ");

					if (!taskName || !taskDetails) {
						ctx.ui.notify("Usage: /team send <task-name> <task-details>", "warning");
						return;
					}

					const state = currentTeamState ?? loadState(ctx.cwd, taskName);
					if (!state) {
						ctx.ui.notify(`No workflow found for "${taskName}". Run /team init first.`, "warning");
						return;
					}

					if (state.isComplete) {
						ctx.ui.notify(`Task "${taskName}" is already complete.`, "warning");
						return;
					}

					// Update task description
					state.taskDescription = taskDetails;
					saveState(ctx.cwd, state);
					currentTeamState = state;

					// Write task.md
					const tfp = taskFilePath(ctx.cwd, taskName);
					fs.writeFileSync(tfp, taskDetails, { encoding: "utf-8" });

					// Trigger orchestration
					triggerOrchestration(pi, ctx, state, "New task from user");
					ctx.ui.notify(`Task sent to orchestrator for "${taskName}"`, "info");
					await cmuxLog("info", `Task sent for ${taskName}: ${taskDetails.substring(0, 100)}...`);
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

					const lines: string[] = [`📋 Workflow: ${taskName}`];

					if (state.taskDescription) {
						lines.push(`\n📝 Task: ${state.taskDescription}`);
					}

					lines.push("\n👥 Agents:");
					for (const agent of state.agents) {
						const status = state.agentStatus[agent.name] ?? "idle";
						const icon = statusIcon(status);
						const surface = state.surfaceIds[agent.name] ? ` (pane: ${state.surfaceIds[agent.name]})` : "";
						const lastResult = getLastReportSummary(agent.name, state);
						const resultLine = status === "done" && lastResult ? `\n     Last: ${lastResult.substring(0, 80)}${lastResult.length > 80 ? "..." : ""}` : "";
						lines.push(`  ${icon} ${agent.name} — ${status}${surface}${resultLine}`);
					}

					// Reports
					const rdir = reportsDir(ctx.cwd, taskName);
					if (fs.existsSync(rdir)) {
						const reportFiles = fs.readdirSync(rdir).filter((f) => f.endsWith(".md"));
						if (reportFiles.length > 0) {
							lines.push("\n📄 Reports:");
							for (const rf of reportFiles) {
								lines.push(`  ✅ ${rf}`);
							}
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

					lines.push(`\n🔄 Complete: ${state.isComplete ? "Yes ✅" : "No"}`);
					lines.push(`📊 Dispatches: ${state.dispatchCount}/${state.maxDispatches}`);

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
					const instructions = message || `Re-do your previous task. Review your earlier report and improve on it.`;

					state.agentStatus[agentName] = "working";
					state.dispatchCount++;
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

					// Re-spawn agent if surface is missing or stale (pane was closed or agent crashed)
					const existingSurfaceId = state.surfaceIds[agentName];
					if (existingSurfaceId && !(await cmuxSurfaceExists(existingSurfaceId))) {
						delete state.surfaceIds[agentName];
					}
					if (!state.surfaceIds[agentName]) {
						const existingSurfaces = Object.values(state.surfaceIds);
						const lastSurface = existingSurfaces.length > 0 ? existingSurfaces[existingSurfaces.length - 1] : undefined;

						const { surfaceId } = await spawnAgent(
							pi, ctx, rosterEntry, taskName,
							existingSurfaces.length === 0 ? "right" : "down",
							lastSurface,
						);

						if (surfaceId) {
							state.surfaceIds[agentName] = surfaceId;
							await cmuxEqualizeSplits();
						}
					}

					saveState(ctx.cwd, state);
					currentTeamState = state;

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

						// Close cmux panes
						for (const [agentName, surfaceId] of Object.entries(state.surfaceIds)) {
							await cmuxCloseSurface(surfaceId);
						}

						state.isComplete = true;
						saveState(ctx.cwd, state);
					}

					ctx.ui.setStatus("team-phase", undefined);
					ctx.ui.notify(`Shutdown sent for "${taskName}"`, "info");
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
						const tools = agent.tools ? ` (tools: ${agent.tools.join(", ")})` : "";
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

				default: {
					ctx.ui.notify(
						"Unknown command. Usage:\n" +
							"  /team init <task-name> <agent>...\n" +
							"  /team send <task-name> <task-details>\n" +
							"  /team status [task-name]\n" +
							"  /team redo <task-name> <agent> [message]\n" +
							"  /team shutdown [task-name]\n" +
							"  /team list\n" +
							"  /team history [task-name]",
						"info",
					);
				}
			}
		},
	});
}
