const el = (id) => document.getElementById(id);

const NEW_ACCOUNT = '__new__';

let config = { host: '', token: '' };
let accounts = [];
let providers = [];
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

function hostMatches(hostname, target) {
  const host = hostOf(target || '') || String(target || '').replace(/^\./, '').toLowerCase();
  if (!hostname || !host) return false;
  return hostname === host || hostname.endsWith(`.${host}`);
}

function matches(account, hostname) {
  if (!account.loginUrl) return false;
  return hostMatches(hostname, account.loginUrl);
}

/** 当前站点属于哪个已适配平台；找不到就返回 null。 */
function providerForHost(hostname) {
  if (!hostname) return null;
  return (
    providers.find((provider) => {
      if (hostMatches(hostname, provider.loginUrl)) return true;
      return (provider.cookieDomains || []).some((domain) => hostMatches(hostname, domain));
    }) || null
  );
}

function selectedAccount() {
  const value = el('account').value;
  if (!value || value === NEW_ACCOUNT) return null;
  return accounts.find((account) => account.id === value) || null;
}

function updateHint(hostname, provider) {
  const value = el('account').value;
  if (value === NEW_ACCOUNT) {
    const existing = accounts.find((account) => matches(account, hostname) && account.configured);
    const base = provider
      ? `会新建一个「${provider.name}」账号，已有账号的登录态不会被改动。`
      : '会新建一个账号，已有账号的登录态不会被改动。';
    el('hint').textContent = existing
      ? `${base}「${existing.label}」已保存的登录态保持原样，要刷新它请在列表里手动选中。`
      : base;
    return;
  }
  const current = selectedAccount();
  if (current) {
    el('hint').textContent = `会覆盖「${current.label}」当前的登录态。想保留原来的登录，选「＋ 新建账号」。`;
    return;
  }
  el('hint').textContent = '没有账号与当前站点匹配，请手动选择目标账号。';
}

function fillAccounts(hostname) {
  const select = el('account');
  const provider = providerForHost(hostname);
  select.innerHTML = '';

  if (provider) {
    const option = document.createElement('option');
    option.value = NEW_ACCOUNT;
    option.textContent = `＋ 新建账号（${provider.name}）`;
    select.appendChild(option);
  }

  if (accounts.length === 0) {
    if (!provider) {
      select.innerHTML = '<option value="">还没有账号，请先在控制台添加</option>';
      return;
    }
    select.value = NEW_ACCOUNT;
    updateHint(hostname, provider);
    return;
  }

  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = `${account.label} · ${account.providerName}${account.verified ? ' · 已验证' : ''}`;
    select.appendChild(option);
  }

  const auto = accounts.find((account) => matches(account, hostname));
  // 已有可用登录态时默认「新建」：覆盖是不可逆的，刷新老账号应由用户显式选择。
  if (auto && auto.configured && provider) {
    select.value = NEW_ACCOUNT;
  } else if (auto) {
    select.value = auto.id;
  } else {
    select.value = provider ? NEW_ACCOUNT : accounts[0].id;
  }
  updateHint(hostname, provider);
}

function defaultLabel(provider) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${provider.name} ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`.slice(0, 40);
}

async function refreshAccounts(hostname) {
  setStatus('正在读取账号…', 'busy');
  const result = await api('/api/ext/accounts');
  if (result.status !== 200) {
    setStatus(result.body?.error?.message || `读取账号失败（HTTP ${result.status}）`, 'bad');
    return;
  }
  accounts = result.body.accounts || [];
  providers = result.body.providers || [];
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

async function createAccountFor(provider) {
  const result = await api('/api/ext/accounts', {
    method: 'POST',
    body: JSON.stringify({ providerId: provider.id, label: defaultLabel(provider) }),
  });
  if (result.status !== 201) {
    setStatus(result.body?.error?.message || `新建账号失败（HTTP ${result.status}）`, 'bad');
    return null;
  }
  return result.body.account;
}

async function capture() {
  const choice = el('account').value;
  if (!choice) {
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

  const hostname = hostOf(activeTab.url);
  const provider = providerForHost(hostname);
  if (choice === NEW_ACCOUNT && !provider) {
    setStatus('当前站点没有匹配的平台，无法新建账号。', 'bad');
    return;
  }

  el('capture').disabled = true;
  let created = false;
  let accountId = choice;

  try {
    if (choice === NEW_ACCOUNT) {
      setStatus('正在新建账号…', 'busy');
      const account = await createAccountFor(provider);
      if (!account) return;
      accountId = account.id;
      created = true;
    }

    setStatus('正在读取当前站点 Cookie…', 'busy');
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
    const target = created ? `新建账号「${account?.label}」` : `「${account?.label}」`;
    setStatus(
      verified
        ? `已${created ? '新建并' : ''}保存到${target}，${count} 个字段，校验通过。`
        : `已保存到${target}，但平台校验未通过：${result.body.warning || '请确认这是登录后的 Cookie'}`,
      verified ? 'ok' : 'bad',
    );
    await refreshAccounts(hostname);
    if (created) el('account').value = accountId;
    updateHint(hostname, provider);
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

el('account').addEventListener('change', () => {
  const hostname = hostOf(activeTab?.url || '');
  updateHint(hostname, providerForHost(hostname));
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
