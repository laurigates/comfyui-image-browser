"""The security guards added for the Comfy Registry ban — see image_browser.py's
module docstring for the threat model these assert.

Every control here asserts BOTH directions on the SAME input, in the same test.
A suite that only asserts "no header -> 403" passes identically against a guard
hard-wired to deny everything — which would break the entire pack while reading
as coverage. The positive arm is what tells "correct" from "inert", and the rest
of the Python suite is a second positive arm: `_FakeRequest` in
tests/test_helpers.py now carries a valid header set by default, so a
deny-everything guard turns that file red wholesale.
"""

from __future__ import annotations

import asyncio
import os
import sys
import urllib.parse
from types import SimpleNamespace
from typing import ClassVar

import pytest
import server

import image_browser as ib

VALID = {
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
    "Origin": "http://127.0.0.1:8188",
    "Host": "127.0.0.1:8188",
}


def _req(headers=None, body=None, **overrides):
    """A POST-shaped fake request: valid headers unless a test says otherwise."""
    h = dict(VALID if headers is None else headers)
    h.update({k: v for k, v in overrides.items() if v is not None})
    for k, v in overrides.items():
        if v is None:
            h.pop(k, None)
    return SimpleNamespace(headers=h, json=_json_of(body if body is not None else {}))


def _with_settings(request, settings):
    """Attach stored ComfyUI settings to a fake request.

    conftest's user-manager stub answers `get_settings(request)` from this
    attribute, so a test switches an opt-in on through the SAME path the server
    reads it — rather than monkeypatching the predicate it means to exercise. A
    request without it reads as no settings stored: every opt-in's default-off.
    """
    request.comfy_settings = dict(settings)
    return request


def _get_req(query, headers=None):
    return SimpleNamespace(
        rel_url=SimpleNamespace(query=query), headers=dict(VALID if headers is None else headers)
    )


def _json_of(body):
    async def json():
        return body

    return json


# ---------------------------------------------------------------------------
# The Origin/Host parse — the draft's defect, pinned against the stdlib
# ---------------------------------------------------------------------------


class TestAuthorityParse:
    """The hand-rolled parse exists only because `urllib` in shipped Python is a
    registry-scanner tripwire (tests/test_publish_hygiene.py enforces that). A
    hand-rolled parser is worth nothing without the reference beside it, so this
    is a DIFFERENTIAL test: tests are not shipped, so they may import the stdlib.
    """

    # (origin, the Host header a same-origin request would carry)
    REAL_PAIRS: ClassVar[list[tuple[str, str]]] = [
        ("http://127.0.0.1:8188", "127.0.0.1:8188"),
        ("http://localhost:8188", "localhost:8188"),
        ("https://comfy.example.com", "comfy.example.com"),
        ("http://192.168.1.9:8188", "192.168.1.9:8188"),
        ("http://popos.intra.lakuz.com:8188", "popos.intra.lakuz.com:8188"),
        ("http://[::1]:8188", "[::1]:8188"),
    ]

    @pytest.mark.parametrize("origin,host", REAL_PAIRS)
    def test_matches_the_stdlib_on_a_real_origin(self, origin, host):
        assert ib._origin_host(origin) == urllib.parse.urlsplit(origin).hostname
        assert ib._host_header_host(host) == urllib.parse.urlsplit("//" + host).hostname

    @pytest.mark.parametrize("origin,host", REAL_PAIRS)
    def test_a_real_same_origin_pair_compares_EQUAL(self, origin, host):
        """The two-sided half, and the anti-regression for the draft's defect.

        The draft read the host as
        `_host_of(origin.replace("https://", "//").replace("http://", "//"))`
        where `_host_of` itself prepends "//" — yielding "////host", whose
        hostname is None for EVERY well-formed Origin. That parse 403s every
        legitimate POST, and a suite that only checked the cross-origin refusal
        would have shipped it green. Executed here on real pairs.
        """
        assert ib._origin_host(origin) is not None
        assert ib._origin_host(origin) == ib._host_header_host(host)

    def test_a_cross_origin_pair_compares_UNEQUAL(self):
        assert ib._origin_host("https://evil.example.net") != ib._host_header_host(
            "comfy.example.com"
        )

    @pytest.mark.parametrize("origin", ["null", "", "   ", "not-a-url", "http:/missing-slash"])
    def test_an_unusable_origin_yields_None(self, origin):
        """None is the refusal direction: an opaque or malformed origin must not
        be assumed to be ours. Paired with the real-origin test above, which
        proves None is not simply what this function always returns."""
        assert ib._origin_host(origin) is None

    def test_userinfo_is_not_read_as_the_host(self):
        assert ib._origin_host("http://127.0.0.1:8188@evil.example.net") == "evil.example.net"
        assert ib._origin_host("http://evil.example.net") == "evil.example.net"


# ---------------------------------------------------------------------------
# The two mutation gates
# ---------------------------------------------------------------------------


