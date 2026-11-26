# RoleRiver Labs

RoleRiver Labs is a planned, self-hostable job discovery and evidence-based matching tool. It will start as a single-user CLI and later monitor permitted sources and surface actionable opportunities. It is generic and configurable; no real candidate data belongs in this repository.

**Status:** documentation bootstrap for review. There is no runnable application, integration or installation command yet. After approval, the first implementation milestone will establish a minimal pnpm workspace and a CLI that assesses local CV and vacancy text with one structured AI request and deterministic operational checks; see the [CLI contract](docs/cli-contract.md).

The [product architecture](docs/architecture.md) is an explicit workflow, not a set of autonomous runtime agents. Separately, [AI-assisted development](docs/ai-assisted-development.md) describes human-governed specialist roles. See the [roadmap](docs/roadmap.md), [source policies](docs/source-policies.md), and [development log](docs/development-log.md). The log records approximate elapsed active session time, counting parallel work once and explicitly marking unknown durations; it is not a productivity claim.

Keep profiles, vacancy content, credentials and tokens private. Only synthetic examples and public-safe material should be committed. See [security](SECURITY.md) and the [threat model](docs/threat-model.md).

Planned persistence after the CLI uses DynamoDB and private S3, with local infrastructure for development. The later static dashboard uses Google sign-in and offers Gmail connection separately; its public demo will use synthetic data without login. No cloud resources or OAuth accounts have been created.
