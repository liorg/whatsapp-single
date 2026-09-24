


השלב הבא: העברה לשרת (מהמחשב שלך):
```bash

docker save liorgr/whatsapp-single:local | gzip | ssh lior@<server-ip> 'gunzip | docker load'
```
בשרת:
```bash

docker images liorgr/whatsapp-single      # צריך להופיע tag בשם local
```

Supabase SQL:
sql
```bash

update providers set tag = 'local' where id = 'baileys';
```
בשרת: לעקוב אחרי הלוג ולעשות Restart לטלפון מה-UI:
```bash

journalctl -u whatsapp-manager -f | grep --line-buffered TIMING
```
```bash

docker images liorgr/whatsapp-single:local --format '{{.Size}}'
```

כדאי לעבור ל-push עם tag בשם test, שמעלה רק את השכבות שהשתנו.

```bash
docker tag liorgr/whatsapp-single:local liorgr/whatsapp-single:test
docker push liorgr/whatsapp-single:test
```

```bash
update providers set tag = 'test' where id = 'baileys';
```

בשרת:

```bash
curl -s -X POST localhost:5000/api/images/prepull | jq '.results[] | {image, ok, updated}'
journalctl -u whatsapp-manager -f | grep --line-buffered TIMING

```

```bash
docker logs -t whatsapp_972546252491_aab00b9e 2>&1 | head -3

```