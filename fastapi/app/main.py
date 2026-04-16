import base64
import io
import sys
import os
from contextlib import asynccontextmanager
from typing import Optional, List

import httpx
import qrcode
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

sys.path.insert(0, os.path.dirname(__file__))

# ── Config ────────────────────────────────────────────────────────────────────
BAILEYS_URL = "http://localhost:3001"
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

# ── Redis ─────────────────────────────────────────────────────────────────────
redis_client: aioredis.Redis | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client
    redis_client = aioredis.from_url(REDIS_URL, encoding="utf-8", decode_responses=True)
    app.state.redis = redis_client
    yield
    await redis_client.aclose()

# ── Models ────────────────────────────────────────────────────────────────────
class TextMsg(BaseModel):
    jid: str
    text: str

class ButtonItem(BaseModel):
    id: str
    text: str

class ButtonMsg(BaseModel):
    jid: str
    text: str
    footer: Optional[str] = None
    buttons: List[ButtonItem] = Field(..., min_length=1, max_length=3)

class ListRow(BaseModel):
    id: str
    title: str
    description: Optional[str] = None

class ListSection(BaseModel):
    title: str
    rows: List[ListRow]

class ListMsg(BaseModel):
    jid: str
    text: str
    title: Optional[str] = None
    buttonText: str = "בחר אפשרות"
    footer: Optional[str] = None
    sections: List[ListSection]

class WebhookRegister(BaseModel):
    url: str
    secret: Optional[str] = None

class WebhookUnregister(BaseModel):
    url: str

class ButtonResponse(BaseModel):
    jid: str
    buttonId: str
    displayText: str

class ListResponse(BaseModel):
    jid: str
    rowId: str
    title: Optional[str] = None

# ── Helpers ───────────────────────────────────────────────────────────────────
async def baileys_post(path: str, data: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{BAILEYS_URL}{path}", json=data)
        r.raise_for_status()
        return r.json()

async def baileys_get(path: str) -> dict:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{BAILEYS_URL}{path}")
        r.raise_for_status()
        return r.json()

async def baileys_delete(path: str, data: dict = None) -> dict:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.delete(f"{BAILEYS_URL}{path}", json=data) if data else await c.delete(f"{BAILEYS_URL}{path}")
        r.raise_for_status()
        return r.json()

async def forward_to_webhooks(redis, payload: dict) -> None:
    """מעביר payload לכל webhooks חיצוניים רשומים ב-Redis."""
    try:
        import json
        raw = await redis.get("wa:external_hooks")
        webhooks = json.loads(raw) if raw else []
        if not webhooks:
            return
        async with httpx.AsyncClient(timeout=10) as c:
            for wh in webhooks:
                try:
                    headers = {"Content-Type": "application/json"}
                    if wh.get("secret"):
                        headers["X-Webhook-Secret"] = wh["secret"]
                    await c.post(wh["url"], json=payload, headers=headers)
                except Exception:
                    pass
    except Exception:
        pass

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="WhatsApp Gateway",
    version="2.0.0",
    description="""
## 📱 WhatsApp Gateway

### תיאור:
- FastAPI חשוף לאינטרנט — לקוחות חיצוניים מתחברים לכאן
- Baileys פנימי בלבד — מתקשר עם WhatsApp

### Endpoints:
- **Connection**: status, QR, logout
- **Send**: text, buttons, list
- **Webhooks**: רשום endpoint לקבלת הודעות נכנסות
- **Messages**: קרא הודעות מה-stream
- **Contacts**: רשימת אנשי קשר
""",
    lifespan=lifespan
)

# ── Connection ────────────────────────────────────────────────────────────────
@app.get("/status", tags=["Connection"])
async def status():
    """סטטוס החיבור ל-WhatsApp"""
    try:
        return await baileys_get("/status")
    except Exception as e:
        raise HTTPException(503, f"Baileys unavailable: {e}")

