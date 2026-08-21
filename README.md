# Guillermo

Guillermo is a small local coding agent built to learn how an LLM can work on a repository safely and transparently. It intentionally does **not** integrate with Jira or GitHub yet.

## What it does

Given a task and a target Git repository, Guillermo asks an OpenAI model to use four narrow tools:

1. `list_files` — inspect the repository tree.
2. `read_file` — inspect a text file in the repository.
3. `apply_patch` — apply a validated unified diff.
4. `run_tests` — run a package-manager test command from a small allowlist.

After the run, it prints the test result, changed files, and the complete Git diff. Guillermo has no general shell tool and refuses patches outside the selected repository.

## Setup

```bash
npm install
cp .env.example .env
# Add your OpenAI API key to .env. Guillermo loads it automatically at startup.
# You can also export it in your shell; exported values take precedence.
```

## Run it

Point it at another Git repository (not Guillermo itself unless that is intentional):

```bash
npm run dev -- \
  --repo /absolute/path/to/a/repository \
  --task "Add a test for the URL parser and fix any bug the test identifies"
```

Use `--model` to override `GUILLERMO_MODEL`, or `--max-steps` to cap tool calls:

```bash
npm run dev -- --repo /path/to/repo --task "..." --max-steps 12
```

## Deliberate limits

- It does not create branches, commits, pull requests, or network requests.
- It uses one persisted-in-process event stream only; durable run storage comes later with Jira.
- `apply_patch` accepts only repository-relative text-file patches and blocks sensitive paths such as `.env`, `.git`, `node_modules`, and lockfiles.
- `run_tests` permits `npm`, `pnpm`, `yarn`, or `bun` test commands only, without shell operators.

This is an intentional first slice of the 12-factor approach: prompts are owned in source, the context is selected by tools, actions are structured outputs, and TypeScript—not the LLM—owns the control flow.
