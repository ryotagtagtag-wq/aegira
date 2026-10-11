// src/errors.js
export function notFound(message = 'Not Found') {
  return new Response(message, { status: 404 });
}

export function badRequest(message = 'Bad Request') {
  return new Response(message, { status: 400 });
}

export function unauthorized(message = 'Unauthorized') {
  return new Response(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="aegira-admin", charset="UTF-8"'
    }
  });
}

export function forbidden(message = 'Forbidden') {
  return new Response(message, { status: 403 });
}

export function registrationClosed(message = 'Registration is closed.') {
  return new Response(JSON.stringify({ error: { code: 'registration_closed', message } }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function invalidOrExpired(message = 'Invalid or expired code') {
  return new Response(JSON.stringify({ error: { code: 'invalid_or_expired', message } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function alreadyUsed(message = 'Already used') {
  return new Response(JSON.stringify({ error: { code: 'already_used', message } }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function internalError(message = 'Internal Server Error') {
  return new Response(message, { status: 500 });
}
