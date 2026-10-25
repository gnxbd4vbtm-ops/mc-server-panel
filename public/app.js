const app = document.querySelector("#app");
const toastArea = document.querySelector("#toast-area");
const state = {
  csrf: null, servers: [], selected: null, tab: "Overview", versions: [],
  bedrockVersions: [],
  lanAddresses: [],
  logs: "", eventSource: null, filePath: ".", selectedFile: null, fileContent: "",
  fileMode: "files", theme: localStorage.getItem("mc-panel-theme") ?? "dark",
};
document.documentElement.dataset.theme = state.theme;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function highlightedSource(source, filename) {
  const extension = filename.split(".").at(-1).toLowerCase();
  const language = new Map([
    ["json", "json"], ["yaml", "yaml"], ["yml", "yaml"], ["toml", "toml"], ["properties", "properties"],
  ]).get(extension) ?? "text";
  const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*|\/\/[^\n]*|\b(?:true|false|null|yes|no)\b|-?\b\d+(?:\.\d+)?\b|[A-Za-z_][\w.-]*(?=\s*[:=]))/g;
  let output = "";
  let cursor = 0;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    const start = match.index;
    output += escapeHtml(source.slice(cursor, start));
    const escaped = escapeHtml(token);
    let type = "string";
    if (token.startsWith("#") || token.startsWith("//")) type = "comment";
    else if (/^(?:true|false|null|yes|no)$/i.test(token)) type = "literal";
    else if (/^-?\d/.test(token)) type = "number";
    else if (/^[A-Za-z_]/.test(token) && !/^['"]/.test(token)) type = "key";
    else if (token.startsWith('"') && /^\s*:/.test(source.slice(start + token.length))) type = "key";
    output += `<span class="syntax-${type}">${escaped}</span>`;
    cursor = start + token.length;
  }
  output += escapeHtml(source.slice(cursor));
  return { language, html: `${output}\n` };
}

function connectionAddress(server) {
  const bedrockPort = server.loader === "bedrock" ? server.port : server.bedrock_port;
  const javaPort = server.loader === "bedrock" ? null : server.port;
  if (server.bind_address === "0.0.0.0" || server.bind_address === "::") {
    if (state.lanAddresses.length) {
      return state.lanAddresses.slice(0, 3).map((address) => {
        const formatted = address.includes(":") ? `[${address}]` : address;
        if (server.loader === "bedrock") return `${formatted}:${bedrockPort} UDP`;
        return server.crossplay
          ? `Java ${formatted}:${javaPort} TCP · Bedrock ${formatted}:${bedrockPort} UDP`
          : `${formatted}:${javaPort} TCP`;
      }).join(", ");
    }
    if (server.loader === "bedrock") return `All interfaces:${bedrockPort} UDP`;
    return server.crossplay
      ? `Java ${javaPort} TCP · Bedrock ${bedrockPort} UDP`
      : `All interfaces:${javaPort} TCP`;
  }
  const formatted = server.bind_address.includes(":") ? `[${server.bind_address}]` : server.bind_address;
  if (server.loader === "bedrock") return `${formatted}:${bedrockPort} UDP`;
  return server.crossplay
    ? `Java ${formatted}:${javaPort} TCP · Bedrock ${formatted}:${bedrockPort} UDP`
    : `${formatted}:${javaPort} TCP`;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (state.csrf && !["GET", "HEAD"].includes(options.method ?? "GET")) headers.set("x-csrf-token", state.csrf);
  const response = await fetch(url, {
    ...options, headers, credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const type = response.headers.get("content-type") ?? "";
  const value = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(value?.error ?? `Request failed with HTTP ${response.status}`);
  return value;
}

function toast(message, kind = "info") {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  if (kind === "error") item.style.borderColor = "var(--danger)";
  toastArea.append(item);
  setTimeout(() => item.remove(), 5000);
}

function duration(seconds) {
  if (!seconds) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}m`;
}

function statusMarkup(status) {
  return `<span class="status ${escapeHtml(status)}"><i class="dot"></i>${escapeHtml(status)}</span>`;
}

function renderAuth(firstRun) {
  app.innerHTML = `<main class="auth-wrap"><form class="auth-card" id="auth-form">
    <div class="brand"><span class="mark">B</span><span>BYTE SERVER PANEL<small>MINECRAFT SERVER PANEL</small></span></div>
    <h1>${firstRun ? "Set up your panel" : "Welcome back"}</h1>
    <p class="muted">${firstRun ? "Create a local administrator password. It is stored as a salted password hash." : "Sign in to manage your Minecraft servers."}</p>
    <div class="field"><label for="password">${firstRun ? "Administrator password (12+ characters)" : "Password"}</label><input class="input" id="password" type="password" minlength="${firstRun ? "12" : "1"}" required autocomplete="${firstRun ? "new-password" : "current-password"}"></div>
    ${firstRun ? '<div class="field"><label for="password-confirm">Confirm password</label><input class="input" id="password-confirm" type="password" minlength="12" required autocomplete="new-password"></div>' : ""}
    <button class="button primary" style="width:100%" type="submit">${firstRun ? "Create password" : "Sign in"}</button>
    <p class="muted" style="font-size:11px;margin:18px 0 0">This panel listens on this computer only (127.0.0.1).</p>
  </form></main>`;
  document.querySelector("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.querySelector("#password").value;
    if (firstRun && password !== document.querySelector("#password-confirm").value) {
      toast("Passwords do not match.", "error");
      return;
    }
    const submit = event.currentTarget.querySelector("button");
    submit.disabled = true;
    try {
      const data = await api(firstRun ? "/api/setup" : "/api/login", { method: "POST", body: { password } });
      state.csrf = data.csrf;
      await showApp();
    } catch (error) {
      toast(error.message, "error");
      submit.disabled = false;
    }
  });
}

async function boot() {
  try {
    const session = await api("/api/session");
    if (!session.configured) return renderAuth(true);
    if (!session.authenticated) return renderAuth(false);
    state.csrf = session.csrf;
    await showApp();
  } catch (error) {
    app.innerHTML = `<main class="auth-wrap"><div class="auth-card"><h1>Panel unavailable</h1><p class="muted">${escapeHtml(error.message)}</p></div></main>`;
  }
}

async function showApp() {
  try {
    const metadata = await api("/api/versions");
    state.versions = metadata.versions;
    state.bedrockVersions = metadata.bedrock_versions ?? [];
    if (!metadata.bedrock_available) toast(`Bedrock version metadata is unavailable: ${metadata.bedrock_error}`, "error");
    if (!metadata.paper_available) toast(`Paper compatibility metadata is unavailable: ${metadata.paper_error}`, "error");
    if (!metadata.fabric_available) toast(`Fabric compatibility metadata is unavailable: ${metadata.fabric_error}`, "error");
    if (!metadata.quilt_available) toast(`Quilt compatibility metadata is unavailable: ${metadata.quilt_error}`, "error");
    if (!metadata.forge_available) toast(`Forge compatibility metadata is unavailable: ${metadata.forge_error}`, "error");
    if (!metadata.neoforge_available) toast(`NeoForge compatibility metadata is unavailable: ${metadata.neoforge_error}`, "error");
  } catch (error) {
    toast(`Could not load Minecraft version metadata: ${error.message}`, "error");
    state.versions = [];
  }
  try {
    state.lanAddresses = (await api("/api/network")).lan_addresses;
  } catch (error) {
    toast(`Could not read LAN addresses: ${error.message}`, "error");
    state.lanAddresses = [];
  }
  await refreshServers();
  render();
  if (!state.poller) {
    state.poller = setInterval(refreshSilently, 5000);
  }
}

async function refreshServers() {
  state.servers = await api("/api/servers");
}

async function refreshSilently() {
  try {
    state.servers = await api("/api/servers");
    if (!state.selected) {
      updateDashboardView();
    } else {
      const updated = state.servers.find((server) => server.id === state.selected.id);
      if (!updated) {
        state.selected = null;
        render();
      } else {
        state.selected = { ...state.selected, ...updated };
        const status = document.querySelector("#selected-status");
        if (status) status.innerHTML = statusMarkup(updated.status);
        const pid = document.querySelector("#selected-pid");
        if (pid) pid.textContent = updated.pid ? `PID ${updated.pid}` : "Not running";
        const uptime = document.querySelector("#selected-uptime");
        if (uptime) uptime.textContent = duration(updated.uptime_seconds);
        const playerCount = document.querySelector("#selected-players");
        if (playerCount) playerCount.textContent = updated.players === null ? "Unknown" : updated.players;
        const memory = document.querySelector("#selected-memory");
        if (memory) memory.textContent = updated.memory_mb === null ? "—" : `${updated.memory_mb} MB`;
        const cpu = document.querySelector("#selected-cpu");
        if (cpu) cpu.textContent = updated.cpu_percent === null ? "—" : `${updated.cpu_percent}%`;
      }
    }
  } catch (error) {
    if (error.message === "Sign in to continue") {
      state.csrf = null;
      closeStream();
      clearInterval(state.poller);
      state.poller = null;
      renderAuth(false);
    } else {
      console.warn("Server status refresh failed:", error);
    }
  }
}

function updateDashboardView() {
  const running = state.servers.filter((server) => server.status === "running").length;
  const memory = state.servers.reduce((sum, server) => sum + (server.memory_mb ?? 0), 0);
  const values = document.querySelectorAll(".stat-value");
  if (values[0]) values[0].textContent = state.servers.length;
  if (values[1]) values[1].innerHTML = `${running}<span class="muted" style="font-size:14px;font-weight:400"> / ${state.servers.length}</span>`;
  if (values[2]) values[2].innerHTML = memory ? `${memory} <span style="font-size:14px">MB</span>` : "—";
  const count = document.querySelector("#server-nav-count");
  if (count) count.textContent = state.servers.length;
  document.querySelectorAll(".nav-server[data-server]").forEach((button) => {
    const server = state.servers.find((entry) => entry.id === button.dataset.server);
    const dot = button.querySelector(".dot");
    if (server && dot) dot.style.background = server.status === "running" ? "var(--accent)" : "var(--muted)";
  });
  if (document.querySelector("#servers-grid")) renderServerCards();
}

function shell(content, selected = "Dashboard") {
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="mark">B</span><span>BYTE SERVER PANEL<small>LOCAL SERVER HOST</small></span></div>
      <div class="nav-label">Workspace</div>
      <nav><button class="nav-item ${selected === "Dashboard" ? "active" : ""}" id="nav-dashboard"><span class="nav-icon">▦</span>Dashboard</button></nav>
      <div class="nav-label">Your servers <span id="server-nav-count" style="float:right">${state.servers.length}</span></div>
      <nav>${state.servers.map((server) => `<button class="nav-server" data-server="${escapeHtml(server.id)}"><span class="dot" style="background:${server.status === "running" ? "var(--accent)" : "var(--muted)"}"></span>${escapeHtml(server.name)}</button>`).join("")}</nav>
      <div class="side-bottom"><div class="user-row"><span class="avatar">A</span><span class="user-name">Local administrator<small class="muted" style="display:block">This device only</small></span><button class="icon-button" id="logout" title="Sign out">↗</button></div></div>
    </aside>
    <main class="main">${content}</main>
  </div>`;
  document.querySelector("#nav-dashboard").addEventListener("click", () => {
    closeStream(); state.selected = null; render();
  });
  document.querySelectorAll("[data-server]").forEach((button) => button.addEventListener("click", () => openServer(button.dataset.server)));
  document.querySelector("#logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); } catch (error) { toast(error.message, "error"); }
    state.csrf = null;
    closeStream();
    clearInterval(state.poller);
    state.poller = null;
    renderAuth(false);
  });
  const themeButton = document.querySelector("#theme-toggle");
  themeButton?.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
    localStorage.setItem("mc-panel-theme", state.theme);
  });
}

