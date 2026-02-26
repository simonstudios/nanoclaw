# GitHub Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `gh` CLI to the agent container so NanoClaw can manage GitHub issues, projects, and PRs (read-only) from WhatsApp.

**Architecture:** Install `gh` in the Dockerfile, pipe a `GH_TOKEN` PAT through the existing secrets pipeline into the SDK environment, and create a container skill with `gh` CLI reference + Projects v2 GraphQL recipes.

**Tech Stack:** `gh` CLI, GitHub GraphQL API, existing NanoClaw secrets pipeline

---

### Task 1: Install `gh` CLI in Dockerfile

**Files:**
- Modify: `container/Dockerfile:7-26`

**Step 1: Add `gh` CLI installation to Dockerfile**

Add the GitHub CLI apt repository and install `gh` in the existing `apt-get` block. Insert before the existing `apt-get` block:

```dockerfile
# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
```

Then add `gh` to the existing `apt-get install` list (line 7-26), adding `gh \` after `git \`.

**Step 2: Build the container to verify**

Run: `./container/build.sh`
Expected: Build succeeds with no errors.

**Step 3: Verify `gh` is installed in the container**

Run: `container run --rm nanoclaw-agent:latest gh --version`
Expected: Output like `gh version 2.x.x`

**Step 4: Commit**

```bash
git add container/Dockerfile
git commit -m "feat(container): install gh CLI for GitHub integration"
```

---

### Task 2: Add `GH_TOKEN` to secrets pipeline

**Files:**
- Modify: `src/container-runner.ts:184-186`

**Step 1: Add `GH_TOKEN` to the readSecrets allowlist**

In `src/container-runner.ts` line 184-186, change:

```typescript
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}
```

To:

```typescript
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GH_TOKEN']);
}
```

This reads `GH_TOKEN` from `.env` and passes it via stdin JSON to the container. The agent runner already merges all secrets into `sdkEnv` (see `container/agent-runner/src/index.ts:512-515`), so `GH_TOKEN` will automatically be available to `gh` commands.

**Important:** Do NOT add `GH_TOKEN` to `SECRET_ENV_VARS` in the agent runner. The sanitization hook unsets those vars before every Bash command. `gh` needs `GH_TOKEN` to authenticate — it's intentionally available to Bash, unlike the API keys which are billing-sensitive.

**Step 2: Build to verify**

Run: `npm run build`
Expected: Compiles with no errors.

**Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(secrets): add GH_TOKEN to container secrets pipeline"
```

---

### Task 3: Create the GitHub container skill

**Files:**
- Create: `container/skills/github/SKILL.md`

**Step 1: Create the skill file**

Create `container/skills/github/SKILL.md` with the following content:

````markdown
---
name: github
description: Manage GitHub issues, projects, and PRs for the simonstudios org using the gh CLI.
allowed-tools: Bash(gh:*)
---

# GitHub Management with `gh` CLI

Default org: `simonstudios`. Always confirm the repo with the user before creating or modifying issues.

## Issues

```bash
# List open issues
gh issue list -R simonstudios/REPO

# Create issue (present summary to user before running)
gh issue create -R simonstudios/REPO --title "TITLE" --body "BODY" --label "bug"

# View issue details
gh issue view NUMBER -R simonstudios/REPO

# Edit issue
gh issue edit NUMBER -R simonstudios/REPO --title "NEW TITLE" --add-label "priority:high"

# Close issue
gh issue close NUMBER -R simonstudios/REPO

# Reopen issue
gh issue reopen NUMBER -R simonstudios/REPO

# Add comment
gh issue comment NUMBER -R simonstudios/REPO --body "Comment text"

# Assign
gh issue edit NUMBER -R simonstudios/REPO --add-assignee USERNAME

# Search issues across org
gh search issues "query" --owner simonstudios
```

## Pull Requests (read-only)

Do NOT create, merge, or approve PRs.

```bash
# List PRs
gh pr list -R simonstudios/REPO

# View PR details
gh pr view NUMBER -R simonstudios/REPO

# Check PR status (CI checks)
gh pr checks NUMBER -R simonstudios/REPO
```

## Projects v2

Projects v2 uses GraphQL for custom fields. The `gh project` CLI covers basics, but setting field values (Status, Priority) requires `gh api graphql`.

### List projects

```bash
gh project list --owner simonstudios
```

### View project items

```bash
gh project item-list PROJECT_NUMBER --owner simonstudios
```

### Add issue to project

```bash
gh project item-add PROJECT_NUMBER --owner simonstudios --url https://github.com/simonstudios/REPO/issues/NUMBER
```

### Discover field IDs and option IDs

