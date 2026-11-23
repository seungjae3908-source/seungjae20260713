"""원자적 저장, 실행 잠금, 체크포인트, 결과 불변 보관."""
from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional


class LockBusyError(RuntimeError):
    """같은 작업이 이미 실행 중."""


class IntegrityError(RuntimeError):
    """저장 파일 해시 불일치."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fsync_dir(d: Path) -> None:
    try:
        fd = os.open(str(d), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_bytes(path: Path, data: bytes, *, overwrite: bool = True) -> str:
    """임시 파일에 쓰고 fsync 후 rename. 중간에 죽어도 반쪽 파일이 남지 않는다."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not overwrite and path.exists():
        raise FileExistsError(f"이미 존재하는 결과는 덮어쓰지 않습니다: {path}")
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".part", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if not overwrite:
            # 경쟁 상태에서도 덮어쓰지 않도록 link 로 생성(이미 있으면 실패)
            os.link(tmp, path)
            os.unlink(tmp)
        else:
            os.replace(tmp, path)
        _fsync_dir(path.parent)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    return sha256_bytes(data)


def atomic_write_json(path: Path, obj: Any, *, overwrite: bool = True) -> str:
    data = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True, default=str).encode("utf-8")
    return atomic_write_bytes(path, data, overwrite=overwrite)


def read_json(path: Path) -> Any:
    with open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def cleanup_partials(directory: Path) -> int:
    """이전 실행이 남긴 .part 임시 파일 제거. 제거 개수 반환."""
    n = 0
    if not Path(directory).exists():
        return 0
    for p in Path(directory).rglob(".*.part"):
        try:
            p.unlink()
            n += 1
        except FileNotFoundError:
            pass
    return n


@contextmanager
def run_lock(lock_path: Path) -> Iterator[Path]:
    """flock 기반 단일 실행 잠금. 프로세스가 죽으면 OS 가 잠금을 풀어 준다."""
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                holder = ""
                try:
                    holder = os.pread(fd, 64, 0).decode(errors="replace").strip()
                except OSError:
                    pass
                raise LockBusyError(f"이미 실행 중입니다 (잠금 {lock_path}, pid={holder or '?'})") from None
            raise
        os.ftruncate(fd, 0)
        os.pwrite(fd, str(os.getpid()).encode(), 0)
        yield lock_path
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


class Checkpoint:
    """작업 단위(예: 월별 파일) 완료 기록. 완료 항목은 해시와 함께 남겨 재개 시 검증한다."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.state: dict[str, Any] = {"done": {}}
        if self.path.exists():
            self.state = read_json(self.path)
            self.state.setdefault("done", {})

    def is_done(self, key: str, artifact: Optional[Path] = None) -> bool:
        rec = self.state["done"].get(key)
        if rec is None:
            return False
        if artifact is not None:
            if not Path(artifact).exists():
                return False
            if rec.get("sha256") and sha256_file(Path(artifact)) != rec["sha256"]:
                return False
        return True

    def mark_done(self, key: str, **info: Any) -> None:
        self.state["done"][key] = info
        atomic_write_json(self.path, self.state)

    def forget(self, key: str) -> None:
        self.state["done"].pop(key, None)
        atomic_write_json(self.path, self.state)


def write_manifest(directory: Path, files: list[Path], extra: Optional[dict] = None) -> Path:
    directory = Path(directory)
    entries = {}
    for f in files:
        f = Path(f)
        entries[str(f.relative_to(directory))] = {"sha256": sha256_file(f), "bytes": f.stat().st_size}
    manifest = {"files": entries, **(extra or {})}
    out = directory / "MANIFEST.json"
    atomic_write_json(out, manifest, overwrite=False)
    return out


def verify_manifest(directory: Path) -> dict:
    directory = Path(directory)
    manifest = read_json(directory / "MANIFEST.json")
    bad = []
    for rel, meta in manifest["files"].items():
        p = directory / rel
        if not p.exists():
            bad.append({"file": rel, "reason": "missing"})
        elif sha256_file(p) != meta["sha256"]:
            bad.append({"file": rel, "reason": "sha256_mismatch"})
    if bad:
        raise IntegrityError(f"무결성 실패: {bad}")
    return {"ok": True, "files": len(manifest["files"])}