function renderDashboard() {
  const running = state.servers.filter((server) => server.status === "running").length;
  const memory = state.servers.reduce((sum, server) => sum + (server.memory_mb ?? 0), 0);
  shell(`<header class="topbar"><div><h1>Good ${new Date().getHours() < 12 ? "morning" : "evening"}</h1><p>Your Minecraft servers, at a glance.</p></div><div class="actions"><button class="icon-button" id="theme-toggle" title="Toggle theme">◐</button><button class="button primary" id="create-server">＋ &nbsp;New server</button></div></header>
    <section class="stats-grid">
      <article class="stat-card"><div class="stat-label">Total servers</div><div class="stat-value">${state.servers.length}</div></article>
      <article class="stat-card"><div class="stat-label">Currently running</div><div class="stat-value">${running}<span class="muted" style="font-size:14px;font-weight:400"> / ${state.servers.length}</span></div></article>
      <article class="stat-card"><div class="stat-label">Memory in use</div><div class="stat-value">${memory ? `${memory} <span style="font-size:14px">MB</span>` : "—"}</div></article>
    </section>
    <section><div class="section-head"><div><h2>Your servers</h2><p>Live state from managed server processes.</p></div><div class="actions"><input class="search" id="server-search" placeholder="Search servers…" aria-label="Search servers"><select class="input" id="server-sort" style="width:auto"><option value="name">Name A–Z</option><option value="created">Recently created</option><option value="status">Status</option></select></div></div><div id="servers-grid" class="server-grid"></div></section>
    <div class="notice" style="margin-top:28px">The management panel is bound to <span class="mono">127.0.0.1</span>. Minecraft ports are separate. To allow friends to join, configure your router and firewall yourself; this panel never changes them.</div>`);
  document.querySelector("#create-server").addEventListener("click", showCreateWizard);
  document.querySelector("#server-search").addEventListener("input", renderServerCards);
  document.querySelector("#server-sort").addEventListener("change", renderServerCards);
  renderServerCards();
}

function renderServerCards() {
  const query = document.querySelector("#server-search").value.trim().toLowerCase();
  const sort = document.querySelector("#server-sort").value;
  const servers = state.servers.filter((server) =>
    `${server.name} ${server.id} ${server.version} ${server.loader ?? server.software}`.toLowerCase().includes(query));
  if (sort === "name") servers.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "created") servers.sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (sort === "status") servers.sort((a, b) => a.status.localeCompare(b.status));
  const grid = document.querySelector("#servers-grid");
  if (!servers.length) {
    grid.innerHTML = state.servers.length
      ? '<div class="empty" style="grid-column:1/-1">No servers match your search.</div>'
      : '<div class="empty" style="grid-column:1/-1"><div class="empty-icon">▣</div><h2>No servers yet</h2><p>Create your first independent Minecraft server instance.</p><button class="button primary" id="empty-create">Create a server</button></div>';
    document.querySelector("#empty-create")?.addEventListener("click", showCreateWizard);
    return;
  }
  grid.innerHTML = servers.map((server) => `<article class="server-card" data-card="${escapeHtml(server.id)}">
    <div class="card-head"><span class="server-emblem">▦</span><div class="server-title"><h3>${escapeHtml(server.name)}</h3><p class="mono">${escapeHtml(server.loader ?? server.software)} · ${escapeHtml(server.version)}</p></div>${statusMarkup(server.status)}</div>
    <div class="card-meta"><span>${server.players === null ? "Players —" : `Players ${server.players}/${server.max_players}`}</span><span>${server.status === "running" ? duration(server.uptime_seconds) : server.loader === "bedrock" ? "Native Bedrock" : `${server.max_memory_mb} MB max`}</span></div>
    <div class="card-footer"><span title="LAN address">${escapeHtml(connectionAddress(server))}</span><span>${server.memory_mb === null ? "RAM —" : `RAM ${server.memory_mb} MB`}</span></div>
  </article>`).join("");
  document.querySelectorAll("[data-card]").forEach((card) => card.addEventListener("click", () => openServer(card.dataset.card)));
}

async function openServer(id) {
  closeStream();
  const server = state.servers.find((candidate) => candidate.id === id);
  if (!server) return;
  state.selected = server;
  state.tab = "Overview";
  state.filePath = ".";
  state.selectedFile = null;
  try {
    const files = await api(`/api/servers/${encodeURIComponent(id)}/files?path=.`);
    state.selected.installed = files.some((entry) => entry.name === "server-panel.json");
  } catch { state.selected.installed = false; }
  render();
}

function renderDetail() {
  const server = state.selected;
  if (!server) return renderDashboard();
  const tabs = ["Overview", "Console", ...(server.loader === "bedrock" ? [] : ["Players"]), ...(server.software === "paper" ? ["Plugins"] : []),
    ...(server.loader && ["fabric", "forge", "neoforge", "quilt"].includes(server.loader) ? ["Mods", "Modpacks"] : []),
    "Files", "Worlds", "Configuration", "Backups", "Settings"];
  if (!tabs.includes(state.tab)) state.tab = "Overview";
  const active = ["running", "starting", "stopping", "orphaned"].includes(server.status);
  const controls = active
    ? `<button class="button" id="restart-server" ${server.status !== "running" ? "disabled" : ""}>Restart</button><button class="button" id="stop-server" ${server.status === "stopping" || (server.status === "starting" && !server.pid) ? "disabled" : ""}>${server.status === "stopping" ? "Stopping…" : server.status === "starting" && !server.pid ? "Starting…" : server.status === "orphaned" ? "Stop recovered process" : "Stop"}</button><button class="button danger" id="force-stop-server" ${!server.pid ? "disabled" : ""}>Force stop</button>`
    : server.operation
      ? `<button class="button" disabled>${server.operation === "installing" || server.operation === "restoring" ? "Updating…" : escapeHtml(server.operation)}</button>`
      : `<button class="button primary" id="start-server" ${!server.installed || !server.eula_accepted ? "disabled" : ""}>Start server</button>`;
  shell(`  <header class="topbar"><div><button class="button small" id="back-dashboard">← &nbsp;All servers</button><h1 style="margin-top:17px">${escapeHtml(server.name)}</h1><p><span class="mono">${escapeHtml(server.loader ?? server.software)} ${escapeHtml(server.version)}</span> · ${escapeHtml(server.description || server.id)}</p></div><div class="actions">${controls}<button class="icon-button" id="theme-toggle" title="Toggle theme">◐</button></div></header>
    <div class="actions" style="gap:12px;margin-bottom:3px"><span id="selected-status">${statusMarkup(server.status)}</span><span id="selected-pid" class="muted mono">${server.pid ? `PID ${server.pid}` : "Not running"}</span>${server.status === "orphaned" ? '<span class="notice warning">Recovered process identity is valid, but its control socket is unavailable. Console reattachment failed; stopping remains available.</span>' : ""}${server.last_exit_code !== null ? `<span class="muted">Last exit: ${escapeHtml(server.last_exit_code)}</span>` : ""}</div>
    <div class="tabs" role="tablist">${tabs.map((tab) => `<button class="tab ${state.tab === tab ? "active" : ""}" data-tab="${tab}">${tab}</button>`).join("")}</div>
    <div id="detail-content">${renderTab()}</div>`, "Server");
  document.querySelector("#back-dashboard").addEventListener("click", () => { closeStream(); state.selected = null; render(); });
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    closeStream(); state.tab = button.dataset.tab; state.selectedFile = null; render();
  }));
  document.querySelector("#start-server")?.addEventListener("click", () => runAction(() => api(`/api/servers/${server.id}/start`, { method: "POST", body: {} }), "Server started."));
  document.querySelector("#stop-server")?.addEventListener("click", () => {
    if (confirm("Send the stop command and wait up to 15 seconds for a graceful shutdown?")) runAction(() => api(`/api/servers/${server.id}/stop`, { method: "POST", body: {} }), "Server stop requested.");
  });
  document.querySelector("#restart-server")?.addEventListener("click", () => {
    if (confirm("Stop this server gracefully and start it again?")) runAction(() => api(`/api/servers/${server.id}/restart`, { method: "POST", body: {} }), "Server restarted.");
  });
  document.querySelector("#force-stop-server")?.addEventListener("click", () => {
    if (confirm("Force-kill this server process now? Unsaved world data may be lost.")) runAction(() => api(`/api/servers/${server.id}/stop`, { method: "POST", body: { force: true } }), "Server process force-killed.");
  });
  attachTab();
}

