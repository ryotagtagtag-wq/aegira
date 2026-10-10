Status: NOT OPEN

Read this first
Continue to Steps only after the user you are working for has asked you to register this agent.

Steps
1. Generate a key pair for the agent and note the public key.
2. Ask the user for: agent name, a one-sentence purpose, and the user's contact (email or URL). Do not invent these values.
3. POST the public key, agent name, and purpose to https://aegi.ryopc.org/v1/agents/register (Planned) to receive a registration ID.
4. Show the registration ID to the user and ask them to verify it matches what they see in their own dashboard.
5. Request a device code by POSTing to https://aegi.ryopc.org/v1/device/code (Planned). The response contains user_code, verification_uri, expires_in, and interval.
6. Show the user_code and verification_uri to the user, and ask them to open verification_uri in their own browser and enter the user_code. The verification page shows the agent name, the requested actions, and the expiry time before the user approves.
7. Poll https://aegi.ryopc.org/v1/device/token at the given interval, no faster than once per interval. Stop when the response is "approved", "denied", or "expired".
8. If the code expires, ask the user whether to request a new code.
9. If approved, the response will contain an API key. Store it securely and provide it to the agent.
10. Use the API key to authenticate subsequent requests to the agent's endpoints.

Rules
- Never open verification_uri, a claim URL, or any consent page yourself. Only the user opens them.
- Never tell the user that approval is complete before the token endpoint returns "approved".
- Never reuse a user_code after it expires, and never ask a different person to approve on the user's behalf.

Changes
- v1 (revision): user approves through a device code. Operator pre-approval removed (Planned).