@app.get("/qrcode", tags=["Connection"])
async def get_qrcode():
    """QR Code כ-JSON עם base64 תמונה"""
    try:
        r = await baileys_get("/qrcode")
        img_b64 = None
        if r.get("qr"):
            img = qrcode.make(r["qr"])
            buf = io.BytesIO()
            img.save(buf, "PNG")
            img_b64 = base64.b64encode(buf.getvalue()).decode()
        return {"qr": r.get("qr"), "qr_image_base64": img_b64, "status": r.get("status")}
    except httpx.HTTPStatusError:
        raise HTTPException(404, "QR not available – check /status")
    except Exception as e:
        raise HTTPException(503, str(e))

@app.get("/qrcode/image", tags=["Connection"])
async def qrcode_image():
    """QR Code כתמונת PNG — פתח בדפדפן וסרוק"""
    try:
        r = await baileys_get("/qrcode")
        if not r.get("qr"):
            raise HTTPException(404, "QR not available")
        img = qrcode.make(r["qr"])
        buf = io.BytesIO()
        img.save(buf, "PNG")
        buf.seek(0)
        return StreamingResponse(buf, media_type="image/png")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(503, str(e))

@app.delete("/logout", tags=["Connection"])
async def logout():
    """התנתק מ-WhatsApp"""
    return await baileys_delete("/logout")

# ── Send ──────────────────────────────────────────────────────────────────────
@app.post("/send/text", tags=["Send"])
async def send_text(b: TextMsg):
    """שלח הודעת טקסט"""
    return await baileys_post("/send/text", b.model_dump())

@app.post("/send/buttons", tags=["Send"])
async def send_buttons(b: ButtonMsg):
    """שלח כפתורים (עד 3) — Business API בלבד"""
    return await baileys_post("/send/buttons", b.model_dump())

@app.post("/send/list", tags=["Send"])
async def send_list(b: ListMsg):
    """שלח תפריט צף"""
    return await baileys_post("/send/list", b.model_dump())

@app.post("/send/button-response", tags=["Send"])
async def send_button_response(b: ButtonResponse):
    """סימולציה של לחיצת כפתור"""
    return await baileys_post("/send/button-response", b.model_dump())

@app.post("/send/list-response", tags=["Send"])
async def send_list_response(b: ListResponse):
    """סימולציה של בחירה מתפריט"""
    return await baileys_post("/send/list-response", b.model_dump())

# ── Webhooks (לקוחות חיצוניים רושמים כאן) ───────────────────────────────────
@app.post("/webhooks/register", tags=["Webhooks"])
async def register_webhook(request: Request, b: WebhookRegister):
    """
    רשום webhook לקבלת הודעות נכנסות מ-WhatsApp.

    הודעות יישלחו כ-POST:
    ```json
    {
      "event": "message",
      "messageId": "...",
      "jid": "972501234567@s.whatsapp.net",
      "type": "text",
      "data": {"text": "שלום"},
      "timestamp": 1234567890
    }
    ```
    """
    import json
    redis = request.app.state.redis
    raw   = await redis.get("wa:external_hooks")
    hooks = json.loads(raw) if raw else []

    if not any(h["url"] == b.url for h in hooks):
        hooks.append({"url": b.url, "secret": b.secret})
        await redis.set("wa:external_hooks", json.dumps(hooks))

    # גם רשום ב-Baileys לקבלת הודעות
    await baileys_post("/webhooks/register", b.model_dump())

    return {"success": True, "url": b.url, "total": len(hooks)}

@app.delete("/webhooks/unregister", tags=["Webhooks"])
async def unregister_webhook(request: Request, b: WebhookUnregister):
    """הסר webhook"""
    import json
    redis = request.app.state.redis
    raw   = await redis.get("wa:external_hooks")
    hooks = json.loads(raw) if raw else []
    hooks = [h for h in hooks if h["url"] != b.url]
    await redis.set("wa:external_hooks", json.dumps(hooks))

    await baileys_delete("/webhooks/unregister", b.model_dump())
    return {"success": True, "total": len(hooks)}

@app.get("/webhooks", tags=["Webhooks"])
async def list_webhooks(request: Request):
    """רשימת webhooks רשומים"""
    import json
    redis = request.app.state.redis
    raw   = await redis.get("wa:external_hooks")
    hooks = json.loads(raw) if raw else []
    safe  = [{"url": h["url"], "has_secret": bool(h.get("secret"))} for h in hooks]
    return {"webhooks": safe, "count": len(safe)}

