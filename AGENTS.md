# Agent Instructions — Pi Extensions

## Project Overview

This repository contains custom extensions for the pi coding agent. Extensions are TypeScript files that use pi's ExtensionAPI to hook into the agent lifecycle (tool calls, session events, commands, etc.).

## Repository Structure

- Single-file extensions live at the repo root (e.g., `ai-permission-gate.ts`).
- Multi-file extensions live in their own directory (e.g., `team/index.ts`, `team/agents.ts`).
- Test files sit alongside their extension (e.g., `ai-permission-gate.test.mjs`).

## Development Guidelines

- **Language:** TypeScript, targeting Node.js (pi uses tsx for runtime compilation).
- **Imports:** Use `@mariozechner/pi-coding-agent` for the ExtensionAPI type and helpers. Use `@mariozechner/pi-ai` and `@sinclair/typebox` where needed (as the team extension does).
- **No build step:** pi loads `.ts` files directly via tsx. Do not add a build/compile step.
- **No npm/pnpm:** This is not a Node.js package. Dependencies are pi's own dependencies (available at runtime).
- **Symlink deployment:** Extensions are deployed by symlinking into `~/.pi/agent/extensions/`. Always use `ln -sf` to update symlinks.

## Conventions

- Each extension exports a default function: `export default function(pi: ExtensionAPI) { ... }`.
- Use `pi.on("tool_call", ...)` for tool call hooks, `pi.registerTool(...)` for custom tools, `pi.registerCommand(...)` for slash commands.
- Prefer environment variables for configuration (prefixed with `PI_`).
- Keep extensions self-contained — do not cross-import between extensions.
- Write tests as `.mjs` files using Node.js built-in `node:test` and `node:assert/strict`.

## Git

- Never auto-commit. Make changes, inform the user, and let them review and commit.
