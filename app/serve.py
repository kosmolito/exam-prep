#!/usr/bin/env python3
"""
Exam Prep local server.

Usage:
  python serve.py                               # loads sample-questions/questions.yaml
  python serve.py --input-file questions.yaml   # loads YAML, serves dynamically
  python serve.py --input-file questions.json   # loads JSON, serves dynamically
  python serve.py --port 9090                   # custom port (default: 8080)

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
from urllib.parse import parse_qs, unquote, urlparse

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


def switch_active_file(active: dict, path: Path) -> None:
    """Load a questions file and update the shared active state dict in-place."""
    data = load_input_file(path)
    img_dir = path.parent
    attach_images(data, img_dir)
    active['json_bytes'] = json.dumps(data, ensure_ascii=False).encode('utf-8')
    active['img_dir']    = img_dir
    active['path']       = path


def list_question_files(questions_dir: Path, active_path: Path | None) -> list[dict]:
    """Return metadata for all question files found in questions_dir."""
    files = []
    for p in sorted(questions_dir.iterdir()):
        if p.is_file() and p.suffix.lower() in ('.yaml', '.yml', '.json'):
            try:
                data = load_input_file(p)
                meta = data.get('meta', {})
                files.append({
                    'name':   p.name,
                    'title':  meta.get('title', p.stem),
                    'count':  len(data.get('questions', [])),
                    'active': p == active_path,
                })
            except Exception:
                pass
    return files


def make_handler(active: dict, questions_dir: Path | None):
    """Return a request handler class backed by mutable shared active state."""

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(APP_ROOT), **kwargs)

        def do_GET(self):
            if self.path == '/questions.json':
                self._serve_bytes(active['json_bytes'], 'application/json; charset=utf-8')

            elif self.path == '/api/files':
                if questions_dir and questions_dir.is_dir():
                    files = list_question_files(questions_dir, active['path'])
                else:
                    files = []
                self._serve_bytes(json.dumps(files).encode('utf-8'), 'application/json; charset=utf-8')

            elif self.path.startswith('/images/') and active['img_dir'] is not None:
                img_dir = active['img_dir']
                filename = self.path[len('/images/'):]
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

        def do_POST(self):
            if self.path == '/api/files/load':
                if not questions_dir:
                    self.send_error(400, 'No questions directory configured'); return
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length))
                    name = body.get('name', '')
                    target = (questions_dir / name).resolve()
                    if not str(target).startswith(str(questions_dir.resolve())):
                        self.send_error(403, 'Path traversal denied'); return
                    if not target.is_file():
                        self.send_error(404, 'File not found'); return
                    switch_active_file(active, target)
                    print(f"Switched to: {target.name}")
                    self._serve_bytes(b'{"ok":true}', 'application/json')
                except Exception as exc:
                    self.send_error(500, str(exc))

            elif self.path.startswith('/api/files/upload'):
                if not questions_dir:
                    self.send_error(400, 'No questions directory configured'); return
                try:
                    params = parse_qs(urlparse(self.path).query)
                    name   = unquote(params.get('name', [''])[0]).strip()

                    if not name or any(c in name for c in ('/', '\\')) or name.startswith('.'):
                        self.send_error(400, 'Invalid filename'); return
                    suffix = Path(name).suffix.lower()
                    if suffix not in ('.yaml', '.yml', '.json'):
                        self.send_error(400, 'Only .yaml, .yml, or .json files are allowed'); return

                    length  = int(self.headers.get('Content-Length', 0))
                    content = self.rfile.read(length)

                    # Validate content before saving
                    try:
                        text = content.decode('utf-8')
                        if suffix in ('.yaml', '.yml'):
                            try:
                                import yaml
                            except ImportError:
                                self.send_error(400, 'PyYAML not installed on server'); return
                            data = yaml.safe_load(text)
                        else:
                            data = json.loads(text)
                        if isinstance(data, list):
                            data = {'questions': data}
                        if not isinstance(data.get('questions'), list) or not data['questions']:
                            raise ValueError('File must contain a non-empty "questions" list')
                    except Exception as exc:
                        self.send_error(400, str(exc)[:300]); return

                    target = (questions_dir / name).resolve()
                    if not str(target).startswith(str(questions_dir.resolve())):
                        self.send_error(403, 'Path traversal denied'); return
                    overwrite = params.get('overwrite', [''])[0].lower() == 'true'
                    if target.exists() and not overwrite:
                        self.send_error(409, f'A file named "{name}" already exists.'); return

                    target.write_bytes(content)
                    if target == active['path']:
                        switch_active_file(active, target)
                    print(f"Uploaded: {name}")
                    self._serve_bytes(b'{"ok":true}', 'application/json')
                except Exception as exc:
                    self.send_error(500, str(exc))

            else:
                self.send_error(404)

        def do_DELETE(self):
            if self.path.startswith('/api/files/'):
                if not questions_dir:
                    self.send_error(400, 'No questions directory configured'); return
                name = unquote(self.path[len('/api/files/'):])
                target = (questions_dir / name).resolve()
                if not str(target).startswith(str(questions_dir.resolve())):
                    self.send_error(403, 'Path traversal denied'); return
                if not target.is_file():
                    self.send_error(404, 'File not found'); return
                if target == active['path']:
                    self.send_error(409, 'Cannot delete the active file'); return
                target.unlink()
                print(f"Deleted: {name}")
                self._serve_bytes(b'{"ok":true}', 'application/json')
            else:
                self.send_error(404)

        def _serve_bytes(self, body: bytes, content_type: str):
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', len(body))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description='Exam Prep local server')
    parser.add_argument(
        '--input-file', '-i', metavar='FILE',
        help='Questions file (.yaml, .yml, or .json). '
             'Defaults to sample-questions/questions.yaml in the app directory.',
    )
    parser.add_argument(
        '--port', '-p', type=int, default=8080,
        help='Port to listen on (default: 8080)',
    )
    parser.add_argument(
        '--no-browser', action='store_true',
        help='Do not open a browser automatically',
    )
    args = parser.parse_args()

    input_file = args.input_file or os.environ.get('QUESTIONS_FILE')

    if input_file:
        initial_path = Path(input_file).resolve()
        if not initial_path.exists():
            sys.exit(f"File not found: {initial_path}")
    else:
        initial_path = APP_ROOT / 'sample-questions' / 'questions.yaml'
        if not initial_path.exists():
            sys.exit(
                "Default file not found: sample-questions/questions.yaml\n"
                "Run with --input-file to specify a questions file."
            )

    active: dict = {'json_bytes': None, 'img_dir': None, 'path': None}
    print(f"Loading questions from: {initial_path}")
    switch_active_file(active, initial_path)
    questions_dir = initial_path.parent

    data = json.loads(active['json_bytes'])
    n     = len(data.get('questions', []))
    title = data.get('meta', {}).get('title', initial_path.stem)
    imgs  = sum(1 for q in data.get('questions', []) if q.get('image'))
    print(f"  {n} questions loaded  ·  {imgs} with images  ·  title: {title!r}")

    url = f"http://localhost:{args.port}"
    print(f"\nExam Prep  →  {url}")
    print("Press Ctrl-C to stop.\n")

    Handler = make_handler(active, questions_dir)
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
