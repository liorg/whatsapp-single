# 📱 WhatsApp Gateway – All-in-One Container

Container אחד עם: **Redis + Baileys (Node.js) + FastAPI (Python)**

## 🚀 הפעלה

```bash
docker compose up --build -d
```

## 🔗 גישה

| | URL |
|---|---|
| **Swagger UI** | http://localhost:8000/docs |
| **QR Code (PNG)** | http://localhost:8000/qrcode/image |
| **Health** | http://localhost:8000/health |

## 📋 שימוש בסיסי

```bash
# 1. סרוק QR בדפדפן
open http://localhost:8000/qrcode/image

# 2. שלח הודעה
curl -X POST http://localhost:8000/send/text \
  -H "Content-Type: application/json" \
  -d '{"jid": "972501234567", "text": "שלום!"}'

# 3. קרא הודעות נכנסות
curl -X POST "http://localhost:8000/messages/pop?count=10"
```

## 📂 נתונים

| תיקייה | תוכן |
|---------|-------|
| `./data/auth` | Session WhatsApp (לא יאבד ב-restart) |
| `./data/redis` | Redis persistence |
| `./data/logs` | לוגים של כל השירותים |

## 🛠️ לוגים

```bash
sudo docker logs whatsapp_1 -f

# לוג ספציפי
sudo docker exec whatsapp_1 tail -f /var/log/baileys.log
sudo docker exec whatsapp_1 tail -f /var/log/fastapi.log
```

## 📨 מבנה הודעה נכנסת

```json
{
  "messageId": "ABC123",
  "jid": "972501234567@s.whatsapp.net",
  "sender": "972501234567@s.whatsapp.net",
  "isGroup": false,
  "timestamp": 1705000000,
  "type": "text",
  "data": { "text": "שלום!" },
  "receivedAt": "2024-01-12T10:00:00Z"
}
```

### סוגי הודעות:
`text` | `image` | `video` | `audio` | `document` | `button_response` | `list_response` | `template_button_response` | `reaction` | `location`
# whatsapp-single


CLEAN TOKEN
cd ~/projects/github/whatsapp-single
sudo rm -rf ./data/auth_1


# מחק contacts.json
sudo rm ./data/contacts_1/*

# מחק את כל ה-auth
sudo rm -rf ./data/auth/*

gi
#  הרצה דינמית
sudo docker build -t whatsapp-image .
cd ~/projects/github/whatsapp-single

# 1. עצור את הישן
sudo docker stop whatsapp_1
sudo docker rm whatsapp_1

# 2. בנה image חדש
sudo docker build -t whatsapp-image .

# 3. הרץ מחדש
sudo docker run -d --name whatsapp_1 --restart unless-stopped -p 8001:8000 -p 3002:3001 -v $(pwd)/baileys/src:/app/baileys/src -v $(pwd)/fastapi/app:/app/fastapi/app -v $(pwd)/data/auth_1:/app/auth_info -v $(pwd)/data/redis_1:/var/lib/redis -v $(pwd)/data/logs_1:/var/log -v $(pwd)/data/contacts_1:/app/data -e TZ=Asia/Jerusalem whatsapp-image


##  בדיקה שקוד תקין
node --check baileys/src/index.js
sudo python3 -m py_compile fastapi/app/main.py && echo "OK"

## בדיקה מתוך CONTAINER
docker exec whatsapp_9725XXXX  node --check /app/baileys/src/index.js

## LOGS מתוך CONTAINER
 docker logs whatsapp_972504476645 --tail 50
