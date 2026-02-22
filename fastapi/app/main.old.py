import base64
import io
import json
from contextlib import asynccontextmanager
from typing import Optional, List

import httpx
import qrcode
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# ── Config ────────────────────────────────────────────────────────────────────
BAILEYS_URL = "http://localhost:3001"
REDIS_URL   = "redis://localhost:6379"
STREAM_KEY  = "whatsapp:messages"

# ── Redis ─────────────────────────────────────────────────────────────────────
redis_client: aioredis.Redis | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client
    redis_client = aioredis.from_url(REDIS_URL, encoding="utf-8", decode_responses=True)
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

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="WhatsApp Gateway",
    version="2.0.0",
    description="""
## 📱 WhatsApp Gateway — Redis Streams + Webhooks

### Features:
- **Redis Streams**: Reliable message queue with consumer groups
- **Webhooks**: Push notifications to your endpoints
- **Contacts**: Auto-save contacts from incoming messages
- **Full API**: Send text, buttons, lists, and more

### Endpoints:
- **Connection**: status, QR code, logout
- **Send**: text, buttons, list
- **Webhooks**: register, unregister, list
- **Messages**: stream read, stream info, trace
- **Contacts**: search and list
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
    """
    שלח כפתורים (עד 3)
    
    ⚠️ שים לב: כפתורים לא עובדים בחשבונות רגילים, רק ב-WhatsApp Business API
    """
    return await baileys_post("/send/buttons", b.model_dump())

@app.post("/send/list", tags=["Send"])
async def send_list(b: ListMsg):
    """
    שלח תפריט צף
    
    ```json
    {
      "jid": "972501234567",
      "text": "בחר שירות:",
      "buttonText": "פתח תפריט",
      "sections": [{
        "title": "שירותים",
        "rows": [
          {"id": "s1", "title": "שירות 1", "description": "תיאור"},
          {"id": "s2", "title": "שירות 2"}
        ]
      }]
    }
    ```
    """
    return await baileys_post("/send/list", b.model_dump())

# ── Webhooks ──────────────────────────────────────────────────────────────────
@app.post("/webhooks/register", tags=["Webhooks"])
async def register_webhook(b: WebhookRegister):
    """
    רשום webhook לקבלת הודעות נכנסות
    
    - **url**: כתובת ה-webhook שלך (https://your-domain.com/webhook)
    - **secret**: סוד לאבטחה (אופציונלי) - יישלח ב-header X-Webhook-Secret
    
    הודעות יישלחו כ-POST עם JSON:
    ```json
    {
      "messageId": "...",
      "jid": "972501234567@s.whatsapp.net",
      "type": "text",
      "data": {"text": "..."},
      "timestamp": 1234567890,
      "receivedAt": "2024-01-01T12:00:00Z"
    }
    ```
    """
    return await baileys_post("/webhooks/register", b.model_dump())

@app.delete("/webhooks/unregister", tags=["Webhooks"])
async def unregister_webhook(b: WebhookUnregister):
    """הסר webhook"""
    return await baileys_delete("/webhooks/unregister", b.model_dump())

@app.get("/webhooks", tags=["Webhooks"])
async def list_webhooks():
    """רשימת webhooks רשומים"""
    return await baileys_get("/webhooks")

# ── Messages (Redis Streams) ──────────────────────────────────────────────────
@app.get("/messages/stream/info", tags=["Messages"])
async def stream_info():
    """
    מידע על ה-Stream
    
    - **length**: כמה הודעות יש
    - **firstEntry**: ההודעה הראשונה
    - **lastEntry**: ההודעה האחרונה
    """
    return await baileys_get("/messages/stream/info")

@app.get("/messages/stream/read", tags=["Messages"])
async def stream_read(
    count: int = Query(10, ge=1, le=100, description="כמה הודעות לקרוא"),
    lastId: str = Query("0", description="ID של ההודעה האחרונה שקראת (0 = מההתחלה)")
):
    """
    קרא הודעות מה-Stream
    
    - ההודעות **לא נמחקות** (שונה מ-pop)
    - אפשר לקרוא כמה פעמים שרוצים
    - השתמש ב-lastId כדי לקרוא רק הודעות חדשות
    
    **דוגמה:**
    1. קריאה ראשונה: `?count=10&lastId=0`
    2. קריאה שנייה: `?count=10&lastId=<id-מהתשובה-הקודמת>`
    """
    return await baileys_get(f"/messages/stream/read?count={count}&lastId={lastId}")

@app.get("/messages/trace/{jid}", tags=["Messages"])
async def trace_conversation(
    jid: str,
    limit: int = Query(100, ge=1, le=500, description="מקסימום הודעות")
):
    """
    היסטוריית שיחה מלאה עם איש קשר
    
    - **jid**: מספר או JID (972501234567 או 972501234567@s.whatsapp.net)
    - **limit**: כמה הודעות (ברירת מחדל: 100)
    
    מחזיר את כל ההודעות מה-Stream שקשורות ל-JID הזה (ממוינות מהחדש לישן):
    - הודעות שהתקבלו ממנו ✅
    - הודעות ששלחת אליו (עתידי - דורש שמירת הודעות יוצאות)
    
    **דוגמה:**
    ```
    GET /messages/trace/972501234567?limit=50
    ```
    """
    try:
        return await baileys_get(f"/messages/trace/{jid}?limit={limit}")
    except Exception as e:
        raise HTTPException(503, f"Baileys unavailable: {e}")

# Legacy endpoints (backwards compatibility)
@app.get("/messages/status", tags=["Messages (Legacy)"], deprecated=True)
async def queue_status_legacy():
    """⚠️ Deprecated: השתמש ב-/messages/stream/info"""
    info = await baileys_get("/messages/stream/info")
    return {"queue_length": info.get("length", 0)}

# ── Contacts ──────────────────────────────────────────────────────────────────
@app.get("/contacts", tags=["Contacts"])
async def get_contacts(
    q: str = Query("", description="חיפוש לפי שם או מספר"),
    limit: int = Query(200, ge=1, le=1000)
):
    """
    קבל רשימת אנשי קשר
    
    אנשי קשר נשמרים אוטומטית כשמישהו שולח לך הודעה
    """
    return await baileys_get(f"/contacts?q={q}&limit={limit}")

@app.get("/contacts/count", tags=["Contacts"])
async def contacts_count():
    """כמה אנשי קשר שמורים"""
    return await baileys_get("/debug/contacts-count")

# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/health", tags=["System"])
async def health():
    """בדיקת בריאות — Redis + Baileys"""
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
        "status": "healthy" if (redis_ok and baileys_ok) else "degraded",
        "redis":  "ok" if redis_ok  else "error",
        "baileys":"ok" if baileys_ok else "error"
    }