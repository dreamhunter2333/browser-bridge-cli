---
name: browser-bridge-cli-skill-generator
description: Create Browser Bridge CLI workflow skills for operating one or more websites. Use when asked to generate a new skill from current conversation context, browser state, observed website flows, or a fresh request describing web tasks such as login, navigation, scraping, form submission, uploads, admin actions, or repeated multi-site browser operations.
---

# Browser Bridge CLI Skill Generator

Create a new skill that teaches Codex how to operate a specific website workflow with Browser Bridge CLI.

## Workflow

1. Identify the target workflow from the user request or current context.
2. If a browser is available, inspect the real site with `browser-bridge-cli` commands such as `info`, `tabs`, `query`, `eval`, `screenshot`, and `cdp`.
3. Capture only stable operational facts: URLs, page landmarks, selectors, button labels, required ordering, success signals, auth barriers, and known failure states.
4. Invoke `$skill-creator` to create the new user-facing workflow skill.
5. Use the output location requested by the user. If no destination is specified, let the agent infer the appropriate user skill location from context instead of assuming this repository.
6. Write `SKILL.md` with clear trigger metadata and the shortest reliable procedure for the workflow.
7. Add `agents/openai.yaml` with matching display metadata when that is part of the target skill format.

## Skill Shape

Use this structure for the generated workflow skill when the target skill format supports `agents/openai.yaml`:

```text
<workflow-skill-name>/
├── SKILL.md
└── agents/
    └── openai.yaml
```

The `<workflow-skill-name>/` directory is the artifact being created for the user, not a default path inside this repository.

Do not add scripts by default. Add references or assets only when the workflow truly needs reusable non-obvious context.

## Generated SKILL.md Guidance

The generated skill should include:

- What website or websites it operates.
- When to use the skill, in the frontmatter `description`.
- Required preconditions, such as logged-in browser state or selected account.
- Browser Bridge CLI commands that are useful for the workflow.
- Step-by-step flow with stable selectors or visible text when known.
- Verification signals for completion.
- Stop conditions, especially auth, payment, destructive, or permission barriers.

Keep the instructions source-backed. If a detail was inferred from context rather than observed in the live browser, mark it as an assumption.

## Multi-Site Workflows

For workflows spanning multiple websites, split the generated instructions by site and include the handoff condition between sites. Prefer stable URLs and visible UI landmarks over brittle CSS selectors.

## Guardrails

- Do not include secrets, session tokens, cookies, or private credentials in generated skills.
- Do not encode one-time local state as if it were generally valid.
- Preserve user confirmation points for destructive, paid, or externally visible actions.
- Keep the new skill narrow: one repeatable workflow, not a general website manual.
