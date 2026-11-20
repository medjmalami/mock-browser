# HTTP Lab backend

This directory contains the offline teaching backend for HTTP Lab. It uses only
Node's `net` sockets for HTTP; it does not use `node:http`, `fetch`, axios, or
Express.

## Run

From the repository root, after installing the workspace dependencies:

```sh
npm run server
```

The defaults are:

- origin: `127.0.0.1:8080`
- proxy: `127.0.0.1:8888`
- TCP echo: `127.0.0.1:9000`

Override them with `ORIGIN_PORT`, `PROXY_PORT`, `ECHO_PORT` and the matching
`*_HOST` variables. Set `PROXY_AUTH_USER` and `PROXY_AUTH_PASSWORD` together
to enable the proxy's Basic 407 challenge.

The exported `startLabServices()` API starts all three services and returns
their actual addresses plus an async `stop()` function. Every service accepts
an `onEvent` callback; events include connection IDs, raw request/response
bytes, cache decisions, proxy authentication, and tunnel bytes.

## Routes and teaching defaults

The origin implements the HTTP Lab routes from the project brief, including
static resources, conditional requests, ranges, `/items` CRUD, login sessions,
Basic auth, redirects, negotiation, gzip, chunked/streaming responses,
`/status/:code`, latency/timeout demonstrations, TRACE, a metadata-only binary
`POST /upload` route, and URL-addressable binary uploads. `PUT /uploads/name.ext`
stores the exact request bytes in memory at that path; `GET` or `HEAD` to the
same path serves the stored representation. Repeating the PUT replaces it.
Uploads are cleared when the origin process stops. Login uses
`mohamed` / `hkm4c`; the same credentials protect `/protected/`.

The proxy accepts absolute-form HTTP requests and only forwards to the local
origin. CONNECT is limited to the configured local origin and echo ports.
`Proxy-Authorization` is consumed by the proxy and is never sent upstream.

The optional network smoke test requires a host environment that permits local
socket binding:

```sh
HTTP_LAB_RUN_NETWORK_TESTS=1 npm test --workspace @http-lab/server
```

The default test suite is deterministic and does not require network binding;
it tests the raw parser/serializer and route behavior directly.

