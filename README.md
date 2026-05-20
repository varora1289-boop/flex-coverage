# Indeed Flex Coverage Analysis Tool

## Getting it running (5 minutes)

### Step 1: Open in Cursor
Open Cursor. Click **File > Open Folder**. Pick the `flex-coverage` folder.

### Step 2: Open the terminal
Press **Ctrl+`** (backtick key, top left of keyboard next to the 1 key).
This opens a terminal panel at the bottom of Cursor.

### Step 3: Install and run
Type these two commands one at a time, hitting Enter after each:

```
npm install
npm start
```

You should see:
```
  ✦ Indeed Flex Coverage Tool running at http://localhost:3000
  ✦ 3199 ZIP codes loaded from data/territories.csv
  ✦ 15 compliant states loaded from data/compliant_states.csv
  ✦ Logs saved to /logs folder
```

### Step 4: Open the tool
Open your browser and go to: **http://localhost:3000**

That's it. The tool is live.

---

## Updating coverage data

### Add or change ZIP territories
Open `data/territories.csv` in Cursor (or Excel). Each row is:

```
zip,market,tier
30303,Atlanta,core
77015,Houston,adj
85264,Phoenix,exp
```

Tier options: `core`, `adj`, `seg`, `exp`

Save the file. Restart the server (Ctrl+C in terminal, then `npm start` again).
The tool instantly uses the new data.

### Add or remove compliant states
Open `data/compliant_states.csv`. Add or remove states:

```
state,status
AZ,compliant
TX,compliant
```

Any state listed as `compliant` = unlisted ZIPs in that state show "Out of Coverage"
States NOT listed = unlisted ZIPs show "Non-compliant"

Save and restart.

---

## Reviewing analysis logs

Every time someone runs an analysis, a JSON file is saved to the `logs/` folder.
Filename format: `2026-05-20T15-30-00_Client_Name.json`

Each log contains: client name, requester, locations analyzed, tier results,
spend data, and a timestamp.

You can also see all logs at: **http://localhost:3000/api/logs**

---

## Deploying for your team (so everyone can access it)

### Option A: Railway (easiest, free tier available)
1. Push this folder to a GitHub repo
2. Go to railway.app, sign in with GitHub
3. Click "New Project" > "Deploy from GitHub repo"
4. Pick your repo. Railway auto-detects Node.js
5. It gives you a URL like `flex-coverage.up.railway.app`
6. Share that URL with your rev team

### Option B: Render (also free tier)
1. Push to GitHub
2. Go to render.com, connect GitHub
3. Create "New Web Service", pick your repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Deploy

### Option C: Run on your company network
If your team has a shared server, just copy this folder there,
run `npm install && npm start`, and share the IP:3000 address.

---

## File structure

```
flex-coverage/
├── server.js              ← The web server (you don't need to touch this)
├── package.json           ← Project config
├── data/
│   ├── territories.csv    ← ZIP code coverage data (EDIT THIS)
│   └── compliant_states.csv  ← Which states are compliant (EDIT THIS)
├── public/
│   └── index.html         ← The coverage tool UI
└── logs/                  ← Analysis logs auto-saved here
```
