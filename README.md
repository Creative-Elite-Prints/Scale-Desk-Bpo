# ScaleDesk server

One small server that runs your whole ScaleDesk business:

1. **The app:** your customers visit your address, create an account, and use ScaleDesk with their own leads, clients and freelancers.
2. **Free trials and monthly subscriptions:** you unlock trials, give invite codes, and record or automate paid months.
3. **Live jobs:** collected from several sources and pushed to signed-in users.
4. **Project rooms and quote requests:** private spaces to work with clients, and to ask freelancers for quotations.

Needs Node.js 18 or newer. No packages to install.

## Put it online

You need a free GitHub account and a Render account (render.com). Other hosts that run Node also work.

1. On GitHub, create a **private** repository and upload everything in this folder, keeping the `public` folder.
2. On Render choose **New**, then **Blueprint**, and pick the repository. Render reads `render.yaml` and creates the service, a storage disk, and generated passwords. Choose an always-on plan, because free plans sleep and lose files.
3. In the service's **Environment** page, copy `ADMIN_KEY`. Fill in `OWNER_EMAILS` (your own email), `PLAN_PRICE_TEXT` (for example `$19 per month`), and later `SUBSCRIBE_URL`.
4. Open `https://YOUR-ADDRESS/api/health`. You should see `"ok": true`.
5. Open `https://YOUR-ADDRESS/`, and create your account with the email you put in `OWNER_EMAILS`. That account never expires.
6. Open `https://YOUR-ADDRESS/admin` and sign in with `ADMIN_KEY` to manage customers and rooms.

## Selling ScaleDesk

| Setting | What it does |
| --- | --- |
| `TRIAL_DAYS` | Free trial given at sign-up. Default 7. Set `0` and every new account waits until you unlock it. |
| `OWNER_EMAILS` | Accounts with these emails never expire. Put yours here. |
| `PLAN_PRICE_TEXT` | The price shown on sign-in and plan screens, for example `$19 per month`. You choose it. |
| `SUBSCRIBE_URL` | Your payment provider's subscription link. Shown on the "plan ended" screen. |
| `SUPPORT_EMAIL` | Shown to people whose plan has ended. |

**Unlocking people to try it:** in `/admin`, under Customers, press **Give trial days**, or create an **invite code** (for example 14 days, 1 person). The person enters the code when they create their account.

**Taking subscriptions:** a paid month is 30 days. Either press **Add paid month** after you receive a payment, or let your payment tool tell the server automatically: it sends `POST /api/webhooks/subscription` with `{"email":"customer@example.com","months":1,"reference":"unique-payment-id"}` and an `x-signature` header holding the HMAC-SHA256 of the raw body (hex) using `PAYMENT_WEBHOOK_SECRET`. Repeated references are ignored. When a paid month runs out, the customer sees the "plan ended" screen. Their data stays saved.

**What customers get:** each account has its own leads, clients, freelancers, rooms and quote requests, and cannot see anyone else's.

## Project rooms and quote requests

- **Project room:** client and developer chat and share files. Final files stay locked for the client until the full price is recorded as paid. The room closes when the client approves and the full payment is recorded. Files are kept a few more days for download, then deleted.
- **Quote request:** you give a freelancer a private link. They see the brief (with no budget), chat with you, and send a quotation (price, days, notes). You accept or decline.
- In the app, **Invite to quote in app** (Freelancers tab, Message) creates the quote request and puts the link in your message. `/admin` lists all of them.

## Payments in milestones (30% / 40% / 30%)

- Every project room splits its price into milestones. The default is **30% to start, 40% at the midpoint, 30% on delivery**. In the app, **Send offer to client** has a Payment plan menu (30/40/30, 50/50, or 100% before final files). The plan is also written into the proposal text the client reads.
- The client can pay the first milestone as soon as they accept. The next ones appear only when you press **Request next payment** in the room. The client is emailed (if email is set up) and the button on their page changes to the exact amount.
- A milestone counts as paid when the total paid reaches its running total, so payments you record by hand in `/admin`, or part payments, work too.
- Final files stay locked until **every** milestone is paid. The room closes after the client approves and the full amount is in.
- **Invoice (PDF):** both you and the client can download an invoice from the room, showing each milestone, what is paid and the balance.

