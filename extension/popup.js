const el = (id) => document.getElementById(id);

let config = { host: '', token: '' };
let accounts = [];
let activeTab = null;

function setStatus(text, tone) {
  const node = el('status');
  node.className = `status${tone ? ` is-${tone}` : ''}`;
  node.textContent = text;
}

function clearStatus() {
  const node = el('status');
  node.className = 'status';
  node.textContent = '';
}

async function loadConfig() {
  const saved = await chrome.storage.local.get(['host', 'token']);
  config.host = (saved.host || '').replace(/\/+$/, '');
  config.token = saved.token || '';
  if (config.host) el('host').value = config.host;
  if (config.token) el('token').value = config.token;
  return Boolean(config.host && config.token);
}

async function api(path, options = {}) {
  const response = await fetch(`${config.host}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.token}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matches(account, hostname) {
  if (!account.loginUrl) return false;
  const target = hostOf(account.loginUrl);
  if (!target) return false;
  return hostname === target || hostname.endsWith(`.${target}`);
}

function fillAccounts(hostname) {
  const select = el('account');
  select.innerHTML = '';
  if (accounts.length === 0) {
    select.innerHTML = '<option value="">还没有账号，请先在控制台添加</option>';
    return;
  }
  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = `${account.label} · ${account.providerName}${account.verified ? ' · 已验证' : ''}`;
    select.appendChild(option);
  }
  const auto = accounts.find((account) => matches(account, hostname));
  if (auto) {
    select.value = auto.id;
    el('hint').textContent = `已按当前站点自动选中「${auto.label}」。`;
  } else {
    el('hint').textContent = '没有账号与当前站点匹配，请手动选择目标账号。';
  }
}

async function refreshAccounts(hostname) {
  setStatus('正在读取账号…', 'busy');
  const result = await api('/api/ext/accounts');
  if (result.status !== 200) {
    setStatus(result.body?.error?.message || `读取账号失败（HTTP ${result.status}）`, 'bad');
    return;
  }
  accounts = result.body.accounts || [];
  clearStatus();
  fillAccounts(hostname);
}

async function buildCookieHeader(url) {
  const cookies = await chrome.cookies.getAll({ url });
  const now = Math.floor(Date.now() / 1000);
  return cookies
    .filter((cookie) => cookie.value && (!cookie.expirationDate || cookie.expirationDate > now))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function capture() {
  const accountId = el('account').value;
  if (!accountId) {
    setStatus('请先选择一个账号', 'bad');
    return;
  }
  if (!activeTab?.url) {
    setStatus('读不到当前标签地址', 'bad');
    return;
  }
  if (!/^https?:/i.test(activeTab.url)) {
    setStatus('请在登录页面（http/https）上使用', 'bad');
    return;
  }

  el('capture').disabled = true;
  setStatus('正在读取当前站点 Cookie…', 'busy');
  try {
    const header = await buildCookieHeader(activeTab.url);
    if (!header) {
      setStatus('当前站点没有可读的 Cookie，请确认已经登录。', 'bad');
      return;
    }
    setStatus('正在校验并加密保存…', 'busy');
    const result = await api('/api/ext/cookie', {
      method: 'POST',
      body: JSON.stringify({ accountId, cookie: header }),
    });
    if (result.status !== 200) {
      setStatus(result.body?.error?.message || `保存失败（HTTP ${result.status}）`, 'bad');
      return;
    }
    const account = result.body.account;
    const verified = account?.cookie?.verified;
    const count = account?.cookie?.fields?.length ?? 0;
    setStatus(
      verified
        ? `已保存并验证通过：${account.label}，${count} 个字段。`
        : `已保存，但平台校验未通过：${result.body.warning || '请稍后重试'}`,
      verified ? 'ok' : 'bad',
    );
    await refreshAccounts(hostOf(activeTab.url));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'bad');
  } finally {
    el('capture').disabled = false;
  }
}

async function boot() {
  const configured = await loadConfig();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!configured) {
    el('setup').classList.remove('hidden');
    el('main').classList.add('hidden');
    return;
  }

  el('setup').classList.add('hidden');
  el('main').classList.remove('hidden');
  const hostname = hostOf(tab?.url || '');
  el('site').textContent = hostname || '（无法读取当前标签）';
  el('site').title = tab?.url || '';
  await refreshAccounts(hostname);
}

el('save-config').addEventListener('click', async () => {
  const host = el('host').value.trim().replace(/\/+$/, '');
  const token = el('token').value.trim();
  if (!/^https?:\/\//i.test(host)) {
    setStatus('地址要以 http:// 或 https:// 开头', 'bad');
    return;
  }
  if (token.length < 20) {
    setStatus('令牌看起来不完整', 'bad');
    return;
  }
  config = { host, token };
  await chrome.storage.local.set({ host, token });
  clearStatus();
  await boot();
});

el('capture').addEventListener('click', () => void capture());

el('reload').addEventListener('click', () => void refreshAccounts(hostOf(activeTab?.url || '')));

el('reset').addEventListener('click', async () => {
  await chrome.storage.local.remove(['host', 'token']);
  config = { host: '', token: '' };
  el('host').value = '';
  el('token').value = '';
  clearStatus();
  await boot();
});

void boot();
