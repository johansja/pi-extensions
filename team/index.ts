/**
 * Team Extension
 *
 * Orchestrates multi-role development workflows in cmux panes.
 * Each role (planner, coder, reviewer) runs as a full pi session
 * with its own pane, model, tools, and mailbox.
 *
 * Communication between roles is file-based via .pi/workflow/<task>/mailbox/.
 * The orchestrator manages pane lifecycle via the cmux socket API.
 *
 * Usage:
 *   /team init <task-name>           — Create workflow, become orchestrator
 *   /team spawn <role> <task-name>   — Spawn a role in a new cmux pane
 *   /team status [task-name]         — Show workflow state
 *   /team send <role> <task-name> <msg> — Send a message to a role's mailbox
 *   /team approve <task-name>        — Approve plan, advance to implementing
 *   /team reject <task-name> <fb>    — Reject plan, send feedback to planner
 *   /team redo <role> <task-name>    — Re-dispatch a role
 *   /team shutdown <task-name>       — Graceful shutdown of all workers
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { discoverAgents, type AgentConfig, type AgentDiscoveryResult } from "./agents.js";

const execFileAsync = promisify(execFile);

// ─── Phase tracking constants ────────────────────────────────────────────────

const PHASES = ["planning", "plan-review", "implementing", "reviewing", "fixing", "final-review", "done"] as const;
type WorkflowPhase = (typeof PHASES)[number];

interface PhaseEntry {
	phase: WorkflowPhase;
	timestamp: number;
	by: string;
}

interface PhaseData {
	phase: WorkflowPhase;
	history: PhaseEntry[];
	reviewCycles: number;
}

interface TeamMessage {
	type: "dispatch" | "challenge" | "done" | "notify" | "shutdown" | "ack";
	from: string;
	to: string;
	body?: string;
	task?: string;
	summary?: string;
	timestamp: number;
	referenceId?: string;
}

interface TeamState {
	task: string;
	role: "orchestrator";
	spawnedRoles: string[];
	surfaceIds: Record<string, string>; // role -> cmux surface_id
	phase: (typeof PHASES)[number];
	completedRoles: string[];
	reviewRound: number;
	autoOrchestrate: boolean; // whether to auto-advance the pipeline
}

interface WorkerState {
	task: string;
	role: string;
}

// ─── Mailbox helpers ─────────────────────────────────────────────────────────

function workflowDir(cwd: string, task: string): string {
	return path.join(cwd, ".pi", "workflow", task);
}

function mailboxDir(cwd: string, task: string): string {
	return path.join(workflowDir(cwd, task), "mailbox");
}

function mailboxPath(cwd: string, task: string, role: string): string {
	return path.join(mailboxDir(cwd, task), `${role}.json`);
}

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

// ─── Phase file helpers ──────────────────────────────────────────────────────

function workflowPhasePath(cwd: string, task: string): string {
	return path.join(workflowDir(cwd, task), "phase.json");
}

function readPhase(phaseFile: string): PhaseData {
	try {
		const content = fs.readFileSync(phaseFile, "utf-8").trim();
		if (!content) {
			return { phase: "planning", history: [], reviewCycles: 0 };
		}
		return JSON.parse(content);
	} catch {
		return { phase: "planning", history: [], reviewCycles: 0 };
	}
}

function writePhase(phaseFile: string, data: PhaseData): void {
	fs.writeFileSync(phaseFile, JSON.stringify(data, null, 2), { encoding: "utf-8" });
}

// ─── Workflow initialization ─────────────────────────────────────────────────

function initWorkflow(cwd: string, task: string): void {
	const dir = workflowDir(cwd, task);
	const mdir = mailboxDir(cwd, task);

	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(mdir, { recursive: true });

	// Initialize mailbox files for all known roles
	const roles = ["orchestrator", "planner", "coder", "reviewer"];
	for (const role of roles) {
		const mp = path.join(mdir, `${role}.json`);
		if (!fs.existsSync(mp)) {
			fs.writeFileSync(mp, "[]", { encoding: "utf-8" });
		}
	}

	// Initialize phase tracking
	const phaseFile = path.join(dir, "phase.json");
	if (!fs.existsSync(phaseFile)) {
		writePhase(phaseFile, {
			phase: "planning",
			history: [{ phase: "planning", timestamp: Date.now(), by: "orchestrator" }],
			reviewCycles: 0,
		});
	}
}

// ─── Session state persistence ───────────────────────────────────────────────

function saveOrchestratorState(pi: ExtensionAPI, state: TeamState): void {
	pi.appendEntry("team-orchestrator", state);
}

function saveWorkerState(pi: ExtensionAPI, state: WorkerState): void {
	pi.appendEntry("team-worker", state);
}

function loadOrchestratorState(ctx: ExtensionContext): TeamState | null {
	const entries = ctx.sessionManager.getEntries();
	const entry = entries
		.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "team-orchestrator")
		.pop() as { data?: TeamState } | undefined;
	if (!entry?.data) return null;
	// Ensure new fields have defaults when loading old state
	const state = entry.data;
	return {
		task: state.task,
		role: "orchestrator",
		spawnedRoles: state.spawnedRoles ?? [],
		surfaceIds: state.surfaceIds ?? {},
		phase: state.phase ?? "planning",
		completedRoles: state.completedRoles ?? [],
		reviewRound: state.reviewRound ?? 0,
		autoOrchestrate: state.autoOrchestrate ?? true,
	};
}

function loadWorkerState(ctx: ExtensionContext): WorkerState | null {
	const entries = ctx.sessionManager.getEntries();
	const entry = entries
		.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "team-worker")
		.pop() as { data?: WorkerState } | undefined;
	return entry?.data ?? null;
}

// ─── cmux CLI helpers ────────────────────────────────────────────────────────

async function cmuxExec(...args: string[]): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execFileAsync("cmux", args, { timeout: 10000 });
	} catch (err: any) {
		throw new Error(`cmux ${args.join(" ")} failed: ${err.message}`);
	}
}

async function cmuxSplitPane(direction: string = "right"): Promise<string | null> {
	try {
		const { stdout } = await cmuxExec("new-split", direction);
		// Parse surface from output like "OK surface:47 workspace:2"
		const match = stdout.match(/surface:(\d+)/i);
		return match ? `surface:${match[1]}` : null;
	} catch {
		// cmux might not be running
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

async function cmuxSendKeyToSurface(surfaceId: string, key: string): Promise<void> {
	try {
		await cmuxExec("send-key", "--surface", surfaceId, key);
	} catch {
		// Best effort
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
		// Best effort — non-cmux environments will silently ignore
	}
}

async function cmuxNotify(title: string, body: string): Promise<void> {
	try {
		await cmuxExec("notify", "--title", title, "--body", body);
	} catch {
		// Best effort
	}
}

// ─── Notify helper ───────────────────────────────────────────────────────────

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		// Windows
		return;
	} else if (process.env.KITTY_WINDOW_ID) {
		process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
		process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
	} else {
		process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
	}
}

// ─── Default dispatch messages ───────────────────────────────────────────────

function getDefaultDispatchMessage(role: string, task: string): string {
	switch (role) {
		case "planner":
			return `Research and create an implementation plan for task "${task}". Write your plan to .pi/workflow/${task}/plan.md, then advance the workflow phase.`;
		case "coder":
			return `Read .pi/workflow/${task}/plan.md and implement it. Write implementation details to .pi/workflow/${task}/implementation.md.`;
		case "reviewer":
			return `Review the implementation against .pi/workflow/${task}/plan.md. Read .pi/workflow/${task}/implementation.md for what was done. Write findings to .pi/workflow/${task}/review.md.`;
		default:
			return `Start working on task "${task}".`;
	}
}

// ─── Deliverable mapping ──────────────────────────────────────────────────────

const DELIVERABLES: Record<string, string> = {
	planner: "plan.md",
	coder: "implementation.md",
	reviewer: "review.md",
};

function deliverableExists(cwd: string, task: string, role: string): boolean {
	const filename = DELIVERABLES[role];
	if (!filename) return true; // roles without defined deliverables (e.g. orchestrator)
	return fs.existsSync(path.join(workflowDir(cwd, task), filename));
}

// ─── Spawn coder helper (used by /team approve and potentially other places) ─

async function spawnCoder(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: TeamState,
): Promise<void> {
	const discovery = discoverAgents(ctx.cwd, "both");
	const agent = discovery.agents.find((a) => a.name === "coder");
	if (!agent) {
		ctx.ui.notify(`⚠️ No coder agent found. Spawn manually with /team spawn coder ${state.task}`, "warning");
		return;
	}

	state.phase = "implementing";
	saveOrchestratorState(pi, state);
	updateOrchestratorStatus(ctx, state);

	await logEvent(ctx, "✅ Plan approved. Spawning coder...", "success");

	const plannerSurface = state.surfaceIds["planner"];
	const { surfaceId } = await spawnAgent(pi, ctx, agent, state.task,
		`Read .pi/workflow/${state.task}/plan.md and implement it.`,
		plannerSurface ? "down" : "right",
		plannerSurface ?? undefined);

	if (!state.spawnedRoles.includes("coder")) state.spawnedRoles.push("coder");
	if (surfaceId) state.surfaceIds["coder"] = surfaceId;
	saveOrchestratorState(pi, state);

	// Equalize all pane widths so each panel gets equal space
	if (surfaceId) await cmuxEqualizeSplits();

	// Update phase.json
	const phaseFile = workflowPhasePath(ctx.cwd, state.task);
	const phaseData = readPhase(phaseFile);
	phaseData.phase = "implementing";
	phaseData.history.push({ phase: "implementing", timestamp: Date.now(), by: "orchestrator" });
	writePhase(phaseFile, phaseData);

	// Dispatch task to coder's mailbox
	const coderMailbox = mailboxPath(ctx.cwd, state.task, "coder");
	appendToMailbox(coderMailbox, {
		type: "dispatch",
		from: "orchestrator",
		to: "coder",
		task: `Read .pi/workflow/${state.task}/plan.md and implement it.`,
		timestamp: Date.now(),
	});
}

// ─── Auto-orchestration ──────────────────────────────────────────────────────

async function handleRoleDone(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	completedRole: string,
	summary: string,
): Promise<void> {
	const state = loadOrchestratorState(ctx);
	if (!state) return;

	// Mark role as completed
	if (!state.completedRoles.includes(completedRole)) {
		state.completedRoles.push(completedRole);
	}

	// Change 8: Deliverable existence check
	if (!deliverableExists(ctx.cwd, state.task, completedRole)) {
		const deliverable = DELIVERABLES[completedRole];
		pi.sendUserMessage(
			`⚠️ ${completedRole} reported done but ${deliverable ?? "deliverable"} was not found. Use /team redo ${completedRole} ${state.task} to re-dispatch.`
		);
		saveOrchestratorState(pi, state);
		return;
	}

	// Determine what to do next based on phase and which role finished
	if (!state.autoOrchestrate) {
		// Manual mode — just notify the human
		pi.sendUserMessage(`✅ ${completedRole} is done: ${summary}\nUse /team spawn to continue the pipeline.`);
		saveOrchestratorState(pi, state);
		return;
	}

	const discovery = discoverAgents(ctx.cwd, "both");

	switch (completedRole) {
		case "planner": {
			// Change 6: Planner done → advance to plan-review phase, NOT implementing.
			// Wait for human approval before spawning the coder.
			state.phase = "plan-review";
			saveOrchestratorState(pi, state);
			updateOrchestratorStatus(ctx, state);

			// Update phase.json
			const phaseFile = workflowPhasePath(ctx.cwd, state.task);
			const phaseData = readPhase(phaseFile);
			phaseData.phase = "plan-review";
			phaseData.history.push({ phase: "plan-review", timestamp: Date.now(), by: "orchestrator" });
			writePhase(phaseFile, phaseData);

			await logEvent(ctx, "📋 Planner done. Plan ready for human review.", "info");
			pi.sendUserMessage(
				`📋 Plan is ready for review. Use /team approve ${state.task} to proceed or /team reject ${state.task} <feedback> to request changes.`
			);
			break;
		}

		case "coder": {
			// Coder done → spawn or re-dispatch reviewer
			state.phase = "reviewing";
			state.reviewRound++;
			saveOrchestratorState(pi, state);
			updateOrchestratorStatus(ctx, state);

			const reviewerSurfaceId = state.surfaceIds["reviewer"];
			if (reviewerSurfaceId) {
				// Re-use existing reviewer pane — just send dispatch to mailbox
				await logEvent(ctx, `✅ Coder done. Re-dispatching reviewer (round ${state.reviewRound})...`, "success");
				const reviewerMailbox = mailboxPath(ctx.cwd, state.task, "reviewer");
				appendToMailbox(reviewerMailbox, {
					type: "dispatch",
					from: "orchestrator",
					to: "reviewer",
					task: `Review the implementation against .pi/workflow/${state.task}/plan.md. Read .pi/workflow/${state.task}/implementation.md for what was done.`,
					timestamp: Date.now(),
				});
				ctx.ui.notify(`✅ Coder done. Re-dispatching reviewer (round ${state.reviewRound})...`, "info");
			} else {
				// No existing reviewer — spawn new pane
				const agent = discovery.agents.find((a) => a.name === "reviewer");
				if (!agent) {
					ctx.ui.notify(`✅ Coder is done: ${summary}\n⚠️ No reviewer agent found. Spawn manually with /team spawn reviewer ${state.task}`, "info");
					break;
				}
				await logEvent(ctx, `✅ Coder done. Spawning reviewer (round ${state.reviewRound})...`, "success");
				const lastAgentSurface = state.surfaceIds["coder"] ?? state.surfaceIds["planner"];
				const { surfaceId } = await spawnAgent(pi, ctx, agent, state.task,
					`Review the implementation against .pi/workflow/${state.task}/plan.md. Read .pi/workflow/${state.task}/implementation.md for what was done.`,
					lastAgentSurface ? "down" : "right",
					lastAgentSurface ?? undefined);
				if (!state.spawnedRoles.includes("reviewer")) state.spawnedRoles.push("reviewer");
				if (surfaceId) state.surfaceIds["reviewer"] = surfaceId;

				// Equalize all pane widths so each panel gets equal space
				if (surfaceId) await cmuxEqualizeSplits();

				// Dispatch task to reviewer's mailbox
				const reviewerMailbox = mailboxPath(ctx.cwd, state.task, "reviewer");
				appendToMailbox(reviewerMailbox, {
					type: "dispatch",
					from: "orchestrator",
					to: "reviewer",
					task: `Review the implementation against .pi/workflow/${state.task}/plan.md. Read .pi/workflow/${state.task}/implementation.md for what was done.`,
					timestamp: Date.now(),
				});
			}
			saveOrchestratorState(pi, state);
			break;
		}

		case "reviewer": {
			// Reviewer done → check if there are critical/important findings
			// Read review.md to decide next step
			const reviewPath = path.join(ctx.cwd, `.pi/workflow/${state.task}/review.md`);
			let hasCriticalOrImportant = false;
			try {
				const reviewContent = fs.readFileSync(reviewPath, "utf-8");
				// Check for unchecked critical or important items
				hasCriticalOrImportant = /^### (Critical|Important).*\n(?:- \[ \])/m.test(reviewContent);
			} catch {
				// If we can't read the review, assume findings exist
				hasCriticalOrImportant = true;
			}

			if (hasCriticalOrImportant && state.reviewRound < 3) {
				// Re-dispatch coder to fix review findings
				const agent = discovery.agents.find((a) => a.name === "coder");
				if (!agent) {
					pi.sendUserMessage(`✅ Reviewer done with findings. ⚠️ No coder agent found to fix them.`);
					break;
				}
				state.phase = "fixing";
				saveOrchestratorState(pi, state);
				updateOrchestratorStatus(ctx, state);
				// Re-use existing coder pane if available, otherwise spawn new
				const coderSurfaceId = state.surfaceIds["coder"];
				if (coderSurfaceId) {
					await logEvent(ctx, "✅ Reviewer done with findings. Re-dispatching coder to fix them...", "warning");
					// Send message to existing coder's mailbox
					const coderMailbox = mailboxPath(ctx.cwd, state.task, "coder");
					appendToMailbox(coderMailbox, {
						type: "dispatch",
						from: "orchestrator",
						to: "coder",
						task: `Address the review findings in .pi/workflow/${state.task}/review.md. Fix all Critical and Important items.`,
						timestamp: Date.now(),
					});
					ctx.ui.notify("✅ Reviewer done with findings. Re-dispatching coder to fix them...", "info");
				} else {
					await logEvent(ctx, "✅ Reviewer done with findings. Spawning coder to fix them...", "warning");
					ctx.ui.notify("✅ Reviewer done with findings. Spawning coder to fix them...", "info");
					const { surfaceId: newCoderSurfaceId } = await spawnAgent(pi, ctx, agent, state.task,
						`Address the review findings in .pi/workflow/${state.task}/review.md. Fix all Critical and Important items.`);
					if (!state.spawnedRoles.includes("coder")) state.spawnedRoles.push("coder");
					if (newCoderSurfaceId) state.surfaceIds["coder"] = newCoderSurfaceId;

					// Equalize all pane widths so each panel gets equal space
					if (newCoderSurfaceId) await cmuxEqualizeSplits();

					// Dispatch task to coder's mailbox
					const coderMailbox = mailboxPath(ctx.cwd, state.task, "coder");
					appendToMailbox(coderMailbox, {
						type: "dispatch",
						from: "orchestrator",
						to: "coder",
						task: `Address the review findings in .pi/workflow/${state.task}/review.md. Fix all Critical and Important items.`,
						timestamp: Date.now(),
					});
				}
				saveOrchestratorState(pi, state);
			} else {
				// No critical findings, or max review rounds reached → final review by planner
				state.phase = "final-review";
				saveOrchestratorState(pi, state);
				updateOrchestratorStatus(ctx, state);
				await logEvent(ctx, "✅ Reviewer done. No critical findings remaining.", "success");
				pi.sendUserMessage(`✅ Reviewer done. No critical findings remaining (round ${state.reviewRound}).\nReady for final review. Use /team send planner ${state.task} "Do a final review" or /team shutdown ${state.task} to close.`);
			}
			break;
		}

		default:
			pi.sendUserMessage(`✅ ${completedRole} is done: ${summary}`);
	}
}

// ─── Status update helpers ──────────────────────────────────────────────────

function updateOrchestratorStatus(ctx: ExtensionContext, state: TeamState): void {
	const phaseIcons: Record<string, string> = {
		"planning": "📋",
		"plan-review": "👀",
		"implementing": "🔨",
		"reviewing": "🔍",
		"fixing": "🔧",
		"final-review": "🔎",
		"done": "✅",
	};
	const icon = phaseIcons[state.phase] ?? "📋";
	ctx.ui.setStatus("team-phase", ctx.ui.theme.fg("accent", `${icon} ${state.phase}`));
}

async function logEvent(ctx: ExtensionContext, message: string, level: string = "info"): Promise<void> {
	try {
		await cmuxExec("log", "--level", level, "--source", "team", "--", message);
	} catch {
		// cmux not available
	}
}

// ─── Mailbox message processing ─────────────────────────────────────────────

function processMailboxMessages(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	role: string,
	messages: TeamMessage[],
): void {
	for (const msg of messages) {
		if (msg.type === "dispatch") {
			pi.sendUserMessage(msg.task ?? msg.body ?? "New task from orchestrator", { deliverAs: "followUp" });
		} else if (msg.type === "challenge") {
			pi.sendUserMessage(`⚠️ Challenge from ${msg.from}: ${msg.body}`, { deliverAs: "followUp" });
		} else if (msg.type === "done") {
			if (role === "orchestrator") {
				handleRoleDone(pi, ctx, msg.from, msg.summary ?? "");
			} else {
				pi.sendUserMessage(`✅ ${msg.from} is done: ${msg.summary}`, { deliverAs: "followUp" });
			}
		} else if (msg.type === "notify") {
			ctx.ui.notify(`📢 ${msg.from}: ${msg.body}`, "info");
		} else if (msg.type === "ack") {
			pi.sendUserMessage(`✅ ${msg.from} acknowledged: ${msg.body}`, { deliverAs: "followUp" });
		} else if (msg.type === "shutdown") {
			ctx.ui.notify("🛑 Shutdown requested by orchestrator. Wrapping up.", "info");
		}
	}
}

// ─── Mailbox watching ────────────────────────────────────────────────────────

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

	// Check for existing messages (e.g., dispatch written before fs.watch was set up)
	const existingMessages = readMailbox(mp);
	if (existingMessages.length > 0) {
		processMailboxMessages(pi, ctx, task, role, existingMessages);
		clearMailbox(mp);
		lastSize = 0; // Reset since we cleared the mailbox
	}

	try {
		const watcher = fs.watch(mp, () => {
			try {
				const stat = fs.statSync(mp);
				if (stat.size === lastSize) return;
				lastSize = stat.size;

				const messages = readMailbox(mp);
				if (messages.length === 0) return;

				processMailboxMessages(pi, ctx, task, role, messages);
				clearMailbox(mp);
			} catch {
				// Mailbox file might be temporarily unavailable
			}
		});

		// Clean up watcher on process exit
		process.on("exit", () => watcher.close());
	} catch {
		// fs.watch may fail on some systems
	}
}

// ─── Agent spawn ─────────────────────────────────────────────────────────────

async function spawnAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agent: AgentConfig,
	task: string,
	initialMessage?: string,
	splitDirection?: string,
	splitFromSurfaceId?: string,
): Promise<{ surfaceId: string | null }> {
	// No auto-dispatch — the new pi session starts idle and watches its mailbox.
	// The orchestrator (or auto-orchestration logic) will send a dispatch
	// when it's time for this role to begin work.

	// Generate task context temp file
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-team-"));
	const contextFile = path.join(tmpDir, `context-${agent.name}.md`);
	const contextContent = [
		`You are the **${agent.name}** for task **${task}**.`,
		``,
		`Workflow directory: \`.pi/workflow/${task}/\``,
		`Write deliverables to: \`.pi/workflow/${task}/\``,
		`Your mailbox: \`.pi/workflow/${task}/mailbox/${agent.name}.json\``,
		``,
		`Available deliverables to read:`,
		`- \`.pi/workflow/${task}/plan.md\` (from planner)`,
		`- \`.pi/workflow/${task}/review.md\` (from reviewer)`,
		`- \`.pi/workflow/${task}/implementation.md\` (from coder)`,
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

	// Try cmux split — split from the specified surface or the current one
	let surfaceId: string | null = null;
	try {
		const direction = splitDirection ?? "right";
		if (splitFromSurfaceId) {
			// Split from a specific surface (e.g., the last agent pane)
			const { stdout } = await cmuxExec("new-split", direction, "--surface", splitFromSurfaceId);
			const match = stdout.match(/surface:(\d+)/i);
			surfaceId = match ? `surface:${match[1]}` : null;
		} else {
			surfaceId = await cmuxSplitPane(direction);
		}
	} catch {
		// cmux not available
	}

	if (surfaceId) {
		// Wait a moment for the new pane to be ready
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Send the pi command to the new surface
		// cmux send-surface interprets \n as Enter
		const command = `${envPrefix} pi ${args.join(" ")}\n`;
		await cmuxSendToSurface(surfaceId, command);

		// Rename the tab
		const icons: Record<string, string> = {
			planner: "🔵",
			coder: "🟢",
			reviewer: "🟡",
		};
		const tabTitle = `${icons[agent.name] ?? "⚪"} ${agent.name}: ${task}`;
		await cmuxRenameTab(surfaceId, tabTitle);
	} else {
		// No cmux — print the command for manual execution
		const command = `${envPrefix} pi ${args.join(" ")}`;
		ctx.ui.notify(`cmux not available. Run manually:\n${command}`, "info");
	}

	return { surfaceId };
}

// ─── Main extension ──────────────────────────────────────────────────────────

export default function teamExtension(pi: ExtensionAPI) {
	let currentTeamState: TeamState | null = null;
	let currentWorkerState: WorkerState | null = null;

	// ─── Register the team_message tool ────────────────────────────────────

	pi.registerTool({
		name: "team_message",
		label: "Team Message",
		description: "Send a message to another role in your team (challenge, notify, etc.)",
		promptSnippet: "Send a message to a team member",
		parameters: Type.Object({
			to: StringEnum(["planner", "coder", "reviewer", "orchestrator"] as const, {
				description: "Role to send the message to",
			}),
			type: StringEnum(["challenge", "notify", "ack"] as const, {
				description: "Type of message: challenge (disagreement/concern), notify (informational), or ack (acknowledge receipt/action)",
			}),
			body: Type.String({ description: "Message content" }),
			referenceTo: Type.Optional(Type.String({ description: "Role whose message you're acknowledging" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = process.env.PI_TEAM_TASK ?? currentWorkerState?.task ?? currentTeamState?.task;
			const role = process.env.PI_TEAM_ROLE ?? currentWorkerState?.role ?? currentTeamState?.role;

			if (!task || !role) {
				return {
					content: [{ type: "text", text: "Not in a team session. Use /team commands to set up." }],
					isError: true,
				};
			}

			const mp = mailboxPath(ctx.cwd, task, params.to);
			appendToMailbox(mp, {
				type: params.type,
				from: role,
				to: params.to,
				body: params.body,
				timestamp: Date.now(),
				referenceId: params.referenceTo,
			});

			return {
				content: [{ type: "text", text: `✉️ ${params.type} sent to ${params.to}` }],
			};
		},
	});

	// ─── Register the team_advance_phase tool (Change 5: includes "plan-review") ──

	pi.registerTool({
		name: "team_advance_phase",
		label: "Advance Workflow Phase",
		description: "Advance the team workflow to the next phase. Call when your deliverable is complete.",
		promptSnippet: "Advance workflow to next phase after completing deliverable",
		parameters: Type.Object({
			nextPhase: StringEnum(["plan-review", "implementing", "reviewing", "fixing", "final-review", "done"] as const, {
				description: "The next workflow phase to advance to",
			}),
			summary: Type.String({ description: "Brief summary of what was accomplished" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = process.env.PI_TEAM_TASK ?? currentWorkerState?.task ?? currentTeamState?.task;
			const role = process.env.PI_TEAM_ROLE ?? currentWorkerState?.role ?? currentTeamState?.role;

			if (!task || !role) {
				return {
					content: [{ type: "text", text: "Not in a team session." }],
					isError: true,
				};
			}

			const phaseFile = workflowPhasePath(ctx.cwd, task);
			const phaseData = readPhase(phaseFile);
			const currentIdx = PHASES.indexOf(phaseData.phase);
			const nextIdx = PHASES.indexOf(params.nextPhase);

			if (nextIdx <= currentIdx) {
				return {
					content: [{ type: "text", text: `Cannot go backwards from ${phaseData.phase} to ${params.nextPhase}.` }],
					isError: true,
				};
			}
			if (nextIdx > currentIdx + 1 && params.nextPhase !== "done") {
				return {
					content: [{ type: "text", text: `Cannot skip from ${phaseData.phase} to ${params.nextPhase}. Next phase is ${PHASES[currentIdx + 1]}.` }],
					isError: true,
				};
			}

			const prevPhase = phaseData.phase;
			phaseData.phase = params.nextPhase;
			phaseData.history.push({ phase: params.nextPhase, timestamp: Date.now(), by: role });
			if (params.nextPhase === "fixing") phaseData.reviewCycles++;
			writePhase(phaseFile, phaseData);

			// Notify all roles via their mailboxes
			const roles = ["orchestrator", "planner", "coder", "reviewer"];
			for (const r of roles) {
				const mp = mailboxPath(ctx.cwd, task, r);
				appendToMailbox(mp, {
					type: "notify",
					from: role,
					to: r,
					body: `Workflow advanced to **${params.nextPhase}** by ${role}. ${params.summary}`,
					timestamp: Date.now(),
				});
			}

			return {
				content: [{ type: "text", text: `✅ Phase advanced: ${prevPhase} → ${params.nextPhase}` }],
			};
		},
	});

	// ─── questionnaire tool already exists as a built-in pi tool ───────────
	// Change 4: The planner references the built-in questionnaire tool in its prompt.
	// No need to re-register it here — it's available natively to all agents.

	// ─── Register the team_read_deliverables tool ──────────────────────────

	pi.registerTool({
		name: "team_read_deliverables",
		label: "Read Team Deliverables",
		description: "Read all available workflow deliverables (plan, review, implementation). Use at the start of your work to get context from other roles.",
		promptSnippet: "Read deliverables from other team roles",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const task = process.env.PI_TEAM_TASK ?? currentWorkerState?.task ?? currentTeamState?.task;
			const role = process.env.PI_TEAM_ROLE ?? currentWorkerState?.role ?? currentTeamState?.role;

			if (!task || !role) {
				return {
					content: [{ type: "text", text: "Not in a team session." }],
					isError: true,
				};
			}

			const dir = workflowDir(ctx.cwd, task);
			const deliverables = [
				{ name: "plan.md", from: "planner", desc: "Implementation plan" },
				{ name: "implementation.md", from: "coder", desc: "Implementation details" },
				{ name: "review.md", from: "reviewer", desc: "Review findings" },
			];

			const parts: string[] = [];
			for (const d of deliverables) {
				const filePath = path.join(dir, d.name);
				if (fs.existsSync(filePath)) {
					const content = fs.readFileSync(filePath, "utf-8");
					parts.push(`## ${d.name} (from ${d.from} — ${d.desc})\n\n${content}`);
				}
			}

			if (parts.length === 0) {
				return { content: [{ type: "text", text: "No deliverables found yet." }] };
			}

			return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }] };
		},
	});

	// ─── Session start: restore state for subagents and orchestrators ──────

	pi.on("session_start", async (_event, ctx) => {
		// Path 1: Subagent with env vars (set by spawn)
		const envTask = process.env.PI_TEAM_TASK;
		const envRole = process.env.PI_TEAM_ROLE;

		if (envTask && envRole) {
			currentWorkerState = { task: envTask, role: envRole };
			saveWorkerState(pi, currentWorkerState);
			setupMailboxWatching(pi, ctx, envTask, envRole);

			const icons: Record<string, string> = {
				planner: "🔵",
				coder: "🟢",
				reviewer: "🟡",
			};
			pi.setSessionName(`${icons[envRole] ?? "⚪"} ${envRole}: ${envTask}`);
			ctx.ui.notify(`Team session: ${envRole} for ${envTask}`, "info");
			return;
		}

		// Path 2: Orchestrator resume from session state
		const state = loadOrchestratorState(ctx);
		if (state?.task && state?.role === "orchestrator") {
			currentTeamState = state;
			setupMailboxWatching(pi, ctx, state.task, "orchestrator");
			pi.setSessionName(`🔷 Orchestrator: ${state.task}`);
		}
	});

	// ─── Agent end: auto-write done message ────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		const task = process.env.PI_TEAM_TASK ?? currentWorkerState?.task;
		const role = process.env.PI_TEAM_ROLE ?? currentWorkerState?.role;

		if (!task || !role) return; // Not a team subagent

		// Check for deliverable
		const deliverable = DELIVERABLES[role];
		let hasDeliverable = false;
		if (deliverable) {
			hasDeliverable = fs.existsSync(path.join(workflowDir(ctx.cwd, task), deliverable));
		}

		// Write done message to orchestrator mailbox
		const mp = mailboxPath(ctx.cwd, task, "orchestrator");
		appendToMailbox(mp, {
			type: "done",
			from: role,
			to: "orchestrator",
			summary: `${role} finished processing${hasDeliverable ? ` — ${deliverable} written` : " — no deliverable found"}`,
			timestamp: Date.now(),
		});

		// Send notification
		notify("Pi", `${role} done for ${task}`);
		try {
			await cmuxNotify("Pi", `${role} done for ${task}`);
		} catch {
			// cmux not available
		}
	});

	// ─── /team command ─────────────────────────────────────────────────────

	pi.registerCommand("team", {
		description: "Manage multi-role team workflow",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				"init",
				"spawn",
				"status",
				"send",
				"approve",
				"reject",
				"redo",
				"shutdown",
				"auto",
				"history",
			];
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
					if (!taskName) {
						ctx.ui.notify("Usage: /team init <task-name>", "warning");
						return;
					}

					// Create workflow directory structure
					initWorkflow(ctx.cwd, taskName);

					// Set up orchestrator identity
					currentTeamState = {
						task: taskName,
						role: "orchestrator",
						spawnedRoles: [],
						surfaceIds: {},
						phase: "planning",
						completedRoles: [],
						reviewRound: 0,
						autoOrchestrate: true,
					};
					saveOrchestratorState(pi, currentTeamState);

					// Start watching orchestrator mailbox
					setupMailboxWatching(pi, ctx, taskName, "orchestrator");

					// Name the session
					pi.setSessionName(`🔷 Orchestrator: ${taskName}`);

					ctx.ui.notify(`Team initialized for "${taskName}"`, "info");
					updateOrchestratorStatus(ctx, currentTeamState);
					await logEvent(ctx, `Team initialized for ${taskName}`, "info");
					break;
				}

				// ─── /team spawn ────────────────────────────────────────
				case "spawn": {
					const roleName = parts[1];
					const taskName = parts[2];

					if (!roleName || !taskName) {
						ctx.ui.notify("Usage: /team spawn <role> <task-name>", "warning");
						return;
					}

					if (!currentTeamState && !loadOrchestratorState(ctx)) {
						ctx.ui.notify("Not an orchestrator session. Run /team init first.", "warning");
						return;
					}

					const state = currentTeamState ?? loadOrchestratorState(ctx)!;

					// Discover available agents
					const discovery = discoverAgents(ctx.cwd, "both");
					const agent = discovery.agents.find((a) => a.name === roleName);

					if (!agent) {
						const available = discovery.agents.map((a) => a.name).join(", ") || "none";
						ctx.ui.notify(`Unknown role "${roleName}". Available: ${available}`, "error");
						return;
					}

					// Optional initial message from remaining args
					const initialMessage = parts.length > 3 ? parts.slice(3).join(" ") : undefined;

					// Spawn the agent — first agent splits right from orchestrator,
					// subsequent agents split down from the last agent in the right column
					const lastAgentSurface = state.surfaceIds["reviewer"] ?? state.surfaceIds["coder"] ?? state.surfaceIds["planner"];
					const isFirstAgent = Object.keys(state.surfaceIds).length === 0;
					const splitDir = isFirstAgent ? "right" : "down";
					const splitFrom = isFirstAgent ? undefined : lastAgentSurface;

					const { surfaceId } = await spawnAgent(pi, ctx, agent, taskName, initialMessage, splitDir, splitFrom);

					// Update state
					state.spawnedRoles.push(roleName);
					if (surfaceId) state.surfaceIds[roleName] = surfaceId;

					// Update phase based on which role was spawned
					if (roleName === "planner") state.phase = "planning";
					else if (roleName === "coder") state.phase = state.reviewRound > 0 ? "fixing" : "implementing";
					else if (roleName === "reviewer") state.phase = "reviewing";

					saveOrchestratorState(pi, state);

					// Equalize all pane widths so each panel gets equal space
					if (surfaceId) await cmuxEqualizeSplits();

					// Dispatch task to the spawned role's mailbox
					const dispatchMessage = initialMessage ?? getDefaultDispatchMessage(roleName, taskName);
					const roleMailbox = mailboxPath(ctx.cwd, taskName, roleName);
					appendToMailbox(roleMailbox, {
						type: "dispatch",
						from: "orchestrator",
						to: roleName,
						task: dispatchMessage,
						timestamp: Date.now(),
					});

					ctx.ui.notify(`Spawned ${roleName} for "${taskName}"${surfaceId ? ` (pane: ${surfaceId})` : " (manual mode)"}`, "info");
					updateOrchestratorStatus(ctx, state);
					await logEvent(ctx, `Spawned ${roleName} for ${taskName}`, "info");
					break;
				}

				// ─── /team approve (Change 3) ────────────────────────────
				case "approve": {
					const taskName = parts[1];
					if (!taskName) {
						ctx.ui.notify("Usage: /team approve <task-name>", "warning");
						return;
					}

					const state = currentTeamState ?? loadOrchestratorState(ctx);
					if (!state) {
						ctx.ui.notify("Not an orchestrator session. Run /team init first.", "warning");
						return;
					}

					// Verify we're in plan-review phase
					if (state.phase !== "plan-review") {
						ctx.ui.notify(`Cannot approve: current phase is "${state.phase}", not "plan-review". Use /team status ${taskName} to check.`, "warning");
						return;
					}

					// Advance to implementing and spawn coder
					await spawnCoder(pi, ctx, state);
					currentTeamState = state; // Keep in-memory state in sync
					ctx.ui.notify(`✅ Plan approved for "${taskName}". Spawning coder.`, "info");
					await logEvent(ctx, `Plan approved for ${taskName}`, "info");
					break;
				}

				// ─── /team reject (Change 3) ─────────────────────────────
				case "reject": {
					const taskName = parts[1];
					const feedback = parts.slice(2).join(" ");

					if (!taskName) {
						ctx.ui.notify("Usage: /team reject <task-name> <feedback>", "warning");
						return;
					}

					if (!feedback) {
						ctx.ui.notify("Please provide feedback when rejecting a plan. Usage: /team reject <task-name> <feedback>", "warning");
						return;
					}

					const state = currentTeamState ?? loadOrchestratorState(ctx);
					if (!state) {
						ctx.ui.notify("Not an orchestrator session. Run /team init first.", "warning");
						return;
					}

					// Verify we're in plan-review phase
					if (state.phase !== "plan-review") {
						ctx.ui.notify(`Cannot reject: current phase is "${state.phase}", not "plan-review". Use /team status ${taskName} to check.`, "warning");
						return;
					}

					// Reset phase back to planning
					state.phase = "planning";
					saveOrchestratorState(pi, state);
					currentTeamState = state; // Keep in-memory state in sync
					updateOrchestratorStatus(ctx, state);

					// Update phase.json
					const phaseFile = workflowPhasePath(ctx.cwd, taskName);
					const phaseData = readPhase(phaseFile);
					phaseData.phase = "planning";
					phaseData.history.push({ phase: "planning", timestamp: Date.now(), by: "orchestrator" });
					writePhase(phaseFile, phaseData);

					// Send feedback to planner's mailbox
					const plannerMailbox = mailboxPath(ctx.cwd, taskName, "planner");
					appendToMailbox(plannerMailbox, {
						type: "dispatch",
						from: "orchestrator",
						to: "planner",
						task: `Plan rejected. Feedback: ${feedback}. Please revise the plan and write an updated plan.md.`,
						timestamp: Date.now(),
					});

					ctx.ui.notify(`❌ Plan rejected for "${taskName}". Run /team redo planner ${taskName} to re-dispatch the planner with your feedback.`, "info");
					await logEvent(ctx, `Plan rejected for ${taskName}: ${feedback}`, "info");
					break;
				}

				// ─── /team redo (Change 7) ───────────────────────────────
				case "redo": {
					const roleName = parts[1];
					const taskName = parts[2];

					if (!roleName || !taskName) {
						ctx.ui.notify("Usage: /team redo <role> <task-name>", "warning");
						return;
					}

					const validRoles = ["planner", "coder", "reviewer"];
					if (!validRoles.includes(roleName)) {
						ctx.ui.notify(`Unknown role "${roleName}". Valid roles: ${validRoles.join(", ")}`, "warning");
						return;
					}

					const state = currentTeamState ?? loadOrchestratorState(ctx);
					if (!state) {
						ctx.ui.notify("Not an orchestrator session. Run /team init first.", "warning");
						return;
					}

					// Validate that the role has been spawned before making any state changes
					if (!state.spawnedRoles.includes(roleName)) {
						ctx.ui.notify(`Role "${roleName}" has not been spawned yet. Use /team spawn ${roleName} ${taskName} first.`, "warning");
						return;
					}

					// Warn if redoing reviewer while coder is actively fixing
					if (roleName === "reviewer" && state.phase === "fixing") {
						ctx.ui.notify(`⚠️ Coder is currently fixing review findings (phase: fixing). Redoing reviewer will reset phase to "reviewing" and may leave the coder in an inconsistent state. Proceed with caution.`, "warning");
					}

					// Reset phase based on the role
					if (roleName === "planner") {
						state.phase = "planning";
					} else if (roleName === "coder") {
						state.phase = "implementing";
					} else if (roleName === "reviewer") {
						state.phase = "reviewing";
					}

					// Remove from completedRoles
					state.completedRoles = state.completedRoles.filter((r) => r !== roleName);
					saveOrchestratorState(pi, state);
					currentTeamState = state; // Keep in-memory state in sync
					updateOrchestratorStatus(ctx, state);

					// Update phase.json
					const phaseFile = workflowPhasePath(ctx.cwd, taskName);
					const phaseData = readPhase(phaseFile);
					phaseData.phase = state.phase as WorkflowPhase;
					phaseData.history.push({ phase: state.phase as WorkflowPhase, timestamp: Date.now(), by: "orchestrator" });
					writePhase(phaseFile, phaseData);

					// Clear stale mailbox messages before re-dispatch
					const roleMailbox = mailboxPath(ctx.cwd, taskName, roleName);
					clearMailbox(roleMailbox);

					// Send redo dispatch to the role's mailbox
					const redoMessage = getDefaultDispatchMessage(roleName, taskName);
					appendToMailbox(roleMailbox, {
						type: "dispatch",
						from: "orchestrator",
						to: roleName,
						task: `Redo requested. ${redoMessage}`,
						timestamp: Date.now(),
					});

					ctx.ui.notify(`🔁 Redo: ${roleName} re-dispatched for "${taskName}". Phase reset to ${state.phase}.`, "info");
					await logEvent(ctx, `Redo: ${roleName} re-dispatched for ${taskName}`, "info");
					break;
				}

				// ─── /team status ───────────────────────────────────────
				case "status": {
					const taskName = parts[1] ?? currentTeamState?.task ?? loadOrchestratorState(ctx)?.task;

					if (!taskName) {
						ctx.ui.notify("Usage: /team status <task-name>", "warning");
						return;
					}

					const dir = workflowDir(ctx.cwd, taskName);
					if (!fs.existsSync(dir)) {
						ctx.ui.notify(`No workflow found for "${taskName}"`, "warning");
						return;
					}

					// Read all mailboxes
					const roles = ["orchestrator", "planner", "coder", "reviewer"];
					const statusLines: string[] = [`📋 Workflow: ${taskName}\n`];

					// Check deliverables
					const deliverables = ["plan.md", "review.md", "implementation.md"];
					statusLines.push("📄 Deliverables:");
					for (const d of deliverables) {
						const exists = fs.existsSync(path.join(dir, d));
						statusLines.push(`  ${exists ? "✅" : "⬜"} ${d}`);
					}

					// Check mailboxes
					statusLines.push("\n📬 Mailboxes:");
					for (const role of roles) {
						const mp = mailboxPath(ctx.cwd, taskName, role);
						const messages = readMailbox(mp);
						const unread = messages.length;
						statusLines.push(`  ${unread > 0 ? "🔴" : "🟢"} ${role}: ${unread} message${unread !== 1 ? "s" : ""}`);
					}

					// Show workflow state
					const state = currentTeamState ?? loadOrchestratorState(ctx);
					if (state) {
						statusLines.push(`\n🔄 Phase: ${state.phase}`);
						statusLines.push(`🤖 Auto-orchestrate: ${state.autoOrchestrate ? "ON" : "OFF"}`);
						if (state.spawnedRoles?.length) {
							statusLines.push(`👥 Spawned: ${state.spawnedRoles.join(", ")}`);
						}
						if (state.completedRoles?.length) {
							statusLines.push(`✅ Completed: ${state.completedRoles.join(", ")}`);
						}
						if (state.reviewRound > 0) {
							statusLines.push(`🔁 Review round: ${state.reviewRound}`);
						}
					}

					// Show workflow phase from phase.json
					const phaseFile = workflowPhasePath(ctx.cwd, taskName);
					if (fs.existsSync(phaseFile)) {
						const phaseData = readPhase(phaseFile);
						statusLines.push(`\n🔄 Phase: **${phaseData.phase}**`);
						if (phaseData.reviewCycles > 0) {
							statusLines.push(`   Review cycles: ${phaseData.reviewCycles}`);
						}
						if (phaseData.history.length > 0) {
							const last = phaseData.history[phaseData.history.length - 1];
							statusLines.push(`   Last change: ${last.phase} by ${last.by}`);
						}
					}

					ctx.ui.notify(statusLines.join("\n"), "info");
					break;
				}

				// ─── /team send ─────────────────────────────────────────
				case "send": {
					const roleName = parts[1];
					const taskName = parts[2];
					const message = parts.slice(3).join(" ");

					if (!roleName || !taskName || !message) {
						ctx.ui.notify("Usage: /team send <role> <task-name> <message>", "warning");
						return;
					}

					const mp = mailboxPath(ctx.cwd, taskName, roleName);
					appendToMailbox(mp, {
						type: "dispatch",
						from: "orchestrator",
						to: roleName,
						task: message,
						timestamp: Date.now(),
					});

					ctx.ui.notify(`Message sent to ${roleName}`, "info");
					break;
				}

				// ─── /team shutdown ─────────────────────────────────────
				case "shutdown": {
					const taskName = parts[1] ?? currentTeamState?.task ?? loadOrchestratorState(ctx)?.task;

					if (!taskName) {
						ctx.ui.notify("Usage: /team shutdown <task-name>", "warning");
						return;
					}

					const state = currentTeamState ?? loadOrchestratorState(ctx);
					const roles = state?.spawnedRoles ?? ["planner", "coder", "reviewer"];

					// Send shutdown to all roles
					for (const role of roles) {
						const mp = mailboxPath(ctx.cwd, taskName, role);
						appendToMailbox(mp, {
							type: "shutdown",
							from: "orchestrator",
							to: role,
							timestamp: Date.now(),
						});
					}

					// Close cmux panes
					if (state?.surfaceIds) {
						for (const [role, surfaceId] of Object.entries(state.surfaceIds)) {
							await cmuxCloseSurface(surfaceId);
						}
					}

					ctx.ui.notify(`Shutdown sent for "${taskName}"`, "info");
					break;
				}

				// ─── /team auto ──────────────────────────────────────
				case "auto": {
					const state = currentTeamState ?? loadOrchestratorState(ctx);
					if (!state) {
						ctx.ui.notify("Not an orchestrator session. Run /team init first.", "warning");
						return;
					}
					state.autoOrchestrate = !state.autoOrchestrate;
					saveOrchestratorState(pi, state);
					ctx.ui.notify(`Auto-orchestrate: ${state.autoOrchestrate ? "ON ✅" : "OFF ⏸️"}`, "info");
					break;
				}

				// ─── /team history ─────────────────────────────────────
				case "history": {
					const taskName = parts[1] ?? currentTeamState?.task ?? loadOrchestratorState(ctx)?.task;
					if (!taskName) {
						ctx.ui.notify("Usage: /team history <task-name>", "warning");
						return;
					}

					const phaseFile = workflowPhasePath(ctx.cwd, taskName);
					if (!fs.existsSync(phaseFile)) {
						ctx.ui.notify(`No phase history for "${taskName}"`, "warning");
						return;
					}

					const phaseData = readPhase(phaseFile);
					const lines: string[] = [`📜 Workflow History: ${taskName}\n`];
					lines.push(`Current phase: ${phaseData.phase}`);
					lines.push(`Review cycles: ${phaseData.reviewCycles}\n`);
					lines.push("Transitions:");
					for (const entry of phaseData.history) {
						const time = new Date(entry.timestamp).toLocaleTimeString();
						lines.push(`  ${time} — ${entry.phase} (by ${entry.by})`);
					}

					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				default: {
					ctx.ui.notify(
						"Unknown command. Usage:\n" +
							"  /team init <task-name>\n" +
							"  /team spawn <role> <task-name>\n" +
							"  /team status [task-name]\n" +
							"  /team send <role> <task-name> <message>\n" +
							"  /team approve <task-name>\n" +
							"  /team reject <task-name> <feedback>\n" +
							"  /team redo <role> <task-name>\n" +
							"  /team history [task-name]\n" +
							"  /team auto\n" +
							"  /team shutdown [task-name]",
						"info",
					);
				}
			}
		},
	});
}
