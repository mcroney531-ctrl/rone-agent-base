const app = document.getElementById('app');

function getToken() {
  try {
    return localStorage.getItem('dashboardToken') || '';
  } catch {
    return '';
  }
}

function setToken(token) {
  try {
    localStorage.setItem('dashboardToken', token);
  } catch {
    // ignore — falls back to prompting again next load
  }
}

async function api(path, options = {}) {
  const res = await fetch(`/.netlify/functions/${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-dashboard-token': getToken(),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    setToken('');
    render();
    throw new Error('unauthorized');
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function pill(text) {
  return `<span class="pill pill-${text}">${text.replace('_', ' ')}</span>`;
}

async function renderTokenGate() {
  app.innerHTML = `
    <div class="token-gate">
      <h2>Agent Base</h2>
      <p class="muted">Enter the dashboard token (only needed if DASHBOARD_TOKEN is set in Netlify env).</p>
      <input id="token-input" type="text" placeholder="dashboard token" />
      <button id="token-submit">Continue</button>
    </div>
  `;
  document.getElementById('token-submit').onclick = () => {
    setToken(document.getElementById('token-input').value.trim());
    render();
  };
}

async function renderMain() {
  app.innerHTML = `
    <header>
      <h1>Agent Base Control Plane</h1>
      <div class="row">
        <select id="agent-select"></select>
        <button id="run-now">Run now</button>
        <button class="secondary" id="refresh">Refresh</button>
      </div>
    </header>
    <main>
      <section>
        <h2>Pending actions</h2>
        <div id="actions-list"><div class="empty">Loading…</div></div>
      </section>
      <section>
        <h2>Recent runs</h2>
        <div id="runs-list"><div class="empty">Loading…</div></div>
      </section>
    </main>
  `;

  document.getElementById('refresh').onclick = () => loadAll();
  document.getElementById('run-now').onclick = onRunNow;

  await loadAll();
}

async function onRunNow() {
  const select = document.getElementById('agent-select');
  const agentId = select.value;
  if (!agentId) return;
  const btn = document.getElementById('run-now');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    await api('run-now', { method: 'POST', body: JSON.stringify({ agentId }) });
    await loadAll();
  } catch (err) {
    alert(`run failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run now';
  }
}

async function loadAll() {
  await Promise.all([loadAgents(), loadActions(), loadRuns()]);
}

async function loadAgents() {
  const select = document.getElementById('agent-select');
  try {
    const { agents } = await api('agents');
    select.innerHTML = agents.map((a) => `<option value="${a.id}">${a.name}${a.enabled ? '' : ' (disabled)'}</option>`).join('');
  } catch (err) {
    select.innerHTML = '<option>failed to load</option>';
  }
}

async function loadActions() {
  const list = document.getElementById('actions-list');
  try {
    const { actions } = await api('actions');
    const pending = actions.filter((a) => a.status === 'pending_approval');
    if (!pending.length) {
      list.innerHTML = '<div class="empty">No actions waiting on approval.</div>';
      return;
    }
    list.innerHTML = pending
      .map(
        (a) => `
      <div class="card" data-id="${a.id}">
        <div class="row">
          <div>
            <strong>${a.action_type}</strong> → ${a.target}
            <div class="muted">agent: ${a.agents?.name ?? a.agent_id} · risk: ${a.risk_level} · ${fmtTime(a.created_at)}</div>
          </div>
          <div class="row">
            <button class="approve">Approve</button>
            <button class="reject">Reject</button>
          </div>
        </div>
        <pre>${JSON.stringify(a.payload, null, 2)}</pre>
      </div>
    `
      )
      .join('');

    list.querySelectorAll('.card').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('.approve').onclick = () => decide(id, 'approve');
      card.querySelector('.reject').onclick = () => decide(id, 'reject');
    });
  } catch (err) {
    list.innerHTML = `<div class="empty">failed to load: ${err.message}</div>`;
  }
}

async function decide(actionId, decision) {
  try {
    await api('actions', { method: 'POST', body: JSON.stringify({ actionId, decision }) });
    await loadActions();
  } catch (err) {
    alert(`${decision} failed: ${err.message}`);
  }
}

async function loadRuns() {
  const list = document.getElementById('runs-list');
  try {
    const { runs } = await api('runs');
    if (!runs.length) {
      list.innerHTML = '<div class="empty">No runs yet.</div>';
      return;
    }
    list.innerHTML = runs
      .map(
        (r) => `
      <div class="card">
        <div class="row">
          <div>
            <strong>${r.agents?.name ?? r.agent_id}</strong> ${pill(r.status)}
            <div class="muted">${fmtTime(r.created_at)} · tokens ${r.tokens_input ?? 0}/${r.tokens_output ?? 0}${r.cost_usd ? ` · $${Number(r.cost_usd).toFixed(4)}` : ''}</div>
          </div>
        </div>
        ${r.output?.text ? `<pre>${r.output.text}</pre>` : ''}
        ${r.error ? `<pre>${r.error}</pre>` : ''}
      </div>
    `
      )
      .join('');
  } catch (err) {
    list.innerHTML = `<div class="empty">failed to load: ${err.message}</div>`;
  }
}

async function render() {
  // Probe once; if a token is required and we don't have one, show the gate.
  try {
    await api('agents');
    await renderMain();
  } catch (err) {
    if (err.message === 'unauthorized') {
      renderTokenGate();
    } else {
      app.innerHTML = `<div class="empty" style="padding:40px;">failed to load: ${err.message}</div>`;
    }
  }
}

render();