Before setting custom fields, you must discover the field and option IDs. They are opaque strings that change per project.

```bash
gh api graphql -f query='
  query($org: String!, $number: Int!) {
    organization(login: $org) {
      projectV2(number: $number) {
        id
        fields(first: 20) {
          nodes {
            ... on ProjectV2Field {
              id
              name
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
            ... on ProjectV2IterationField {
              id
              name
            }
          }
        }
      }
    }
  }' -f org="simonstudios" -F number=PROJECT_NUMBER
```

Save the project ID, field IDs, and option IDs from the output. You will need them for mutations below.

### Set a single-select field (Status, Priority, etc.)

```bash
gh api graphql -f query='
  mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $project
      itemId: $item
      fieldId: $field
      value: {singleSelectOptionId: $option}
    }) {
      projectV2Item { id }
    }
  }' -f project="PROJECT_ID" -f item="ITEM_ID" -f field="FIELD_ID" -f option="OPTION_ID"
```

### Set a text field

```bash
gh api graphql -f query='
  mutation($project: ID!, $item: ID!, $field: ID!, $text: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $project
      itemId: $item
      fieldId: $field
      value: {text: $text}
    }) {
      projectV2Item { id }
    }
  }' -f project="PROJECT_ID" -f item="ITEM_ID" -f field="FIELD_ID" -f text="VALUE"
```

### Set a number field

```bash
gh api graphql -f query='
  mutation($project: ID!, $item: ID!, $field: ID!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $project
      itemId: $item
      fieldId: $field
      value: {number: 5}
    }) {
      projectV2Item { id }
    }
  }' -f project="PROJECT_ID" -f item="ITEM_ID" -f field="FIELD_ID"
```

### Query project items with field values

```bash
gh api graphql -f query='
  query($org: String!, $number: Int!) {
    organization(login: $org) {
      projectV2(number: $number) {
        items(first: 50) {
          nodes {
            id
            content {
              ... on Issue {
                title
                number
                state
                url
              }
              ... on PullRequest {
                title
                number
                state
                url
              }
            }
            fieldValues(first: 10) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2Field { name } }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number
                  field { ... on ProjectV2Field { name } }
                }
              }
            }
          }
        }
      }
    }
  }' -f org="simonstudios" -F number=PROJECT_NUMBER
```

### Get issue node ID (needed for addProjectV2ItemById)

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id
      }
    }
  }' -f owner="simonstudios" -f repo="REPO" -F number=ISSUE_NUMBER
```

## Workflow Tips

- **Always discover field IDs first** before trying to set custom fields. IDs are opaque and project-specific.
- **Cache project/field IDs** within a conversation — they don't change between calls.
- **Confirm before creating** — present the issue title, body, labels, and repo to the user before running `gh issue create`.
- **Use `--json` for structured output** — most `gh` commands support `--json` for machine-readable output, e.g. `gh issue list -R REPO --json number,title,state,labels`.
````

**Step 2: Verify skill file structure**

Run: `ls -la container/skills/github/SKILL.md`
Expected: File exists.

**Step 3: Commit**

```bash
git add container/skills/github/SKILL.md
git commit -m "feat(skills): add GitHub management skill with Projects v2 GraphQL recipes"
```

---

### Task 4: Rebuild container and verify end-to-end

**Step 1: Rebuild the container**

The buildkit cache may retain stale files. Prune first if needed, then rebuild:

Run: `./container/build.sh`
Expected: Build succeeds.

**Step 2: Verify `gh` authenticates inside container**

This requires `GH_TOKEN` in `.env`. If not yet set, remind the user to create a fine-grained PAT at https://github.com/settings/personal-access-tokens/new with:
- Resource owner: `simonstudios`
- Repository access: All repositories
- Permissions: Issues (read/write), Projects (read/write), Pull requests (read), Metadata (read)

Then add to `.env`:
```
GH_TOKEN=github_pat_...
```

**Step 3: Test via NanoClaw**

Run `npm run dev` and send a message via WhatsApp like "list open issues on [repo]" to verify the agent can use `gh`.

**Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "feat: GitHub integration - gh CLI in container with Projects v2 support"
```

---

### Task 5: Update design doc with corrections

**Files:**
- Modify: `docs/plans/2026-02-23-github-integration-design.md`

The design doc already has the corrected GH_TOKEN handling (not in SECRET_ENV_VARS). Amend the previous design commit to include the corrections.

**Step 1: Commit the corrected design doc**

```bash
git add docs/plans/2026-02-23-github-integration-design.md
git commit -m "docs: correct GH_TOKEN handling in GitHub integration design"
```