function renderTab() {
  const server = state.selected;
  const activeProcess = ["running", "starting", "stopping"].includes(server.status);
  switch (state.tab) {
    case "Overview": return `<section class="detail-grid">
      <article class="metric"><span>Uptime</span><strong id="selected-uptime">${duration(server.uptime_seconds)}</strong></article>
      <article class="metric"><span>Players online</span><strong id="selected-players">${server.players === null ? "Unknown" : server.players}</strong></article>
      <article class="metric"><span>${server.loader === "bedrock" ? "Process memory" : "Memory in use"}</span><strong id="selected-memory">${server.memory_mb === null ? "—" : `${server.memory_mb} MB`}</strong></article>
      <article class="metric"><span>CPU usage</span><strong id="selected-cpu">${server.cpu_percent === null ? "—" : `${server.cpu_percent}%`}</strong></article>
      <article class="metric"><span>LAN connection</span><strong class="mono" style="font-size:12px;overflow-wrap:anywhere">${escapeHtml(connectionAddress(server))}</strong></article>
      ${server.loader === "bedrock" ? '<article class="metric"><span>Runtime</span><strong>Native Linux x86_64</strong></article>' : `<article class="metric"><span>Java runtime</span><strong class="mono" style="font-size:12px;overflow-wrap:anywhere">${escapeHtml(server.java_path)}</strong></article>`}
    </section>
    <section class="panel"><h2>Instance information</h2><p class="muted" style="font-size:13px">${escapeHtml(server.description || "No description added.")}</p>
      <div class="notice">${server.installed ? "Server software is installed." : "Server software is not installed yet. Install it from Settings."} ${server.eula_accepted ? "EULA accepted." : "EULA acceptance is required before starting."}</div>
      <p class="muted" style="font-size:12px">${server.loader === "bedrock" ? `Native Bedrock Dedicated Server · UDP ${server.port}` : `RAM limit ${server.min_memory_mb}–${server.max_memory_mb} MB · Java ${escapeHtml(server.java_path)}`}${server.crossplay ? ` · Bedrock cross-play UDP ${server.bedrock_port}` : ""} · max players ${server.max_players}</p></section>
    <section class="panel"><h2>Resource history</h2><p class="muted">Recent persisted samples; disk usage covers this server directory.</p><div id="metrics-history" class="loading">Loading resource history…</div></section>`;
    case "Console": return `<section class="panel"><div class="console-tools"><input class="input" id="console-search" placeholder="Filter visible output…"><button class="button small" id="console-pause">Pause scroll</button><button class="button small" id="console-copy">Copy output</button></div><div class="console" id="console-output" aria-label="Live server console"></div><form class="console-form" id="command-form"><input class="input mono" id="command" placeholder="Enter a server command (without /)" autocomplete="off" ${["running", "starting"].includes(server.status) ? "" : "disabled"}><button class="button primary" ${["running", "starting"].includes(server.status) ? "" : "disabled"}>Send</button></form><p class="muted" style="font-size:11px;margin:10px 0 0">Commands are sent directly to this server process. Console access is administrative.</p></section>`;
    case "Players": return `<section class="panel"><div class="section-head"><div><h2>Players</h2><p>Online names come from the server's actual <span class="mono">list</span> response.</p></div><button class="button" id="refresh-players" ${server.status !== "running" ? "disabled" : ""}>Refresh</button></div>
      <div id="player-list" class="loading">Querying the server…</div>
      <form id="player-action-form" class="console-form"><input class="input" id="player-name" maxlength="16" placeholder="Player name" required><select class="input" id="player-action"><option value="whitelistAdd">Whitelist</option><option value="whitelistRemove">Remove whitelist</option><option value="op">Make operator</option><option value="deop">Remove operator</option><option value="ban">Ban</option><option value="pardon">Unban</option></select><button class="button primary" ${server.status !== "running" ? "disabled" : ""}>Apply</button></form>
      <div class="notice warning">Offline-mode names and UUIDs are not authenticated identities. Permission records can only be edited while stopped.</div>
      <form id="resolve-player-form" class="console-form"><input class="input" id="resolve-player-name" maxlength="16" placeholder="Resolve Minecraft profile name" required><button class="button" type="submit">Resolve UUID</button></form><div id="resolved-player" class="muted"></div>
      <button class="button small" id="view-permissions">Load stopped-server permission records</button><div id="permission-editor" hidden><div class="field"><label for="permission-file">Permission file</label><select class="input" id="permission-file"><option>whitelist.json</option><option>ops.json</option><option>banned-players.json</option></select></div><textarea class="input mono" id="permission-records" rows="12" spellcheck="false" aria-label="Permission records JSON"></textarea><button class="button primary" id="save-permissions">Save permission records</button></div></section>`;
    case "Mods": return renderProjectManager("mod");
    case "Plugins": return renderProjectManager("plugin");
    case "Modpacks": return renderModpacks();
    case "Files": return renderFiles();
    case "Worlds": return `<section class="panel"><h2>World data</h2><p class="muted">Stopped backups and imports require the server to be stopped. A live snapshot briefly pauses automatic saves and flushes world state. Import archives must be gzip-compressed tar files whose top-level folder matches the target world name. Symbolic links and special files are refused.</p><div id="world-list" class="loading">Reading world folders…</div>
      <h3>Import a world archive</h3><form id="world-import-form" class="console-form"><input class="input" id="world-import-name" placeholder="Target folder name (must match archive)" required pattern="[A-Za-z0-9_-]{1,64}"><input class="input" id="world-import-file" type="file" accept=".tar.gz,application/gzip" required><button class="button danger">Import world</button></form>
      <h3>World backups</h3><div id="world-backup-list" class="loading">Loading world backups…</div><button class="button" id="open-world-files">Browse files</button></section>`;
    case "Configuration": return renderConfiguration();
    case "Backups": return `<section class="panel"><div class="section-head"><div><h2>Backups</h2><p>Consistent archive backups require the server to be stopped.</p></div><button class="button primary" id="create-backup" ${!server.operation && (server.status === "stopped" || server.status === "crashed") ? "" : "disabled"}>Create backup</button></div>
      <form id="backup-schedule" class="form-grid"><div class="field"><label for="backup-hours">Interval (hours)</label><input class="input" id="backup-hours" type="number" min="1" max="720" value="24"></div><div class="field"><label for="backup-retention">Keep backups</label><input class="input" id="backup-retention" type="number" min="1" max="100" value="7"></div><label class="checkbox-row"><input type="checkbox" id="backup-enabled">Enable schedule</label><button class="button" type="submit">Save schedule</button></form><div id="backup-schedule-state" class="muted"></div>
      <div id="backup-list" class="loading">Loading backups…</div></section>`;
    case "Settings": return `<section class="panel"><h2>Server settings</h2><div class="detail-grid">
      <div class="metric"><span>Software</span><strong>${escapeHtml(server.loader ?? server.software)}</strong></div><div class="metric"><span>Minecraft</span><strong>${escapeHtml(server.version)}</strong></div><div class="metric"><span>Directory</span><strong class="mono" style="font-size:11px;overflow-wrap:anywhere">servers/${escapeHtml(server.id)}</strong></div></div>
      <div class="notice warning">${server.eula_accepted ? "EULA acceptance recorded." : "The server cannot start until you explicitly accept the Minecraft EULA."}</div>
      <label class="checkbox-row"><input type="checkbox" id="auto-restart-setting" ${server.auto_restart ? "checked" : ""}> Automatically restart after unexpected crashes (maximum 3 attempts)</label>
      <button class="button" id="accept-eula" ${server.eula_accepted || server.operation ? "disabled" : ""}>Review and accept EULA</button>
      <button class="button" id="install-server" ${server.operation || activeProcess ? "disabled" : ""}>${server.installed ? server.loader === "bedrock" ? "Update Bedrock server" : "Reinstall / update server software" : "Install server software"}</button>
      <p class="muted" style="font-size:12px;margin-top:12px">Supported installers: native Bedrock Dedicated Server on Linux x86_64, Vanilla (including Mojang-listed preview versions), Paper/Purpur, Fabric, Quilt, Forge, and NeoForge. Loader availability depends on upstream compatibility metadata. Paper/Purpur cross-play installs and updates Geyser and Floodgate.</p>
      ${server.loader === "bedrock" ? '<div class="notice">This is the native Bedrock server: no Java runtime or Java mod/plugin manager is used. The server console, files, worlds, and backups remain available; player-management commands are not exposed in this panel.</div>' : ""}
      <hr style="border:0;border-top:1px solid var(--line);margin:24px 0">
      <h3>Change panel password</h3><form id="password-change" class="form-grid"><div class="field"><label for="current-password">Current password</label><input class="input" id="current-password" type="password" autocomplete="current-password" required></div><div class="field"><label for="new-password">New password (12+ characters)</label><input class="input" id="new-password" type="password" minlength="12" autocomplete="new-password" required></div><button class="button" type="submit">Update password</button></form>
      <hr style="border:0;border-top:1px solid var(--line);margin:24px 0">
      <h3>Delete server</h3><p class="muted" style="font-size:12px">This permanently removes the server directory and its backup archives. Create/download a backup elsewhere first if you need to preserve data.</p><button class="button danger" id="delete-server" ${server.operation ? "disabled" : ""}>Delete this server</button></section>`;
    default: return "";
  }
}

