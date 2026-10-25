const state = {
  servers: [],
  events: [],
  versions: [],
  javaRuntimes: [],
  backups: [],
  tasks: [],
  schedules: [],
  metrics: {},
  currentPage: 'overview',
  serverPageId: null,
  hasLoadedServers: false,
  consoleServerId: null,
  consoleLogInterval: null,
  refreshInterval: null,
  authMode: 'login',
  adminServerId: null,
  manageTab: 'overview',
  fileDirectory: '',
  selectedFile: ''
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const MODDED_SOFTWARE = new Set(['fabric', 'forge', 'neoforge', 'quilt']);
const PLUGIN_SOFTWARE = new Set(['paper', 'purpur']);
const managementTemplate = $('#server-management-template');
$('#server-page-sections').append(
  ...[...managementTemplate.content.querySelectorAll('.manage-panel')].map((panel) => panel.cloneNode(true))
);
managementTemplate.remove();

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const trashIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M8 5.5V3.7h4v1.8m-6.5 0 .8 11h7.4l.8-11M8.3 8.2v5.5m3.4-5.5v5.5"/></svg>';

function supportsContent(server, type) {
  if (type === 'mod') return MODDED_SOFTWARE.has(server?.software);
  if (type === 'plugin') return PLUGIN_SOFTWARE.has(server?.software);
  return type === 'modpack' && MODDED_SOFTWARE.has(server?.software);
}

function contentCompatibilityMessage(server, type) {
  if (!server) return 'Install a server before searching for content.';
  if (type === 'modpack') {
    return 'Modpacks must include files compatible with this server software and Minecraft version.';
  }
  if (type === 'mod' && supportsContent(server, type)) {
    return `${server.software} mods for Minecraft ${server.minecraftVersion} are available to browse.`;
  }
  if (type === 'plugin' && supportsContent(server, type)) {
    return `${server.software} plugins for Minecraft ${server.minecraftVersion} are available to browse.`;
  }
  if (type === 'mod') {
    return `${server.software} does not load mods. Mods require Fabric, Forge, NeoForge, or Quilt.`;
  }
  if (type === 'plugin') {
    return `${server.software} does not load plugins. Plugins require Paper or Purpur.`;
  }
  const supportsMods = supportsContent(server, 'mod');
  const supportsPlugins = supportsContent(server, 'plugin');
  if (supportsMods) return `${server.software} supports mods, not Paper/Purpur plugins.`;
  if (supportsPlugins) return `${server.software} supports plugins, not Fabric/Forge/NeoForge/Quilt mods.`;
  return `${server.software} does not load mods or plugins.`;
}

function updateModrinthCompatibility() {
  const server = state.servers.find((item) => item.id === $('#modrinth-server').value);
  const typeSelect = $('#modrinth-type');
  for (const option of typeSelect.options) {
    option.hidden = !supportsContent(server, option.value);
  }
  if (typeSelect.selectedOptions[0]?.hidden) {
    typeSelect.value = ['mod', 'plugin', 'modpack'].find((type) => supportsContent(server, type)) ?? '';
  }
  $('#modrinth-compatibility').textContent = server
    ? typeSelect.value
      ? contentCompatibilityMessage(server, typeSelect.value)
      : `${server.software} has no supported Modrinth content types.`
    : 'Install a server before searching for content.';
  $('#modrinth-search-form button[type="submit"]').disabled = !server || !typeSelect.value;
}

function handleModrinthSelectionChange() {
  updateModrinthCompatibility();
  $('#modrinth-results').replaceChildren();
}

function updateManagedContentCompatibility() {
  const server = state.servers.find((item) => item.id === state.adminServerId);
  for (const form of $$('.manage-search-form')) {
    const type = form.dataset.manageSearch;
    const supported = supportsContent(server, type);
    form.closest('.manage-panel').hidden = !supported;
    $(`[data-server-section="${type === 'mod' ? 'mods' : 'plugins'}"]`).hidden = !supported;
    if (!supported) {
      const targetId = type === 'mod' ? 'manage-mod-results' : 'manage-plugin-results';
      $(`#${targetId}`).replaceChildren();
    }
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status}).`);
  return data;
}

async function boot() {
  try {
    const status = await api('/api/auth/status');
    if (status.authenticated) {
      $('#app-shell').hidden = false;
      await refresh();
      void loadVersions();
      state.refreshInterval = setInterval(() => void refresh(), 5000);
      return;
    }
    showAuthScreen(status.configured ? 'login' : 'setup');
  } catch (error) {
    showAuthScreen('login', `Unable to check authentication: ${error.message}`);
  }
}

function showAuthScreen(mode, message = '') {
  state.authMode = mode;
  $('#auth-screen').hidden = false;
  $('#app-shell').hidden = true;
  const setup = mode === 'setup';
  $('#auth-title').textContent = setup ? 'Set administrator password' : 'Sign in';
  $('#auth-description').textContent = setup
    ? 'Use the one-time token printed in the panel startup terminal, then choose a strong password.'
    : 'Enter the administrator password to continue.';
  $('#setup-token-field').classList.toggle('hidden', !setup);
  $('#auth-confirm-field').classList.toggle('hidden', !setup);
  $('#auth-password-field input').autocomplete = setup ? 'new-password' : 'current-password';
  $('#auth-password-field input').value = '';
  $('#auth-error').textContent = message;
  $('#auth-error').classList.toggle('hidden', !message);
  $('#auth-submit').textContent = setup ? 'Set password' : 'Sign in';
  $('#auth-form').elements.password.required = true;
  $('#auth-form').elements.token.required = setup;
  $('#auth-form').elements.confirmPassword.required = setup;
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), 4200);
}

function bytes(value) {
  if (value == null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function elapsed(seconds) {
  if (!seconds) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function relativeTime(value) {
  if (!value) return 'Never';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function statusLabel(server) {
  if (!server.installed) return 'Not installed';
  if (server.status === 'orphaned') return 'Running · panel disconnected';
  if (server.status === 'unknown') return 'Process state unknown';
  return server.status.charAt(0).toUpperCase() + server.status.slice(1);
}

function serverCard(server) {
  const statusClass = server.installed ? server.status : 'not-installed';
  const mainAction = server.status === 'unknown'
      ? `<button class="button button-secondary button-small" data-action="confirm-stopped" data-id="${escapeHtml(server.id)}">Confirm stopped</button>`
    : !server.installed
      ? `<button class="button button-primary button-small" data-action="install" data-id="${escapeHtml(server.id)}">Install</button>`
    : server.status === 'orphaned'
      ? `<button class="button button-secondary button-small" data-action="stop" data-id="${escapeHtml(server.id)}">Stop process</button>`
    : server.status === 'running' || server.status === 'starting'
      ? `<button class="button button-secondary button-small" data-action="stop" data-id="${escapeHtml(server.id)}">Stop</button>`
      : `<button class="button button-primary button-small" data-action="start" data-id="${escapeHtml(server.id)}">Start</button>`;
  const forceStopAction = server.installed && ['running', 'starting', 'orphaned'].includes(server.status)
    ? `<button class="button button-danger button-small" data-action="force-stop" data-id="${escapeHtml(server.id)}">Force stop</button>`
    : '';
  return `<article class="server-card">
    <div class="server-card-top"><div class="server-ident"><span class="server-icon" aria-hidden="true">▣</span><div><h3>${escapeHtml(server.name)}</h3><small>${escapeHtml(server.software)} · ${escapeHtml(server.minecraftVersion)}</small></div></div><span class="status-pill ${escapeHtml(statusClass)}">${escapeHtml(statusLabel(server))}</span></div>
    <div class="server-stats"><div class="server-stat"><strong>${escapeHtml(server.players == null ? '—' : server.players)}</strong><small>PLAYERS</small></div><div class="server-stat"><strong>${escapeHtml(server.status === 'running' ? elapsed(server.uptimeSeconds) : '—')}</strong><small>UPTIME</small></div><div class="server-stat" title="${escapeHtml(server.diskError ?? 'Disk usage')}"><strong>${escapeHtml(bytes(server.diskBytes))}</strong><small>DISK</small></div></div>
    <div class="card-bottom"><span class="muted">Port ${escapeHtml(server.port)}</span><div class="card-actions">${mainAction}${forceStopAction}${server.installed ? `<button class="button button-secondary button-small" data-action="manage" data-id="${escapeHtml(server.id)}">Manage</button>` : ''}${server.installed && ['stopped', 'crashed'].includes(server.status) ? `<button class="icon-button" data-action="backup" data-id="${escapeHtml(server.id)}" title="Create backup" aria-label="Create backup">▧</button>` : ''}<button class="delete-server-button" data-action="delete" data-id="${escapeHtml(server.id)}" title="Delete server" aria-label="Delete ${escapeHtml(server.name)}">${trashIcon}</button></div></div>
  </article>`;
}

function emptyState(title, description, button = '') {
  return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">▤</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p>${button}</div>`;
}

