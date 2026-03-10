// WebUI共通の画面制御（認証状態、メニュー、API連携）を担当するスクリプト。
const page = document.body.dataset.page || 'jobs';
const adminPages = new Set(['users', 'ldap', 'audit']);
let currentUser = null;

const userBadge = document.getElementById('userBadge');
const logoutBtn = document.getElementById('logoutBtn');
const themeToggleBtn = document.getElementById('themeToggle');
const alertBox = document.getElementById('alertBox');
const sidebarLinks = Array.from(document.querySelectorAll('#sidebarNav .nav-link, #sidebarMobileNav .nav-link'));
const adminOnlyLinks = Array.from(document.querySelectorAll('.admin-only'));

// localStorageが利用不可な環境でもテーマ初期化で落ちないようにする。
function loadThemeFromStorage() {
  try {
    return localStorage.getItem('theme') || 'light';
  } catch {
    return 'light';
  }
}

// テーマ属性を切り替えてローカル保存する。
function setTheme(theme) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // ignore storage failures
  }
  if (themeToggleBtn) {
    themeToggleBtn.innerHTML = theme === 'dark' ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-fill"></i>';
  }
}

setTheme(loadThemeFromStorage());
themeToggleBtn?.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-bs-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ページ上部アラートを表示する。
function showAlert(type, message) {
  if (!alertBox) return;
  alertBox.className = `alert alert-${type}`;
  alertBox.textContent = message;
  alertBox.classList.remove('d-none');
}

// ページ上部アラートを非表示にする。
function hideAlert() {
  if (!alertBox) return;
  alertBox.classList.add('d-none');
}

// 指定Cookieキーの値を取得する。
function getCookieValue(name) {
  const cookies = document.cookie ? document.cookie.split('; ') : [];
  for (const entry of cookies) {
    const pos = entry.indexOf('=');
    if (pos <= 0) continue;
    const key = entry.slice(0, pos);
    if (key === name) return decodeURIComponent(entry.slice(pos + 1));
  }
  return '';
}

// API呼び出し共通処理（CSRF付与・エラーハンドリング）を行う。
async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {})
  };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = getCookieValue('noc_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  const res = await fetch(path, {
    ...options,
    headers
  });

  if (res.status === 401) {
    location.href = '/ui/login.html';
    throw new Error('unauthorized');
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.message || `${res.status} error`);
  }

  if (res.status === 204) return null;
  return res.json();
}

logoutBtn?.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // ignore
  }
  location.href = '/ui/login.html';
});

// ジョブ状態に応じたバッジHTMLを返す。
function statusBadge(status) {
  const map = {
    STOPPED: 'secondary',
    STARTING: 'warning',
    RUNNING: 'success',
    RECONNECTING: 'warning',
    ERROR: 'danger',
    STOPPING: 'secondary'
  };
  const cls = map[status] || 'secondary';
  return `<span class="badge text-bg-${cls} badge-status">${status}</span>`;
}

// 権限とジョブ状態に応じた操作ボタン群を生成する。
function actionButtons(job) {
  const role = currentUser?.role || 'viewer';
  const canControl = ['admin', 'operator'].includes(role);
  const canDelete = role === 'admin';

  return `
    <div class="btn-group btn-group-sm">
      ${canControl ? `<button class="btn btn-outline-success" data-action="start" data-id="${job.id}">Start</button>` : ''}
      ${canControl ? `<button class="btn btn-outline-warning" data-action="stop" data-id="${job.id}">Stop</button>` : ''}
      ${canControl ? `<button class="btn btn-outline-primary" data-action="restart" data-id="${job.id}">Restart</button>` : ''}
      ${job.vnc_enabled ? `<button class="btn btn-outline-dark" data-action="vnc" data-id="${job.id}">VNC</button>` : ''}
      ${canControl ? `<button class="btn btn-outline-info" data-action="edit" data-id="${job.id}">Edit</button>` : ''}
      ${canDelete ? `<button class="btn btn-outline-danger" data-action="delete" data-id="${job.id}">Delete</button>` : ''}
      <button class="btn btn-outline-secondary" data-action="logs" data-id="${job.id}">Logs</button>
    </div>
  `;
}