function renderFiles() {
  if (state.selectedFile !== null) {
    const highlighted = highlightedSource(state.fileContent, state.selectedFile);
    return `<section class="panel"><div class="section-head"><div><button class="button small" id="file-back">← Files</button><p class="breadcrumb">${escapeHtml(state.selectedFile)}</p></div><div><span class="muted">${highlighted.language}</span> <button class="button primary" id="save-file">Save file</button></div></div><div class="code-editor"><pre class="code-highlight" aria-hidden="true"><code id="file-highlight">${highlighted.html}</code></pre><textarea class="input file-editor" id="file-editor" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="Text file editor">${escapeHtml(state.fileContent)}</textarea></div><p class="muted" style="font-size:11px;margin:9px 0 0">Syntax colors are provided for JSON, YAML, TOML, and properties files. Text editor, maximum 1 MB. Symbolic links cannot be read or edited.</p></section>`;
  }
  return `<section class="panel"><div class="section-head"><div><h2>Files</h2><p class="breadcrumb">${escapeHtml(state.filePath)}</p></div>
    <div class="actions"><button class="button small" id="new-file">New file</button><button class="button small" id="new-folder">New folder</button><button class="button small" id="upload-file">Upload</button><button class="button" id="file-up" ${state.filePath === "." ? "disabled" : ""}>↑ Up</button><input id="file-upload-input" type="file" hidden></div></div><div id="file-list" class="loading">Loading directory…</div></section>`;
}

function renderConfiguration() {
  if (state.selectedFile !== null) return renderFiles();
  const hasLoaderConfig = ["fabric", "forge", "neoforge", "quilt"].includes(state.selected.loader);
  return `<section class="panel"><h2>Configuration files</h2><p class="muted" style="font-size:13px">Open a text file from your server directory to edit it. Changes are written directly to the instance.</p><div class="actions"><button class="button primary" id="browse-config">Browse all files</button>${hasLoaderConfig ? '<button class="button" id="browse-loader-config">Browse loader and mod configs</button>' : ""}</div><div class="notice">Edit server.properties, JSON, TOML, YAML, and other text files. Loader and mod configuration files are opened from the config/ directory. The editor does not perform schema validation. Back up important files before editing.</div></section>`;
}

function renderProjectManager(type) {
  const isMod = type === "mod";
  const loaderName = state.selected.loader ?? state.selected.software;
  const label = isMod ? `${loaderName[0].toUpperCase()}${loaderName.slice(1)} mods` : "Paper plugins";
  const projectLabel = isMod ? "mods" : "plugins";
  return `<section class="panel"><div class="section-head"><div><h2>${label}</h2><p>Search compatible ${projectLabel} and install while the server is stopped.</p></div></div>
      <form id="project-search" class="console-form">${isMod ? '<select class="input" id="project-source" aria-label="Project source"><option value="modrinth">Modrinth</option><option value="curseforge">CurseForge</option></select>' : ""}<input class="input" id="project-query" placeholder="Search ${projectLabel}"><button class="button primary">Search</button></form>
      <div id="project-results" class="loading">Loading installed ${projectLabel}…</div>
      <h3>Installed ${projectLabel}</h3><div id="installed-projects" class="loading">Loading…</div>
      <p class="muted">Modrinth downloads are checksum-verified and install required dependencies. CurseForge downloads require a backend-only API key and are SHA-1 verified; CurseForge dependency resolution and updates are not supported.</p></section>`;
}

function renderModpacks() {
  return `<section class="panel"><h2>CurseForge modpacks</h2><p class="muted">Find modpacks for Minecraft ${escapeHtml(state.selected.version)}. Installation requires a backend-only CurseForge API key and a stopped server.</p>
    <form id="modpack-search" class="console-form"><input class="input" id="modpack-query" placeholder="Search CurseForge modpacks"><button class="button primary">Search</button></form>
    <div id="modpack-results" class="empty">Search for a compatible modpack.</div>
    <div class="notice">Required mod files are downloaded through CurseForge's API and SHA-1 verified. Only modpack overrides in mods/, config/, defaultconfigs/, kubejs/, scripts/, resourcepacks/, and datapacks/ are installed. Existing files are never overwritten. CurseForge licensing or unavailable files may prevent installation.</div></section>`;
}

async function runAction(action, success) {
  try {
    await action();
    toast(success);
    await refreshServers();
    state.selected = state.servers.find((server) => server.id === state.selected?.id) ?? state.selected;
    render();
  } catch (error) {
    toast(error.message, "error");
    await refreshSilently();
  }
}

function attachTab() {
  const id = state.selected.id;
  if (state.tab === "Console") attachConsole(id);
  if (state.tab === "Overview") attachMetrics(id);
  if (state.tab === "Files") loadFileDirectory(id);
  if (state.tab === "Players") attachPlayers(id);
  if (state.tab === "Mods") attachProjects(id, "mod");
  if (state.tab === "Plugins") attachProjects(id, "plugin");
  if (state.tab === "Modpacks") attachModpacks(id);
  if (state.tab === "Configuration") {
    document.querySelector("#browse-config")?.addEventListener("click", () => { state.tab = "Files"; state.filePath = "."; render(); });
    document.querySelector("#browse-loader-config")?.addEventListener("click", () => {
      state.tab = "Files";
      state.filePath = "config";
      render();
    });
    if (state.selectedFile !== null) attachEditor(id);
  }

  async function attachMetrics(id) {
    const chart = document.querySelector("#metrics-history");
    if (["paper", "purpur"].includes(state.selected.loader ?? state.selected.software)) {
      const telemetry = document.createElement("div");
      telemetry.className = "actions";
      telemetry.style.marginBottom = "12px";
      telemetry.innerHTML = `<button class="button small" id="refresh-telemetry" ${state.selected.status !== "running" ? "disabled" : ""}>Query server TPS/MSPT</button><span id="telemetry-value">${Array.isArray(state.selected.tps) ? `TPS ${state.selected.tps.map((value) => value.toFixed(1)).join(" / ")} · MSPT ${state.selected.mspt ?? "—"}` : "No server-reported TPS/MSPT query yet."}</span>`;
      chart.before(telemetry);
      telemetry.querySelector("#refresh-telemetry").addEventListener("click", async (event) => {
        event.currentTarget.disabled = true;
        try {
          const result = await api(`/api/servers/${id}/telemetry`, { method: "POST", body: {} });
          telemetry.querySelector("#telemetry-value").textContent =
            `TPS ${result.tps.map((value) => value.toFixed(1)).join(" / ")} · MSPT ${result.mspt.toFixed(2)}`;
          await refreshSilently();
        } catch (error) { toast(error.message, "error"); }
        finally { event.currentTarget.disabled = state.selected?.status !== "running"; }
      });
    }
    try {
      const { metrics, crashes } = await api(`/api/servers/${id}/history`);
      if (!metrics.length) chart.innerHTML = '<div class="empty">No samples yet. Metrics are sampled once per minute while the panel is running.</div>';
      else {
        const graph = (label, key, color, unit) => {
          const values = metrics.map((sample) => Number.isFinite(sample[key]) ? sample[key] : null);
          const present = values.filter((value) => value !== null);
          if (!present.length) return `<div class="metric-chart"><span>${label}: no readings</span></div>`;
          const max = Math.max(1, ...present);
          const points = values.map((value, index) => value === null ? null :
            `${(index / Math.max(1, values.length - 1) * 400).toFixed(1)},${(85 - value / max * 75).toFixed(1)}`).filter(Boolean);
          const current = present.at(-1);
          const display = key === "disk_bytes" ? current >= 1024 ** 3 ? `${(current / 1024 ** 3).toFixed(1)} GB` :
            `${(current / 1024 ** 2).toFixed(1)} MB` : `${current.toFixed(1)} ${unit}`;
          return `<div class="metric-chart"><span>${label} · current ${display}</span>
            <svg viewBox="0 0 400 100" role="img" aria-label="${label} history"><polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="2"/></svg></div>`;
        };
        chart.innerHTML = graph("CPU", "cpu_percent", "var(--accent)", "%") +
          graph("Memory", "memory_mb", "var(--warn)", "MB") +
          graph("Disk", "disk_bytes", "#7ab7ff", "bytes");
        if (["paper", "purpur"].includes(state.selected.loader ?? state.selected.software)) {
          chart.insertAdjacentHTML("beforeend", graph("TPS (1m)", "tps_1m", "#b38aff", "TPS") +
            graph("MSPT", "mspt", "#ff8aa8", "ms"));
        }
      }
      if (crashes.length) {
        chart.insertAdjacentHTML("beforeend", `<h3>Recent crashes</h3>${crashes.map((crash) =>
          `<div class="file-row"><span class="file-name">Exit ${escapeHtml(crash.exit_code ?? "unknown")}</span><small class="muted">${new Date(crash.occurred_at + "Z").toLocaleString()}</small></div>`).join("")}`);
      }
    } catch (error) { chart.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; }
  }
  if (state.tab === "Worlds") {
    document.querySelector("#open-world-files").addEventListener("click", () => { state.tab = "Files"; state.filePath = "."; render(); });
    attachWorlds(id);
  }
  if (state.tab === "Backups") attachBackups(id);
  if (state.tab === "Settings") {
    attachSettings(id);
    document.querySelector("#password-change").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api("/api/password", { method: "POST", body: {
          current_password: document.querySelector("#current-password").value,
          new_password: document.querySelector("#new-password").value,
        } });
        event.currentTarget.reset();
        toast("Panel password changed. Other active sessions were signed out.");
      } catch (error) { toast(error.message, "error"); }
    });
    document.querySelector("#auto-restart-setting").addEventListener("change", async (event) => {
      try {
        await api(`/api/servers/${id}/auto-restart`, { method: "PUT", body: { enabled: event.target.checked } });
        state.selected.auto_restart = event.target.checked;
        toast("Automatic restart setting saved.");
      } catch (error) { event.target.checked = !event.target.checked; toast(error.message, "error"); }
    });
  }
}

function closeStream() {
  state.eventSource?.close();
  state.eventSource = null;
}

