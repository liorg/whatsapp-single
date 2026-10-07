1. מצא את שם הקונטיינר של Baileys:
```bash
docker ps
```

בדוק סטטוס

```bash
curl -s http://127.0.0.1:9369/status

curl -s http://127.0.0.1:9369/version
```

```bash
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
```


```bash

docker stop  whatsapp_972504476645_3beff8fa
docker rm whatsapp_972504476645_3beff8fa

```

```bash
sudo systemctl restart whatsapp-manager.service

```


יכול להיות. נבדוק אילו תיקיות מחוברות ל־volume:

```bash
docker inspect --format '{{range .Mounts}}{{println .Source " -> " .Destination}}{{end}}' whatsapp_972504476645_3beff8fa
```

```bash
docker exec whatsapp_972504476645_3beff8fa tail -n 0 -F /var/log/baileys.log \
  | awk '/\[MESSAGE\] raw decoded/ {show=1} show {print; fflush()} show && /^    }[[:space:]]*$/ {show=0}'
```
ונחפש קובצי לוג בתוך הקונטיינר:

```bash
docker exec whatsapp_972504476645_3beff8fa sh -c 'find /app /var/log -type f -name "*.log" -not -path "*/node_modules/*" 2>/dev/null'
```

```bash
sudo ls -lh /opt/whatsapp-data/logs_3beff8fa-4dc6-4a03-b70f-17a47fe09529/
```

2. הצג את הלוג שלו בזמן אמת:
```bash
   sudo tail -n 100 -F /opt/whatsapp-data/logs_3beff8fa-4dc6-4a03-b70f-17a47fe09529/baileys.log
```



   
