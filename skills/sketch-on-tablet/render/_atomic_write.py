"""Atomic file-write helper.

Centralises the write-to-temp + `os.replace` idiom used by every
sketch-on-tablet component that mutates an on-disk file (the polling
lock file, design-state.md). `os.replace` is atomic on POSIX and
atomic-in-practice on NTFS for small files on one volume, which is the
only case any caller in this skill hits (each writer keeps the
sibling .tmp in the same parent directory as the destination).
"""
import os
from pathlib import Path


def atomic_write_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    """Write `content` to `path` atomically via a sibling .tmp + os.replace."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding=encoding)
    os.replace(tmp, path)
