# WhatsApp / Baileys — TCP Trace

## מבנה החיבור

```text
┌─────────────────────┐                      ┌─────────────────────┐
│  Baileys / Docker   │                      │  WhatsApp Server    │
│  172.17.0.3         │◄────────────────────►│  57.144.111.32:443 │
└─────────────────────┘       TCP / TLS       └─────────────────────┘
```

החיבור הוא **Full-Duplex** — אותו TCP socket משמש גם לשליחה וגם לקבלה.

---

# 📥 הודעה נכנסת — WhatsApp → Baileys

דפוס שנצפה ב־trace:

```text
Baileys / Docker                         WhatsApp
      │                                     │
      │◄──────── 65 bytes ──────────────────│
      │                                     │
      │──────── TCP ACK ───────────────────►│
      │                                     │
      │◄──────── 423 bytes ─────────────────│  ← Message traffic
      │                                     │
      │──────── TCP ACK ───────────────────►│
      │                                     │
      │──────── 82 bytes ──────────────────►│  ← Baileys response
      │                                     │
      │◄──────── TCP ACK ───────────────────│
      │                                     │
      ▼                                     ▼
 messages.upsert
```

דוגמה מה־`tcpdump`:

```text
IN   length 65
OUT  ACK

IN   length 423
OUT  ACK

OUT  length 82
IN   ACK
```

### המשמעות

```text
WhatsApp
    │
    │ IN payload
    ▼
Linux TCP
    │
    ├── TCP ACK
    │
    ▼
TLS / WebSocket
    │
    ▼
Baileys
    │
    ▼
messages.upsert
```

> `423` אינו מספר קבוע. גודל ה־payload משתנה לפי ההודעה והפרוטוקול.

---

# 📤 הודעה יוצאת — Baileys → WhatsApp

דפוס שנצפה ב־trace:

```text
Baileys / Docker                         WhatsApp
      │                                     │
      │──────── 144 bytes ─────────────────►│  ← התחלת השליחה
      │                                     │
      │◄──────── TCP ACK ───────────────────│
      │                                     │
      │◄──────── 290 bytes ─────────────────│
      │                                     │
      │──────── 353 bytes + ACK ───────────►│
      │                                     │
      │◄──────── TCP ACK ───────────────────│
      │                                     │
      │◄──────── 89 bytes ──────────────────│
      │──────── TCP ACK ───────────────────►│
      │                                     │
      │◄──────── 84 bytes ──────────────────│
      │──────── TCP ACK ───────────────────►│
      │──────── 81 bytes ──────────────────►│
      │◄──────── TCP ACK ───────────────────│
      │                                     │
      │◄──────── 340 bytes ─────────────────│
      │──────── 82 bytes + ACK ────────────►│
      │                                     │
      │◄──────── 99 bytes ──────────────────│
      │──────── 95 bytes + ACK ────────────►│
      │◄──────── TCP ACK ───────────────────│
```

---

# 🔁 SEQ ו־ACK

```text
Sender                              Receiver

SEQ 100:200
100 bytes ─────────────────────────►

                       ACK 200
          ◄────────────────────────
```

`SEQ` אומר:

> אלה ה־bytes שאני שולח.

`ACK 200` אומר:

> קיבלתי הכול עד byte 199; הבא שאני מצפה לקבל הוא 200.

ה־ACK הוא **cumulative**, ולכן לא חייב להיות ACK נפרד לכל TCP packet.

---

# 🪟 Window

לדוגמה:

```text
ack 559, win 501
```

`win` הוא **TCP Receive Window**.

המקבל מודיע לשולח כמה מידע נוסף הוא מסוגל לקבל בלי לעצור ולהמתין.

```text
win > 0    → אפשר להמשיך להעביר data

win = 0    → המקבל מבקש לעצור זמנית
```

Window Scaling יכול לגרום לכך שהחלון האפקטיבי גדול יותר מהמספר שמוצג ישירות.

---

# 🚦 Flags

```text
Flags [.]
```

ACK ללא payload:

```text
length 0
```

---

```text
Flags [P.]
```

ACK + payload:

```text
length > 0
```

לדוגמה:

```text
Flags [P.], seq 136:559, ack 1, length 423
```

יש כאן data וגם ACK.

---

# 🔎 בדיקת התקלה של Incoming

Baseline תקין:

```text
WhatsApp
    │
    ├── IN קטן / protocol traffic
    │
    ├── IN message payload
    │
    ▼
Baileys
    │
    ├── response
    │
    ▼
messages.upsert
```

בזמן התקלה צריך לבדוק האם נראה:

```text
WhatsApp
    │
    ├── protocol / keepalive עדיין עובד
    │
    X
    │   אין IN של message traffic
    │
    ▼
Baileys לא מקבל את ההודעה
```

ואם לאחר X זמן נראה פתאום:

```text
WhatsApp
    │
    ├──── IN message 1 ────►
    ├──── IN message 2 ────►
    ├──── IN message 3 ────►
    │
    ▼
Baileys

messages.upsert × 3
```

זה ה־**backlog** — ההודעות שלא הוזרמו בזמן ומגיעות לאחר מכן ברצף.

---

# 🛠 פקודות הבדיקה

### TCP Trace

```bash
docker exec whatsapp_972504476645_3beff8fa \
tcpdump -l -i any -nn -tttt \
'tcp port 443'
```

`-l` — מדפיס את השורות מיידית ולא משאיר אותן ב־output buffer.

`-i any` — מאזין לכל interfaces.

`-nn` — לא מבצע DNS/service-name resolution.

`-tttt` — timestamp מלא.

---

### מצב ה־socket

```bash
docker exec whatsapp_972504476645_3beff8fa \
ss -tnp state established '( dport = :443 )'
```

דוגמה:

```text
ESTAB 0 0
172.17.0.3:55968
57.144.111.32:443
users:(("node",pid=9,fd=32))
```

`Recv-Q` — bytes שהגיעו ל־Linux ועדיין לא נקראו על ידי Node.

`Send-Q` — bytes שנשלחו ועדיין ממתינים לאישור TCP.

---

# ⚠️ TCP ACK לעומת WhatsApp ACK

אלה שני דברים שונים:

```text
WhatsApp Protocol
       │
       │ WhatsApp ACK
       ▼
WebSocket
       │
       ▼
TLS encryption
       │
       ▼
TCP
       │
       │ TCP ACK
       ▼
Network
```

`tcpdump` יכול לראות את **TCP ACK**.

הוא לא יכול לקרוא את **WhatsApp protocol ACK**, מכיוון שהוא נמצא בתוך התעבורה המוצפנת של TLS/WSS.

כדי לבדוק WhatsApp ACK צריך instrumentation/logging בתוך Baileys, למשל סביב `sendMessageAck()`.
