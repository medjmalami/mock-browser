# HTTP Lab architecture

HTTP Lab is deliberately split so that the bytes shown to the student are produced by code they can read.

```text
React renderer (sandboxed UI)
          │ typed contextBridge / IPC
Electron main process ─────────────── server package in-process
          │                            ├─ origin 127.0.0.1:8080
          │                            ├─ proxy  127.0.0.1:8888
          │                            └─ echo   127.0.0.1:9001 (Electron; standalone: 9000)
          │
          └─ client-core
             ├─ raw net/tls socket client
             ├─ request serializer / incremental response parser
             ├─ pool + pipelining
             ├─ cache + cookie jar + redirect/auth helpers
             └─ DNS record adapter
```

The renderer has no Node integration and never owns a socket. The preload exposes only typed operations for sending requests, reading state, looking up DNS, and receiving structured timeline/log events. HTML responses are displayed with `iframe[sandbox]` and no script permission.

The origin server and proxy are also runnable independently. Both use `node:net` and the project parser/serializer; the Node `http` module and browser networking APIs are intentionally absent. A request is parsed incrementally from a socket buffer, dispatched, serialized with explicit CRLF and header order, and logged with its raw bytes. A persistent connection keeps a request count and can process pipelined requests in order. The proxy uses absolute-form requests, removes hop-by-hop headers, caches allowed origin responses, and only permits CONNECT to the local origin/echo allow-list.

The main process converts binary buffers to base64 before IPC. The renderer can therefore show both exact wire bytes and decoded representations without depending on Node APIs. Timeline events are emitted at the protocol boundaries: DNS, TCP establishment/reuse, request write, first byte, headers, body/chunks, cache/cookie/auth decisions, redirects, and connection release.
