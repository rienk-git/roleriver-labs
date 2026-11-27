# RoleRiver Labs

RoleRiver Labs is a planned, self-hostable job discovery and evidence-based matching tool. It will start as a single-user CLI and later monitor permitted sources and surface actionable opportunities. It is generic and configurable; no real candidate data belongs in this repository.

**Status:** the first matching CLI accepts local text and can request one structured AI assessment; ingestion, persistence and notifications are not implemented. See the [CLI contract](docs/cli-contract.md).

To set up the development tools, install [mise](https://mise.jdx.dev/getting-started.html) 2026.11.14 or newer, then run:

```sh
mise install
mise run install
mise run check
```

The check runs formatting, linting, typechecking and the test runner. The current tests cover domain validation, objective rules, the mocked assessment provider and CLI. Node.js 26 Linux binaries may require `libatomic`; see the [Node.js release notes](https://nodejs.org/en/blog/release/v26.13.0/). The workspace does not require AWS or Google credentials.

To build the CLI and see its options, run `mise exec -- pnpm build` followed by `mise exec -- pnpm cli --help`. A live assessment requires an explicit opt-in, a separately billed OpenAI API key and model, and the privacy attestations described in the [CLI contract](docs/cli-contract.md). Default tests do not use an API key or network.

For VS Code, the repository points to its pinned TypeScript installation. After installing dependencies, open a TypeScript file, run **TypeScript: Select TypeScript Version** from the Command Palette, and select **Use Workspace Version**. VS Code requires this selection; the workspace setting alone does not force it.

The [product architecture](docs/architecture.md) is an explicit workflow, not a set of autonomous runtime agents. Separately, [AI-assisted development](docs/ai-assisted-development.md) describes human-governed specialist roles. See the [architecture decisions](docs/adr/), [roadmap](docs/roadmap.md), [source policies](docs/source-policies.md), and [development log](docs/development-log.md). Contributors can use the included specialists or define their own by following the [agent workflow](docs/agent-workflow.md). The log records approximate elapsed active session time, counting parallel work once and explicitly marking unknown durations; it is not a productivity claim.

Keep profiles, vacancy content, credentials and tokens private. Only synthetic examples and public-safe material should be committed. See [security](SECURITY.md) and the [threat model](docs/threat-model.md).

The initial persistence foundation uses DynamoDB Local and a filesystem object adapter for development; the CLI does not use persistence yet. See the [persistence design](docs/persistence-design.md) for local integration tests, safety boundaries and deferred work. Planned production persistence uses DynamoDB and private S3. The later static dashboard uses Google sign-in and offers Gmail connection separately; its public demo will use synthetic data without login. No cloud resources or OAuth accounts have been created.
