import base64
import io
import json
from contextlib import asynccontextmanager
from typing import Optional, List, Any

import httpx
import qrcode
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# ── Config ────────────────────────────────────────────────────────────────────
BAILEYS_URL = "http://localhost:3001"
REDIS_URL   = "redis://localhost:6379"
QUEUE_KEY   = "whatsapp:messages:incoming"

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

class ImageMsg(BaseModel):
    jid: str
    url: str
    caption: Optional[str] = None

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

class TemplateBtn(BaseModel):
    type: str = "quick_reply"   # quick_reply | url | call
    text: str
    id: Optional[str] = None
    url: Optional[str] = None
    phone: Optional[str] = None

class TemplateMsg(BaseModel):
    jid: str
    text: str
    footer: Optional[str] = None
    templateButtons: List[TemplateBtn]

class ReactionMsg(BaseModel):
    jid: str
    messageId: str
    emoji: str

class ButtonClick(BaseModel):
    jid: str
    buttonId: str
    displayText: Optional[str] = None

class ListClick(BaseModel):
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

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="WhatsApp Gateway",
    version="1.0.0",
    description="""
## 📱 WhatsApp Gateway — All-in-One

### Endpoints:
- **Connection**: status, QR code, logout
- **Send**: text, image, buttons, list, template, reaction
- **Interact**: button-click, list-click
- **Messages**: pop / peek from Redis queue
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
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, "QR not available – check /status")
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
    async with httpx.AsyncClient() as c:
        r = await c.delete(f"{BAILEYS_URL}/logout")
        return r.json()

# ── Send ──────────────────────────────────────────────────────────────────────
@app.post("/send/text", tags=["Send"])
async def send_text(b: TextMsg):
    """שלח הודעת טקסט"""
    return await baileys_post("/send/text", b.model_dump())

@app.post("/send/image", tags=["Send"])
async def send_image(b: ImageMsg):
    """שלח תמונה (URL ציבורי) + כיתוב אופציונלי"""
    return await baileys_post("/send/image", b.model_dump())

@app.post("/send/buttons", tags=["Send"])
async def send_buttons(b: ButtonMsg):
    """
    שלח כפתורים (עד 3)
    ```json
    {"jid":"972501234567","text":"בחר:","buttons":[{"id":"y","text":"כן"},{"id":"n","text":"לא"}]}
    ```
    """
    return await baileys_post("/send/buttons", b.model_dump())

@app.post("/send/list", tags=["Send"])
async def send_list(b: ListMsg):
    """
    שלח רשימת אפשרויות
    ```json
    {"jid":"972501234567","text":"בחר שירות:","buttonText":"פתח","sections":[{"title":"שירותים","rows":[{"id":"s1","title":"שירות 1"}]}]}
    ```
    """
    return await baileys_post("/send/list", b.model_dump())

@app.post("/send/template", tags=["Send"])
async def send_template(b: TemplateMsg):
    """שלח כפתורי template (quick_reply / url / call)"""
    return await baileys_post("/send/template", b.model_dump())

@app.post("/send/reaction", tags=["Send"])
async def send_reaction(b: ReactionMsg):
    """תגובת אמוג'י להודעה"""
    return await baileys_post("/send/reaction", b.model_dump())

# ── Interact ──────────────────────────────────────────────────────────────────
@app.post("/interact/button-click", tags=["Interact"])
async def button_click(b: ButtonClick):
    """סימולציה של לחיצת כפתור"""
    return await baileys_post("/send/button-click", b.model_dump())

@app.post("/interact/list-click", tags=["Interact"])
async def list_click(b: ListClick):
    """סימולציה של בחירה מרשימה"""
    return await baileys_post("/send/list-click", b.model_dump())

# ── Messages (Redis Queue) ────────────────────────────────────────────────────
@app.get("/messages/status", tags=["Messages"])
async def queue_status():
    """כמה הודעות ממתינות ב-Queue"""
    n = await redis_client.llen(QUEUE_KEY)
    return {"queue_length": n, "queue_key": QUEUE_KEY}

@app.get("/messages/peek", tags=["Messages"])
async def peek(start: int = 0, end: int = Query(9, le=99)):
    """הצג הודעות **ללא מחיקה** (חדשות ראשונות)"""
    items = await redis_client.lrange(QUEUE_KEY, start, end)
    msgs  = [json.loads(i) for i in items if i]
    return {"messages": msgs, "count": len(msgs)}

@app.post("/messages/pop", tags=["Messages"])
async def pop(count: int = Query(10, ge=1, le=100)):
    """
    שלוף והסר הודעות מה-Queue (ישנות ראשונות — FIFO)

    ⚠️ הודעות **יימחקו** לאחר השליפה
    """
    pipeline = redis_client.pipeline()
    for _ in range(count):
        pipeline.rpop(QUEUE_KEY)
    results = await pipeline.execute()
    msgs = [json.loads(r) for r in results if r]
    return {"messages": msgs, "count": len(msgs)}

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