function attachConsole(id) {
  const output = document.querySelector("#console-output");
  let paused = false;
  let filter = "";
  function paint() {
    const filtered = filter ? state.logs.split("\n").filter((line) => line.toLowerCase().includes(filter)).join("\n") : state.logs;
    output.textContent = filtered;
    if (!paused) output.scrollTop = output.scrollHeight;
  }
  api(`/api/servers/${id}/logs`).then(({ log }) => {
    state.logs = log;
    paint();
  }).catch((error) => toast(error.message, "error"));
  const eventSource = new EventSource(`/api/servers/${encodeURIComponent(id)}/logs?stream=1`);
  state.eventSource = eventSource;
  eventSource.onmessage = (event) => {
    state.logs = (state.logs + JSON.parse(event.data)).slice(-500_000);
    paint();
  };
  eventSource.onerror = () => {
    if (state.selected?.id === id && state.tab === "Console") {
      // EventSource retries automatically; status refresh remains available independently.
    }
  };
  document.querySelector("#console-search").addEventListener("input", (event) => { filter = event.target.value.toLowerCase(); paint(); });
  document.querySelector("#console-pause").addEventListener("click", (event) => { paused = !paused; event.target.textContent = paused ? "Resume scroll" : "Pause scroll"; });
  document.querySelector("#console-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.logs); toast("Console output copied."); }
    catch { toast("Clipboard access is unavailable in this browser.", "error"); }
  });
  document.querySelector("#command-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.querySelector("#command");
    const command = input.value;
    if (!command.trim()) return;
    try { await api(`/api/servers/${id}/command`, { method: "POST", body: { command } }); input.value = ""; }
    catch (error) { toast(error.message, "error"); }
  });
}

async function loadFileDirectory(id) {
  try {
    const files = await api(`/api/servers/${id}/files?path=${encodeURIComponent(state.filePath)}`);
    const list = document.querySelector("#file-list");
    if (!Array.isArray(files)) throw new Error("The selected path is not a directory");
    list.innerHTML = files.length ? files.map((file) => `<div class="file-row"><span>${file.type === "directory" ? "📁" : file.type === "file" ? "▤" : "↗"}</span><span class="file-name" data-file="${escapeHtml(file.name)}" data-type="${file.type}">${escapeHtml(file.name)}</span><small class="muted">${file.type}</small>${file.type === "file" ? `<a class="button small" href="/api/servers/${encodeURIComponent(id)}/download?path=${encodeURIComponent(state.filePath === "." ? file.name : `${state.filePath}/${file.name}`)}">Download</a>` : ""}<button class="button small" data-rename="${escapeHtml(file.name)}">Rename</button><button class="button small danger" data-delete="${escapeHtml(file.name)}">Delete</button></div>`).join("") : '<div class="empty">This directory is empty.</div>';
    document.querySelectorAll("[data-file]").forEach((entry) => entry.addEventListener("click", async () => {
      const child = state.filePath === "." ? entry.dataset.file : `${state.filePath}/${entry.dataset.file}`;
      if (entry.dataset.type === "directory") {
        state.filePath = child; state.selectedFile = null; render();
      } else if (entry.dataset.type === "file") {
        try {
          const file = await api(`/api/servers/${id}/files?path=${encodeURIComponent(child)}`);
          state.selectedFile = child; state.fileContent = file.content; render();
        } catch (error) { toast(error.message, "error"); }
      }
    }));
    document.querySelector("#file-up").addEventListener("click", () => {
      state.filePath = state.filePath === "." ? "." : state.filePath.includes("/") ? state.filePath.slice(0, state.filePath.lastIndexOf("/")) : ".";
      render();
    });
    document.querySelector("#new-file").addEventListener("click", () => createFile("file"));
    document.querySelector("#new-folder").addEventListener("click", () => createFile("directory"));
    document.querySelector("#upload-file").addEventListener("click", () => document.querySelector("#file-upload-input").click());
    document.querySelector("#file-upload-input").addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const relative = state.filePath === "." ? file.name : `${state.filePath}/${file.name}`;
      try {
        const response = await fetch(`/api/servers/${encodeURIComponent(id)}/upload?path=${encodeURIComponent(relative)}`, {
          method: "PUT", credentials: "same-origin", headers: { "x-csrf-token": state.csrf }, body: file,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Upload failed with HTTP ${response.status}`);
        toast(`Uploaded ${file.name}.`); await loadFileDirectory(id);
      } catch (error) { toast(error.message, "error"); }
      event.target.value = "";
    });
    document.querySelectorAll("[data-rename]").forEach((button) => button.addEventListener("click", async () => {
      const oldName = button.dataset.rename;
      const name = prompt("New file or folder name:", oldName);
      if (!name || name === oldName) return;
      const from = state.filePath === "." ? oldName : `${state.filePath}/${oldName}`;
      const to = state.filePath === "." ? name : `${state.filePath}/${name}`;
      try { await api(`/api/servers/${id}/files`, { method: "POST", body: { operation: "move", from, to } }); await loadFileDirectory(id); }
      catch (error) { toast(error.message, "error"); }
    }));
    document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", async () => {
      const name = button.dataset.delete;
      if (!confirm(`Move ${name} to this server's recovery trash?`)) return;
      const relative = state.filePath === "." ? name : `${state.filePath}/${name}`;
      try { await api(`/api/servers/${id}/files`, { method: "POST", body: { operation: "delete", path: relative } }); toast("Item moved to recovery trash."); await loadFileDirectory(id); }
      catch (error) { toast(error.message, "error"); }
    }));
  } catch (error) {
    document.querySelector("#file-list").innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
  }

  async function createFile(type) {
    const name = prompt(type === "file" ? "New file name:" : "New folder name:");
    if (!name) return;
    const relative = state.filePath === "." ? name : `${state.filePath}/${name}`;
    try {
      await api(`/api/servers/${state.selected.id}/files`, { method: "POST", body: { operation: "create", path: relative, type } });
      await loadFileDirectory(state.selected.id);
    } catch (error) { toast(error.message, "error"); }
  }
}

function attachEditor(id) {
  const editor = document.querySelector("#file-editor");
  const highlight = document.querySelector("#file-highlight");
  const preview = highlightedSource(editor.value, state.selectedFile);
  highlight.innerHTML = preview.html;
  editor.addEventListener("input", () => {
    highlight.innerHTML = highlightedSource(editor.value, state.selectedFile).html;
    highlight.parentElement.scrollTop = editor.scrollTop;
    highlight.parentElement.scrollLeft = editor.scrollLeft;
  });
  editor.addEventListener("scroll", () => {
    highlight.parentElement.scrollTop = editor.scrollTop;
    highlight.parentElement.scrollLeft = editor.scrollLeft;
  });
  document.querySelector("#file-back").addEventListener("click", () => { state.selectedFile = null; render(); });
  document.querySelector("#save-file").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      state.fileContent = editor.value;
      await api(`/api/servers/${id}/files`, { method: "PUT", body: { path: state.selectedFile, content: state.fileContent } });
      toast("File saved.");
    } catch (error) { toast(error.message, "error"); }
    event.currentTarget.disabled = false;
  });
}

async function attachBackups(id) {
  const list = document.querySelector("#backup-list");
  try {
    const backups = await api(`/api/servers/${id}/backups`);
    list.innerHTML = backups.length ? backups.map((backup) => `<div class="backup-row"><span class="file-name">${escapeHtml(backup.filename)}</span><small class="muted">${new Date(backup.created_at + "Z").toLocaleString()}</small><a class="button small" href="/api/servers/${encodeURIComponent(id)}/backup-download?backup_id=${encodeURIComponent(backup.id)}">Download</a><button class="button small" data-restore="${escapeHtml(backup.id)}">Restore</button></div>`).join("") : '<div class="empty">No backups yet.</div>';
    document.querySelectorAll("[data-restore]").forEach((button) => button.addEventListener("click", async () => {
      if (!confirm("Restore this backup? The current server directory will be moved aside and replaced. The server must be stopped.")) return;
      try {
        await api(`/api/servers/${id}/restore`, { method: "POST", body: { backup_id: button.dataset.restore } });
        toast("Backup restored.");
        state.selected.installed = true;
      } catch (error) { toast(error.message, "error"); }
    }));
  } catch (error) { list.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; }
  document.querySelector("#create-backup").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const backup = await api(`/api/servers/${id}/backups`, { method: "POST", body: {} });
      toast(`Backup created: ${backup.filename}`);
      await attachBackups(id);
    } catch (error) { toast(error.message, "error"); }
    event.currentTarget.disabled = false;
  });
  try {
    const schedule = await api(`/api/servers/${id}/backup-schedule`);
    if (schedule) {
      document.querySelector("#backup-hours").value = schedule.interval_hours;
      document.querySelector("#backup-retention").value = schedule.retention_count;
      document.querySelector("#backup-enabled").checked = schedule.enabled;
      document.querySelector("#backup-schedule-state").textContent = `Next run: ${new Date(schedule.next_run_at).toLocaleString()}`;
    } else {
      document.querySelector("#backup-schedule-state").textContent = "No scheduled backup configured.";
    }
  } catch (error) { toast(error.message, "error"); }
  document.querySelector("#backup-schedule").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const schedule = await api(`/api/servers/${id}/backup-schedule`, { method: "PUT", body: {
        interval_hours: Number(document.querySelector("#backup-hours").value),
        retention_count: Number(document.querySelector("#backup-retention").value),
        enabled: document.querySelector("#backup-enabled").checked,
      } });
      document.querySelector("#backup-schedule-state").textContent = `Next run: ${new Date(schedule.next_run_at).toLocaleString()}`;
      toast("Backup schedule saved.");
    } catch (error) { toast(error.message, "error"); }
  });
}

