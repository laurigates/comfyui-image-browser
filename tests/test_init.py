"""Smoke tests for the loader stub so CI is green from the first commit."""

import __init__ as pack


def test_web_directory_exported():
    assert pack.WEB_DIRECTORY == "./web/dist"


def test_node_mappings_exported():
    assert isinstance(pack.NODE_CLASS_MAPPINGS, dict)
    assert isinstance(pack.NODE_DISPLAY_NAME_MAPPINGS, dict)
