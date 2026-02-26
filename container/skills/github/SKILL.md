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
