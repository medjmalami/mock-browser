# HTTP Lab demo script

1. Start the app and choose **Page + images (HTTP/1.1)**. Open Timeline and Connections. Click **Load page** and point out one connection reused for the HTML plus both images.
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
12. Set `PUT http://127.0.0.1:8080/uploads/soleil.jpg`, choose **binary / image**, and select an image. Inspect the generated `Content-Type` and `Content-Length`, then request the same URL with `GET` to verify that the stored response returns the exact image bytes. Repeating the PUT demonstrates replacement at the same URL.
13. Use the DNS panel for `localhost` while offline; then try a public name to demonstrate the clear no-record/offline message.
