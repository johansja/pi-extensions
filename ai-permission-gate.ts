/**
 * AI Permission Gate Extension
 *
 * Uses the pi-ai completeSimple() API to classify bash commands by risk level
 * and require user confirmation before executing potentially harmful ones.
 *
 * Instead of maintaining a long list of regex patterns, this extension
 * asks a fast, cheap model to judge each command. The LLM returns a
 * structured verdict with a risk level and explanation.
 *
 * CWD-Aware Classification:
 *   The current working directory (CWD) is passed to the LLM via both
 *   the system prompt guidelines and the user prompt, enabling the LLM
 *   to treat project-local operations (e.g., rm -rf ./build, npm install)
 *   as less risky than system-wide equivalents. No post-check heuristics
 *   or risk-downgrading logic — the LLM makes CWD-aware judgments directly.
 *
 * Configuration via environment variables:
 *   PI_AI_PERM_GATE_MODEL       - Model for classification (format: "provider/modelId"). Overrides settings.json.
 *   PI_AI_PERM_GATE_BLOCK_LEVEL - Minimum risk level to block: "low" | "medium" | "high" (default: "low")
 *     "low"    = block on any risk (safest, most confirmations)
 *     "medium" = block on medium and high risk
 *     "high"   = only block on high risk (fewest confirmations)
 *   PI_AI_PERM_GATE_TIMEOUT     - Timeout in ms for the LLM call (default: 10000)
 *   PI_AI_PERM_GATE_FALLBACK    - What to do if LLM fails: "allow" | "block" | "confirm" (default: "confirm")
 */

import {
	AuthStorage,
	ModelRegistry,
	SettingsManager,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { completeSimple, type Model, type Api, type Context } from "@mariozechner/pi-ai";

// Risk levels, ordered from least to most severe
const RISK_LEVELS = ["safe", "low", "medium", "high"] as const;
type RiskLevel = (typeof RISK_LEVELS)[number];

interface Verdict {
	risk: RiskLevel;
	reason: string;
}

const SYSTEM_PROMPT = `You are a command safety classifier. You analyze shell commands and determine their risk level.

Respond with EXACTLY this JSON format and nothing else:
{"risk":"safe|low|medium|high","reason":"brief explanation"}

Risk levels:
- safe: Read-only or harmless operations (ls, cat, echo, pwd, which, node -v, git status, git log, etc.)
- low: Minor side effects that are easily reversible or low-impact, including CWD-scoped deletions and modifications (rm -rf ./build, rm -rf ./dist, rm ./temp.log, git add, git commit, npm install, pip install, mkdir ./dir, touch ./file, cp ./a ./b, mv ./a ./b, git checkout, git switch, git stash, kubectl get, kubectl describe, helm list, helm status)
- medium: Significant changes that could affect the system or data, including operations affecting paths outside CWD but not system-critical (rm -rf ../other-project, git push, kubectl apply, helm install, helm upgrade, npm publish, ALTER TABLE with WHERE, DELETE with WHERE, UPDATE with WHERE, docker rm, docker rmi, pip uninstall)
- high: Destructive, irreversible, or security-sensitive operations, including system-wide or irreversible operations, or operations outside CWD that affect system state (rm -rf /etc, sudo, DROP TABLE, TRUNCATE, DELETE without WHERE, UPDATE without WHERE, git push --force, kubectl delete, shutdown, reboot, mkfs, dd, iptables, chmod 777)

Working directory context:
- You will be given the current working directory (CWD)
- Commands whose effects are contained within the CWD are less risky than system-wide equivalents
- Deleting files/dirs under CWD (e.g., rm -rf ./build, rm -rf ./node_modules) is low risk — it only affects the project, not the system
- Modifying project-local files (e.g., ./src, ./config, ./data within CWD) is low risk
- Commands targeting paths outside CWD or system paths (/etc, /usr, /var, /opt, ~, /) retain their normal risk level
- Package installs (npm install, pip install) within CWD are low risk
- Docker/container operations that only affect project containers are medium risk (still affects runtime)

Important guidelines:
- Analyze the FULL command including all flags and arguments
- Consider chained commands (&&, ||, ;) - rate by the most dangerous segment
- Shell variable expansion and command substitution should raise suspicion slightly since content is unknown
- Piping data into destructive commands is high risk
- Commands that modify live infrastructure (k8s, databases) are at least medium
- When in doubt, rate one level higher rather than lower
- Be concise in your reason - one short sentence max`;

function riskLevelIndex(level: RiskLevel): number {
	return RISK_LEVELS.indexOf(level);
}

function stripCodeFences(raw: string): string {
	let text = raw.trim();
	// Strip markdown code fences: ```json ... ``` or ``` ... ```
	text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
	return text.trim();
}

function parseVerdict(raw: string): Verdict {
	const cleaned = stripCodeFences(raw);
	try {
		const parsed = JSON.parse(cleaned);
		if (
			parsed &&
			typeof parsed.risk === "string" &&
			RISK_LEVELS.includes(parsed.risk as RiskLevel) &&
			typeof parsed.reason === "string"
		) {
			return parsed as Verdict;
		}
	} catch {
		// Try to extract JSON from the response in case the model added extra text
		const jsonMatch = cleaned.match(/\{[^{}]*"risk"[^{}]*"reason"[^{}]*\}/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]);
				if (
					parsed &&
					typeof parsed.risk === "string" &&
					RISK_LEVELS.includes(parsed.risk as RiskLevel) &&
					typeof parsed.reason === "string"
				) {
					return parsed as Verdict;
				}
			} catch {
				// fall through
			}
		}
	}
	return { risk: "medium", reason: "Could not parse LLM verdict" };
}

