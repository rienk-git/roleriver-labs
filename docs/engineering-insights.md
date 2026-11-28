# Engineering insights from agent-assisted development

RoleRiver Labs is an exploration of multi-agent software engineering as well as a product. These insights are the owner's observations and opinions, informed by work on this repository and discussion with AI. They are starting points for reflection, not a controlled comparison or universal rules; they may change with experience.

## Architecture and planning

Discussing architecture with AI early has helped clarify product constraints, trust boundaries and the intended outcome. AI can explore alternatives, but its suggestions still need critical review. In this project, modular boundaries and ports at real I/O boundaries fit the goals; other projects may benefit from a simpler structure.

An early roadmap makes dependencies and priorities visible. Changing it when new information emerges is a strength: the roadmap should help decisions rather than lock the team into its first assumptions. Keeping estimates separate from observed or owner-estimated time makes those changes easier to understand.

## Agents, cost and feedback

Specialist agents have provided useful perspectives when given distinct responsibilities. Their feedback loops can expose issues that might otherwise be missed, but can also lead to additional iterations as architecture, security and QA findings interact. These perspectives are not necessarily independent: agents may share assumptions or make correlated mistakes. Security review remains mandatory at the sensitive boundaries specified by the repository.

Multi-agent work appears to use more tokens, partly because context is shared across agents, although this repository has not made a controlled single-agent comparison. Parallel work may reduce elapsed time while increasing compute and coordination. Development also involves waiting, reading agent reasoning and steering the work; those activities are part of the human effort. Actual agent usage and checks should be reported, and overlapping elapsed work counted once.

The I02 retention and recovery work demonstrates how a feedback loop can expand. Legitimate concerns about token isolation, shared content and incomplete synchronization led to additional coordination and rare-failure handling. The resulting merged slice added about 8,700 lines including tests, yet remained inactive and did not provide a user-facing Gmail CLI. That is evidence to reassess scope and sequencing, not evidence that every safeguard is unnecessary. See the [recovery review](retention-recovery-review.md) and [simplification proposal](i02-simplification-proposal.md).

## Proportionate quality

Review depth and model capability should match the task. Some applications or changes may not need an architect and a separate conciseness review: focused checks can be enough, saving time and tokens while still meeting the need. Authentication, permissions, sensitive data and destructive operations warrant stronger review. A lightweight model may be sufficient for some work, but model size alone does not establish which important issues it will catch.

A general error and a user or operator retry can be appropriate for rare failures in production as well as local development. That is only safe when failure does not expose secrets, silently lose needed data, advance an incomplete checkpoint or report uncertain deletion as successful. A catch-all handler can sanitize an error; it cannot make an incorrect state safe or prove cleanup occurred. Document manual remediation when the outcome remains uncertain.

## Review and ownership

There is a risk of approving AI-generated PRs too easily, much as a reviewer may become less critical of a trusted colleague's PRs. AI also brings its own pressures: it can produce large changes and plausible explanations quickly, and reviewers can lose track of the details. The final diff, behavior and test evidence still deserve review, regardless of who or what produced them.

Repository files are the durable shared context. Agents can miss earlier decisions after context changes, rely on stale instructions or misinterpret a handoff. Record decisions, contracts and unresolved work in reviewed artifacts, and give each task the relevant current context. Do not put credentials, private messages or candidate data into that shared context.

## Reuse with judgment

A discoverable module index, clear contracts and cohesive modules might reduce repeated discovery and duplicate work across a monorepo or organization. An enterprise-architecture agent could help find existing libraries and question whether code should be shared. These are ideas to explore rather than requirements for this repository: shared libraries and catalogs also need ownership and maintenance, and premature extraction can couple unrelated features.

## What to measure next

One engineer working with agents can produce substantial output quickly, and may avoid some team coordination overhead. How that compares with other ways of working remains an open question. Useful measures for future work include active human time, wall time, observable agent and tool usage, review iterations, defects found and maintenance cost. Record model and client configuration when known.
