# WoW Forever Roster

A small website that shows a public roster of **World of Warcraft: Forever** characters. The admin can
track a **whole guild** (members sync automatically) and/or add individual players on `/admin`. The server
keeps everything up to date from the Blizzard API: level, class, race, faction, guild rank, ruleset, item
level, last login, and avatar.

- **Public page (`/`):** sortable, searchable roster with the guild banner, level bars, class colours,
  class-mix chips, level and rank filters, "+N levels today", and "last ding" times. It refreshes itself
  every 30 seconds.
- **Admin page (`/admin`):** password login. Pick the guild to track and name its ranks. Add players outside
  the guild one at a time or in bulk, set a public note per player, and hide guild members you don't want
  shown (alts, say). Force refreshes and see poll and API status. See who visits the site (below).
- **Stack:** Node.js 22 + Express. The data lives in one JSON file (`data/players.json`) and the frontend is
  vanilla JS with no build step.

---

## How the Blizzard API works for Forever (read this)

Blizzard hasn't **documented** a Forever API yet. Players found it on launch day (Nov 4, 2026), and it may change:

| | |
|---|---|
| Namespace | `profile-forever-{region}` (`us`, `eu`, `kr`, `tw`) |
| Character | `GET https://{region}.api.blizzard.com/profile/wow/character/{first}-{surname}?namespace=profile-forever-{region}` |
| Slug | First name + surname, lowercased, joined by `-` (e.g. `Anduin Wrynn` → `anduin-wrynn`). No realm, because Forever is realmless. |
| Avatar | `…/character/{slug}/character-media` (renders can lag the profile by several hours) |
| Guild | `GET …/data/wow/guild/{guild-slug}` and `…/roster` in the same `profile-forever-{region}` namespace. Also realmless. |
| Class/race names | `static-forever-{region}` (`/data/wow/playable-class/index`, `/playable-race/index`) |

Things to know:

- **A character shows up only once it's level 10 *and* has logged out at least once.** Before that the API
  returns 404, and the site shows "Not visible yet".
- **Profiles update when a character logs out.** Polling every 5 minutes is plenty, and faster polling won't
  show anything new.
- **Rate limits:** Blizzard allows 36,000 requests/hour and 100/second per API client. The poller spaces its
  calls 100 ms apart and sends `If-Modified-Since` for profiles. See the budget table under Guild mode.
- If Blizzard renames the namespace or paths, change them in `src/blizzard.js`.

---

## Guild mode

In `/admin`, under **Guild**, enter the guild name and region and click **Track guild**. The site checks that
the guild exists and then syncs it.

What each poll does (every `POLL_INTERVAL_SECONDS`, default 5 min):

1. **Fetches the guild roster** (one request). New members are added, and members who left are removed
   30 minutes after they drop off the roster, so a brief API glitch can't wipe your list. The roster gives
   every member's level, class, race, faction and rank number, **including characters under level 10** that
   have no profile yet.
2. **Fetches full profiles** for the item level, last login and avatar:
   - level-10+ guild members every `GUILD_PROFILE_INTERVAL_SECONDS` (default 30 min)
   - players you added by hand every poll

Notes:

- **Rank names:** Blizzard only sends rank numbers (0 = Guild Master). Name them in the **Rank names** box.
- **Hidden members:** guild members can't be deleted, because they'd come back on the next sync. Use
  **Hide** to keep someone off the public page instead.
- **Players you add by hand** stay on the list if they leave the guild. If you add a guild member by hand,
  they're switched to the faster polling for players you added.
- **Guild slug:** Blizzard hasn't documented the guild slug format. The site assumes the guild name
  lowercased with spaces turned into hyphens and apostrophes removed (`Kael's Chosen` → `kaels-chosen`). If
  the lookup says "not found" and the name is right, try a different slug in the **Slug** box.
- **Switching guilds or stopping:** this removes the old guild's members. Players you added by hand are kept.
- **Roster size:** the roster caps at 1,000 members.

**API budget** (36,000 requests/hour allowed):

| Guild size (level 10+) | Requests/hour at the defaults |
|---|---|
| 100 | ~12 roster + ~200 profiles ≈ **220** |
| 500 | ~12 + ~1,000 ≈ **1,000** |
| 1,000 | ~12 + ~2,000 ≈ **2,000** |

Even with `GUILD_PROFILE_INTERVAL_SECONDS=300`, a 1,000-member guild uses about 12,000 requests/hour, a
third of the limit.

---

## Visitor stats (admin only)