/**
 * Read the permissionGate.model setting from settings.json.
 * Returns undefined if not configured.
 */
function readPermissionGateModel(cwd: string, agentDir: string): string | undefined {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	// SettingsManager doesn't expose custom keys, so read the raw global settings
	const globalSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
	const gate = globalSettings.permissionGate as Record<string, unknown> | undefined;
	if (gate && typeof gate.model === "string") {
		return gate.model;
	}
	return undefined;
}

/**
 * Resolve a model from PI_AI_PERM_GATE_MODEL env var or settings.json.
 * Accepts "provider/modelId" format (e.g., "anthropic/claude-sonnet-4-5")
 * or a bare model id that's searched across providers.
 * Returns undefined if no model is configured (caller should fall back to ctx.model).
 */
async function resolveModel(modelSpec: string | undefined): Promise<Model<Api> | undefined> {
	if (!modelSpec) return undefined;

	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);

	// Support "provider/modelId" format
	const slashIdx = modelSpec.indexOf("/");
	if (slashIdx !== -1) {
		const provider = modelSpec.slice(0, slashIdx);
		const modelId = modelSpec.slice(slashIdx + 1);
		const model = modelRegistry.find(provider, modelId);
		if (!model) {
			throw new Error(
				`Model not found: ${modelSpec}. Available models: ${modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`).join(", ")}`,
			);
		}
		return model;
	}

	// Bare model id — search across all providers
	const available = modelRegistry.getAvailable();
	const exactMatch = available.find((m) => m.id === modelSpec);
	if (exactMatch) return exactMatch;

	// Partial/fuzzy match on model id or name
	const partialMatches = available.filter(
		(m) =>
			m.id.toLowerCase().includes(modelSpec.toLowerCase()) ||
			(m.name && m.name.toLowerCase().includes(modelSpec.toLowerCase())),
	);
	if (partialMatches.length === 1) return partialMatches[0];
	if (partialMatches.length > 1) {
		throw new Error(
			`Ambiguous model "${modelSpec}" matches: ${partialMatches.map((m) => `${m.provider}/${m.id}`).join(", ")}. Use provider/modelId format.`,
		);
	}

	throw new Error(
		`Model not found: ${modelSpec}. Available models: ${available.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
	);
}

/**
 * Classify a shell command using the pi-ai completeSimple() API.
 * Sends a single-shot LLM request with the safety classifier system prompt
 * and returns the parsed verdict.
 */
