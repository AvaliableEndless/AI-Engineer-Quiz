"""Keep all tests away from the local demonstration catalog."""
import os
import tempfile
import uuid

import pytest

os.environ["KEEPSTACK_DATA_DIR"] = tempfile.mkdtemp(prefix="keepstack-test-")
os.environ["KEEPSTACK_AI_ENABLED"] = "false"
os.environ["KEEPSTACK_OCR_ENABLED"] = "false"


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    from keepstack import db, ingest
    from keepstack.config import config

    previous = getattr(db._local, "conn", None)
    db._local.conn = None
    for name, value in {
        "data_dir": tmp_path, "db_path": tmp_path / "keepstack.db",
        "blob_dir": tmp_path / "blobs", "thumb_dir": tmp_path / "thumbnails",
        "cache_dir": tmp_path / "cache",
    }.items():
        monkeypatch.setattr(config, name, value)
    db.init_db()
    conn = db.get_conn()
    for name in ("Campaign demo", "Other collection"):
        conn.execute(
            "INSERT INTO collections (uuid,name,created_at) VALUES (?,?,?)",
            (str(uuid.uuid5(uuid.NAMESPACE_URL, name)), name, "2026-01-01"),
        )
    conn.commit()
    sequence = 0

    def add(*, title="Harbor photo", description="", tags=("approved", "campaign"),
            collection=1, media_type="image", status="active", created_at="2026-01-01",
            filename=None):
        nonlocal sequence
        sequence += 1
        asset_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"test-asset-{sequence}"))
        cur = conn.execute(
            """INSERT INTO assets
               (uuid,sha256,filename,title,description,media_type,mime_type,ext,size,
                status,storage_key,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (asset_uuid, f"hash-{sequence}", filename or f"asset-{sequence}.jpg",
             title, description, media_type, "image/jpeg", "jpg", sequence,
             status, f"blob-{sequence}", created_at, created_at),
        )
        asset_id = cur.lastrowid
        for name in tags:
            name = name.strip().lower()
            conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (name,))
            conn.execute(
                "INSERT INTO asset_tags(asset_id,tag_id) SELECT ?,id FROM tags WHERE name=?",
                (asset_id, name),
            )
        if collection is not None:
            conn.execute(
                "INSERT INTO collection_assets(collection_id,asset_id) VALUES (?,?)",
                (collection, asset_id),
            )
        conn.commit()
        ingest.reindex_fts(asset_id)
        return {"id": asset_id, "uuid": asset_uuid}

    yield {"add": add, "conn": conn}
    conn.close()
    db._local.conn = previous


@pytest.fixture
def client(catalog):
    from fastapi.testclient import TestClient
    from keepstack.app import app
    from keepstack.auth import hash_password, make_token

    conn = catalog["conn"]
    cur = conn.execute(
        """INSERT INTO users(username,password_hash,role,created_at)
           VALUES (?,?,?,?)""",
        ("reviewer", hash_password("test-password"), "admin", "2026-01-01"),
    )
    conn.commit()
    with TestClient(app) as test_client:
        test_client.headers["Authorization"] = "Bearer " + make_token(cur.lastrowid, "admin")
        yield test_client
