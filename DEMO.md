# HTTP Lab demo script

1. Choose **Upload image (PUT)**, select an image, and send it to `/uploads/soleil.jpg`; choose it again, change the URL to `/uploads/lune.jpg`, and send the second image. Then choose **Page + images (HTTP/1.1)**. The client automatically caches each body and its ETag/Last-Modified validators, then revalidates each URL. Open Sequence and Connections, click **Load page**, and point out the HTML request followed by both image GET requests on a reused connection; repeat the load to observe an independent 304 or 200 for each resource.
2. Change the version to **HTTP/1.0**, clear the Connection header, and load the same page again. Compare the three TCP establishments with HTTP/1.1.
3. Choose **Conditional GET → 304**, send twice with cache enabled, and inspect the second request's `Cache-Control: no-cache`, `If-Modified-Since` / `If-None-Match`, and the 304 cache reuse. The response panel keeps the actual wire status 304 while rendering the cached representation.
4. Choose **ETag → 304** and show the ETag in the response header table and cache side panel.
5. Choose **Basic auth 401 → 200**. The timeline shows the challenge, the Base64 step, and the retry. Emphasize that Base64 is not encryption.
6. Choose **Proxy 407 → 200**. Open Proxy/Server logs and show that `Proxy-Authorization` is visible only on the proxy side.
7. Choose **Cookie login**, then request `http://127.0.0.1:8080/private/home` with cookies enabled. Show `Set-Cookie`, the cookie jar, and the automatic `Cookie` header.
8. Choose **Chunked response**. Open the chunks tab and add the two data chunks: `6` + `10` hexadecimal equals 22 decoded bytes.
9. Choose **Range → 206** and point at `Content-Range`. Choose **TRACE echo** and compare the request wire with the body byte-for-byte.
10. Choose **CONNECT tunnel**, type a line in the tunnel console, and show the bytes returning from the local echo service.
11. Use the method selector and `/status/100`, `/status/401`, `/status/407`, `/status/206`, `/status/503` to show status-specific headers and the French/course explanations.
12. Choose **Upload image (PUT)**, select an image, and inspect the generated `Content-Type` and `Content-Length`. Request the same URL with `GET` to verify that the stored response returns the exact image bytes. Repeating the PUT demonstrates replacement at the same URL.
13. Choose **Delete image (authenticated)** and send it. The authenticated `DELETE` returns `204`; requesting the same URL afterward returns `404`.
14. Use the DNS panel for `localhost` while offline; then try a public name to demonstrate the clear no-record/offline message.

15. Choose **301 redirect** and send. The **Exchange step** selector starts on `GET /old → 301`: inspect `Location` in the response headers and the CRLF-delimited raw response. Select step 2 to inspect the followed GET and its response. The same selector exposes authentication challenge/retry pairs.
16. Choose **Form POST + Referer** and send to load `GET /login`. In **Response → rendered**, edit the username/password and click **Submit**. Inspect the POST request body and `Referer: http://127.0.0.1:8080/login`, then the `201`, `Location`, and `Set-Cookie` response. The real HTML form runs in the embedded page and submits through the raw client. Select its POST under Page requests to inspect the exchange.

17. Choose **JavaScript + CSS**, then click **Send**. Inside **Response → rendered**, the page loads `/live-demo.css` and `/live-demo.js`. Click the counter, then submit the form. Select each **Page requests** row to inspect CSS/JS GETs, the POST body and Referer, and the response cookie. Click Continue in the embedded page to inspect the cookie-bearing private-page request.
18. Enter `https://www.wikipedia.org/` and click **Send**. The rendered panel displays the globe image and runs page scripts/styles. Resource requests appear alongside the response. Use **snapshot** for a static, script-disabled view.

The document is rendered from captured bytes, without repeating its request. Later page requests use direct raw HTTP/HTTPS, an isolated browser cookie session, and automatic redirects. Workers, WebSockets, downloads, and popups are disabled; not every public web application is supported. Switching away from rendered closes the page; returning starts from the captured response again.