## Previews and Final delivery

- A client sees picture previews (PNG, JPG, GIF, WebP) through a viewer that draws "PREVIEW" with their name across the image. Other file types download as they are, so share screenshots or a short screen recording, not working files.
- This discourages casual copying. It cannot stop a technical person from saving what they can see, so never upload source code or a working site as a preview.
- Marking a file **Final delivery** needs a five-item checklist ticked first (scope finished, tested on phone and computer, no test content, feedback handled, handover ready). The server will not accept a final file without it.

## Accounts: confirmation, forgot password, legal pages

- New accounts must tick the Terms and Privacy box. A confirmation email is sent (people can start using the app straight away; a bar reminds them until they confirm).
- **Forgot your password?** sends a one-hour, single-use link. The answer is the same whether or not the email has an account. Using the link signs out every old session.
- Both need email set up (Resend, see below). Without it, use **Set password** in `/admin`.
- `/terms` and `/privacy` are plain-language **templates**. Set `BUSINESS_NAME`, `SUPPORT_EMAIL` and `LEGAL_COUNTRY`, then **have a lawyer in your country review and adjust them before you sell**. They are not legal advice.

## AI assistant

Add `ANTHROPIC_API_KEY` (from console.anthropic.com) and the assistant turns on:
- **Draft reply with AI** and **Summarise** in the Messages tab. The draft goes into the message box for you to edit; nothing is sent automatically.
- **Improve with AI** under a proposal.
- It never states what you can pay a freelancer. Each account gets 30 uses a day (`AI_DAILY_LIMIT`), and you pay Anthropic per use. `ANTHROPIC_MODEL` changes the model. The Privacy Policy tells users that the text they submit goes to the AI provider.

## Freelancer payouts

The **Payouts** tab records what you owe each freelancer: amount, due date, part payments, overdue flags and a CSV download. It is a record only (no money moves) and is saved with your account.

## Install on a phone

Open your address on the phone and choose **Add to Home Screen** (iPhone Safari: Share, then Add to Home Screen; Android Chrome: menu, then Install app). It then opens full screen like an app. It still needs an internet connection.

## Messages: talk to freelancers and clients inside ScaleDesk

- **Chat in app** (Freelancers tab, Message) starts a private conversation about a job. Your first message asks for a quotation and never states what you can pay. The freelancer opens their private link, reads it, replies, and sends a quotation (price, days, notes).
- The **Messages** tab lists every conversation with an unread badge, refreshes by itself every few seconds, and shows quotations with **Accept** and **Decline** buttons. **Open chat with this client** does the same for a client's offer.
- Enter an email address when you start a chat and the freelancer is emailed their private link. After that, each side gets a short "new message" email at most once every 30 minutes (needs Resend, see below). The notification never repeats the private link.
- No email set up: copy the private link shown in the thread and send it by WhatsApp.
- **New private link** in a thread replaces a lost link; the old one stops working.

## Card and EFT payments with PayFast (South Africa)

PayFast takes the payment on its own page, so card and bank details never reach your server. It works in rand only.

1. Open a merchant account at payfast.co.za. You need a South African bank account and PayFast's business verification.
2. In your PayFast dashboard, open the integration settings. Copy your **Merchant ID** and **Merchant Key**, and set a **passphrase** (a long phrase only you know). Subscriptions need the passphrase. If the dashboard has a switch for Instant Transaction Notifications, make sure it is on.
3. In your server settings add: `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `PAYFAST_SUB_AMOUNT` (your monthly price in rand, for example `349`) and `PUBLIC_URL` (your real `https://` address; PayFast must be able to reach it).
4. **Test first** in PayFast's sandbox: create a sandbox account, use its Merchant ID, Key and passphrase, and add `PAYFAST_SANDBOX=true`. Make a test subscription and a test room payment. Then switch to your live details and remove `PAYFAST_SANDBOX`.
5. Subscriptions are recurring billing. PayFast may need to switch that on for your account, so ask them if the subscription button fails.

