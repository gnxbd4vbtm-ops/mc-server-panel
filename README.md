# Byte Server Panel

Byte Server Panel is a local-first web application for creating and managing Minecraft Java Edition server instances on Linux. It runs as an ordinary user process, listens on `127.0.0.1` by default, and does not install Java, Minecraft, system packages, services, or firewall rules automatically.

## Requirements

- Node.js 22.13 or later. The application uses Node's built-in SQLite module (`node:sqlite`); Node may print its experimental-feature warning.
- Java for running a Minecraft server. The panel does not install or change Java.
- Internet access for selected Mojang/provider metadata and user-confirmed software or Modrinth content downloads. The dashboard, database, and process manager run locally.

## Run

From the project directory:

```sh
npm start
```

Open <http://127.0.0.1:18765>. For development with automatic Node.js restarts, run `npm run dev`. Run tests with `npm test`; `npm run check` performs JavaScript syntax checks. `npm run build` runs the production-source checks; the frontend is served as static files and does not require a bundler.

The default port can be changed for a single run:

```sh
BSP_PORT=18888 npm start
```

Optional data locations are configured with `BSP_DATA_DIR`, `BSP_SERVERS_DIR`, `BSP_BACKUPS_DIR`, and `BSP_DATABASE_PATH`. By default, application state, SQLite data, backups, and server files live in `.data/` under the project directory. Backups are gzip-compressed tar archives with per-file SHA-256 manifests and an archive SHA-256; downloads and restores verify integrity. Stop the server before creating or restoring a snapshot. Keep ten backups per server by default; set `BSP_BACKUP_RETENTION` to a value from 1-1000 to change this.

The panel binds only to `127.0.0.1` by default and requires an administrator password. On first run, copy the one-time setup token from the terminal into the panel and choose a password of at least 12 characters. Sessions expire after 12 hours; repeated failed logins are rate-limited.

LAN access is an explicit opt-in and requires HTTPS. Supply a certificate and private key, then set `BSP_HOST` to a host interface address or wildcard such as `0.0.0.0`:

```sh
BSP_HOST=0.0.0.0 BSP_TLS_CERT=/path/to/cert.pem BSP_TLS_KEY=/path/to/key.pem npm start
```

For hostnames not matching an interface address, add comma-separated names with `BSP_ALLOWED_HOSTS`. Do not expose the panel to the public internet. The panel does not install a service, configure a firewall, or enable LAN access unless explicitly configured.

## Available today

- Responsive dark/light dashboard using live data from the local backend.
- Persistent SQLite server definitions and activity history.
- One-time token-protected administrator setup, scrypt password hashes, rate-limited login, expiring HttpOnly/SameSite sessions, and HTTPS-only opt-in LAN binding.
- Server configuration for Vanilla Minecraft version, Java executable, memory, port, and description, with memory and port checks.
- Complete official Mojang version catalogue, including snapshots and legacy version identifiers, is selectable for Vanilla and every listed provider. Provider compatibility is shown before installation; Fabric and Quilt versions absent from their official game catalogues are rejected before downloading an installer. Published checksums are verified before installation; provider installers run without a shell in an isolated staging directory.
- Modrinth search for compatible mods, plugins, and modpacks; mods are enabled for Fabric/Forge/NeoForge/Quilt servers, plugins for Paper/Purpur, and incompatible searches are blocked with an explanation. Content archives are checked against Modrinth SHA-1/SHA-512 metadata and restricted to approved HTTPS vendor hosts.
- Modrinth `.mrpack` imports validate ZIP structure, paths, checksums, size limits, and server-side compatibility before safely writing files into an installed modded server.
- Discovery of existing Java executables on `PATH` and common JVM directories, with Mojang-metadata Java minimum checks before installation and start.
- Separate instance directories, server properties, explicit EULA consent before first start, and Java child-process start/stop, console input, and captured output.
- Each server has a dedicated routed management page with sidebar sections for overview, files, supported mods or plugins, worlds, player/world settings, console, and logs. Console output polls live process logs alongside the command prompt.
- Installed servers can change Minecraft version or server software from their dedicated Server software page. The panel creates a full recovery snapshot first, installs into a staged copy, preserves worlds/configuration/content, and switches to the new runtime only after installation succeeds.
- Fabric and Quilt installations keep the Minecraft server JAR beside their loader launcher and start the correct loader JAR. Older installs with the launcher mistakenly placed over the game JAR are repaired on start using Mojang's verified server artifact; server versions in the create form are selected from the official version catalogue.
- Managed servers use loopback-only RCON with a random per-server password in a mode-0600 private file. On Linux, after a panel restart the panel verifies process identity and attempts authenticated RCON reattachment; reattached servers support commands, graceful stop, and bounded `logs/latest.log` viewing.
- If process identity is unavailable, the server is marked unknown and cannot start, back up, or be deleted until the user confirms they checked that no process remains.
- Stopped-server gzip/tar archives with embedded file manifests, external SHA-256 verification, download/restore, and retention.
- Persisted install/backup/restore/content tasks with progress, cancellation, and restart-interruption recovery.
- Compressed archive downloads/restores, SHA-256 verification, and configurable per-server retention.
- Recurring interval schedules for backup/start/stop/restart, historical process/disk metrics, and diagnostics export.
- Authenticated file management and allowlisted player/whitelist/operator/world/datapack administration. The RCON credential is never returned by the API or file editor.
- Snapshots are retained if their server definition is deleted; they remain visible as backups without a restore target.
- Same-origin API checks, loopback-only host validation, request-size limits, restrictive response headers, parameterized SQL, and filesystem paths managed by the backend.

## Current boundaries

- Provider versions are chosen automatically from stable/latest vendor metadata. Every game version remains selectable, but no provider supports every release or snapshot; incompatible Fabric and Quilt versions are rejected early, while other providers may fail if no compatible artifact exists. The UI does not yet expose arbitrary loader versions, provider build selection, CurseForge, or non-Modrinth content catalogs.
- Forge-family and Fabric/Quilt installer artifacts are checksum-verified before execution. Those vendor installers may download their runtime libraries during installation; the panel does not independently mirror or pin every transitive library.
- Modrinth imports require server-compatible projects and checksummed downloads. Client-only files are skipped; overrides do not replace the panel-managed `server.properties` or EULA. Updates, dependency conflict resolution, and automatic rollback are not provided.
- Process reattachment depends on Linux `/proc`, a valid managed process ID, and enabled local RCON. If RCON is unavailable, the server remains detached and must be stopped or verified manually. Player counts remain unavailable.
- The panel does not collect network/TPS metrics, install Java, change persistent host/network configuration, or run as a system service.
- LAN use requires a valid TLS certificate/key and an explicit bind-address change. Do not expose this privileged panel to the public internet.

## Security and data handling

Vanilla installation uses Mojang's official metadata and distribution hosts. Other server providers and Modrinth use provider-specific allowlists, published artifact hashes, bounded downloads, and explicit user-initiated installation; selected loader installers are launched with argument arrays and no shell. Existing Java executables are probed with a three-second timeout; the panel never installs Java. The selected runtime must meet the major version declared by Mojang before installation or start. RCON binds only to loopback and its random credential is stored with restrictive file permissions. Server paths are generated by the backend under the configured instance root. Console commands are administrative. Deleting an instance removes its server files and requires confirmation in the UI.

Minecraft server installation and execution are initiated by the user. On the first start, the interface asks the user to confirm acceptance of the Minecraft EULA; the panel does not accept it silently.

No system-level configuration or software is changed by the application.
