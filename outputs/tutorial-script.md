# Staking PDEX — Tutorial Video Script

**Total length:** ~3:40 (3:00 of narration + 0:40 of card / silence buffer).
**Pace:** 150 wpm comfortable, ~480 words total narration.
**Voice:** direct, honest, concrete. Match the brand voice rules in `BRAND.md`.

Each segment has three columns: **time**, **on-screen action**, and **what the narrator says**. Cuts at every `///`. Bold words are emphasis cues for the voiceover artist — speak them slightly louder, not slower.

---

## 0:00 – 0:10 — Title card

| Time | Action | Narration |
|---|---|---|
| 0:00–0:10 | Title-card SVG (`tutorial-title-card.svg`). Soft synth pad bed at -18 LUFS. | *(silent)* |

---

## 0:10 – 0:40 — Why stake (30s)

> Hook the viewer with the why. One sentence per idea — earn, validators, commitment.

| Time | Action | Narration |
|---|---|---|
| 0:10–0:15 | Fade to home page. Hold on the network-info panel — viewer sees AVG APY, current era, validator count. | Polkadex uses **Nominated Proof-of-Stake**. |
| 0:15–0:22 | Zoom in slightly on the APY card. | Validators produce blocks. Everyone else stakes PDEX behind them and earns a share of the rewards. |
| 0:22–0:30 | Pan to the AVG APY value (~14–16%). | Right now the average annualised yield is shown here on the home page — roughly fourteen to sixteen percent, depending on which validators you back. |
| 0:30–0:40 | Cut to a quick text overlay: "Earn · Cool-down 28 days." Cursor moves toward the **My Account** link in the sidebar. | You commit PDEX to a validator. You earn every era — about twenty-four hours. When you want to stop, you unstake — there's a twenty-eight-day cool-down — and your PDEX comes back to your spendable balance. That's the whole loop. **Let's do it.** |

///

## 0:40 – 1:20 — Connect wallet (40s)

> Build trust at the signing moment. Slow the cursor. Show the extension dialog without speeding past it.

| Time | Action | Narration |
|---|---|---|
| 0:40–0:45 | Lower-third: "Step 1 · Connect your wallet." Click **My Account** in the sidebar. | First, **connect a wallet**. Click "My Account" in the sidebar. |
| 0:45–0:55 | Show the Connect Wallet panel with extension list visible. Cursor hovers over Polkadot.js card. | The explorer detects any wallet extension you've installed — Polkadot.js, Talisman, SubWallet, or PolkaGate. On mobile, use Nova Wallet or SubWallet's in-app browser. |
| 0:55–1:08 | Click Polkadot.js. The extension's permission dialog appears. **Hold for the full dialog read.** | Approve the permission request. The explorer never sees your private key or seed phrase — it asks the wallet to sign on your behalf. |
| 1:08–1:20 | Account picker appears. Click an account. Land on the wallet dashboard. Hold for ~1s. | Pick the account you want to stake from. You land on your **wallet dashboard**. |

///

## 1:20 – 2:30 — Pick a validator + stake (70s)

> The longest segment because the choice of validator is where users get stuck. Show, don't tell, the three things to look at.

| Time | Action | Narration |
|---|---|---|
| 1:20–1:25 | Lower-third: "Step 2 · Pick a validator." Cursor moves to **Stake more** button. | From the dashboard, click **Stake more**. |
| 1:25–1:42 | Quick cut to Validators page. Pan slowly across the **Commission, Real APY, Slash** columns. Numbers in focus. | Before you nominate, browse the Validators page and look at three things. **Commission** — the cut a validator keeps before paying you. **Real APY** — actual realised yield over the last thirty days. **Slash count** — non-zero means past penalties. |
| 1:42–1:48 | Back to the Stake modal. Cursor in the validator search box. | Search for the validator by name or address. |
| 1:48–2:00 | Highlight the "Selected" list as we type. | You can back up to sixteen validators at once. The chain picks the highest-stake ones each era, so **spreading across several** gives you exposure even if one of them drops out. |
| 2:00–2:08 | Cursor moves to the amount input. Type the PDEX amount. | Enter how much PDEX you want to stake. |
| 2:08–2:18 | Click **Stake**. Wallet extension pops up. **Hold for the full sign-and-submit dialog read.** | Click Stake. Your wallet pops up — **review the call data**, then sign. |
| 2:18–2:30 | Success toast. Dashboard updates with the new "Total Staked" stat. | The transaction lands in the next block. Your dashboard updates. |

///

## 2:30 – 3:20 — What happens next (50s)

> Land the expectation: rewards come tomorrow, not now.

| Time | Action | Narration |
|---|---|---|
| 2:30–2:36 | Lower-third: "Step 3 · Watch your rewards." Click "Full reward history" link. | Rewards start landing at the next **era boundary** — about twenty-four hours from now. Open the **Staking Rewards** page for your address to see them. |
| 2:36–2:55 | Show the Staking Rewards page. Spotlight the Realized APR card. | The **Realized APR** card shows your actual yield — rolling thirty days, ninety days, and all-time. It's a number you can **trust** because it's computed from what you actually received, not a theoretical target. |
| 2:55–3:10 | Cut back to the wallet dashboard. Pulse-highlight the **Pay out rewards** button. | When unclaimed rewards build up, the **Pay out** button on your dashboard turns active. One click — sign once — and you collect every reward you've earned. |
| 3:10–3:20 | Hold on the dashboard. Subtle motion. | Anyone can trigger your payout, so even if you forget, you'll usually receive your rewards within a day or two anyway. **That's staking on Polkadex.** |

///

## 3:20 – 3:40 — End card

| Time | Action | Narration |
|---|---|---|
| 3:20–3:40 | End-card SVG (`tutorial-end-card.svg`). Music outro. | *(silent)* |

---

## Production notes for the editor

- **Cursor visibility:** make sure the cursor is enabled in the screen recorder, and pause ~0.5s on each interactive element before clicking. New viewers will not know where the buttons are.
- **Zoom-ins:** at every modal open (Stake, sign), zoom the recording 1.4× so 12-px form labels are readable on a phone.
- **Captions:** auto-generate via YouTube Studio, then proof-read for product names — auto-captioning consistently mishears "PDEX" as "P-Dex" or "Pidex."
- **Brand colour for highlights:** use `#E6007A` (Polkadex pink) for callout arrows and step-counter circles; `#00E676` (Polkadex green) for success toasts and "rewards earned" moments.
- **Avoid showing your real balance.** Use a demo wallet or doctor the DOM via the inspector before recording the dashboard shot.
- **Run length target:** 3:40 total. Faster is better — if you can land at 3:00, do.
