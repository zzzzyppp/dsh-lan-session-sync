# LAN session sync for DeepSeek Harness

Two DeepSeek Harness installs on the same LAN keep their own sessions and copy
across only what the other machine is missing. Sync is **pull-only**: a device
lists the sessions offered by its peers and imports the ones it does not
already have. This device only pulls; it never pushes, replaces, or overwrites.

## What it does

- Discovers peers automatically with UDP broadcast (and accepts manual peers).
- Exchanges a small session catalog over plain HTTP on the LAN.
- Imports a missing session through the official persistence service, as a new
  local session with a deterministic id derived from its content.
- Skips a session when its origin (`device id/session id`) or its content digest
  is already known, so peers cannot bounce the same session back and forth.
- Attaches imported sessions to a workspace so they appear in the sidebar.
- Never exports seeded sessions, subagent sessions, or sessions still owned by
  a live writer.

## Requirements

- DeepSeek Harness 0.2.1-rc.2 or newer (built against 0.2.2-rc.5).
- Node.js 22+ (the bundled runtime is fine).
- Both devices on the same LAN and able to reach each other's TCP port **47830**
  and UDP port **47829**. If a port is taken, the next free port is used.

## Settings

Add the plugin in **Settings → Plugins**, then open **Settings → LAN session
sync**. There you can:

- rename this device and pause automatic sync;
- choose the automatic check interval (default 30 s);
- run an immediate sync, add a manual peer by address and port;
- protect the LAN endpoint with a shared key (stored as a DSH credential).

Agent tools `lan_sync_status` and `lan_sync_now` expose the same operations.

## Security model

- The HTTP endpoint binds `0.0.0.0` but refuses non-LAN source addresses; public
  addresses never get a response.
- Every request except `/v1/health` must carry the plugin's protocol header.
- This device only pulls; it never pushes or overwrites. A peer that holds the
  shared key (or any LAN host when no key is set) can offer sessions to this
  device through `POST /v1/sessions`, which imports them as new sessions.
- Optionally require a shared key. The key is held in the DSH credential store
  (`lan-session-sync/key`), not in `state.json`.
- LAN traffic is plain HTTP and **not encrypted**; session content and the shared
  key cross the network in clear text. Use this only on a network you trust, and
  set a key to stop other LAN hosts from listing or importing your sessions.
- Session content is only ever sent to peers you can reach on the LAN; there is
  no cloud relay.

## Behavior and limits

- Sessions are copied as **snapshots**. A session that grows on the source after
  it was imported is not updated later.
- Only finished, non-seeded, top-level sessions with a recorded `cwd` are
  offered. Subagent sessions are excluded.
- An imported session keeps the source `cwd` when that directory exists on this
  machine under a safe prefix (home, `/Applications`, `/Volumes`, `/tmp`);
  otherwise it lands in `<DSH_HOME>/lan-session-sync/synced`.
- Plugin state lives in `<DSH_HOME>/lan-session-sync/state.json`. A corrupt file
  is renamed to `state.json.corrupt-<timestamp>` and sync starts paused.
- The settings panel ships English and Chinese copy; other DSH UI languages see
  the English fallback.

## Troubleshooting

- No peers: make sure both devices run DSH with this plugin, are on the same
  subnet, and the firewall allows UDP 47829 and TCP 47830. Add the peer manually
  if broadcasts are blocked.
- A sync reports `not-private`: the peer resolved to a public address; use a
  LAN address or a manual peer entry.
- Check **Settings → LAN session sync → Recent imports** for the last imported
  sessions and the last error summary.
