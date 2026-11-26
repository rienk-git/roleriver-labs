# Lightweight development tooling

Status: accepted.

## Context

The project needs a reproducible local workflow across its TypeScript code and any justified future Python components.

## Alternatives

Heavy monorepo orchestration or making containers mandatory for all development.

## Decision

Use mise and pnpm, native scripts and lockfiles; use uv when Python is justified. Keep the CLI database-free. Introduce pinned Docker Compose infrastructure when persistence work requires it, as described in [ADR 007](007-dynamodb-object-storage.md). Defer distributed infrastructure until justified.

## Consequences

The local workflow stays small, while exact compatible versions and service-specific operating requirements need review before implementation.

## Revisit

Revisit when measurable task-graph complexity, deployment or data-access needs warrant different tooling.