What this turns on:
- **Subscribe** on the plan screen: a monthly charge in rand. Each successful charge adds a month (plus 2 days of grace). **Manage billing** opens PayFast's page where the customer can change their card. To cancel, the customer uses the link in PayFast's emails or their PayFast account, or you cancel in your PayFast dashboard. The plan stays active until the paid month ends.
- **Pay with PayFast (card or EFT)** in a project room, for the milestone that is due. **Only rooms priced in ZAR show it.** A client in another country pays the rand amount and their bank converts it. Whether PayFast accepts a given foreign card is up to PayFast's settings, so ask them.
- Every PayFast message is checked three ways before it counts: its signature, a confirmation call back to PayFast, and a repeat check so the same payment is never counted twice.

Stripe stays in the package as an option for anyone you sell ScaleDesk to in a country Stripe supports. You do not need it.

## PayPal (clients paying in other currencies)

PayFast takes rand only. For a room priced in dollars, euros, pounds and other currencies, the client gets a **Pay with PayPal (PayPal or card)** button. They pay on PayPal's own page, so card details never reach your server. When they come back, ScaleDesk asks PayPal what happened and records only a payment PayPal confirms for that room, in that room's currency.

1. Open a PayPal **Business** account (paypal.com) and make sure it can receive payments and be withdrawn to your South African bank. Check this with PayPal for your account, as rules for South African accounts have changed over time.
2. On developer.paypal.com open **Apps & Credentials**, create a **Live** app, and copy the **Client ID** and **Secret**. (Use the Sandbox tab for testing.)
3. Add to your server settings: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and make sure `PUBLIC_URL` is your real `https://` address.
4. **Test first** with the sandbox: use the sandbox Client ID and Secret and add `PAYPAL_SANDBOX=true`. Pay a test room with a sandbox buyer account. Then switch to live details and delete `PAYPAL_SANDBOX`.

Currencies: USD, EUR, GBP, AUD, CAD, NZD, SGD, HKD, CHF, SEK, NOK, DKK, PLN. PayPal cannot charge rand or dirham, so ZAR rooms use PayFast and AED rooms have no online payment option (record those by hand in `/admin`). PayPal charges its own fees and may hold or convert funds, so check its terms. The monthly **subscription** for your own customers stays with PayFast, in rand.

## Stripe (optional: only for countries Stripe supports)

Stripe is not available to South African businesses, so skip this section unless you run ScaleDesk from a country where Stripe works.

Stripe takes the card details on its own page, so they never touch your server. It supports many countries and currencies. Check that Stripe is available in your country and which payout options you get.

1. Create a Stripe account and finish its business verification.
2. In Stripe, create a **Product** with a **monthly recurring Price** for ScaleDesk. Copy the Price ID (starts with `price_`).
3. In Stripe's developer area, copy your **secret key** (`sk_...`). Start with the test key.
4. In Stripe, add a **webhook** pointing to `https://YOUR-ADDRESS/api/webhooks/stripe` for the events `checkout.session.completed` and `invoice.paid`. Copy its signing secret (`whsec_...`).
5. In your server settings add: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` and `PUBLIC_URL` (your server address, for example `https://scaledesk.example.com`).
6. Test with Stripe's test card `4242 4242 4242 4242`, then switch to your live keys.

What this turns on:
- **Subscribe button** on the plan screen. When a customer pays, their plan activates until the end of the paid month plus 2 days' grace. A **Manage billing** button lets them cancel or change their card.
- **Pay with card** on a client's project room, for the full amount in the room's currency. Supported currencies: USD, EUR, GBP, ZAR, AUD, CAD, NZD, SGD, HKD, AED, CHF, SEK, NOK, DKK, PLN. When the payment arrives the room records it, and closes once the client has also approved.
- Every Stripe message is checked against its signature, and repeated messages are ignored.