function eventMarkup(event) {
  const time = event.created_at ?? event.createdAt;
  return `<div class="event-item"><span class="event-indicator ${escapeHtml(event.kind)}"></span><span class="event-message">${escapeHtml(event.message)}</span><span class="event-meta">${event.server_name ? `<span class="event-server">${escapeHtml(event.server_name)}</span>` : ''}<time datetime="${escapeHtml(time)}">${escapeHtml(relativeTime(time))}</time></span></div>`;
}

async function refresh() {
  try {
    const previousTasks = new Map(state.tasks.map((task) => [task.id, task.status]));
    const [servers, events, backups, tasks, schedules] = await Promise.all([
      api('/api/servers'), api('/api/events'), api('/api/backups'), api('/api/tasks'), api('/api/schedules')
    ]);
    state.servers = servers;
    state.hasLoadedServers = true;
    state.events = events;
    state.backups = backups;
    state.tasks = tasks;
    state.schedules = schedules;
    const metricEntries = await Promise.all(servers.map(async (server) => [
      server.id,
      await api(`/api/servers/${server.id}/metrics?limit=60`)
    ]));
    state.metrics = Object.fromEntries(metricEntries);
    $('#load-error').classList.add('hidden');
    render();
    updateManagedInstallButtons(tasks);
    const contentInstallFinished = tasks.some((task) =>
      ['content-install', 'modpack-install'].includes(task.type)
      && task.serverId === state.adminServerId
      && ['completed', 'failed', 'cancelled'].includes(task.status)
      && ['queued', 'running', 'cancelling'].includes(previousTasks.get(task.id))
    );
    if (contentInstallFinished && state.currentPage === 'server'
        && ['mods', 'plugins'].includes(state.manageTab)) {
      const type = state.manageTab === 'mods' ? 'mod' : 'plugin';
      await loadManagedContent(type === 'mod' ? 'mods' : 'plugins', type === 'mod' ? 'manage-mod-files' : 'manage-plugin-files');
    }
  } catch (error) {
    $('#load-error').textContent = `Unable to load panel data: ${error.message}`;
    $('#load-error').classList.remove('hidden');
  }
}

function updateManagedInstallButtons(tasks) {
  for (const button of $$('[data-manage-modrinth-install][data-install-task]')) {
    const task = tasks.find((item) => item.id === button.dataset.installTask);
    if (!task) continue;
    if (task.status === 'completed') {
      button.dataset.uninstallContent = button.dataset.installPath;
      button.textContent = 'Uninstall';
      delete button.dataset.installTask;
      delete button.dataset.installPath;
      const server = state.servers.find((item) => item.id === state.adminServerId);
      button.disabled = !server || !['stopped', 'crashed'].includes(server.status);
    } else if (['failed', 'cancelled'].includes(task.status)) {
      button.textContent = 'Install latest compatible';
      delete button.dataset.installTask;
      delete button.dataset.installPath;
      button.disabled = false;
    }
  }
}

function render() {
  const running = state.servers.filter((server) => server.status === 'running').length;
  const starting = state.servers.filter((server) => server.status === 'starting').length;
  const stopped = state.servers.filter((server) => server.status === 'stopped').length;
  const attention = state.servers.filter((server) => ['crashed', 'orphaned', 'unknown'].includes(server.status)).length;
  const diskBytes = state.servers.reduce((sum, server) => sum + (server.diskBytes ?? 0), 0);
  const diskUnavailable = state.servers.some((server) => server.diskBytes === null);
  $('#stat-total').textContent = state.servers.length;
  $('#task-list').innerHTML = state.tasks.filter((task) => ['queued', 'running', 'cancelling'].includes(task.status)).map((task) => `
    <article class="task-card">
      <div class="task-card-top"><strong>${escapeHtml(task.type)} · ${escapeHtml(task.message)}</strong><span>${escapeHtml(task.status)}${task.status === 'running' ? ` · ${escapeHtml(task.progress)}%` : ''}</span></div>
      <div class="task-progress"><span style="width:${Math.min(100, Math.max(0, task.progress))}%"></span></div>
      ${task.status === 'queued' || task.status === 'running' ? `<button class="button button-secondary button-small" data-action="cancel-task" data-id="${escapeHtml(task.id)}">Cancel</button>` : ''}
    </article>`).join('');
  $('#stat-running').textContent = running;
  $('#stat-starting').textContent = starting;
  $('#stat-stopped').textContent = stopped;
  $('#stat-attention').textContent = attention;
  $('#stat-disk').textContent = diskUnavailable ? 'Unavailable' : bytes(diskBytes);
  $('#nav-server-count').textContent = state.servers.length;
  $('#server-grid').innerHTML = state.servers.length
    ? state.servers.slice(0, 4).map(serverCard).join('')
    : emptyState('No servers yet', 'Create an instance to get started. Your first server is configured locally and installed only when you ask.', '<button class="button button-primary button-small" type="button" data-create>＋ Create your first server</button>');
  renderServerList();
  $('#overview-events').innerHTML = state.events.length ? state.events.slice(0, 5).map(eventMarkup).join('') : emptyState('No activity yet', 'Server and panel events will appear here.');
  $('#activity-list').innerHTML = state.events.length ? state.events.map(eventMarkup).join('') : emptyState('Nothing to show', 'Events will be recorded as you manage your servers.');
  $('#backup-list').innerHTML = state.backups.length ? state.backups.map(backupMarkup).join('') : emptyState('No backups yet', 'Stop a server and create a local snapshot from its server card.');
  $('#schedule-server').innerHTML = state.servers.map((server) => `<option value="${escapeHtml(server.id)}">${escapeHtml(server.name)}</option>`).join('')
    || '<option value="">Create a server first</option>';
  const contentServers = state.servers.filter((server) => server.installed);
  const previousContentServer = $('#modrinth-server').value;
  $('#modrinth-server').innerHTML = contentServers.map((server) =>
    `<option value="${escapeHtml(server.id)}">${escapeHtml(server.name)} · ${escapeHtml(server.software)} · ${escapeHtml(server.minecraftVersion)}</option>`
  ).join('') || '<option value="">Install a server first</option>';
  if (contentServers.some((server) => server.id === previousContentServer)) {
    $('#modrinth-server').value = previousContentServer;
  }
  if ($('#modrinth-server').value !== previousContentServer) {
    $('#modrinth-results').replaceChildren();
  }
  updateModrinthCompatibility();
  $('#schedule-list').innerHTML = state.schedules.length ? state.schedules.map((schedule) => {
    const server = state.servers.find((item) => item.id === schedule.serverId);
    return `<article class="backup-row"><div class="backup-meta"><strong>${escapeHtml(server?.name ?? 'Deleted server')} · ${escapeHtml(schedule.action)}</strong><small>Every ${escapeHtml(schedule.intervalMinutes)} minutes · Next ${escapeHtml(new Date(schedule.nextRunAt).toLocaleString())}${schedule.lastRunAt ? ` · Last ${escapeHtml(new Date(schedule.lastRunAt).toLocaleString())}` : ''}</small></div><button class="button button-danger button-small" data-action="delete-schedule" data-id="${escapeHtml(schedule.id)}">Delete</button></article>`;
  }).join('') : emptyState('No schedules configured', 'Add a recurring backup or server lifecycle action.');
  const metricRows = state.servers.flatMap((server) => (state.metrics[server.id] ?? []).slice(-12).reverse().map((metric) =>
    `<div class="event-item"><span class="event-indicator info"></span><span class="event-message">${escapeHtml(server.name)}</span><span class="event-meta"><span>${escapeHtml(metric.cpuPercent == null ? '—' : `${metric.cpuPercent.toFixed(1)}% CPU`)} · ${escapeHtml(metric.memoryBytes == null ? '—' : bytes(metric.memoryBytes))} RAM · ${escapeHtml(bytes(metric.diskBytes))} disk</span><time>${escapeHtml(new Date(metric.capturedAt).toLocaleString())}</time></span></div>`
  ));
  $('#metrics-list').innerHTML = metricRows.length ? metricRows.slice(0, 36).join('') : emptyState('No metrics yet', 'Resource samples will appear after the first collection.');
  $('#scheduler-metrics-list').innerHTML = metricRows.length ? metricRows.join('') : emptyState('No metrics available', 'Metrics are sampled once per minute while the panel is running.');
  showPage(location.hash.slice(1) || 'overview');
}

