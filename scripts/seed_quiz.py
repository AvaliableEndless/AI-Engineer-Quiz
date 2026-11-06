"""Create a separate, deterministic catalog for the search/export exercise."""
from __future__ import annotations

import argparse
import io
import os
from pathlib import Path
import uuid

from PIL import Image, ImageDraw


def picture(index: int) -> bytes:
    image = Image.new("RGB", (640, 420), (180 + index % 60, 215, 235))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 230, 640, 420), fill=(30, 120 + index % 50, 160))
    draw.rectangle((0, 205, 640, 240), fill=(85, 95, 100))
    for n in range(5):
        x = 40 + n * 115
        draw.rectangle((x, 130 - n * 12, x + 80, 204), fill=(190, 70 + index % 100, 55 + n * 25))
    draw.polygon(((160, 295), (450, 295), (405, 340), (200, 340)), fill=(245, 245, 240))
    draw.rectangle((230, 260, 365, 294), fill=(60, 75, 85))
    draw.text((24, 24), f"HARBOR / DEMO {index:03}", fill=(20, 35, 45), font_size=28)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path,
                        help="New empty directory; an existing database is never overwritten.")
    args = parser.parse_args()
    data_dir = args.data_dir.resolve()
    if data_dir.exists() and any(data_dir.iterdir()):
        parser.error(f"Refusing nonempty data directory: {data_dir}. Choose a new directory.")
    os.environ["KEEPSTACK_DATA_DIR"] = str(data_dir)
    os.environ["KEEPSTACK_AI_ENABLED"] = "false"
    os.environ["KEEPSTACK_OCR_ENABLED"] = "false"

    # Configuration must be set before importing Keepstack.
    from keepstack import ingest
    from keepstack.auth import hash_password
    from keepstack.db import get_conn, init_db

    init_db()
    conn = get_conn()
    stamp = "2026-01-01T00:00:00+00:00"
    conn.execute(
        "INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,?,?)",
        ("admin", hash_password("admin"), "admin", stamp),
    )
    user = dict(conn.execute("SELECT * FROM users WHERE username='admin'").fetchone())
    for name in ("Harbor campaign", "Other collection"):
        conn.execute(
            "INSERT INTO collections(uuid,name,description,created_at) VALUES (?,?,?,?)",
            (str(uuid.uuid5(uuid.NAMESPACE_URL, name)), name, "Search/export demo", stamp),
        )
    conn.commit()

    cases = [dict() for _ in range(45)]
    cases += [
        {"tags": ["approved"]}, {"tags": ["campaign"]},
        {"tags": ["approved", "campaign", "internal"]},
        {"collection": 2}, {"collection": None},
        {"keyword": False}, {"status": "archived"}, {"status": "deleted"},
        {"document": True},
    ]
    for index, case in enumerate(cases):
        keyword = case.get("keyword", True)
        title = f'Harbor 素材, "宣传" {index:02}' if keyword else "Mountain landscape"
        filename = f"asset_{index:02}.png"
        content = picture(index)
        if case.get("document"):
            filename, content = "campaign_notes.txt", b"Harbor campaign notes"
        asset = ingest.ingest_stream(io.BytesIO(content), filename, user=user, run_ai=False, title=title)
        created = stamp if index < 30 else "2026-01-02T00:00:00+00:00"
        conn.execute(
            "UPDATE assets SET uuid=?,description=?,created_at=?,updated_at=?,status=? WHERE id=?",
            (str(uuid.uuid5(uuid.NAMESPACE_URL, f"quiz-asset-{index}")),
             '说明, "引号"\r\n第二行' if index == 0 else "Campaign material" if keyword else "Outdoor view",
             created, created, case.get("status", "active"), asset["id"]),
        )
        tags = case.get("tags", ["approved", "campaign"])
        if index == 0:
            tags = tags + ['客户, "宣传" & 50%_']
        for tag in tags:
            conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (tag,))
            conn.execute(
                "INSERT INTO asset_tags(asset_id,tag_id) SELECT ?,id FROM tags WHERE name=?",
                (asset["id"], tag),
            )
        collection = case.get("collection", 1)
        if collection is not None:
            conn.execute("INSERT INTO collection_assets(collection_id,asset_id) VALUES (?,?)",
                         (collection, asset["id"]))
        conn.commit()
        ingest.reindex_fts(asset["id"])
    print(f"Created {len(cases)} assets (52 active), 2 collections in {data_dir}")
    print("Login: admin / admin (local demo only)")
    print("harbor + Harbor campaign + image + include approved,campaign - exclude internal = 45")
    print("20 / 20 / 5 per page; first 30 matching assets share the same creation time.")


if __name__ == "__main__":
    main()
