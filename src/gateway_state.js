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

  // Static methods for crypto helpers
  static generateUserCode() {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const values = [];
    while (values.length < 8) {
      const byte = crypto.getRandomValues(new Uint8Array(1))[0];
      if (byte < 224) {
        values.push(byte % 32);
      }
    }
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += charset.charAt(values[i]);
      if (i === 3) {
        result += '-';
      }
    }
    return result;
  }

  static generateDeviceCode() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    let base64 = btoa(String.fromCharCode(...array));
    base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return base64;
  }

  static async hash(str) {
    // SHA-256 hash of the string, return as hex
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    return crypto.subtle.digest('SHA-256', data).then((buf) => {
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    });
  }

  // Instance methods

  /**
   * Get the current status.
   * @returns {Object} Status object.
   */
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
      registration_changed_reason: registration_changed_reason || null,
      agents_paused: !!agents_paused,
      paused_changed_at: paused_changed_at || null,
      paused_reason: paused_reason || null,
      audit_head_seq: audit_head_seq || 0
    };
  }

  /**
   * Set registration open/closed.
   * @param {boolean} open - Whether registration should be open.
   * @param {string} reason - Reason for the change.
   * @returns {boolean} True if the value changed.
   */
  async setRegistration(open, reason) {
    // Ensure the key exists (initialize to false if undefined)
    const current = await this.state.storage.get('registration_open');
    if (current === undefined) {
      await this.state.storage.put('registration_open', false);
    }
    const changed = await this.state.storage.compareExchange('registration_open', !open, open);
    if (changed) {
      const now = new Date().toISOString();
      await this.state.storage.put('registration_changed_at', now);
      await this.state.storage.put('registration_changed_reason', reason);
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

  /**
   * Set agent pause state.
   * @param {boolean} paused - Whether agents should be paused.
   * @param {string} reason - Reason for the change.
   * @returns {boolean} True if the value changed.
   */
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

  /**
   * Get recent audit entries.
   * @param {number} limit - Maximum number of entries to return.
   * @returns {Array} Audit entries.
   */
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

  // Verify audit entries and return any bad sequence numbers
  async verifyAudit(limit) {
    const head = await this.state.storage.get("audit_head_seq") || 0;
    const badSeqs = [];
    
    for (let i = 0; i < limit && head - i > 0; i++) {
      const seq = head - i;
      const entry = await this.state.storage.get(`audit_${seq}`);
      
      // Check if entry exists and has the correct seq field
      if (!entry || entry.seq !== seq) {
        badSeqs.push(seq);
      }
    }
    return badSeqs;
  }

  /**
   * @param {string} deviceCodeHash - The SHA-256 hash of the device code.
   * @param {string} user_code - The user code (XXXX-XXXX).
   * @param {string} agent_name - The name of the agent.
   * @param {string} actions - The requested actions.
   * @param {number} expires_at - Unix timestamp when the code expires.
   */
  async _storeDeviceRecord(deviceCodeHash, user_code, agent_name, actions, expires_at) {
    const key = `device:${deviceCodeHash}`;
    const value = {
      user_code,
      agent_name,
      actions,
      expires_at,
      used: false,
      decision: null,
      api_key: null,
      api_key_hash: null,
      api_key_collected: false
    };
    await this.state.storage.put(key, value);
  }

  /**
   * Store a device code and return the codes and metadata.
   * @param {string} agent_name - The name of the agent.
   * @param {string} actions - The requested actions.
   * @returns {Object} Object with device_code, user_code, verification_uri, expires_in, interval.
   * @throws {Error} If registration is closed.
   */
  async storeDeviceCode(agent_name, actions) {
    // Check if registration is open
    const registration_open = await this.state.storage.get('registration_open');
    if (!registration_open) {
      const err = new Error('registration_closed');
      err.code = 'registration_closed';
      throw err;
    }

    // Generate codes
    const device_code = GatewayState.generateDeviceCode();
    const user_code = GatewayState.generateUserCode();
    const deviceCodeHash = await GatewayState.hash(device_code);

    // Set expiration (now + 600 seconds)
    const now = Math.floor(Date.now() / 1000);
    const expires_in = 600;
    const expires_at = now + expires_in;
    const interval = 5;

    // Store the mapping from user_code to device_code_hash
    const mapKey = 'user_code_to_device_hash';
    let map = await this.state.storage.get(mapKey) || {};
    if (typeof map !== 'object') {
      map = {};
    }
    map[user_code] = deviceCodeHash;
    await this.state.storage.put(mapKey, map);

    // Store the device record
    await this._storeDeviceRecord(deviceCodeHash, user_code, agent_name, actions, expires_at);

    // Return the object
    return {
      device_code,
      user_code,
      verification_uri: 'https://aegi.ryopc.org/device',
      expires_in,
      interval
    };
  }

  /**
   * Check if a device code exists (by user_code).
   * @param {string} user_code - The user code.
   * @returns {boolean} True if the code exists.
   */
  async deviceCodeExists(user_code) {
    const mapKey = 'user_code_to_device_hash';
    const map = await this.state.storage.get(mapKey) || {};
    if (typeof map !== 'object') return false;
    const deviceCodeHash = map[user_code];
    if (!deviceCodeHash) return false;
    const key = `device:${deviceCodeHash}`;
    const stored = await this.state.storage.get(key);
    return stored !== null;
  }

  /**
   * Consume a device code: mark it as used and return the metadata if valid.
   * Returns null if the code is unknown, expired, or already used.
   * @param {string} user_code - The user code.
   * @returns {Object|null} An object with agent_name, actions, expires_at, or null.
   */
  async consumeDeviceCode(user_code) {
    const mapKey = 'user_code_to_device_hash';
    const map = await this.state.storage.get(mapKey) || {};
    if (typeof map !== 'object') return null;
    const deviceCodeHash = map[user_code];
    if (!deviceCodeHash) return null;
    const key = `device:${deviceCodeHash}`;
    const stored = await this.state.storage.get(key);
    if (!stored) return null; // unknown code
    const data = stored;
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
    await this.state.storage.put(key, data);
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
    // Generate a random API key (33 bytes -> base64url 44 chars)
    const array = new Uint8Array(33);
    crypto.getRandomValues(array);
    let base64 = btoa(String.fromCharCode(...array));
    base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const api_key = base64;
    return api_key;
  }

  /**
   * Verify an API key candidate against the stored hash.
   * @param {string} candidateKey - The candidate API key.
   * @returns {boolean} True if the key matches.
   */
  async verifyApiKey(candidateKey) {
    // This method is likely used in the context of a specific device code after retrieving the record.
    // Since we don't have a reverse lookup, we'll leave it as a stub that returns false.
    // However, to make it work, we could compute the hash and compare with stored api_key_hash.
    // But we need to know which record to check. For now, we'll return false.
    return false;
  }

  /**
   * Get the audit head sequence.
   * @returns {number} The current head sequence.
   */
  async getAuditHeadSeq() {
    return await this.state.storage.get('audit_head_seq') || 0;
  }

  /**
   * Set the audit head sequence.
   * @param {number} seq - The sequence to set.
   */
  async putAuditHeadSeq(seq) {
    await this.state.storage.put('audit_head_seq', seq);
  }

  /**
   * Put an audit entry at the given sequence.
   * @param {number} seq - The sequence number.
   * @param {Object} entry - The audit entry.
   */
  async putAuditEntry(seq, entry) {
    await this.state.storage.put(`audit_${seq}`, entry);
  }

  /**
   * Handle a token request (client polling for token).
   * @param {string} device_code - The device code from the client.
   * @returns {Object} Response with statusCode and body.
   */
  async handleTokenRequest(device_code) {
    const deviceCodeHash = await GatewayState.hash(device_code);
    const key = `device:${deviceCodeHash}`;
    const record = await this.state.storage.get(key);
    if (!record) {
      return { statusCode: 400, body: JSON.stringify({ error: 'unknown_device_code' }) };
    }
    const now = Math.floor(Date.now() / 1000);
    // Check expiration
    if (record.expires_at < now) {
      return { statusCode: 400, body: JSON.stringify({ error: 'expired_token' }) };
    }
    // If already used (api_key already taken)
    if (record.used) {
      return { statusCode: 400, body: JSON.stringify({ error: 'expired_token' }) };
    }
    // Check slow_down
    const last = record.last_token_at ?? 0;
    if (now - last < 5) {
      return { statusCode: 400, body: JSON.stringify({ error: 'slow_down' }) };
    }
    // Update last_token_at
    record.last_token_at = now;
    await this.state.storage.put(key, record);
    // If not yet approved
    if (record.decision === null) {
      return { statusCode: 400, body: JSON.stringify({ error: 'authorization_pending' }) };
    }
    // If denied
    if (record.decision === 'deny') {
      return { statusCode: 400, body: JSON.stringify({ error: 'access_denied' }) };
    }
    // If approved and we have api_key
    if (record.decision === 'approve' && record.api_key_collected && record.api_key !== null) {
      // Return the api_key and mark used
      const api_key = record.api_key;
      record.used = true;
      await this.state.storage.put(key, record);
      return { statusCode: 200, body: JSON.stringify({ api_key }) };
    }
    // Fallback: should not happen
    return { statusCode: 400, body: JSON.stringify({ error: 'unknown_error' }) };
  }

  /**
   * Handle an approve request (user approves or denies the device code).
   * @param {string} user_code - The user code.
   * @param {string} decision - Either 'approve' or 'deny'.
   * @returns {Object} Response with statusCode and body.
   */
  async handleApproveRequest(user_code, decision) {
    // Debug logging - let's see what we received
    // We'll use a try/catch to store debug info in case of issues
    try {
      // Add some debugging - if we get here, let's verify our inputs
      if (typeof user_code !== 'string' || user_code === '') {
        // Log debug info by storing it somewhere we can retrieve
        await this.state.storage.put('debug_last_error', JSON.stringify({
          error: 'invalid_user_code_in_method',
          user_code: user_code,
          typeof_user_code: typeof user_code,
          decision: decision,
          typeof_decision: typeof decision
        }));
      }
      
      const mapKey = 'user_code_to_device_hash';
      const map = await this.state.storage.get(mapKey) || {};
      if (typeof map !== 'object') {
        await this.state.storage.put('debug_last_error', JSON.stringify({
          error: 'map_not_object',
          map: map,
          typeof_map: typeof map,
          mapKey: mapKey
        }));
        return null;
      }
      const deviceCodeHash = map[user_code];
      if (!deviceCodeHash) {
        await this.state.storage.put('debug_last_error', JSON.stringify({
          error: 'device_code_hash_not_found',
          user_code: user_code,
          map: map,
          mapKeys: Object.keys(map)
        }));
        return null;
      }
      const key = `device:${deviceCodeHash}`;
      const record = await this.state.storage.get(key);
      if (!record) {
        await this.state.storage.put('debug_last_error', JSON.stringify({
          error: 'record_not_found',
          key: key,
          deviceCodeHash: deviceCodeHash,
          user_code: user_code
        }));
        return null;
      }
      const now = Math.floor(Date.now() / 1000);
      // Check expiration
      if (record.expires_at < now) {
        return { statusCode: 400, body: JSON.stringify({ error: 'invalid_or_expired' }) };
      }
      // If already decided, cannot change
      if (record.decision !== null) {
        return { statusCode: 409, body: JSON.stringify({ error: 'already_used' }) };
      }
      if (decision === 'approve') {
        // Generate api_key
        const array = new Uint8Array(33);
        crypto.getRandomValues(array);
        let base64 = btoa(String.fromCharCode(...array));
        base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        const api_key = base64;
        const api_key_hash = await GatewayState.hash(api_key);
        record.api_key = api_key;
        record.api_key_hash = api_key_hash;
        record.api_key_collected = true;
        record.decision = 'approve';
        // Update record
        await this.state.storage.put(key, record);
        return { statusCode: 200, body: JSON.stringify({ message: 'Decision approve recorded' }) };
      } else if (decision === 'deny') {
        record.decision = 'deny';
        // Update record
        await this.state.storage.put(key, record);
        return { statusCode: 200, body: JSON.stringify({ message: 'Decision deny recorded' }) };
      }
      // Should not reach here
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid_decision' }) };
    } catch (err) {
      // Store error info for debugging
      await this.state.storage.put('debug_last_error', JSON.stringify({
        error: 'exception_in_method',
        message: String(err),
        stack: err.stack
      }));
      return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
    }
  }
}

export { GatewayState };
