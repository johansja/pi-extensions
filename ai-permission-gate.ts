/**
 * AI Permission Gate Extension
 *
 * Uses an LLM (spawned as a child pi process) to determine whether
 * a bash command is potentially harmful and should require user
 * confirmation before execution.
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
 *   PI_AI_PERM_GATE_MODEL       - Model to use for classification (default: pi's default model)
 *   PI_AI_PERM_GATE_BLOCK_LEVEL - Minimum risk level to block: "low" | "medium" | "high" (default: "low")
 *     "low"    = block on any risk (safest, most confirmations)
 *     "medium" = block on medium and high risk
 *     "high"   = only block on high risk (fewest confirmations)
 *   PI_AI_PERM_GATE_TIMEOUT     - Timeout in ms for the LLM call (default: 10000)
 *   PI_AI_PERM_GATE_FALLBACK    - What to do if LLM fails: "allow" | "block" | "confirm" (default: "confirm")
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

async function classifyCommand(command: string, cwd: string, model: string | undefined, timeout: number, signal: AbortSignal | undefined): Promise<Verdict> {
	// Fallback to process CWD if ctx.cwd is missing
	if (!cwd) {
		cwd = process.cwd();
	}
	// Write the system prompt and user prompt to temp files so we can pass them to pi
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ai-perm-"));

	try {
		const promptPath = path.join(tmpDir, "prompt.md");
		await fs.promises.writeFile(promptPath, SYSTEM_PROMPT, { encoding: "utf-8", mode: 0o600 });

		const args: string[] = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--tools", "read", // need at least one tool; read is harmless
			"--append-system-prompt", promptPath,
		];

		if (model) {
			args.push("--model", model);
		}

		// The user prompt is the command to classify, with CWD context
		args.push(`Analyze this shell command for safety: ${command}\n\nCurrent working directory: \`${cwd}\``);

		const invocation = getPiInvocation(args);
		let buffer = "";
		let lastAssistantText = "";

		const exitCode = await new Promise<number>((resolve, reject) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: os.homedir(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message?.role === "assistant") {
					for (const part of event.message.content) {
						if (part.type === "text") {
							lastAssistantText = part.text;
						}
					}
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 1);
			});

			proc.on("error", (err) => {
				reject(err);
			});

			// Handle timeout
			const timer = setTimeout(() => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 3000);
			}, timeout);

			proc.on("close", () => clearTimeout(timer));

			// Handle abort signal
			if (signal) {
				const killProc = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 3000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		if (exitCode !== 0 || !lastAssistantText) {
			throw new Error(`LLM classification failed (exit code ${exitCode})`);
		}

		return parseVerdict(lastAssistantText);
	} finally {
		// Cleanup temp dir
		try {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Try to use the same pi binary that's running
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
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
		const model = process.env.PI_AI_PERM_GATE_MODEL || undefined;
		const blockLevel = (process.env.PI_AI_PERM_GATE_BLOCK_LEVEL as RiskLevel) || "low";
		const timeout = parseInt(process.env.PI_AI_PERM_GATE_TIMEOUT || "10000", 10);
		const fallback = process.env.PI_AI_PERM_GATE_FALLBACK || "confirm";

		let verdict: Verdict;
		try {
			verdict = await classifyCommand(command, ctx.cwd, model, timeout, ctx.signal);
		} catch (err) {
			// LLM call failed - use fallback strategy
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
