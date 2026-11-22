# LAN sync for DeepSeek Harness (flat mesh)

Every DeepSeek Harness install on the same network is an **equal peer** in a
flat mesh: each device pulls the files it is missing, pushes the sessions a
peer is missing, and merges append-only session logs byte-for-byte. A session
can travel directly between any two devices, in either direction, and through
a third device as a relay when two devices cannot reach each other directly.
Nothing is coordinated by a server.

The sync scope follows the reference design (`YarXVI/dsh-plugin-dsh-sync`):

| Set | What | Merge rule |
| --- | --- | --- |
| `sessions` | `sessions/**/session.v*.jsonl.zstd` | **append-only**: remote log is a strict prefix of local → append the zstd frames; local prefix of remote → no-op; diverged → local kept, peer copy parked under `<session>/conflicts/` |
| `workspace` | `storages/workspace.json` | structured union: workspaces by id, session lists unioned, newer `updatedAt` wins; pinned/archived flags stay local |
| `storages` | other `storages/*` (`schedule.json`, …) | conflict-safe last-writer-wins |
| `profile` | profile `package.json`, `cordis.patch.yml`, `cordis.yml`, `pnpm-workspace.yaml`, `plugins/` | deps added only when the local bundle/link exists; only model blocks of `cordis.patch.yml` merged; plugin sources mirrored without native binaries |
| `modules` | profile `node_modules` real packages | conflict-safe last-writer-wins, no deletions, bounded size |
| `credentials` | `.credentials.yaml` | only `*API_KEY` refs merged; existing local values win; records untouched |
| `attachments` | `attachments/` | conflict-safe last-writer-wins |
| `cache` | `cache/` | off by default |

Only sessions are pushed proactively; other sets converge by both sides
pulling. Live sessions (`ctx.sessions.get(id)` non-null) are never touched:
writing into a log a DSH writer owns would desync its in-process handle.

## Behaviour

- Discovers peers with UDP broadcast on port **47829** (hello every 10 s) and
  accepts manual peers; serves plain HTTP on TCP **47830** (next free port if
  taken).
- Every cycle asks each peer for a manifest (`POST /v1/manifest`), compares
  size/mtime/SHA-256 plus the last agreed base, then pulls changed files
  (`GET /v1/file`) or pushes missing sessions (`POST /v1/file`).
- Both sides run the same pure rules, so they converge without a coordinator.
- Conflicts never overwrite: the peer copy is parked next to the local file
  (`*.conflict-<device>-<stamp>`) or under `conflicts/` for session logs.
- Session copies made by older snapshot-based builds (same creation time, same
  cwd, different id) are recognised and never appended to, because their
  delivery markers name the source id.
- At most 3 sessions are pushed per peer per run, newest first, each below
  96 MiB compressed; other files are capped at 160 MiB.
- Deletions of ordinary files propagate through tombstones (45 days) only for
  sets that allow it; sessions, workspace and modules never delete.
- Imported sessions are attached to a workspace so they appear in the sidebar.

## Requirements

- DeepSeek Harness 0.2.1-rc.2 or newer (built against 0.2.2-rc.5).
- Node.js 22+ (the bundled runtime is fine).
- Peers reachable on TCP 47830 and UDP 47829 (or configure manual peers).

## Settings (Settings → LAN sync)

- Device name, paused, automatic sync interval.
- “Send my sessions too” (push) and a per-set scope grid.
- Manual peers (`address:47830`), useful for Thunderbolt/USB link-local cables.
- Optional shared key: stored as the DSH credential `lan-session-sync/key`, never
  in the settings file. Without it, any LAN host can list and copy files, and
  traffic is unencrypted HTTP, so use it on trusted networks only.

## Safety notes

- Session appends write raw zstd frames from a peer whose SHA-256 was verified;
  byte-prefix identity is checked before appending, and diverged logs are never
  appended.
- `workspace.json` and profile files are merged on disk. While DSH is running,
  the live registry may rewrite some of these files; the next cycle re-merges.
  Workspace session lists are also updated through the registry when sessions
  are attached.
- Plugin-owned state lives in `<DSH_HOME>/lan-session-sync/` and is never synced.

## Files

- `index.js` host plugin; `client.js` settings panel (web client).
- `lib/` mesh engine, sets/paths, merge rules, file transfer, transport server,
  discovery, session log merge helpers, credentials/model-config/bundle merge.
- `test/` unit + HTTP end-to-end tests (`node --test test/*.test.js`).
- `scripts/fake-peer.mjs` standalone peer for local experiments.

MIT. Design inspired by `YarXVI/dsh-plugin-dsh-sync`; see
`THIRD_PARTY_NOTICES.md`.