class TestContentTypeGate:
    """Requiring application/json is the gate that actually closes the CSRF
    class: aiohttp's BaseRequest.json() never inspects Content-Type (verified
    against aiohttp 3.11.13 — a JSON body is accepted under text/plain,
    multipart/form-data and application/x-www-form-urlencoded alike), so
    without it a cross-origin <form> is a CORS-simple request that reaches
    every handler with no preflight."""

    @pytest.mark.parametrize(
        "value", ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON"]
    )
    def test_json_is_accepted(self, value):
        assert ib._reject_non_json(_req(**{"Content-Type": value})) is None

    @pytest.mark.parametrize(
        "value",
        [
            "text/plain;charset=UTF-8",
            "multipart/form-data",
            "application/x-www-form-urlencoded",
            "",
        ],
    )
    def test_the_three_form_encodable_types_are_refused(self, value):
        resp = ib._reject_non_json(_req(**{"Content-Type": value}))
        assert resp is not None
        assert resp.status == 415

    def test_a_missing_header_is_refused_and_the_present_one_is_not(self):
        """Both directions on the same request shape."""
        assert ib._reject_non_json(_req(**{"Content-Type": None})).status == 415
        assert ib._reject_non_json(_req()) is None


class TestSameSiteGate:
    def test_cross_site_is_refused_and_same_origin_is_not(self):
        assert ib._reject_cross_site(_req(**{"Sec-Fetch-Site": "cross-site"})).status == 403
        assert ib._reject_cross_site(_req(**{"Sec-Fetch-Site": "same-origin"})) is None

    def test_same_site_is_ACCEPTED(self):
        """Deliberate, and matches ComfyUI core, which refuses only cross-site.
        Narrowing this would 403 split-subdomain reverse-proxy setups that core
        serves fine. Paired with the cross-site refusal so it cannot pass on an
        accept-everything guard."""
        assert ib._reject_cross_site(_req(**{"Sec-Fetch-Site": "same-site"})) is None
        assert ib._reject_cross_site(_req(**{"Sec-Fetch-Site": "cross-site"})) is not None

    def test_sec_fetch_site_wins_over_a_differing_origin(self):
        """A browser-set same-site verdict ends the check — that is the whole
        point of the tier order. The Origin here differs from Host and is
        deliberately NOT consulted."""
        headers = {**VALID, "Sec-Fetch-Site": "same-site", "Origin": "https://ui.example.com"}
        headers["Host"] = "api.example.com"
        assert ib._reject_cross_site(SimpleNamespace(headers=headers)) is None

    def test_without_sec_fetch_site_a_mismatched_origin_is_refused(self):
        base = {k: v for k, v in VALID.items() if k != "Sec-Fetch-Site"}
        assert ib._reject_cross_site(SimpleNamespace(headers=base)) is None
        bad = {**base, "Origin": "https://evil.example.net"}
        assert ib._reject_cross_site(SimpleNamespace(headers=bad)).status == 403

    def test_neither_header_is_allowed_through(self):
        """Documented and deliberate: per Fetch a browser sends Origin on every
        non-GET request, so this case is curl or an API client, not a page.
        Paired with the refusal above so it cannot pass on an inert guard."""
        bare = {"Content-Type": "application/json"}
        assert ib._reject_cross_site(SimpleNamespace(headers=bare)) is None
        assert (
            ib._reject_cross_site(
                SimpleNamespace(headers={**bare, "Sec-Fetch-Site": "cross-site"})
            ).status
            == 403
        )


class TestEveryPostIsGuarded:
    """The enumeration. An exception list rots the moment someone adds a route;
    this cannot, because it reads the route table itself."""

    @staticmethod
    def _registered(method):
        return [r for r in server.PromptServer.instance.routes.registered if r.method == method]

    def test_every_registered_post_carries_the_guard(self):
        posts = self._registered("POST")
        assert len(posts) >= 13, "the POST surface shrank — update this floor deliberately"
        unguarded = [
            r.path for r in posts if not getattr(r.handler, "image_browser_guarded", False)
        ]
        assert unguarded == []

    def test_no_GET_route_carries_the_guard(self):
        """The two-sided half: it proves the marker means something. Were the
        attribute check vacuously true (a getattr default of True, a marker set
        on every function), the read endpoints would report as guarded too — and
        the assertion above would pass while asserting nothing."""
        marked = [
            r.path
            for r in self._registered("GET")
            if getattr(r.handler, "image_browser_guarded", False)
        ]
        assert marked == []

    def test_a_guarded_handler_refuses_a_form_post_and_serves_a_json_one(self):
        """End to end through a real registered handler, both directions."""
        refused = asyncio.run(
            ib.image_browser_delete(_req(**{"Content-Type": "text/plain;charset=UTF-8"}))
        )
        assert refused.status == 415
        # Same handler, valid headers: it gets past the guard and fails on the
        # BODY instead (no type/name), which is the un-guarded behaviour.
        served = asyncio.run(ib.image_browser_delete(_req(body={})))
        assert served.status == 400


# ---------------------------------------------------------------------------
# Path containment on the mutation path
# ---------------------------------------------------------------------------


