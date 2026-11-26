# Contributing

The project is establishing its initial development workspace. Discuss scope and acceptance criteria before significant work. Follow [AGENTS.md](AGENTS.md), use synthetic data, make small reviewable changes, and document actual checks and unresolved risks. Material changes to accepted architecture require owner approval. See the [README](README.md) for setup and the [agent workflow](docs/agent-workflow.md) for using or defining specialists.

## TypeScript imports

For relative imports in Node-targeted TypeScript, use the `.js` extension, for example `import { deadlineStatus } from "./objective.js"`. The project uses Node ESM with TypeScript's `NodeNext` module mode: TypeScript resolves that path to the `.ts` source during typechecking, while the path is compatible with emitted JavaScript running in Node. The CLI build strategy is still to be decided; this convention does not by itself provide a build. Use the workspace TypeScript version in VS Code as described in the README if the editor cannot resolve an import.
