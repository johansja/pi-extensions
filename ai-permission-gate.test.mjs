/**
 * Tests for the CWD-aware permission gate pure functions.
 *
 * Run with: node --test ai-permission-gate.test.mjs
 *
 * These tests cover riskLevelIndex(), stripCodeFences(), parseVerdict(),
 * and the CWD-aware system prompt content — the deterministic logic that
 * doesn't require an LLM call.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Inline copies of the pure functions under test.
// We copy them here rather than importing because the extension is a .ts file
// with side effects (spawns child processes). Keeping tests self-contained
// also makes it obvious what's being tested.
// ---------------------------------------------------------------------------

const RISK_LEVELS = ["safe", "low", "medium", "high"];

function riskLevelIndex(level) {
	return RISK_LEVELS.indexOf(level);
}

function stripCodeFences(raw) {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
	return text.trim();
}

function parseVerdict(raw) {
	const cleaned = stripCodeFences(raw);
	try {
		const parsed = JSON.parse(cleaned);
		if (
			parsed &&
			typeof parsed.risk === "string" &&
			RISK_LEVELS.includes(parsed.risk) &&
			typeof parsed.reason === "string"
		) {
			return parsed;
		}
	} catch {
		const jsonMatch = cleaned.match(/\{[^{}]*"risk"[^{}]*"reason"[^{}]*\}/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]);
				if (
					parsed &&
					typeof parsed.risk === "string" &&
					RISK_LEVELS.includes(parsed.risk) &&
					typeof parsed.reason === "string"
				) {
					return parsed;
				}
			} catch {
				// fall through
			}
		}
	}
	return { risk: "medium", reason: "Could not parse LLM verdict" };
}

// ---------------------------------------------------------------------------
// Read the source file for consistency and content tests
// ---------------------------------------------------------------------------

const extensionSource = fs.readFileSync(
	path.join(import.meta.dirname, "ai-permission-gate.ts"),
	"utf-8",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("riskLevelIndex", () => {
	it("returns correct indices for all risk levels", () => {
		assert.equal(riskLevelIndex("safe"), 0);
		assert.equal(riskLevelIndex("low"), 1);
		assert.equal(riskLevelIndex("medium"), 2);
		assert.equal(riskLevelIndex("high"), 3);
	});

	it("returns -1 for unknown risk level", () => {
		assert.equal(riskLevelIndex("unknown"), -1);
	});
});

describe("stripCodeFences", () => {
	it("strips code fence with json language tag", () => {
		assert.equal(
			stripCodeFences('```json\n{"risk":"low","reason":"test"}\n```'),
			'{"risk":"low","reason":"test"}',
		);
	});

	it("strips code fence without language tag", () => {
		assert.equal(
			stripCodeFences('```\n{"risk":"low","reason":"test"}\n```'),
			'{"risk":"low","reason":"test"}',
		);
	});

	it("returns plain text unchanged", () => {
		assert.equal(stripCodeFences("hello world"), "hello world");
	});

	it("returns already-stripped JSON unchanged", () => {
		const json = '{"risk":"safe","reason":"ok"}';
		assert.equal(stripCodeFences(json), json);
	});

	it("handles leading/trailing whitespace", () => {
		assert.equal(
			stripCodeFences('  \n  {"risk":"low","reason":"test"}  \n  '),
			'{"risk":"low","reason":"test"}',
		);
	});
});

describe("parseVerdict", () => {
	it("parses valid JSON verdict", () => {
		const result = parseVerdict('{"risk":"low","reason":"minor side effects"}');
		assert.deepEqual(result, { risk: "low", reason: "minor side effects" });
	});

	it("parses valid JSON verdict wrapped in code fences", () => {
		const result = parseVerdict('```json\n{"risk":"high","reason":"dangerous"}\n```');
		assert.deepEqual(result, { risk: "high", reason: "dangerous" });
	});

	it("parses valid JSON with extra whitespace", () => {
		const result = parseVerdict('  \n  {"risk":"safe","reason":"read-only"}  \n  ');
		assert.deepEqual(result, { risk: "safe", reason: "read-only" });
	});

	it("extracts JSON from surrounding text", () => {
		const result = parseVerdict('Here is my verdict: {"risk":"medium","reason":"moderate risk"} Done.');
		assert.deepEqual(result, { risk: "medium", reason: "moderate risk" });
	});

	it("returns medium fallback for unparseable text", () => {
		const result = parseVerdict("This is not JSON at all");
		assert.deepEqual(result, { risk: "medium", reason: "Could not parse LLM verdict" });
	});

	it("returns medium fallback for JSON with invalid risk level", () => {
		const result = parseVerdict('{"risk":"extreme","reason":"unknown risk"}');
		assert.deepEqual(result, { risk: "medium", reason: "Could not parse LLM verdict" });
	});

	it("returns medium fallback for JSON missing reason", () => {
		const result = parseVerdict('{"risk":"low"}');
		assert.deepEqual(result, { risk: "medium", reason: "Could not parse LLM verdict" });
	});
});

describe("consistency with source file", () => {
	it("RISK_LEVELS array matches the source file", () => {
		// Extract RISK_LEVELS from the .ts source
		const match = extensionSource.match(/const RISK_LEVELS\s*=\s*\[([^\]]+)\]/);
		assert.ok(match, "Could not find RISK_LEVELS in source file");
		const sourceLevels = match[1]
			.split(",")
			.map((s) => s.trim().replace(/"/g, ""));
		assert.deepEqual(sourceLevels, [...RISK_LEVELS]);
	});

	it("parseVerdict fallback risk matches the source file", () => {
		// Extract the fallback return from the source
		const match = extensionSource.match(
			/return \{\s*risk:\s*"(\w+)",\s*reason:\s*"Could not parse LLM verdict"\s*\}/,
		);
		assert.ok(match, "Could not find parseVerdict fallback in source file");
		assert.equal(match[1], "medium", "Fallback risk should be 'medium'");
	});
});

describe("CWD-aware system prompt content", () => {
	it("contains Working directory context section", () => {
		assert.match(extensionSource, /Working directory context:/);
	});

	it("mentions CWD in the user prompt template", () => {
		assert.match(extensionSource, /Current working directory:/);
	});

	it("classifyCommand accepts cwd parameter", () => {
		assert.match(extensionSource, /classifyCommand\([^)]*command:\s*string[^)]*cwd:\s*string/s);
	});

	it("passes ctx.cwd to classifyCommand", () => {
		assert.match(extensionSource, /classifyCommand\(command,\s*ctx\.cwd/);
	});

	it("tells LLM that CWD-scoped deletions are low risk", () => {
		assert.match(extensionSource, /Deleting files\/dirs under CWD.*low risk/);
	});

	it("tells LLM that system paths retain normal risk", () => {
		assert.match(extensionSource, /paths outside CWD.*retain their normal risk/);
	});

	it("low risk definition includes CWD-scoped deletions", () => {
		assert.match(extensionSource, /CWD-scoped deletions and modifications/);
	});

	it("high risk definition mentions outside CWD", () => {
		assert.match(extensionSource, /operations outside CWD that affect system state/);
	});

	it("package installs are described as low risk (not safe)", () => {
		assert.match(extensionSource, /Package installs.*within CWD are low risk/);
	});

	it("medium risk examples include CWD-outside path", () => {
		assert.match(extensionSource, /rm -rf \.\.\/other-project/);
	});

	it("CWD is delimited with backticks in user prompt", () => {
		assert.match(extensionSource, /Current working directory: \\`\$\{cwd\}\\`/);
	});

	it("classifyCommand has CWD fallback guard", () => {
		assert.match(extensionSource, /if \(!cwd\)\s*\{\s*cwd = process\.cwd\(\)/);
	});

	it("uses completeSimple from @mariozechner/pi-ai for classification", () => {
		assert.match(extensionSource, /completeSimple/);
		assert.match(extensionSource, /from "@mariozechner\/pi-ai"/);
	});

	it("does NOT use createAgentSession (heavier than needed)", () => {
		assert.doesNotMatch(extensionSource, /createAgentSession/);
	});

	it("does NOT use SessionManager for classification", () => {
		assert.doesNotMatch(extensionSource, /SessionManager/);
	});

	it("does NOT include subprocess spawn for classification", () => {
		assert.doesNotMatch(extensionSource, /from "node:child_process"/);
	});

	it("does NOT include temp file creation for prompts", () => {
		assert.doesNotMatch(extensionSource, /mkdtemp.*pi-ai-perm/);
	});

	it("resolveModel function exists for PI_AI_PERM_GATE_MODEL", () => {
		assert.match(extensionSource, /async function resolveModel/);
	});

	it("falls back to ctx.model when no PI_AI_PERM_GATE_MODEL is set", () => {
		assert.match(extensionSource, /resolveModel.*\?\?.*ctx\.model/s);
	});

	it("resolves API key via ModelRegistry.getApiKeyAndHeaders", () => {
		assert.match(extensionSource, /getApiKeyAndHeaders/);
	});

	it("does NOT include CWD_MAX_RISK env var (LLM-only approach)", () => {
		assert.doesNotMatch(extensionSource, /PI_AI_PERM_GATE_CWD_MAX_RISK/);
	});

	it("does NOT include isCwdScoped heuristic", () => {
		assert.doesNotMatch(extensionSource, /function isCwdScoped/);
	});

	it("does NOT include hasSystemEscapePattern", () => {
		assert.doesNotMatch(extensionSource, /function hasSystemEscapePattern/);
	});
});

describe("risk level comparison logic", () => {
	it("safe is below low threshold", () => {
		assert.equal(riskLevelIndex("safe") < riskLevelIndex("low"), true);
	});

	it("low meets the low block threshold", () => {
		assert.equal(riskLevelIndex("low") >= riskLevelIndex("low"), true);
	});

	it("high exceeds all thresholds", () => {
		assert.equal(riskLevelIndex("high") > riskLevelIndex("medium"), true);
		assert.equal(riskLevelIndex("high") > riskLevelIndex("low"), true);
	});
});
