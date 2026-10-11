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

  // Device code handling.

  /**
   * Store a device code with metadata.
   * @param {string} user_code - The device code (XXXX-XXXX).
   * @param {string} agent_name - The name of the agent.
   * @param {string} actions - The requested actions.
   * @param {number} expires_at - Unix timestamp when the code expires.
   */
  async storeDeviceCode(user_code, agent_name, actions, expires_at) {
    // We'll store the device code under a key like `device:${user_code}`.
    const key = `device:${user_code}`;
    const value = JSON.stringify({
      agent_name,
      actions,
      expires_at,
      used: false
    });
    await this.state.storage.put(key, value);
  }

  /**
   * Check if a device code exists (regardless of expiration or usage).
   * @param {string} user_code
   * @returns {boolean}
   */
  async deviceCodeExists(user_code) {
    const key = `device:${user_code}`;
    const stored = await this.state.storage.get(key);
    return stored !== null;
  }

  /**
   * Consume a device code: mark it as used and return the metadata if valid.
   * Returns null if the code is unknown, expired, or already used.
   * @param {string} user_code
   * @returns {Object|null} An object with agent_name, actions, expires_at, or null.
   */
  async consumeDeviceCode(user_code) {
    const key = `device:${user_code}`;
    const stored = await this.state.storage.get(key);
    if (!stored) {
      return null; // unknown code
    }
    const data = JSON.parse(stored);
    const now = Math.floor(Date.now() / 1000);
    if (data.expires_at < now) {
      // Expired: we can optionally delete it.
      await this.state.storage.delete(key);
      return null; // expired
    }
    if (data.used) {
      return null; // already used
    }
    // Mark as used.
    data.used = true;
    await this.state.storage.put(key, JSON.stringify(data));
    return {
      agent_name: data.agent_name,
      actions: data.actions,
      expires_at: data.expires_at
    };
  }

  /**
   * Issue an API key for a successfully approved device code.
   * We will generate a random API key, store its SHA-256 hash, and return the plaintext key only once.
   * We will also write an audit entry.
   * @returns {string} The generated API key.
   */
  async issueApiKey() {
    // Generate a random 32-byte key and encode it in base64.
    const key = crypto.getRandomValues(new Uint8Array(32));
    // We'll store the hash of the key.
    const hashBuffer = await crypto.subtle.digest('SHA-256', key);
    const hashHex = Array.prototype.map.call(new Uint8Array(hashBuffer), x => ('00' + x.toString(16)).slice(-2)).join('');
    // Store the hash under a key like `api_key_hash`.
    // We'll allow only one API key to be issued? The instruction says: approve issues an api_key once.
    // We'll store it under a fixed key, overwriting any previous.
    await this.state.storage.put('api_key_hash', hashHex);
    // Increment audit head seq and store the audit entry for api_key issued.
    const seq = await this.state.storage.get('audit_head_seq') || 0;
    const newSeq = seq + 1;
    await this.state.storage.put('audit_head_seq', newSeq);
    await this.state.storage.put(`audit_${newSeq}`, {
      seq: newSeq,
      time: new Date().toISOString(),
      event: 'api_key.issued',
      actor: 'system',
      decision: 'issued',
      summary: 'API key issued for device approval',
      params_digest: null
    });
    // Return the base64-encoded key.
    return btoa(String.fromCharCode(...key));
  }

  /**
   * Check if a candidate API key matches the stored hash.
   * @param {string} candidateKey - Base64-encoded API key.
   * @returns {boolean}
   */
  async verifyApiKey(candidateKey) {
    const storedHash = await this.state.storage.get('api_key_hash');
    if (!storedHash) {
      return false;
    }
    // Decode the candidate key.
    let keyBytes;
    try {
      keyBytes = new Uint8Array(atob(candidateKey), 'binary');
    } catch (e) {
      return false;
    }
    const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes);
    const hashHex = Array.prototype.map.call(new Uint8Array(hashBuffer), x => ('00' + x.toString(16)).slice(-2)).join('');
    return constantTimeEqualStr(hashHex, storedHash);
  }

  // Audit head sequence helpers.

  /**
   * Get the current audit head sequence.
   * @returns {number}
   */
  async getAuditHeadSeq() {
    return await this.state.storage.get('audit_head_seq') || 0;
  }

  /**
   * Set the audit head sequence.
   * @param {number} seq
   */
  async putAuditHeadSeq(seq) {
    await this.state.storage.put('audit_head_seq', seq);
  }

  /**
   * Store an audit entry at the given sequence number.
   * @param {number} seq
   * @param {Object} entry
   */
  async putAuditEntry(seq, entry) {
    await this.state.storage.put(`audit_${seq}`, JSON.stringify(entry));
  }
}

export { GatewayState };
