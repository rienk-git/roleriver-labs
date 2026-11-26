# Email-first, policy-gated discovery

Status: accepted.

## Context

The project starts with a local single-user CLI and must preserve a path to later capabilities without claiming they exist.

## Alternatives

Unrestricted scraping or browser-first discovery.

## Decision

Use Gmail read-only polling, official APIs/feeds and permitted sources, with manual fallback and central default-deny per-method enforcement.

## Consequences

Requires permission evidence and robust incomplete-source handling.

## Revisit

Revisit when source permissions or operational requirements change.
