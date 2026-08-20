# כלי ניטור רשת — סיכום

## 1. שלוש שכבות תצפית

| שכבה | כלי | מה רואים | מוצפן? |
|---|---|---|---|
| **רשת** | `ss`, `/proc/net/dev`, `tcpdump` | חיבורים, bytes, packets | ✅ התוכן מוצפן |
| **אפליקציה** | הלוגים שלך (`[UPSERT] fired`) | ההודעה עצמה, אחרי פענוח | ❌ טקסט מלא |
| **webhook** | `tcpdump port 5000`, Redis stream | ה-JSON שנשלח ל-Spine | ❌ HTTP רגיל |

**הנקודה המרכזית:** אין כלי רשת שיראה הודעות WhatsApp. התעבורה מוצפנת ב-TLS → Noise → Signal.
המקום היחיד שההודעה קריאה הוא **בתוך התהליך, אחרי הפענוח** — כלומר בלוגים של הקוד.

```
frame מוצפן → [ss: כמה sockets] → פענוח → [UPSERT fired: ההודעה]
   → Redis [addMessage ok] → webhook [webhook ok] → Spine
```

---

## 2. `ss` vs `tcpdump` vs `/proc/net/dev`

| | `/proc/net/dev` | `ss` | `tcpdump` |
|---|---|---|---|
| **שאלה** | כמה עבר? | מי מחובר? | מה עובר? |
| **רזולוציה** | כל הכרטיס | socket בודד | packet בודד |
| **PID / fd** | ❌ | ✅ | ❌ |
| **תוכן packet** | ❌ | ❌ | ✅ |
| **סוג מדידה** | מונה מצטבר מאז boot | מצב רגעי | זרם חי |
| **הרשאות** | כלום | כלום | `NET_RAW` |
| **עומס** | אפסי | אפסי | לא זניח |
| **חבילה** | מובנה בקרנל | `iproute2` | `tcpdump` |

### חוק אצבע
- **"כמה?"** → `/proc/net/dev` — מהיר, זמין תמיד, בלי להתקין כלום
- **"מי?"** → `ss` — רוב הבעיות יהיו כאן
- **"מה?"** → `tcpdump` — רק על תעבורה **לא מוצפנת**

---

## 3. מה זה netstat

`netstat` הוא הכלי **הישן**. `ss` הוא היורש שלו.

| | `netstat` | `ss` |
|---|---|---|
| חבילה | `net-tools` (deprecated) | `iproute2` (סטנדרט) |
| מקור מידע | סורק `/proc/net/*` כטקסט | `netlink` — API ישיר לקרנל |
| מהירות | איטי עם אלפי sockets | מהיר |
| מידע TCP פנימי | ❌ | ✅ (`-i`: rtt, cwnd, retransmits) |
| סינון | `grep` בלבד | שפת סינון מובנית |
| זמינות | לרוב לא מותקן ב-images מודרניים | סטנדרט |

**המרה מהירה:**

| netstat | ss |
|---|---|
| `netstat -tulpn` | `ss -tulpn` |
| `netstat -an` | `ss -an` |
| `netstat -tp` | `ss -tp` |

הדגלים כמעט זהים — מי שמכיר `netstat` יסתדר מיד.
**המלצה:** להשתמש ב-`ss`. `netstat` רק אם זו מכונה ישנה בלי `iproute2`.

---

## 4. פקודות `ss` פופולריות

### דגלים בסיסיים

| דגל | משמעות |
|---|---|
| `-t` | TCP |
| `-u` | UDP |
| `-l` | רק listening |
| `-n` | ללא resolve — מספרים בלבד (**מהיר יותר**) |
| `-p` | הצג תהליך (PID + fd) |
| `-a` | הכל (listening + established) |
| `-i` | מידע TCP פנימי — rtt, cwnd, bytes |
| `-s` | סיכום סטטיסטי |
| `-4` / `-6` | IPv4 / IPv6 בלבד |
| `-o` | טיימרים (retransmit, keepalive) |

### שימושים נפוצים

```bash
# כל החיבורים הפעילים עם תהליך — הכי שימושי
ss -tnp

# מי מאזין על אילו פורטים
ss -tulpn

# חיבורים לפורט מסוים
ss -tnp 'dport = :443'
ss -tnp 'sport = :3001'

# רק ESTABLISHED
ss -tn state established

# חיבורים ל-IP מסוים
ss -tnp 'dst 57.144.111.32'

# סיכום — כמה חיבורים בכל מצב
ss -s

# מידע TCP מלא (rtt, bytes, retransmits)
ss -tinp

# עם טיימרים — לזהות retransmit תקוע
ss -tnpo

# ספירה מהירה
ss -tn state established | wc -l
```

### שילובים שימושיים

```bash
# כמה חיבורים לכל יעד — לזהות דליפות
ss -tn state established | awk '{print $5}' | cut -d: -f1 | sort | uniq -c | sort -rn

# חיבורים של תהליך מסוים
ss -tnp | grep 'pid=7'

# מעקב רציף כל 2 שניות
watch -n 2 'ss -tnp | grep 443'

# בתוך container
docker exec <name> ss -tinp | grep 443
```

### שדות חשובים ב-`ss -i`

| שדה | משמעות |
|---|---|
| `bytes_sent` / `bytes_received` | מצטבר מאז פתיחת ה-socket |
| `lastsnd` / `lastrcv` | ms מאז פעילות אחרונה (**זהירות: שקט ≠ מוות**) |
| `rtt` | זמן הלוך-חזור |
| `retrans` | retransmissions — סימן לבעיית רשת |
| `cwnd` | congestion window |

---

## 5. `/proc/net/*` — בלי כלים בכלל

```bash
# תעבורה מצטברת לפי interface
cat /proc/net/dev

# חיבורי TCP גולמיים (hex)
cat /proc/net/tcp

# מה שתהליך מסוים פתוח
ls -l /proc/<pid>/fd | grep socket
```

**פענוח `/proc/net/tcp`:**
- כתובות ב-hex, **little-endian**
- `206F9039:01BB` → IP `57.111.144.32`, port `443` (`01BB` = 443)
- עמודת `st`: `01`=ESTABLISHED, `0A`=LISTEN, `06`=TIME_WAIT

---

## 6. חבילות ל-Dockerfile

```dockerfile
RUN apt-get update && apt-get install -y \
    iproute2 \      # ss, ip — החשוב ביותר
    procps \        # ps, top
    lsof \          # fd → socket
    net-tools \     # netstat, ifconfig (גיבוי)
    dnsutils \      # dig, nslookup
    iputils-ping \  # ping
    && rm -rf /var/lib/apt/lists/*
```

**`tcpdump` — לשקול בנפרד.** דורש `--cap-add=NET_RAW`, ועל תמונת production זה משטח תקיפה.
עדיף להתקין אד-הוק כשצריך.

**מינימום מומלץ:** `iproute2` + `procps` + `lsof` — מכסה את רוב המקרים.
