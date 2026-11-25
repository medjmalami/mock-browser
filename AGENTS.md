# HTTP Lab — Agent Guide

## Project purpose

HTTP Lab is an Electron teaching application for ISIMS “Chapitre II: Protocole HTTP”. It must make HTTP exchange details visible: exact request/response bytes, CRLF framing, headers, connection reuse, caching, cookies, redirects, authentication, chunking, proxying, and TCP tunnelling.

## Repository layout

- `client-core/` — raw HTTP/1.x client, incremental parser, serializer, connection pool, cache, cookie jar, DNS helper, and client tests.
- `server/` — handwritten `node:net` origin server, proxy, TCP echo service, protocol helpers, CLI, and server tests.
- `app/` — Electron main process, secure preload, React/Vite renderer, and UI tests/build configuration.
- `docs/ARCHITECTURE.md` — one-page architecture note.
- `DEMO.md` — course demonstration walkthrough.
- `README.md` — user-facing setup and usage instructions.

## Non-negotiable constraints

- Do not use `fetch`, `XMLHttpRequest`, Axios, Express, or Node’s `http` module for the lab protocol implementation.
- All HTTP client/server wire traffic is built and parsed manually on top of `node:net`; use `node:tls` only for an explicit HTTPS enhancement.
- Preserve deliberate CRLF bytes, header order, header casing, request-target form, and raw wire captures.
- Networking belongs in the Electron main process or `client-core`, never in the renderer.
- Keep Electron security enabled: `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer, and a small typed preload API.
- Keep static response HTML in a sandboxed iframe with scripts disabled. The rendered response panel embeds a WebContentsView that may execute scripts in its separate sandboxed session, with no preload or Node access; HTTP/HTTPS traffic must pass through the main-process raw client and remain inspectable.
- Bind lab services to `127.0.0.1` only. The proxy CONNECT allow-list must remain limited to the local origin and echo service.
- Keep the standalone server defaults: origin `8080`, proxy `8888`, echo `9000`.
- Electron defaults the echo service to `9001` to coexist with common Docker mappings; override it with `HTTP_LAB_ECHO_PORT=9000` when needed.

## Common commands

Run from the repository root:

```sh
npm install
npm run build
npm test
npm run typecheck
npm run server
npm start
npm run dev
```

`npm run server` starts the standalone origin, proxy, and echo services. Electron starts its own services, so do not run both when they use the same ports.

Useful standalone checks:

```sh
curl -v http://127.0.0.1:8080/
curl -v -I http://127.0.0.1:8080/
curl -v -X TRACE http://127.0.0.1:8080/
```

## Development workflow

1. Inspect existing code and tests before changing behavior.
2. Make small, readable changes with comments where protocol behavior is non-obvious.
3. Add or update focused tests for parser, serializer, cache, cookies, routes, or IPC behavior.
4. Run the narrowest relevant test first, then `npm test`, `npm run typecheck`, and `npm run build`.
5. Check raw bytes and CRLF framing whenever changing HTTP behavior.
6. Update `README.md`, `docs/ARCHITECTURE.md`, or `DEMO.md` when commands, ports, behavior, or teaching scenarios change.

## Protocol implementation notes

- Support GET, POST, PUT, PATCH, DELETE, HEAD, CONNECT, and TRACE end to end.
- HEAD must use the same headers and `Content-Length` as GET while sending no body.
- 204, 205, and 304 responses have no body; successful CONNECT transitions to tunnel bytes.
- HTTP/1.0 closes by default and HTTP/1.1 persists by default; honor explicit `Connection` directives.
- Parse split TCP packets incrementally and preserve pipelined response ordering.
- Keep proxy `Proxy-Authorization` out of origin requests.
- Keep cache and cookie behavior observable through timeline events and side panels.
- When changing the renderer build, remember that Electron production loads `file://`; Vite needs `base: './'` so assets resolve relatively.

## Git and change hygiene

- Preserve unrelated user changes in a dirty worktree.
- Do not use destructive commands such as `git reset --hard` or broad recursive deletion.
- Prefer focused commits when the repository’s Git metadata is writable.
- Never commit generated `dist/` or dependency directories; `.gitignore` handles them.

