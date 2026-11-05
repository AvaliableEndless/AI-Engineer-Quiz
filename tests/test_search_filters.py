import pytest

from keepstack import search


def combined(**changes):
    return dict(q="harbor", collection_id=1, media_type="image",
                include_tags=["approved", "campaign"], exclude_tags=["internal"],
                **changes)


def test_combined_filters_and_legacy_tag(catalog):
    expected = catalog["add"]()
    catalog["add"](tags=["approved"])
    catalog["add"](tags=["approved", "campaign", "internal"])
    catalog["add"](collection=2)
    catalog["add"](media_type="video")
    catalog["add"](status="deleted")
    catalog["add"](status="archived")
    catalog["add"](title="Forest photo")
    result = search.search(**combined())
    assert result["total"] == 1
    assert [row["uuid"] for row in result["items"]] == [expected["uuid"]]
    legacy = search.search(q="harbor", collection_id=1, tag="APPROVED", media_type="image")
    assert legacy["total"] == 3


def test_tag_names_duplicates_unknown_and_conflicts(catalog):
    special = '客户, "宣传" & 50%_'
    expected = catalog["add"](tags=["approved", "campaign", special])
    catalog["add"](tags=["approved-extra"])
    result = search.search(include_tags=[" APPROVED ", "approved", special.upper()])
    assert [row["uuid"] for row in result["items"]] == [expected["uuid"]]
    assert search.search(include_tags=["app"])["total"] == 0
    assert search.search(include_tags=["missing"])["total"] == 0
    assert search.search(exclude_tags=["missing"])["total"] == 2
    assert search.search(include_tags=["approved"], exclude_tags=["APPROVED"])["total"] == 0
    assert search.search(exclude_tags=[special, "approved-extra"])["total"] == 0


@pytest.mark.parametrize("sort", ["newest", "oldest"])
def test_three_pages_with_equal_timestamps_are_stable(catalog, sort):
    expected = [catalog["add"](created_at="2026-01-01" if n < 30 else "2026-01-02")
                for n in range(45)]
    if sort == "newest":
        expected.reverse()
    actual = []
    for offset, count in [(0, 20), (20, 20), (40, 5), (60, 0)]:
        result = search.search(**combined(sort=sort), limit=20, offset=offset)
        assert result["total"] == 45
        assert len(result["items"]) == count
        actual.extend(row["uuid"] for row in result["items"])
    assert actual == [row["uuid"] for row in expected]
    assert len(set(actual)) == 45


@pytest.mark.parametrize("q,total", [("", 1), (" \t ", 1), ("!!!", 0),
                                      ('"harbor"*', 1), ("中文", 1), ("'; --", 0)])
def test_keyword_edge_cases(catalog, q, total):
    catalog["add"](title="Harbor 中文")
    assert search.search(q=q)["total"] == total


def test_existing_fts_fields_and_prefixes(catalog):
    asset = catalog["add"](title="Uniqueheading", description="Specialcaption",
                           filename="Oddfilename.jpg", tags=["distincttag"])
    for q in ["uniquehead", "specialcap", "oddfilename", "distincttag"]:
        assert search.search(q=q)["items"][0]["uuid"] == asset["uuid"]
