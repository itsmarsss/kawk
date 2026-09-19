import pytest
from pydantic import ValidationError
from remember_hub.contracts.percepts import Detection, FaceObservation, TranscriptSegment


def test_inverted_box_is_invalid():
    with pytest.raises(ValidationError):
        Detection(track_id="x", label="keys", box_xyxy=(10, 10, 1, 1), score=0.9)


def test_normalized_face_contract():
    data = dict(box=(0, 0, 100, 100), det_score=0.9)
    with pytest.raises(ValidationError):
        FaceObservation(**data, embedding_512=[0.0] * 512)
    assert FaceObservation(**data, embedding_512=[1.0] + [0.0] * 511).model == "buffalo_l"


def test_partial_and_final_share_identity():
    first = TranscriptSegment(seg_id="session:0", text="Where", is_final=False)
    final = first.model_copy(update={"text": "Where are my keys?", "is_final": True})
    assert final.seg_id == first.seg_id
