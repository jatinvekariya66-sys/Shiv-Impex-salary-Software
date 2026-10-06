# Ledger Payroll Backend — Turso Database + Cashfree Autopay + Live Sync

This is the backend for your Ledger payroll app: it stores employees and
payroll runs permanently in a free cloud database (Turso), pushes live
updates to every connected device the instant anything changes, and does
the actual bank transfers via Cashfree Payouts.

It's built to run on **Render** (a host that keeps a server running
continuously) while your app itself lives on **Netlify** (which only hosts
static pages, not servers) — that split is why you need both.

## 1. Create your free Turso database

1. Go to turso.tech and sign up (free tier is generous — plenty for this)
2. Install the Turso CLI:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   ```
3. Log in: `turso auth login` (opens your browser to confirm)
4. Create a database: `turso db create ledger-payroll`
5. Get your two credentials:
   ```bash
   turso db show --url ledger-payroll
   turso db tokens create ledger-payroll
   ```
   The first gives you a URL starting with `libsql://...`, the second a
   long token string. You'll need both in the next step.

(Turso's web dashboard also lets you create a database and generate a
token without the CLI, if you'd rather click through it.)

## 2. Configure locally and test first

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- `APP_SECRET` — make up a long random string
- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` — from step 1
- Cashfree fields — optional, leave blank for now

```bash
npm start
```

You should see `Ledger backend running on port 4000 — database: Turso
[autopay disabled] [live sync enabled]`. Test it locally with the app
(Server settings → `http://localhost:4000`) before deploying, so you know
it works before adding a hosting step on top.

## 3. Deploy the backend to Render

1. Push this `payroll-backend` folder to a GitHub repository (Render deploys from GitHub)
2. Go to render.com, sign up free, click **New → Web Service**, connect that repo
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. Under **Environment**, add every variable from your `.env` (`APP_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and the Cashfree ones if using them)
5. Deploy. Render gives you a URL like `https://ledger-payroll.onrender.com`

Because the actual data lives in Turso (not on Render's disk), it's
completely safe even though Render's free tier doesn't keep local files —
there's nothing local left to lose.

One free-tier quirk: Render's free web services "sleep" after 15 minutes
of no traffic, and the first request after that takes ~30–50 seconds to
wake back up (this also briefly drops the live WebSocket connection —
the app automatically reconnects once the server wakes up).

## 4. Deploy the app to Netlify

1. Go to netlify.com, sign up free
2. Drag your `payroll-ledger.html` file onto the Netlify dashboard's
   "Deploy manually" drag-and-drop area — no build step needed
3. Netlify gives you a live URL like `https://your-app-name.netlify.app`

## 5. Connect them

Open your Netlify URL, go to **Server settings**, and enter:
- Server URL: your Render URL (e.g. `https://ledger-payroll.onrender.com`)
- App secret: the same `APP_SECRET` you set in Render's environment variables

From here on, this is your permanent setup — no terminal needs to stay
open, nothing runs on your laptop.

## 6. Live sync across devices

Once connected, the app opens a WebSocket connection to this server
(`wss://` automatically, matching your `https://` Render URL). Any change
on any device — your laptop, your phone, a colleague's computer — pushes
instantly to every other open device, no refresh needed. If the
connection drops, it reconnects automatically every few seconds.

## 7. Add Cashfree later for real autopay

Add `CASHFREE_CLIENT_ID` / `CASHFREE_CLIENT_SECRET` as environment
variables in Render (start with sandbox keys), redeploy, and "Send to
autopay" / "Check status" in the app will start actually calling Cashfree.

## API reference

Every HTTP request needs the header `x-app-secret: <your APP_SECRET>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/employees` | List all employees |
| POST | `/api/employees` | Add an employee |
| PUT | `/api/employees/:id` | Update an employee |
| DELETE | `/api/employees/:id` | Remove an employee |
| GET | `/api/runs` | List all payroll runs with their entries |
| POST | `/api/runs` | Create a new payroll run |
| DELETE | `/api/runs/:runId` | Delete an entire run |
| DELETE | `/api/runs/:runId/entries/:employeeId` | Remove one person from a run |
| PATCH | `/api/runs/:runId/entries/:employeeId` | Manually set status |
| POST | `/api/runs/:runId/send-autopay` | Send pending entries to Cashfree |
| GET | `/api/runs/:runId/check-status` | Check and update Cashfree transfer status |
| WS | `/ws?secret=<APP_SECRET>` | Live sync — pushes `{"type":"changed"}` whenever data changes |

## Security notes

- Never commit `.env` or share your `APP_SECRET`, Turso token, or Cashfree secret
- CORS is open so your Netlify-hosted app can call this server directly —
  the `x-app-secret` header (and the matching `secret` query param on the
  WebSocket) is what actually protects it
- Treat your Turso auth token like a password — anyone with it can read or
  change your entire payroll database
