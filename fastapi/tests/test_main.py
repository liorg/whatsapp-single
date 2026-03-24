"""
tests/test_main.py
-------------------
Unit tests — מדמה events של Baileys ובודק שהם מועברים לwebhooks חיצוניים.
ללא Docker / Redis / Baileys אמיתי.

הרצה:
    cd fastapi
    pip install pytest pytest-asyncio httpx fastapi pydantic redis
    pytest tests/test_main.py -v
"""

import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from main import app

client = TestClient(app, raise_server_exceptions=False)

WEBHOOK_URL  = "https://external.com/hook"
WEBHOOK_URL2 = "https://other.com/hook"

# ── הודעות לדוגמה שBaileys שולח ──────────────────────────────────────────────

TEXT_MESSAGE = {
    "event":     "message",
    "messageId": "msg_123",
    "jid":       "972501234567@s.whatsapp.net",
    "sender":    "972501234567@s.whatsapp.net",
    "type":      "text",
    "data":      {"text": "שלום עולם"},
    "timestamp": 1700000000,
    "fromMe":    False,
    "isGroup":   False,
    "receivedAt": "2024-01-01T12:00:00Z",
}

IMAGE_MESSAGE = {
    "event":     "message",
    "messageId": "msg_456",
    "jid":       "972501234567@s.whatsapp.net",
    "type":      "image",
    "data":      {"caption": "תמונה יפה"},
    "timestamp": 1700000001,
    "fromMe":    False,
}

GROUP_MESSAGE = {
    "event":     "message",
    "messageId": "msg_789",
    "jid":       "120363000000000000@g.us",
    "sender":    "972501234567@s.whatsapp.net",
    "type":      "text",
    "data":      {"text": "הודעה בקבוצה"},
    "timestamp": 1700000002,
    "isGroup":   True,
}

MY_MESSAGE = {
    "event":     "message",
    "messageId": "msg_999",
    "jid":       "972509999999@s.whatsapp.net",
    "type":      "text",
    "data":      {"text": "שלחתי"},
    "timestamp": 1700000003,
    "fromMe":    True,
}


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def mock_redis():
    """Redis mock — מדמה get/set בזיכרון."""
    store = {}

    async def fake_get(key):
        return store.get(key)

    async def fake_set(key, val):
        store[key] = val
        return True

    async def fake_ping():
        return True

    mock = AsyncMock()
    mock.get  = AsyncMock(side_effect=fake_get)
    mock.set  = AsyncMock(side_effect=fake_set)
    mock.ping = AsyncMock(side_effect=fake_ping)

    app.state.redis = mock
    yield mock, store


@pytest.fixture()
def with_webhooks(mock_redis):
    """מוסיף webhook חיצוני לRedis לפני הבדיקה."""
    _, store = mock_redis
    store["wa:external_hooks"] = json.dumps([
        {"url": WEBHOOK_URL,  "secret": None},
        {"url": WEBHOOK_URL2, "secret": "s3cr3t"},
    ])


# ══════════════════════════════════════════════════════════════════════════════
# /internal/baileys-event — העברת הודעות לwebhooks חיצוניים
# ══════════════════════════════════════════════════════════════════════════════

