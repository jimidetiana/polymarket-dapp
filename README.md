# Polymarket Soccer Market-Graph dApp — Usage Notes

A **pure front-end** Polymarket soccer dApp. It draws every market of a single
match as one **relationship graph** (a "market web"), and you place orders by
clicking nodes directly on it. No server, no database — the graph is computed in
the browser on every load from Gamma's market list.

> These are usage notes: how to read the graph and operate the dApp. Project
> goals live in `GOALS.md`; the wallet/order-flow deep dive is in
> `WALLET-HANDOFF.md`.

---

## Picking a match

The left column lists today's + tomorrow's soccer matches (Chinese team names
with an English sub-line, league · kickoff · volume, and a status badge).

- **Search** by team or league name — Chinese or English both work.
- **Filter tabs** are multi-select. Status tabs (Live / Upcoming / Ended) union
  together; **我的 (Mine)** intersects with them. **全部 (All)** clears the
  selection.
- A **持仓 (Position)** badge on a row means you hold a position **somewhere in
  that match**. This check is at the **event level** — it lights up if you hold
  any side of any market in the match, including markets the graph does not
  draw (see the caveat below).

Click a row to load that match's graph.

## Reading the market graph

The graph is a **fixed 26-slot template** — the same skeleton for every match,
so a slot always sits in the same place. Data only fills the slots; it never
reshapes the layout.

- **Center three nodes** — inferred goal counts (total / home / away). These
  have no market of their own; the number is reverse-inferred from the
  over/under ladder.
- **Market nodes** — each shows **one side** of a real market and its price:
  - Over/Under (total & per-team) → the **Over** side
  - Moneyline (home / draw / away) → the **Yes** side
  - Spread (±1.5, ±2.5) → the named team's side (both sides get their own slot)
- **Node color** encodes home (warm) / away (cool) / neutral. A **fully
  colored** node has a live two-sided quote; a **dimmed, dashed** node only has
  a possibly-stale Gamma snapshot price.
- **✓ 已打出** on a node means the goal line has been reached.
- A **white outline** marks the currently selected node; a **dashed empty**
  node means the match does not list that line.

## Position markers

When you hold a position, a small badge sits at the node's top-right corner.
The **letter** says open vs. settled, the **color** says which side:

| Badge | Meaning |
|-------|---------|
| **Green · 持** | You hold **this displayed side**, position still open |
| **Gray · 结** | You hold **this displayed side**, position settled/closed |
| **Amber · 持 / 结** | You hold the **other side of this same market** (e.g. you bought **Under** but the slot shows **Over**, or **No** on a moneyline). That side has no slot of its own in the template, so it's borrowed onto the shown slot. |

Amber is matched via the market's `conditionId` (shared by both sides). Hover
the node to see the exact outcome you hold, size, avg/current price, and P&L —
the amber tooltip spells out that it's a reverse-side holding so the Over/Under
label isn't mistaken for the side you own.

> **Caveat — markets the template doesn't draw.** If your position is on a
> market with no slot at all (both-teams-to-score, correct score, half-time
> lines, total 6.5+, per-team 3.5+, spread ±3.5, …), it can't be marked on the
> graph — there's no node to attach to. It still shows via the event-level
> **持仓** badge in the match list. This is expected, not a bug.

## Placing an order

Click any node bound to a market to open the order panel. The center inferred
nodes and empty slots aren't clickable for ordering — they only focus/highlight.
Ordering needs a wallet connected on **Polygon**. Positions and balances are
read from your **proxy wallet**, not the signing address.

---

## Mobile wallets

- **Binance Wallet / MetaMask in-app browser**: open this site's URL inside the
  wallet and connect using its injected provider, just like a desktop extension.
- **Mobile Chrome / Safari / home-screen PWA**: use **Connect mobile wallet**
  (WalletConnect), then select Binance Wallet or MetaMask in the connection
  dialog. Approve in the wallet and return to the browser/PWA. Adding the site
  to the home screen does not inject a wallet by itself.
- Desktop extensions still connect directly; the adjacent arrow offers
  WalletConnect when it is configured. Multiple injected wallets remain selectable.

To enable WalletConnect, create your own project at
[Reown Dashboard](https://dashboard.reown.com), allow the frontend's production
origin (and any HTTPS development origin you use), and set this in `.env`:

```dotenv
VITE_WALLETCONNECT_PROJECT_ID=your_project_id
```

This is a **public project identifier**, not a private key or builder secret.
Restart the dev server or rebuild and deploy after changing it. Without an ID,
only injected wallets are available; the UI explains how to use a wallet's
in-app browser rather than attempting to connect a nonexistent provider.
Cross-app connection requires internet access and a compatible wallet version;
verify both wallets on a real phone before treating a deployment as tested.

Android home-screen PWAs advertise a WalletConnect `redirect.universal` URL
pointing to the site's root (inside the PWA scope). This gives supporting wallets
a return destination, but the wallet and Android decide whether to open it and
whether it returns to the existing PWA window. Desktop browser sessions do not advertise
this return URL. After changing this metadata, disconnect and reconnect the wallet;
an existing session does not receive the new metadata just by refreshing the page.

## Development

```bash
npm run dev      # Vite dev server
npm run build    # tsc -b && vite build
npm run test     # vitest run
npm run lint     # oxlint
npm run server   # thin HMAC attribution / signing backend (optional)
```

Built with React 19 + TypeScript + Vite, Tailwind CSS v4, TanStack Query, and
the Polymarket CLOB client. Market data comes from Gamma (CORS-open, browser
direct); live prices stream over the CLOB WebSocket.

## Deploying

The frontend is a static site (hash routing) served as a **Cloudflare Worker
with static assets** — what Cloudflare Pages became. The Worker name, and so
the `https://<name>.zhangsanfengzhsh.workers.dev` URL, comes from
`wrangler.jsonc`:

```bash
npm run deploy   # build + wrangler deploy (uploads dist/ to production)
```

`VITE_SIGN_URL_PRIMARY` / `VITE_SIGN_URL_FALLBACK` are baked in at **build**
time from `.env`, so redeploy after changing them. They point at the signing
backend, which lives in its own repo (`polymarket-builder-sign`, Cloudflare
Workers) and holds the builder secrets. Nothing secret is in this bundle.

Wallet signing needs a secure context (`https://` or `localhost`): opening the
site over plain `http://` on another host fails at order time with
`reading 'importKey'`.
