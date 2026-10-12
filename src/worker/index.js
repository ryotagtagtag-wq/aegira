/**
 * Aegira Worker
 * Serves static assets and handles API routes.
 */

// Import the Durable Object class from a separate module
import { GatewayState } from '../gateway_state.js';
// Import shared logic
import { sha256Hex, constantTimeEqualStr } from '../crypto.js';
import {
  notFound,
  badRequest,
  unauthorized,
  forbidden,
  registrationClosed,
  invalidOrExpired,
  alreadyUsed,
  internalError
} from '../errors.js';

// Re-export the Durable Object class for binding
export { GatewayState };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // API routes
    if (path.startsWith('/v1/')) {
      return handleApiRequest(request, env, ctx);
    }

    // Admin page
    if (path === '/admin' || path === '/admin/') {
      return handleAdminPage(request, env, ctx);
    }

    // Device approval page
    if (path === '/device' || path === '/device/') {
      return handleDevicePage(request, env, ctx);
    }

    // Everything else: serve static assets
    return await serveStaticAsset(request, env);
  }
};

/**
 * Serve a static asset from the ASSETS binding.
 * Optionally add headers.
 */
async function serveStaticAsset(request, env) {
  // Fetch the asset
  const assetResponse = await env.ASSETS.fetch(request);
  // We can add headers here if needed.
  // For now, return as-is.
  return assetResponse;
}

/**
 * Handle API requests under /v1/*.
 */
async function handleApiRequest(request, env, ctx) {
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

  // Public API: /v1/device/code
  if (path === '/v1/device/code' && method === 'POST') {
    // Parse JSON body for agent_name and actions.
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return badRequest();
    }
    const { agent_name, actions } = body;
    if (!agent_name || typeof agent_name !== 'string' || !actions || typeof actions !== 'string') {
      return badRequest();
    }
    try {
      // This will check registration and generate/store the device code.
      const result = await stub.storeDeviceCode(agent_name, actions);
      return Response.json(result);
    } catch (err) {
      if (err.message === 'registration_closed') {
        return registrationClosed();
      }
      // Other errors (e.g., storage) -> internal error.
      return internalError();
    }
  }

  // Public API: /v1/device/token
  if (path === '/v1/device/token' && method === 'POST') {
    // Parse JSON body for device_code.
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return badRequest();
    }
    const { device_code } = body;
    if (!device_code || typeof device_code !== 'string') {
      return badRequest();
    }
    try {
      const result = await stub.handleTokenRequest(device_code);
      // result is { statusCode, body } where body is already a JSON string.
      return new Response(result.body, { status: result.statusCode, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      return internalError();
    }
  }

  // Public API: /v1/device/approve
  if (path === '/v1/device/approve' && method === 'POST') {
    // Parse JSON body.
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return badRequest();
    }
    const { user_code, decision } = body;
    if (!user_code || typeof user_code !== 'string' || !decision || (decision !== 'approve' && decision !== 'deny')) {
      return new Response(JSON.stringify({ error: 'validation failed', user_code: user_code, decision: decision, typeof_user_code: typeof user_code, body: JSON.stringify(body) }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    try {
      const result = await stub.handleApproveRequest(user_code, decision);
      return new Response(result.body, { status: result.statusCode, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      return internalError();
    }
  }

  // Public API: /v1/audit/verify
  if (path === '/v1/audit/verify' && method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '20');
    if (isNaN(limit) || limit < 1 || limit > 50) {
      return badRequest();
    }
    const verified = await stub.verifyAudit(limit);
    return Response.json(verified);
  }


  // Admin API: /v1/admin/*
  if (path.startsWith('/v1/admin/')) {
    // Check for the required headers.
    const authHeader = request.headers.get('Authorization');
    const xAegiraRequest = request.headers.get('X-Aegira-Request');
    if (!authHeader || !authHeader.startsWith('Bearer ') || !xAegiraRequest || xAegiraRequest !== '1') {
      return badRequest();
    }
    const token = authHeader.slice(7); // Remove 'Bearer '
    // We'll compare the token with the admin key from environment variable.
    const adminKey = env.AEGIRA_ADMIN_KEY;
    if (!adminKey) {
      return internalError(); // Admin is not configured.
    }
    // We'll do a constant-time comparison.
    if (!constantTimeEqualStr(token, adminKey)) {
      return unauthorized();
    }
    // Check IP allowlist if set.
    const allowIps = env.AEGIRA_ADMIN_ALLOW_IPS;
    if (allowIps) {
      const cfConnectingIp = request.headers.get('CF-Connecting-IP');
      if (!cfConnectingIp || !allowIps.split(',').includes(cfConnectingIp.trim())) {
        return forbidden();
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
        return badRequest();
      }
      const changed = await stub.setRegistration(data.open, data.reason);
      const status = await stub.getStatus();
      return Response.json({ ...status, changed });
    }
    if (path === '/v1/admin/pause' && method === 'POST') {
      const data = await request.json();
      if (!data || typeof data.paused !== 'boolean' || typeof data.reason !== 'string' || data.reason.length < 1 || data.reason.length > 200) {
        return badRequest();
      }
      const changed = await stub.setPause(data.paused, data.reason);
      const status = await stub.getStatus();
      return Response.json({ ...status, changed });
    }
    if (path === '/v1/admin/audit/recent' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      if (isNaN(limit) || limit < 1 || limit > 50) {
        return badRequest();
      }
      const recent = await stub.getRecentAudit(limit);
      return Response.json(recent);
    }
    // If we reach here, the endpoint is not found.
    return notFound();
  }

  // If we reach here, the API endpoint is not found.
  return notFound();
}

/**
 * Handle the admin page.
 */
async function handleAdminPage(request, env, ctx) {
  // Check if the admin password is set.
  const adminPassword = env.AEGIRA_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword === '') {
    return new Response("Admin is not configured.", { status: 503 }); // Admin is not configured.
  }

  // Check IP allowlist if set.
  const allowIps = env.AEGIRA_ADMIN_ALLOW_IPS;
  if (allowIps) {
    const cfConnectingIp = request.headers.get('CF-Connecting-IP');
    if (!cfConnectingIp || !allowIps.split(',').includes(cfConnectingIp.trim())) {
      return forbidden();
    }
  }

  // Check for Basic auth.
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return unauthorized();
  }

  // Wait 1 second before responding to prevent timing attacks.
  await new Promise(resolve => setTimeout(resolve, 1000));

  const base64Credentials = authHeader.slice(6);
  const credentials = atob(base64Credentials);
  const [username, password] = credentials.split(':');
  // We ignore the username.
  // Compare the password with the admin password in constant time.
  if (!constantTimeEqualStr(password, adminPassword)) {
    return unauthorized();
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
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonceBase64}'; style-src 'nonce-${nonceBase64}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    }
  });
}

