"""The documented demo command must be repeatable and preserve existing data."""
from pathlib import Path
import sqlite3
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def seed(directory):
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(ROOT / "scripts" / "seed_quiz.py"),
         "--data-dir", str(directory)],
        cwd=ROOT, capture_output=True, text=True, encoding="utf8", timeout=60,
    )


def snapshot(directory):
    with sqlite3.connect(directory / "keepstack.db") as conn:
        return conn.execute(
            "SELECT id,uuid,title,description,filename,media_type,status,created_at,sha256 "
            "FROM assets ORDER BY id"
        ).fetchall()


def test_seed_is_repeatable_and_refuses_overwrite(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    result = seed(first)
    assert result.returncode == 0, result.stderr
    rows = snapshot(first)
    assert len(rows) == 54
    assert sum(row[6] == "active" for row in rows) == 52
    assert len({row[1] for row in rows}) == 54
    assert len({row[8] for row in rows}) == 54
    assert len({row[7] for row in rows[:30]}) == 1
    assert len(list((first / "blobs").rglob("*.*"))) == 54
    assert len(list((first / "thumbnails").rglob("*.jpg"))) >= 53
    result = seed(second)
    assert result.returncode == 0, result.stderr
    assert snapshot(second) == rows
    result = seed(first)
    assert result.returncode != 0
    assert "Refusing nonempty data directory" in result.stderr
    assert snapshot(first) == rows
