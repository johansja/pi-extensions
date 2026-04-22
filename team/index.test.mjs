/**
 * Tests for the team extension's pure helper functions.
 *
 * Run with: node --test team/index.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Inlined pure functions from team/index.ts ─────────────────────────────

function sanitizeTaskName(task) {
	const trimmed = task.trim();
	if (!trimmed) return null;
	if (trimmed.length < 1 || trimmed.length > 64) return null;
	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
	return trimmed;
}

function validateTaskName(task) {
	const sanitized = sanitizeTaskName(task);
	if (sanitized === null) {
		throw new Error(`Invalid task name: "${task}". Must be 1–64 characters, no slashes or "..".`);
	}
	return sanitized;
}

function workflowDir(cwd, task) {
	return path.join(cwd, ".pi", "workflow", task);
}

function statePath(cwd, task) {
	return path.join(workflowDir(cwd, task), "state.json");
}

function mailboxDir(cwd, task) {
	return path.join(workflowDir(cwd, task), "mailbox");
}

function mailboxPath(cwd, task, agent) {
	return path.join(mailboxDir(cwd, task), `${agent}.json`);
}

function readMailbox(filePath) {
	try {
		const content = fs.readFileSync(filePath, "utf-8").trim();
		if (!content) return [];
		const lines = content.split("\n").filter(Boolean);
		const messages = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				messages.push(JSON.parse(line));
			} catch (_) {
				// skip malformed lines
			}
		}
		return messages;
	} catch {
		return [];
	}
}

function appendToMailbox(filePath, message) {
	const line = JSON.stringify(message) + "\n";
	fs.appendFileSync(filePath, line, { encoding: "utf-8" });
}

function clearMailbox(filePath) {
	fs.writeFileSync(filePath, "", { encoding: "utf-8" });
}

function saveState(cwd, state) {
	const sp = statePath(cwd, state.task);
	fs.writeFileSync(sp, JSON.stringify(state, null, 2), { encoding: "utf-8" });
}

function loadState(cwd, task) {
	const sp = statePath(cwd, task);
	try {
		const content = fs.readFileSync(sp, "utf-8").trim();
		if (!content) return null;
		const state = JSON.parse(content);
		if (state.orchestratorPaneId === undefined) {
			state.orchestratorPaneId = null;
		}
		if (state.status === undefined) {
			state.status = "active";
		}
		return state;
	} catch {
		return null;
	}
}

function statusIcon(status) {
	switch (status) {
		case "working": return "🟡";
		case "idle": return "🔵";
		default: return "⚪";
	}
}

const VALID_ROLES = ["planning", "research", "implementation", "review", "testing"];

function getAgentRoles(agent) {
	return new Set(agent.roles ?? []);
}

function buildDelegationRules(agents) {
	const roleToAgents = new Map();

	for (const agent of agents) {
		const roles = getAgentRoles(agent);
		if (roles.size > 0) {
			const unknownRoles = Array.from(roles).filter(r => !VALID_ROLES.includes(r));
			const validRoles = Array.from(roles).filter(r => VALID_ROLES.includes(r));
			for (const role of validRoles) {
				if (!roleToAgents.has(role)) roleToAgents.set(role, []);
				roleToAgents.get(role).push(agent.name);
			}
		}
	}

	if (roleToAgents.size === 0) return [];

	const rules = [];
	rules.push("**Delegation Rules — You must NOT do these yourself, delegate them:**");

	const roleDescriptions = {
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

const MAX_CONTEXT_DISPATCHES = 20;

function buildOrchestratorContext(state, extraInfo) {
	const lines = [];

	lines.push(`📋 **Team Orchestration — ${state.task}**`);
	lines.push("");

	lines.push("**Agents:**");
	for (const agent of state.agents) {
		const status = state.agentStatus[agent.name] ?? "idle";
		const icon = statusIcon(status);
		const toolsLabel = agent.tools && agent.tools.length > 0
			? ` [tools: ${agent.tools.join(", ")}]`
			: "";
		const rolesLabel = agent.roles && agent.roles.length > 0
			? ` [roles: ${agent.roles.join(", ")}]`
			: "";
		lines.push(`  ${icon} ${agent.name} (${status})${toolsLabel}${rolesLabel} — ${agent.description}`);
	}
	lines.push("");

	const delegationRules = buildDelegationRules(state.agents);
	if (delegationRules.length > 0) {
		lines.push(...delegationRules);
		lines.push("");
	}

	lines.push("### Completed Work");
	const recentDispatches = state.dispatchHistory.slice(-MAX_CONTEXT_DISPATCHES);
	const agentsWithResults = new Map();
	for (const entry of recentDispatches) {
		if (entry.result && entry.result !== "[Session interrupted]" && entry.result !== "[Team completed]") {
			if (!agentsWithResults.has(entry.agent)) agentsWithResults.set(entry.agent, []);
			agentsWithResults.get(entry.agent).push(entry.result);
		}
	}
	if (agentsWithResults.size > 0) {
		for (const [agentName, results] of agentsWithResults) {
			const summary = results.map((r, i) => `#${i + 1}: ${r}`).join("; ");
			lines.push(`- ${agentName}: ${summary}`);
		}
	} else {
		lines.push("- No completed work yet");
	}
	lines.push("");

	if (extraInfo) {
		lines.push(extraInfo);
		lines.push("");
	}

	lines.push("Use the `team_orchestrate` tool to dispatch an agent.");

	return lines.join("\n");
}

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeTmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "team-test-"));
}

function cleanup(dir) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch { /* best effort */ }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("sanitizeTaskName", () => {
	it("accepts valid names", () => {
		assert.equal(sanitizeTaskName("alpha"), "alpha");
		assert.equal(sanitizeTaskName("task-123"), "task-123");
		assert.equal(sanitizeTaskName("team-name"), "team-name");
		assert.equal(sanitizeTaskName("  spaced  "), "spaced");
	});

	it("rejects empty strings", () => {
		assert.equal(sanitizeTaskName(""), null);
		assert.equal(sanitizeTaskName("   "), null);
	});

	it("revents path traversal", () => {
		assert.equal(sanitizeTaskName("../etc"), null);
		assert.equal(sanitizeTaskName("./foo"), null);
		assert.equal(sanitizeTaskName("a/b"), null);
		assert.equal(sanitizeTaskName("a\\b"), null);
		assert.equal(sanitizeTaskName("foo..bar"), null);
	});

	it("rejects names > 64 characters", () => {
		assert.equal(sanitizeTaskName("a".repeat(65)), null);
		assert.equal(sanitizeTaskName("a".repeat(64)), "a".repeat(64));
	});
});

