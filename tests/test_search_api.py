import pytest


@pytest.mark.parametrize("params", [
    {"limit": 0}, {"limit": -1}, {"limit": 201}, {"limit": "oops"},
    {"offset": -1}, {"offset": "oops"}, {"collection_id": 0},
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
