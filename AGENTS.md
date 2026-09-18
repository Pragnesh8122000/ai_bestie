# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The repository uses npm workspaces; run `npm test` and `npm run build` from the root for the complete server/client validation.
- Treat `docs/deployment.md` as authoritative for Google Identity Services environment/origin setup and one-off database migrations.
- Conversation switching, stale-stream isolation, and the one authoritative chat-generation quota are behaviorally pinned in `client/src/stores/chatStore*.test.ts` and `server/src/middleware/auth.test.ts`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
