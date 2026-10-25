# Implementation checklist

Unchecked items are not advertised as supported.

## Implemented and covered by tests

- [x] Loopback-only Node.js panel, SQLite persistence, first-run password setup, CSRF/same-origin controls, and login throttling.
- [x] In-app password change with current-password verification and invalidation of other active sessions.
- [x] Multiple independent Vanilla/Paper/Purpur/Fabric/Quilt/Forge/NeoForge instances, unique identifiers/ports, explicit EULA acceptance, Java compatibility checks, and available upstream checksum validation.
- [x] Native official Bedrock Dedicated Server installation and supervised execution on Linux x86_64, with Bedrock UDP port handling and no Java runtime dependency.
- [x] Optional Paper/Purpur Java-Bedrock cross-play setup using official Geyser/Floodgate artifacts, SHA-256 verification, separate Bedrock UDP configuration, and Java TCP port preservation.
- [x] Child-process startup, console stdin, log streaming, graceful/forced shutdown, crash detection/history, `/proc` CPU/RSS, and bounded automatic crash restarts.
- [x] Durable server-install jobs with queued/running/completed/failed/interrupted/cancelled states, byte-based progress, errors, cancellation, and explicit retry.
- [x] Cancellation, byte-based download progress, retry, and durable outcomes for server installation jobs.
- [x] Persistent per-server process supervisors keep Minecraft stdin/log handling alive across unexpected panel exits; reattachment validates process identity, reconnects the console, replays recent log output, and can still stop only the matching process.
- [x] Server-root file browse/edit/create/move/upload/download/delete-to-trash with traversal/symlink checks and backend size limits.
- [x] Paper plugin discovery from Modrinth; compatible-version filtering, recursive required-dependency resolution, trusted-CDN checksum verification, atomic install/update, one-step verified rollback, persistent install metadata, listing, and removal.
- [x] Specific compatible Modrinth project version selection in the UI.
- [x] Live player-list query, kick/ban/unban, whitelist, and operator commands; stopped-server permission JSON inspection, with authenticated HTTP integration coverage using a fake server process.
- [x] World-folder inventory and disk-size reporting.
- [x] Stopped-server archive creation, staged restore, backup download, configurable scheduled backups, and retention.
- [x] Persistent crash and periodic CPU/RAM/disk/player history data, dashboard history graphs, and settings for bounded automatic restart.
- [x] On-demand Paper/Purpur TPS/MSPT queries use actual server console responses, validate values, and persist historical samples.
- [x] Optional direct remote management over TLS 1.2+ with explicit Host allowlisting, secure session cookies, and fail-closed config validation.
- [x] Server creation includes validated online-mode, view-distance, and simulation-distance settings; server.properties changes are schema/range checked.
- [x] Responsive dashboard, search/sort, live status updates, dark/light themes, console, file manager, Paper plugin manager, player controls, worlds, and backup schedule UI.
- [x] Fake-process, provider-mock, HTTP security, file-boundary, backup, download-checksum, and installation-job tests.
- [x] Session behavior is documented: sessions expire after inactivity, remain in memory, and reset when the panel restarts.

## Remaining work

- [x] Reattach console/stdin/log streams to surviving supervised processes after an unexpected panel restart.
- [x] Fabric stable-release compatibility metadata, official installer CLI flow, SHA-512 verification of the installer, staged output validation, wizard selection, and Modrinth mod discovery.
- [x] Forge and NeoForge stable-version compatibility metadata, checksum-verified official installer flows, validated Java argument-file launch, and creation UI options.
- [x] Quilt stable-Minecraft compatibility metadata, official SHA-512-verified installer flow, staged output validation, wizard option, and Modrinth mod UI.
- [x] Mojang-listed Vanilla snapshots and pre-releases are labeled in the wizard and install only from verified official version metadata.
- [x] CurseForge mod and modpack discovery using the backend-only optional API key; compatible metadata checks, SHA-1-verified trusted-CDN downloads, manifest loader/version validation, bounded ZIP extraction, safe override allowlist, no-overwrite staging, and rollback on failure. CurseForge updates, dependency resolution, plugins, and inaccessible/licensed files remain unsupported.
- [x] Bedrock release discovery from the official Minecraft page, bounded safe Linux archive extraction, generated server properties, executable validation, native process recovery identity, and explicit no-Java UI flow. The official archive has no publisher checksum available through the current metadata path.
- [x] Bedrock-aware dashboard, server detail, connection addresses, native runtime display, Java-only Players tab hiding, Java/Bedrock creation filtering, and Paper/Purpur cross-play port selection.
- [x] Browser file editor applies lightweight syntax coloring to JSON, YAML, TOML, and properties text.
- [x] Loader configuration browsing and text editing for Fabric, Quilt, Forge, and NeoForge through the server-root-bounded file manager (generic editor; no mod-specific schema forms).
- [x] Player UUID resolution through Mojang in online mode and Minecraft-compatible offline UUID derivation; stopped-server whitelist/operator/banned-player JSON editing with strict validation and clear offline identity caveats.
- [x] World-specific stopped-server backups, download/export, validated tar.gz imports, and staged restore with the existing world preserved until replacement succeeds.
- [x] Live world snapshots flush and pause world saving, archive persisted world state, request saving be re-enabled in a finally path, and fail explicitly if re-enabling cannot be confirmed; full-server backups still require a stopped server.
