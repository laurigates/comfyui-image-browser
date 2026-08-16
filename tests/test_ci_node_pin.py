"""CI must pin the Node the JS suites run under, from one source of truth.

WHY THIS IS A TEST AND NOT A COMMENT.

`bun run test` and `bun run test:e2e` do not run under bun. Both shell out to a
Node bin (`vitest`, `playwright`) whose shebang is `env node`, so the runtime is
the runner image's Node — a version nothing in this repo declares.

That is load-bearing rather than cosmetic, because the runtime decides which
`Storage` implementation the jsdom suite exercises. Measured locally, no flags:

    node 22.21.1   'localStorage' in globalThis -> False
    node 24.0.0    'localStorage' in globalThis -> False   (True with --experimental-webstorage)
    node 24.19.0   'localStorage' in globalThis -> False
    node 25.0.0    'localStorage' in globalThis -> True
    node 26.5.0    'localStorage' in globalThis -> True

So the built-in accessor is unflagged from **v25**, not from v22.4 (v22.4 is
where the *flag* landed — issue #40 conflated the two). Where the accessor
exists it evaluates to `undefined` without `--localstorage-file`, and vitest
copies jsdom's window globals onto `globalThis` only where the name is ABSENT,
so jsdom's real Storage never lands and `tests/js/setup-jsdom.js` installs its
in-memory shim instead. Below v25 there is no accessor, jsdom's Storage lands,
and the shim's guard is false.

Both paths are green today. The problem is that they are DIFFERENT paths, and
without a pin CI silently picks one while every developer picks the other — so
a shim-only regression cannot be caught by CI, and a jsdom-Storage-only one
cannot be caught locally. The pin is what makes the two sides agree.

This test exists because the pin lives in a workflow file that nothing else
reads: a new Node-running job added later, or a hand-edit dropping the step,
restores the divergence with no other signal.

WHY ONE JOB IS EXEMPT. `test-e2e` is Node-driven too and is deliberately NOT
pinned — @playwright/test 1.56.0 hangs installing Chromium under Node 26 (see
PIN_EXEMPT_JOBS for the measurement). That exemption is data here rather than a
comment in the workflow, and it is asserted in BOTH directions: an exempt job
that gains a pin fails, and a Node-driven job in neither set fails. An
exemption nobody can see is how a workaround becomes permanent.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
CI = REPO / ".github" / "workflows" / "ci.yml"
NODE_VERSION_FILE = REPO / ".node-version"

# The measured boundary above. Anything below this puts CI on jsdom's Storage
# while developers are on the shim. 25 itself reached end-of-life 2026-06-01,
# which is why the repo pins 26 rather than the bare minimum.
MIN_NODE_MAJOR = 25

# Commands that reach a Node bin rather than running under bun.
NODE_DRIVEN_COMMANDS = ("bun run test", "bun run test:e2e")

# Jobs that must read .node-version.
PINNED_JOBS = {"test-js"}

# Jobs that are Node-driven and deliberately NOT pinned, with the reason.
#
# Held as DATA rather than as a comment so the exemption cannot rot in either
# direction: adding the pin back fails the exemption test, and dropping a job
# from here without pinning it fails the coverage test. An exemption nobody can
# see is how a workaround becomes permanent.
PIN_EXEMPT_JOBS = {
    "test-e2e": (
        "@playwright/test 1.56.0 hangs installing Chromium under Node 26 — the "
        "download reaches 100% and the unzip never returns, with no error. "
        "Measured locally, same command, only the runtime varying: node 24.19.0 "
        "-> exit 0; node 26.5.0 -> hung, killed at 300s. Reproduced in CI (run "
        "31962595191 sat at that step for 50 minutes). This suite drives a real "
        "Chromium whose build Playwright pins itself, so it has no equivalent of "
        "the Storage divergence the pin exists to remove. Revisit when Playwright "
        "supports Node 26."
    ),
}


def _jobs() -> dict:
    return yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]


def _runs_node_suite(job: dict) -> bool:
    for step in job.get("steps") or []:
        run = (step.get("run") or "").strip()
        if any(line.strip() in NODE_DRIVEN_COMMANDS for line in run.splitlines()):
            return True
    return False


def _setup_node_step(job: dict) -> dict | None:
    for step in job.get("steps") or []:
        if str(step.get("uses") or "").startswith("actions/setup-node@"):
            return step
    return None


def test_the_node_version_file_exists_and_names_a_version_with_the_builtin_accessor():
    assert NODE_VERSION_FILE.is_file(), ".node-version is missing"
    raw = NODE_VERSION_FILE.read_text(encoding="utf-8").strip().lstrip("v")
    assert raw, ".node-version is empty"
    major = int(raw.split(".")[0])
    assert major >= MIN_NODE_MAJOR, (
        f".node-version pins Node {raw}, below v{MIN_NODE_MAJOR}. Node only "
        "exposes the built-in localStorage accessor unflagged from v25, so a "
        "lower pin puts CI on jsdom's Storage while developers run the "
        "tests/js/setup-jsdom.js shim — the divergence the pin exists to close."
    )


def test_every_node_driven_job_is_either_pinned_or_a_recorded_exemption():
    # The paired positive, and the thing that keeps the per-job checks honest.
    #
    # Without it, "every job in PINNED_JOBS is pinned" is true of a workflow
    # that runs no JS at all, and of one whose job names were renamed out from
    # under this test. It also forces a NEW Node-driven job to be classified:
    # it must go in PINNED_JOBS or into PIN_EXEMPT_JOBS with a reason, and
    # neither can be done by accident.
    found = {n for n, j in _jobs().items() if _runs_node_suite(j)}
    assert found == PINNED_JOBS | set(PIN_EXEMPT_JOBS), (
        f"the Node-driven jobs in ci.yml are {sorted(found)}, but this test "
        f"classifies {sorted(PINNED_JOBS | set(PIN_EXEMPT_JOBS))}. Either a job "
        f"was added/renamed/removed, or NODE_DRIVEN_COMMANDS no longer matches "
        f"how the suites are invoked — in which case the assertions below are "
        f"silently checking nothing."
    )
    assert found, "no Node-driven job found at all"


@pytest.mark.parametrize("job_name", sorted(PINNED_JOBS))
def test_a_pinned_job_reads_the_shared_node_version_file(job_name: str):
    job = _jobs()[job_name]
    assert _runs_node_suite(job), f"{job_name} no longer runs a Node-driven suite"
    step = _setup_node_step(job)
    assert step is not None, (
        f"{job_name} runs a Node bin but has no actions/setup-node step, so it "
        f"runs on whatever Node the runner image ships."
    )
    # One source of truth: the file, not a literal repeated per job. A version
    # written inline here and again in .node-version is two numbers that drift.
    assert (step.get("with") or {}).get("node-version-file") == ".node-version", (
        f"{job_name} sets up Node without reading .node-version "
        f"(with: {step.get('with')!r}). Use node-version-file so the workflow "
        f"and local tooling cannot disagree."
    )
    assert "node-version" not in (step.get("with") or {}), (
        f"{job_name} pins an inline node-version alongside node-version-file; "
        f"setup-node prefers the inline one, which reintroduces the drift."
    )


@pytest.mark.parametrize("job_name", sorted(PIN_EXEMPT_JOBS))
def test_an_exempt_job_is_still_unpinned_and_still_carries_its_reason(job_name: str):
    # The other direction. Pinning an exempt job "for consistency" is a change
    # that looks obviously right and breaks the job — test-e2e sat at Install
    # Chromium for 50 minutes when it was pinned. Going red here is how the next
    # person finds the measurement instead of repeating it.
    job = _jobs()[job_name]
    assert _runs_node_suite(job), f"{job_name} no longer runs a Node-driven suite"
    assert _setup_node_step(job) is None, (
        f"{job_name} is listed in PIN_EXEMPT_JOBS but now sets up Node. If the "
        f"exemption no longer applies, move it to PINNED_JOBS and delete the "
        f"reason. Reason on record: {PIN_EXEMPT_JOBS[job_name]}"
    )
    assert len(PIN_EXEMPT_JOBS[job_name]) > 80, (
        f"{job_name}'s exemption has no substantive reason recorded. An "
        f"exemption without one is indistinguishable from an oversight."
    )