class TestRealpathContainment:
    @staticmethod
    def _sandbox(base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def test_an_ESCAPING_symlinked_subfolder_is_refused_while_a_real_one_still_writes(
        self, tmp_path, monkeypatch
    ):
        """The load-bearing pair, END TO END through /delete, with real symlinks.

        This test replaces one that asserted the BYPASS as desired behaviour
        ("a symlinked subfolder must stay writable"). It was wrong, and the
        wrongness was executable: anchoring the realpath check on the
        subfolder-resolved base resolves the symlink into the base, after which
        the target is contained by construction. Measured against this file
        before the anchor moved to the root: `output/link -> /etc` plus
        POST /delete {subfolder: "link", name: "passwd.png"} answered
        `200 {"ok": true}` and the victim outside the sandbox was gone.

        Both arms here, on one tree and one endpoint, because a refusal-only
        test passes identically against a resolver hard-wired to refuse — which
        would break every write in the pack."""
        root = tmp_path / "output"
        root.mkdir()
        etc = tmp_path / "etc"
        etc.mkdir()
        victim = etc / "passwd.png"
        victim.write_bytes(b"secret")
        (root / "link").symlink_to(etc, target_is_directory=True)

        real = root / "renders"
        real.mkdir()
        keep = real / "clip.png"
        keep.write_bytes(b"x")
        self._sandbox(root, monkeypatch)

        escaped = asyncio.run(
            ib.image_browser_delete(
                _req(body={"type": "output", "subfolder": "link", "name": "passwd.png"})
            )
        )
        assert escaped.status == 400
        assert victim.exists(), "a file outside the sandbox was deleted"
        # Actionable, per the /file refusal's precedent: the message names the
        # setting that permits this layout, so the operator is not left guessing.
        assert escaped._body["error"] == ib.LINKED_SUBFOLDER_WRITES_DISABLED_MSG
        assert "Allow writes through symlinked subfolders" in escaped._body["error"]

        served = asyncio.run(
            ib.image_browser_delete(
                _req(body={"type": "output", "subfolder": "renders", "name": "clip.png"})
            )
        )
        assert served.status == 200, served._body
        assert not keep.exists(), "an ordinary in-root subfolder stopped being writable"

    def test_the_DIR_resolver_is_gated_too_and_still_removes_a_real_folder(
        self, tmp_path, monkeypatch
    ):
        """The folder half, END TO END through /rmdir, and it needs its own test:
        the file and dir resolvers are separate functions with separate calls to
        the containment gate, and a suite that only drove /delete reported the
        dir resolver losing its gate as MISSED (measured, on the first run of
        this table).

        Reproduced before the fix: `output/link -> <outside>` plus
        POST /rmdir {subfolder: "link", name: "important", recursive: true}
        answered `200 {"ok": true, "files": 2, "dirs": 1}` and the tree outside
        the sandbox was gone. Both arms on one tree."""
        root = tmp_path / "output"
        root.mkdir()
        outside = tmp_path / "outside"
        outside.mkdir()
        important = outside / "important"
        important.mkdir()
        (important / "a.png").write_bytes(b"x")
        (important / "b.png").write_bytes(b"x")
        (important / "nested").mkdir()
        (root / "link").symlink_to(outside, target_is_directory=True)

        doomed = root / "scratch"
        doomed.mkdir()
        (doomed / "a.png").write_bytes(b"x")
        self._sandbox(root, monkeypatch)

        escaped = asyncio.run(
            ib.image_browser_rmdir(
                _req(
                    body={
                        "type": "output",
                        "subfolder": "link",
                        "name": "important",
                        "recursive": True,
                    }
                )
            )
        )
        assert escaped.status == 400
        assert escaped._body["error"] == ib.LINKED_SUBFOLDER_WRITES_DISABLED_MSG
        assert important.exists(), "a tree outside the sandbox was deleted"
        assert (important / "a.png").exists()

        served = asyncio.run(
            ib.image_browser_rmdir(
                _req(
                    body={
                        "type": "output",
                        "subfolder": "",
                        "name": "scratch",
                        "recursive": True,
                    }
                )
            )
        )
        assert served.status == 200, served._body
        assert not doomed.exists(), "an ordinary in-root folder stopped being removable"

    def test_an_unknown_type_anchors_on_a_path_nothing_can_be_under(self, tmp_path, monkeypatch):
        """Defence in depth, and the direction matters.

        Every caller rejects a non-sandboxed type before reaching the anchor, so
        this is unreachable today. It is asserted anyway because the failure mode
        of getting it wrong is silent: `folder_paths.get_directory_by_type`
        answers None for an unknown type, and a fallback of `""` or `"."`
        resolves to the CWD — under which a great deal IS contained. Paired with
        a real type so it cannot pass against a function that always refuses."""
        import folder_paths

        # Type-AWARE, unlike the class helper: core answers None for a type it
        # does not know, and that None is the input under test here.
        monkeypatch.setattr(
            folder_paths,
            "get_directory_by_type",
            lambda t: str(tmp_path) if t in ib.SANDBOXED_TYPES else None,
            raising=False,
        )
        assert ib._contained_after_realpath(str(tmp_path / "x.png"), ib._sandbox_root("output"))
        assert not ib._contained_after_realpath(
            str(tmp_path / "x.png"), ib._sandbox_root("nonesuch")
        )
        assert not ib._contained_after_realpath(os.getcwd(), ib._sandbox_root("nonesuch"))

    def test_a_symlinked_ROOT_stays_writable(self, tmp_path, monkeypatch):
        """The anchor is realpath(ROOT), which is why moving it off the base did
        not break the install whose whole output dir lives on another disk
        (`output -> /mnt/otherdisk/output`). Resolving the root once puts every
        target under it inside the anchor.

        Paired with the refusal above: without this arm, a resolver that refused
        every symlink anywhere would read as correct."""
        disk = tmp_path / "otherdisk"
        disk.mkdir()
        (disk / "r.png").write_bytes(b"x")
        linked_root = tmp_path / "output"
        linked_root.symlink_to(disk, target_is_directory=True)
        self._sandbox(linked_root, monkeypatch)

        target, err = ib._resolve_sandboxed_file("output", "", "r.png")
        assert err == ""
        assert target is not None

    def test_the_opt_in_permits_the_SUBFOLDER_and_still_refuses_the_LEAF(
        self, tmp_path, monkeypatch
    ):
        """The escape hatch is exactly as wide as the deployment it exists for.

        `output/renders -> /mnt/nas/renders` is a real layout, so it is handed
        back — but only the subfolder. A symlinked NAME
        (`output/leak.png -> /etc/passwd`) is refused with the opt-in ON, which
        is what stops the switch being a general containment off-switch."""
        root = tmp_path / "output"
        root.mkdir()
        nas = tmp_path / "nas"
        nas.mkdir()
        (nas / "clip.png").write_bytes(b"x")
        (root / "renders").symlink_to(nas, target_is_directory=True)
        secret = tmp_path / "secret.png"
        secret.write_bytes(b"x")
        (root / "leak.png").symlink_to(secret)
        self._sandbox(root, monkeypatch)

        _t, err = ib._resolve_sandboxed_file(
            "output", "renders", "clip.png", allow_linked_subfolder=True
        )
        assert err == "", "the opt-in must permit the symlinked subfolder"

        _t, err = ib._resolve_sandboxed_file("output", "", "leak.png", allow_linked_subfolder=True)
        assert err == "name escapes root", "the opt-in must not widen the leaf"

    def test_the_endpoints_honour_the_opt_in_and_default_it_OFF(self, tmp_path, monkeypatch):
        """The wiring, not the resolver: a default that is right in
        `_resolve_sandboxed_file` and never read by a handler protects nothing.
        Same request twice, only the stored setting differing."""
        root = tmp_path / "output"
        root.mkdir()
        nas = tmp_path / "nas"
        nas.mkdir()
        victim = nas / "clip.png"
        victim.write_bytes(b"x")
        (root / "renders").symlink_to(nas, target_is_directory=True)
        self._sandbox(root, monkeypatch)
        body = {"type": "output", "subfolder": "renders", "name": "clip.png"}

        off = asyncio.run(ib.image_browser_delete(_req(body=body)))
        assert off.status == 400
        assert victim.exists()

        on = asyncio.run(
            ib.image_browser_delete(
                _with_settings(_req(body=body), {ib.SETTING_ALLOW_LINKED_SUBFOLDER_WRITES: True})
            )
        )
        assert on.status == 200, on._body
        assert not victim.exists()

    @pytest.mark.parametrize("stored", [False, "true", 1, None, "yes"])
    def test_only_a_real_boolean_True_opens_the_symlink_hatch(self, tmp_path, monkeypatch, stored):
        """Same `is True` discipline as the read opt-in — a hand-edited settings
        file holding the string "false" must not turn a containment gate off.
        Paired with the True arm in the test above."""
        root = tmp_path / "output"
        root.mkdir()
        nas = tmp_path / "nas"
        nas.mkdir()
        (nas / "clip.png").write_bytes(b"x")
        (root / "renders").symlink_to(nas, target_is_directory=True)
        self._sandbox(root, monkeypatch)

        resp = asyncio.run(
            ib.image_browser_delete(
                _with_settings(
                    _req(body={"type": "output", "subfolder": "renders", "name": "clip.png"}),
                    {ib.SETTING_ALLOW_LINKED_SUBFOLDER_WRITES: stored},
                )
            )
        )
        assert resp.status == 400

    def test_the_READ_resolver_is_untouched_by_the_gate(self, tmp_path, monkeypatch):
        """/list, /thumb, /metadata and pin resolution all share
        `_resolve_listing_base`. Putting the realpath check there would stop a
        symlinked output subfolder listing at all."""
        root = tmp_path / "output"
        root.mkdir()
        nas = tmp_path / "nas"
        nas.mkdir()
        (root / "renders").symlink_to(nas, target_is_directory=True)
        self._sandbox(root, monkeypatch)
        base, err = ib._resolve_listing_base("output", "renders", "")
        assert err == ""
        assert base == str(root / "renders")

    def test_a_file_symlink_pointing_out_is_refused_and_a_real_file_is_not(
        self, tmp_path, monkeypatch
    ):
        root = tmp_path / "output"
        root.mkdir()
        outside = tmp_path / "secrets.png"
        outside.write_bytes(b"x")
        (root / "link.png").symlink_to(outside)
        (root / "real.png").write_bytes(b"x")
        self._sandbox(root, monkeypatch)
        assert ib._resolve_sandboxed_file("output", "", "link.png")[1] == "name escapes root"
        assert ib._resolve_sandboxed_file("output", "", "real.png")[1] == ""


# ---------------------------------------------------------------------------
# Bounded destructive work
# ---------------------------------------------------------------------------


class TestBatchCap:
    def _items(self, n):
        return [{"type": "output", "subfolder": "", "name": f"{i}.png"} for i in range(n)]

    def test_at_the_cap_it_passes_and_one_over_it_does_not(self):
        at, err = ib._validate_batch_items({"items": self._items(ib.MAX_MUTATION_BATCH)})
        assert err is None and at is not None
        over, resp = ib._validate_batch_items({"items": self._items(ib.MAX_MUTATION_BATCH + 1)})
        assert over is None
        assert resp.status == 400
        assert str(ib.MAX_MUTATION_BATCH) in resp._body["error"]


class TestCountDirContentsEarlyExit:
    def _tree(self, root):
        """5 files + 3 subdirs at the top, 5 files in each subdir.

        The first os.walk yield alone is 5 files + 3 dirs = 8, so a limit of 2
        must break there and report (5, 3) — deterministic, no ordering luck.
        """
        for i in range(5):
            (root / f"top{i}.png").write_bytes(b"x")
        for d in range(3):
            sub = root / f"sub{d}"
            sub.mkdir()
            for i in range(5):
                (sub / f"n{i}.png").write_bytes(b"x")

    def test_it_stops_at_the_limit_and_is_exact_without_one(self, tmp_path):
        """Both directions on the same tree. The exact arm is what proves the
        early exit did not simply break counting; the early arm is what proves
        the cap can refuse before the walk finishes. Without the early exit a
        /rmdir on a huge tree stalls the event loop BEFORE the cap can refuse,
        which would make the cap decorative."""
        self._tree(tmp_path)
        assert ib._count_dir_contents(str(tmp_path)) == (20, 3)
        assert ib._count_dir_contents(str(tmp_path), limit=2) == (5, 3)


class TestRmdirCeiling:
    @staticmethod
    def _sandbox(base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def _call(self, body):
        return asyncio.run(ib.image_browser_rmdir(_req(body=body)))

    def test_the_count_is_taken_WITH_the_cap_so_the_walk_can_stop_early(
        self, tmp_path, monkeypatch
    ):
        """A cap decided after a full os.walk is decorative.

        `_count_dir_contents` runs synchronously on the event loop, so a
        pathological tree stalls the server BEFORE the ceiling can refuse it.
        What is observable in this tier is the argument, not the stall — no
        pytest run can measure an event loop that never yields — so this asserts
        the limit reaches the counter, and TestCountDirContentsEarlyExit asserts
        that the same limit changes what the counter does. Neither half means
        much alone; together they say the short circuit is wired and works.
        """
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "d").mkdir()
        seen = {}
        real = ib._count_dir_contents

        def spy(target, limit=None):
            seen["limit"] = limit
            return real(target, limit)

        monkeypatch.setattr(ib, "_count_dir_contents", spy)
        self._call({"type": "output", "subfolder": "", "name": "d"})
        assert seen["limit"] == ib.MAX_RMDIR_ENTRIES

    def test_under_the_ceiling_confirms_and_over_it_refuses_with_a_DIFFERENT_status(
        self, tmp_path, monkeypatch
    ):
        """413, never 409. src/api.ts discriminates the "folder is not empty"
        confirm on `status === 409 && typeof data.files === "number"` and answers
        it by re-posting `recursive: true`. A 409 here would be read as
        confirm-and-retry, the retry would be refused identically, and the user
        would sit in a confirm/refuse loop with no way out. Both arms asserted
        on the same folder shape."""
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "MAX_RMDIR_ENTRIES", 3)

        small = tmp_path / "small"
        small.mkdir()
        for i in range(2):
            (small / f"{i}.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "name": "small"})
        assert resp.status == 409
        assert isinstance(resp._body["files"], int), "the confirm contract must survive"

        big = tmp_path / "big"
        big.mkdir()
        for i in range(9):
            (big / f"{i}.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "name": "big", "recursive": True})
        assert resp.status == 413
        assert resp._body["code"] == "too_large"
        assert "files" not in resp._body, "a 413 must not look like the 409 confirm to the client"
        assert big.is_dir(), "the refusal must not have deleted anything"


# ---------------------------------------------------------------------------
# The arbitrary-path read opt-in
# ---------------------------------------------------------------------------


class TestFileOptIn:
    @staticmethod
    def _settings(monkeypatch, value):
        monkeypatch.setattr(
            server,
            "PromptServer",
            SimpleNamespace(
                instance=SimpleNamespace(
                    user_manager=SimpleNamespace(
                        settings=SimpleNamespace(get_settings=lambda request: value)
                    )
                )
            ),
            raising=False,
        )
        monkeypatch.setattr(ib, "PromptServer", server.PromptServer, raising=False)

    def _call(self, path):
        return asyncio.run(ib.image_browser_file(_get_req({"path": path})))

    def test_off_by_default_and_on_when_the_user_opts_in(self, tmp_path, monkeypatch):
        """The whole point of the change: the reach is a CONFIGURATION choice,
        not a code-verified capability. Both arms on the same real file."""
        media = tmp_path / "clip.mp4"
        media.write_bytes(b"x")
        ib.web.FileResponse.reset_mock()

        self._settings(monkeypatch, {})
        resp = self._call(str(media))
        assert resp.status == 403
        assert "Allow absolute-path file reads" in resp._body["error"]
        ib.web.FileResponse.assert_not_called()

        self._settings(monkeypatch, {ib.SETTING_ALLOW_PATH_READS: True})
        self._call(str(media))
        ib.web.FileResponse.assert_called_once()

    @pytest.mark.parametrize("stored", [False, "true", 1, None, "yes"])
    def test_only_a_real_boolean_True_enables_it(self, tmp_path, monkeypatch, stored):
        """A corrupted or hand-edited settings file holding the string "false"
        must not open a security-relevant reach. Paired with the True arm above."""
        media = tmp_path / "clip.mp4"
        media.write_bytes(b"x")
        self._settings(monkeypatch, {ib.SETTING_ALLOW_PATH_READS: stored})
        assert self._call(str(media)).status == 403

    def test_unreadable_settings_read_as_OFF(self, tmp_path, monkeypatch):
        def boom(request):
            raise RuntimeError("no user manager here")

        monkeypatch.setattr(
            ib,
            "PromptServer",
            SimpleNamespace(
                instance=SimpleNamespace(
                    user_manager=SimpleNamespace(settings=SimpleNamespace(get_settings=boom))
                )
            ),
            raising=False,
        )
        media = tmp_path / "clip.mp4"
        media.write_bytes(b"x")
        assert self._call(str(media)).status == 403

    def test_a_missing_file_and_a_bad_extension_answer_THE_SAME_403(self, tmp_path, monkeypatch):
        """The existence oracle. With the extension checked AFTER os.path.isfile
        the endpoint answered 404 for an absent path and 403 for a present
        non-media one — so an unauthenticated caller could enumerate any
        directory on the host without reading a byte. Both arms on the same
        extension, one file present and one absent."""
        self._settings(monkeypatch, {ib.SETTING_ALLOW_PATH_READS: True})
        present = tmp_path / "secret.key"
        present.write_bytes(b"x")
        absent = tmp_path / "not-here.key"
        assert self._call(str(present)).status == 403
        assert self._call(str(absent)).status == 403
        # ...while a whitelisted extension still distinguishes the two, which is
        # the paired positive: the collapse above is the extension gate acting,
        # not the endpoint having stopped answering.
        assert self._call(str(tmp_path / "gone.mp4")).status == 404

    def test_base_reports_the_opt_in_state(self, tmp_path, monkeypatch):
        import folder_paths

        for attr in ("get_input_directory", "get_output_directory", "get_temp_directory"):
            monkeypatch.setattr(folder_paths, attr, lambda: str(tmp_path), raising=False)
        monkeypatch.setattr(
            folder_paths, "get_user_directory", lambda: str(tmp_path), raising=False
        )
        monkeypatch.setattr(folder_paths, "base_path", str(tmp_path), raising=False)

        self._settings(monkeypatch, {})
        off = asyncio.run(ib.image_browser_base(_get_req({})))
        assert off._body["allow_path_reads"] is False

        self._settings(monkeypatch, {ib.SETTING_ALLOW_PATH_READS: True})
        on = asyncio.run(ib.image_browser_base(_get_req({})))
        assert on._body["allow_path_reads"] is True

    def test_a_caller_cannot_flip_the_opt_in_from_the_REQUEST(self, tmp_path, monkeypatch):
        """The reach must be the OWNER's configuration choice, not a parameter.
        A request that claims the opt-in every way it can — query string and
        header — is still refused while the stored setting is off, and the same
        request succeeds once the stored setting alone is on. That pair is what
        separates "reads the settings" from "reads whatever it is told"."""
        media = tmp_path / "clip.mp4"
        media.write_bytes(b"x")
        claimed = {
            "path": str(media),
            ib.SETTING_ALLOW_PATH_READS: "true",
            "allow_path_reads": "1",
            "type": "path",
        }
        headers = {**VALID, ib.SETTING_ALLOW_PATH_READS: "true", "X-Allow-Path-Reads": "1"}

        self._settings(monkeypatch, {})
        assert asyncio.run(ib.image_browser_file(_get_req(claimed, headers))).status == 403

        ib.web.FileResponse.reset_mock()
        self._settings(monkeypatch, {ib.SETTING_ALLOW_PATH_READS: True})
        asyncio.run(ib.image_browser_file(_get_req(claimed, headers)))
        ib.web.FileResponse.assert_called_once()


# ---------------------------------------------------------------------------
# The absolute-path read opt-in covers EVERY absolute-path read
# ---------------------------------------------------------------------------


class TestEveryAbsolutePathReadIsGated:
    """`ImageBrowser.AllowAbsolutePathReads` must mean what it is named.

    It used to gate /file alone while /thumb, /metadata and `type=path`
    listings kept their arbitrary reach. Measured with the opt-in OFF against
    real Pillow and a PNG outside every root: /file answered 403, and

        /thumb    -> 200 image/webp, 436 bytes, decoding to (512, 384) with
                     pixel(0,0) = (200, 30, 28) — the subject's own colour
        /metadata -> 200, returning the file's embedded `raw` text
        /list ?type=path&path=/etc -> 200, 19 directories enumerated

    A 512x384 re-encode of an image IS a read of it: a photo, a screenshot and
    a scanned document all survive that downscale legibly. So the switch covers
    all four, and each test below asserts BOTH directions on the same address —
    a refusal-only suite passes identically against endpoints that stopped
    answering at all.
    """

    @staticmethod
    def _sandbox(base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def test_thumb_refuses_a_path_read_when_off_and_resolves_it_when_on(self, tmp_path):
        outside = str(tmp_path / "photo.png")

        off = asyncio.run(ib.image_browser_thumb(_get_req({"path": outside})))
        assert off.status == 403
        assert off._body["error"] == ib.PATH_READS_DISABLED_MSG

        on = asyncio.run(
            ib.image_browser_thumb(
                _with_settings(_get_req({"path": outside}), {ib.SETTING_ALLOW_PATH_READS: True})
            )
        )
        # Past the gate: the resolver returned the path and the handler is now
        # answering about the FILE (absent -> 404), not about the setting.
        assert on.status == 404

    def test_metadata_refuses_a_path_read_when_off_and_resolves_it_when_on(self, tmp_path):
        outside = str(tmp_path / "notes.txt")

        off = asyncio.run(ib.image_browser_metadata(_get_req({"path": outside})))
        assert off.status == 403
        assert off._body["error"] == ib.PATH_READS_DISABLED_MSG

        on = asyncio.run(
            ib.image_browser_metadata(
                _with_settings(_get_req({"path": outside}), {ib.SETTING_ALLOW_PATH_READS: True})
            )
        )
        assert on.status == 400
        assert on._body["error"] == "unsupported file type"

    def test_list_refuses_type_path_when_off_and_enumerates_when_on(self, tmp_path):
        (tmp_path / "sub").mkdir()
        (tmp_path / "a.png").write_bytes(b"x")
        query = {"type": "path", "path": str(tmp_path)}

        off = asyncio.run(ib.image_browser_list(_get_req(query)))
        assert off.status == 403
        assert off._body["error"] == ib.PATH_READS_DISABLED_MSG
        assert "dirs" not in off._body, "a refused listing must not enumerate anything"

        on = asyncio.run(
            ib.image_browser_list(
                _with_settings(_get_req(query), {ib.SETTING_ALLOW_PATH_READS: True})
            )
        )
        assert on.status == 200
        assert [d["name"] for d in on._body["dirs"]] == ["sub"]

    def test_the_refusal_precedes_any_disk_touch(self, tmp_path, monkeypatch):
        """Refused before the filesystem is consulted, so an off install is not
        an existence oracle either — the same property /file already had.

        Both arms: the ON call is what proves the endpoints reach scandir at
        all, so a hard-wired `raise` in the spy could not pass this silently."""
        calls = []
        real_scandir = os.scandir

        def spy(path, *a, **kw):
            calls.append(path)
            return real_scandir(path, *a, **kw)

        monkeypatch.setattr(os, "scandir", spy)
        query = {"type": "path", "path": str(tmp_path)}

        asyncio.run(ib.image_browser_list(_get_req(query)))
        assert calls == [], f"a refused listing scanned {calls}"

        asyncio.run(
            ib.image_browser_list(
                _with_settings(_get_req(query), {ib.SETTING_ALLOW_PATH_READS: True})
            )
        )
        assert calls == [str(tmp_path)]

    def test_the_gate_precedes_the_RESOLVER_so_a_refusal_reveals_nothing(self, tmp_path):
        """Ordering, made observable.

        `_resolve_listing_base` answers 400 "missing path" for `type=path` with
        no path. Gate first and every refused request collapses to one 403, so a
        caller learns only that the switch is off. Gate second and the two
        answers differ — a small oracle, and exactly the shape /file's
        extension-before-isfile ordering exists to avoid.

        The paired positive is the same malformed request with the switch ON,
        which must still say 'missing path': the collapse above is the gate
        acting, not the endpoint having stopped validating."""
        off = asyncio.run(ib.image_browser_list(_get_req({"type": "path"})))
        assert off.status == 403
        assert off._body["error"] == ib.PATH_READS_DISABLED_MSG

        on = asyncio.run(
            ib.image_browser_list(
                _with_settings(_get_req({"type": "path"}), {ib.SETTING_ALLOW_PATH_READS: True})
            )
        )
        assert on.status == 400
        assert on._body["error"] == "missing path"

    def test_the_SANDBOXED_roots_are_never_gated(self, tmp_path, monkeypatch):
        """The switch is about reach OUTSIDE input/output/temp. Gating the roots
        too would turn the pack off by default, which is a different bug — and
        one a refusal-only suite would have called a pass."""
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "shot.png").write_bytes(b"x")

        resp = asyncio.run(ib.image_browser_list(_get_req({"type": "output"})))
        assert resp.status == 200
        assert [f["name"] for f in resp._body["files"]] == ["shot.png"]

        thumb = asyncio.run(
            ib.image_browser_thumb(_get_req({"type": "output", "name": "missing.png"}))
        )
        assert thumb.status == 404, "a sandboxed thumb must fail on the FILE, not on the setting"


class TestUserSettingsDegradeToOff:
    """ "Any failure degrades to off" has to be true, not merely documented.

    `_user_settings` used to be `get_settings(request) or {}` inside a try, so a
    truthy NON-mapping (a hand-edited settings file holding a list or a string)
    passed straight through and the caller's `.get` raised AttributeError
    OUTSIDE the try — a 500 from an endpoint whose contract is to answer 403.
    """

    @staticmethod
    def _stored(monkeypatch, value):
        monkeypatch.setattr(
            ib,
            "PromptServer",
            SimpleNamespace(
                instance=SimpleNamespace(
                    user_manager=SimpleNamespace(
                        settings=SimpleNamespace(get_settings=lambda request: value)
                    )
                )
            ),
            raising=False,
        )

    @pytest.mark.parametrize("value", [["a", "b"], "true", 7, {"a"}])
    def test_a_truthy_non_mapping_reads_as_off_rather_than_raising(self, monkeypatch, value):
        self._stored(monkeypatch, value)
        assert ib._user_settings(_get_req({})) == {}
        assert ib._absolute_path_reads_enabled(_get_req({})) is False
        assert ib._linked_subfolder_writes_enabled(_get_req({})) is False

    def test_a_real_mapping_still_reads_through(self, monkeypatch):
        """The paired positive: without it, `_user_settings` hard-wired to `{}`
        would pass every assertion above while switching both opt-ins off
        permanently."""
        self._stored(monkeypatch, {ib.SETTING_ALLOW_PATH_READS: True})
        assert ib._absolute_path_reads_enabled(_get_req({})) is True


class TestCorsHeaderFlag:
    """`--enable-cors-header` is an explicit "I want this reachable
    cross-origin", and core drops its OWN cross-site check under it. Refusing
    anyway broke that deployment with a message about a header the operator was
    already sending correctly.

    The Content-Type gate is NOT waived with it — that one is what stops a
    preflight-free <form> post, and it applies to every configuration.
    """

    @staticmethod
    def _flag(monkeypatch, value):
        module = SimpleNamespace(args=SimpleNamespace(enable_cors_header=value))
        monkeypatch.setitem(sys.modules, "comfy", SimpleNamespace(cli_args=module))
        monkeypatch.setitem(sys.modules, "comfy.cli_args", module)

    def test_cross_site_is_refused_without_the_flag_and_allowed_with_it(self, monkeypatch):
        cross = _req(**{"Sec-Fetch-Site": "cross-site"})
        self._flag(monkeypatch, False)
        assert ib._reject_cross_site(cross).status == 403
        self._flag(monkeypatch, True)
        assert ib._reject_cross_site(cross) is None

    def test_the_JSON_gate_survives_the_flag(self, monkeypatch):
        """The half that must NOT be waived. Without this arm the flag could be
        widened into a general guard off-switch and the suite would stay green."""
        self._flag(monkeypatch, True)
        form = _req(**{"Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site"})
        assert ib._reject_non_json(form).status == 415

    def test_an_absent_cli_args_module_leaves_the_STRICT_gate_in_force(self, monkeypatch):
        """Fail-closed. `comfy.cli_args` exists only inside a ComfyUI install, so
        the read is a guarded lazy import and any failure must keep the refusal —
        never open it. Paired with the allowed arm above."""
        monkeypatch.setitem(sys.modules, "comfy", None)
        monkeypatch.setitem(sys.modules, "comfy.cli_args", None)
        assert ib._cors_header_enabled() is False
        assert ib._reject_cross_site(_req(**{"Sec-Fetch-Site": "cross-site"})).status == 403
