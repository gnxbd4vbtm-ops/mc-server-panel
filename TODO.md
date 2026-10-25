# Implementation checklist

- [x] Localhost-first responsive dashboard, persistent SQLite state, and server lifecycle management
- [x] Vanilla installation from verified Mojang metadata
- [x] Java runtime discovery and compatibility checks without installing Java
- [x] Fabric, Forge, NeoForge, Quilt, Paper, and Purpur installation from official catalogs
- [x] Modrinth discovery and checksum-verified mod, plugin, and `.mrpack` installation
- [x] Authentication, persistent sessions, request protections, and explicit HTTPS-only LAN opt-in
- [x] Persisted background tasks with progress, cancellation, and interrupted-task recovery
- [x] Symlink-resistant server file management and allowlisted player, whitelist, operator, world, and datapack commands
- [x] Private loopback RCON configuration, verified Linux process reattachment, remote commands, graceful stop, and bounded server logs
- [x] Compressed backup archives with integrity verification, downloads, restore, and retention
- [x] Recurring schedules, historical CPU/memory/disk metrics, and diagnostics export
- [x] Automated tests, syntax/build checks, and operational/security documentation

## Explicit limits

- Process reattachment depends on Linux `/proc` and a successful local RCON authentication. If either check fails, the server remains detached and must be stopped or verified manually.
- Provider installers may fetch their required runtime libraries while running in an isolated staging directory; their primary installer artifacts are checksum-verified before execution.
- Modrinth pack import skips client-only files and does not replace panel-managed EULA or `server.properties` files. CurseForge, network/TPS metrics, and automatic software/content updates remain out of scope.
