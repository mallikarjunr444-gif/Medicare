"""Check-in results are saved per session and show up in the final report, for the owner only."""
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.v1.users import create_access_token
from app.models import ScreeningResult, User
from app.services import psych_screening as ps
from app.websocket import ConnectionManager
from tests.test_conversations import _seed_session
from tests.test_websocket import _wire_session


def _finish(scale_id, answers):
    s = ps.new_state()
    ps.start(s, scale_id)
    step = None
    for a in answers:
        step = ps.handle(s, str(a))
    return step


def test_finished_questionnaire_returns_a_record_to_save():
    step = _finish("gad7", [2] * 7)
    assert step.result == {"scale": "gad7", "name": "GAD-7", "score": 14, "max": 21, "band": "moderate",
                           "band_label": "moderate anxiety symptoms", "answers": [2] * 7, "item9_positive": False}
    assert _finish("gad7", [2] * 6).result is None  # nothing to save mid-way


def test_item9_returns_a_flag_not_a_score():
    step = _finish("phq9", [0] * 8 + [1])
    assert step.crisis and step.result["score"] is None and step.result["item9_positive"] is True
    assert step.result["answers"] == [0] * 8 + [1]


@pytest.fixture
def patched_db(test_engine, monkeypatch):
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr("app.database.AsyncSessionLocal", factory)
    return factory


@pytest.mark.asyncio
async def test_saved_once_per_scale_and_reported_to_the_client(db_session, test_user, patched_db):
    session = await _seed_session(db_session, test_user.id)
    m = ConnectionManager()
    ws = _wire_session(m, session.id, test_user.id)
    data = m.session_data[session.id]
    rec = _finish("gad7", [2] * 7).result
    await m._record_screening(session.id, data, rec, "en")
    await m._record_screening(session.id, data, {**rec, "score": 7, "band": "mild", "band_label": "mild anxiety symptoms"}, "en")  # retake replaces

    async with patched_db() as db:
        rows = (await db.execute(select(ScreeningResult))).scalars().all()
    assert len(rows) == 1 and rows[0].score == 7 and rows[0].user_id == test_user.id
    events = [e for e in ws.sent if e.get("type") == "screening_result"]
    assert events[0]["name"] == "GAD-7" and events[0]["score"] == 14 and events[0]["max"] == 21
    assert "answers" not in events[0]  # raw answers are stored, not pushed to the client


@pytest.mark.asyncio
async def test_a_save_failure_never_breaks_the_chat(db_session, test_user, monkeypatch):
    m = ConnectionManager()
    ws = _wire_session(m, "s1", test_user.id)
    monkeypatch.setattr("app.database.AsyncSessionLocal", lambda: (_ for _ in ()).throw(RuntimeError("db down")))
    await m._record_screening("s1", m.session_data["s1"], _finish("who5", [3] * 5).result, "en")
    assert any(e.get("type") == "screening_result" for e in ws.sent)  # still shown to the person


@pytest.mark.asyncio
async def test_final_report_and_check_ins_endpoint(client, db_session, test_user, auth_headers, patched_db):
    session = await _seed_session(db_session, test_user.id)
    m = ConnectionManager()
    _wire_session(m, session.id, test_user.id)
    await m._record_screening(session.id, m.session_data[session.id], _finish("pss10", [2] * 10).result, "en")
    await m._record_screening(session.id, m.session_data[session.id], _finish("phq9", [0] * 8 + [2]).result, "en")

    r = await client.get(f"/api/v1/consultation-reports/{session.id}/check-ins", headers=auth_headers)
    assert r.status_code == 200
    by_scale = {c["scale"]: c for c in r.json()["check_ins"]}
    assert by_scale["pss10"]["score"] == 20 and by_scale["pss10"]["band"] == "moderate"
    assert by_scale["phq9"]["item9_positive"] is True and by_scale["phq9"]["score"] is None
    assert "answers" not in by_scale["pss10"]

    put = await client.put(f"/api/v1/consultation-reports/{session.id}", headers=auth_headers, json={"report": {"id": "x"}})
    assert put.status_code == 200 and {c["scale"] for c in put.json()["check_ins"]} == {"pss10", "phq9"}
    got = await client.get(f"/api/v1/consultation-reports/{session.id}", headers=auth_headers)
    assert len(got.json()["check_ins"]) == 2


@pytest.mark.asyncio
async def test_other_users_cannot_read_check_ins(client, db_session, test_user, patched_db):
    session = await _seed_session(db_session, test_user.id)
    other = User(email="o@example.com", username="other", full_name="O", hashed_password="x")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    headers = {"Authorization": f"Bearer {create_access_token(data={'sub': other.id})}"}
    r = await client.get(f"/api/v1/consultation-reports/{session.id}/check-ins", headers=headers)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_no_check_ins_gives_an_empty_list(client, db_session, test_user, auth_headers):
    session = await _seed_session(db_session, test_user.id)
    r = await client.get(f"/api/v1/consultation-reports/{session.id}/check-ins", headers=auth_headers)
    assert r.status_code == 200 and r.json()["check_ins"] == []