// セッション取得と画面権限制御の初期化を行う。
async function initializeSession() {
  const res = await fetch('/api/auth/me');
  if (res.status === 401) {
    location.href = '/ui/login.html';
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    throw new Error('failed to load session');
  }

  currentUser = await res.json();
  userBadge.textContent = `${currentUser.username || 'unknown'} (${currentUser.role || '-'})`;

  if (adminPages.has(page) && currentUser.role !== 'admin') {
    location.href = '/ui/jobs.html';
    throw new Error('forbidden');
  }

  for (const link of adminOnlyLinks) {
    link.classList.toggle('d-none', currentUser.role !== 'admin');
  }

  for (const link of sidebarLinks) {
    const active = link.dataset.page === page;
    link.classList.toggle('active', active);
  }
}

// 改行テキストのURLスケジュールをAPI形式へ変換する。
function parseSchedules(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [url, priorityText, refreshText] = line.split(',');
      return {
        url: (url || '').trim(),
        priority: Number((priorityText || '1').trim()),
        refresh_interval_sec: Number((refreshText || '10').trim())
      };
    });
}

// API形式のURLスケジュールをテキスト表示形式へ変換する。
function formatSchedules(urls) {
  return (urls || [])
    .map((x) => `${x.url},${x.priority},${x.refresh_interval_sec}`)
    .join('\n');
}