async function attachPlayers(id) {
  const list = document.querySelector("#player-list");
  async function refresh() {
    try {
      const response = await api(`/api/servers/${id}/players`);
      list.innerHTML = response.players.length
        ? response.players.map((name) => `<div class="file-row"><span class="file-name">${escapeHtml(name)}</span><button class="button small" data-kick="${escapeHtml(name)}">Kick</button><button class="button small danger" data-ban="${escapeHtml(name)}">Ban</button></div>`).join("")
        : '<div class="empty">The server reports no players online.</div>';
      document.querySelectorAll("[data-kick],[data-ban]").forEach((button) => button.addEventListener("click", async () => {
        const player = button.dataset.kick ?? button.dataset.ban;
        const action = button.dataset.kick ? "kick" : "ban";
        if (!confirm(`${action === "kick" ? "Kick" : "Ban"} ${player}?`)) return;
        const reason = prompt("Reason (optional):") ?? "";
        try {
          await api(`/api/servers/${id}/players`, { method: "POST", body: { action, player, reason } });
          toast(`${action === "kick" ? "Kick" : "Ban"} command sent for ${player}.`);
        } catch (error) { toast(error.message, "error"); }
      }));
    } catch (error) { list.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; }
  }
  document.querySelector("#refresh-players").addEventListener("click", refresh);
  document.querySelector("#player-action-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const player = document.querySelector("#player-name").value;
    const action = document.querySelector("#player-action").value;
    try {
      await api(`/api/servers/${id}/players`, { method: "POST", body: { action, player } });
      toast(`${action} command sent for ${player}.`);
    } catch (error) { toast(error.message, "error"); }
  });
  const permissionEditor = document.querySelector("#permission-editor");
  const permissionFile = document.querySelector("#permission-file");
  const permissionOutput = document.querySelector("#permission-records");
  async function loadPermissionRecords() {
    try {
      const records = await api(`/api/servers/${id}/permissions`);
      permissionOutput.value = JSON.stringify(records[permissionFile.value], null, 2);
      permissionEditor.hidden = false;
    } catch (error) { toast(error.message, "error"); }
  }
  document.querySelector("#view-permissions").addEventListener("click", loadPermissionRecords);
  permissionFile.addEventListener("change", loadPermissionRecords);
  document.querySelector("#save-permissions").addEventListener("click", async () => {
    try {
      const records = JSON.parse(permissionOutput.value);
      const result = await api(`/api/servers/${id}/permissions`, {
        method: "PUT", body: { filename: permissionFile.value, records },
      });
      permissionOutput.value = JSON.stringify(result.records, null, 2);
      toast(`${result.filename} saved.`);
    } catch (error) { toast(error.message, "error"); }
  });
  document.querySelector("#resolve-player-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const output = document.querySelector("#resolved-player");
    output.textContent = "Resolving profile…";
    try {
      const player = document.querySelector("#resolve-player-name").value;
      const profile = await api(`/api/servers/${id}/player-profile?name=${encodeURIComponent(player)}`);
      output.textContent = `${profile.name} · ${profile.uuid} · ${profile.identity_type}${profile.identity_warning ? ` — ${profile.identity_warning}` : ""}`;
    } catch (error) { output.textContent = error.message; }
  });
  if (state.selected.status === "running") await refresh();
  else list.innerHTML = '<div class="empty">Start the server to query its actual online player list.</div>';
}

async function attachProjects(id, type) {
  const installedList = document.querySelector("#installed-projects");
  async function refreshInstalled() {
    const installed = await api(`/api/servers/${id}/projects?type=${type}&installed=1`);
    installedList.innerHTML = installed.length ? installed.map((project) =>
      `<div class="file-row"><span class="file-name">${escapeHtml(project.title ?? project.filename)}<small class="muted">${escapeHtml(project.version_id ?? "Unmanaged")} · ${escapeHtml(project.filename)}</small></span>${project.managed ? `<button class="button small" data-update-project="${escapeHtml(project.project_id)}">Update</button>${project.rollback_available ? `<button class="button small" data-rollback-project="${escapeHtml(project.project_id)}">Roll back</button>` : ""}` : ""}<button class="button small danger" data-remove-project="${escapeHtml(project.filename)}">Remove</button></div>`).join("")
      : '<div class="empty">No plugins installed.</div>';
    document.querySelectorAll("[data-update-project]").forEach((button) => button.addEventListener("click", async () => {
      if (!confirm("Update this project to its latest compatible Modrinth version? Required dependencies must already be compatible.")) return;
      button.disabled = true;
      try {
        const updated = await api(`/api/servers/${id}/projects`, { method: "POST", body: {
          operation: "update", type, project_id: button.dataset.updateProject,
        } });
        toast(`Updated to ${updated.version.version_number}. Previous version is available for rollback.`);
        await refreshInstalled();
      } catch (error) { toast(error.message, "error"); button.disabled = false; }
    }));
    document.querySelectorAll("[data-rollback-project]").forEach((button) => button.addEventListener("click", async () => {
      if (!confirm("Restore the previous managed project version?")) return;
      button.disabled = true;
      try {
        const restored = await api(`/api/servers/${id}/projects`, { method: "POST", body: {
          operation: "rollback", type, project_id: button.dataset.rollbackProject,
        } });
        toast(`Restored version ${restored.version_id}.`);
        await refreshInstalled();
      } catch (error) { toast(error.message, "error"); button.disabled = false; }
    }));
    document.querySelectorAll("[data-remove-project]").forEach((button) => button.addEventListener("click", async () => {
      if (!confirm(`Remove ${button.dataset.removeProject}?`)) return;
      try {
        await api(`/api/servers/${id}/projects`, { method: "POST", body: { operation: "remove", type, filename: button.dataset.removeProject } });
        toast("Plugin removed."); await refreshInstalled();
      } catch (error) { toast(error.message, "error"); }
    }));
  }
  try { await refreshInstalled(); }
  catch (error) { installedList.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; }
  document.querySelector("#project-search").addEventListener("submit", async (event) => {
    event.preventDefault();
    const results = document.querySelector("#project-results");
    results.textContent = "Searching Modrinth…";
    try {
      const query = document.querySelector("#project-query").value;
      const source = document.querySelector("#project-source")?.value ?? "modrinth";
      results.textContent = `Searching ${source === "curseforge" ? "CurseForge" : "Modrinth"}…`;
      const data = await api(`/api/servers/${id}/projects?source=${source}&type=${type}&query=${encodeURIComponent(query)}`);
      results.innerHTML = data.hits.length ? data.hits.map((project) =>
        `<div class="file-row"><span class="file-name">${escapeHtml(project.title)}<small class="muted">${Number(project.downloads).toLocaleString()} downloads · ${escapeHtml(project.author)}</small></span><button class="button small" data-load-versions="${escapeHtml(project.id)}">Choose version</button></div>`).join("")
        : '<div class="empty">No compatible projects found.</div>';
      document.querySelectorAll("[data-load-versions]").forEach((button) => button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const projectId = button.dataset.loadVersions;
          const source = document.querySelector("#project-source")?.value ?? "modrinth";
          const versions = await api(`/api/servers/${id}/project-versions?source=${source}&type=${type}&project_id=${encodeURIComponent(projectId)}`);
          const row = button.closest(".file-row");
          if (!versions.length) throw new Error("No compatible versions found for this project.");
          const select = document.createElement("select");
          select.className = "input";
          select.setAttribute("aria-label", "Compatible project version");
          select.innerHTML = versions.map((version) =>
            `<option value="${escapeHtml(version.id)}">${escapeHtml(version.name)} (${escapeHtml(version.version_number)})</option>`).join("");
          const installButton = document.createElement("button");
          installButton.className = "button small primary";
          installButton.textContent = "Install";
          installButton.addEventListener("click", async () => {
            if (!confirm(`Install this ${source === "curseforge" ? "CurseForge file" : "Modrinth version and any required compatible dependencies"}?`)) return;
            installButton.disabled = true;
            try {
              const installed = await api(`/api/servers/${id}/projects`, { method: "POST", body: {
                operation: "install", type, source, project_id: projectId, version_id: select.value,
              } });
              toast(`Installed ${installed.filename}${installed.dependencies.length ? ` with ${installed.dependencies.length} required dependencies` : ""}.`);
              await refreshInstalled();
            } catch (error) { toast(error.message, "error"); installButton.disabled = false; }
          });
          row.append(select, installButton);
          button.remove();
        } catch (error) { toast(error.message, "error"); button.disabled = false; }
      }));
    } catch (error) { results.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; }
  });
}

function attachModpacks(id) {
  document.querySelector("#modpack-search").addEventListener("submit", async (event) => {
    event.preventDefault();
    const results = document.querySelector("#modpack-results");
    results.textContent = "Searching CurseForge…";
    try {
      const query = document.querySelector("#modpack-query").value;
      const data = await api(`/api/servers/${id}/modpacks?query=${encodeURIComponent(query)}`);
      results.innerHTML = data.hits.length ? data.hits.map((pack) =>
        `<div class="file-row"><span class="file-name">${escapeHtml(pack.title)}<small class="muted">${Number(pack.downloads).toLocaleString()} downloads · ${escapeHtml(pack.author)} · ${escapeHtml(pack.description)}</small></span><button class="button small" data-pack-versions="${escapeHtml(pack.id)}">Choose version</button></div>`).join("")
        : '<div class="empty">No matching modpacks found for this Minecraft version.</div>';
      document.querySelectorAll("[data-pack-versions]").forEach((button) => button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const projectId = button.dataset.packVersions;
          const versions = await api(`/api/servers/${id}/modpack-versions?project_id=${encodeURIComponent(projectId)}`);
          const row = button.closest(".file-row");
          if (!versions.length) throw new Error("No compatible modpack files are available.");
          const select = document.createElement("select");
          select.className = "input";
          select.setAttribute("aria-label", "Compatible CurseForge modpack file");
          select.innerHTML = versions.map((version) =>
            `<option value="${escapeHtml(version.id)}">${escapeHtml(version.name)} (${escapeHtml(version.version_number)})</option>`).join("");
          const installButton = document.createElement("button");
          installButton.className = "button small primary";
          installButton.textContent = "Install";
          installButton.disabled = ["running", "starting", "stopping"].includes(state.selected.status);
          installButton.addEventListener("click", async () => {
            if (!confirm("Install this modpack's required files and supported configuration overrides? Existing files will not be overwritten. The server must be stopped.")) return;
            installButton.disabled = true;
            try {
              const installed = await api(`/api/servers/${id}/modpacks`, { method: "POST", body: {
                project_id: projectId, file_id: select.value,
              } });
              const skipped = installed.skipped_overrides ? ` ${installed.skipped_overrides} client-only or unsupported override file(s) were skipped.` : "";
              toast(`Installed ${installed.title} (${installed.loader}, Minecraft ${installed.minecraft_version}).${skipped}`);
              await refreshSilently();
            } catch (error) {
              toast(error.message, "error");
              installButton.disabled = false;
            }
          });
          row.append(select, installButton);
          button.remove();
        } catch (error) { toast(error.message, "error"); button.disabled = false; }
      }));
    } catch (error) {
      results.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
  });
}