The **Visitors** panel on `/admin` shows whether the site is being used: who is on it right now, page
views and unique visitors over 24 hours to 90 days, returning visitors, time on page, which tabs people open,
and breakdowns by country, device, browser, system, referring site, and bots or link previews (for example,
someone pasting the link in Discord). Each IP can be given a name so you recognise it next time.

How it works, and what it doesn't do:

- **No cookies or browser storage for visitors.** Each load of the public page is logged on the server with
  the IP, the country Cloudflare reports (`CF-IPCountry`), the user agent and the referring site. Time on
  page comes from the page's own 30-second refresh, which only runs while the tab is visible.
- **Your own visits** are recognised from your admin sign-in cookie and hidden unless you tick
  "Include my own visits".
- **Kept for 90 days** in `data/visits.json`, separate from the roster. **Clear visitor log** deletes it.
- **Countries:** Cloudflare adds the country header when **IP Geolocation** is on for the zone
  (Network settings in the dashboard). It is on by default.
- IP addresses count as personal data under laws like the GDPR, even without cookies. For a small guild
  site this is usually fine, but don't share the log.

---

## 1. Get Blizzard API credentials

1. Go to <https://develop.battle.net/access/clients>. Your Battle.net account needs an authenticator attached.
2. **Create Client**. Give it any name. A redirect URL isn't needed, so use `https://localhost` if the form insists. Turn off "Service URL".
3. Copy the **Client ID** and **Client Secret**.

---

## 2. Host it with Docker + Cloudflare Tunnel (recommended)

The compose file runs two containers: the app and `cloudflared`. The app **publishes no ports on your
server**. cloudflared reaches it over the private Docker network, and visitors reach cloudflared through
Cloudflare. You need a domain whose DNS is managed by Cloudflare (the free plan is fine).

### 2a. Install Docker on Ubuntu (skip if you have it)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # then log out and back in
docker compose version          # should print v2.x
```

### 2b. Create the tunnel in Cloudflare

1. Open <https://one.dash.cloudflare.com> and go to **Networks → Tunnels → Create a tunnel → Cloudflared**.
2. Name it (e.g. `wow-forever`). On the "Install connector" screen, choose **Docker** and copy the long token
   after `--token`. **Don't run the command.** The token goes in `.env` instead.
3. Click **Next**, then on **Public Hostname** add:
   - Subdomain: `roster` (or whatever you like), Domain: your domain
   - Service type: **HTTP**, URL: **`app:3000`**
4. Save. Cloudflare creates the DNS record for you.

### 2c. Configure and start

```bash
git clone https://github.com/christofferbraun/wow-forever-tracker.git wow-forever-tracker
cd wow-forever-tracker
cp .env.example .env
chmod 600 .env
nano .env     # set BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET, ADMIN_PASSWORD, TUNNEL_TOKEN, DEFAULT_REGION
docker compose up -d --build
docker compose logs -f app   # Ctrl+C to stop following
```

Open `https://roster.yourdomain.com`, go to `/admin`, sign in, and add players.

### Day-to-day commands

```bash
docker compose ps                         # both containers should be "running"/"healthy"
docker compose logs -f app                # app logs
docker compose logs -f cloudflared        # tunnel logs
git pull && docker compose up -d --build  # update the app
docker compose pull cloudflared && docker compose up -d   # update cloudflared
docker compose down                       # stop (data is kept in the volume)
```

### Deploy automatically when you push to GitHub

A systemd timer can check GitHub every 2 minutes and redeploy whenever `main` has new commits. It needs no
open ports, webhook or GitHub setup. Install it once, from the checkout, with your normal account (it must
own the checkout and be in the `docker` group):

```bash
cd ~/wow-forever-tracker
git pull
sudo bash deploy/install-auto-update.sh          # or: ... install-auto-update.sh 5min
```

The first run rebuilds once. After that, each check does a `git fetch`; if `main` moved, it fast-forwards
and runs `docker compose up -d --build`, then waits for the app to report healthy. Commits that only touch
`README.md`, `LICENSE` or `deploy/` don't trigger a rebuild. If a build fails, the old container keeps
running and that commit isn't retried; push a fix, or run `FORCE=1 deploy/auto-update.sh`. If files were edited
on the server, it refuses to pull and says so in the log.

```bash
journalctl -u wow-forever-update -f              # watch deploys
systemctl list-timers wow-forever-update         # when the next check runs
sudo systemctl start wow-forever-update          # check right now
sudo bash deploy/install-auto-update.sh --uninstall
```

**Back up the roster:**

```bash
docker compose cp app:/app/data/players.json ./players-backup.json
```

**Restore:** `docker compose cp ./players-backup.json app:/app/data/players.json && docker compose restart app`

---

