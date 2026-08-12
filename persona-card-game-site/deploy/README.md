# Deploying the game and its relay

Two things go on the server: the **built site** (static files, served by nginx)
and the **relay** (one small Node process, kept alive by systemd). The relay is
what turns an online match into a shareable link; without it the game still
works and falls back to the copy-paste WebRTC handshake.

Written for the machine this repo sits on: Ubuntu, nginx, site at
`persona.shcherbakov.co` served from `/var/www/persona`, node at `/usr/bin/node`.

---

## 1. Build and publish the site

```bash
cd ~/projects/persona-card-game-site
npm ci                       # or npm install
npm run build                # writes dist/
sudo rsync -a --delete dist/ /var/www/persona/
```

`--delete` removes the previous build's hashed assets. That is what you want:
the filenames are content-hashed, so stale ones only accumulate.

## 2. Install the relay service

```bash
sudo cp deploy/persona-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now persona-relay
systemctl status persona-relay          # should say active (running)
curl localhost:8788/ws/health           # {"ok":true,"rooms":0}
```

The service runs as `nick` from this checkout, so **the checkout must stay
where it is** — `/home/nick/projects/persona-card-game-site`. Moving it means
editing `WorkingDirectory=` and running `daemon-reload` again.

It binds `127.0.0.1` only. Nothing outside the machine can reach it except
through nginx, which is the point.

## 3. Point nginx at both

```bash
sudo cp deploy/nginx-persona.conf /etc/nginx/sites-available/persona
sudo ln -sf /etc/nginx/sites-available/persona /etc/nginx/sites-enabled/persona
sudo nginx -t                            # must pass before reloading
sudo systemctl reload nginx
```

This replaces the old four-line site file. It still serves `/var/www/persona`
on port 80; what it adds is the `/ws` proxy, a rate limit, and cache headers.

If `nginx -t` reports a **duplicate `connection_upgrade` map**, another site on
this machine already defines one — delete the `map` block from the top of the
file and reload again.

## 4. Verify from outside

```bash
curl http://persona.shcherbakov.co/ws/health
RELAY_URL=ws://persona.shcherbakov.co/ws node tools/relay-smoke.js
```

The smoke check runs eleven assertions through the real proxy: room creation,
refusing unknown codes, refusing a third player, forwarding in both directions,
and disconnect cleanup. If it passes, online play works.

Then in a browser: open the site, **Online Match → Host a match**, pick decks,
create — you should get a link. Open it in another browser (or another machine)
and the match starts by itself.

---

## Updating later

```bash
cd ~/projects/persona-card-game-site
git pull
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/persona/
sudo systemctl restart persona-relay     # only if server/relay.js changed
```

Restarting the relay drops matches in progress. It holds nothing on disk, so
there is nothing to migrate or back up.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Game never offers a link, only copy-paste codes | The health probe failed. `curl http://persona.shcherbakov.co/ws/health`. |
| `curl` of `/ws/health` returns the game's HTML | nginx matched `location /` instead of `/ws` — the config did not reload, or the file is not the one in sites-enabled. |
| Connection drops after exactly 60 seconds | `proxy_read_timeout` is missing from the `/ws` block. |
| Browser console: `WebSocket connection failed`, code 1006 | The upgrade headers are missing, or the relay is not running. Check `systemctl status persona-relay`. |
| `502 Bad Gateway` on `/ws` | Relay is down. `journalctl -u persona-relay -n 50`. |

## Adding HTTPS later

This site is HTTP today, so the game uses `ws://`. Nothing in the code needs
changing when you add TLS: the relay address is derived from the page's own
scheme, so an `https://` page automatically uses `wss://`.

```bash
sudo certbot --nginx -d persona.shcherbakov.co
```

Certbot rewrites the server block and keeps the `/ws` location as it is.

One thing to know: on an HTTPS page, browsers **block** plain `ws://`
connections as mixed content. So once TLS is on, the relay must be reached
through nginx (which it already is) — never by pointing the setting at
`ws://…:8788` directly.
