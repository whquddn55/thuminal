# Windows 브라우저 칸 시험 서버 (probe.ps1). probe.html 을 내고, 페이지가 보낸 입력(/ev?e=…)을 한 줄씩 기록 파일에 남긴다.
# 사용법: python probe_server.py <포트> <기록 파일>
import http.server
import os
import sys
import urllib.parse

PORT = int(sys.argv[1])
LOG = sys.argv[2]
PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe.html")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/ev":
            e = urllib.parse.parse_qs(url.query).get("e", [""])[0]
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(e + "\n")
            body, kind = b"ok", "text/plain"
        else:
            with open(PAGE, "rb") as f:
                body, kind = f.read(), "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
