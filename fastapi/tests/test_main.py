"""
tests/test_main.py
-------------------
בודק את הזרימה המלאה:
1. Baileys שולח authenticated + creds_b64
2. FastAPI שומר ב-Redis
3. FastAPI מעביר לwebhooks חיצוניים רשומים
4. Webhooks חיצוניים מקבלים את הpayload הנכון

הרצה:
    cd fastapi
    pip install pytest pytest-asyncio httpx fastapi pydantic redis
    pytest tests/test_main.py -v
"""

import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock, call
from fastapi.testclient import TestClient

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from main import app

client = TestClient(app, raise_server_exceptions=False)

# ── קבועים ────────────────────────────────────────────────────────────────────
PHONE        = "972501234567"
JID          = "972501234567@s.whatsapp.net"
CREDS_B64    = "eyJub2lzZUtleVByaXZhdGUiOiJhYmMxMjM0NTY3ODkwIn0="
WEBHOOK_URL  = "https://external.com/hook"
WEBHOOK_URL2 = "https://other2.com/hook"

# ── אירועים שBaileys שולח ─────────────────────────────────────────────────────

AUTH_EVENT = {
    "event":     "authenticated",
    "phone":     PHONE,
    "jid":       JID,
    "name":      "עסק לדוגמה",
    "timestamp": "2024-01-01T12:00:00Z",
    "creds_b64": CREDS_B64,
}

TEXT_MESSAGE = {
    "event":     "message",
    "messageId": "msg_123",
    "jid":       JID,
    "type":      "text",
    "data":      {"text": "שלום"},
    "timestamp": 1700000000,
    "fromMe":    False,
}

IMAGE_MESSAGE = {
    "event":   "message",
    "messageId": "msg_456",
    "jid":     JID,
    "type":    "image",
    "data":    {"caption": "תמונה"},
    "fromMe":  False,
}

GROUP_MESSAGE = {
    "event":   "message",
    "messageId": "msg_789",
    "jid":     "120363000@g.us",
    "type":    "text",
    "data":    {"text": "הודעה בקבוצה"},
    "isGroup": True,
    "fromMe":  False,
}

MY_MESSAGE = {
    "event":   "message",
    "messageId": "msg_999",
    "jid":     JID,
    "type":    "text",
    "data":    {"text": "שלחתי"},
    "fromMe":  True,
}


# ── Redis mock ────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def mock_redis():
    """Redis in-memory mock לכל בדיקה."""
    store = {}

    async def fake_get(key):
        return store.get(key)

    async def fake_set(key, val):
        store[key] = val

    async def fake_ping():
        return True

    mock = AsyncMock()
    mock.get  = AsyncMock(side_effect=fake_get)
    mock.set  = AsyncMock(side_effect=fake_set)
    mock.ping = AsyncMock(side_effect=fake_ping)

    app.state.redis = mock
    yield mock, store


@pytest.fixture()
def with_one_webhook(mock_redis):
    """webhook חיצוני אחד רשום."""
    _, store = mock_redis
    store["wa:external_hooks"] = json.dumps([
        {"url": WEBHOOK_URL, "secret": None}
    ])


@pytest.fixture()
def with_two_webhooks(mock_redis):
    """שני webhooks חיצוניים רשומים."""
    _, store = mock_redis
    store["wa:external_hooks"] = json.dumps([
        {"url": WEBHOOK_URL,  "secret": None},
        {"url": WEBHOOK_URL2, "secret": "s3cr3t"},
    ])


# ══════════════════════════════════════════════════════════════════════════════
# 1. אירוע authenticated — שמירה ב-Redis
# ══════════════════════════════════════════════════════════════════════════════

class TestAuthenticatedEventStorage:

    def test_creds_b64_saved_to_redis(self, mock_redis):
        """authenticated → creds_b64 נשמר ב-Redis לפי phone."""
        _, store = mock_redis

        client.post("/internal/baileys-event", json=AUTH_EVENT)

        assert f"wa:creds:{PHONE}" in store
        assert store[f"wa:creds:{PHONE}"] == CREDS_B64

    def test_last_auth_saved_to_redis(self, mock_redis):
        """authenticated → wa:last_auth נשמר עם phone + jid + name."""
        _, store = mock_redis

        client.post("/internal/baileys-event", json=AUTH_EVENT)

        assert "wa:last_auth" in store
        info = json.loads(store["wa:last_auth"])
        assert info["phone"] == PHONE
        assert info["jid"]   == JID
        assert info["name"]  == "עסק לדוגמה"

    def test_regular_message_does_not_save_creds(self, mock_redis):
        """הודעה רגילה לא שומרת creds."""
        _, store = mock_redis

        client.post("/internal/baileys-event", json=TEXT_MESSAGE)

        assert f"wa:creds:{PHONE}" not in store
        assert "wa:last_auth"       not in store

    def test_authenticated_without_creds_b64_not_saved(self, mock_redis):
        """authenticated בלי creds_b64 — לא שומר."""
        _, store = mock_redis
        event = {**AUTH_EVENT}
        del event["creds_b64"]

        client.post("/internal/baileys-event", json=event)

        assert f"wa:creds:{PHONE}" not in store


