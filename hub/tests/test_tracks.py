"""Audit regression: track aliasing must respect the coast window, or person B
standing where person A stood inherits A's identity forever."""

from remember_hub.config import WorldCfg
from remember_hub.contracts.percepts import Detection
from remember_hub.world.tracks import TrackTable

BOX = (0.4, 0.1, 0.6, 0.9)


def det(track: str, box=BOX) -> Detection:
    return Detection(track_id=track, label="person", box_xyxy=box, score=0.9, frame_wh=(1, 1))


def test_alias_only_within_coast_window():
    tt = TrackTable(WorldCfg(coast_s=1.0, track_end_s=2.0), score_threshold=0.3)
    appeared, _ = tt.update([det("a")], now=0.0)
    assert [e.track_id for e in appeared] == ["a"]

    # Person A gone 1.5 s (past coast, before track-end); B arrives in the same spot.
    appeared, ended = tt.update([det("b")], now=1.5)
    assert [e.track_id for e in appeared] == ["b"], "stale entity must NOT absorb new track"
    assert not ended
    assert set(tt.entities) == {"a", "b"}

    # Within the coast window a same-label overlapping track IS a duplicate -> alias.
    appeared, _ = tt.update([det("c")], now=1.6)
    assert appeared == []
    assert tt.entities["b"].last_seen == 1.6


def test_frozen_extends_coasting_and_blocks_track_end():
    tt = TrackTable(WorldCfg(coast_s=1.0, track_end_s=2.0), score_threshold=0.3)
    tt.update([det("a")], now=0.0)
    tt.freeze()
    _, ended = tt.update([], now=10.0)
    assert not ended, "frozen table must never end tracks (§6.1 recycle rule)"
    assert [e.track_id for e in tt.in_view(10.0)] == ["a"], "frozen = extended coasting"
    tt.thaw()
    _, ended = tt.update([], now=10.1)
    assert [e.track_id for e in ended] == ["a"]
