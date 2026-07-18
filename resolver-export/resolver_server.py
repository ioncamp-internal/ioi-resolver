#!/usr/bin/env python3
"""Serve the resolver directory, with a separate localhost-only admin listener.

Two listeners over the same directory:

  public (--port)        read-only. Refuses every write method and hides the
                         admin page. This is the one cloudflared forwards, so
                         everything it serves is world-readable.

  admin (--admin-port)   serves the admin page and accepts uploads and saves.
                         Bound to 127.0.0.1 and never forwarded by the tunnel,
                         so the write endpoints are unreachable from outside.

The split is the whole point: an upload endpoint on the public listener would
let anyone write files onto this machine.
"""
import argparse
import json
import os
import re
import shutil
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# 只認得這些副檔名, 且大小有上限 -- 上傳端點雖然只綁本機, 仍不該無條件收檔
ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# 公開埠不提供的路徑: admin 頁面與它專用的資源
ADMIN_ONLY = {"/admin.html", "/js/admin.js", "/css/admin.css"}

SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def safe_image_name(name):
    """Reject anything that is not a plain image filename in this directory."""
    name = (name or "").strip()
    if not name or not SAFE_NAME.match(name):
        return None
    if name.startswith(".") or os.path.splitext(name)[1].lower() not in ALLOWED_EXT:
        return None
    return name


class ResolverHandler(SimpleHTTPRequestHandler):
    """Read-only static handler. `admin` turns on the write endpoints."""

    admin = False
    root = "."
    slides_dir = "slides"

    def translate_path(self, path):
        # SimpleHTTPRequestHandler serves from the process cwd; pin it to root
        # instead so both listeners can share one directory.
        rel = super().translate_path(path)
        return os.path.join(self.root, os.path.relpath(rel, os.getcwd()))

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s - %s\n" %
                         ("admin" if self.admin else "public",
                          self.address_string(), fmt % args))

    # -- read ---------------------------------------------------------------

    def do_GET(self):
        if not self.admin and self.path.split("?")[0] in ADMIN_ONLY:
            self.send_error(404, "File not found")
            return
        if self.admin and self.path.split("?")[0] == "/api/images":
            self.send_json(200, {"images": self.list_images()})
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.admin and self.path.split("?")[0] in ADMIN_ONLY:
            self.send_error(404, "File not found")
            return
        super().do_HEAD()

    def list_images(self):
        d = os.path.join(self.root, self.slides_dir)
        if not os.path.isdir(d):
            return []
        return sorted(n for n in os.listdir(d)
                      if os.path.splitext(n)[1].lower() in ALLOWED_EXT
                      and os.path.isfile(os.path.join(d, n)))

    # -- write (admin listener only) ----------------------------------------

    def do_POST(self):
        if not self.admin:
            self.send_error(405, "This server is read-only")
            return
        path = self.path.split("?")[0]
        if path == "/api/upload":
            self.handle_upload()
        elif path == "/api/slides":
            self.handle_save_slides()
        else:
            self.send_error(404, "No such endpoint")

    def do_PUT(self):
        self.send_error(405, "This server is read-only")

    def do_DELETE(self):
        self.send_error(405, "This server is read-only")

    def read_body(self, limit):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > limit:
            return None
        return self.rfile.read(length)

    def handle_upload(self):
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        name = safe_image_name((q.get("name") or [""])[0])
        if not name:
            self.send_json(400, {"error": "檔名無效, 只接受圖片且不能含路徑"})
            return
        body = self.read_body(MAX_UPLOAD_BYTES)
        if body is None:
            self.send_json(400, {"error": "檔案是空的或超過 %d MB" % (MAX_UPLOAD_BYTES // 1048576)})
            return

        target_dir = os.path.join(self.root, self.slides_dir)
        os.makedirs(target_dir, exist_ok=True)
        dest = os.path.join(target_dir, name)
        tmp = dest + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(body)
        os.replace(tmp, dest)
        self.send_json(200, {"name": name, "bytes": len(body), "images": self.list_images()})

    def handle_save_slides(self):
        body = self.read_body(2 * 1024 * 1024)
        if body is None:
            self.send_json(400, {"error": "內容是空的或過大"})
            return
        try:
            cfg = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            self.send_json(400, {"error": "不是合法的 JSON: %s" % exc})
            return
        if not isinstance(cfg, dict) or not isinstance(cfg.get("rules"), list):
            self.send_json(400, {"error": "格式不對: 需要一個物件, 且 rules 是陣列"})
            return

        dest = os.path.join(self.root, "slides.json")
        if os.path.exists(dest):
            shutil.copyfile(dest, dest + ".bak")
        tmp = dest + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, dest)
        self.send_json(200, {"saved": True, "rules": len(cfg["rules"])})

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def make_handler(root, admin, slides_dir):
    return type("Handler", (ResolverHandler,),
                {"root": root, "admin": admin, "slides_dir": slides_dir})


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root")
    ap.add_argument("--port", type=int, required=True, help="public, read-only")
    ap.add_argument("--admin-port", type=int, default=None,
                    help="localhost-only, accepts uploads and saves")
    ap.add_argument("--slides-dir", default="slides")
    args = ap.parse_args(argv)

    root = os.path.abspath(args.root)
    os.chdir(root)

    public = ThreadingHTTPServer(("", args.port),
                                 make_handler(root, False, args.slides_dir))
    sys.stderr.write("public (read-only)  http://localhost:%d/index.html\n" % args.port)

    if args.admin_port:
        # 綁 127.0.0.1: tunnel 只轉發 --port, 所以寫入端點外面碰不到
        admin = ThreadingHTTPServer(("127.0.0.1", args.admin_port),
                                    make_handler(root, True, args.slides_dir))
        sys.stderr.write("admin  (localhost)  http://localhost:%d/admin.html\n" % args.admin_port)
        threading.Thread(target=admin.serve_forever, daemon=True).start()

    public.serve_forever()


if __name__ == "__main__":
    main()
