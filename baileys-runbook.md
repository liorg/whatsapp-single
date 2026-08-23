# Runbook — הודעות נכנסות לא מגיעות

**קונטיינר:** `whatsapp_972504476645_3beff8fa` · **פורט:** `9369→3001` · **גרסה:** `1.0.0.33`

> ⚠️ **הכלל הראשון: אל תעשה restart לפני שאספת ראיות.**
> restart משחרר את התור ומוחק את הראיה. הרגע התקוע הוא הרגע היקר.

---

## שלב 1 — תצפית חיה (לפני שנוגעים בכלום)

```bash
docker exec whatsapp_972504476645_3beff8fa \
  tail -f /var/log/baileys.log | grep -E "recv xml|UPSERT|decrypt|SOCK"
```

**להשאיר רץ → לשלוח הודעה מהטלפון → להסתכל.**

| מה מופיע | מסקנה | פעולה |
|---|---|---|
| רק `<iq ... ping/>` ו-`type='result'` | וואטסאפ **לא מנתב** אליך | נסה wake, ואז restart |
| `<message from=...>` בלי `[UPSERT] fired` | Baileys בולע — כשל פענוח | **אל תעשה restart** — בדוק sessions |
| `[UPSERT] fired` + `addMessage FAILED` | Redis | בדוק את חיבור ה-Redis |
| `[UPSERT] fired` + `webhook FAILED` | Spine לא מקבל | הבעיה במורד הזרם |
| `[UPSERT] fired` + `webhook ok` | **הכל תקין** — הבעיה ב-Spine/DB | לא כאן |

### מסלול תקין נראה כך
```
recv xml                    ← ההודעה הגיעה
[UPSERT] fired              ← Baileys פלט
[UPSERT] addMessage ok      ← נכתב ל-Redis
[UPSERT] webhook ok         ← נשלח ל-Spine
```

---

## שלב 2 — לצלם נתונים שלא ישרדו restart

```bash
# מונים ומצב socket
docker exec whatsapp_972504476645_3beff8fa \
  ss -tin 'dport = :443' | grep -oE "sport|bytes_received:[0-9]*|lastrcv:[0-9]*"

# כמה timeouts מאז ה-socket הנוכחי
docker exec whatsapp_972504476645_3beff8fa \
  awk '/new socket created/{n=0} /Timed Out/{n++} END{print n}' /var/log/baileys.log

# כשלי פענוח
docker exec whatsapp_972504476645_3beff8fa \
  grep -i "No session found\|Bad MAC\|failed to decrypt" /var/log/baileys.log | tail -5
```

---

## שלב 3 — wake לפני restart

נסה **קודם** לשלוח הודעה יוצאת:

```bash
curl -X POST localhost:9369/send/text \
  -H 'Content-Type: application/json' \
  -d '{"jid":"972546252491","text":"wake"}'
```

אם התור משתחרר מיד אחרי — **יש עקיפה שלא דורשת restart.**
אפשר להפוך את זה ל-heartbeat אוטומטי כל X דקות.

---

## שלב 4 — restart (רק אחרי 1–3)

```bash
docker cp whatsapp_972504476645_3beff8fa:/app/auth_info ~/auth_backup_$(date +%s)
docker restart whatsapp_972504476645_3beff8fa
sleep 20
curl -m 5 localhost:9369/version    # 1.0.0.33
curl -m 5 localhost:9369/status     # connected
```

---

## מדידת RX — האם ההודעה בכלל מגיעה

```bash
docker exec whatsapp_972504476645_3beff8fa \
  ss -tin 'dport = :443' | grep -o "bytes_received:[0-9]*"
# ← לשלוח הודעה מהטלפון ←
docker exec whatsapp_972504476645_3beff8fa \
  ss -tin 'dport = :443' | grep -o "bytes_received:[0-9]*"
```

| דלתא | פירוש |
|---|---|
| **+300 ומעלה** | הודעה הגיעה |
| **+39 / +47 / +71** | ping/pong בלבד — **שום הודעה** |
| **0** | שקט מוחלט |

⚠️ המונה מתאפס בכל socket חדש. אם קופץ אחורה — היה reconnect, לא ירידה.
⚠️ שתי שורות בפלט = שני sockets. בדוק אם זה מעבר תקין או דליפה.

---

## איפה הלוגים

**לא ב-`docker logs`** — supervisord כותב לקבצים:

| קובץ | תוכן |
|---|---|
| `/var/log/baileys.log` | **הלוג העיקרי** — Baileys + הקוד |
| `/var/log/fastapi.log` | ה-gateway |
| `/var/log/supervisord.log` | ניהול תהליכים |

```bash
docker exec whatsapp_972504476645_3beff8fa \
  find / -name "*.log" -newermt "-2 hours" -not -path "/proc/*" 2>/dev/null
```

---

## מה כבר נשלל

| חשד | מצב |
|---|---|
| sockets כפולים | **תוקן** ב-`1.0.0.33`, מאומת בלוג |
| `type !== 'notify'` | **תוקן** — מקבל גם `append` |
| webhook חוסם reconnect | **תוקן** — reconnect קודם, webhook לא-חוסם |
| `executeInitQueries` timeout | **לא הגורם** — נכשל גם כשהכל עובד |
| `logger: 'trace'` | **לא הגורם** — דלוק ועובד |
| סשן מת / QR | **לא** — שליחה נמסרת בפועל |
| מכשירים מקושרים מרובים | **לא** — רק אחד |
| קבצי session חסרים | **לא** — 34 sessions, קובץ ה-LID תקין וטרי |

**עדיין לא מוסבר:** מה גורם לתקיעה. restart משחרר תור של ~24KB, ואז זורם.

---

## פתוח — לתקן

1. **הקוד ל-repo.** `1.0.0.33` קיים רק כ-`docker cp` — ייעלם ב-rebuild הבא
2. **`level: 'trace'` → `process.env.LOG_LEVEL`** — ממלא דיסק (כבר 93%)
3. **`console.error('[HOOK-FIRED]')`** — דיבוג זמני שנשאר, מכפיל כל שורה
4. **ה-hook שולח webhook על כל `warn`** — לשקול `level >= 50`
5. **1341 prekeys** — חריג פי ~50. לבדוק את `nextPreKeyId: 1536`
6. **פיצול LID/PN** — `session-46037871886515.0.json` + `session-972546252491.0.json`
   לאותו איש קשר. תמיכת LID מלאה רק ב-Baileys v7 (כרגע `6.7.9`)
7. **חסרים `getMessage` + `msgRetryCounterCache`** ב-`makeWASocket` —
   בלעדיהם מנגנון ה-retry receipt כבוי

---

## שלוש נקודות התצפית

```
frame מוצפן → [ss: כמה sockets, כמה bytes]
   → פענוח → [recv xml: מי שלח]
   → [UPSERT fired: ההודעה]
   → [addMessage ok] → [webhook ok] → Spine
```

`ss` = כמה · `recv xml` = ממי · `UPSERT` = מה · `webhook` = לאן