async function attachWorlds(id) {
  const list = document.querySelector("#world-list");
  try {
    async function refreshWorlds() {
      const worlds = await api(`/api/servers/${id}/worlds`);
      list.innerHTML = worlds.length ? worlds.map((world) => `<div class="file-row"><span class="file-name">${escapeHtml(world.name)}<small class="muted">${(world.size_bytes / 1024 / 1024).toFixed(1)} MB</small></span><button class="button small" data-open-world="${escapeHtml(world.path)}">Browse</button><button class="button small" data-backup-world="${escapeHtml(world.name)}" ${["running", "starting", "stopping"].includes(state.selected.status) ? "disabled" : ""}>Stopped backup</button><button class="button small" data-snapshot-world="${escapeHtml(world.name)}" ${state.selected.status !== "running" ? "disabled" : ""}>Live snapshot</button></div>`).join("") : '<div class="empty">No Minecraft world folders found yet.</div>';
      document.querySelectorAll("[data-open-world]").forEach((button) => button.addEventListener("click", () => {
        state.filePath = button.dataset.openWorld; state.tab = "Files"; render();
      }));
      document.querySelectorAll("[data-backup-world]").forEach((button) => button.addEventListener("click", async () => {
        if (!confirm(`Create a consistent backup of ${button.dataset.backupWorld}? The server must be stopped.`)) return;
        button.disabled = true;
        try {
          await api(`/api/servers/${id}/worlds`, { method: "POST", body: { operation: "backup", world_name: button.dataset.backupWorld } });
          toast("World backup created.");
          await refreshWorldBackups();
        } catch (error) { toast(error.message, "error"); button.disabled = false; }
      }));
      document.querySelectorAll("[data-snapshot-world]").forEach((button) => button.addEventListener("click", async () => {
        if (!confirm(`Snapshot ${button.dataset.snapshotWorld} now? The server will flush its world, briefly pause automatic saves, and re-enable saving after the archive is captured.`)) return;
        button.disabled = true;
        try {
          await api(`/api/servers/${id}/worlds`, {
            method: "POST", body: { operation: "snapshot", world_name: button.dataset.snapshotWorld },
          });
          toast("Live world snapshot completed and automatic saving was re-enabled.");
          await refreshWorldBackups();
        } catch (error) { toast(error.message, "error"); button.disabled = false; }
      }));
    }
    async function refreshWorldBackups() {
      const container = document.querySelector("#world-backup-list");
      const backups = await api(`/api/servers/${id}/world-backups`);
      container.innerHTML = backups.length ? backups.map((backup) =>
        `<div class="file-row"><span class="file-name">${escapeHtml(backup.world_name)}<small class="muted">${escapeHtml(backup.created_at)}</small></span><button class="button small" data-download-world-backup="${escapeHtml(backup.id)}">Export</button><button class="button small danger" data-restore-world-backup="${escapeHtml(backup.id)}">Restore</button></div>`).join("")
        : '<div class="empty">No world backups yet.</div>';
      document.querySelectorAll("[data-download-world-backup]").forEach((button) => button.addEventListener("click", async () => {
        try {
          const response = await fetch(`/api/servers/${id}/world-backup-download?backup_id=${encodeURIComponent(button.dataset.downloadWorldBackup)}`, { credentials: "same-origin" });
          if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
          const disposition = response.headers.get("content-disposition") ?? "";
          const filename = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
          const anchor = document.createElement("a");
          anchor.href = URL.createObjectURL(await response.blob());
          anchor.download = filename ? decodeURIComponent(filename) : "world.tar.gz";
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
        } catch (error) { toast(error.message, "error"); }
      }));
      document.querySelectorAll("[data-restore-world-backup]").forEach((button) => button.addEventListener("click", async () => {
        if (!confirm("Restore this backup over the current world? The current world will be replaced.")) return;
        button.disabled = true;
        try {
          await api(`/api/servers/${id}/world-backups`, {
            method: "POST", body: { operation: "restore", backup_id: button.dataset.restoreWorldBackup },
          });
          toast("World restored from backup.");
          await refreshWorlds();
          await refreshWorldBackups();
        } catch (error) { toast(error.message, "error"); button.disabled = false; }
      }));
    }
    await refreshWorlds();
    await refreshWorldBackups();
    document.querySelector("#world-import-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = document.querySelector("#world-import-file").files[0];
      const worldName = document.querySelector("#world-import-name").value;
      if (!file || !confirm(`Import ${file.name} as ${worldName}? This replaces that world if it already exists.`)) return;
      const archivePath = `.panel-import-${crypto.randomUUID()}.tar.gz`;
      const submit = event.currentTarget.querySelector("button");
      submit.disabled = true;
      try {
        const uploaded = await fetch(`/api/servers/${id}/upload?path=${encodeURIComponent(archivePath)}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/gzip", "x-csrf-token": state.csrf },
          body: file,
        });
        if (!uploaded.ok) {
          const error = await uploaded.json();
          throw new Error(error.error ?? `Upload failed with HTTP ${uploaded.status}`);
        }
        await api(`/api/servers/${id}/worlds`, {
          method: "POST", body: { operation: "import", archive_path: archivePath, world_name: worldName },
        });
        toast("World imported. The validated source archive is kept as a downloadable world backup.");
        event.currentTarget.reset();
        await refreshWorlds();
        await refreshWorldBackups();
      } catch (error) { toast(error.message, "error"); }
      finally { submit.disabled = false; }
    });
  } catch (error) { list.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; }
}

function attachSettings(id) {
  document.querySelector("#accept-eula").addEventListener("click", showEula);
  document.querySelector("#install-server").addEventListener("click", async (event) => {
    if (!confirm("Download the selected server software from its official source and verify its checksum?")) return;
    const installButton = event.currentTarget;
    installButton.disabled = true;
    installButton.textContent = "Installing…";
    let cancelButton;
    try {
      const task = await api(`/api/servers/${id}/install`, { method: "POST", body: {} });
      cancelButton = document.createElement("button");
      cancelButton.className = "button danger";
      cancelButton.textContent = "Cancel installation";
      event.currentTarget.after(cancelButton);
      cancelButton.addEventListener("click", async () => {
        cancelButton.disabled = true;
        try { await api(`/api/jobs/${encodeURIComponent(task.id)}/cancel`, { method: "POST", body: {} }); }
        catch (error) { toast(error.message, "error"); cancelButton.disabled = false; }
      });
      const result = await waitForJob(task.id, (job) => {
        installButton.textContent = `${job.message}${job.progress ? ` · ${job.progress}%` : ""}`;
      });
      state.selected.installed = true;
      toast(result.message);
      render();
    } catch (error) {
      toast(error.message === "Installation cancelled." ? error.message : `Installation failed: ${error.message}`, "error");
      installButton.disabled = false;
      installButton.textContent = "Retry installation";
    } finally {
      cancelButton?.remove();
    }
  });
  document.querySelector("#delete-server").addEventListener("click", async () => {
    if (!confirm(`Permanently delete ${state.selected.name}, its server directory, and all backup archives? Create and preserve a backup elsewhere first if needed.`)) return;
    try {
      await api(`/api/servers/${id}`, { method: "DELETE" });
      closeStream(); state.selected = null; await refreshServers(); render(); toast("Server and its files deleted.");
    } catch (error) { toast(error.message, "error"); }
  });
}

async function waitForJob(id, onUpdate) {
  while (true) {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (job.status === "completed") return job;
    if (job.status === "cancelled") throw new Error("Installation cancelled.");
    if (["failed", "interrupted"].includes(job.status)) throw new Error(job.error ?? job.message);
    onUpdate?.(job);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function showEula() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<form class="modal" id="eula-form"><div class="modal-head"><div><h2>Minecraft End User License Agreement</h2><p>Read the official agreement before accepting.</p></div><button type="button" class="icon-button" id="close-modal">×</button></div>
    <div class="notice">The Minecraft server software is provided under the Minecraft EULA. Read it at <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">https://aka.ms/MinecraftEULA</a>. This action writes <span class="mono">eula=true</span> in this server's directory.</div>
    <label class="checkbox-row"><input type="checkbox" id="eula-check" required>I have read and agree to the Minecraft EULA for this server.</label>
    <div class="modal-actions"><button class="button" type="button" id="cancel-modal">Cancel</button><button class="button primary">Accept EULA</button></div></form>`;
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  document.querySelector("#close-modal").addEventListener("click", close);
  document.querySelector("#cancel-modal").addEventListener("click", close);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  document.querySelector("#eula-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(`/api/servers/${state.selected.id}/eula`, { method: "POST", body: { accepted: true } });
      state.selected.eula_accepted = true;
      close(); render(); toast("EULA acceptance recorded.");
    } catch (error) { toast(error.message, "error"); }
  });
}

function showCreateWizard() {
  const defaults = { name: "", id: "", description: "", version: "", software: "paper", port: 25565, bind_address: "0.0.0.0", max_players: 20, min_memory_mb: 1024, max_memory_mb: 2048, java_path: "java", online_mode: true, view_distance: 10, simulation_distance: 10 };
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const versions = [
    ...state.versions.map((entry) => ({ ...entry, bedrock: false })),
    ...state.bedrockVersions.map((entry) => ({ ...entry, paper: false, purpur: false, fabric: false,
      quilt: false, forge: false, neoforge: false, bedrock: true })),
  ];
  backdrop.innerHTML = `<form class="modal" id="create-form"><div class="modal-head"><div><h2>Create a server</h2><p>Each instance gets its own directory, port, config, world, and process.</p></div><button type="button" class="icon-button" id="close-modal">×</button></div>
    <div class="form-grid">
      <div class="field"><label for="server-name">Server name</label><input class="input" id="server-name" required maxlength="64" placeholder="My Survival Server"></div>
      <div class="field"><label for="server-id">Unique identifier</label><input class="input mono" id="server-id" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="48" placeholder="my-survival-server"></div>
      <div class="field"><label for="server-version">Minecraft version</label><select class="input" id="server-version" required ${versions.length ? "" : "disabled"}>${versions.map((entry) => {
        if (entry.bedrock) return `<option value="${escapeHtml(entry.id)}" data-type="bedrock" data-bedrock="true">${escapeHtml(entry.id)} · Official Bedrock release</option>`;
        const kind = entry.type === "release" ? "Stable release" : /(?:-pre|-rc)/i.test(entry.id) ? "Pre-release" : "Snapshot";
        return `<option value="${escapeHtml(entry.id)}" data-type="${entry.type}" data-bedrock="false" data-paper="${entry.paper}" data-purpur="${entry.purpur}" data-fabric="${entry.fabric}" data-quilt="${entry.quilt}" data-forge="${entry.forge}" data-neoforge="${entry.neoforge}">${escapeHtml(entry.id)} · ${kind}${entry.paper ? " · Paper" : ""}${entry.purpur ? " · Purpur" : ""}${entry.fabric ? " · Fabric" : ""}${entry.quilt ? " · Quilt" : ""}${entry.forge ? " · Forge" : ""}${entry.neoforge ? " · NeoForge" : ""}</option>`;
      }).join("")}</select></div>
      <div class="field"><label for="server-software">Server software</label><select class="input" id="server-software"><option value="paper">Paper — optimized plugins-capable Java server</option><option value="purpur">Purpur — Paper-compatible Java server with additional gameplay options</option><option value="fabric">Fabric — lightweight Java mod loader</option><option value="quilt">Quilt — community Java mod loader based on Fabric</option><option value="forge">Forge — widely used Java mod loader</option><option value="neoforge">NeoForge — community Java mod loader</option><option value="vanilla">Vanilla — official Java server</option><option value="bedrock">Bedrock Dedicated Server — native Linux server</option></select></div>
      <div class="field"><label for="server-port" id="server-port-label">Java server port (TCP)</label><input class="input" id="server-port" type="number" min="1024" max="65535" value="25565" required></div>
      <div class="field" id="crossplay-option"><label class="checkbox-row"><input id="server-crossplay" type="checkbox"> Enable Bedrock cross-play (automatically install Geyser + Floodgate)</label><small class="muted">Paper/Purpur only. Java keeps its TCP port; Bedrock uses a separate UDP port.</small></div>
      <div class="field" id="bedrock-port-field" hidden><label for="server-bedrock-port">Bedrock cross-play port (UDP)</label><input class="input" id="server-bedrock-port" type="number" min="1024" max="65534" value="19132"></div>
      <div class="field"><label for="server-bind">Bind address</label><select class="input" id="server-bind"><option value="0.0.0.0">All interfaces (LAN/public)</option><option value="127.0.0.1">This computer only</option></select></div>
      <div class="field" id="minimum-memory-field"><label for="server-min-memory">Initial heap (MB)</label><input class="input" id="server-min-memory" type="number" min="512" value="1024" required></div>
      <div class="field" id="maximum-memory-field"><label for="server-max-memory">Maximum heap (MB)</label><input class="input" id="server-max-memory" type="number" min="512" value="2048" required></div>
      <div class="field"><label for="server-players">Maximum players</label><input class="input" id="server-players" type="number" min="1" max="1000" value="20" required></div>
      <div class="field"><label for="server-view-distance">View distance (chunks)</label><input class="input" id="server-view-distance" type="number" min="2" max="32" value="10" required></div>
      <div class="field"><label for="server-simulation-distance">Simulation distance (chunks)</label><input class="input" id="server-simulation-distance" type="number" min="2" max="32" value="10" required></div>
      <label class="checkbox-row"><input id="server-online-mode" type="checkbox" checked> Require authenticated Minecraft accounts (online mode)</label>
      <div class="field" id="java-runtime-field"><label for="server-java">Java executable</label><input class="input mono" id="server-java" list="java-runtimes" value="java" required><datalist id="java-runtimes"></datalist><small class="muted" id="java-requirement">Checking the selected Minecraft version's Java requirement…</small></div>
    </div>
    <div class="field"><label for="server-description">Description (optional)</label><input class="input" id="server-description" maxlength="500"></div>
    <div class="notice warning">Bedrock Dedicated Server is a separate native Linux x86_64 server with UDP networking and no Java requirement. Its official archive does not publish a checksum; the panel restricts downloads to the official HTTPS host and validates ZIP integrity. Java/Bedrock cross-play uses Paper/Purpur plus SHA-256-verified Geyser and Floodgate plugins. Bedrock users connect to the separate UDP port; Java users keep the TCP port. Java runtime installation is not provided.</div>
    <div class="modal-actions"><button class="button" type="button" id="cancel-modal">Cancel</button><button class="button primary" type="submit" ${versions.length && versions.some((version) => version.paper) ? "" : "disabled"}>Create server</button></div></form>`;
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  document.querySelector("#close-modal").addEventListener("click", close);
  document.querySelector("#cancel-modal").addEventListener("click", close);
  document.querySelector("#server-name").addEventListener("input", (event) => {
    const id = document.querySelector("#server-id");
    if (!id.dataset.edited) id.value = event.target.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  });
  document.querySelector("#server-id").addEventListener("input", (event) => { event.target.dataset.edited = "1"; });
  const softwareSelect = document.querySelector("#server-software");
  const crossplayCheckbox = document.querySelector("#server-crossplay");
  const updateSoftwareChoices = () => {
    const software = softwareSelect.value;
    const version = document.querySelector("#server-version");
    const isBedrock = software === "bedrock";
    const crossplayAllowed = software === "paper" || software === "purpur";
    const supported = (option) => isBedrock
      ? option.dataset.bedrock === "true"
      : option.dataset.bedrock !== "true" &&
        (software === "vanilla" || (option.dataset.type === "release" && option.dataset[software] === "true"));
    [...version.options].forEach((option) => { option.disabled = !supported(option); });
    if (version.selectedOptions[0]?.disabled) version.value = [...version.options].find((option) => !option.disabled)?.value ?? "";
    version.disabled = ![...version.options].some(supported);
    document.querySelector('#create-form button[type="submit"]').disabled = version.disabled;
    document.querySelector("#java-runtime-field").hidden = isBedrock;
    document.querySelector("#server-java").required = !isBedrock;
    document.querySelector("#minimum-memory-field").hidden = isBedrock;
    document.querySelector("#maximum-memory-field").hidden = isBedrock;
    document.querySelector("#crossplay-option").hidden = !crossplayAllowed;
    if (!crossplayAllowed) crossplayCheckbox.checked = false;
    const crossplay = crossplayAllowed && crossplayCheckbox.checked;
    document.querySelector("#bedrock-port-field").hidden = !crossplay;
    document.querySelector("#server-bedrock-port").required = crossplay;
    document.querySelector("#server-port-label").textContent = isBedrock ? "Bedrock server port (UDP)" : "Java server port (TCP)";
    const portInput = document.querySelector("#server-port");
    if (isBedrock && portInput.value === "25565") portInput.value = "19132";
    else if (!isBedrock && portInput.value === "19132") portInput.value = "25565";
    updateJavaRequirement();
  };
  softwareSelect.addEventListener("change", updateSoftwareChoices);
  crossplayCheckbox.addEventListener("change", updateSoftwareChoices);
  document.querySelector("#server-version").addEventListener("change", updateJavaRequirement);
  updateSoftwareChoices();
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  updateJavaRequirement();
  if (softwareSelect.value !== "bedrock") {
    api("/api/java").then(({ runtimes }) => {
      const datalist = document.querySelector("#java-runtimes");
      if (datalist) datalist.innerHTML = runtimes.map((runtime) => `<option value="${escapeHtml(runtime)}"></option>`).join("");
    }).catch((error) => toast(`Could not detect Java runtimes: ${error.message}`, "error"));
  }
  document.querySelector("#create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = (id) => document.querySelector(`#${id}`).value;
    const config = {
      ...defaults, name: value("server-name"), id: value("server-id"), description: value("server-description"),
      version: value("server-version"), software: value("server-software"), port: Number(value("server-port")),
      crossplay: crossplayCheckbox.checked,
      bedrock_port: crossplayCheckbox.checked ? Number(value("server-bedrock-port")) : null,
      bind_address: value("server-bind"), min_memory_mb: Number(value("server-min-memory")),
      max_memory_mb: Number(value("server-max-memory")), max_players: Number(value("server-players")), java_path: value("server-java"),
      online_mode: document.querySelector("#server-online-mode").checked,
      view_distance: Number(value("server-view-distance")), simulation_distance: Number(value("server-simulation-distance")),
    };
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const created = await api("/api/servers", { method: "POST", body: config });
      close(); await refreshServers(); await openServer(created.id); toast("Server instance created. Install its software in Settings.");
    } catch (error) { toast(error.message, "error"); submit.disabled = false; }
  });
}

async function updateJavaRequirement() {
  const version = document.querySelector("#server-version")?.value;
  const label = document.querySelector("#java-requirement");
  if (!version || !label) return;
  if (document.querySelector("#server-software")?.value === "bedrock") {
    label.textContent = "Bedrock Dedicated Server runs as a native Linux executable and does not require Java.";
    return;
  }
  label.textContent = "Checking Minecraft metadata…";
  try {
    const info = await api(`/api/java?version=${encodeURIComponent(version)}`);
    if (document.querySelector("#server-version")?.value !== version) return;
    label.textContent = `Minecraft ${version} requires Java ${info.required_major} or newer. ${info.runtimes.length ? `${info.runtimes.length} executable(s) found on PATH; choose a path or enter another.` : "No Java executable found on PATH; installation is not provided by this panel."}`;
  } catch (error) {
    label.textContent = `Java requirement could not be checked: ${error.message}`;
  }
}

function render() {
  if (state.selected) renderDetail();
  else renderDashboard();
}

boot();
