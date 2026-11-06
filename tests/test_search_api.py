import pytest
import csv
import io
import json
from urllib.parse import quote


def csv_rows(response):
    assert response.status_code == 200, response.text
    assert response.content.startswith(b"\xef\xbb\xbf")
    assert "attachment" in response.headers["content-disposition"]
    return list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


def query(sort="newest"):
    return [("q", "harbor"), ("collection_id", "1"), ("media_type", "image"),
            ("include_tags", "approved"), ("include_tags", "campaign"),
            ("exclude_tags", "internal"), ("sort", sort)]


@pytest.mark.parametrize("params", [
    {"limit": 0}, {"limit": -1}, {"limit": 201}, {"limit": "oops"},
    {"offset": -1}, {"offset": "oops"}, {"offset": 2**63},
    {"collection_id": 0}, {"collection_id": 2**63},
    {"sort": "unknown"}, {"status": "deleted"}, {"mode": "semantic"},
])
def test_invalid_query_parameters(client, params):
    assert client.get("/api/assets", params=params).status_code == 422


def test_repeated_tag_parameters_and_total(client, catalog):
    good = catalog["add"]()
    catalog["add"](tags=["approved"])
    response = client.get("/api/assets", params=[
        ("q", "harbor"), ("collection_id", "1"), ("include_tags", "APPROVED"),
        ("include_tags", "campaign"), ("exclude_tags", "internal"), ("limit", "1"),
    ])
    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert response.json()["items"][0]["uuid"] == good["uuid"]


def test_list_requires_login(client):
    assert client.get("/api/assets", headers={"Authorization": ""}).status_code == 401


def test_out_of_range_page_and_largest_valid_integer(client, catalog):
    catalog["add"]()
    response = client.get("/api/assets", params={"offset": 2**63 - 1})
    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert response.json()["items"] == []
    assert client.get("/api/assets", params={"collection_id": 2**63 - 1}).json()["total"] == 0


@pytest.mark.parametrize("sort", ["newest", "oldest", "name", "largest"])
def test_export_matches_all_pages_and_roundtrips_fields(client, catalog, sort):
    special = '客户, "宣传" & 50%_'
    expected = [catalog["add"](
        title=f'Harbor 中文, "标题"\n{n:02}',
        description='说明, "引号"\r\n第二行',
        filename=f'素材, "{n}"\n.jpg',
        tags=["campaign", "approved", special],
        created_at="2026-01-01" if n < 30 else "2026-01-02",
    ) for n in range(45)]
    catalog["add"](tags=["approved", "campaign", "internal"])
    catalog["add"](media_type="video")
    catalog["add"](collection=2)
    catalog["add"](status="deleted")
    listed = []
    for offset in (0, 20, 40):
        response = client.get("/api/assets", params=query(sort) + [("offset", offset)])
        assert response.status_code == 200
        assert response.json()["total"] == 45
        listed.extend(response.json()["items"])
    exported = csv_rows(client.get("/api/assets/export.csv", params=query(sort) + [
        ("limit", "1"), ("offset", "20"),
    ]))
    assert [row["uuid"] for row in exported] == [row["uuid"] for row in listed]
    assert {row["uuid"] for row in exported} == {row["uuid"] for row in expected}
    assert list(exported[0]) == [
        "uuid", "title", "description", "filename", "media_type", "tags", "created_at",
    ]
    for row in exported:
        original = catalog["conn"].execute("SELECT * FROM assets WHERE uuid=?", (row["uuid"],)).fetchone()
        for field in ("title", "description", "filename", "media_type", "created_at"):
            assert row[field] == original[field]
        assert json.loads(row["tags"]) == sorted(["campaign", "approved", special])


def test_export_over_two_hundred_rows(client, catalog):
    expected = {catalog["add"]()["uuid"] for _ in range(205)}
    exported = csv_rows(client.get("/api/assets/export.csv"))
    assert {row["uuid"] for row in exported} == expected


def test_empty_export_auth_and_validation(client):
    response = client.get("/api/assets/export.csv")
    assert csv_rows(response) == []
    assert next(csv.reader(io.StringIO(response.content.decode("utf-8-sig")))) == [
        "uuid", "title", "description", "filename", "media_type", "tags", "created_at",
    ]
    assert client.get("/api/assets/export.csv", headers={"Authorization": ""}).status_code == 401
    for params in [{"sort": "unknown"}, {"status": "deleted"}, {"mode": "semantic"},
                   {"collection_id": 2**63}]:
        assert client.get("/api/assets/export.csv", params=params).status_code == 422


def test_edits_refresh_fts_filters_and_export(client, catalog):
    asset = catalog["add"](title="Oldneedle", description="Oldcaption")
    url = "/api/assets/" + asset["uuid"]
    assert client.get("/api/assets", params={"q": "oldneedle"}).json()["total"] == 1
    assert client.patch(url, json={"title": "Newneedle 中文", "description": '新说明, "x"\n下一行'}).status_code == 200
    assert client.get("/api/assets", params={"q": "oldneedle"}).json()["total"] == 0
    assert client.get("/api/assets", params={"q": "oldcaption"}).json()["total"] == 0
    rows = csv_rows(client.get("/api/assets/export.csv", params={"q": "newneedle"}))
    assert rows[0]["description"] == '新说明, "x"\n下一行'
    assert rows[0]["title"] == "Newneedle 中文"
    name = 'Specialtag 中文, "x"&'
    assert client.post(url + "/tags", json={"name": name}).status_code == 200
    for endpoint in ("/api/assets", "/api/assets/export.csv"):
        response = client.get(endpoint, params={"q": "specialtag", "include_tags": name})
        if endpoint.endswith(".csv"):
            assert csv_rows(response)[0]["uuid"] == asset["uuid"]
        else:
            assert response.json()["total"] == 1
    assert client.delete(url + "/tags/" + quote(name, safe="")).status_code == 200
    assert client.get("/api/assets", params={"q": "specialtag"}).json()["total"] == 0
    assert csv_rows(client.get("/api/assets/export.csv", params={"include_tags": name})) == []
    assert client.delete(url + "/tags/campaign").status_code == 200
    assert client.get("/api/assets", params={"include_tags": "campaign"}).json()["total"] == 0
