# Modular workflow and contracts

Status: accepted.

## Context

The project starts with a local single-user CLI and must preserve a path to later capabilities without claiming they exist.

## Alternatives

Mandatory microservices or a permanent monolith.

## Decision

Start in-process with TypeScript ports/adapters and explicit orchestration; Python only for a concrete benefit. Use schema-first versioned contracts at real boundaries.

## Consequences

Fast local work with a migration path; no durable events by default.

## Revisit

Revisit when isolation or cross-language needs justify distribution.
