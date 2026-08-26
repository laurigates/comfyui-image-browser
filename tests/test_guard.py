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

    def test_a_symlinked_SUBFOLDER_still_resolves_while_a_symlinked_NAME_does_not(
        self, tmp_path, monkeypatch
    ):
        """The load-bearing pair, and the reason the gate is NOT in the listing
        resolver. `output/renders -> /mnt/nas/renders` is the layout this
        workspace actually uses: navigating into it and deleting a file there
        must keep working. An entry that links OUT (`output/evil -> /etc`) must
        not."""
        root = tmp_path / "output"
        root.mkdir()
        nas = tmp_path / "nas"
        nas.mkdir()
        (nas / "clip.png").write_bytes(b"x")
        (root / "renders").symlink_to(nas, target_is_directory=True)
        outside = tmp_path / "outside"
        outside.mkdir()
        (root / "evil").symlink_to(outside, target_is_directory=True)
        self._sandbox(root, monkeypatch)

        target, err = ib._resolve_sandboxed_file("output", "renders", "clip.png")
        assert err == "", "a symlinked subfolder must stay writable"
        assert target is not None

        _t, err = ib._resolve_sandboxed_dir("output", "", "evil")
        assert err == "name escapes root"

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
