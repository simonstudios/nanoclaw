# GitHub Integration Design

Add `gh` CLI to the agent container so NanoClaw can manage GitHub issues, projects, and PRs (read-only) from WhatsApp.

## Scope

- **Issues**: create, list, edit, close, comment, label, assign
- **Projects v2**: add items, set custom fields (Status, Priority), move between columns, query items
- **PRs**: list, view, check status (read-only - no create/merge/approve)
- **Default org**: `simonstudios` (all repos)

## Out of Scope

- No MCP server - `gh` via Bash is sufficient
- No router/channel changes - GitHub is a tool, not a message channel
- No IPC changes - agent runs `gh` like it runs `agent-browser`
- No webhook listener - agent queries on demand, doesn't react to GitHub events
- No code editing via GitHub - issues and project management only

## Authentication

Fine-grained PAT scoped to `simonstudios` org (all repos). Permissions needed:

- `issues: read/write`
- `projects: read/write`
- `pull_requests: read`
- `metadata: read`

Token stored in `.env` as `GH_TOKEN`, passed through existing secrets pipeline.

## Changes

### 1. Dockerfile

Install `gh` CLI from GitHub's official apt repository.

### 2. Secrets Pipeline (`src/container-runner.ts`)

Add `GH_TOKEN` to `readSecrets()` allowlist alongside existing keys.

### 3. Agent Runner (`container/agent-runner/src/index.ts`)

- Add `GH_TOKEN` to SDK environment (set from secrets) so `gh` authenticates automatically
- Do NOT add to `SECRET_ENV_VARS` — unlike API keys, `GH_TOKEN` must be available to Bash commands for `gh` to authenticate. The sanitization hook is for keys the agent should never touch (billing-sensitive API keys). The GitHub PAT is specifically intended for agent-initiated commands.

### 4. Container Skill (`container/skills/github/SKILL.md`)

Skill file covering three tiers:

**Issues** - `gh issue` command reference with `simonstudios` org default.

**Projects v2** - baked-in GraphQL recipes extracted from orchestkit:
- Discover project field IDs and option IDs
- Set custom fields (Status, Priority, etc.) via GraphQL mutations
- Move items between columns
- Add issues to projects
- Query project items with field values

**PRs (read-only)** - `gh pr list`, `gh pr view`, `gh pr checks`.

**Behavioural guidelines:**
- Confirm repo/org before creating or modifying issues
- Present summary before creating (WhatsApp messages can be ambiguous)
- Default org: `simonstudios`

### 5. `.env`

User adds `GH_TOKEN=github_pat_...` to their `.env` file.

## Architecture Fit

Follows the exact same pattern as the existing Anthropic API key:
- `.env` on host -> `readSecrets()` -> stdin JSON to container -> SDK env only
- GH_TOKEN intentionally NOT sanitized from Bash (unlike API keys) — `gh` needs it
- Token never written to disk inside container