Stripe pays out to your bank account, and you are responsible for tax. A "merchant of record" service handles tax for you but works differently. Ask an accountant.

## Sending offers and messages by email

Offers to clients and quotation requests to freelancers are emailed from the app with a private link.

1. Create a Resend account (resend.com) and verify your sending domain.
2. Add `EMAIL_API_KEY` (your Resend key) and `EMAIL_FROM` (for example `Scale Desk <hello@yourdomain.com>`) to your server settings.
3. Replies go to the email address on your ScaleDesk account.

Each account can send 30 emails a day (change with `EMAIL_DAILY_LIMIT`). If email is not set up, the app shows the private link so you can send it yourself by WhatsApp or your own email.

## Sharing your work after a client accepts

A project room created with **Send offer to client** shows your proposal and price to the client. Until they press **Accept**, nobody can upload files. After they accept, you upload previews and mark the finished work **Final delivery**. The client can pay by card, and downloads the final files once the full price is paid. If they decline, the room closes.

## Other settings

| Name | What it does |
| --- | --- |
| `ADMIN_KEY` | A backup key the server accepts for admin actions. Required. You normally sign in as owner with your own login (see `OWNER_EMAILS`). |
| `DATA_DIR` | Where accounts, rooms and files are saved. Must be a persistent disk. |
| `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` | Optional. A free outside copy of your accounts and rooms, so a restart or a wiped disk can never lose them. See "Keeping accounts safe". |
| `PAYMENT_WEBHOOK_SECRET` | Lets a payment tool confirm payments automatically. |
| `ROOM_DAYS` | How long a room may stay open if never finished. Default 60. |
| `DOWNLOAD_DAYS_AFTER_CLOSE` | Days to download files after a room closes. Default 7. |
| `ACCESS_KEY` | Optional key for the job feed, for your own scripts. Signed-in users do not need it. |
| `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `PAYFAST_SUB_AMOUNT`, `PAYFAST_SANDBOX` | PayFast payments and subscriptions (see above). |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_SANDBOX` | PayPal payments in other currencies (see above). |
| `SOURCES`, `FREELANCER_TOKEN` | Job sources, and an optional Freelancer.com token. |
| `BUSINESS_NAME`, `LEGAL_COUNTRY` | Names used in the Terms, Privacy Policy and emails. |
| `ANTHROPIC_API_KEY`, `AI_DAILY_LIMIT`, `ANTHROPIC_MODEL` | Turns on the AI assistant, its daily limit per account, and the model. |

The job feed needs a signed-in account with an active plan.

## Jobs

| Source | How often | Notes |
| --- | --- | --- |
| Freelancer.com | every 60 seconds | Searches active projects for virtual assistant, customer support, data entry, cold email, lead generation, appointment setting, website, wordpress, game, mobile app, web app, chatbot. Change the list with `FREELANCER_KEYWORDS`. Hourly projects are shown as `$X / hr`, fixed ones as `$X fixed`. |
| RemoteOK | every 15 minutes | Credit and link back to RemoteOK (the app does this). |
| Remotive | every 6 hours | **Off by default.** Limited to 4 fetches a day, 24 hour delay, credit and link back required, no passing jobs to other job boards. |

Each job shows the client's full description in a **Full job description** dropdown, with **Copy description** and **Copy brief for freelancer** buttons. The brief leaves out the client's budget and the listing link and asks for a quotation. Freelancer's full text relies on their search returning it (`full_description`); if it does not, the app shows the short preview instead.

If Freelancer jobs stop appearing, check Freelancer's developer documentation. Bids and messages go through each site itself, using **Open original**. Read each source's terms before selling access to the feed.

## The member dashboard (`/app`)

Dark slate and electric cyan theme with a collapsible left menu: Dashboard, Live Job Leads, Lead Pipeline, Find Talent, Courses, Calculator, Analytics (Proposals, Payouts, My profile and Messages sit under "Your work").