async function classifyCommand(
	command: string,
	cwd: string,
	model: Model<Api>,
	apiKey: string | undefined,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<Verdict> {
	// Fallback to process CWD if ctx.cwd is missing
	if (!cwd) {
		cwd = process.cwd();
	}

	const context: Context = {
		systemPrompt: SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: `Analyze this shell command for safety: ${command}\n\nCurrent working directory: \`${cwd}\``,
				timestamp: Date.now(),
			},
		],
	};

	// Apply timeout via a combined AbortController
	let timedOut = false;
	const timeoutController = new AbortController();

	const timer = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, timeout);

	// Forward user's abort signal to the timeout controller
	const onAbort = () => timeoutController.abort();
	if (signal) {
		if (signal.aborted) {
			timeoutController.abort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	try {
		const response = await completeSimple(model, context, {
			apiKey,
			signal: timeoutController.signal,
		});

		// Extract text from the assistant response
		let responseText = "";
		for (const part of response.content) {
			if (part.type === "text") {
				responseText += part.text;
			}
		}

		if (!responseText) {
			throw new Error("LLM classification returned empty response");
		}

		return parseVerdict(responseText);
	} catch (err) {
		if (timedOut) {
			throw new Error("LLM classification timed out");
		}
		if (signal?.aborted) {
			throw new Error("LLM classification aborted");
		}
		throw err;
	} finally {
		clearTimeout(timer);
		if (signal) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		// Windows Terminal toast
		const { execFile } = require("node:child_process");
		execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
	} else if (process.env.KITTY_WINDOW_ID) {
		process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
		process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
	} else {
		process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;

		// Skip empty commands
		if (!command?.trim()) return undefined;

		// Load settings from environment variables
		const modelSpec = process.env.PI_AI_PERM_GATE_MODEL
			|| readPermissionGateModel(ctx.cwd, `${process.env.HOME}/.pi/agent`)
			|| undefined;
		const blockLevel = (process.env.PI_AI_PERM_GATE_BLOCK_LEVEL as RiskLevel) || "low";
		const timeout = parseInt(process.env.PI_AI_PERM_GATE_TIMEOUT || "10000", 10);
		const fallback = process.env.PI_AI_PERM_GATE_FALLBACK || "confirm";

		let verdict: Verdict;
		try {
			// Use env var model if specified, otherwise prefer a fast/cheap model,
			// falling back to the session's current model as last resort
			const model = (await resolveModel(modelSpec)) ?? ctx.model;
			if (!model) {
				throw new Error("No model available for classification");
			}

			// Resolve API key via the session's model registry
			const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!authResult.ok) {
				throw new Error(`No API key for ${model.provider}/${model.id}: ${authResult.error}`);
			}

			verdict = await classifyCommand(command, ctx.cwd, model, authResult.apiKey, timeout, ctx.signal);
		} catch (err) {
			// LLM call failed - log and use fallback strategy
			const errDetail = err instanceof Error ? err.message : String(err);
			console.error(`[ai-permission-gate] Classification failed: ${errDetail}`);
			if (ctx.hasUI) {
				ctx.ui.notify(`Permission gate error: ${errDetail}`, "error");
			}
			if (fallback === "allow") return undefined;
			if (fallback === "block") {
				if (!ctx.hasUI) {
					return { block: true, reason: "Command blocked: AI safety check failed" };
				}
				return {
					block: true,
					reason: "Command blocked: AI safety check failed and fallback is set to block",
				};
			}
			// fallback === "confirm" - ask the user
			if (!ctx.hasUI) return undefined; // can't confirm in non-interactive mode, allow
			notify("Pi", "Permission gate: awaiting input");
			const choice = await ctx.ui.select(
				`⚠️ AI safety check failed\n\n  ${command}\n\nThe LLM could not classify this command. Allow it?`,
				["Yes", "No"],
			);
			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user (AI check failed)" };
			}
			return undefined;
		}

		// Check if the risk level meets the block threshold
		const blockThreshold = riskLevelIndex(blockLevel);
		const commandRisk = riskLevelIndex(verdict.risk);

		if (commandRisk >= blockThreshold && verdict.risk !== "safe") {
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `Potentially dangerous command: ${verdict.reason}`,
				};
			}

			const riskEmoji = verdict.risk === "high" ? "🔴" : verdict.risk === "medium" ? "🟡" : "🟢";
			notify("Pi", `Permission gate: ${verdict.risk} risk command`);
			const choice = await ctx.ui.select(
				`${riskEmoji} Potentially dangerous command (${verdict.risk} risk)\n\n  ${command}\n\n${verdict.reason}\n\nAllow?`,
				["Yes", "No"],
			);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
