# Agent workflow and compatibility

Installed CLI observed: `codex-cli 0.162.0-alpha.17.2`. On this installation, a strict-mode app-server `config/read` for the repository returned `agents.max_concurrent_threads_per_session = 3` from an enabled project configuration layer. This confirms configuration loading, not live enforcement. The [official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) describes standalone `.codex/agents/*.toml`, the concurrency setting (excluding the primary), and inheritance of the parent model and reasoning effort when no override is configured. The seven files deliberately omit both overrides. With Terra Light selected in the parent, inheritance is the intended default; actual child model reporting in this client has not been independently verified. Official [model documentation](https://learn.chatgpt.com/docs/models) identifies `gpt-6.1-terra` and states it requires CLI 0.159.0 or newer; do not guess a separate model identifier for Light.

Custom agents inherit parent permissions; read-only instructions are not a separate sandbox. Ask Codex CLI or IDE to use a named specialist with a narrow task and expected output; use `/subagents` in the CLI to inspect threads. The named architect specialist successfully read `AGENTS.md` and `.codex/config.toml` through `functions.exec` and `tools.exec_command` in a chat session and reported file-patching tools; no files were changed. An earlier chat session had no child filesystem tools, so access should be verified if a future session behaves differently. The owner also reported a successful local CLI test with `--no-daemon`. Neither test proves live enforcement of the concurrency limit. Do not claim independent review without actual evidence.

Assign explicit nonoverlapping files and contracts; use isolated worktrees for concurrent writes or serialize. Never concurrently edit shared files or lockfiles. No nested delegation by default. Specialists return scope, files, checks actually run, risks and questions. The orchestrator integrates, runs relevant gates, updates roadmap/log and presents material architecture/security decisions for human approval. Security reviews auth, secrets, external content, fetching, permissions and sensitive data; DevOps reviews relevant delivery changes. Read-only reviews do not establish organizational independence or guarantee correctness.

## Using the roles in a fresh clone

Open the cloned repository as the project root in a Codex client that supports custom subagents, review `AGENTS.md` and the accepted [architecture decisions](adr/), and select a model and reasoning level available to your account. The repository supplies seven development specialists in `.codex/agents/`: `architect`, `typescript-engineer`, `python-engineer`, `frontend-engineer`, `qa-engineer`, `security-engineer` and `devops-engineer`. They are reusable instructions, not separate runtime services or pre-created accounts. The orchestrator assigns only the roles appropriate to the task.

For example, ask: “Use the `qa-engineer` specialist to review the current changes for regressions and missing tests; report file references and checks actually run, without editing.” This is an illustrative prompt, not a claim that a review occurred. Ask for at most three concurrent specialists, give each a scoped task and file ownership, and integrate their reports yourself. Confirm that the client actually exposes the needed tools; if a specialist cannot read files, provide relevant context for limited analysis or use a client with repository access.

## Defining another specialist

For a project-specific role, add a TOML file under `.codex/agents/` with a unique `name`, a short `description` and `developer_instructions`. For a personal role outside this repository, use your Codex user's `agents/` directory. The name is the role identifier; role instructions extend `AGENTS.md`, not replace its safety and review conventions. Define a narrow responsibility, boundaries and expected evidence, and avoid storing personal data, credentials or local paths. For example:

```toml
name = "documentation-reviewer"
description = "Review project documentation for clarity and consistency"
developer_instructions = """
Follow AGENTS.md. Review the assigned documentation without editing.
Report concrete findings and file references; do not expand scope.
"""
```

Omit model and reasoning overrides to inherit the parent session's selection; each contributor controls their own available model and permissions. A role file does not grant filesystem access or create a separate sandbox. Start a fresh session if necessary, ask for the role by name, and verify the actual tools and result before relying on it. The project concurrency limit is three specialists excluding the orchestrator; other environments may require the orchestrator to enforce that policy. See the [official custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) for current client support and schema.

## Persistent context and handoffs

Repository files are the durable shared project context: `AGENTS.md` holds conventions, `docs/adr/` records accepted decisions, and the roadmap and development log track progress and evidence. Each agent has its own task context; the orchestrator passes relevant facts and consolidates findings. Record material decisions and unresolved questions in the repository before ending a milestone. Changes only become available to other clones after they are committed and shared; never put private candidate data or secrets into that shared context.
