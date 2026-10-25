# Byte Server Panel — Minecraft Server Control Panel

A self-hosted, local-first Minecraft Java and Bedrock server panel for Linux. It is a dependency-light Node.js application with a native HTTP backend, SQLite persistence, and a responsive browser UI. It does not require Docker, a browser-hosted control service, root privileges, or a Windows compatibility layer.

> **Release scope:** The panel creates, installs, runs, and monitors **native Bedrock Dedicated Server**, **Vanilla, Paper/Purpur, Fabric, Quilt, Forge, and NeoForge**. Paper/Purpur can optionally install Geyser + Floodgate for Bedrock cross-play. Paper/Purpur provide Modrinth plugin discovery/install; mod loaders provide Modrinth and optional CurseForge mods and CurseForge modpack import. See [Known limitations](#known-limitations) and [TODO.md](./TODO.md).

## Requirements

- Linux x86_64 (developed for CachyOS / Arch Linux)
- Node.js **22.5 or newer** (Node 24 recommended; `node:sqlite` is used)
- A compatible Java runtime for the selected Minecraft release
- GNU `tar` for backup creation and restoration
- A browser on the same computer

The panel itself has no npm runtime dependencies. Minecraft server software is downloaded from upstream Mojang, Paper/Purpur, and loader sources when the user requests installation.

## Quick start (fish)

```fish
cd /path/to/mc-server-panel
npm test
npm start
```

Open <http://127.0.0.1:8765>. On first launch, create a panel password of at least 12 characters. The password is stored as a salted scrypt hash. The panel does not start a Minecraft server or accept its EULA automatically.

Optional paths/port can be set before launch:

```fish
set -gx MC_PANEL_DATA_DIR "$HOME/.local/share/mc-server-panel"
set -gx MC_PANEL_SERVER_ROOT "$HOME/Games/minecraft-servers"
set -gx MC_PANEL_BACKUP_ROOT "$HOME/Games/minecraft-backups"
set -gx MC_PANEL_PORT 8765
# Optional: configure your CurseForge API key in the private service environment.
# set -gx MC_PANEL_CURSEFORGE_API_KEY "your-private-api-key"
npm start
```

By default the management service binds only to `127.0.0.1`. Optional direct remote HTTPS is available only when configured with a certificate, private key, and explicit Host allowlist; the Minecraft server bind address and port remain independent.

For a remote LAN-only panel, configure the service environment with a private-key/certificate pair and exact hostnames clients will use:

```fish
set -gx MC_PANEL_HOST "0.0.0.0"
set -gx MC_PANEL_PORT 8765
set -gx MC_PANEL_TLS_KEY "$HOME/.config/mc-server-panel/tls/panel.key"
set -gx MC_PANEL_TLS_CERT "$HOME/.config/mc-server-panel/tls/panel.crt"
set -gx MC_PANEL_ALLOWED_HOSTS "panel.example.lan"
npm start
```

Use a trusted certificate, restrict network access with your firewall, and never forward this management port to the public internet without an intentional security review. Remote binding fails closed unless TLS and `MC_PANEL_ALLOWED_HOSTS` are both configured; HTTPS sessions use `Secure` cookies and reject plaintext HTTP. This service does not trust reverse-proxy headers or configure proxies.

## Linux user service (systemd)

The example user unit is [contrib/systemd/mc-server-panel.service](./contrib/systemd/mc-server-panel.service). It expects the project at `~/.local/opt/mc-server-panel`; adjust the `WorkingDirectory` and `ExecStart` if you choose another location.

```fish
mkdir -p ~/.local/opt ~/.config/systemd/user
cp -a /path/to/mc-server-panel ~/.local/opt/mc-server-panel
cp ~/.local/opt/mc-server-panel/contrib/systemd/mc-server-panel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mc-server-panel.service
systemctl --user status mc-server-panel.service
journalctl --user -u mc-server-panel.service -f
```

Stopping the service requests a graceful stop from every running Minecraft process before the panel exits. The unit runs as the normal user and does not use `sudo`. If you need user services before login, configure systemd lingering separately; this panel does not change that setting.

## Development, production, and tests

- Development: `npm start` (source is served directly; there is no transpile/bundle step).
- Tests: `npm test` (Node's built-in test runner, fake Java executable/process, disposable directories; no Minecraft downloads. Includes authenticated HTTP coverage and mocked Modrinth/CurseForge installs, dependency handling, and safe modpack ZIP extraction).
- Production: run `npm start` under the included systemd **user** service. Application logs go to the journal; Minecraft console output is stored per instance.

The runtime is intentionally small and has no third-party frontend dependencies. The UI uses system fonts and supports dark/light themes.

## Architecture and data

```text
Browser (same-origin UI)
  └─ HTTP JSON API + authenticated Server-Sent Events
       ├─ SQLite state and password hash
       ├─ Server lifecycle manager, durable installation jobs, metrics, and crash history
       ├─ Mojang Java version metadata + official Vanilla downloads
       ├─ Official Bedrock Dedicated Server release page + native Linux archive installer
       ├─ Paper and Purpur version/build APIs + checksum-verified downloads
       ├─ GeyserMC download API + SHA-256-verified Geyser/Floodgate Paper plugins
       ├─ Fabric/Quilt/Forge/NeoForge metadata + checksum-verified official installers
       ├─ Modrinth plugin/mod metadata, dependency resolution, and checksummed file downloads
       ├─ Optional CurseForge API catalog, SHA-1 verified mod downloads, and safe modpack import
       └─ Mojang player profiles and offline-mode-derived UUIDs
```

- Backend modules: `src/http.js`, `src/security.js`, `src/database.js`, `src/manager.js`, `src/minecraft.js`, `src/providers.js`.
- Frontend: `public/` (no build tooling or third-party runtime fetches).
- SQLite database: `$XDG_DATA_HOME/mc-server-panel/panel.sqlite` or `~/.local/share/mc-server-panel/panel.sqlite`.
- Default server directories: `~/.local/share/mc-server-panel/servers/<server-id>/`.
- Default backups: `~/.local/share/mc-server-panel/backups/<server-id>/`.
- Each server has its own directory, configuration, world, port, log, and supervised process. A small detached Node.js supervisor owns stdin/stdout and a permission-restricted Unix socket; it launches Java or the native Bedrock binary with an argument array and `shell: false`.
- Bedrock Dedicated Server is a distinct `bedrock` loader backed by the official Linux x86_64 executable; it does not require Java. The same supervisor launches either the native executable or Java without a shell, and Bedrock uses UDP ports independently from Java TCP ports.
- SQLite preserves server definitions, install-job state, crash/metrics history, and project-install metadata. On a normal panel/service shutdown, managed Minecraft processes are asked to stop cleanly. After an unclean panel exit, the panel validates the Java PID, start time, boot ID, user, working directory, and jar, then reconnects to the supervisor socket to resume console input and live logs. Recent console output is replayed on reattachment.

## Supported Minecraft versions and software

The wizard loads Mojang-listed stable releases, snapshots, and pre-releases at runtime; it does not hard-code a version ceiling. Preview versions are clearly labeled and can be installed on Vanilla only. It checks each server software's compatibility metadata before enabling options, and installers verify compatibility again at install time.

| Software | Current support |
| --- | --- |
| Bedrock Dedicated Server | Current Linux x86_64 release linked from the official Minecraft download page; native executable, UDP networking, no Java requirement, and safe in-place updates that preserve server properties and permissions |
| Vanilla | Mojang-listed stable releases, snapshots, and pre-releases; jar checksum verified against Mojang SHA-1 metadata |
| Paper | Versions listed by Paper's current Downloads Service API (v3); selected stable build downloaded and verified with SHA-256 |
| Purpur | Versions listed by Purpur API; latest build downloaded and checked against its API-provided MD5 metadata (weaker than SHA-256/SHA-1; MD5 is not collision-resistant) |
| Fabric | Stable versions from Fabric metadata; official Fabric installer JAR is verified against its Maven SHA-512 sidecar, then run with explicit server-install arguments in a staging directory |
| Quilt | Stable Minecraft versions from Quilt metadata; official installer version and SHA-512 are validated from Quilt's metadata, and the server installer runs in a staging directory |
| Forge | Current Mojang versions with Forge `recommended`/`latest` promotion metadata; official installer JAR SHA-1 sidecar is checked before the headless `--installServer` process |
| NeoForge | Current Mojang versions mapped to stable versions from NeoForge's Maven metadata; installer JAR SHA-512 sidecar is checked before the headless `--installServer` process |
| Snapshots / prereleases | Vanilla only; Paper, Purpur, Fabric, Quilt, Forge, and NeoForge remain stable-release-only |

For Java/Bedrock cross-play, choose Paper or Purpur and enable **Bedrock cross-play** in the creation wizard. The installer downloads the latest Geyser and Floodgate Paper artifacts from GeyserMC's official API, verifies their published SHA-256 checksums, and configures Geyser's Bedrock UDP port separately from the Java TCP port. This currently supports Paper/Purpur only; it does not turn a native Bedrock server into a Java-compatible server.

The official Bedrock server page does not publish a checksum for the Linux archive through the metadata used by the panel. The download is restricted to the official HTTPS host, the ZIP structure and CRCs are validated, and required files are checked before installation; unlike Java/bridge artifacts, the archive cannot currently be checked against a publisher-provided cryptographic checksum. In-place Bedrock updates retain the server's `server.properties`, `permissions.json`, and `allowlist.json`, and roll back replaced files if an update fails.

Fabric, Quilt, Forge, and NeoForge installation run their official installers as Java child processes (without a shell) in temporary staging directories. Installer JARs are checked against official SHA-512 metadata or their publisher's SHA-1 sidecar; generated launch artifacts are validated and copied into the server root only after the installer exits successfully. Forge/NeoForge use validated Java argument files rather than executing generated shell scripts. The Configuration tab opens the loader's `config/` directory in the bounded text editor; it does not provide mod-specific schema forms.

Minecraft's Mojang version metadata is used to determine the Java major version when available. Installed Java executables on `PATH` are detected, and a custom Java executable path can be selected. The panel never changes the system Java alternative or installs a Java package. A runtime is verified before server start.

Vanilla has no plugin or mod support. Paper and Purpur's Plugins tab searches Modrinth for compatible plugins; Fabric, Quilt, Forge, and NeoForge's Mods tabs search Modrinth and, when configured, CurseForge. Modrinth installs verify SHA-512/SHA-1 metadata, resolve required dependencies, and record managed projects with update and rollback support. CurseForge requires `MC_PANEL_CURSEFORGE_API_KEY`, sent only to `api.curseforge.com`; mod downloads must come from an HTTPS `*.forgecdn.net` host and pass SHA-1 verification. CurseForge jars are listed as unmanaged files and can be removed; provider-specific update, rollback, dependency resolution, and plugins are not supported.

The Modpacks tab searches CurseForge for the selected Minecraft version. Installation requires a stopped server, an empty `mods/` directory, a matching loader/version in the pack manifest, and API access to every required file. The pack and each mod file are SHA-1 verified. Pack archives are limited to 128 MiB compressed / 256 MiB expanded, and required mod downloads are limited to 1 GiB total. Extraction rejects encrypted/unsupported/ZIP64 archives, symbolic links, path traversal, duplicate paths, invalid checksums, and oversized entries. No existing files are overwritten; a failed installation rolls back any files already placed. Overrides are installed only under `mods/`, `config/`, `defaultconfigs/`, `kubejs/`, `scripts/`, `resourcepacks/`, and `datapacks/`; other client-only or unsupported override entries are skipped and reported. Modpack updates/removal are not managed by the panel. CurseForge licensing/API restrictions can prevent specific files from being installed, in which case the operation fails explicitly.

## Using the panel

1. **Create a server:** choose a unique lowercase identifier, compatible Minecraft version, server software, port, bind address, player limit, online-mode setting, view/simulation distance, and Java executable for Java servers. Native Bedrock uses the official current Linux x86_64 release and its UDP port; it does not need a Java runtime. Paper/Purpur can enable automatic Geyser/Floodgate installation using a separate Bedrock UDP port.
2. **Install:** open the server's Settings and choose *Install server software*. Downloads are explicit and verified against publisher checksums where available. Bedrock archives have no published checksum and are validated using HTTPS, ZIP integrity checks, and required-file checks instead. Interrupted downloads do not create an installed marker; retry installation to recover.
3. **Accept EULA:** open Settings, read the linked official Minecraft EULA, check the acknowledgement, and accept. The panel writes `eula=true` only after this explicit action.
4. **Start:** use *Start server*. The panel validates Java for Java servers, verifies the Bedrock executable for native Bedrock, and checks the configured TCP/UDP bind ports before starting a detached supervisor. Commands are launched with argument arrays (no shell command construction).
5. **Operate:** use the live console to send actual server stdin commands; query live players and send kick/ban/whitelist/operator commands; browse, create, move, upload, download, edit, and trash files; inspect world-folder sizes; and create/download/restore backups. JSON, YAML, TOML, and properties files receive lightweight editor syntax coloring. Scheduled backups run only while the server is stopped and apply the configured retention count.

Server process logs are streamed live and appended to `logs/panel-console.log`; Minecraft's own `logs/latest.log` remains untouched. The online player list uses the actual `list` command response; counts may remain unknown until a query or log event is observed. While stopped, the Players tab can edit the whitelist, operator, and banned-player JSON files using validated records. Name-to-UUID resolution uses Mojang's profile API in online mode; offline mode derives the UUID Minecraft uses from the typed name, but that is not proof of identity. CPU/RSS are read from Linux `/proc`; disk usage and time-series samples are collected periodically. Paper/Purpur telemetry invokes their real `tps` and `mspt` commands on demand, validates the responses, and stores the observed 1-minute TPS/MSPT values.

The Worlds tab can create, download, restore, and import world-specific `.tar.gz` archives. Stopped-server imports must be gzip-compressed tar archives rooted at the target world folder; the backend rejects path traversal, symbolic links, and special files, caps expanded size at 20 GiB, verifies available disk space, and keeps a verified copy as a world backup. While running, a world snapshot sends `save-off`, waits for the actual disable response, sends `save-all flush`, waits for the server's save confirmation, captures the archive, and sends `save-on` in a `finally` path. If the panel cannot confirm saving was re-enabled, it displays an explicit error requiring immediate console inspection. Full-server backups continue to require a stopped server.

The server bind address defaults to `0.0.0.0` (all interfaces) for Minecraft connectivity; choose `127.0.0.1` for a local-only game server. Java uses TCP, while Bedrock and Geyser use UDP; cross-play keeps these ports separately configurable. A LAN address, public IP, and DNS name are different things. Router port forwarding, firewall rules, and DNS are user-managed and are never modified by the panel. The web panel stays bound to loopback independently of the Minecraft server.

## Security notes

- Loopback-only management binding by default. Remote binding requires direct TLS (minimum TLS 1.2) and an explicit Host allowlist.
- The optional CurseForge API key is read from the backend process environment, never returned by the API or sent to the browser, and is sent only to `api.curseforge.com`. Use a private service environment file and do not commit or paste keys into application code.
- First-run password setup; salted scrypt password hash, HttpOnly/SameSite session cookie, same-origin checks, and CSRF token for mutations.
- Password changes require the current password and invalidate other active sessions. Sessions are held in memory and expire after 12 hours of inactivity; a panel restart signs everyone out.
- Login attempts are rate-limited per local connection address.
- No CORS access, browser shell, `sudo`, or user-controlled shell invocation.
- Java is spawned with explicit arguments and `shell: false`.
- File browsing, upload, download, create, move, trash, and editing are confined to each server directory; path traversal and symbolic-link traversal are rejected on the backend. Uploads are limited to 100 MB, downloads to 512 MB, and regular text editing to 1 MB.
- Backups run only when the server is stopped. Restore is stop-only, checks archive paths, extracts into a staging directory, then swaps the existing directory with rollback if the swap fails.
- Recovery-trash files remain under each server root in `.panel-trash`; file deletion moves data there instead of immediately destroying it.
- No firewall, router, DNS, or system Java configuration changes are made.
- The Minecraft console is intentionally privileged: anyone authenticated to this local panel can issue administrative commands.
- Remote management uses the same password authentication and CSRF/origin protections, with HTTPS-only Secure session cookies. TLS termination at a reverse proxy is unsupported because forwarded headers are not trusted.
- The optional CurseForge API key is read from the backend process environment, never returned by the API or sent to the browser, and sent only to `api.curseforge.com`. Keep it in a private service environment and do not commit it.
- Purpur's upstream build metadata currently supplies MD5 rather than a collision-resistant checksum. The panel verifies the published value over HTTPS, but this assurance is weaker than the SHA-256/SHA-1 checks used for other supported software.

## Known limitations

- CurseForge requires an API key and access to the relevant files. CurseForge mod updates, rollback, dependency resolution, plugins, and modpack updates/removal are unsupported.
- Modpacks require a CurseForge manifest and API-accessible required files. Encrypted and ZIP64 archives, arbitrary installer scripts, unsupported override folders, and existing mod sets are not imported.
- Configuration editing is a bounded text editor with syntax coloring, not a loader- or mod-specific schema editor.
- Java installation, firewall/router configuration, public DNS, remote proxy TLS termination, and server software outside the listed loaders are not managed.
- Check [TODO.md](./TODO.md) for the implemented capability checklist and scope notes.

## Known limitations

- CurseForge requires an API key and access to the relevant files. CurseForge installs are not tracked for provider-specific updates or rollback; dependency resolution and plugin discovery are unsupported.
- Modpack imports require a CurseForge manifest and API-accessible required files. Encrypted and ZIP64 archives, arbitrary installer scripts, unsupported override folders, and files already present in the server are not imported.
- Native Bedrock is Linux x86_64 only, follows the current official release exposed by Minecraft's download page, and does not expose this panel's player-management commands or Java mod/plugin managers. The official archive currently has no publisher checksum available to verify.
- Automatic cross-play currently supports Paper/Purpur only. Geyser and Floodgate use their latest official Paper artifacts; other proxies, server software, plugin configuration workflows, and version-specific bridge compatibility selection are not managed.
- Geyser's initial ports are generated automatically. If you later change the Java listener port or Bedrock bind address by editing configuration files, update the corresponding values in `plugins/Geyser-Spigot/config.yml` as well.
- Configuration editing is a bounded text editor with syntax coloring, not a loader- or mod-specific schema editor.
- Java installation, firewall/router configuration, public DNS, remote proxy TLS termination, and server software outside the listed loaders are not managed.
- Review [TODO.md](./TODO.md) before relying on a feature not listed as implemented there.

## Backups and recovery

Create and restore backups from the server's **Backups** tab. For consistency, the server must be stopped. Archives are compressed with system `tar` and stored separately from the server directory. Restore checks member paths and refuses symbolic links and special files, extracts to a new staging directory, and preserves the current directory during the swap; the replaced directory is removed after a successful swap. Keep an additional copy elsewhere for important worlds.

If a download fails, the server remains uninstalled and the durable installation job reports its error; retry from Settings. Installation jobs show progress and can be cancelled; partial downloads are removed. If the panel is stopped normally, it sends `stop` and waits for the server to exit, then escalates to signals if needed. After an abrupt panel exit, the detached supervisor retains the managed process's console streams and log file. On restart, the panel reattaches only after the stored process identity matches; it replays recent log output and restores console control. If supervisor reconnection fails, the process is shown as recovered/orphaned and may be stopped only after its identity check succeeds.

## Uninstall

Stop and disable the user service, then remove only the application code/unit. Server definitions, SQLite state, and worlds are in the data directory and are preserved unless you explicitly remove them:

```fish
systemctl --user disable --now mc-server-panel.service
rm ~/.config/systemd/user/mc-server-panel.service
systemctl --user daemon-reload
rm -r ~/.local/opt/mc-server-panel
```

Do **not** remove `~/.local/share/mc-server-panel` or a custom server/backup root if you want to keep worlds. Verify any path before removing it.

## Troubleshooting

- **`node:sqlite` unavailable:** use Node.js 22.5 or newer; Node 24 is recommended.
- **Panel port already in use:** set a different `MC_PANEL_PORT` (1–65535); the web panel port is unrelated to Minecraft ports.
- **Remote panel will not start:** set both `MC_PANEL_TLS_KEY` and `MC_PANEL_TLS_CERT`, set `MC_PANEL_ALLOWED_HOSTS` to the exact client hostname(s), and verify certificate/key readability. Never use a wildcard host allowlist.
- **Port unavailable when starting a game server:** another process may already be bound to that address/port; choose another Minecraft port or stop the conflicting service.
- **Java is too old:** install an appropriate Java runtime using your preferred Arch package source, then select its executable path. The panel does not replace system Java.
- **Paper install says the version is unsupported:** recheck the current Paper version list and choose a compatible stable release.
- **Backup command missing:** install the Arch `tar` package (`tar` is normally part of a standard CachyOS base installation).
- **Service logs:** `journalctl --user -u mc-server-panel.service -f`; per-server console logs live under that server's `logs/`.
- **Forgot panel password:** stop the panel and back up its data directory. Changing a password in the UI requires the current password; forgotten-password recovery is not implemented.

## License

[MIT License](./LICENSE).