- **Live Job Leads**: filter chips for BPO, Virtual Assistant, Customer Support, Cold Outreach and Software. Each card has **Place Bid**, a save icon, an open-original icon and **1-Click Copy Proposal**. **Upwork does not allow its listings to be copied by other apps**, so the Upwork button opens Upwork's own search for the chosen type in a new tab. Freelancer and RemoteOK leads arrive in the list. The Upwork, Freelancer and RemoteOK search links are built from standard search addresses; open each once to confirm it still works.
- **Lead Pipeline**: Follow Up, Closing, In Progress, Completed. **+ Add Deal** takes a manual deal or starts from a live lead. Drag cards between columns or use the arrows. Totals add up fixed-price deals only; hourly rates and yearly salaries show on the card but are not added in.
- **Saved data**: leads, bids, deals and stats are saved to your account and backed up to Upstash with the rest of the accounts (see "Keeping accounts safe"). Deals saved by older versions are moved over automatically (Found and Applied become Follow Up, In talks becomes Closing, Won becomes Completed).
- **Courses** are the built-in text lessons. **Analytics** is worked out from your own deals and the live feed.

## Before you sell to the public

- **Not independently security reviewed.** The rules were tested automatically (accounts, trials, subscriptions, separation between customers, rooms and quote requests), but get a review before you hold many customers' data.
- **Legal pages:** add terms of service and a privacy policy, and follow your country's data protection law (for example POPIA in South Africa or GDPR in Europe). You will store customers' names, emails and business data.
- **Terms and Privacy are templates.** Get them reviewed locally before selling.
- **Without email set up** there are no confirmation or reset emails. Use **Set password** in `/admin` to help someone who is locked out.
- **Not escrow:** clients pay you (through PayFast, or Stripe if you use it). Final files unlock only after full payment is recorded. Paying your developers is separate.
- **Backups:** everything is saved in files under `DATA_DIR`, and the server must run as one copy. Back that folder up.
- Sign-in attempts and sign-ups are rate limited.

## Try it on your computer

Run `ADMIN_KEY=choose-a-password OWNER_EMAILS=you@example.com node server.js`, then open `http://localhost:3000/`.

## Owner sign-in (no admin key needed)
Put your own email in `OWNER_EMAILS`, sign up with it, and you stay signed in for a year. A "Back office" button appears under your name in the app and opens /admin using that sign-in. `ADMIN_KEY` still works as a backup.

## How customers get paid (current behaviour)
Client card payments (PayFast / PayPal) go to the ONE merchant account set in the server settings (yours). Other customers can record payments by hand in the Payouts tab or paste their own payment link into a room ("Pay now" link). Per-customer merchant accounts are not built yet.

## Profiles
Every signed-in user (you included) has a "My profile" tab: name, headline, about, services, rates, contact email and up to 6 examples of work (title, description, link, picture). "Write with AI" buttons (need ANTHROPIC_API_KEY) draft or tidy the wording, and the person can undo and must read it before saving. Nothing is public until they tick "Make my profile page public"; the page is then at /p/<name>. Pictures are shrunk in the browser and stored in the account data on the disk, so keep an eye on disk size if you have many customers.

## Landing page
Visitors who open your address see the landing page (`public/landing.html`: hero, how it works, $19/mo pricing). Its buttons go to `/app#signup`. Signed-in people are sent straight to `/app`. The trial length shown comes from `TRIAL_DAYS`. To change the wording, price or features, edit `public/landing.html` and upload it to GitHub like any other file. The $19 and the "Approx. R350" are typed text: if you change what you charge (PAYFAST_SUB_AMOUNT), change it there too.

## Staying signed in
People stay signed in on a device (180 days, renewed every time they use the app; 1 year for owners) until they press Sign out. If the server is asleep or restarting, the app keeps the sign-in and retries instead of asking people to log in again. If people ARE being asked to create accounts again after every update, your accounts are being wiped: check in Render that the disk is attached (Disks, mounted at /var/data) and that the DATA_DIR setting is /var/data. Without the disk, everything resets on each deploy.

