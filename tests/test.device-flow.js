import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { GatewayState } from '../src/gateway_state.js';

// Mock Durable Object state that provides a storage object with the expected interface.
class MockState {
  constructor() {
    // This is the storage object that will be accessed via state.storage
    this.storage = new Map();
    // Add the required methods to the storage object.
    this.storage.get = async (key) => {
      if (Array.isArray(key)) {
        return await Promise.all(key.map(k => this.storage.get(k)));
      }
      return Map.prototype.get.call(this.storage, key);
    };
    this.storage.put = async (key, value) => {
      Map.prototype.set.call(this.storage, key, value);
    };
    this.storage.delete = async (key) => {
      Map.prototype.delete.call(this.storage, key);
    };
    this.storage.compareExchange = async (key, oldValue, newValue) => {
      const currentValue = await this.storage.get(key);
      if (currentValue === oldValue) {
        await this.storage.put(key, newValue);
        return true;
      }
      return false;
    };
  }
}

// Mock env
const mockEnv = {};

describe('GatewayState', () => {
  let state;
  let stub;

  beforeEach(() => {
    state = new MockState();
    stub = new GatewayState(state, mockEnv);
  });

  describe('crypto helper methods', () => {
    it('should generate a user code in the correct format', async () => {
      const userCode = GatewayState.generateUserCode();
      assert.strictEqual(typeof userCode, 'string');
      assert.strictEqual(userCode.length, 9);
      assert.strictEqual(userCode.charAt(4), '-');
      const parts = userCode.split('-');
      assert.strictEqual(parts.length, 2);
      assert.strictEqual(parts[0].length, 4);
      assert.strictEqual(parts[1].length, 4);
      const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (const part of parts) {
        for (const char of part) {
          assert.ok(charset.includes(char), `Invalid char ${char} in user code part ${part}`);
        }
      }
    });

    it('should generate a device code that is base64url', async () => {
      const deviceCode = GatewayState.generateDeviceCode();
      assert.strictEqual(typeof deviceCode, 'string');
      assert.ok(/^[A-Za-z0-9_-]+$/.test(deviceCode));
      assert.strictEqual(deviceCode.length, 43);
    });

    it('should hash a string to a 64-character hex string', async () => {
      const hash = await GatewayState.hash('test');
      assert.strictEqual(typeof hash, 'string');
      assert.strictEqual(hash.length, 64);
      assert.ok(/^[0-9a-f]+$/.test(hash));
    });
  });

  describe('registration', () => {
    it('should return closed by default', async () => {
      const status = await stub.getStatus();
      assert.strictEqual(status.registration, 'closed');
    });

    it('should be able to open and close registration', async () => {
      const changedOpen = await stub.setRegistration(true, 'Test reason');
      assert.strictEqual(changedOpen, true);
      const statusAfterOpen = await stub.getStatus();
      assert.strictEqual(statusAfterOpen.registration, 'open');
      assert.strictEqual(statusAfterOpen.registration_changed_reason, 'Test reason');

      const changedClose = await stub.setRegistration(false, 'Another reason');
      assert.strictEqual(changedClose, true);
      const statusAfterClose = await stub.getStatus();
      assert.strictEqual(statusAfterClose.registration, 'closed');
      assert.strictEqual(statusAfterClose.registration_changed_reason, 'Another reason');
    });

    it('should not change if already in the requested state', async () => {
      await stub.setRegistration(true, 'Reason 1');
      const changedOpen = await stub.setRegistration(true, 'Reason 2');
      assert.strictEqual(changedOpen, false);
      const status = await stub.getStatus();
      assert.strictEqual(status.registration_changed_reason, 'Reason 1');
    });
  });

  describe('device code flow', () => {
    it('should return registration_closed when registration is closed', async () => {
      let error = null;
      try {
        await stub.storeDeviceCode('test-agent', 'test-actions');
      } catch (err) {
        error = err;
      }
      assert.ok(error);
      assert.strictEqual(error.message, 'registration_closed');
    });

    it('should generate a device code when registration is open', async () => {
      await stub.setRegistration(true, 'Test reason');

      const result = await stub.storeDeviceCode('test-agent', 'test-actions');
      assert.ok(result.device_code);
      assert.ok(result.user_code);
      assert.strictEqual(result.verification_uri, 'https://aegi.ryopc.org/device');
      assert.strictEqual(result.expires_in, 600);
      assert.strictEqual(result.interval, 5);

      const deviceCodeHash = await GatewayState.hash(result.device_code);
      const record = await state.storage.get(`device:${deviceCodeHash}`);
      assert.ok(record);
      assert.strictEqual(record.agent_name, 'test-agent');
      assert.strictEqual(record.actions, 'test-actions');
      assert.strictEqual(record.user_code, result.user_code);
      assert.strictEqual(record.decision, null);
      assert.strictEqual(record.api_key_hash, null);
      assert.strictEqual(record.api_key_collected, false);
    });

    it('should not allow duplicate user codes', async () => {
      await stub.setRegistration(true, 'Test reason');

      const result1 = await stub.storeDeviceCode('agent1', 'actions1');
      const result2 = await stub.storeDeviceCode('agent2', 'actions2');
      assert.notStrictEqual(result1.user_code, result2.user_code);

      const userCodeMap = await state.storage.get('user_code_to_device_hash');
      assert.ok(userCodeMap);
      assert.strictEqual(Object.keys(userCodeMap).length, 2);
    });
  });

  describe('token endpoint', () => {
    it('should return authorization_pending before approval', async () => {
      await stub.setRegistration(true, 'Test reason');
      const { device_code } = await stub.storeDeviceCode('test-agent', 'test-actions');

      const result = await stub.handleTokenRequest(device_code);
      assert.strictEqual(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.strictEqual(body.error, 'authorization_pending');
    });

    it('should return slow_down when polled too fast', async () => {
      await stub.setRegistration(true, 'Test reason');
      const { device_code } = await stub.storeDeviceCode('test-agent', 'test-actions');

      await stub.handleTokenRequest(device_code);
      const result = await stub.handleTokenRequest(device_code);
      assert.strictEqual(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.strictEqual(body.error, 'slow_down');
    });

    it('should return api_key exactly once on approval', async () => {
      await stub.setRegistration(true, 'Test reason');
      const { device_code, user_code } = await stub.storeDeviceCode('test-agent', 'test-actions');

      await stub.handleApproveRequest(user_code, 'approve');

      let result = await stub.handleTokenRequest(device_code);
      assert.strictEqual(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.ok(body.api_key);
      assert.strictEqual(typeof body.api_key, 'string');
      assert.strictEqual(body.api_key.length, 44);

      result = await stub.handleTokenRequest(device_code);
      assert.strictEqual(result.statusCode, 400);
      const body2 = JSON.parse(result.body);
      assert.strictEqual(body2.error, 'expired_token');
    });

    it('should return access_denied on deny', async () => {
      await stub.setRegistration(true, 'Test reason');
      const { device_code } = await stub.storeDeviceCode('test-agent', 'test-actions');

      const deviceCodeHash = await GatewayState.hash(device_code);
      const record = await state.storage.get(`device:${deviceCodeHash}`);
      const user_code = record.user_code;

      await stub.handleApproveRequest(user_code, 'deny');

      const result = await stub.handleTokenRequest(device_code);
      assert.strictEqual(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.strictEqual(body.error, 'access_denied');
    });
  });



  describe('approve endpoint', () => {
  let stub;
  let state;

  beforeEach(() => {
    state = new MockState();
    stub = new GatewayState(state, {});
  });

    it('should return already_used on second decision', async () => {
      await stub.setRegistration(true, 'Test reason');
      const { device_code } = await stub.storeDeviceCode('test-agent', 'test-actions');
      const deviceCodeHash = await GatewayState.hash(device_code);
      const record = await state.storage.get(`device:${deviceCodeHash}`);
      const user_code = record.user_code;

      let result = await stub.handleApproveRequest(user_code, 'approve');
      assert.strictEqual(result.statusCode, 200);

      result = await stub.handleApproveRequest(user_code, 'approve');
      assert.strictEqual(result.statusCode, 409);
      const body = JSON.parse(result.body);
      assert.strictEqual(body.error, 'already_used');

      result = await stub.handleApproveRequest(user_code, 'deny');
      assert.strictEqual(result.statusCode, 409);
      const body2 = JSON.parse(result.body);
      assert.strictEqual(body2.error, 'already_used');
    });

    it('should return invalid_or_expired if the device code has expired', async () => {
      await stub.setRegistration(true, 'Test reason');
      const { device_code } = await stub.storeDeviceCode('test-agent', 'test-actions');
      const deviceCodeHash = await GatewayState.hash(device_code);
      const record = await state.storage.get(`device:${deviceCodeHash}`);
      const user_code = record.user_code;

      record.expires_at = Math.floor(Date.now() / 1000) - 10;
      await state.storage.put(`device:${deviceCodeHash}`, record);

      const result = await stub.handleApproveRequest(user_code, 'approve');
      assert.strictEqual(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.strictEqual(body.error, 'invalid_or_expired');
    });
  });

  describe('audit', () => {
  let stub;
  let state;

  beforeEach(() => {
    state = new MockState();
    stub = new GatewayState(state, {});
  });

    it('should increment audit head on registration change', async () => {
      const initialHead = await state.storage.get('audit_head_seq') || 0;
      await stub.setRegistration(true, 'Reason');
      const newHead = await state.storage.get('audit_head_seq');
      assert.strictEqual(newHead, initialHead + 1);
    });

    it('should store audit entries', async () => {
      await stub.setRegistration(true, 'Reason 1');
      await stub.setRegistration(false, 'Reason 2');

      const head = await state.storage.get('audit_head_seq');
      assert.strictEqual(head, 2);

      const entry1 = await state.storage.get('audit_1');
      assert.ok(entry1);
      assert.strictEqual(entry1.event, 'registration.changed');
      assert.strictEqual(entry1.decision, 'open');
      assert.strictEqual(entry1.summary, 'Reason 1');

      const entry2 = await state.storage.get('audit_2');
      assert.ok(entry2);
      assert.strictEqual(entry2.event, 'registration.changed');
      assert.strictEqual(entry2.decision, 'closed');
      assert.strictEqual(entry2.summary, 'Reason 2');
    });
  });
});

// Now test the worker's API handling
import { handleApiRequest, handleAdminPage, handleDevicePage } from '../src/worker/index.js';

describe('Worker API handling', () => {
  let stub;
  let state;

  let mockEnv;
  let mockCtx;

  beforeEach(() => {
    state = new MockState();
    stub = new GatewayState(state, {});
    mockEnv = {
      GATEWAY_STATE: {
        idFromName: () => 'fake-id',
        get: (id) => {
          assert.strictEqual(id, 'fake-id');
          return stub;
        }
      },
      AEGIRA_ADMIN_PASSWORD: 'test-password',
      AEGIRA_ADMIN_KEY: 'test-admin-key',
      AEGIRA_ADMIN_ALLOW_IPS: ''
    };
    mockCtx = {};
  });

  function createRequest(url, method = 'GET', body = null, headers = {}) {
    const init = {
      method,
      headers: new Headers(headers)
    };
    if (body !== null) {
      init.body = JSON.stringify(body);
    }
    return new Request(url, init);
  }

  it('/v1/status should return the status', async () => {
    await stub.setRegistration(true, 'Test reason');

    const request = createRequest('http://example.com/v1/status');
    const response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.strictEqual(data.registration, 'open');
    assert.strictEqual(data.registration_changed_reason, 'Test reason');
  });

  it('/v1/device/code should return device code when registration is open', async () => {
    await stub.setRegistration(true, 'Test reason');

    const request = createRequest('http://example.com/v1/device/code', 'POST', {
      agent_name: 'test-agent',
      actions: 'test-actions'
    });
    const response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.ok(data.device_code);
    assert.ok(data.user_code);
    assert.strictEqual(data.verification_uri, 'https://aegi.ryopc.org/device');
    assert.strictEqual(data.expires_in, 600);
    assert.strictEqual(data.interval, 5);
  });

  it('/v1/device/code should return registration_closed when registration is closed', async () => {
    const request = createRequest('http://example.com/v1/device/code', 'POST', {
      agent_name: 'test-agent',
      actions: 'test-actions'
    });
    const response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 403);
    const data = await response.json();
    assert.strictEqual(data.error.code, 'registration_closed');
  });

  it('/v1/device/token should return authorization_pending before approval', async () => {
    await stub.setRegistration(true, 'Test reason');
    const { device_code } = await stub.storeDeviceCode('test-agent', 'test-actions');

    const request = createRequest('http://example.com/v1/device/token', 'POST', {
      device_code
    });
    const response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 400);
    const data = await response.json();
    assert.strictEqual(data.error, 'authorization_pending');
  });

  it('/v1/device/token should return api_key once on approval', async () => {
    await stub.setRegistration(true, 'Test reason');
    const { device_code, user_code } = await stub.storeDeviceCode('test-agent', 'test-actions');

    await stub.handleApproveRequest(user_code, 'approve');

    let request = createRequest('http://example.com/v1/device/token', 'POST', {
      device_code
    });
    let response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.ok(data.api_key);

    request = createRequest('http://example.com/v1/device/token', 'POST', {
      device_code
    });
    response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 400);
    const data2 = await response.json();
    assert.strictEqual(data2.error, 'expired_token');
  });

  it('/v1/device/approve should approve and deny', async () => {
    await stub.setRegistration(true, 'Test reason');
    const { device_code } = await stub.storeDeviceCode('test-agent', 'test-actions');
    const deviceCodeHash = await GatewayState.hash(device_code);
    const record = await state.storage.get(`device:${deviceCodeHash}`);
    const user_code = record.user_code;

    let request = createRequest('http://example.com/v1/device/approve', 'POST', {
      user_code,
      decision: 'approve'
    });
    let response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.strictEqual(data.message, 'Decision approve recorded');

    const updatedRecord = await state.storage.get(`device:${deviceCodeHash}`);
    assert.strictEqual(updatedRecord.decision, 'approve');

    request = createRequest('http://example.com/v1/device/approve', 'POST', {
      user_code,
      decision: 'approve'
    });
    response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 409);
    const data2 = await response.json();
    assert.strictEqual(data2.error, 'already_used');

    const { device_code: device_code2 } = await stub.storeDeviceCode('test-agent2', 'test-actions2');
    const deviceCodeHash2 = await GatewayState.hash(device_code2);
    const record2 = await state.storage.get(`device:${deviceCodeHash2}`);
    const user_code2 = record2.user_code;

    request = createRequest('http://example.com/v1/device/approve', 'POST', {
      user_code: user_code2,
      decision: 'deny'
    });
    response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 200);
    const data3 = await response.json();
    assert.strictEqual(data3.message, 'Decision deny recorded');

    const updatedRecord2 = await state.storage.get(`device:${deviceCodeHash2}`);
    assert.strictEqual(updatedRecord2.decision, 'deny');
  });

  it('/admin page should return 401 with wrong password', async () => {
    const request = createRequest('http://example.com/admin');
    const wrongCredentials = btoa('user:wrong-password');
    const headers = new Headers({
      'Authorization': `Basic ${wrongCredentials}`
    });
    const requestWithHeaders = new Request('http://example.com/admin', {
      method: 'GET',
      headers
    });

    const response = await handleAdminPage(requestWithHeaders, mockEnv, mockCtx);
    assert.strictEqual(response.status, 401);
  });

  it('/admin page should return 200 with correct password', async () => {
    const request = createRequest('http://example.com/admin');
    const correctCredentials = btoa('user:test-password');
    const headers = new Headers({
      'Authorization': `Basic ${correctCredentials}`
    });
    const requestWithHeaders = new Request('http://example.com/admin', {
      method: 'GET',
      headers
    });

    const response = await handleAdminPage(requestWithHeaders, mockEnv, mockCtx);
    assert.strictEqual(response.status, 200);
  });

  it('/device page should return the form', async () => {
    const request = createRequest('http://example.com/device');
    const response = await handleDevicePage(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes('<h1>Aegira device approval</h1>'));
  });
  it('/admin returns 503 when AEGIRA_ADMIN_PASSWORD is unset', async () => {
    const request = createRequest('http://example.com/admin');
    const mockEnvNoPassword = {
      GATEWAY_STATE: {
        idFromName: () => 'fake-id',
        get: (id) => {
          assert.strictEqual(id, 'fake-id');
          return stub;
        }
      },
      AEGIRA_ADMIN_KEY: 'test-admin-key',
      AEGIRA_ADMIN_ALLOW_IPS: ''
    };
    const mockCtx = {};
    const requestWithHeaders = new Request('http://example.com/admin', {
      method: 'GET',
      headers: new Headers()
    });

    const response = await handleAdminPage(requestWithHeaders, mockEnvNoPassword, mockCtx);
    assert.strictEqual(response.status, 503);
  });

  it('Tampering with one stored audit entry makes GET /v1/audit/verify report the bad seq', async () => {
    // Generate three audit entries by toggling registration
    await stub.setRegistration(true, 'reason1');
    await stub.setRegistration(false, 'reason2');
    await stub.setRegistration(true, 'reason3');

    // Get the current head
    const head = await state.storage.get('audit_head_seq');
    // We'll tamper with the second most recent entry (head - 1)
    const seqToTamper = head - 1;
    const entry = await state.storage.get(`audit_${seqToTamper}`);
    // Tamper: change the seq field to something else
    entry.seq = seqToTamper + 999;
    await state.storage.put(`audit_${seqToTamper}`, entry);

    // Now verify with limit that includes the tampered seq
    const request = createRequest('http://example.com/v1/audit/verify?limit=3');
    const response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 200);
    const badSeqs = await response.json();
    // Expect the array to contain the tampered seq
    assert.deepEqual(badSeqs, [seqToTamper]);
  });

  it('A device code created while registration is closed never yields an api_key, even after registration is later opened', async () => {
    // Registration is closed by default (REGISTRATION_OPEN = false)
    // Create a device code record directly (bypassing storeDeviceCode check)
    const agent_name = 'test-agent';
    const actions = 'test-actions';
    const device_code = GatewayState.generateDeviceCode();
    const user_code = GatewayState.generateUserCode();
    const deviceCodeHash = await GatewayState.hash(device_code);
    const now = Math.floor(Date.now() / 1000);
    const expires_in = 600;
    const expires_at = now + expires_in;

    await stub._storeDeviceRecord(deviceCodeHash, user_code, agent_name, actions, expires_at);

    // Open registration
    await stub.setRegistration(true, 'Opened later');

    // Now attempt to use the device code via token endpoint
    const request = createRequest('http://example.com/v1/device/token', 'POST', {
      device_code
    });
    const response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 400); // Should not be 200 with api_key
    const data = await response.json();
    // Ensure no api_key in response
    assert.strictEqual(data.api_key, undefined);
    // Optionally check error is authorization_pending (since decision is null)
    assert.strictEqual(data.error, 'authorization_pending');
  it('after device code approval, closing registration does not stop api_key delivery and no second api_key', async () => {
    // Registration is open
    await stub.setRegistration(true, 'Open for approval');

    // Create and approve a device code
    const { device_code, user_code } = await stub.storeDeviceCode('test-agent', 'test-actions');
    await stub.handleApproveRequest(user_code, 'approve');

    // Close registration
    await stub.setRegistration(false, 'Closed after approval');

    // Attempt to use the device code via token endpoint - should return api_key once
    let request = createRequest('http://example.com/v1/device/token', 'POST', {
      device_code
    });
    let response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.ok(data.api_key);

    // Second attempt should not return api_key (should be expired_token)
    request = createRequest('http://example.com/v1/device/token', 'POST', {
      device_code
    });
    response = await handleApiRequest(request, mockEnv, mockCtx);
    assert.strictEqual(response.status, 400);
    const data2 = await response.json();
    assert.strictEqual(data2.error, 'expired_token');
  });
  });
});