## 3. Alternative: host without Docker (systemd + cloudflared service)

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# App
sudo useradd --system --home /opt/wow-forever-tracker --shell /usr/sbin/nologin wowtracker
sudo git clone https://github.com/christofferbraun/wow-forever-tracker.git /opt/wow-forever-tracker
cd /opt/wow-forever-tracker
sudo npm install --omit=dev
sudo cp .env.example .env && sudo nano .env       # HOST=127.0.0.1, PORT=3000
sudo mkdir -p data && sudo chown -R wowtracker:wowtracker data .env && sudo chmod 600 .env
sudo cp deploy/wow-forever-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now wow-forever-tracker
curl -s http://127.0.0.1:3000/healthz            # {"ok":true}
```

**cloudflared as a system service:**

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

Create the tunnel in the dashboard as in step 2b, but choose **Debian** and **run** the
`sudo cloudflared service install <token>` command it shows. For the public hostname, set the service to
**HTTP → `localhost:3000`**.

Logs: `journalctl -u wow-forever-tracker -f` and `journalctl -u cloudflared -f`.

---

## 4. Optional: extra lock on `/admin` with Cloudflare Access

The admin page has its own password, login rate limiting, and a signed HttpOnly cookie. You can add a second
layer at Cloudflare's edge:

Zero Trust → **Access → Applications → Add → Self-hosted**. Set the domain to `roster.yourdomain.com` with path
`admin`, then add a second destination with path `api/admin`. Add a policy that **allows** only your email.
Cloudflare will then ask for a one-time email code before anyone even sees the admin login.

---

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET` | — | Required for polling |
| `ADMIN_PASSWORD` | — | Required, at least 12 characters |
| `DEFAULT_REGION` | `us` | `us`, `eu`, `kr`, `tw`. Can also be set per player. |
| `POLL_INTERVAL_SECONDS` | `300` | Roster sync and players added by hand. Minimum 60. |
| `GUILD_PROFILE_INTERVAL_SECONDS` | `1800` | Full-profile refresh for guild members (can't be lower than the poll interval) |
| `SITE_TITLE` / `SITE_SUBTITLE` | | Shown in the page header |
| `TUNNEL_TOKEN` | — | Docker setup only |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Bare-metal only. Compose sets `0.0.0.0:3000` inside the container. |
| `DATA_DIR` | `./data` | Where `players.json` and the session secret live |
| `LOCALE` | region default | Language for class/race names, e.g. `de_DE` |
| `TRUST_PROXY` | `loopback, uniquelocal` | Who may set `X-Forwarded-*` (cloudflared on localhost or the Docker network) |
| `SESSION_SECRET` | auto | Generated into `data/.session-secret` if unset |

## Project layout

```
server.js            Express app, routes, security headers
src/config.js        .env loading and validation
src/store.js         JSON-file storage (atomic writes)
src/blizzard.js      OAuth + Forever profile/guild/static API client, response mapping
src/poller.js        Polling loop: guild roster sync, profile refresh, level history, avatars
src/auth.js          Admin password login, signed session cookie, rate limiting
src/stats.js         Activity feed and guild analytics
src/visits.js        Cookieless visitor log for the admin Visitors panel
src/probe.js         Admin API probe: raw Blizzard responses for one character
public/              index.html (roster), admin.html, styles.css, *.js
Dockerfile, docker-compose.yml, deploy/  Hosting (deploy/auto-update.sh: redeploy on push)
```

## API endpoints

Public: `GET /api/players`, `GET /api/site`, `GET /healthz`

Admin (session cookie + `X-Requested-With: fetch` header on writes): `POST /api/admin/login`, `POST /api/admin/logout`,
`GET /api/admin/status`, `GET|POST /api/admin/players`, `POST /api/admin/players/bulk`,
`PATCH|DELETE /api/admin/players/:id` (PATCH accepts `note`, `region`, `hidden`), `POST /api/admin/players/:id/refresh`,
`POST /api/admin/refresh-all`, `GET|PUT|DELETE /api/admin/guild`, `PATCH /api/admin/guild/ranks`,
`GET|DELETE /api/admin/visits` (`?range=24h|7d|30d|90d&mine=1&tz=<minutes>`), `PUT /api/admin/visits/labels`,
`POST /api/admin/probe` (`{ slug, region }`: raw responses from every character endpoint, plus item data and icons for the equipped gear)

Upgrading from the first version needs no migration: the existing `players.json` is read as is.

## Blizzard terms

Data comes from the Blizzard API and is subject to the Blizzard Developer API Terms of Use
(linked from <https://develop.battle.net>).
Don't put API data behind a paywall, and remove a player's data if they ask you to.
