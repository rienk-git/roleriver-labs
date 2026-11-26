# Google identity and separate Gmail consent

Status: accepted.

## Context

The static dashboard and independent API need authenticated ownership, while manual import and the personal CLI must work without Gmail access. Gmail read-only is a restricted, broad mailbox grant.

## Alternatives

Local passwords, Cognito, additional identity providers, a combined sign-in/mailbox grant, or unauthenticated public access to private data.

## Decision

Initially use direct Google OIDC only for sign-in, with minimum `openid`, `email`, `profile` scopes as needed. Map validated issuer and subject (`iss`, `sub`) to an internal user ID, never email as the primary key. A separate optional Connect Gmail action requests incremental `gmail.readonly` consent and offline access. Bind the connection to the authenticated user, explicitly confirm a different mailbox identity, and support disconnect, revocation and reconnect without a new account. No Gmail send/modify permission. Manual import works without Gmail consent.

## Consequences

The independent BFF with a server-side token store and an HttpOnly application session cookie is the recommended approach for the dashboard: it keeps Google tokens out of browser JavaScript and supports Gmail synchronization when the user is absent. [RFC 10017, OAuth 2.0 for Browser-Based Applications §6.1.4.3](https://datatracker.ietf.org/doc/html/rfc10017#section-6.1.4.3), strongly recommends the BFF architecture for applications handling personal data. See also [Google web-server OAuth guidance](https://developers.google.com/identity/protocols/oauth2/web-server) for offline access and server-side token refresh. HttpOnly alone does not prevent an injected script from making authenticated requests; CSRF and XSS defenses remain necessary. Background workers need narrowly controlled credential access independent of the browser session.

An independently deployed TypeScript backend-for-frontend (BFF), which may be part of the API, owns OAuth callbacks, token isolation, session issuance and authorization. The static Next.js export contains no runtime BFF. The browser holds an opaque application session identifier in a Secure, HttpOnly cookie with a reviewed SameSite policy, scope and lifetime; the Gmail refresh token remains encrypted server-side and is never placed in the cookie. The BFF refreshes provider tokens server-side when needed and handles refresh failure and revocation. Architect and security must review a concrete standards-based flow before implementation: supported Google libraries, authorization code with PKCE where applicable, state, exact redirect URI and ID-token signature, issuer, audience, expiry and nonce as applicable. Use same-origin routing where practical; protect cookie-authenticated state-changing requests against CSRF, including in same-origin deployments, and explicitly configure CORS and credential policies where origins differ. Review session rotation, expiry and logout. Never put Gmail refresh tokens, client secrets or long-lived credentials in browser storage; never use a Gmail access token as the app session. Encrypt refresh tokens server-side with restricted separate access and KMS-backed protection in AWS; do not store plaintext token attributes. Handle expiry, refresh failure and revocation.

Public demo is synthetic and requires no login; self-hosters provide their own OAuth and AI configuration and must understand consent-screen, test-user and token-lifetime limits. Hosted multi-user mode is deferred pending Google policy, verification and security obligations. Labels and queries restrict processing, not the broad OAuth grant. Before sending mailbox-derived content to an AI provider, evaluate applicable Google policies, disclosures, consent and processor handling; if compliance cannot be established, keep it local or use manual import.

## Revisit

Reconsider identity providers, session mechanism and hosted distribution after a concrete need and security/policy review.
