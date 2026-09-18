#!/usr/bin/env python3
"""
Particle Hands - local launcher.

Serves the app on http://localhost:<port> and opens your browser.
Browsers only allow camera access on localhost or https, which is why
the page must be served instead of opened as a file.

    python3 server.py              # default port 8000, opens browser
    python3 server.py --port 9000
    python3 server.py --no-browser
"""
import argparse
import functools
import http.server
import os
import socket
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".wasm": "application/wasm",
        ".json": "application/json",
    }

    def end_headers(self):
        # Always serve fresh files while you tweak the code.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.server.quiet:
            sys.stderr.write("  %s  %s\n" % (self.address_string(), fmt % args))


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def main():
    parser = argparse.ArgumentParser(description="Particle Hands local server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    args = parser.parse_args()

    port = args.port
    while not port_free(port) and port < args.port + 20:
        port += 1

    handler = functools.partial(Handler, directory=ROOT)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        httpd.quiet = not args.verbose
        url = f"http://localhost:{port}/"
        print()
        print("  ✦  PARTICLE HANDS")
        print(f"  ✦  running at {url}")
        print("  ✦  allow camera access when the browser asks")
        print("  ✦  Ctrl+C to stop")
        print()
        if not args.no_browser:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  bye ✦")


if __name__ == "__main__":
    main()