class TestBaileysEventForwarding:

    def test_text_message_forwarded_to_all_webhooks(self, with_webhooks):
        """הודעת טקסט נכנסת → מועברת לכל webhooks רשומים."""
        with patch("main.forward_to_webhooks", new=AsyncMock()) as mock_fwd:
            resp = client.post("/internal/baileys-event", json=TEXT_MESSAGE)

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        mock_fwd.assert_called_once()
        _, payload = mock_fwd.call_args[0]
        assert payload["messageId"] == "msg_123"
        assert payload["type"]      == "text"

    def test_image_message_forwarded(self, with_webhooks):
        with patch("main.forward_to_webhooks", new=AsyncMock()) as mock_fwd:
            client.post("/internal/baileys-event", json=IMAGE_MESSAGE)
        payload = mock_fwd.call_args[0][1]
        assert payload["type"] == "image"

    def test_group_message_forwarded(self, with_webhooks):
        with patch("main.forward_to_webhooks", new=AsyncMock()) as mock_fwd:
            client.post("/internal/baileys-event", json=GROUP_MESSAGE)
        payload = mock_fwd.call_args[0][1]
        assert payload["isGroup"] is True

    def test_my_own_message_also_forwarded(self, with_webhooks):
        """הודעות שלי (fromMe=True) גם מועברות."""
        with patch("main.forward_to_webhooks", new=AsyncMock()) as mock_fwd:
            client.post("/internal/baileys-event", json=MY_MESSAGE)
        payload = mock_fwd.call_args[0][1]
        assert payload["fromMe"] is True

    def test_no_webhooks_still_returns_ok(self, mock_redis):
        """אין webhooks רשומים — עדיין מחזיר ok."""
        with patch("main.forward_to_webhooks", new=AsyncMock()):
            resp = client.post("/internal/baileys-event", json=TEXT_MESSAGE)
        assert resp.status_code == 200

    def test_forward_sends_secret_header(self, mock_redis):
        """בדיקה ש-secret מועבר ב-X-Webhook-Secret."""
        _, store = mock_redis
        store["wa:external_hooks"] = json.dumps([
            {"url": WEBHOOK_URL, "secret": "topsecret"}
        ])

        mock_response = MagicMock()
        mock_response.status_code = 200

        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post = AsyncMock(return_value=mock_response)
            mock_c.__aenter__ = AsyncMock(return_value=mock_c)
            mock_c.__aexit__  = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            client.post("/internal/baileys-event", json=TEXT_MESSAGE)

            headers = mock_c.post.call_args[1]["headers"]
            assert headers.get("X-Webhook-Secret") == "topsecret"

    def test_forward_fails_silently(self, mock_redis):
        """אם webhook חיצוני לא עונה — לא קורס."""
        _, store = mock_redis
        store["wa:external_hooks"] = json.dumps([{"url": WEBHOOK_URL, "secret": None}])

        with patch("httpx.AsyncClient") as mock_cls:
            mock_c = AsyncMock()
            mock_c.post = AsyncMock(side_effect=Exception("timeout"))
            mock_c.__aenter__ = AsyncMock(return_value=mock_c)
            mock_c.__aexit__  = AsyncMock(return_value=False)
            mock_cls.return_value = mock_c

            resp = client.post("/internal/baileys-event", json=TEXT_MESSAGE)

        assert resp.status_code == 200   # לא קרס!


# ══════════════════════════════════════════════════════════════════════════════
# /webhooks/register + unregister + list
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
            resp = client.request("DELETE", "/webhooks/unregister",
                                  json={"url": WEBHOOK_URL})

        assert resp.status_code == 200
        saved = json.loads(store["wa:external_hooks"])
        assert not any(h["url"] == WEBHOOK_URL for h in saved)
        assert any(h["url"] == WEBHOOK_URL2    for h in saved)

    def test_list_webhooks_hides_secrets(self, mock_redis):
        _, store = mock_redis
        store["wa:external_hooks"] = json.dumps([
            {"url": WEBHOOK_URL,  "secret": "hidden"},
            {"url": WEBHOOK_URL2, "secret": None},
        ])

        resp = client.get("/webhooks")
        items = resp.json()["webhooks"]
        assert items[0]["has_secret"] is True
        assert items[1]["has_secret"] is False
        assert "hidden" not in resp.text

    def test_list_webhooks_empty(self, mock_redis):
        resp = client.get("/webhooks")
        assert resp.json()["count"] == 0


# ══════════════════════════════════════════════════════════════════════════════
# /health
# ══════════════════════════════════════════════════════════════════════════════

class TestHealth:

    def test_health_ok(self, mock_redis):
        with patch("main.baileys_get", new=AsyncMock(return_value={"status": "connected"})):
            resp = client.get("/health")
        assert resp.json()["status"]  == "healthy"
        assert resp.json()["redis"]   == "ok"
        assert resp.json()["baileys"] == "ok"

    def test_health_baileys_down(self, mock_redis):
        with patch("main.baileys_get", new=AsyncMock(side_effect=Exception("down"))):
            resp = client.get("/health")
        assert resp.json()["status"]  == "degraded"
        assert resp.json()["baileys"] == "error"