/**
 * Tests for the team/agents.ts discovery and parsing functions.
 *
 * Run with: node --test team/agents.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Mock parseFrontmatter (mimics @mariozechner/pi-coding-agent behavior) ─

function parseFrontmatter(content) {
	const match = content.match(/^---\r?\n(.*?)\r?\n---\r?\n(.*)$/s);
	if (!match) {
		return { frontmatter: {}, body: content };
	}
	const raw = match[1];
	const body = match[2];
	const frontmatter = {};
	for (const line of raw.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			frontmatter[key] = value;
		}
	}
	return { frontmatter, body };
}

// ─── Inlined functions from team/agents.ts ─────────────────────────────────

function isDirectory(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function loadAgentsFromDir(dir, source) {
	const agents = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const toolsRaw = frontmatter.tools?.trim().toLowerCase();
		const tools = toolsRaw === "all" || toolsRaw === "*"
			? ["all"]
			: toolsRaw
				?.split(",")
				.map((t) => t.trim())
				.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function findNearestProjectAgentsDir(cwd) {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "team");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeTmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
}

function cleanup(dir) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch { /* best effort */ }
}

function writeAgentFile(dir, filename, frontmatter, body = "# System prompt\n") {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	const content = `---\n${fm}\n---\n${body}`;
	fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("loadAgentsFromDir", () => {
	let tmpDir;

	it("setup", () => {
		tmpDir = makeTmpDir();
	});

	it("parses valid agent .md files", () => {
		writeAgentFile(tmpDir, "planner.md", {
			name: "planner",
			description: "Plans architecture",
			model: "openai/gpt-4o",
			thinking: "high",
		});

		const agents = loadAgentsFromDir(tmpDir, "project");
		assert.equal(agents.length, 1);
		assert.equal(agents[0].name, "planner");
		assert.equal(agents[0].description, "Plans architecture");
		assert.equal(agents[0].model, "openai/gpt-4o");
		assert.equal(agents[0].thinking, "high");
		assert.equal(agents[0].source, "project");
		assert.ok(agents[0].filePath.endsWith("planner.md"));
	});

	it("parses tools field", () => {
		writeAgentFile(tmpDir, "worker.md", {
			name: "worker",
			description: "Does work",
			tools: "read, bash",
		});

		const agents = loadAgentsFromDir(tmpDir, "project");
		const worker = agents.find((a) => a.name === "worker");
		assert.ok(worker);
		assert.deepEqual(worker.tools, ["read", "bash"]);
	});

	it("handles tools: all", () => {
		writeAgentFile(tmpDir, "super.md", {
			name: "super",
			description: "All tools",
			tools: "all",
		});

		const agents = loadAgentsFromDir(tmpDir, "project");
		const superAgent = agents.find((a) => a.name === "super");
		assert.ok(superAgent);
		assert.deepEqual(superAgent.tools, ["all"]);
	});

	it("handles tools: *", () => {
		writeAgentFile(tmpDir, "wildcard.md", {
			name: "wildcard",
			description: "Wildcard tools",
			tools: "*",
		});

		const agents = loadAgentsFromDir(tmpDir, "project");
		const w = agents.find((a) => a.name === "wildcard");
		assert.ok(w);
		assert.deepEqual(w.tools, ["all"]);
	});

	it("skips files missing required fields", () => {
		const subDir = path.join(tmpDir, "missing-fields");
		fs.mkdirSync(subDir);
		writeAgentFile(subDir, "no-name.md", { description: "No name" });
		writeAgentFile(subDir, "no-desc.md", { name: "NoDesc" });

		const agents = loadAgentsFromDir(subDir, "project");
		assert.equal(agents.length, 0);
	});

	it("skips non-.md files", () => {
		const subDir = path.join(tmpDir, "non-md");
		fs.mkdirSync(subDir);
		fs.writeFileSync(path.join(subDir, "readme.txt"), "hello", "utf-8");
		const agents = loadAgentsFromDir(subDir, "project");
		assert.equal(agents.length, 0);
	});

	it("returns empty array for missing dir", () => {
		const agents = loadAgentsFromDir(path.join(tmpDir, "missing"), "project");
		assert.deepEqual(agents, []);
	});

	it("returns empty array for empty dir", () => {
		const emptyDir = path.join(tmpDir, "empty");
		fs.mkdirSync(emptyDir);
		const agents = loadAgentsFromDir(emptyDir, "project");
		assert.deepEqual(agents, []);
	});

	it("cleanup", () => {
		cleanup(tmpDir);
	});
});

describe("findNearestProjectAgentsDir", () => {
	let tmpDir;

	it("setup", () => {
		tmpDir = makeTmpDir();
	});

	it("finds .pi/team from cwd", () => {
		const teamDir = path.join(tmpDir, ".pi", "team");
		fs.mkdirSync(teamDir, { recursive: true });
		const result = findNearestProjectAgentsDir(tmpDir);
		assert.equal(result, teamDir);
	});

	it("finds from a subdirectory", () => {
		const subDir = path.join(tmpDir, "src", "components");
		fs.mkdirSync(subDir, { recursive: true });
		const result = findNearestProjectAgentsDir(subDir);
		assert.equal(result, path.join(tmpDir, ".pi", "team"));
	});

	it("returns null when no .pi/team exists", () => {
		const orphanDir = makeTmpDir();
		const result = findNearestProjectAgentsDir(orphanDir);
		assert.equal(result, null);
		cleanup(orphanDir);
	});

	it("stops at filesystem root", () => {
		const result = findNearestProjectAgentsDir(path.parse(tmpDir).root);
		// On Unix this is /, on Windows C:\ etc. Should be null unless .pi/team exists there.
		// We just verify it doesn't throw.
		assert.equal(typeof result, typeof null);
	});

	it("cleanup", () => {
		cleanup(tmpDir);
	});
});

describe("isDirectory", () => {
	let tmpDir;

	it("setup", () => {
		tmpDir = makeTmpDir();
	});

	it("returns true for directories", () => {
		assert.equal(isDirectory(tmpDir), true);
	});

	it("returns false for files", () => {
		const filePath = path.join(tmpDir, "file.txt");
		fs.writeFileSync(filePath, "hello", "utf-8");
		assert.equal(isDirectory(filePath), false);
	});

	it("returns false for missing paths", () => {
		assert.equal(isDirectory(path.join(tmpDir, "nonexistent")), false);
	});

	it("cleanup", () => {
		cleanup(tmpDir);
	});
});

describe("frontmatter edge cases", () => {
	let tmpDir;

	it("setup", () => {
		tmpDir = makeTmpDir();
	});

	it("malformed YAML still extracts known fields", () => {
		// Our simple parser is forgiving — it extracts key: value pairs line by line
		const content = `---\nname: edge\ndescription: Edge case agent\nextra: stuff\n---\nbody here`;
		const { frontmatter, body } = parseFrontmatter(content);
		assert.equal(frontmatter.name, "edge");
		assert.equal(frontmatter.description, "Edge case agent");
		assert.equal(frontmatter.extra, "stuff");
		assert.equal(body, "body here");
	});

	it("missing frontmatter delimiters returns empty frontmatter", () => {
		const content = "Just some markdown\nwithout frontmatter";
		const { frontmatter, body } = parseFrontmatter(content);
		assert.deepEqual(frontmatter, {});
		assert.equal(body, content);
	});

	it("missing fields yields undefined for those keys", () => {
		const content = `---\nname: partial\n---\nbody here`;
		const { frontmatter } = parseFrontmatter(content);
		assert.equal(frontmatter.name, "partial");
		assert.equal(frontmatter.description, undefined);
	});

	it("empty dir with unreadable file", () => {
		const emptyDir = path.join(tmpDir, "unreadable");
		fs.mkdirSync(emptyDir);
		fs.writeFileSync(path.join(emptyDir, "bad.md"), "no frontmatter", "utf-8");
		const agents = loadAgentsFromDir(emptyDir, "project");
		assert.equal(agents.length, 0);
	});

	it("cleanup", () => {
		cleanup(tmpDir);
	});
});