/**
 * Handle the device approval page.
 */
async function handleDevicePage(request, env, ctx) {
  if (request.method === 'GET') {
    // Generate a nonce for the CSP.
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceBase64 = btoa(String.fromCharCode(...nonce));

    // We'll fetch the status from the Durable Object to see if registration is open and to get any pending device code? Actually, the device code is not stored in the Durable Object yet; we will handle that in the POST endpoint.
    // For the GET page, we just show the form.
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Aegira device approval</title>
        <meta name="robots" content="noindex, nofollow">
        <style>
          :root {
            --bg-color: #0f172a;
            --text-color: #e2e8f0;
            --accent-color: #34d399;
            --card-bg: #1e293b;
            --card-border: #34d399;
            --radius-button: 9999px;
            --radius-card: 12px;
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
            max-width: 400px;
            margin: 0 auto;
            padding: 0 1rem;
          }
          h1 {
            font-size: 2rem;
            margin-bottom: 1rem;
          }
          .form-group {
            margin-bottom: 1.5rem;
          }
          label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
          }
          input[type="text"] {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid var(--card-border);
            border-radius: var(--radius-card);
            background: var(--input-bg);
            color: var(--input-text);
          }
          .button-group {
            display: flex;
            gap: 1rem;
            flex-wrap: wrap;
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
        </style>
        <script nonce="${nonceBase64}">
          // We'll put the JavaScript for the device page here.
          document.addEventListener('DOMContentLoaded', () => {
            const codeInput = document.getElementById('device-code');
            const submitButton = document.getElementById('submit-code');
            const resultLine = document.getElementById('result-line');
            const approvalSection = document.getElementById('approval-section');
            const agentNameEl = document.getElementById('agent-name');
            const actionsEl = document.getElementById('actions');
            const expiryEl = document.getElementById('expiry');
            const approveButton = document.getElementById('approve-button');
            const denyButton = document.getElementById('deny-button');

            let deviceCode = '';

            // Handle code input.
            if (codeInput && submitButton) {
              submitButton.addEventListener('click', async () => {
                deviceCode = codeInput.value.trim();
                // Validate format: XXXX-XXXX
                if (!/^[0-9A-F]{4}-[0-9A-F]{4}$/i.test(deviceCode)) {
                  resultLine.textContent = 'Invalid code format. Use XXXX-XXXX.';
                  resultLine.className = 'result-line error';
                  return;
                }
                // We'll check the code with the backend.
                try {
                  const response = await fetch('/v1/device/code', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    }
                  });
                  if (response.ok) {
                    const data = await response.json();
                    // Show the agent name, actions, and expiry.
                    agentNameEl.textContent = data.agent_name || 'Unknown';
                    actionsEl.textContent = data.actions || 'None';
                    expiryEl.textContent = new Date(data.expires_at * 1000).toLocaleString();
                    approvalSection.style.display = 'block';
                    resultLine.textContent = '';
                    resultLine.className = '';
                  } else {
                    const error = await response.json();
                    resultLine.textContent = \`Error: \${error.error?.message || 'Unknown error'}\`;
                    resultLine.className = 'result-line error';
                    approvalSection.style.display = 'none';
                  }
                } catch (err) {
                  resultLine.textContent = 'Failed to connect to server.';
                  resultLine.className = 'result-line error';
                  approvalSection.style.display = 'none';
                }
              });
            }

            // Handle approve/deny buttons.
            if (approveButton && denyButton) {
              const makeDecision = async (decision) => {
                if (!deviceCode) {
                  resultLine.textContent = 'No code entered.';
                  resultLine.className = 'result-line error';
                  return;
                }
                try {
                  const response = await fetch('/v1/device/approve', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ user_code: deviceCode, decision })
                  });
                  if (response.ok) {
                    const data = await response.json();
                    if (data.api_key) {
                      // We should not show the API key here; the instruction says never reveal an api_key on this endpoint's response page.
                      // Instead, we tell the user to poll /v1/device/token.
                      resultLine.textContent = 'Approval successful. Poll /v1/device/token for the API key.';
                      resultLine.className = 'result-line success';
                    } else {
                      resultLine.textContent = decision === 'approve' ? 'Approved.' : 'Denied.';
                      resultLine.className = 'result-line success';
                    }
                    // Clear the code and hide the approval section.
                    codeInput.value = '';
                    approvalSection.style.display = 'none';
                  } else {
                    const error = await response.json();
                    resultLine.textContent = \`Error: \${error.error?.message || 'Unknown error'}\`;
                    resultLine.className = 'result-line error';
                  }
                } catch (err) {
                  resultLine.textContent = 'Failed to connect to server.';
                  resultLine.className = 'result-line error';
                }
              };
              approveButton.addEventListener('click', () => makeDecision('approve'));
              denyButton.addEventListener('click', () => makeDecision('deny'));
            }
          });
        </script>
      </head>
      <body>
        <div class="container">
          <h1>Aegira device approval</h1>
          <div class="form-group">
            <label for="device-code">Device code</label>
            <input type="text" id="device-code" placeholder="Enter the device code (XXXX-XXXX)" />
            <button id="submit-code">Submit</button>
          </div>
          <div id="approval-section" style="display: none;">
            <div class="form-group">
              <label for="agent-name">Agent name</label>
              <p id="agent-name">—</p>
            </div>
            <div class="form-group">
              <label for="actions">Requested actions</label>
              <p id="actions">—</p>
            </div>
            <div class="form-group">
              <label for="expiry">Expires at</label>
              <p id="expiry">—</p>
            </div>
            <div class="button-group">
              <button id="approve-button">Approve</button>
              <button id="deny-button">Deny</button>
            </div>
          </div>
          <div class="result-line" id="result-line" aria-live="polite"></div>
        </div>
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
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonceBase64}'; style-src 'nonce-${nonceBase64}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      }
    });
  }

  // Note: The /v1/device/approve endpoint is now handled in handleApiRequest.
  // We keep this fallback for safety, but it should never be reached.
  if (request.method === 'POST' && path === '/v1/device/approve') {
    // This should be handled by handleApiRequest, but we keep a fallback.
    return handleApiRequest(request, env, ctx);
  }

  // If we reach here, the method is not supported.
  return notFound();
}
export { handleApiRequest, handleAdminPage, handleDevicePage };