# ══════════════════════════════════════════════════════════════════════════════
# 2. אירוע authenticated — העברה לwebhooks חיצוניים
# ══════════════════════════════════════════════════════════════════════════════

class TestAuthenticatedEventForwarding:

    def test_auth_event_forwarded_with_creds_b64(self, with_one_webhook):
        """authenticated מועבר לwebhook עם creds_b64 מלא."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post          = AsyncMock(return_value=mock_resp)
            mock_c.__aenter__    = AsyncMock(return_value=mock_c)
            mock_c.__aexit__     = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            client.post("/internal/baileys-event", json=AUTH_EVENT)

            payload = mock_c.post.call_args[1]["json"]
            assert payload["event"]     == "authenticated"
            assert payload["phone"]     == PHONE
            assert payload["creds_b64"] == CREDS_B64

    def test_auth_event_forwarded_to_all_webhooks(self, with_two_webhooks):
        """authenticated מועבר לכל webhooks רשומים."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post          = AsyncMock(return_value=mock_resp)
            mock_c.__aenter__    = AsyncMock(return_value=mock_c)
            mock_c.__aexit__     = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            client.post("/internal/baileys-event", json=AUTH_EVENT)

            urls = [c[0][0] for c in mock_c.post.call_args_list]
            assert WEBHOOK_URL  in urls
            assert WEBHOOK_URL2 in urls

    def test_auth_event_sends_secret_header(self, with_two_webhooks):
        """webhook עם secret מקבל X-Webhook-Secret header."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post          = AsyncMock(return_value=mock_resp)
            mock_c.__aenter__    = AsyncMock(return_value=mock_c)
            mock_c.__aexit__     = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            client.post("/internal/baileys-event", json=AUTH_EVENT)

            # מצא את הקריאה ל-WEBHOOK_URL2 (זה שיש לו secret)
            calls_by_url = {
                c[0][0]: c[1]["headers"]
                for c in mock_c.post.call_args_list
            }
            assert calls_by_url[WEBHOOK_URL2].get("X-Webhook-Secret") == "s3cr3t"
            assert "X-Webhook-Secret" not in calls_by_url[WEBHOOK_URL]

    def test_no_webhooks_registered_returns_ok(self, mock_redis):
        """אין webhooks — עדיין מחזיר ok ושומר ב-Redis."""
        _, store = mock_redis

        resp = client.post("/internal/baileys-event", json=AUTH_EVENT)

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert store.get(f"wa:creds:{PHONE}") == CREDS_B64  # עדיין נשמר!

    def test_webhook_failure_does_not_crash(self, with_one_webhook):
        """webhook חיצוני שנופל — לא קורס, עדיין מחזיר ok."""
        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post          = AsyncMock(side_effect=Exception("timeout"))
            mock_c.__aenter__    = AsyncMock(return_value=mock_c)
            mock_c.__aexit__     = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            resp = client.post("/internal/baileys-event", json=AUTH_EVENT)

        assert resp.status_code == 200


# ══════════════════════════════════════════════════════════════════════════════
# 3. הודעות רגילות — העברה לwebhooks
# ══════════════════════════════════════════════════════════════════════════════

class TestMessageForwarding:

    def test_text_message_forwarded(self, with_one_webhook):
        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post          = AsyncMock(return_value=MagicMock(status_code=200))
            mock_c.__aenter__    = AsyncMock(return_value=mock_c)
            mock_c.__aexit__     = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            client.post("/internal/baileys-event", json=TEXT_MESSAGE)

            payload = mock_c.post.call_args[1]["json"]
            assert payload["type"]      == "text"
            assert payload["messageId"] == "msg_123"

    def test_image_message_forwarded(self, with_one_webhook):
        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post          = AsyncMock(return_value=MagicMock(status_code=200))
            mock_c.__aenter__    = AsyncMock(return_value=mock_c)
            mock_c.__aexit__     = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            client.post("/internal/baileys-event", json=IMAGE_MESSAGE)

            payload = mock_c.post.call_args[1]["json"]
            assert payload["type"] == "image"

    def test_group_message_forwarded(self, with_one_webhook):
        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post          = AsyncMock(return_value=MagicMock(status_code=200))
            mock_c.__aenter__    = AsyncMock(return_value=mock_c)
            mock_c.__aexit__     = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            client.post("/internal/baileys-event", json=GROUP_MESSAGE)

            payload = mock_c.post.call_args[1]["json"]
            assert payload["isGroup"] is True

    def test_my_own_message_forwarded(self, with_one_webhook):
        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post          = AsyncMock(return_value=MagicMock(status_code=200))
            mock_c.__aenter__    = AsyncMock(return_value=mock_c)
            mock_c.__aexit__     = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            client.post("/internal/baileys-event", json=MY_MESSAGE)

            payload = mock_c.post.call_args[1]["json"]
            assert payload["fromMe"] is True


# ══════════════════════════════════════════════════════════════════════════════
# 4. /auth/status + /auth/creds — קריאה מ-Redis
# ══════════════════════════════════════════════════════════════════════════════

class TestAuthEndpoints:

    def test_auth_status_after_authenticated_event(self, mock_redis):
        """אחרי authenticated event — /auth/status מחזיר מחובר."""
        client.post("/internal/baileys-event", json=AUTH_EVENT)

        resp = client.get("/auth/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["authenticated"] is True
        assert body["phone"]         == PHONE

    def test_auth_status_before_any_event(self, mock_redis):
        """/auth/status לפני כל אירוע — לא מחובר."""
        resp = client.get("/auth/status")
        assert resp.json()["authenticated"] is False

    def test_get_creds_after_authenticated_event(self, mock_redis):
        """אחרי authenticated — /auth/creds/{phone} מחזיר creds_b64."""
        client.post("/internal/baileys-event", json=AUTH_EVENT)

        resp = client.get(f"/auth/creds/{PHONE}")
        assert resp.status_code == 200
        assert resp.json()["creds_b64"] == CREDS_B64
        assert resp.json()["phone"]     == PHONE

    def test_get_creds_unknown_phone_returns_404(self, mock_redis):
        resp = client.get("/auth/creds/000000")
        assert resp.status_code == 404

    def test_auth_dashboard_returns_html(self, mock_redis):
        """/auth/dashboard מחזיר HTML תקין."""
        client.post("/internal/baileys-event", json=AUTH_EVENT)

        resp = client.get("/auth/dashboard")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]
        assert PHONE in resp.text
        assert CREDS_B64[:20] in resp.text


# ══════════════════════════════════════════════════════════════════════════════
# 5. ניהול webhooks — register / unregister / list
# ══════════════════════════════════════════════════════════════════════════════

class TestWebhookManagement:

    def test_register_webhook(self, mock_redis):
        with patch("main.baileys_post", new=AsyncMock(return_value={"success": True})):
            resp = client.post("/webhooks/register", json={"url": WEBHOOK_URL})
        assert resp.status_code == 200
        assert resp.json()["success"] is True

    def test_register_duplicate_not_doubled(self, mock_redis):
        _, store = mock_redis
        store["wa:external_hooks"] = json.dumps([{"url": WEBHOOK_URL, "secret": None}])

        with patch("main.baileys_post", new=AsyncMock(return_value={"success": True})):
            client.post("/webhooks/register", json={"url": WEBHOOK_URL})

        saved = json.loads(store["wa:external_hooks"])
        assert len([h for h in saved if h["url"] == WEBHOOK_URL]) == 1

    def test_unregister_webhook(self, mock_redis):
        _, store = mock_redis
        store["wa:external_hooks"] = json.dumps([
            {"url": WEBHOOK_URL,  "secret": None},
            {"url": WEBHOOK_URL2, "secret": None},
        ])

        with patch("main.baileys_delete", new=AsyncMock(return_value={"success": True})):
            client.request("DELETE", "/webhooks/unregister", json={"url": WEBHOOK_URL})

        saved = json.loads(store["wa:external_hooks"])
        assert not any(h["url"] == WEBHOOK_URL  for h in saved)
        assert     any(h["url"] == WEBHOOK_URL2 for h in saved)

    def test_list_webhooks_hides_secrets(self, mock_redis):
        _, store = mock_redis
        store["wa:external_hooks"] = json.dumps([
            {"url": WEBHOOK_URL,  "secret": "topsecret"},
            {"url": WEBHOOK_URL2, "secret": None},
        ])

        resp = client.get("/webhooks")
        items = resp.json()["webhooks"]
        assert items[0]["has_secret"] is True
        assert items[1]["has_secret"] is False
        assert "topsecret" not in resp.text