function renderServerList() {
  const search = $('#server-search').value.trim().toLowerCase();
  const filter = $('#server-filter').value;
  const servers = state.servers.filter((server) =>
    (!search || `${server.name} ${server.minecraftVersion} ${server.software}`.toLowerCase().includes(search)) &&
    (filter === 'all' || server.status === filter)
  );
  $('#server-list').innerHTML = servers.length ? servers.map((server) => {
    const isActive = ['running', 'starting', 'orphaned'].includes(server.status);
    const primaryAction = server.status === 'unknown'
        ? `<button class="button button-secondary button-small" data-action="confirm-stopped" data-id="${escapeHtml(server.id)}">Confirm stopped</button>`
      : !server.installed
        ? `<button class="button button-primary button-small" data-action="install" data-id="${escapeHtml(server.id)}">Install</button>`
      : `<button class="button button-secondary button-small" data-action="${isActive ? 'stop' : 'start'}" data-id="${escapeHtml(server.id)}">${server.status === 'orphaned' ? 'Stop process' : isActive ? 'Stop' : 'Start'}</button>`;
    const forceStopAction = server.installed && isActive
      ? `<button class="button button-danger button-small" data-action="force-stop" data-id="${escapeHtml(server.id)}">Force stop</button>`
      : '';
    return `<article class="server-row"><div class="server-ident"><span class="server-icon" aria-hidden="true">▣</span><div><h3>${escapeHtml(server.name)}</h3><small>${escapeHtml(server.software)} · ${escapeHtml(server.minecraftVersion)} · Port ${escapeHtml(server.port)}</small></div></div><div class="card-actions"><span class="status-pill ${escapeHtml(server.installed ? server.status : 'not-installed')}">${escapeHtml(statusLabel(server))}</span>${primaryAction}${forceStopAction}${server.installed ? `<button class="button button-secondary button-small" data-action="manage" data-id="${escapeHtml(server.id)}">Manage</button>` : ''}<button class="delete-server-button" data-action="delete" data-id="${escapeHtml(server.id)}" title="Delete server" aria-label="Delete ${escapeHtml(server.name)}">${trashIcon}</button></div></article>`;
  }).join('')
    : emptyState(search || filter !== 'all' ? 'No matching servers' : 'No server instances', 'Adjust the filter or create a server to see it here.', search || filter !== 'all' ? '' : '<button class="button button-primary button-small" type="button" data-create>＋ Create server</button>');
}

async function searchModrinth() {
  const results = $('#modrinth-results');
  const server = state.servers.find((item) => item.id === $('#modrinth-server').value);
  if (!server) {
    results.innerHTML = emptyState('No compatible server selected', 'Install a server before searching for content.');
    return;
  }
  const type = $('#modrinth-type').value;
  if (!supportsContent(server, type)) {
    results.innerHTML = emptyState('Unavailable for this server', contentCompatibilityMessage(server, type));
    return;
  }
  const params = new URLSearchParams({
    query: $('#modrinth-query').value.trim(),
    type,
    gameVersion: server.minecraftVersion
  });
  if (type === 'mod' && ['fabric', 'forge', 'neoforge', 'quilt'].includes(server.software)) {
    params.set('loader', server.software);
  }
  if (type === 'plugin' && PLUGIN_SOFTWARE.has(server.software)) {
    params.set('loader', server.software);
  }
  results.innerHTML = '<div class="empty-state"><strong>Searching Modrinth…</strong></div>';
  try {
    const data = await api(`/api/modrinth/search?${params}`);
    results.innerHTML = data.hits.map((hit) => `
      <article class="version-row">
        <div class="version-meta"><strong>${escapeHtml(hit.title)}</strong><small>${escapeHtml(hit.description)} · ${escapeHtml(hit.downloads)} downloads</small></div>
        <span class="tag">${escapeHtml(hit.projectType)}</span>
        <button class="button button-secondary button-small" data-modrinth-install data-project="${escapeHtml(hit.projectId)}" data-type="${escapeHtml(type)}">Install latest compatible</button>
      </article>`).join('') || emptyState('No matching projects', `No ${type} projects matched Minecraft ${server.minecraftVersion}.`);
    if (data.total > data.hits.length) {
      results.insertAdjacentHTML('beforeend', `<small class="muted">Showing ${data.hits.length} of ${data.total} results.</small>`);
    }
  } catch (error) {
    results.innerHTML = `<div class="notice notice-error">Modrinth search failed: ${escapeHtml(error.message)}</div>`;
  }
}

async function installLatestModrinth(button) {
  const server = state.servers.find((item) => item.id === $('#modrinth-server').value);
  return installModrinthProject(button, server);
}