# ── Incoming events from Baileys ─────────────────────────────────────────────
@app.post("/internal/baileys-event", include_in_schema=False)
async def baileys_event(request: Request):
    """
    Baileys שולח לכאן כל אירוע (הודעה / authenticated).
    - authenticated → שומר creds_b64 + phone ב-Redis
    - הכל → מעביר לכל webhooks חיצוניים
    """
    import json
    payload = await request.json()
    redis   = request.app.state.redis

    # שמור creds אם זה אירוע authenticated
    if payload.get("event") == "authenticated" and payload.get("phone") and payload.get("creds_b64"):
        await redis.set(f"wa:creds:{payload['phone']}", payload["creds_b64"])
        await redis.set("wa:last_auth", json.dumps({
            "phone":     payload["phone"],
            "jid":       payload.get("jid"),
            "name":      payload.get("name"),
            "timestamp": payload.get("timestamp"),
        }))

    await forward_to_webhooks(redis, payload)
    return {"ok": True}


# ── Auth info endpoints ────────────────────────────────────────────────────────
@app.get("/auth/status", tags=["Auth"])
async def auth_status(request: Request):
    """מראה מי מחובר כרגע ומתי התאמת לאחרונה."""
    import json
    redis = request.app.state.redis
    raw   = await redis.get("wa:last_auth")
    if not raw:
        return {"authenticated": False}
    info = json.loads(raw)
    return {"authenticated": True, **info}


@app.get("/auth/creds/{phone}", tags=["Auth"])
async def get_creds(request: Request, phone: str):
    """
    מחזיר את creds_b64 של חשבון לפי phone.
    לשחזור במכונה חדשה:
    1. קבל את creds_b64
    2. base64decode → כתוב ל-/app/auth_info/creds.json
    3. הפעל מחדש — אין צורך בסריקת QR
    """
    redis = request.app.state.redis
    val   = await redis.get(f"wa:creds:{phone}")
    if not val:
        raise HTTPException(404, f"No creds found for phone {phone}")
    return {
        "phone":            phone,
        "creds_b64":        val,
        "creds_b64_length": len(val),
        "preview":          val[:40] + "...",
    }