## Who can see what (access control)
- `/admin` (the back office) is only sent to a signed-in OWNER, meaning an account whose email is in `OWNER_EMAILS`. Owners get a protected cookie when they sign in. Anyone else who types `/admin`, signed in or not, is sent to `/app`.
- The customer, trial, paid-month and invite-code actions are refused by the server for everyone except owners (or someone holding `ADMIN_KEY` in an API call), whatever the page shows.
- Customers get no Back office button. "Open project rooms" opens `/rooms`, a separate page that shows only their own rooms.
- To make someone else an admin, add their email to `OWNER_EMAILS` in Render and let it redeploy.


## Keeping accounts safe (why accounts disappear on Render)
Render's normal storage is temporary. Every restart, deploy or sleep gives the server a blank folder, so every account is gone. The code cannot fix that on its own. You need ONE of these:

**Option A: a Render Disk (paid).** In Render, open your service, then Disks, add a disk mounted at `/var/data`, and set the `DATA_DIR` setting to `/var/data`. Disks need a paid plan (not the free one). This also keeps uploaded project files.

**Option B: a free Upstash database (works on the free plan).**
1. Go to upstash.com, create a free account, then create a Redis database (pick the region nearest you).
2. On the database page, find "REST API". Copy the URL and the token.
3. In Render, open your service, then Environment, and add `UPSTASH_REDIS_REST_URL` (the URL) and `UPSTASH_REDIS_REST_TOKEN` (the token). Save. Render restarts the server.
4. Check: sign in as the owner. The red "temporary storage" warning in the app and in /admin disappears, and `/api/health` shows `"storage":"remote"`.

How option B works: after every change the server saves a copy of your accounts and rooms to Upstash. When the server starts with an empty folder, it brings them back before anything else loads, so logins, owner status, trials and profiles all return. If Upstash cannot be reached at that moment, the server refuses to start rather than start empty, and tries again.
Option B copies accounts and rooms only. Uploaded project files are not copied, so use Option A if clients upload files.

You can use both. A copy of the file is also kept as `accounts.json.bak`, and a damaged file is set aside as `accounts.json.damaged-*` instead of being overwritten.

Emails are compared without caring about capital letters or extra spaces, on sign-up, sign-in and password reset, so "Ann@Mail.com " and "ann@mail.com" are the same account.


## Proposals and talent (latest update)
- Proposals are short: a one-line greeting, an About me summary (BPO, virtual assistant and admin agency), three deliverables, 3–5 business days, a 50% upfront / 50% on delivery split, and the closing line with your first name | ScaleDesk.
- Find Talent shows sample remote profiles at $5–$15/hr with rating, jobs done and completion rate. They are samples, not real people.
- Message on someone not yet onboarded opens their platform page (a talent search on Upwork or Fiverr until you give a real profile link). After you press Mark onboarded, Message opens a chat thread in your Messages tab.
- Active outreach and Saved talent counts are stored on your account and backed up to Upstash with everything else.

## Admin dashboard additions
- /admin shows a revenue box (MRR = paid subscribers × price), paid / trial / expired counts, and a customer table with sign-up date and status (Free Trial, Paid, Paused, Expired).
- Each customer has Extend trial (adds days) and Set trial length (ends N days from today, 0 ends it).
- MRR uses MRR_PRICE (default 19) and MRR_CURRENCY (default USD). Set them in Render only if your price differs.
- Access: sign in to ScaleDesk as the owner, or enter ADMIN_KEY on the /admin page.
- Data lives in Upstash Redis (already connected), so restarts do not erase it.

## Sign-in fixes
- Emails are trimmed and lower-cased on sign-up, sign-in and reset. Passwords are trimmed too; accounts made earlier with spaces in the password still work.
- A taken email on sign-up switches the form to Sign in with the email filled in. A wrong sign-in says whether the email or the password is the problem.
- /admin has a "Reset link" button per customer: it makes a one-time link (valid 24 hours) that lets them choose a new password.