// 文字列をHTMLエスケープする。
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ジョブ管理画面の初期化とイベント登録を行う。
async function initJobsPage() {
  const jobsBody = document.getElementById('jobsBody');
  const refreshBtn = document.getElementById('refreshBtn');
  const newJobBtn = document.getElementById('newJobBtn');
  const createJobModalEl = document.getElementById('createJobModal');
  const createJobForm = document.getElementById('createJobForm');
  const editJobModalEl = document.getElementById('editJobModal');
  const editJobForm = document.getElementById('editJobForm');

  if (!jobsBody) return;
  if (window.__bootstrapReady && typeof window.__bootstrapReady.then === 'function') {
    await window.__bootstrapReady;
  }
  if (!window.bootstrap?.Modal) {
    showAlert('danger', 'Bootstrap JSの読み込みに失敗しました');
    return;
  }

  const createJobModal = createJobModalEl ? new bootstrap.Modal(createJobModalEl) : null;
  const editJobModal = editJobModalEl ? new bootstrap.Modal(editJobModalEl) : null;
  let jobs = [];
  let expandedLogJobId = null;
  const logsCache = new Map();

  // ジョブ一覧テーブル（ログ展開行を含む）を再描画する。
  function renderJobs() {
    jobsBody.innerHTML = jobs
      .map((job) => {
        const isLogOpen = expandedLogJobId === job.id;
        const logs = logsCache.get(job.id) || [];
        const logsHtml = logs.length
          ? logs
              .map(
                (x) =>
                  `<div class="job-log-line">[${escapeHtml(x.created_at)}] ${escapeHtml(x.level)}/${escapeHtml(x.source)}: ${escapeHtml(x.message)}</div>`
              )
              .join('')
          : '<div class="text-secondary small">ログはありません</div>';

        return `
        <tr>
          <td>${job.id}</td>
          <td>${escapeHtml(job.name)}</td>
          <td>${statusBadge(job.status)}</td>
          <td>${job.resolution_width}x${job.resolution_height} / ${job.fps}</td>
          <td>${job.protocol.toUpperCase()}</td>
          <td>${job.urls.length}</td>
          <td class="text-end">${actionButtons(job)}</td>
        </tr>
        ${
          isLogOpen
            ? `<tr class="job-log-row">
          <td colspan="7">
            <div class="job-log-box">${logsHtml}</div>
          </td>
        </tr>`
            : ''
        }
      `;
      })
      .join('');
  }

  // ジョブ一覧をAPIから再取得して再描画する。
  async function loadJobs() {
    jobs = await api('/api/jobs');
    if (expandedLogJobId !== null && !jobs.some((x) => x.id === expandedLogJobId)) {
      expandedLogJobId = null;
    }
    renderJobs();
  }

  createJobForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const fd = new FormData(createJobForm);
      const payload = {
        name: String(fd.get('name')),
        resolution_width: Number(fd.get('resolution_width')),
        resolution_height: Number(fd.get('resolution_height')),
        fps: Number(fd.get('fps')),
        bitrate_kbps: Number(fd.get('bitrate_kbps')),
        codec: String(fd.get('codec')),
        preset: String(fd.get('preset')),
        protocol: String(fd.get('protocol')),
        output_url: String(fd.get('output_url')),
        stream_key: String(fd.get('stream_key')),
        input_source_type: String(fd.get('input_source_type') || 'browser'),
        test_pattern_type: String(fd.get('test_pattern_type') || ''),
        test_pattern_params: String(fd.get('test_pattern_params') || ''),
        terminal_bg_color: String(fd.get('terminal_bg_color') || '#000000'),
        terminal_fg_color: String(fd.get('terminal_fg_color') || '#ffffff'),
        overlay_enabled: fd.get('overlay_enabled') !== null,
        overlay_message: String(fd.get('overlay_message') || ''),
        overlay_position: String(fd.get('overlay_position') || 'top_left'),
        overlay_font_size_px: Number(fd.get('overlay_font_size_px') || 24),
        refresh_interval_sec: Number(fd.get('refresh_interval_sec')),
        max_retries: Number(fd.get('max_retries')),
        retry_interval_sec: Number(fd.get('retry_interval_sec')),
        urls: parseSchedules(String(fd.get('urls')))
      };

      await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      createJobModal?.hide();
      createJobForm.reset();
      showAlert('success', 'ジョブを作成しました');
      await loadJobs();
    } catch (err) {
      showAlert('danger', err.message || '作成に失敗しました');
    }
  });

  jobsBody.addEventListener('click', async (event) => {
    const target = event.target.closest('button[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const id = Number(target.dataset.id);

    try {
      if (action === 'logs') {
        if (expandedLogJobId === id) {
          expandedLogJobId = null;
          renderJobs();
          return;
        }
        const payload = await api(`/api/jobs/${id}/logs`);
        expandedLogJobId = id;
        logsCache.set(id, payload.items.slice(0, 50));
        renderJobs();
        return;
      }

      if (action === 'edit') {
        const job = await api(`/api/jobs/${id}`);
        if (!editJobForm) return;
        const form = editJobForm;
        form.job_id.value = String(job.id);
        form.name.value = job.name;
        form.resolution_width.value = String(job.resolution_width);
        form.resolution_height.value = String(job.resolution_height);
        form.fps.value = String(job.fps);
        form.bitrate_kbps.value = String(job.bitrate_kbps);
        form.codec.value = job.codec;
        form.preset.value = job.preset;
        form.protocol.value = job.protocol;
        form.output_url.value = job.output_url;
        form.stream_key.value = '';
        form.input_source_type.value = job.input_source_type || 'browser';
        form.test_pattern_type.value = job.test_pattern_type || 'testsrc2';
        form.test_pattern_params.value = job.test_pattern_params || '';
        form.terminal_bg_color.value = job.terminal_bg_color || '#000000';
        form.terminal_fg_color.value = job.terminal_fg_color || '#ffffff';
        form.overlay_enabled.checked = Boolean(job.overlay_enabled);
        form.overlay_message.value = job.overlay_message || '';
        form.overlay_position.value = job.overlay_position || 'top_left';
        form.overlay_font_size_px.value = String(job.overlay_font_size_px || 24);
        form.refresh_interval_sec.value = String(job.refresh_interval_sec);
        form.max_retries.value = String(job.max_retries);
        form.retry_interval_sec.value = String(job.retry_interval_sec);
        form.urls.value = formatSchedules(job.urls);
        editJobModal?.show();
        return;
      }

      if (action === 'vnc') {
        const job = jobs.find((x) => x.id === id);
        if (!job?.vnc_enabled || !job.vnc_port) {
          showAlert('warning', 'このジョブはVNC公開対象ではありません');
          return;
        }
        if (job.novnc_enabled && job.novnc_url) {
          window.open(job.novnc_url, '_blank', 'noopener,noreferrer');
          showAlert('info', `noVNCを開きました: ${job.novnc_url}`);
          return;
        }
        const url = job.vnc_url || `vnc://${job.vnc_host || 'localhost'}:${job.vnc_port}`;
        showAlert('info', `VNC接続先: ${url}`);
        return;
      }

      if (action === 'delete') {
        if (!confirm('ジョブを削除しますか？')) return;
        await api(`/api/jobs/${id}`, { method: 'DELETE' });
        showAlert('success', '削除しました');
        await loadJobs();
        return;
      }

      await api(`/api/jobs/${id}/${action}`, { method: 'POST' });
      showAlert('success', `${action} を受け付けました`);
      await loadJobs();
    } catch (err) {
      showAlert('danger', err.message || '操作に失敗しました');
    }
  });

  editJobForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    try {
      const fd = new FormData(editJobForm);
      const id = Number(fd.get('job_id'));
      const streamKey = String(fd.get('stream_key') || '').trim();
      const payload = {
        name: String(fd.get('name')),
        resolution_width: Number(fd.get('resolution_width')),
        resolution_height: Number(fd.get('resolution_height')),
        fps: Number(fd.get('fps')),
        bitrate_kbps: Number(fd.get('bitrate_kbps')),
        codec: String(fd.get('codec')),
        preset: String(fd.get('preset')),
        protocol: String(fd.get('protocol')),
        output_url: String(fd.get('output_url')),
        input_source_type: String(fd.get('input_source_type') || 'browser'),
        test_pattern_type: String(fd.get('test_pattern_type') || ''),
        test_pattern_params: String(fd.get('test_pattern_params') || ''),
        terminal_bg_color: String(fd.get('terminal_bg_color') || '#000000'),
        terminal_fg_color: String(fd.get('terminal_fg_color') || '#ffffff'),
        overlay_enabled: fd.get('overlay_enabled') !== null,
        overlay_message: String(fd.get('overlay_message') || ''),
        overlay_position: String(fd.get('overlay_position') || 'top_left'),
        overlay_font_size_px: Number(fd.get('overlay_font_size_px') || 24),
        refresh_interval_sec: Number(fd.get('refresh_interval_sec')),
        max_retries: Number(fd.get('max_retries')),
        retry_interval_sec: Number(fd.get('retry_interval_sec')),
        urls: parseSchedules(String(fd.get('urls')))
      };
      if (streamKey) {
        payload.stream_key = streamKey;
      }

      if (submitter) submitter.disabled = true;
      await api(`/api/jobs/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      await api(`/api/jobs/${id}/stop`, { method: 'POST' });
      await api(`/api/jobs/${id}/start`, { method: 'POST' });

      editJobModal?.hide();
      showAlert('success', 'ジョブ設定を保存し、新設定で再起動しました');
      await loadJobs();
    } catch (err) {
      showAlert('danger', err.message || 'ジョブ更新に失敗しました');
    } finally {
      if (submitter) submitter.disabled = false;
    }
  });

  refreshBtn?.addEventListener('click', () => {
    void loadJobs();
  });

  newJobBtn?.addEventListener('click', () => {
    createJobModal?.show();
  });

  await loadJobs();
  setInterval(() => {
    void loadJobs();
  }, 15000);
}

async function initUsersPage() {
  const userCreateForm = document.getElementById('userCreateForm');
  const usersBody = document.getElementById('usersBody');
  const reloadUsersBtn = document.getElementById('reloadUsersBtn');
  if (!usersBody) return;

  // ユーザー一覧を取得してテーブルへ反映する。
  async function loadUsers() {
    const users = await api('/api/admin/users');
    usersBody.innerHTML = users
      .map(
        (u) => `<tr>
        <td>${u.id}</td>
        <td>${u.username}</td>
        <td>${u.role}</td>
        <td>${u.is_active ? 'yes' : 'no'}</td>
        <td class="text-end">
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-warning" data-user-action="toggle" data-user-id="${u.id}" data-user-active="${u.is_active}">
              ${u.is_active ? 'Disable' : 'Enable'}
            </button>
            <button class="btn btn-outline-danger" data-user-action="delete" data-user-id="${u.id}">Delete</button>
          </div>
        </td>
      </tr>`
      )
      .join('');
  }

  userCreateForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const fd = new FormData(userCreateForm);
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: String(fd.get('username')).trim(),
          password: String(fd.get('password')),
          role: String(fd.get('role')),
          is_active: true
        })
      });
      userCreateForm.reset();
      showAlert('success', 'ユーザーを追加しました');
      await loadUsers();
    } catch (err) {
      showAlert('danger', err.message || 'ユーザー追加に失敗しました');
    }
  });

  reloadUsersBtn?.addEventListener('click', () => {
    void loadUsers();
  });

  usersBody.addEventListener('click', async (event) => {
    const target = event.target.closest('button[data-user-action]');
    if (!target) return;

    const action = target.dataset.userAction;
    const userId = target.dataset.userId;
    try {
      if (action === 'toggle') {
        const current = target.dataset.userActive === 'true';
        await api(`/api/admin/users/${userId}`, {
          method: 'PUT',
          body: JSON.stringify({ is_active: !current })
        });
        showAlert('success', 'ユーザー状態を更新しました');
        await loadUsers();
        return;
      }
      if (action === 'delete') {
        if (!confirm('ユーザーを削除しますか？')) return;
        await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
        showAlert('success', 'ユーザーを削除しました');
        await loadUsers();
      }
    } catch (err) {
      showAlert('danger', err.message || 'ユーザー操作に失敗しました');
    }
  });

  await loadUsers();
}

async function initLdapPage() {
  const ldapForm = document.getElementById('ldapForm');
  const ldapTestBtn = document.getElementById('ldapTestBtn');
  if (!ldapForm) return;

  // フォーム入力からLDAP設定ペイロードを組み立てる。
  function buildLdapPayload() {
    return {
      enabled: Boolean(ldapForm.enabled.checked),
      server_url: ldapForm.server_url.value.trim(),
      bind_dn: ldapForm.bind_dn.value.trim(),
      bind_password: ldapForm.bind_password.value,
      base_dn: ldapForm.base_dn.value.trim(),
      user_filter: ldapForm.user_filter.value.trim(),
      group_dn: ldapForm.group_dn.value.trim()
    };
  }

  // 保存済みLDAP設定を取得してフォームへ展開する。
  async function loadLdapConfig() {
    const data = await api('/api/admin/ldap-config');
    if (!data) return;

    ldapForm.enabled.checked = Boolean(data.enabled);
    ldapForm.server_url.value = data.server_url || '';
    ldapForm.bind_dn.value = data.bind_dn || '';
    ldapForm.bind_password.value = '';
    ldapForm.bind_password.placeholder = data.has_bind_password
      ? '変更する場合のみ入力'
      : 'Bind Password (初回は必須)';
    ldapForm.base_dn.value = data.base_dn || '';
    ldapForm.user_filter.value = data.user_filter || '';
    ldapForm.group_dn.value = data.group_dn || '';
  }

  ldapForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = buildLdapPayload();
      await api('/api/admin/ldap-config', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showAlert('success', 'LDAP設定を保存しました');
    } catch (err) {
      showAlert('danger', err.message || 'LDAP設定保存に失敗しました');
    }
  });

  ldapTestBtn?.addEventListener('click', async () => {
    try {
      ldapTestBtn.disabled = true;
      const payload = buildLdapPayload();
      const result = await api('/api/admin/ldap-config/test', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showAlert('success', `${result.message} (${result.elapsed_ms}ms)`);
    } catch (err) {
      showAlert('danger', err.message || 'LDAP接続確認に失敗しました');
    } finally {
      ldapTestBtn.disabled = false;
    }
  });

  await loadLdapConfig();
}

async function initAuditPage() {
  const auditBody = document.getElementById('auditBody');
  const reloadAuditBtn = document.getElementById('reloadAuditBtn');
  const auditLimit = document.getElementById('auditLimit');
  if (!auditBody) return;

  // 監査ログを取得してテーブルへ反映する。
  async function loadAuditLogs() {
    hideAlert();
    const limit = Number(auditLimit?.value || '200');
    const logs = await api(`/api/admin/audit-logs?limit=${limit}`);
    auditBody.innerHTML = logs
      .map(
        (x) => `<tr>
        <td>${x.id}</td>
        <td class="text-nowrap">${x.created_at}</td>
        <td>${escapeHtml(x.actor_username || '-')}</td>
        <td><code>${escapeHtml(x.action)}</code></td>
        <td>${escapeHtml(x.target_type)}</td>
        <td>${escapeHtml(x.target_id)}</td>
        <td class="small"><pre class="audit-pre mb-0">${escapeHtml(x.detail_json || '')}</pre></td>
      </tr>`
      )
      .join('');
  }

  reloadAuditBtn?.addEventListener('click', () => {
    void loadAuditLogs();
  });
  auditLimit?.addEventListener('change', () => {
    void loadAuditLogs();
  });

  await loadAuditLogs();
}

void (async () => {
  await initializeSession();
  if (page === 'jobs') await initJobsPage();
  if (page === 'users') await initUsersPage();
  if (page === 'ldap') await initLdapPage();
  if (page === 'audit') await initAuditPage();
})();
