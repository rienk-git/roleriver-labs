# Requirements

Status: accepted requirements baseline; no functionality is implemented.

The initial user is one self-hosting person. Profiles, geography, currency, preferences, sources and channels must be configurable. The CLI reads local CV and vacancy text plus optional preferences and supplementary evidence, requests one logical AI assessment through a narrow adapter, validates evidence and output, applies confirmed objective constraints, and produces explainable human and machine output. A structured candidate profile is not required. Unknown evidence remains unknown. No application or message is sent automatically.

After the CLI, ingest email alerts with Gmail read-only polling and manual import; enrich via authorized APIs, feeds and permitted pages under [source policies](source-policies.md). Preserve provenance, completeness, status and timestamps; deduplicate and version opportunities. Notify only actionable new or materially changed opportunities, with clear gaps, source links and verification requests. A date-only deadline is not an exact timestamp. The later dashboard is described in [frontend architecture](frontend-architecture.md).

Out of scope for the CLI: persistence, Gmail, browser automation, notifications, scheduling, dashboard, Python services, cloud and distributed infrastructure. Never infer an open vacancy, candidate qualification or hard disqualifier from missing evidence. External source text may be multilingual.

Later persistence uses DynamoDB for structured records and S3 for private objects, with local emulation and no AWS account for default development. Dashboard/API identity starts with Google OIDC; a separate optional Gmail connection must not be required for manual import. Personal CLI authorization must not depend on the dashboard. Public demo data is synthetic; hosted multi-user operation is deferred pending provider-policy and security obligations.
