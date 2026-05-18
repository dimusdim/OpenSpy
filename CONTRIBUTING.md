# Contributing to OpenSpy

OpenSpy is early open-source software. The project needs focused contributions that improve data coverage, source reliability, rendering performance, agent tooling, installation, and public documentation.

## Contribution Flow

1. Fork the repository.
2. Clone your fork.
3. Create a feature branch from `main`.
4. Make a focused change.
5. Run the relevant local checks.
6. Open a pull request with a clear description, screenshots for UI work, and notes about any provider/API behavior.

```bash
git clone https://github.com/YOUR_USERNAME/openspy.git
cd openspy
git checkout -b feature/short-description
npm run install:all
```

## Local Setup

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
npm run dev
```

Open `http://localhost:3737`.

Docker path:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
npm run docker:up
```

## Before Opening a PR

At minimum:

```bash
npm run build
git status --short
```

For frontend or map changes, include screenshots or a short screen recording. For data-source changes, include the source, endpoint, auth model, refresh cadence, rate limits, and a sample response shape without secrets.

## Good First Areas

- Improve install and Docker setup.
- Add safe public documentation and examples.
- Improve layer styling, legends, and entity HUDs.
- Add new no-key or free-key public sources.
- Improve source status, freshness, and provenance metadata.
- Improve replay UX and render performance.
- Harden agent tool contracts and source capability descriptions.

## Data Source Rules

- Do not commit API keys, tokens, cookies, private account IDs, or downloaded private datasets.
- Add credentials only to `.env.example` as empty variable names.
- Make provider limitations explicit: auth, free tier, quota, pagination, historical access, update cadence, and terms caveats.
- Keep provider data access inside backend services or explicit agent/source-fetch tools.
- Do not hide backend result limits or filters. If a provider or account imposes a real limit, return it visibly in metadata.
- Do not add backend logic that interprets user prompts or decides analytic workflow for the agent.

## Agent Harness Rules

Versioned product-agent files live under `agent-harness/`.

- Keep product-agent instructions in `agent-harness/core`.
- Keep executable tool wrappers in `agent-harness/tools`.
- Do not depend on root `AGENTS.md`, root `CLAUDE.md`, `.agents/`, or `.claude/`; those are developer-local and ignored.
- Backend APIs may return facts, tool contracts, diagnostics, provider limitations, and hints about how to call a tool.
- Backend APIs must not inject task checklists, source capability prose, or prompt-specific instructions into the agent.
- Do not use regex or keyword checks over final agent prose as semantic acceptance. Use structured tool evidence and human/LLM review.

## UI and Rendering Rules

- Keep the globe usable with all default layers enabled.
- Preserve real source semantics; do not make performance fixes by silently hiding or changing data meaning.
- Use stable responsive layout for panels, HUDs, controls, and replay cards.
- If a layer is expensive, optimize batching, level of detail, caching, or render path before removing it.
- New visual effects should be independently toggleable and should not leak into unrelated layers.

## Commit and PR Style

Use descriptive commit messages:

```text
Add Sentinel imagery source metadata

Explain the user-facing capability, the changed API contract, and any
provider limitation that affects runtime behavior.
```

Do not include tool-generated co-author trailers such as `Co-authored-by:` for local AI assistants or model names.

PR descriptions should include:

- what changed;
- why it changed;
- how to test it;
- screenshots/video for UI changes;
- source/provider notes for data changes;
- known limitations.

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
