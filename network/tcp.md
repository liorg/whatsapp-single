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



כן. הכי ברור להציג את זה כ־**שתי טבלאות נפרדות**, לפי ה־traces האמיתיים שהבאת.

## 📥 הודעה נכנסת — WhatsApp → Baileys

מה־trace שלך סביב `15:28:56`:

| # | כיוון                      | Flags  | SEQ       |     ACK |    WIN |  Length | משמעות                                    |
| - | -------------------------- | ------ | --------- | ------: | -----: | ------: | ----------------------------------------- |
| 1 | **IN** WhatsApp → Baileys  | `[P.]` | `136:559` |     `1` | `2024` | **423** | WhatsApp שולח payload                     |
| 2 | **OUT** Baileys → WhatsApp | `[.]`  | —         | **559** |  `501` |   **0** | TCP ACK: קיבלתי עד 558                    |
| 3 | **OUT** Baileys → WhatsApp | `[P.]` | `1:83`    |   `559` |  `501` |  **82** | Baileys שולח payload + מאשר את ה־incoming |
| 4 | **IN** WhatsApp → Baileys  | `[.]`  | —         |  **83** | `2024` |   **0** | WhatsApp מאשר את 82 ה־bytes               |

כלומר:

```text id="4s8fuc"
WhatsApp                              Baileys

423 bytes ───────────────────────────►
SEQ 136:559

          ◄────────────────────────── ACK 559

          ◄────────────────────────── 82 bytes
                                      SEQ 1:83
                                      ACK 559

ACK 83 ─────────────────────────────►
```

### השורות המקוריות

```text id="v70s3t"
IN   Flags [P.]  seq 136:559  ack 1    win 2024  length 423
OUT  Flags [.]                ack 559  win 501   length 0
OUT  Flags [P.]  seq 1:83     ack 559  win 501   length 82
IN   Flags [.]                ack 83   win 2024  length 0
```

---

## 📤 הודעה יוצאת — Baileys → WhatsApp

מה־trace שלך סביב `15:27:36–37`:

| # | כיוון                      | Flags  | SEQ       |     ACK |    WIN |  Length | משמעות                     |
| - | -------------------------- | ------ | --------- | ------: | -----: | ------: | -------------------------- |
| 1 | **OUT** Baileys → WhatsApp | `[P.]` | `83:227`  |   `488` |  `501` | **144** | Baileys מתחיל לשלוח        |
| 2 | **IN** WhatsApp → Baileys  | `[.]`  | —         | **227** | `2025` |   **0** | WhatsApp מאשר את 144 bytes |
| 3 | **IN** WhatsApp → Baileys  | `[P.]` | `488:778` |   `227` | `2025` | **290** | WhatsApp מחזיר payload     |
| 4 | **OUT** Baileys → WhatsApp | `[P.]` | `227:580` |   `778` |  `501` | **353** | Baileys שולח payload + ACK |
| 5 | **IN** WhatsApp → Baileys  | `[.]`  | —         | **580** | `2024` |   **0** | WhatsApp מאשר              |
| 6 | **IN** WhatsApp → Baileys  | `[P.]` | `778:867` |   `580` | `2024` |  **89** | עוד payload מ־WhatsApp     |
| 7 | **OUT** Baileys → WhatsApp | `[.]`  | —         | **867** |  `501` |   **0** | Baileys מאשר               |

ובהמשך יש עוד IN/OUT כחלק מאותו דו־שיח.

### השורות המקוריות

```text id="swk1ko"
OUT  Flags [P.]  seq 83:227   ack 488  win 501   length 144
IN   Flags [.]                ack 227  win 2025  length 0

IN   Flags [P.]  seq 488:778  ack 227  win 2025  length 290
OUT  Flags [P.]  seq 227:580  ack 778  win 501   length 353
IN   Flags [.]                ack 580  win 2024  length 0

IN   Flags [P.]  seq 778:867  ack 580  win 2024  length 89
OUT  Flags [.]                ack 867  win 501   length 0
```

## 🔎 ההבדל שקל לזהות

|                           | 📥 Incoming             | 📤 Outgoing              |
| ------------------------- | ----------------------- | ------------------------ |
| מי מתחיל את האירוע        | **WhatsApp**            | **Baileys**              |
| ה־payload המשמעותי הראשון | `IN 423`                | `OUT 144`                |
| TCP ACK ראשון             | Baileys מחזיר `ACK 559` | WhatsApp מחזיר `ACK 227` |
| כיוון ראשוני              | `IN`                    | `OUT`                    |
| TCP תקין                  | ACK מתקדם               | ACK מתקדם                |
| Window                    | `2024 / 501`            | `2025 / 501`             |

והכי חשוב לחקירת התקיעה שלך: **אל תתקבע על `423` או `144`** — אלה גדלים מהדוגמאות הספציפיות. הסימן החשוב הוא הכיוון והדפוס.

ב־incoming תקין אנחנו רואים בבירור **WhatsApp יוזם `IN` עם payload**, בעוד ב־outgoing **Baileys יוזם `OUT` עם payload**.



| Flags  | משמעות             | בדרך כלל Length |
| ------ | ------------------ | --------------: |
| `[.]`  | ACK בלבד           |             `0` |
| `[P.]` | **Payload + ACK**  |           `> 0` |
| `[S]`  | פתיחת TCP — SYN    |             `0` |
| `[S.]` | SYN + ACK          |             `0` |
| `[F.]` | סגירה מסודרת + ACK |             `0` |
| `[R.]` | Reset + ACK        |             `0` |
