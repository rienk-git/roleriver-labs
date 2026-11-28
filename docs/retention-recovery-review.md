# Retention and recovery review

This review applies the repository's simplicity principle to the I02 recovery work. Production can return a general error and rely on a user or operator retry or documented manual recovery when that safely addresses an uncommon failure. Automatic recovery is not a requirement by itself.

## Findings

- Role and evidence retention is currently disabled until multi-owner coordination exists, but remains a planned capability. Its current implementation needs review for whether it supports the approved multi-owner design; disabled status alone is not a reason to remove it. Design multi-owner retention when the role lifecycle supplies authoritative ownership.
- `gmail-objects.ts` combines generic transaction-action serialization, durable intents, retry reconciliation and purge logic. Evaluate replacing this with narrow typed operations and an error requiring controlled reconciliation when an outcome is uncertain. The replacement must account for existing references and uncommitted writes; it must not blindly delete an object that might be shared or still needed.
- Local startup binds four filesystem roots to a database marker. A persistent local database or explicitly disposable local environment may provide a simpler operating model, but either requires a concrete migration and failure contract. Existing markers and content must not be silently discarded or rebound.
- Automatic replay, paginated sweeps and cross-process fencing should each have a concrete operational justification. A user-triggered retry or full resynchronization may suffice if incomplete results stay unavailable and the checkpoint is not advanced prematurely. A single-process local assumption must be enforced, and does not by itself establish distributed production safety.

The last three points are candidates for a coordinated follow-up design, not claims that the current code can simply be deleted. The [simplification proposal](i02-simplification-proposal.md) sets out a concrete replacement for owner review. The existing [recovery design](i02-recovery-proposal.md) documents the current implementation and remains the reference until a replacement is approved.

## Safety boundaries

Continue to enforce source permission at dispatch, tenant and connection ownership, token isolation, bounded inputs and sanitized errors. A failed sync must not publish an incomplete checkpoint or expose a partial result as complete. Do not delete committed, shared or potentially needed content without a reliable ownership decision. Ambiguous provider revocation remains pending for explicit retry or manual remediation; never report success without evidence. Gmail-origin manual imports and legacy digest-named objects require provenance and ownership reconciliation before deletion.