# ── Auth Dashboard ────────────────────────────────────────────────────────────
@app.get("/auth/dashboard", tags=["Auth"])
async def auth_dashboard(request: Request):
    """דף HTML — מצב אימות + creds_b64"""
    import json
    from fastapi.responses import HTMLResponse

    redis    = request.app.state.redis
    raw      = await redis.get("wa:last_auth")
    auth     = json.loads(raw) if raw else None
    creds_b64    = None
    creds_length = 0
    if auth and auth.get("phone"):
        creds_b64    = await redis.get(f"wa:creds:{auth['phone']}")
        creds_length = len(creds_b64) if creds_b64 else 0

    connected   = bool(auth)
    badge_color = "#22c55e" if connected else "#ef4444"
    badge_text  = "מחובר" if connected else "לא מחובר"

    info_rows = ""
    if auth:
        info_rows = f"""
        <div class="row">
          <div class="col"><div class="lbl">טלפון</div><div class="val">+{auth.get('phone','')}</div></div>
          <div class="col"><div class="lbl">JID</div><div class="val small">{auth.get('jid','')}</div></div>
          <div class="col"><div class="lbl">שם</div><div class="val">{auth.get('name') or '-'}</div></div>
          <div class="col"><div class="lbl">זמן</div><div class="val small">{auth.get('timestamp','')}</div></div>
        </div>"""

    creds_section = ""
    if auth:
        creds_section = f"""
    <div class="card">
      <div class="lbl">creds.json (base64) &nbsp;
        <button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('cb').innerText)">העתק</button>
      </div>
      <div class="lbl" style="margin-top:.4rem">אורך: {creds_length} תווים</div>
      <div class="creds" id="cb">{creds_b64 or 'לא נמצא'}</div>
      <a class="btn" href="/auth/creds/{auth.get('phone','')}" target="_blank">הורד JSON</a>
    </div>"""

    html = f"""<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<title>Auth Dashboard</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem}}
h1{{font-size:1.4rem;margin-bottom:1.5rem;color:#f8fafc}}
.card{{background:#1e293b;border-radius:12px;padding:1.5rem;margin-bottom:1rem;border:1px solid #334155}}
.lbl{{font-size:.75rem;color:#94a3b8;margin-bottom:.2rem}}
.val{{font-size:.95rem;color:#f1f5f9;font-weight:500}}
.val.small{{font-size:.8rem}}
.badge{{display:inline-block;padding:.25rem .75rem;border-radius:999px;font-size:.85rem;font-weight:600;background:{badge_color}22;color:{badge_color};border:1px solid {badge_color}55}}
.row{{display:flex;gap:1rem;flex-wrap:wrap;margin-top:1rem}}
.col{{flex:1;min-width:160px}}
.creds{{background:#0f172a;border-radius:8px;padding:1rem;font-family:monospace;font-size:.72rem;color:#7dd3fc;word-break:break-all;max-height:120px;overflow-y:auto;margin-top:.5rem;border:1px solid #1e3a5f}}
.btn{{display:inline-block;margin-top:.75rem;padding:.45rem 1.1rem;border-radius:8px;background:#3b82f6;color:#fff;text-decoration:none;font-size:.82rem;margin-left:.5rem}}
.btn:hover{{background:#2563eb}}
.copy{{font-size:.7rem;background:#334155;border:none;color:#94a3b8;padding:.2rem .5rem;border-radius:4px;cursor:pointer;margin-right:.5rem}}
.copy:hover{{color:#f1f5f9}}
.actions{{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.75rem}}
</style>
</head>
<body>
<h1>WhatsApp Auth Dashboard</h1>
<div class="card">
  <div class="lbl">סטטוס</div>
  <div style="margin-top:.5rem"><span class="badge">{badge_text}</span></div>
  {info_rows}
</div>
{creds_section}
<div class="card">
  <div class="lbl">פעולות</div>
  <div class="actions">
    <a class="btn" href="/qrcode/image" target="_blank">סרוק QR</a>
    <a class="btn" href="/status" target="_blank">סטטוס</a>
    <a class="btn" href="/webhooks" target="_blank">Webhooks</a>
    <a class="btn" href="/docs" target="_blank">API Docs</a>
    <a class="btn" href="/auth/dashboard">רענן</a>
  </div>
</div>
</body>
</html>"""
    return HTMLResponse(html)

# ── Messages ──────────────────────────────────────────────────────────────────
@app.get("/messages/stream/info", tags=["Messages"])
async def stream_info():
    return await baileys_get("/messages/stream/info")

@app.get("/messages/stream/read", tags=["Messages"])
async def stream_read(
    count: int  = Query(10, ge=1, le=100),
    lastId: str = Query("0")
):
    return await baileys_get(f"/messages/stream/read?count={count}&lastId={lastId}")

@app.get("/messages/trace/{jid}", tags=["Messages"])
async def trace_conversation(
    jid: str,
    limit: int = Query(100, ge=1, le=500)
):
    try:
        return await baileys_get(f"/messages/trace/{jid}?limit={limit}")
    except Exception as e:
        raise HTTPException(503, f"Baileys unavailable: {e}")

# ── Contacts ──────────────────────────────────────────────────────────────────
@app.get("/contacts", tags=["Contacts"])
async def get_contacts(
    q: str     = Query("", description="חיפוש לפי שם או מספר"),
    limit: int = Query(200, ge=1, le=1000)
):
    return await baileys_get(f"/contacts?q={q}&limit={limit}")

@app.get("/contacts/count", tags=["Contacts"])
async def contacts_count():
    return await baileys_get("/debug/contacts-count")

# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/health", tags=["System"])
async def health():
    redis_ok = False
    try:
        await redis_client.ping()
        redis_ok = True
    except Exception:
        pass

    baileys_ok = False
    try:
        await baileys_get("/status")
        baileys_ok = True
    except Exception:
        pass

    return {
        "status":  "healthy" if (redis_ok and baileys_ok) else "degraded",
        "redis":   "ok" if redis_ok   else "error",
        "baileys": "ok" if baileys_ok else "error",
    }