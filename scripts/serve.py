import http.server
import socketserver
import urllib.parse
import os
import sys

PORT = int(os.environ.get('PORT', '5173'))
PROJECT_ROOT = os.path.realpath(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
PUBLIC_ROOT = os.path.realpath(os.path.join(PROJECT_ROOT, 'public'))

ALLOWED_ROOT_PREFIXES = ('src/', 'assets/', 'public/')
ALLOWED_ROOT_FILES = ('index.html', 'frame-viewer.html', 'favicon.ico', 'robots.txt')
CACHEABLE_EXTENSIONS = ('.webp', '.png', '.jpg', '.jpeg', '.svg', '.woff2', '.woff')


def _is_within_root(candidate_path, root_path):
    real_candidate = os.path.realpath(candidate_path)
    return real_candidate == root_path or real_candidate.startswith(root_path + os.sep)


class TheNinesDevHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.webp': 'image/webp',
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.svg': 'image/svg+xml',
    }

    def translate_path(self, path):
        # Strip query strings and hash, and decode URL-encoded sequences safely
        url_path = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        clean_path = os.path.normpath(url_path).lstrip('/\\')

        if not clean_path or clean_path == '.':
            return os.path.join(PROJECT_ROOT, 'index.html')

        # Block hidden files/folders (.git, .env, .github) and path traversal
        parts = clean_path.replace('\\', '/').split('/')
        if any(p.startswith('.') or p == '..' for p in parts):
            return os.path.join(PROJECT_ROOT, '__forbidden__')

        normalized_rel = '/'.join(parts)

        # Check public/ directory for frames/ and assets/
        if normalized_rel.startswith(('frames/', 'assets/')) or normalized_rel in ('favicon.ico', 'robots.txt'):
            public_candidate = os.path.join(PUBLIC_ROOT, normalized_rel)
            if _is_within_root(public_candidate, PUBLIC_ROOT) and os.path.exists(public_candidate):
                return public_candidate

        # Strictly whitelist allowed root files and frontend directories (block scripts/, package.json, etc.)
        if normalized_rel not in ALLOWED_ROOT_FILES and not normalized_rel.startswith(ALLOWED_ROOT_PREFIXES):
            return os.path.join(PROJECT_ROOT, '__forbidden__')

        root_candidate = os.path.join(PROJECT_ROOT, normalized_rel)
        if not _is_within_root(root_candidate, PROJECT_ROOT):
            return os.path.join(PROJECT_ROOT, '__forbidden__')

        if os.path.isdir(root_candidate):
            index_in_dir = os.path.join(root_candidate, 'index.html')
            if _is_within_root(index_in_dir, PROJECT_ROOT) and os.path.exists(index_in_dir):
                return index_in_dir
        return root_candidate

    def end_headers(self):
        # Security headers
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')

        # Cache static frame/image assets in browser HTTP cache so scrolling back never re-downloads
        url_path = urllib.parse.urlsplit(self.path).path.lower()
        if url_path.endswith(CACHEABLE_EXTENSIONS):
            self.send_header('Cache-Control', 'public, max-age=3600')
        else:
            self.send_header('Cache-Control', 'no-cache, must-revalidate')

        super().end_headers()

    def log_message(self, format, *args):
        if args and len(args) > 1 and str(args[1]) not in ('200', '206', '304'):
            sys.stderr.write(f"[Server] {args[0]} - {args[1]}\n")


if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), TheNinesDevHandler) as httpd:
        print(f"[The Nines Dev Server] Running at http://localhost:{PORT}/", flush=True)
        print(f"[The Nines Dev Server] Debug HUD: http://localhost:{PORT}/?debug=1", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
