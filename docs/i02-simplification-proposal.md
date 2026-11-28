# I02 simplification proposal

Status: proposed for owner review. This describes a replacement, not current behavior. The existing [recovery design](i02-recovery-proposal.md) remains in force until a replacement is approved and implemented. This proposal preserves the planned multi-owner role and evidence functionality; disabled status alone is not a reason to remove it.

## Goal and scope

Provide one useful local path: authorize a Gmail connection, explicitly poll it, and inspect completed results. A rare failure may return a clear error and require a user or operator retry or documented manual recovery. Automatic recovery is justified only where a concrete operational need warrants it. This proposal does not authorize live Gmail access or sending Gmail content to an external AI provider. The local raw-message list is not the N01 list of promising roles.

## Proposed local workflow

1. Use a documented local operating mode with one enforced writer for a connection. Check tenant and connection ownership and current source permission before each actual provider request. Keep Google tokens encrypted and out of logs and browser storage.
2. Begin a sync and mark its view incomplete. Read and persist eligible message data. Only after the entire sync succeeds, conditionally publish its checkpoint and make the completed view available. On failure, return a sanitized error and keep the incomplete view unavailable; do not advance the checkpoint.
3. Let the user explicitly retry. If the previous attempt may have left partial changes, perform a full reconciliation from a safe watermark. Duplicate writes must not create duplicate records. Compare a canonical selection fingerprint with the checkpoint; a changed selection triggers a full sync rather than relying on permanent version claims.
4. Store each new Gmail content version under an owned, unique identifier with an integrity reference. If object creation or metadata publication has an uncertain outcome, return an error. Keep potentially referenced or shared content and provide an explicit way to inventory and reconcile identifiable orphans; delete only after ownership and lack of use are established. Retryable/manual cleanup must still meet the approved delete-when-no-longer-needed rule; leaving private content indefinitely is not completion.
5. On disconnect, stop new access, attempt provider revocation and removal of identifiable connection-owned text and credentials. Report incomplete with a retry or manual-remediation path when an outcome or ownership is uncertain. Never report deletion or revocation as complete without evidence. Existing role/evidence holds and content potentially needed by another owner must be preserved until an authorized release; disconnect retains the owner's separately approved deletion requirement.

## Module-level changes to evaluate

| Current area | Proposed treatment | Important condition |
| --- | --- | --- |
| `source-gmail/oauth.ts`, `refresh.ts`, `token-store.ts`, `client.ts` and source policy | Keep the essential consent, PKCE/state, token isolation, policy and bounded-fetch behavior. Simplify error/retry coordination only where the safe outcome remains explicit. | Ambiguous provider responses and a credential issued but not stored may require manual Google-account remediation. No token material in errors or logs. |
| `source-gmail/poll.ts` and `persistence/gmail-attempt.ts` | Replace automatic recovery machinery with a simple incomplete/completed state and explicit full retry where sufficient. Preserve conditional publication and guarded reads. | A failed or interrupted attempt must not advance a checkpoint or be shown as complete. |
| `persistence/gmail-config.ts` | Evaluate replacing permanent version-claim records with a canonical selection fingerprint on the checkpoint. | The full query and label selection must be compared; changed or unverifiable selection requires full reconciliation. Existing records need a migration or fail-closed path. |
| `persistence/gmail-objects.ts` and object-store adapters | Replace generic caller-supplied transaction-action serialization and fingerprints with narrow typed publish, detach and cleanup operations. Prefer explicit retry or operator reconciliation to automatic replay for rare ambiguous outcomes. | Preserve tenant ownership, reference integrity and all registered holds. A failed request is not proof an object is unreferenced. |
| `persistence/gmail-local.ts` and `local-barrier.ts` | Replace the large composition and multiple lock/marker protocols with the smallest local workflow and one clearly enforced operating mode. | A single-process assumption must actually be enforced. Distributed workers and S3 require their own conditional ownership and recovery design; a local lock cannot protect them. |
| `persistence/gmail-holds.ts` and disabled role/evidence paths | Preserve the planned multi-owner capability; review the existing implementation against the eventual role ownership model. | Do not remove functionality merely because it is disabled, or delete text while any authorized owner still needs it. |
| `persistence/gmail-disconnect.ts`, `gmail-revocation.ts` | Use a small retryable disconnect workflow with explicit incomplete reasons; remove elaborate states only if a simpler flow can establish the same facts. | Retain or otherwise safely handle credentials until revocation outcome is resolved; account for all sources, quotations and connection-linked copies before claiming full deletion. |
| Local database and root binding | Evaluate a persistent dedicated DynamoDB Local instance versus an explicitly disposable local environment. Replace the existing multi-root markers only with a reviewed initialization and restart contract. | Never silently attach old token/object roots to an empty or unrelated database. First setup, interrupted setup and metadata loss must fail safely. |

## Failure behavior

| Situation | Proposed behavior |
| --- | --- |
| Gmail request, validation or storage fails | Return a general sanitized error; no completed checkpoint or partial result. User retries. |
| Process stops during sync | Leave the view unavailable. On explicit retry, reconcile before publishing. |
| Object write or metadata result is uncertain | Preserve possibly shared or referenced data; report error. An operator can inspect an inventory and reconcile or clean up only after ownership is established. |
| Provider revocation response is lost or cannot be confirmed | Keep the operation pending and any token encrypted; retry or instruct the user to review Google account access. Do not infer success from a generic error. |
| Database state is missing while old files exist | Stop and require an explicit audited recovery or migration; do not create a fresh binding to old data. |
| More than one role or evidence owner needs text | Retain it until the final authorized use ends. Multi-owner behavior remains planned and must not be represented as implemented until tested. |

## Migration and validation

Do not delete existing objects or assume the local store contains only synthetic data. Inventory the current schema and its references first. Legacy digest-named Gmail and manual-import objects may be shared; Gmail-origin or unknown-origin manual imports lack a connection link. Preserve or explicitly reconcile them before deletion or migration. A disposable synthetic test environment may be reset only when clearly identified and explicitly authorized.

Before replacing each piece, write behavior-focused synthetic tests for: successful poll and authorized list; failed fetch/write with no checkpoint advance or partial view; explicit retry without duplicates; denied source and cross-tenant access; encrypted tokens and sanitized errors; uncertain revocation; preservation of shared or held content; and disconnect that remains incomplete when cleanup is uncertain. Add multi-owner release tests when the role model is implemented. Keep existing tests that cover unique safety behavior until equivalent replacement coverage exists. Local emulator tests do not prove cloud IAM, S3 or production concurrency behavior.

## Decision requested

Approve or adjust this direction before implementation replaces the previously approved intent, marker and barrier design. The refactor should proceed in small reviewable slices, beginning with one synthetic local acceptance flow; remove old mechanisms only when their replacement and migration behavior are tested.
