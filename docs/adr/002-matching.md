# AI-first semantic matching and deterministic control

Status: accepted.

## Context

The CLI must assess real experience in context without requiring users to maintain a lossy structured skills profile or a manually curated matching ontology.

## Alternatives

A comprehensive deterministic skill matcher, weighted scores and a hardcoded equivalence matrix; an unconstrained autonomous agent; or multiple extraction and scoring calls for every assessment.

## Decision

Use one logical structured AI assessment request per relevant CV/vacancy version through a narrow provider adapter. The model interprets requirements, alternatives, evidence and transferable experience and recommends apply, review or skip. Deterministic code validates references and consistency, applies confirmed objective constraints and controls operations. Missing evidence is unknown; a high score never overrides a confirmed unmet hard requirement.

## Consequences

The original CV and user corrections remain authoritative. Minimize and redact personal data, isolate untrusted text from instructions, and validate output without claiming that schema validity proves truth. Version prompts and provenance; use synthetic evaluations and mocked offline tests. Provider quality, cost and nondeterminism require ongoing evaluation. Retries are bounded and observable. An optional generated profile or multi-stage processing requires a demonstrated need.

## Revisit

Revisit when evaluation evidence shows a need for specialized processing, or privacy and operational constraints require a different provider approach.