async function installModrinthProject(button, server) {
  if (!server) return;
  const type = button.dataset.type;
  if (!supportsContent(server, type)) {
    toast(contentCompatibilityMessage(server, type), 'error');
    return;
  }
  const params = new URLSearchParams({ type, gameVersion: server.minecraftVersion });
  if (['mod', 'modpack'].includes(type) && ['fabric', 'forge', 'neoforge', 'quilt'].includes(server.software)) {
    params.set('loader', server.software);
  }
  if (type === 'plugin' && PLUGIN_SOFTWARE.has(server.software)) {
    params.set('loader', server.software);
  }
  button.disabled = true;
  try {
    const versions = await api(`/api/modrinth/projects/${encodeURIComponent(button.dataset.project)}/versions?${params}`);
    const compatible = versions.find((version) => version.gameVersions.includes(server.minecraftVersion));
    if (!compatible) throw new Error('No compatible Modrinth version was found for this server.');
    const folder = type === 'plugin' ? 'plugins' : 'mods';
    const file = compatible.files.find((candidate) => candidate.primary) ?? compatible.files[0];
    const contentPath = ['mod', 'plugin'].includes(type) && file ? `${folder}/${file.filename}` : '';
    if (button.matches('[data-manage-modrinth-install]') && contentPath) {
      const installed = await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(folder)}`);
      if (installed.some((entry) => entry.type === 'file' && entry.name === file.filename)) {
        button.dataset.uninstallContent = contentPath;
        button.textContent = 'Uninstall';
        button.disabled = !['stopped', 'crashed'].includes(server.status);
        return;
      }
    }
    if (!confirm(`Install ${type} ${compatible.name || compatible.versionNumber} on ${server.name}? The content will be hash-verified and written only inside this server directory.`)) return;
    const task = await api(`/api/servers/${server.id}/content`, {
      method: 'POST',
      body: JSON.stringify({ contentType: type, versionId: compatible.id, confirmed: true })
    });
    if (button.matches('[data-manage-modrinth-install]') && contentPath) {
      button.dataset.installTask = task.id;
      button.dataset.installPath = contentPath;
      button.textContent = 'Installing…';
    }
    toast(`${type} installation queued (${task.id.slice(0, 8)}).`);
    await refresh();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (!button.dataset.installTask) {
      button.disabled = button.dataset.uninstallContent
        ? !['stopped', 'crashed'].includes(server.status)
        : false;
    }
  }
}

function backupMarkup(backup) {
  const server = state.servers.find((item) => item.id === backup.server_id);
  const label = !backup.available ? 'Missing files' : server ? 'Available' : 'Server removed';
  return `<article class="backup-row"><div class="backup-meta"><strong>${escapeHtml(server?.name ?? backup.server_id ?? 'Deleted server')}</strong><small>${escapeHtml(new Date(backup.created_at).toLocaleString())} · ${escapeHtml(bytes(backup.size_bytes))} · ${backup.archive ? `Compressed archive · SHA-256 ${escapeHtml(backup.integrity)}` : 'Legacy directory snapshot'}</small></div><span class="tag">${label}</span>${backup.available && backup.archive ? `<button class="button button-secondary button-small" data-action="download-backup" data-id="${escapeHtml(backup.id)}">Download</button>` : ''}${server && backup.available ? `<button class="button button-secondary button-small" data-action="restore" data-id="${escapeHtml(server.id)}" data-backup="${escapeHtml(backup.id)}">Restore</button>` : ''}<button class="button button-danger button-small" data-action="delete-backup" data-id="${escapeHtml(backup.id)}">Delete</button></article>`;
}

function showPage(route) {
  const [page, serverId, requestedSection] = route.split('/');
  const serverRoute = page === 'server' && serverId;
  const knownPages = new Set(['overview', 'servers', 'catalog', 'backups', 'scheduler', 'activity']);
  if (!serverRoute && !knownPages.has(page)) route = 'overview';

  if (serverRoute) {
    let section = ['overview', 'files', 'mods', 'plugins', 'worlds', 'players', 'console', 'logs'].includes(requestedSection)
      ? requestedSection
      : 'overview';
    const server = state.servers.find((item) => item.id === serverId);
    if (!server && state.hasLoadedServers) {
      location.hash = 'servers';
      return;
    }
    if (server && ((section === 'mods' && !supportsContent(server, 'mod'))
        || (section === 'plugins' && !supportsContent(server, 'plugin')))) {
      section = 'overview';
      location.hash = `server/${encodeURIComponent(serverId)}/overview`;
    }
    const serverChanged = state.serverPageId !== serverId;
    state.currentPage = 'server';
    state.serverPageId = serverId;
    state.adminServerId = serverId;
    state.consoleServerId = serverId;
    $('#workspace-navigation').hidden = true;
    $('#server-navigation').classList.remove('hidden');
    $('#server-navigation-name').textContent = server?.name ?? 'Loading server…';
    $('#admin-title').textContent = server ? `${server.name} · ${section[0].toUpperCase()}${section.slice(1)}` : 'Loading server…';
    $('#server-page-description').textContent = server
      ? `${server.software} · Minecraft ${server.minecraftVersion} · Port ${server.port}`
      : 'Loading server details…';
    $('#server-page-status').textContent = server ? statusLabel(server) : 'Loading';
    $('#server-page-status').className = `status-pill ${server?.installed ? server.status : 'not-installed'}`;
    $('#console-status').textContent = server && ['running', 'orphaned'].includes(server.status)
      ? 'Connected to the server process.'
      : 'The server is stopped. Start it to send commands; existing logs remain available.';
    const actionButton = $('#server-page-action');
    actionButton.dataset.action = !server?.installed
      ? 'install'
      : server.status === 'running' || server.status === 'starting' || server.status === 'orphaned'
        ? 'stop'
        : server.status === 'unknown' ? 'confirm-stopped' : 'start';
    actionButton.dataset.id = serverId;
    actionButton.textContent = !server?.installed
      ? 'Install server'
      : server.status === 'running' || server.status === 'starting' || server.status === 'orphaned'
        ? 'Stop server'
        : server.status === 'unknown' ? 'Confirm stopped' : 'Start server';
    actionButton.disabled = !server;
    $('#server-page-backup').dataset.action = 'backup';
    $('#server-page-backup').dataset.id = serverId;
    $('#server-page-backup').hidden = !server?.installed || !['stopped', 'crashed'].includes(server.status);
    $('#server-detail-version').textContent = server?.minecraftVersion ?? '—';
    $('#server-detail-software').textContent = server?.software ?? '—';
    $('#server-detail-players').textContent = server?.players == null ? '—' : server.players;
    $('#server-detail-uptime').textContent = server?.status === 'running' ? elapsed(server.uptimeSeconds) : '—';
    $('#server-detail-disk').textContent = server ? bytes(server.diskBytes) : '—';
    $('#server-detail-port').textContent = server?.port ?? '—';
    $('#server-detail-memory').textContent = server ? `${server.memoryMb} MB` : '—';
    $('#server-detail-events').innerHTML = state.events
      .filter((event) => event.server_id === serverId || event.serverId === serverId)
      .slice(0, 8)
      .map(eventMarkup)
      .join('') || emptyState('No server activity yet', 'Events for this server will appear here.');
    for (const link of $$('[data-server-section]')) {
      const active = link.dataset.serverSection === section;
      link.href = `#server/${encodeURIComponent(serverId)}/${link.dataset.serverSection}`;
      if (link.dataset.serverSection === 'mods') link.hidden = !supportsContent(server, 'mod');
      if (link.dataset.serverSection === 'plugins') link.hidden = !supportsContent(server, 'plugin');
      link.classList.toggle('active', active);
    }
    $('#breadcrumb-current').textContent = `${server?.name ?? 'Server'} · ${section[0].toUpperCase()}${section.slice(1)}`;
    if (server && (serverChanged || state.manageTab !== section)) {
      void activateManageTab(section);
    } else if (!server) {
      state.manageTab = '';
      for (const panel of $$('.manage-panel')) {
        const active = panel.id === (section === 'overview' ? 'server-page-overview' : `manage-${section}`);
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      }
    }
    if (server && (section === 'console' || section === 'logs')) {
      if (!state.consoleLogInterval) state.consoleLogInterval = setInterval(() => void refreshConsole(), 2000);
    } else {
      clearInterval(state.consoleLogInterval);
      state.consoleLogInterval = null;
    }
    for (const item of $$('.page')) item.classList.toggle('active', item.id === 'page-server');
    return;
  }

  state.currentPage = page;
  state.serverPageId = null;
  state.adminServerId = null;
  state.consoleServerId = null;
  clearInterval(state.consoleLogInterval);
  state.consoleLogInterval = null;
  $('#workspace-navigation').hidden = false;
  $('#server-navigation').classList.add('hidden');
  for (const item of $$('.page')) item.classList.toggle('active', item.id === `page-${page}`);
  for (const item of $$('.nav-item[data-page]')) item.classList.toggle('active', item.dataset.page === page);
  $('#breadcrumb-current').textContent = $(`.nav-item[data-page="${page}"]`)?.title ?? 'Overview';
  if (page === 'catalog' && state.versions.length === 0) void loadVersions();
}

