# SessionBar Mobile Web Access Deferred Issue

Date: 2026-06-24

## Status

Deferred. This is not part of the current implementation track.

## Context

SessionBar has a web dashboard as a side effect of needing lightweight live monitoring. The immediate product focus remains the local TUI and the hook-driven session state model.

Mobile access matters because the user may want to check task status from an iPhone, including while the phone is used as a passive status screen. The long-term direction may be a dedicated remote iPhone app, but the near-term idea is simply opening the current web dashboard from the phone.

## Current Behavior

The server currently defaults to local-only access:

- HTTP server: `127.0.0.1:8989`
- Web dashboard can be enabled by environment flag.
- Same-origin web usage works locally.
- Phone access requires changing the network exposure model.

## Deferred Problem

Define a safe access path for viewing SessionBar from a phone without confusing this with the main SessionBar data model work.

The decision is not only a UI question. It affects:

- host binding
- public or private entrypoint
- authentication boundary
- whether SessionBar should expose anything directly
- how much deployment responsibility belongs inside SessionBar

## Future Paths

### Public Domain Path

Use a domain such as `status.example.com` as the entrypoint.

Expected shape:

```text
iPhone browser -> domain -> tunnel or reverse proxy -> local SessionBar web server
```

This path is appropriate when access should work outside the home or office network. It should not expose the local SessionBar process directly to the public internet. The domain should terminate TLS and enforce access control outside or in front of SessionBar.

Likely implementations:

- Cloudflare Tunnel plus Access / Zero Trust.
- VPS with Caddy or Nginx plus a private tunnel back to the local machine.
- Another authenticated reverse proxy.

### Private VPS Path

Use a VPS as a private reachable node, then connect privately from the phone.

Expected shape:

```text
iPhone -> private VPS endpoint/VPN -> local or relayed SessionBar endpoint
```

This path is appropriate if the dashboard should not be public-facing and the user is comfortable connecting through a private network layer. The VPS becomes infrastructure, not part of SessionBar itself.

Likely implementations:

- Tailscale / WireGuard style private network.
- VPS-hosted reverse tunnel with private access controls.
- Later native iPhone app using the same private transport.

## Product Boundary

SessionBar should not become a deployment platform. Its responsibilities should stay narrow:

- serve local web dashboard
- expose a clear API/SSE surface
- optionally support an explicit LAN mode
- document safe deployment shapes

Public TLS, identity, auth policy, DNS, and tunnel orchestration should remain outside SessionBar unless a later spec explicitly expands scope.

## Non-Goals

- No implementation in the current work.
- No immediate VPS rental or public deployment setup.
- No direct public exposure of `127.0.0.1:8989`.
- No iPhone native app work in this issue.
- No changes to hook contracts or session state model.

## Open Decisions

- Whether the first supported mobile path should be LAN-only, public-domain tunnel, or private VPS/VPN.
- Whether SessionBar should add a dedicated `web --lan` command before any remote/domain work.
- Whether future remote access requires token auth inside SessionBar, or relies entirely on an upstream access layer.
