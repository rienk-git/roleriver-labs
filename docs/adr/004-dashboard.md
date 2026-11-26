# Static dashboard and separate API

Status: accepted.

## Context

The project starts with a local single-user CLI and must preserve a path to later capabilities without claiming they exist.

## Alternatives

Runtime SSR or a Next.js backend.

## Decision

Use Next.js static export and a separate API; public demos use synthetic data.

## Consequences

Independent deployment and constrained runtime features.

## Revisit

Revisit runtime SSR only with an approved concrete requirement.