describe("validateTaskName", () => {
	it("returns sanitized name for valid input", () => {
		assert.equal(validateTaskName("alpha"), "alpha");
	});

	it("throws for invalid input", () => {
		assert.throws(() => validateTaskName("../foo"), /Invalid task name/);
		assert.throws(() => validateTaskName(""), /Invalid task name/);
	});
});

describe("path helpers", () => {
	const cwd = "/tmp/project";
	const task = "my-task";

	it("workflowDir produces correct path", () => {
		assert.equal(workflowDir(cwd, task), path.join(cwd, ".pi", "workflow", task));
	});

	it("statePath points inside workflow dir", () => {
		assert.equal(statePath(cwd, task), path.join(workflowDir(cwd, task), "state.json"));
	});

	it("mailboxPath points inside mailbox dir", () => {
		assert.equal(mailboxPath(cwd, task, "agent1"), path.join(mailboxDir(cwd, task), "agent1.json"));
	});
});

describe("mailbox I/O", () => {
	let tmpDir;
	let mboxFile;

	it("setup temp dir", () => {
		tmpDir = makeTmpDir();
		mboxFile = path.join(tmpDir, "mailbox.json");
	});

	it("appendToMailbox + readMailbox round-trip", () => {
		appendToMailbox(mboxFile, { type: "dispatch", from: "orch", to: "agent1", instructions: "do work", timestamp: 1 });
		appendToMailbox(mboxFile, { type: "done", from: "agent1", to: "orch", summary: "done", timestamp: 2 });

		const msgs = readMailbox(mboxFile);
		assert.equal(msgs.length, 2);
		assert.equal(msgs[0].type, "dispatch");
		assert.equal(msgs[1].summary, "done");
	});

	it("readMailbox returns [] for missing file", () => {
		const msgs = readMailbox(path.join(tmpDir, "nonexistent.json"));
		assert.deepEqual(msgs, []);
	});

	it("readMailbox skips invalid JSON lines", () => {
		clearMailbox(mboxFile);
		fs.appendFileSync(mboxFile, '{"type":"ok"}\n');
		fs.appendFileSync(mboxFile, 'this is not json\n');
		fs.appendFileSync(mboxFile, '{"type":"ok2"}\n');

		const msgs = readMailbox(mboxFile);
		assert.equal(msgs.length, 2);
		assert.equal(msgs[0].type, "ok");
		assert.equal(msgs[1].type, "ok2");
	});

	it("clearMailbox empties the file", () => {
		clearMailbox(mboxFile);
		const msgs = readMailbox(mboxFile);
		assert.deepEqual(msgs, []);
		assert.equal(fs.readFileSync(mboxFile, "utf-8"), "");
	});

	it("cleanup temp dir", () => {
		cleanup(tmpDir);
	});
});

