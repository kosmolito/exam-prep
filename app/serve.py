#!/usr/bin/env python3
"""
Exam Prep local server.

Usage:
  python serve.py                               # loads sample-questions/questions.yaml
  python serve.py --input-file questions.yaml   # loads YAML, serves dynamically
  python serve.py --input-file questions.json   # loads JSON, serves dynamically
  python serve.py --port 9090                   # custom port (default: 8888)

Environment variables:
  QUESTIONS_FILE   Path to the questions file (overridden by --input-file if both set)
"""
import argparse
import http.server
import json
import os
import socketserver
import sys
import webbrowser
from pathlib import Path

APP_ROOT = Path(__file__).parent
IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.webp')
CONTENT_TYPES = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
}


def load_input_file(path: Path) -> dict:
    """Load YAML or JSON input file and return normalised {meta, questions} dict."""
    suffix = path.suffix.lower()

    if suffix in ('.yaml', '.yml'):
        try:
            import yaml
        except ImportError:
            sys.exit("PyYAML is required for YAML input files.\nInstall it with: pip install pyyaml")
        with open(path, encoding='utf-8') as f:
            data = yaml.safe_load(f)
    elif suffix == '.json':
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    else:
        sys.exit(f"Unsupported file type '{suffix}'. Use .yaml, .yml, or .json")

    # Normalise: bare list → {questions: [...]}
    if isinstance(data, list):
        data = {'questions': data}

    # Assign sequential IDs if missing
    for i, q in enumerate(data.get('questions', []), 1):
        q.setdefault('id', i)

    return data


def attach_images(data: dict, img_dir: Path) -> None:
    """
    For each question, look for <number>.png/jpg/jpeg/webp in img_dir.
    Sets q['image'] = 'images/<filename>' when found, else None.
    """
    for q in data.get('questions', []):
        num = q.get('number', q.get('id', ''))
        for ext in IMAGE_EXTS:
            candidate = img_dir / f"{num}{ext}"
            if candidate.exists():
                q['image'] = f"images/{num}{ext}"
                break
        else:
            q.setdefault('image', None)


def make_handler(questions_json_bytes: bytes, img_dir: Path | None):
    """Return a request handler class configured with in-memory questions data."""

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(APP_ROOT), **kwargs)

        def do_GET(self):
            if self.path == '/questions.json':
                self._serve_bytes(questions_json_bytes, 'application/json; charset=utf-8')

            elif self.path.startswith('/images/') and img_dir is not None:
                filename = self.path[len('/images/'):]
                # Prevent path traversal
                img_path = (img_dir / filename).resolve()
                if not str(img_path).startswith(str(img_dir.resolve())):
                    self.send_error(403)
                    return
                if img_path.is_file():
                    ext = img_path.suffix.lower()
                    ct = CONTENT_TYPES.get(ext, 'application/octet-stream')
                    self._serve_bytes(img_path.read_bytes(), ct)
                else:
                    self.send_error(404, f"Image not found: {filename}")

            else:
                super().do_GET()

        def _serve_bytes(self, body: bytes, content_type: str):
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', len(body))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            pass  # suppress per-request noise

    return Handler


def main():
    parser = argparse.ArgumentParser(description='Exam Prep local server')
    parser.add_argument(
        '--input-file', '-i', metavar='FILE',
        help='Questions file (.yaml, .yml, or .json). '
             'Defaults to questions.json in the app directory.',
    )
    parser.add_argument(
        '--port', '-p', type=int, default=8888,
        help='Port to listen on (default: 8888)',
    )
    parser.add_argument(
        '--no-browser', action='store_true',
        help='Do not open a browser automatically',
    )
    args = parser.parse_args()

    img_dir: Path | None = None

    input_file = args.input_file or os.environ.get('QUESTIONS_FILE')

    if input_file:
        input_path = Path(input_file).resolve()
        if not input_path.exists():
            sys.exit(f"File not found: {input_path}")

        print(f"Loading questions from: {input_path}")
        data = load_input_file(input_path)

        img_dir = input_path.parent
        attach_images(data, img_dir)

        n = len(data.get('questions', []))
        title = data.get('meta', {}).get('title', input_path.stem)
        imgs = sum(1 for q in data.get('questions', []) if q.get('image'))
        print(f"  {n} questions loaded  ·  {imgs} with images  ·  title: {title!r}")

        questions_json_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
        Handler = make_handler(questions_json_bytes, img_dir)
    else:
        # Default: sample-questions/questions.yaml
        default_path = APP_ROOT / 'sample-questions' / 'questions.yaml'
        if not default_path.exists():
            sys.exit(
                "Default file not found: sample-questions/questions.yaml\n"
                "Run with --input-file to specify a questions file."
            )
        print(f"Loading questions from: {default_path}")
        data = load_input_file(default_path)
        img_dir = default_path.parent
        attach_images(data, img_dir)
        n = len(data.get('questions', []))
        title = data.get('meta', {}).get('title', default_path.stem)
        imgs = sum(1 for q in data.get('questions', []) if q.get('image'))
        print(f"  {n} questions loaded  ·  {imgs} with images  ·  title: {title!r}")
        questions_json_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
        Handler = make_handler(questions_json_bytes, img_dir)

    url = f"http://localhost:{args.port}"
    print(f"\nExam Prep  →  {url}")
    print("Press Ctrl-C to stop.\n")

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", args.port), Handler) as httpd:
        if not args.no_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == '__main__':
    main()
