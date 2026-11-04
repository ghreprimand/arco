# Documentation style

How Arco repository guides and the in-app manual are structured so readers can scan them without losing detail.

## Voice and punctuation

- Use impersonal voice.
- Use ASCII punctuation only in prose (hyphen `-`, straight quotes, `...` for ellipsis).
- Exact on-screen UI labels and strings quoted in code formatting keep the glyphs the interface shows (for example `INCOGNITO · NOT SAVED`, `◔ BELL`, `▶ RUN IN TERMINAL`). Curly quotes and typographic dashes stay out regardless: the public audit refuses them.
- Do not use decorative emoji outside quoted UI labels.

## Purpose of every page

1. Open with one short paragraph that states what the page is for and who it is for.
2. List prerequisites next, when the reader needs them before acting.
3. Present the primary content for that page type (see below).
4. End with related links.

Dated history belongs in the monthly `devlog/` archive, or in an **Implementation history** section (or a collapsed details block) at the end of the page. History never sits above the current contract.

## Page types

| Type | Title style | Body |
|---|---|---|
| Concept | Noun phrase | What it is and when to use it. No steps. |
| Task | Imperative verb phrase | Prerequisites, numbered steps, expected result. |
| Reference | Noun phrase | Tables, definition lists, short bullets. |
| Troubleshooting | Symptom or "When X fails" | Symptom, cause, fix steps. |

Prefer one primary type per page. When a guide must mix types, keep each heading block to one type and label sections clearly.

## Length and density

- One idea per paragraph. Aim for under about 60 words when explaining a single control group.
- Prefer sentences under about 25 words when the meaning stays clear.
- Each bullet holds one fact or one short clause. If a bullet grows into a paragraph, promote it to a subsection or a two-column table (Name | Behavior).
- Numbered steps: one action per step. Put runnable commands in a fenced code block immediately under the step that uses them.

## Formatting

- Use **bold** only for on-screen UI labels and exact control names.
- Use `` `code` `` for commands, paths, environment variables, and protocol fields.
- Use tables for comparisons (run modes, providers, limits, feature summaries).
- Use alert-style callouts sparingly. Prefer a portable blockquote such as `> **Note:**` or `> **Warning:**` unless the renderer is known to support GitHub alert syntax.
- Use `<details>` / `<summary>` for optional depth or history appendices, never as the only copy of a required fact.

## Links and commands

- Prefer relative links to tracked documents and stable heading anchors.
- Do not invent commands. Verify every command against the scripts or code that implement it.
- Deep contracts may stay dense, but they still open with a purpose paragraph and a topic table or index when the page is long.

## Loss prevention

When rewriting a page:

1. Keep every current fact unless it is shown stale against current behavior.
2. Keep a fact checklist for the page (artifact or review note).
3. Run `npm run docs:check`.
4. Run the help-docs suite when the in-app manual or contextual help changes.
5. Run the public audit as required by the contribution process.
6. Add a `CHANGELOG.md` Unreleased bullet only when user-visible manual text changes.
