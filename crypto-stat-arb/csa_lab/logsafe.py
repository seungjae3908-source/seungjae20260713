"""비밀정보 마스킹 + 용량 제한 로그."""
from __future__ import annotations

import logging
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path

_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|secret|token|signature|password|passphrase|authorization|x-mbx-apikey)(\s*[=:]\s*|\"\s*:\s*\")([^\s\"&,]+)"),
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}\b"),  # 텔레그램 봇 토큰 형태
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._-]{10,}"),
]


def mask_secrets(text: str) -> str:
    out = _PATTERNS[0].sub(lambda m: f"{m.group(1)}{m.group(2)}***", text)
    out = _PATTERNS[1].sub("***BOT_TOKEN***", out)
    out = _PATTERNS[2].sub("Bearer ***", out)
    return out


class MaskingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        record.msg = mask_secrets(msg)
        record.args = ()
        return True


def setup_logger(name: str, log_dir: Path, *, max_bytes: int = 2_000_000, backups: int = 3,
                 console: bool = True) -> logging.Logger:
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for h in list(logger.handlers):
        logger.removeHandler(h)
        h.close()
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    fh = RotatingFileHandler(log_dir / f"{name}.log", maxBytes=max_bytes, backupCount=backups, encoding="utf-8")
    fh.setFormatter(fmt)
    fh.addFilter(MaskingFilter())
    logger.addHandler(fh)
    if console:
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        sh.addFilter(MaskingFilter())
        logger.addHandler(sh)
    return logger
