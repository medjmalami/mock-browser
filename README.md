# HTTP Lab

HTTP Lab is a small Electron desktop browser/HTTP client for demonstrating the HTTP protocol in a university course. It exposes the request line, exact headers, CRLF framing, body framing, TCP reuse, cookies, cache validators, proxy hops, authentication challenges, and connection lifetime instead of hiding them behind browser APIs.

## Run

Requirements: Node.js 20+ and npm. The project uses npm workspaces.

```bash
npm install
npm run dev       # Vite renderer + Electron + in-process lab servers
npm start         # production renderer + Electron
npm run server    # standalone origin, proxy, and echo services
npm test
```

Ports are configurable with `HTTP_LAB_ORIGIN_PORT`, `HTTP_LAB_PROXY_PORT`, and `HTTP_LAB_ECHO_PORT`. Services bind to `127.0.0.1` only. The standalone server defaults are 8080, 8888, and 9000. The Electron app defaults its echo service to 9001 so it can coexist with Docker services commonly mapped to port 9000; set `HTTP_LAB_ECHO_PORT=9000` when the course port is free.

## Project layout

Use the **Theme** selector in the top bar to switch between **Dark** and **Light**. Your choice is saved locally between launches; dark is the initial default.

- `server/` contains the handwritten origin server, allow-listed proxy, TCP echo service, static resources, CRUD/session/auth routes, cache behavior, and structured logs. It does not use `node:http`, Express, `fetch`, or XMLHttpRequest.
- `client-core/` contains the request serializer, incremental parser, raw socket client, connection pool, pipelining, redirect/auth helpers, cache, cookie jar, and DNS records.
- `app/` contains the Electron main process, secure preload bridge, and React/Vite teaching interface.
- `docs/ARCHITECTURE.md` is the one-page process/data-flow note.
- `DEMO.md` is a short professor-facing demonstration script.

## Postman-style request editing

The Request panel supports ordered custom headers: add any header name/value, disable a row without deleting it, or remove it before sending. Body modes include raw text, form-urlencoded, JSON, and binary/image. Choosing a local file reads it in the sandboxed renderer and sends its `Uint8Array` bytes through the typed preload bridge; the request still receives an explicit `Content-Length` and remains visible in the raw-wire view. The selected media type is added as `Content-Type` and can be edited like any other header.

For an offline upload demonstration, use `POST http://127.0.0.1:8080/upload`, choose **binary / image**, and select a file. The local origin returns JSON containing the received byte count, content type, optional `X-File-Name`/`Content-Disposition` filename, and SHA-256 digest. To populate the page's two image URLs, use `PUT http://127.0.0.1:8080/uploads/soleil.jpg` and `PUT http://127.0.0.1:8080/uploads/lune.jpg`; later `GET` requests to those URLs return the exact bytes and content types. Multiple URLs store multiple images, while repeating a PUT replaces that URL. Stored uploads are kept in memory until the server stops. `DELETE` requires the course Basic credentials (`mohamed` / `hkm4c`) or a valid login session cookie.

Large binary exchanges remain exact in the main-process wire capture, while the renderer transfers only bounded previews for automatic logs and raw/hex panels. Image responses are still rendered normally when they are within the renderer’s safe preview limit; a large image shows its byte count instead of freezing the window. Large request wires can be loaded explicitly from the Request panel when needed.

The **Page + images** loader fetches the HTML and each uploaded image through the raw client. With automatic revalidation enabled, each cache entry stores the representation body plus its `ETag` and `Last-Modified`; later requests add `If-None-Match` and `If-Modified-Since` automatically. Repeating the scenario therefore shows an independent `304 Not Modified` or `200 OK` for the page, `soleil.jpg`, and `lune.jpg`; replacing an image with PUT removes that image's cache entry so the next load returns fresh content for that URL. For the sandboxed HTML preview, the fetched image bytes are inlined as data URLs; the preview therefore does not create hidden renderer-side network requests, while the real image GET exchanges remain visible in Sequence.

## Rendered responses: JavaScript, CSS, and images

Enter an HTTP/HTTPS URL and click **Send**. HTML runs directly inside **Response → rendered**, including stylesheets, images, scripts, and interactive forms. Try `https://www.wikipedia.org/`, or choose **JavaScript + CSS** for an offline demo with a working button and login form. There is no separate browser window or live-page button.

The embedded browser starts from the exact captured response body; it does not repeat the document request or resubmit a POST. Its subsequent resource requests, form submissions, and navigation go through the raw client. Select a row under **Page requests** to inspect its headers and bytes without replaying it. Redirects during page navigation appear as separate requests, including their `Location` headers.