function navigateToServerSection(section) {
  if (!state.serverPageId) return;
  const route = `server/${encodeURIComponent(state.serverPageId)}/${section}`;
  if (location.hash.slice(1) === route) {
    void activateManageTab(section);
  } else {
    location.hash = route;
  }
}

async function loadJavaRuntimes() {
  const select = $('#java-runtime-select');
  select.innerHTML = '<option value="">Discovering Java runtimes…</option>';
  try {
    state.javaRuntimes = await api('/api/java');
    select.innerHTML = '<option value="">Choose a detected runtime (or enter a path below)</option>'
      + state.javaRuntimes.map((runtime) => `<option value="${escapeHtml(runtime.path)}">Java ${escapeHtml(runtime.majorVersion)} (${escapeHtml(runtime.version)}) · ${escapeHtml(runtime.path)}</option>`).join('');
    $('#java-runtime-hint').textContent = state.javaRuntimes.length
      ? `${state.javaRuntimes.length} executable runtime${state.javaRuntimes.length === 1 ? '' : 's'} detected. The selected runtime must meet the version requirement.`
      : 'No Java runtimes detected. Enter an existing executable path; the panel will not install Java.';
  } catch (error) {
    select.innerHTML = '<option value="">Runtime discovery unavailable</option>';
    $('#java-runtime-hint').textContent = `Could not discover Java runtimes: ${error.message}`;
  }
  updateVersionHint();
}

async function updateVersionHint() {
  const hint = $('#version-hint');
  const version = $('#create-version').value.trim();
  if (!version) {
    hint.textContent = 'Enter a version identifier; Java requirements are checked against Mojang metadata.';
    return;
  }
  hint.textContent = 'Checking Minecraft Java requirement…';
  try {
    const info = await api(`/api/versions/${encodeURIComponent(version)}`);
    if (!info.requiredJavaMajor) {
      hint.textContent = `Mojang does not specify a Java requirement for ${info.id}; installation will be blocked unless compatibility can be determined.`;
      return;
    }
    const selectedPath = $('#java-path').value;
    const runtime = state.javaRuntimes.find((item) => item.path === selectedPath);
    hint.textContent = runtime
      ? `Minecraft ${info.id} requires Java ${info.requiredJavaMajor} or newer. Selected Java ${runtime.majorVersion} ${runtime.majorVersion >= info.requiredJavaMajor ? 'is compatible.' : 'is too old.'}`
      : `Minecraft ${info.id} requires Java ${info.requiredJavaMajor} or newer. The selected executable will be verified before installation and start.`;
  } catch (error) {
    hint.textContent = `Could not verify the Java requirement: ${error.message}`;
  }
}

async function updateProviderCatalogHint() {
  const software = $('#create-software').value;
  const version = $('#create-version').value.trim();
  const hint = $('#provider-catalog-hint');
  if (software === 'vanilla' || !version) {
    hint.textContent = 'Loaders and server jars are resolved from their official catalogs.';
    return;
  }
  hint.textContent = `Checking the official ${software} catalog…`;
  try {
    const catalog = await api(`/api/providers/${encodeURIComponent(software)}/catalog?minecraftVersion=${encodeURIComponent(version)}`);
    const compatible = catalog.minecraftVersions?.includes(version) || catalog.versions?.includes(version);
    const stableLoader = catalog.loaders?.find((item) => item.stable) ?? catalog.loaders?.[0];
    const detail = stableLoader ? ` Latest stable loader: ${stableLoader.version}.` : '';
    hint.textContent = compatible
      ? `${software} lists Minecraft ${version} as compatible.${detail} The newest stable build is selected during installation.`
      : `${software} does not list Minecraft ${version} as compatible. It remains selectable; installation will be attempted and may fail if the provider has no build.`;
  } catch (error) {
    hint.textContent = `Could not check ${software} compatibility. The version remains selectable; installation will be attempted and may fail. (${error.message})`;
  }
}

async function loadVersions() {
  const list = $('#version-list');
  list.innerHTML = '<div class="empty-state"><strong>Loading official version metadata…</strong><p>Contacting the Mojang version catalogue.</p></div>';
  try {
    state.versions = await api('/api/versions');
    renderVersions();
  } catch (error) {
    list.innerHTML = `<div class="notice notice-error">Could not load versions: ${escapeHtml(error.message)}. Refresh the catalogue to select an available server version.</div>`;
    $('#create-version').innerHTML = `<option value="">Could not load versions: ${escapeHtml(error.message)}</option>`;
    $('#create-version').disabled = true;
    $('#create-form button[type="submit"]').disabled = true;
  }
}

function renderVersions() {
  const search = $('#version-search').value.trim().toLowerCase();
  const filtered = state.versions.filter((version) => `${version.id} ${version.type}`.toLowerCase().includes(search));
  $('#version-count').textContent = `${filtered.length} versions`;
  $('#version-list').innerHTML = filtered.map((version) => `
    <div class="version-row"><div class="version-meta"><strong>${escapeHtml(version.id)}</strong><small>Released ${escapeHtml(new Date(version.releaseTime).toLocaleDateString())}</small></div><span class="tag">${escapeHtml(version.type)}</span><button class="button button-secondary button-small" data-select-version="${escapeHtml(version.id)}">Use version</button></div>`).join('')
    || emptyState('No matching versions', 'Try a different version number or search.');
  const versionSelect = $('#create-version');
  const previousVersion = versionSelect.value;
  versionSelect.innerHTML = state.versions.map((version) =>
    `<option value="${escapeHtml(version.id)}">${escapeHtml(version.id)} · ${escapeHtml(version.type)}</option>`
  ).join('');
  versionSelect.value = state.versions.some((version) => version.id === previousVersion)
    ? previousVersion
    : (state.versions.find((version) => version.id === '1.21.8')
      ?? state.versions.find((version) => version.type === 'release')
      ?? state.versions[0]).id;
  versionSelect.disabled = false;
  $('#create-form button[type="submit"]').disabled = false;
}

async function createServer(form) {
  const submit = form.querySelector('button[type="submit"]');
  const errorBox = $('#create-error');
  errorBox.classList.add('hidden');
  submit.disabled = true;
  submit.textContent = 'Creating…';
  const input = Object.fromEntries(new FormData(form));
  input.memoryMb = Number(input.memoryMb);
  input.port = Number(input.port);
  try {
    const server = await api('/api/servers', { method: 'POST', body: JSON.stringify(input) });
    $('#create-dialog').close();
    form.reset();
    form.elements.name.value = '';
    form.elements.minecraftVersion.value = state.versions[0]?.id ?? '1.21.8';
    toast(`${server.name} was created. Review and start its installation when ready.`);
    await refresh();
    showPage('servers');
    location.hash = 'servers';
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Create instance';
  }
}

