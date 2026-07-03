"""Stub heavy and ComfyUI-internal imports so image_browser.py can be imported
in a vanilla Python environment for unit tests. The dev group ships none of
these — they only exist inside a ComfyUI install (or are heavy third-party) — so
the module-level imports would otherwise fail collection.

Stubbed: aiohttp (+ .web), PIL (+ .Image), folder_paths, server.
"""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock


class _StubModule(ModuleType):
    def __getattr__(self, attr: str):
        if attr.startswith("__"):
            raise AttributeError(attr)
        m = MagicMock()
        setattr(self, attr, m)
        return m


def _ensure_stub(name: str) -> ModuleType:
    if name in sys.modules and not isinstance(sys.modules[name], _StubModule):
        return sys.modules[name]
    m = _StubModule(name)
    sys.modules[name] = m
    return m


# aiohttp — the backend does `from aiohttp import web`.
_aiohttp = _ensure_stub("aiohttp")
_aiohttp.web = _ensure_stub("aiohttp.web")


# web.json_response is called by validation helpers and endpoints; make it
# return a real object so tests can assert on .status and the body payload
# without a live aiohttp server. Other web.* attrs stay MagicMocks.
def _stub_json_response(body, status: int = 200, **kwargs):
    return SimpleNamespace(status=status, _body=body)


_aiohttp.web.json_response = _stub_json_response

# PIL is a package with submodules — the backend does `from PIL import Image`.
_pil = _ensure_stub("PIL")
_pil.Image = _ensure_stub("PIL.Image")

# ComfyUI core internals only present inside a ComfyUI install.
_ensure_stub("folder_paths")

# ComfyUI core `server` — the backend does `from server import PromptServer`.
_server = _ensure_stub("server")


class _NoopRoutes:
    """Decorator-shaped no-op for @PromptServer.instance.routes.{get,post}(path).

    Records registered (method, path) pairs so tests can assert a route is
    wired without invoking the handler against a real aiohttp Request — the
    stubbed server has no real routes table to introspect.
    """

    def __init__(self):
        self.registered: list[SimpleNamespace] = []

    def _register(self, method, path):
        self.registered.append(SimpleNamespace(method=method, path=path))

        def deco(fn):
            return fn

        return deco

    def get(self, path):
        return self._register("GET", path)

    def post(self, path):
        return self._register("POST", path)


# PromptServer.instance.routes is read at module load; supply a real object so
# the @decorator calls in image_browser.py return their wrapped function.
_server.PromptServer = SimpleNamespace(instance=SimpleNamespace(routes=_NoopRoutes()))
