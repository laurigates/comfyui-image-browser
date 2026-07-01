"""Image Browser for ComfyUI.

See image_browser.py for the backend (node + HTTP endpoints). The frontend
TypeScript source in `src/` is compiled to ESM via `bun build` and emitted to
`web/dist/`, which ComfyUI serves via WEB_DIRECTORY below. See ADR-0001.
"""

try:
    # ComfyUI loads custom_nodes as packages — relative import works.
    from .image_browser import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:
    # Pytest imports __init__.py without a package context; fall back to
    # absolute (the pack root is on sys.path via pyproject pythonpath).
    from image_browser import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web/dist"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