async function runAction(action, id, backupId = null) {
  if (action === 'cancel-task') {
    try {
      await api(`/api/tasks/${id}/cancel`, { method: 'POST', body: '{}' });
      toast('Cancellation requested.');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (action === 'delete-schedule') {
    try {
      if (!confirm('Delete this recurring schedule?')) return;
      await api(`/api/schedules/${id}`, { method: 'DELETE' });
      toast('Schedule deleted.');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (action === 'download-backup') {
    location.href = `/api/backups/${id}/download`;
    return;
  }
  if (action === 'delete-backup') {
    try {
      if (!confirm('Permanently delete this backup archive?')) return;
      await api(`/api/backups/${id}`, { method: 'DELETE' });
      toast('Backup deleted.');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  const server = state.servers.find((item) => item.id === id);
  if (!server) return;
  try {
    if (action === 'delete') {
      if (!confirm(`Delete "${server.name}" and permanently remove its server files? This cannot be undone. Existing snapshots will be retained.`)) return;
      await api(`/api/servers/${id}/delete`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
      toast(`${server.name} and its server files were deleted.`);
    } else if (action === 'install') {
      if (!confirm(`Review installation for "${server.name}":\n\n${server.software} Minecraft ${server.minecraftVersion}\nJava executable: ${server.javaPath}\nMaximum heap: ${server.memoryMb} MB\nServer port: ${server.port}\n\nThe server software will be resolved from its official provider catalog, checksum-verified, and installed inside its isolated instance directory. No Java runtime or system software will be installed. Continue?`)) return;
      const task = await api(`/api/servers/${id}/install`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
      toast(`Installation task queued for ${server.name} (${task.id.slice(0, 8)}).`);
    } else if (action === 'start') {
      const acceptEula = !server.eulaAccepted && confirm('Minecraft requires you to agree to its EULA before starting a server. By continuing, you confirm you have read and accepted https://aka.ms/MinecraftEULA. Start the server?');
      if (!server.eulaAccepted && !acceptEula) return;
      await api(`/api/servers/${id}/start`, { method: 'POST', body: JSON.stringify({ acceptEula }) });
      toast(`Start requested for ${server.name}.`);
    } else if (action === 'stop') {
      if (server.status !== 'running' && !confirm(`The server is ${server.status}. Request a graceful stop?`)) return;
      await api(`/api/servers/${id}/stop`, { method: 'POST', body: '{}' });
      toast(`Graceful shutdown requested for ${server.name}.`);
    } else if (action === 'force-stop') {
      if (!confirm(`Force-stop "${server.name}"? The server will not be able to save its world; unsaved changes may be lost.`)) return;
      await api(`/api/servers/${id}/force-stop`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
      toast(`Forced termination requested for ${server.name}.`);
    } else if (action === 'confirm-stopped') {
      if (!confirm(`The panel cannot verify the previous process for "${server.name}". Check your system process list first. Confirm only if you have verified that this server is not running.`)) return;
      await api(`/api/servers/${id}/confirm-stopped`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
      toast(`${server.name} is marked stopped. You can now start it.`);
    } else if (action === 'backup') {
      const task = await api(`/api/servers/${id}/backups`, { method: 'POST', body: '{}' });
      toast(`Backup task queued for ${server.name} (${task.id.slice(0, 8)}).`);
    } else if (action === 'restore') {
      if (!confirm(`Restore this backup into "${server.name}"? Its current server files will be replaced.`)) return;
      const task = await api(`/api/servers/${id}/restore/${backupId}`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
      toast(`Restore task queued for ${server.name} (${task.id.slice(0, 8)}).`);
    } else if (action === 'console') {
      openConsole(server);
    } else if (action === 'manage') {
      openAdmin(server);
    }
    await refresh();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function openConsole(server) {
  await openAdmin(server, 'console');
}

async function openAdmin(server, tab = 'overview') {
  clearInterval(state.consoleLogInterval);
  state.consoleLogInterval = null;
  state.adminServerId = server.id;
  state.consoleServerId = server.id;
  state.fileDirectory = '';
  state.selectedFile = '';
  state.manageTab = '';
  $('#file-editor').value = '';
  $('#file-editor').disabled = true;
  $('#file-save').disabled = true;
  $('#file-delete').disabled = true;
  $('#console-output').textContent = 'Loading recent server output…';
  $('#console-status').textContent = ['running', 'orphaned'].includes(server.status)
    ? 'Connected to the server process.'
    : 'The server is stopped. Start it to send commands; existing logs remain available.';
  location.hash = `server/${encodeURIComponent(server.id)}/${tab}`;
}

async function activateManageTab(tab) {
  const allowed = new Set(['overview', 'files', 'mods', 'plugins', 'worlds', 'players', 'console', 'logs']);
  if (!allowed.has(tab)) tab = 'files';
  state.manageTab = tab;
  updateManagedContentCompatibility();
  for (const link of $$('[data-server-section]')) {
    link.classList.toggle('active', link.dataset.serverSection === tab);
  }
  for (const panel of $$('.manage-panel')) {
    const active = panel.id === (tab === 'overview' ? 'server-page-overview' : `manage-${tab}`);
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  }
  if (tab === 'files') await loadFileList();
  if (tab === 'mods') await loadManagedContent('mods', 'manage-mod-files');
  if (tab === 'plugins') await loadManagedContent('plugins', 'manage-plugin-files');
  if (tab === 'worlds') await loadWorldList();
  if (tab === 'console' || tab === 'logs') await refreshConsole();
}

async function loadFileList() {
  if (!state.adminServerId) return;
  $('#file-path-label').textContent = state.fileDirectory ? `/${state.fileDirectory}` : '/';
  $('#file-up').disabled = !state.fileDirectory;
  $('#file-list').innerHTML = '<small>Loading files…</small>';
  try {
    const files = await api(`/api/servers/${state.adminServerId}/files?path=${encodeURIComponent(state.fileDirectory)}`);
    $('#file-list').innerHTML = files.map((entry) => {
      const safe = entry.safeName && ['file', 'directory'].includes(entry.type);
      return `<button class="file-entry" type="button" data-file-name="${escapeHtml(entry.name)}" data-file-type="${escapeHtml(entry.type)}" ${safe ? '' : 'disabled'}><span>${entry.type === 'directory' ? '▸' : entry.type === 'file' ? '▤' : '⚠'}</span><span>${escapeHtml(entry.name)}</span><small>${entry.type === 'file' ? escapeHtml(bytes(entry.size)) : escapeHtml(entry.type)}</small></button>`;
    }).join('') || '<small>This directory is empty.</small>';
  } catch (error) {
    $('#file-list').textContent = error.message;
  }
}

async function loadManagedContent(directory, targetId) {
  const target = $(`#${targetId}`);
  target.innerHTML = '<small>Loading…</small>';
  try {
    const files = await api(`/api/servers/${state.adminServerId}/files?path=${encodeURIComponent(directory)}`);
    const server = state.servers.find((item) => item.id === state.adminServerId);
    const canUninstall = server && ['stopped', 'crashed'].includes(server.status);
    target.innerHTML = files.length
      ? files.map((entry) => {
        const contentPath = `${directory}/${entry.name}`;
        const action = entry.type === 'file' && entry.safeName
          ? `<button class="button button-danger button-small" type="button" data-uninstall-content="${escapeHtml(contentPath)}" ${canUninstall ? '' : 'disabled'}>${entry.name.toLowerCase().endsWith('.jar') ? 'Uninstall' : 'Remove file'}</button>`
          : '';
        return `<div class="file-entry file-entry-static"><span>${entry.type === 'directory' ? '▸' : '▤'}</span><span>${escapeHtml(entry.name)}</span><small>${entry.type === 'file' ? escapeHtml(bytes(entry.size)) : escapeHtml(entry.type)}</small>${action}</div>`;
      }).join('')
      : '<div class="file-empty">No files found in this folder.</div>';
  } catch (error) {
    target.innerHTML = error.message.includes('not found') || error.message.includes('does not exist')
      ? '<div class="file-empty">This folder has not been created yet. It will appear after a mod or plugin is installed.</div>'
      : `<div class="notice notice-error">${escapeHtml(error.message)}</div>`;
  }
}

async function uninstallManagedContent(filename, button = null) {
  const directory = state.manageTab === 'mods' ? 'mods' : state.manageTab === 'plugins' ? 'plugins' : '';
  const server = state.servers.find((item) => item.id === state.adminServerId);
  if (!directory || !server || !filename.startsWith(`${directory}/`)) return;
  if (!['stopped', 'crashed'].includes(server.status)) {
    toast('Stop the server before uninstalling content.', 'error');
    return;
  }
  if (!confirm(`Uninstall ${filename.slice(directory.length + 1)} from ${server.name}?`)) return;
  try {
    await api(`/api/servers/${server.id}/file?path=${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (button) {
      delete button.dataset.uninstallContent;
      button.textContent = 'Install latest compatible';
    }
    toast('Content uninstalled.');
    await loadManagedContent(directory, directory === 'mods' ? 'manage-mod-files' : 'manage-plugin-files');
    await refresh();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function searchManageContent(type, query, target) {
  const server = state.servers.find((item) => item.id === state.adminServerId);
  if (!server) return;
  if (!supportsContent(server, type)) {
    target.innerHTML = emptyState('Unavailable for this server', contentCompatibilityMessage(server, type));
    return;
  }
  const params = new URLSearchParams({
    query,
    type,
    gameVersion: server.minecraftVersion
  });
  if (type === 'mod' && ['fabric', 'forge', 'neoforge', 'quilt'].includes(server.software)) {
    params.set('loader', server.software);
  }
  if (type === 'plugin' && ['paper', 'purpur'].includes(server.software)) {
    params.set('loader', server.software);
  }
  target.innerHTML = '<div class="empty-state"><strong>Searching Modrinth…</strong></div>';
  try {
    const data = await api(`/api/modrinth/search?${params}`);
    target.innerHTML = data.hits.map((hit) => `
      <article class="version-row">
        <div class="version-meta"><strong>${escapeHtml(hit.title)}</strong><small>${escapeHtml(hit.description)} · ${escapeHtml(hit.downloads)} downloads</small></div>
        <button class="button button-secondary button-small" data-manage-modrinth-install data-project="${escapeHtml(hit.projectId)}" data-type="${escapeHtml(type)}">Install latest compatible</button>
      </article>`).join('') || emptyState('No matching projects', `No ${type} projects matched Minecraft ${server.minecraftVersion}.`);
  } catch (error) {
    target.innerHTML = `<div class="notice notice-error">Modrinth search failed: ${escapeHtml(error.message)}</div>`;
  }
}

async function loadWorldList() {
  const target = $('#world-list');
  target.innerHTML = '<small>Detecting world folders…</small>';
  try {
    const [rootFiles, properties] = await Promise.all([
      api(`/api/servers/${state.adminServerId}/files`),
      api(`/api/servers/${state.adminServerId}/file?path=server.properties`).catch(() => null)
    ]);
    const configuredName = properties?.content.match(/^level-name=(.+)$/m)?.[1]?.trim();
    const candidates = rootFiles.filter((entry) => entry.type === 'directory' && entry.safeName)
      .slice(0, 40);
    const contents = await Promise.all(candidates.map(async (entry) => {
      const files = await api(`/api/servers/${state.adminServerId}/files?path=${encodeURIComponent(entry.name)}`).catch(() => []);
      return { ...entry, world: files.some((file) => file.name === 'level.dat') };
    }));
    const worlds = contents.filter((entry) => entry.world || entry.name === configuredName);
    target.innerHTML = worlds.length
      ? worlds.map((world) => `<article class="server-row"><div><strong>${escapeHtml(world.name)}</strong><small class="world-meta">${world.name === configuredName ? 'Configured level' : 'Detected world data'}</small></div><button class="button button-secondary button-small" type="button" data-open-world="${escapeHtml(world.name)}">Browse files</button></article>`).join('')
      : emptyState('No world folders found', 'Worlds are created when the server starts for the first time.');
  } catch (error) {
    target.innerHTML = `<div class="notice notice-error">${escapeHtml(error.message)}</div>`;
  }
}

async function openManagedFile(filename) {
  state.selectedFile = state.fileDirectory ? `${state.fileDirectory}/${filename}` : filename;
  try {
    const file = await api(`/api/servers/${state.adminServerId}/file?path=${encodeURIComponent(state.selectedFile)}`);
    $('#file-editor').value = file.content;
    $('#file-editor').disabled = false;
    $('#file-save').disabled = false;
    $('#file-delete').disabled = false;
  } catch (error) {
    state.selectedFile = '';
    $('#file-editor').value = '';
    $('#file-editor').disabled = true;
    $('#file-save').disabled = true;
    $('#file-delete').disabled = true;
    toast(error.message, 'error');
  }
}

async function refreshConsole() {
  if (!state.consoleServerId || !['console', 'logs'].includes(state.manageTab)) return;
  try {
    const entries = await api(`/api/servers/${state.consoleServerId}/logs`);
    const markup = entries.map((entry) => `<div class="console-line ${['stderr', 'error'].includes(entry.source) ? 'stderr' : ''}"><span class="console-time">${escapeHtml(new Date(entry.timestamp).toLocaleTimeString())}</span> ${escapeHtml(entry.line)}</div>`).join('') || 'No process output yet. Start the server to see live logs.';
    for (const output of [$('#console-output'), $('#server-log-output')]) {
      if (!output) continue;
      const wasAtBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
      output.innerHTML = markup;
      if (wasAtBottom) output.scrollTop = output.scrollHeight;
    }
  } catch (error) {
    toast(error.message, 'error');
    clearInterval(state.consoleLogInterval);
    state.consoleLogInterval = null;
  }
}

$$('[data-page]').forEach((link) => link.addEventListener('click', (event) => {
  event.preventDefault();
  const page = link.dataset.page;
  showPage(page);
  location.hash = page;
}));

document.addEventListener('click', (event) => {
  const createButton = event.target.closest('[data-create], #quick-create');
  if (createButton) {
    $('#create-error').classList.add('hidden');
    $('#create-dialog').showModal();
    void loadJavaRuntimes();
    void updateProviderCatalogHint();
    return;
  }
  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) {
    closeButton.closest('dialog').close();
    return;
  }
  const serverSection = event.target.closest('[data-server-section]');
  if (serverSection) {
    event.preventDefault();
    navigateToServerSection(serverSection.dataset.serverSection);
    return;
  }
  const folderButton = event.target.closest('[data-open-server-folder]');
  if (folderButton) {
    state.fileDirectory = folderButton.dataset.openServerFolder;
    state.selectedFile = '';
    $('#file-editor').value = '';
    $('#file-editor').disabled = true;
    $('#file-save').disabled = true;
    $('#file-delete').disabled = true;
    navigateToServerSection('files');
    return;
  }
  const worldButton = event.target.closest('[data-open-world]');
  if (worldButton) {
    state.fileDirectory = worldButton.dataset.openWorld;
    state.selectedFile = '';
    navigateToServerSection('files');
    return;
  }
  if (event.target.closest('#worlds-refresh')) {
    void loadWorldList();
    return;
  }
  if (event.target.closest('#logs-refresh')) {
    void refreshConsole();
    return;
  }
  const uninstallButton = event.target.closest('[data-uninstall-content]');
  if (uninstallButton) {
    void uninstallManagedContent(
      uninstallButton.dataset.uninstallContent,
      uninstallButton.matches('[data-manage-modrinth-install]') ? uninstallButton : null
    );
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) void runAction(actionButton.dataset.action, actionButton.dataset.id, actionButton.dataset.backup);
  const fileButton = event.target.closest('[data-file-name]');
  if (fileButton) {
    if (fileButton.dataset.fileType === 'directory') {
      state.fileDirectory = state.fileDirectory ? `${state.fileDirectory}/${fileButton.dataset.fileName}` : fileButton.dataset.fileName;
      void loadFileList();
    } else if (fileButton.dataset.fileType === 'file') {
      void openManagedFile(fileButton.dataset.fileName);
    }
  }
  const versionButton = event.target.closest('[data-select-version]');
  if (versionButton) {
    $('#create-version').value = versionButton.dataset.selectVersion;
    $('#create-dialog').showModal();
    void loadJavaRuntimes();
    void updateProviderCatalogHint();
    showPage('overview');
    location.hash = 'overview';
  }
  const modrinthButton = event.target.closest('[data-modrinth-install]');
  if (modrinthButton) void installLatestModrinth(modrinthButton);
  const managedModrinthButton = event.target.closest('[data-manage-modrinth-install]');
  if (managedModrinthButton) {
    const server = state.servers.find((item) => item.id === state.adminServerId);
    void installModrinthProject(managedModrinthButton, server);
  }
});

$('#create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void createServer(event.currentTarget);
});
$('#schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const values = Object.fromEntries(new FormData(form));
    await api(`/api/servers/${values.serverId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({ action: values.action, intervalMinutes: Number(values.intervalMinutes) })
    });
    toast(`Recurring ${values.action} schedule added.`);
    await refresh();
  } catch (error) {
    toast(error.message, 'error');
  }
});
$('#file-up').addEventListener('click', () => {
  state.fileDirectory = state.fileDirectory.split('/').slice(0, -1).join('/');
  state.selectedFile = '';
  $('#file-editor').value = '';
  $('#file-editor').disabled = true;
  $('#file-save').disabled = true;
  $('#file-delete').disabled = true;
  void loadFileList();
});
$('#file-reload').addEventListener('click', () => void loadFileList());
$('#file-save').addEventListener('click', async () => {
  try {
    await api(`/api/servers/${state.adminServerId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: state.selectedFile, content: $('#file-editor').value })
    });
    toast('File saved.');
  } catch (error) {
    toast(error.message, 'error');
  }
});
$('#file-delete').addEventListener('click', async () => {
  if (!state.selectedFile || !confirm(`Delete ${state.selectedFile}?`)) return;
  try {
    await api(`/api/servers/${state.adminServerId}/file?path=${encodeURIComponent(state.selectedFile)}`, { method: 'DELETE' });
    state.selectedFile = '';
    $('#file-editor').value = '';
    $('#file-save').disabled = true;
    $('#file-delete').disabled = true;
    toast('File deleted.');
    await loadFileList();
  } catch (error) {
    toast(error.message, 'error');
  }
});
$('#new-file-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const filename = form.elements.filename.value.trim();
  if (!filename || !state.adminServerId) return;
  const filePath = state.fileDirectory ? `${state.fileDirectory}/${filename}` : filename;
  try {
    await api(`/api/servers/${state.adminServerId}/files`, { method: 'POST', body: JSON.stringify({ path: filePath, content: '' }) });
    form.reset();
    await loadFileList();
    await openManagedFile(filename);
  } catch (error) {
    toast(error.message, 'error');
  }
});
$('#admin-command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const action = form.elements.action.value;
  const args = {};
  const playerActions = ['ban', 'pardon', 'whitelist.add', 'whitelist.remove', 'op', 'deop'];
  if (playerActions.includes(action)) args.player = form.elements.player.value.trim();
  if (action === 'ban' && form.elements.reason.value) args.reason = form.elements.reason.value.trim();
  if (action === 'ban-ip') {
    args.target = form.elements.player.value.trim();
    if (form.elements.reason.value) args.reason = form.elements.reason.value.trim();
  }
  if (action === 'difficulty') args.level = form.elements.level.value;
  if (action === 'time') {
    const [operation, ...value] = form.elements.value.value.trim().split(/\s+/);
    args.operation = operation;
    args.value = value.join(' ');
    if (operation === 'add') args.value = Number(args.value);
  }
  if (action === 'weather') {
    const [type, duration] = form.elements.level.value.trim().split(/\s+/);
    args.type = type;
    if (duration) args.duration = Number(duration);
  }
  if (action === 'datapack.list' && form.elements.level.value) args.type = form.elements.level.value;
  if (action === 'datapack.enable' || action === 'datapack.disable') args.name = form.elements.name.value.trim();
  if (action === 'save-all') args.flush = false;
  try {
    await api(`/api/servers/${state.adminServerId}/admin`, { method: 'POST', body: JSON.stringify({ action, args }) });
    toast('Minecraft admin command sent.');
  } catch (error) {
    toast(error.message, 'error');
  }
});
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = form.elements.password.value;
  const authError = $('#auth-error');
  authError.classList.add('hidden');
  const submit = $('#auth-submit');
  submit.disabled = true;
  try {
    if (state.authMode === 'setup' && password !== form.elements.confirmPassword.value) {
      throw new Error('The passwords do not match.');
    }
    await api(`/api/auth/${state.authMode}`, {
      method: 'POST',
      body: JSON.stringify({ token: form.elements.token.value, password })
    });
    location.reload();
  } catch (error) {
    authError.textContent = error.message;
    authError.classList.remove('hidden');
  } finally {
    submit.disabled = false;
  }
});
$('#java-runtime-select').addEventListener('change', (event) => {
  if (event.currentTarget.value) $('#java-path').value = event.currentTarget.value;
  updateVersionHint();
});
$('#java-path').addEventListener('change', updateVersionHint);
$('#create-version').addEventListener('change', updateVersionHint);
$('#create-version').addEventListener('change', updateProviderCatalogHint);
$('#create-software').addEventListener('change', updateProviderCatalogHint);
$('#modrinth-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void searchModrinth();
});
$('#modrinth-server').addEventListener('change', handleModrinthSelectionChange);
$('#modrinth-type').addEventListener('change', handleModrinthSelectionChange);
$$('[data-manage-search]').forEach((form) => form.addEventListener('submit', (event) => {
  event.preventDefault();
  const target = form.dataset.manageSearch === 'mod' ? $('#manage-mod-results') : $('#manage-plugin-results');
  void searchManageContent(form.dataset.manageSearch, form.elements.query.value.trim(), target);
}));
$('#console-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#console-command');
  const command = input.value.trim();
  if (!command || !state.consoleServerId) return;
  try {
    await api(`/api/servers/${state.consoleServerId}/command`, { method: 'POST', body: JSON.stringify({ command }) });
    input.value = '';
    await refreshConsole();
  } catch (error) {
    toast(error.message, 'error');
  }
});
$('#server-search').addEventListener('input', renderServerList);
$('#server-filter').addEventListener('change', renderServerList);
$('#version-search').addEventListener('input', renderVersions);
$('#catalog-refresh').addEventListener('click', () => { state.versions = []; void loadVersions(); });
$$('[data-refresh]').forEach((button) => button.addEventListener('click', () => void refresh()));
$('#theme-toggle').addEventListener('click', () => {
  document.body.classList.toggle('light');
  localStorage.setItem('bsp-theme', document.body.classList.contains('light') ? 'light' : 'dark');
});
$('#auth-logout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  } catch (error) {
    toast(`Could not sign out: ${error.message}`, 'error');
  }
});
if (localStorage.getItem('bsp-theme') === 'light') document.body.classList.add('light');
window.addEventListener('hashchange', () => showPage(location.hash.slice(1) || 'overview'));
showPage(location.hash.slice(1) || 'overview');
void boot();