describe("saveState / loadState round-trip", () => {
	let tmpDir;
	let task;

	it("setup", () => {
		tmpDir = makeTmpDir();
		task = "test-task";
		fs.mkdirSync(workflowDir(tmpDir, task), { recursive: true });
	});

	it("saves and loads a state object", () => {
		const original = {
			task,
			role: "orchestrator",
			status: "active",
			agents: [{ name: "planner", description: "Plans things", source: "project", filePath: "/fake.md" }],
			agentStatus: { planner: "idle" },
			orchestratorPaneId: null,
			surfaceIds: {},
			dispatchHistory: [],
		};

		saveState(tmpDir, original);
		const loaded = loadState(tmpDir, task);

		assert.deepEqual(loaded.task, original.task);
		assert.deepEqual(loaded.agents, original.agents);
		assert.deepEqual(loaded.agentStatus, original.agentStatus);
		assert.equal(loaded.status, "active");
		assert.equal(loaded.orchestratorPaneId, null);
	});

	it("missing file returns null", () => {
		const loaded = loadState(tmpDir, "nonexistent");
		assert.equal(loaded, null);
	});

	it("corrupted JSON returns null", () => {
		const sp = statePath(tmpDir, "corrupt");
		fs.mkdirSync(path.dirname(sp), { recursive: true });
		fs.writeFileSync(sp, "not-json{{{", "utf-8");
		const loaded = loadState(tmpDir, "corrupt");
		assert.equal(loaded, null);
	});

	it("backward compat: missing orchestratorPaneId become null", () => {
		const sp = statePath(tmpDir, "compat");
		fs.mkdirSync(path.dirname(sp), { recursive: true });
		fs.writeFileSync(sp, JSON.stringify({ task: "compat", status: "active" }), "utf-8");
		const loaded = loadState(tmpDir, "compat");
		assert.equal(loaded.orchestratorPaneId, null);
		assert.equal(loaded.status, "active");
	});

	it("cleanup", () => {
		cleanup(tmpDir);
	});
});

describe("statusIcon", () => {
	it("maps known statuses to emoji", () => {
		assert.equal(statusIcon("working"), "🟡");
		assert.equal(statusIcon("idle"), "🔵");
	});

	it("returns default for unknown status", () => {
		assert.equal(statusIcon("shutdown"), "⚪");
		assert.equal(statusIcon("completed"), "⚪");
		assert.equal(statusIcon("unknown"), "⚪");
	});
});

describe("getAgentRoles", () => {
	it("returns explicit roles from agent config", () => {
		const roles = getAgentRoles({ name: "planner", description: "Plans things", roles: ["planning"] });
		assert.deepEqual(roles, new Set(["planning"]));
	});

	it("returns multiple explicit roles", () => {
		const roles = getAgentRoles({ name: "hybrid", description: "Does many things", roles: ["research", "planning"] });
		assert.deepEqual(roles, new Set(["research", "planning"]));
	});

	it("returns empty set when roles is missing", () => {
		const roles = getAgentRoles({ name: "foobar", description: "does something random" });
		assert.deepEqual(roles, new Set());
	});

	it("returns empty set when roles is empty array", () => {
		const roles = getAgentRoles({ name: "empty", description: "No roles", roles: [] });
		assert.deepEqual(roles, new Set());
	});

	it("does not infer roles from name/description", () => {
		const roles = getAgentRoles({ name: "planner", description: "planning specialist" });
		assert.deepEqual(roles, new Set());
	});
});