Use **snapshot** for a static script-disabled HTML view. The **Load page** connection-comparison lesson starts on this snapshot to avoid extra requests changing its measurements. Switching away from rendered closes the active page; returning renders the original captured response again. The latest 20 HTML exchanges are retained for embedded previews; older previews ask you to send again.

The initial request uses the editor settings. Subsequent embedded-page requests use the selected exchange's HTTP version, direct raw connections, automatic browser redirects, and an isolated in-memory browser cookie session. They do not inherit custom request-editor headers/body, proxy/auth helpers, or the lab cache/cookie toggles. Cookies from embedded forms are visible in captured `Set-Cookie`/`Cookie` headers; they do not populate the separate lab cookie jar. Reopening a preview starts a fresh browser session. The request list retains the latest 100 page exchanges.

Workers/service workers, WebSockets, plugins, downloads, and popups are disabled. HTTP/HTTPS resources use the lab's HTTP/1.x transport, including TLS for HTTPS; site CSP and browser origin protections remain enabled. Ordinary client-rendered JavaScript/React pages can execute, but applications depending on unsupported features may not work.

## Design decisions and assumptions

- Networking is owned by Electron's main process or the standalone server. The renderer has `contextIsolation: true`, `nodeIntegration: false`, and a sandboxed preload bridge.
- The app starts the three local services in-process. `npm run server` starts the same services without Electron for curl-based demonstrations.
- The Electron app enables proxy Basic auth by default with `proxy` / `proxy` so the 407 scenario is immediately demonstrable; standalone mode remains unauthenticated unless `PROXY_AUTH_USER` and `PROXY_AUTH_PASSWORD` are set.
- URLs used by the proxy are HTTP absolute-form requests. CONNECT is restricted to the local web server and echo service; arbitrary destinations are rejected.
- `300 Multiple Choices` is displayed for manual inspection. 301/302/303 follow when redirects are enabled, with a five-hop default limit and automatic `Referer`.
- The conditional-cache scenarios send `Cache-Control: no-cache` so the second click performs a validator request even while the origin's `max-age` is still fresh; the exchange keeps the actual wire `304` and exposes the reused representation separately.
- Local caching is in-memory and shared by requests made by the client instance. A fresh hit emits no socket events. Stale entries trigger validators and a 304 reuses the stored decoded body.
- Session state, item CRUD, cache state, and generated resources are in-memory so every run starts clean and works offline.
- The page advertises upload-backed image URLs so the same GET sequence can be observed after replacing either image with PUT.
- TLS support uses Node `tls` as an optional extension. The course scenarios and local backend are HTTP/1.x over raw TCP.

## Security boundaries

The renderer cannot access Node or create sockets. Static response HTML stays inside an iframe with `sandbox` and no scripts. The rendered panel embeds a separate WebContentsView that runs page JavaScript in its own sandboxed session with no preload, Node integration, or lab IPC bridge. Its HTTP/HTTPS protocol handlers delegate to the raw client in the main process; permissions and popups are denied. Server/proxy sockets bind to loopback. Proxy credentials are consumed by the proxy and are never forwarded to the origin. The UI is intended for protocol teaching, not as a general-purpose browser.

## Tests and curl

The test suite covers incremental parsing, split packets, Content-Length, chunked responses, HEAD/304 no-body rules, cookie matching, cache freshness, connection reuse/pipelining, and service smoke behavior.

With `npm run server` in one terminal:

```bash
curl -v http://127.0.0.1:8080/
curl -v -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data 'name=cli' http://127.0.0.1:8080/items
curl -v -X POST -H 'Content-Type: image/jpeg' -H 'X-File-Name: soleil.jpg' --data-binary @/path/to/soleil.jpg http://127.0.0.1:8080/upload
curl -v -X PUT -H 'Content-Type: image/jpeg' --data-binary @/path/to/soleil.jpg http://127.0.0.1:8080/uploads/soleil.jpg
curl -v http://127.0.0.1:8080/uploads/soleil.jpg --output downloaded-soleil.jpg
curl -v -X DELETE -u mohamed:hkm4c http://127.0.0.1:8080/uploads/soleil.jpg
curl -v -I http://127.0.0.1:8080/
curl -v -X TRACE http://127.0.0.1:8080/
```

Optional UI checks (after `npm run build:main`):

```bash
HTTP_LAB_BROWSER_TESTS=1 node app/test/renderer.test.cjs  # requires Chrome
electron app/test/live-page-smoke.cjs                   # requires Electron/display
electron app/test/full-app-smoke.cjs                     # Send -> embedded rendering + form test
HTTP_LAB_TEST_WIKIPEDIA=1 electron app/test/live-page-smoke.cjs # also checks the public site
```
