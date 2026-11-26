# DynamoDB and object storage

Status: accepted.

## Context

A local-first CLI needs a serverless-ready path for operational records and private objects without requiring a relational database. The CLI MVP remains database-free.

## Alternatives

Relational databases; DynamoDB with direct SDK access alone; filesystem or an S3-compatible local emulator for objects.

## Decision

Use DynamoDB for structured records and private S3 for objects; use ElectroDB with AWS SDK v3 and its Document Client behind narrow domain-oriented ports. ElectroDB reduces repetitive entity and key handling and provides typed access patterns; it does not eliminate DynamoDB design or correctness risks. Use direct SDK operations when clearer. Develop with DynamoDB Local and initially a filesystem object adapter, with shared contract tests and explicit local/cloud configuration. No live AWS account is required in default development or CI. Compose infrastructure starts at the persistence milestone.

## Consequences

Define access patterns, tenant boundaries, pagination, consistency, conditional writes and indexes before table design; validate a representative entity with conditional writes and paginated queries against DynamoDB Local, and avoid normal unbounded scans. DynamoDB TTL is not an exact deadline. Large objects require integrity references and retry-safe cross-store recovery because DynamoDB and S3 are not atomic together. Private data and static hosting buckets are separate. Pin images, protect data with least-privilege IAM, encryption and retention/deletion policies. Emulators cannot prove AWS behavior.

## Revisit

Reassess table strategy, local object emulation or relational storage when a demonstrated requirement or measured evidence warrants it. Cloud resources and tests require explicit authorization.
