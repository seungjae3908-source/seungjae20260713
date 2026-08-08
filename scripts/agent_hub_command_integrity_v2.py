#!/usr/bin/env python3
"""Immutable command body seals used to reject edited Issue comments."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Mapping, Sequence, Any

SEAL_PREFIX = "<!-- agent-hub-command-body-sha256:"
SEAL_RE = re.compile(r"(?m)^<!-- agent-hub-command-body-sha256:([0-9a-f]{64}) -->$")


class CommandIntegrityError(RuntimeError):
    pass


def _without_seal(body: str) -> str:
    lines = [line.rstrip() for line in body.replace("\r\n", "\n").split("\n") if not line.startswith(SEAL_PREFIX)]
    return "\n".join(lines).rstrip()


def body_digest(body: str) -> str:
    return hashlib.sha256(_without_seal(body).encode("utf-8")).hexdigest()


def seal_command_body(body: str) -> str:
    clean = _without_seal(body)
    return f"{clean}\n{SEAL_PREFIX}{hashlib.sha256(clean.encode('utf-8')).hexdigest()} -->"


def verify_command_body(body: str) -> str:
    matches = SEAL_RE.findall(body.replace("\r\n", "\n"))
    if len(matches) != 1 or matches[0] != body_digest(body):
        raise CommandIntegrityError("command comment body seal mismatch")
    return matches[0]


def processed_identity(comment_id: int, body: str) -> str:
    if comment_id <= 0:
        raise CommandIntegrityError("comment id is invalid")
    digest = verify_command_body(body)
    return f"{comment_id}:{digest[:16]}"


def self_test() -> int:
    body = seal_command_body("[HUB_COMMAND]\nschema_version: 2\nstatus: ready")
    assert verify_command_body(body) == body_digest(body)
    assert processed_identity(17, body).startswith("17:")
    try:
        verify_command_body(body.replace("status: ready", "status: blocked"))
    except CommandIntegrityError:
        pass
    else:
        raise AssertionError("edited comment passed integrity validation")
    print(json.dumps({"command_integrity_v2":"pass","edited_comment_accepted":0}))
    return 0

if __name__ == "__main__":
    raise SystemExit(self_test())
