#!/usr/bin/env python3
"""Minimal static file server for local preview. Honors the PORT env var."""
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler

port = int(os.environ.get("PORT", "8771"))
HTTPServer(("127.0.0.1", port), SimpleHTTPRequestHandler).serve_forever()
