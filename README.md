# Grace AI

A 3-layer AI agent architecture that separates directive, orchestration, and execution concerns to maximize reliability.

## Architecture

- **Layer 1: Directive** - SOPs written in Markdown (`directives/`)
- **Layer 2: Orchestration** - Intelligent routing and decision making (this agent)
- **Layer 3: Execution** - Deterministic Python scripts (`execution/`)

## Directory Structure

```
grace-ai/
├── directives/    # SOPs and instruction sets
├── execution/     # Deterministic Python scripts
├── .tmp/          # Intermediate files (not committed)
└── .env           # Environment variables (not committed)
```

## Getting Started

1. Add directives to `directives/`
2. Add execution scripts to `execution/`
3. Configure environment variables in `.env`

<!-- Last updated: 2026-02-18 -->