describe("buildDelegationRules", () => {
	it("returns empty array for empty roster", () => {
		assert.deepEqual(buildDelegationRules([]), []);
	});

	it("returns empty array when no roles defined", () => {
		const agents = [
			{ name: "planner", description: "Plans things" },
			{ name: "worker", description: "Does things" },
		];
		const rules = buildDelegationRules(agents);
		assert.deepEqual(rules, []);
	});

	it("includes rules for agents with explicit roles", () => {
		const agents = [
			{ name: "planner", description: "Plans things", roles: ["planning"] },
			{ name: "worker", description: "Does things", roles: ["implementation"] },
		];
		const rules = buildDelegationRules(agents);
		assert.ok(rules.some((r) => r.includes("plan")));
		assert.ok(rules.some((r) => r.includes("implement")));
		assert.ok(rules.some((r) => r.includes("planner")));
		assert.ok(rules.some((r) => r.includes("worker")));
	});

	it("ignores unrecognized roles", () => {
		const agents = [
			{ name: "custom", description: "Custom role", roles: ["unknown-role"] },
		];
		const rules = buildDelegationRules(agents);
		assert.deepEqual(rules, []);
	});

	it("filters out unrecognized roles but keeps valid ones", () => {
		const agents = [
			{ name: "hybrid", description: "Mixed roles", roles: ["planning", "unknown-role", "research"] },
		];
		const rules = buildDelegationRules(agents);
		assert.ok(rules.some((r) => r.includes("plan")));
		assert.ok(rules.some((r) => r.includes("research")));
		assert.ok(!rules.some((r) => r.includes("unknown-role")));
	});

	it("ends with guidance phrase", () => {
		const agents = [{ name: "planner", description: "Plans", roles: ["planning"] }];
		const rules = buildDelegationRules(agents);
		const last = rules[rules.length - 1];
		assert.ok(last.includes("Your ONLY job is to"));
	});
});

describe("buildOrchestratorContext", () => {
	function makeState(dispatches = []) {
		return {
			task: "test-task",
			agents: [
				{ name: "planner", description: "Plans things", roles: ["planning"] },
				{ name: "worker", description: "Does things", roles: ["implementation"] },
			],
			agentStatus: { planner: "idle", worker: "working" },
			dispatchHistory: dispatches,
			status: "active",
		};
	}

	it("contains agent roster with status icons", () => {
		const ctx = buildOrchestratorContext(makeState());
		assert.ok(ctx.includes("planner"));
		assert.ok(ctx.includes("worker"));
		assert.ok(ctx.includes("idle"));
		assert.ok(ctx.includes("working"));
	});

	it("includes role labels in roster", () => {
		const ctx = buildOrchestratorContext(makeState());
		assert.ok(ctx.includes("[roles: planning]"));
		assert.ok(ctx.includes("[roles: implementation]"));
	});

	it("includes delegation rules when agents have roles", () => {
		const ctx = buildOrchestratorContext(makeState());
		assert.ok(ctx.includes("Delegation Rules"));
	});

	it("shows completed work from dispatches", () => {
		const state = makeState([
			{ agent: "planner", instructions: "plan", timestamp: 1, result: "planned" },
		]);
		const ctx = buildOrchestratorContext(state);
		assert.ok(ctx.includes("planned"));
	});

	it("limits to MAX_CONTEXT_DISPATCHES (20)", () => {
		const dispatches = [];
		for (let i = 0; i < 25; i++) {
			dispatches.push({ agent: "worker", instructions: `task${i}`, timestamp: i, result: `result${i}` });
		}
		const state = makeState(dispatches);
		const ctx = buildOrchestratorContext(state);

		// Only last 20 results should appear
		assert.ok(ctx.includes("result24"));
		assert.ok(ctx.includes("result5"));
		assert.ok(!ctx.includes("result4"));
	});

	it("shows extraInfo when provided", () => {
		const ctx = buildOrchestratorContext(makeState(), "Extra context here");
		assert.ok(ctx.includes("Extra context here"));
	});

	it("shows 'No completed work yet' when empty", () => {
		const ctx = buildOrchestratorContext(makeState());
		assert.ok(ctx.includes("No completed work yet"));
	});
});
