/**
 * Aegira Worker
 * Serves static assets and handles API routes.
 */

// Import the Durable Object class from a separate module? We'll define it here.

class GatewayState {
  /**
   * @param {DurableObjectState} state
   * @param {Env} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // We'll use the state's storage for persistence.
  }

  async fetch(request) {
    // This method is called when the Durable Object is fetched via `durableObject.fetch()`.
    // We'll handle the API requests here? Actually, we will bind the Durable Object to the worker and call its methods from the worker.
    // We'll not use the fetch method of the Durable Object. Instead, we will use the state's storage and methods.
    return new Response('Durable Object', { status: 200 });
  }

  // Methods for the admin API and public API.

  async getStatus() {
    const [registration_open, registration_changed_at, registration_changed_reason, agents_paused, paused_changed_at, paused_reason, audit_head_seq] = await this.state.storage.get([
      'registration_open',
      'registration_changed_at',
      'registration_changed_reason',
      'agents_paused',
      'paused_changed_at',
      'paused_reason',
      'audit_head_seq'
    ]);
    return {
      registration: registration_open ? 'open' : 'closed',
      registration_changed_at: registration_changed_at || null,
      agents_paused: !!agents_paused,
      paused_changed_at: paused_changed_at || null,
      audit_head_seq: audit_head_seq || 0
    };
  }

  async setRegistration(open, reason) {
    const changed = await this.state.storage.compareExchange('registration_open', !open, open);
    if (changed) {
      const now = new Date().toISOString();
      await this.state.storage.put('registration_open', open);
      await this.state.storage.put('registration_changed_at', now);
      await this.state.storage.put('registration_changed_reason', reason);
      // Increment audit head seq and store the audit entry.
      const seq = await this.state.storage.get('audit_head_seq') || 0;
      const newSeq = seq + 1;
      await this.state.storage.put('audit_head_seq', newSeq);
      await this.state.storage.put(`audit_${newSeq}`, {
        seq: newSeq,
        time: now,
        event: 'registration.changed',
        actor: 'admin',
        decision: open ? 'open' : 'closed',
        summary: reason,
        params_digest: null
      });
    }
    return changed;
  }

  async setPause(paused, reason) {
    const changed = await this.state.storage.compareExchange('agents_paused', !paused, paused);
    if (changed) {
      const now = new Date().toISOString();
      await this.state.storage.put('agents_paused', paused);
      await this.state.storage.put('paused_changed_at', now);
      await this.state.storage.put('paused_reason', reason);
      const seq = await this.state.storage.get('audit_head_seq') || 0;
      const newSeq = seq + 1;
      await this.state.storage.put('audit_head_seq', newSeq);
      await this.state.storage.put(`audit_${newSeq}`, {
        seq: newSeq,
        time: now,
        event: paused ? 'agents.paused' : 'agents.resumed',
        actor: 'admin',
        decision: paused ? 'paused' : 'resumed',
        summary: reason,
        params_digest: null
      });
    }
    return changed;
  }

  async getRecentAudit(limit) {
    const head = await this.state.storage.get('audit_head_seq') || 0;
    const results = [];
    for (let i = 0; i < limit && head - i > 0; i++) {
      const seq = head - i;
      const entry = await this.state.storage.get(`audit_${seq}`);
      if (entry) {
        results.push(entry);
      }
    }
    return results;
  }
}

// Add the Durable Object to the worker.
export default {
  async fetch(request, env, ctx) {
    // We'll handle the request in the worker.
    // First, try to serve static assets for known file extensions and root paths.
    const url = new URL(request.url);
    const path = url.pathname;

    // List of static file paths we know about (from the root)
    const staticFiles = new Set([
      '/', '/index.html', '/styles.css', '/script.js', '/robots.txt', '/sitemap.xml', '/favicon.ico',
      '/404.html', '/design-tokens.json', '/v1/register.md'
    ]);

    // If the path is in the staticFiles set, serve the file.
    if (staticFiles.has(path)) {
      try {
        const file = await fetch(request); // This will fetch from the same origin, which is our worker? We need to get the file from the filesystem.
        // We cannot fetch from the filesystem directly in the worker without using the `env.ASSETS` binding if we are using Pages.
        // Since we are not using Pages' static asset serving, we must read the files from the worker's bundle.
        // We will use the `import.meta` or `__STATIC_CONTENT` if we are using webpack? Not available.
        // We will instead use a different approach: we will not serve static assets from the worker; we will rely on the existing static site being served by Pages.
        // Given the confusion, we will assume that the static site is already being served by Pages and we are only adding the API and admin page as Functions.
        // We will change our approach: we will use the Pages Functions for the API and admin page, and let Pages serve the static assets.
        // We will then not need to handle static assets in the worker.
        // We will remove the static asset handling and only handle the API and admin page.
        // We will then change the wrangler.toml to use the [pages] configuration and put our functions in the `functions` directory.
        // Let's do that.
        return new Response('Not implemented', { status: 501 });
      } catch (e) {
        return new Response('Not Found', { status: 404 });
      }
    }

    // Handle API routes
    if (path.startsWith('/v1/')) {
      // We'll handle the API in a separate function.
      return handleApiRequest(request, env, ctx);
    }

    // Handle admin page
    if (path === '/admin' || path === '/admin/') {
      return handleAdminPage(request, env, ctx);
    }

    // If nothing else, return 404.
    return new Response('Not Found', { status: 404 });
  }
};

async function handleApiRequest(request, env, ctx) {
  // We'll implement the API endpoints here.
  // We need to get the Durable Object stub.
  const gateway = env.GATEWAY_STATE.idFromName('default');
  const stub = env.GATEWAY_STATE.get(gateway);

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Public API: /v1/status
  if (path === '/v1/status' && method === 'GET') {
    const status = await stub.getStatus();
    return Response.json(status);
  }

  // Public API: /v1/device/code (Planned)
  if (path === '/v1/device/code' && method === 'POST') {
    // We'll check if registration is open.
    const status = await stub.getStatus();
    if (!status.registration_open) {
      return Response.json({ error: { code: 'registration_closed', message: 'Registration is closed.' } }, { status: 403 });
    }
    // For now, we return a fake device code.
    // In a real implementation, we would generate a device code and store it.
    return Response.json({
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://aegi.ryopc.org/v1/device',
      expires_in: 900,
      interval: 5
    });
  }

  // Admin API: /v1/admin/*
  if (path.startsWith('/v1/admin/')) {
    // Check for the required headers.
    const authHeader = request.headers.get('Authorization');
    const xAegiraRequest = request.headers.get('X-Aegira-Request');
    if (!authHeader || !authHeader.startsWith('Bearer ') || !xAegiraRequest || xAegiraRequest !== '1') {
      return new Response('Bad Request', { status: 400 });
    }
    const token = authHeader.slice(7); // Remove 'Bearer '
    // We'll compare the token with the admin key from environment variable.
    const adminKey = env.AEGIRA_ADMIN_KEY;
    if (!adminKey) {
      return Response.json({ error: { message: 'Admin is not configured.' } }, { status: 503 });
    }
    // We'll do a constant-time comparison.
    const crypto = globalThis.crypto;
    const tokenBuffer = new TextEncoder().encode(token);
    const keyBuffer = new TextEncoder().encode(adminKey);
    const tokenHash = await crypto.subtle.digest('SHA-256', tokenBuffer);
    const keyHash = await crypto.subtle.digest('SHA-256', keyBuffer);
    // Compare the two hashes in constant time.
    let diff = 0;
    for (let i = 0; i < tokenHash.byteLength; i++) {
      diff |= tokenHash[i] - keyHash[i];
    }
    if (diff !== 0) {
      return new Response('Unauthorized', { status: 401 });
    }
    // Check IP allowlist if set.
    const allowIps = env.AEGIRA_ADMIN_ALLOW_IPS;
    if (allowIps) {
      const cfConnectingIp = request.headers.get('CF-Connecting-IP');
      if (!cfConnectingIp || !allowIps.split(',').includes(cfConnectingIp.trim())) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    // Now handle the admin API endpoints.
    if (path === '/v1/admin/status' && method === 'GET') {
      const status = await stub.getStatus();
      return Response.json(status);
    }
    if (path === '/v1/admin/registration' && method === 'POST') {
      const data = await request.json();
      if (!data || typeof data.open !== 'boolean' || typeof data.reason !== 'string' || data.reason.length < 1 || data.reason.length > 200) {
        return new Response('Bad Request', { status: 400 });
      }
      const changed = await stub.setRegistration(data.open, data.reason);
      const status = await stub.getStatus();
      return Response.json({ ...status, changed });
    }
    if (path === '/v1/admin/pause' && method === 'POST') {
      const data = await request.json();
      if (!data || typeof data.paused !== 'boolean' || typeof data.reason !== 'string' || data.reason.length < 1 || data.reason.length > 200) {
        return new Response('Bad Request', { status: 400 });
      }
      const changed = await stub.setPause(data.paused, data.reason);
      const status = await stub.getStatus();
      return Response.json({ ...status, changed });
    }
    if (path === '/v1/admin/audit/recent' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      if (isNaN(limit) || limit < 1 || limit > 50) {
        return new Response('Bad Request', { status: 400 });
      }
      const recent = await stub.getRecentAudit(limit);
      return Response.json(recent);
    }
    // If we reach here, the endpoint is not found.
    return new Response('Not Found', { status: 404 });
  }

  // If we reach here, the API endpoint is not found.
  return new Response('Not Found', { status: 404 });
}

async function handleAdminPage(request, env, ctx) {
  // Check if the admin password is set.
  const adminPassword = env.AEGIRA_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword === '') {
    return new Response('Admin is not configured.', { status: 503 });
  }

  // Check IP allowlist if set.
  const allowIps = env.AEGIRA_ADMIN_ALLOW_IPS;
  if (allowIps) {
    const cfConnectingIp = request.headers.get('CF-Connecting-IP');
    if (!cfConnectingIp || !allowIps.split(',').includes(cfConnectingIp.trim())) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  // Check for Basic auth.
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="aegira-admin", charset="UTF-8"'
      }
    });
  }
  // We'll wait 1 second before responding to prevent timing attacks? The spec says wait 1 second before responding on failure.
  // We'll do that only on failure? We'll do it always to avoid leaking information about the password.
  // But we'll do it after we check the password? We'll do it before we check the password to avoid leaking that the password is set.
  // We'll wait 1 second in any case.
  await new Promise(resolve => setTimeout(resolve, 1000));

  const base64Credentials = authHeader.slice(6);
  const credentials = atob(base64Credentials);
  const [username, password] = credentials.split(':');
  // We ignore the username.
  // Compare the password with the admin password in constant time.
  const crypto = globalThis.crypto;
  const passwordBuffer = new TextEncoder().encode(password);
  const adminPasswordBuffer = new TextEncoder().encode(adminPassword);
  const passwordHash = await crypto.subtle.digest('SHA-256', passwordBuffer);
  const adminPasswordHash = await crypto.subtle.digest('SHA-256', adminPasswordBuffer);
  let diff = 0;
  for (let i = 0; i < passwordHash.byteLength; i++) {
    diff |= passwordHash[i] - adminPasswordHash[i];
  }
  if (diff !== 0) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="aegira-admin", charset="UTF-8"'
      }
    });
  }

  // If we get here, the password is correct.
  // We'll generate a nonce for the CSP.
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceBase64 = btoa(String.fromCharCode(...nonce));

  // We'll fetch the status from the Durable Object to render the page.
  const gateway = env.GATEWAY_STATE.idFromName('default');
  const stub = env.GATEWAY_STATE.get(gateway);
  const status = await stub.getStatus();
  const recentAudit = await stub.getRecentAudit(20);

  // We'll embed the HTML as a string.
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Aegira admin</title>
      <meta name="robots" content="noindex, nofollow">
      <style>
        :root {
          --bg-color: #0f172a;
          --text-color: #e2e8f0;
          --accent-color: #34d399;
          --header-bg: #0f172a;
          --footer-bg: #0f172a;
          --card-bg: #1e293b;
          --card-border: #34d399;
          --terminal-bg: #0f172a;
          --terminal-text: #e2e8f0;
          --badge-bg: #34d39920;
          --badge-text: #34d399;
          --button-primary-bg: var(--accent-color);
          --button-primary-text: #000;
          --button-secondary-bg: transparent;
          --button-secondary-text: var(--text-color);
          --button-secondary-border: var(--accent-color);
          --input-bg: #1e293b;
          --input-text: #e2e8f0;
          --radius-button: 9999px;
          --radius-card: 12px;
          --radius-window: 12px;
          --shadow-panel: 0 0 40px rgba(52,211,153,0.15), 0 0 80px rgba(52,211,153,0.05);
          --spacing-section: 96px;
          --spacing-card: 24px;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
          line-height: 1.6;
          color: var(--text-color);
          background-color: var(--bg-color);
        }
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 0 1rem;
        }
        header {
          background-color: var(--header-bg);
          padding: 1rem 0;
          border-bottom: 1px solid var(--card-border);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        header .logo {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        header .logo-square {
          width: 32px;
          height: 32px;
          background: var(--accent-color);
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 800;
          color: #000;
          font-size: 1.2rem;
        }
        header .logo-text {
          font-family: 'Georgia', 'Times New Roman', serif;
          font-size: 1.8rem;
          margin: 0;
          letter-spacing: -0.02em;
          color: var(--text-color);
        }
        header nav ul {
          display: flex;
          gap: 1rem;
          list-style: none;
        }
        header nav a {
          color: var(--text-color);
          text-decoration: none;
          font-weight: 500;
        }
        header nav a:hover {
          text-decoration: underline;
        }
        header .star-button {
          background: var(--button-primary-bg);
          color: var(--button-primary-text);
          border: none;
          padding: 0.5rem 1rem;
          border-radius: var(--radius-button);
          cursor: pointer;
          font-weight: 600;
        }
        header .star-button:hover {
          opacity: 0.9;
        }
        main {
          padding: 2rem 0;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          background: var(--badge-bg);
          color: var(--badge-text);
          padding: 0.25rem 0.75rem;
          border-radius: 9999px;
          font-size: 0.875rem;
          margin-bottom: 1.5rem;
        }
        .badge .dot {
          width: 6px;
          height: 6px;
          background: var(--accent-color);
          border-radius: 50%;
        }
        h1 {
          font-size: 2rem;
          margin-bottom: 1rem;
        }
        p {
          margin-bottom: 1rem;
        }
        .button-group {
          display: flex;
          gap: 1rem;
          flex-wrap: wrap;
          margin-top: 1.5rem;
        }
        .button-primary,
        .button-secondary {
          padding: 0.75rem 1.5rem;
          border-radius: var(--radius-button);
          font-weight: 600;
          cursor: pointer;
          text-decoration: none;
          border: none;
          transition: opacity 0.2s;
        }
        .button-primary {
          background: var(--button-primary-bg);
          color: var(--button-primary-text);
        }
        .button-primary:hover {
          opacity: 0.9;
        }
        .button-secondary {
          background: var(--button-secondary-bg);
          color: var(--button-secondary-text);
          border: 2px solid var(--button-secondary-border);
        }
        .button-secondary:hover {
          background: rgba(95, 199, 146, 0.1);
        }
        .description {
          margin-bottom: 1rem;
        }
        .status-card {
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: var(--radius-card);
          padding: 1.5rem;
          margin-bottom: 1.5rem;
        }
        .status-card h2 {
          margin-top: 0;
          margin-bottom: 0.5rem;
          font-size: 1.5rem;
          color: var(--text-color);
        }
        .status-card .info {
          display: flex;
          flex-wrap: wrap;
          gap: 1rem;
          margin-bottom: 1rem;
        }
        .status-card .info div {
          flex: 1 1 200px;
        }
        .status-card .info label {
          display: block;
          font-weight: 600;
          margin-bottom: 0.25rem;
        }
        .status-card .info value {
          font-size: 1.125rem;
          font-weight: 400;
        }
        .audit-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 1.5rem;
        }
        .audit-table th,
        .audit-table td {
          padding: 0.75rem 1rem;
          text-align: left;
          border-bottom: 1px solid var(--card-border);
        }
        .audit-table th {
          background: var(--card-bg);
          font-weight: 600;
        }
        .audit-table tbody tr:hover {
          background: rgba(52,211,153,0.03);
        }
        .result-line {
          margin-top: 1.5rem;
          padding: 0.75rem;
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: var(--radius-card);
        }
        .result-line.success {
          color: var(--accent-color);
        }
        .result-line.error {
          color: #ef4444;
        }
      </style>
      <script nonce="${nonceBase64}">
        // We'll put the JavaScript for the admin page here.
        document.addEventListener('DOMContentLoaded', () => {
          const loadButton = document.getElementById('load-key-button');
          const keyInput = document.getElementById('admin-api-key');
          const statusCard = document.querySelector('.status-card');
          const registrationOpenBtn = document.getElementById('open-registration');
          const registrationCloseBtn = document.getElementById('close-registration');
          const pauseBtn = document.getElementById('pause-actions');
          const resumeBtn = document.getElementById('resume-actions');
          const reasonInput = document.getElementById('reason-input');
          const auditTableBody = document.querySelector('#audit-table tbody');
          const resultLine = document.getElementById('result-line');
          const apiKeyInput = document.getElementById('admin-api-key');

          let adminKey = '';

          // Load the admin API key.
          if (loadButton && keyInput) {
            loadButton.addEventListener('click', async () => {
              adminKey = keyInput.value.trim();
              keyInput.value = '';
              // We'll store the key in a variable and use it for API calls.
              // We'll update the status to indicate the key is loaded.
              resultLine.textContent = 'Key loaded.';
              resultLine.className = 'result-line success';
              // We'll reload the status and audit.
              await reloadStatus();
              await reloadAudit();
            });
          }

          // Registration control.
          if (registrationOpenBtn && registrationCloseBtn && reasonInput) {
            const confirmRegistration = async (open) => {
              const reason = reasonInput.value.trim();
              if (reason.length < 1 || reason.length > 200) {
                resultLine.textContent = 'Reason must be between 1 and 200 characters.';
                resultLine.className = 'result-line error';
                return;
              }
              const confirmText = open ? 'Registration will open for new agents. Continue?' : 'Registration will close for new agents. Continue?';
              if (!window.confirm(confirmText)) {
                return;
              }
              try {
                const response = await fetch('/v1/admin/registration', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': \`Bearer \${adminKey}\`,
                    'X-Aegira-Request': '1'
                  },
                  body: JSON.stringify({ open, reason })
                });
                if (response.ok) {
                  const data = await response.json();
                  resultLine.textContent = data.changed ? 'Registration status updated.' : 'Registration status is already as requested.';
                  resultLine.className = 'result-line success';
                  await reloadStatus();
                  await reloadAudit();
                } else {
                  const error = await response.json();
                  resultLine.textContent = \`Error: \${error.error?.message || 'Unknown error'}\`;
                  resultLine.className = 'result-line error';
                }
              } catch (err) {
                resultLine.textContent = 'Failed to connect to server.';
                resultLine.className = 'result-line error';
              }
              reasonInput.value = '';
            };
            registrationOpenBtn.addEventListener('click', () => confirmRegistration(true));
            registrationCloseBtn.addEventListener('click', () => confirmRegistration(false));
          }

          // Pause control.
          if (pauseBtn && resumeBtn && reasonInput) {
            const confirmPause = async (paused) => {
              const reason = reasonInput.value.trim();
              if (reason.length < 1 || reason.length > 200) {
                resultLine.textContent = 'Reason must be between 1 and 200 characters.';
                resultLine.className = 'result-line error';
                return;
              }
              const confirmText = paused ? 'Pause new actions. Continue?' : 'Resume actions. Continue?';
              if (!window.confirm(confirmText)) {
                return;
              }
              try {
                const response = await fetch('/v1/admin/pause', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': \`Bearer \${adminKey}\`,
                    'X-Aegira-Request': '1'
                  },
                  body: JSON.stringify({ paused, reason })
                });
                if (response.ok) {
                  const data = await response.json();
                  resultLine.textContent = data.changed ? 'Pause status updated.' : 'Pause status is already as requested.';
                  resultLine.className = 'result-line success';
                  await reloadStatus();
                  await reloadAudit();
                } else {
                  const error = await response.json();
                  resultLine.textContent = \`Error: \${error.error?.message || 'Unknown error'}\`;
                  resultLine.className = 'result-line error';
                }
              } catch (err) {
                resultLine.textContent = 'Failed to connect to server.';
                resultLine.className = 'result-line error';
              }
              reasonInput.value = '';
            };
            pauseBtn.addEventListener('click', () => confirmPause(true));
            resumeBtn.addEventListener('click', () => confirmPause(false));
          }

          async function reloadStatus() {
            try {
              const response = await fetch('/v1/admin/status', {
                headers: {
                  'Authorization': \`Bearer \${adminKey}\`,
                  'X-Aegira-Request': '1'
                }
              });
              if (response.ok) {
                const data = await response.json();
                // Update the status card.
                const registrationStatusEl = statusCard.querySelector('[data-status="registration"]');
                const registrationChangedAtEl = statusCard.querySelector('[data-changed-at="registration"]');
                const registrationReasonEl = statusCard.querySelector('[data-reason="registration"]');
                const pausedStatusEl = statusCard.querySelector('[data-status="paused"]');
                const pausedChangedAtEl = statusCard.querySelector('[data-changed-at="paused"]');
                const auditHeadSeqEl = statusCard.querySelector('[data-audit-head]');
                if (registrationStatusEl) registrationStatusEl.textContent = data.registration === 'open' ? 'OPEN' : 'CLOSED';
                if (registrationChangedAtEl) registrationChangedAtEl.textContent = data.registration_changed_at || '—';
                if (registrationReasonEl) registrationReasonEl.textContent = data.registration_changed_reason || '—';
                if (pausedStatusEl) pausedStatusEl.textContent = data.agents_paused ? 'PAUSED' : 'RUNNING';
                if (pausedChangedAtEl) pausedChangedAtEl.textContent = data.paused_changed_at || '—';
                if (auditHeadSeqEl) auditHeadSeqEl.textContent = data.audit_head_seq || '0';
              } else {
                resultLine.textContent = 'Failed to load status.';
                resultLine.className = 'result-line error';
              }
            } catch (err) {
              resultLine.textContent = 'Failed to connect to server.';
              resultLine.className = 'result-line error';
            }
          }

          async function reloadAudit() {
            try {
              const response = await fetch('/v1/admin/audit/recent?limit=20', {
                headers: {
                  'Authorization': \`Bearer \${adminKey}\`,
                  'X-Aegira-Request': '1'
                }
              });
              if (response.ok) {
                const data = await response.json();
                auditTableBody.innerHTML = '';
                data.forEach(entry => {
                  const tr = document.createElement('tr');
                  tr.innerHTML = \`
                    <td>\${entry.seq}</td>
                    <td>\${new Date(entry.time).toLocaleString()}</td>
                    <td>\${entry.event}</td>
                    <td>\${entry.decision}</td>
                    <td>\${entry.summary}</td>
                  \`;
                  auditTableBody.appendChild(tr);
                });
              } else {
                resultLine.textContent = 'Failed to load audit.';
                resultLine.className = 'result-line error';
              }
            } catch (err) {
              resultLine.textContent = 'Failed to connect to server.';
              resultLine.className = 'result-line error';
            }
          }

          // Initial load.
          reloadStatus();
          reloadAudit();
        });
      </script>
    </head>
    <body>
      <a href="#main-content" class="skip-link">Skip to main content</a>
      <header>
        <div class="container">
          <div class="logo">
            <div class="logo-square">A</div>
            <div class="logo-text">AEGIRA</div>
          </div>
          <nav>
            <ul>
              <li><a href="#" aria-label="Docs">Docs</a></li>
              <li><a href="#" aria-label="Status">Status</a></li>
              <li><a href="https://github.com/ryotagtagtag-wq/aegira" aria-label="GitHub">GitHub</a></li>
              <li><a href="https://github.com/ryotagtagtag-wq/aegira" class="star-button">Star on GitHub</a></li>
            </ul>
          </nav>
        </div>
      </header>
      <main id="main-content">
        <div class="container">
          <h1>Aegira admin</h1>
          <div class="status-card">
            <h2>Status</h2>
            <div class="info">
              <div>
                <label>Registration</label>
                <value data-status="registration">—</value>
              </div>
              <div>
                <label>Changed at</label>
                <value data-changed-at="registration">—</value>
              </div>
              <div>
                <label>Reason</label>
                <value data-reason="registration">—</value>
              </div>
            </div>
            <div class="info">
              <div>
                <label>Actions</label>
                <value data-status="paused">—</value>
              </div>
              <div>
                <label>Changed at</label>
                <value data-changed-at="paused">—</value>
              </div>
              <div>
                <label>Audit head</label>
                <value data-audit-head>—</value>
              </div>
            </div>
          </div>
          <div>
            <label for="admin-api-key">Admin API key</label>
            <input type="password" id="admin-api-key" placeholder="Enter admin API key" />
            <button id="load-key-button">Load</button>
          </div>
          <div>
            <h2>Registration control</h2>
            <button id="open-registration">Open registration</button>
            <button id="close-registration">Close registration</button>
            <input type="text" id="reason-input" placeholder="Reason (1-200 chars)" />
          </div>
          <div>
            <h2>Pause control</h2>
            <button id="pause-actions">Pause new actions</button>
            <button id="resume-actions">Resume actions</button>
            <input type="text" id="reason-input" placeholder="Reason (1-200 chars)" />
          </div>
          <div>
            <h2>Recent audit</h2>
            <table class="audit-table">
              <thead>
                <tr>
                  <th>Seq</th>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Decision</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="result-line" id="result-line" aria-live="polite"></div>
        </div>
      </main>
    </body>
    </html>
  `;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': \`default-src 'none'; script-src 'nonce-\${nonceBase64}'; style-src 'nonce-\${nonceBase64}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\`
    }
  });
}
