# Stackyard

- This is greenfield. Prefer clean current designs over compatibility layers. Change contracts and persisted formats directly; call out required data resets.
- If a rule conflicts with the task, stop, state the conflict, and get explicit user approval before breaking it.

## Code

- Treat performance, correctness, and maintainability as hard constraints. Avoid unnecessary or unbounded work. Measure non-obvious trade-offs.
- Fix root causes. Do not ship workarounds, silent fallbacks, or competing sources of truth.
- Every state needs a way in, a way out, and a way to inspect it. Close requires reopen. Irreversibility requires an explicit product decision.
- Keep complexity at adapter boundaries. Domain logic and orchestration stay transport- and framework-agnostic; UI renders state and emits intent.

## Frontend

- Do not add `title` attributes to elements.
- `cursor-pointer` is forbidden.

## UI

- Keep the interface calm and deliberate. Use clear hierarchy, typography, spacing, and alignment; keep color, borders, shadows, and motion restrained.
- Use the same components and behavior for similar actions.
- Make action priority obvious. Keep secondary actions visually subordinate and reveal advanced controls on demand.
- Make the interface feel instant. Give every action immediate feedback, and keep background work from blocking unrelated interaction.
- Keep layouts stable across loading, validation, hover, focus, and label changes. Preserve scroll position when async content appears.
- Keep interface text concise, short and useful. Use it to label actions, clarify consequences, report errors, or explain recovery.
- Do not narrate what the interface already communicates.
- Do not add a step, container, confirmation, modal, toast, or motion unless it clarifies hierarchy, collects required input, communicates otherwise hidden state, or prevents a meaningful mistake.

## Git

- Use plain-language Conventional Commit subjects and pull request titles.
- Keep each commit to one coherent change.
- In commit bodies, state the problem in one or two sentences, then explain the fix.
- Open every pull request description with a short, plain-language value pitch: in one or two sentences, explain what the change makes possible and why it matters. Keep implementation details out of the pitch.

## Verifying

- Run the narrowest checks that cover the change. Repo-wide checks require explicit user approval.
- Verify at the lowest stable layer that proves the behavior.
- Report what was verified and any gaps.
- Do not launch browsers or use computer-control tools for verification without explicit user approval.
- Do not add UI tests.
