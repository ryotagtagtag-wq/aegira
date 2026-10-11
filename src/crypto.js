// src/crypto.js
export async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return hashBuffer; // return ArrayBuffer
}

export async function sha256Hex(message) {
  const hashBuffer = await sha256(message);
  return Array.prototype.map.call(new Uint8Array(hashBuffer), x => ('00' + x.toString(16)).slice(-2)).join('');
}

// Constant-time comparison of two ArrayBuffers (or Uint8Arrays)
export function constantTimeEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  let result = 0;
  for (let i = 0; i < a.byteLength; i++) {
    result |= a[i] - b[i];
  }
  return result === 0;
}

// Constant-time comparison of two strings (by converting to Uint8Array)
export function constantTimeEqualStr(a, b) {
  return constantTimeEqual(
    new TextEncoder().encode(a),
    new TextEncoder().encode(b)
  );
}
