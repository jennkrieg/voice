# Voice Agent Platform

A multi-client AI phone agent platform you can resell (in the spirit of Retell / Vapi / Bland). Each client
(a "tenant") gets their own agents, phone numbers, calendar and CRM connections, call recordings, analytics
and AI coaching. You run one deployment for all of them.

**What an agent can do**

| | |
|---|---|
| Phone calls | Inbound and outbound calls on numbers you buy or import through Twilio. Natural turn-taking, the caller can interrupt, filler phrases while it looks things up, a silence check, and a maximum call length. |
| Calendar | Checks open times and books on **Google Calendar** (clients click a "connect" link) or **Cal.com**. Sends a confirmation text after booking. |
| Transfers | Hands the call to a person (e.g. front desk, sales, billing). The person hears a short spoken summary first, and if nobody answers the AI takes the call back. |
| CRM | **HubSpot** and **GoHighLevel**: looks up the caller, updates fields, logs each call as a note, writes the outcome and summary into fields you choose. **Any other CRM** connects through webhooks (Zapier, Make, n8n, Salesforce Flow, Pipedrive automations...). |
| Auto-dial leads | A CRM workflow calls our webhook when a contact is created or updated, and the agent phones them. It respects calling hours in the contact's timezone, do-not-call, de-duplication, retries and per-agent concurrency. |
| SMS | Two-way AI texting on the same number (it can book by text too), texts during calls ("I just texted you the address"), missed-call text-back, and STOP/START opt-outs. |
| Email follow-ups | Sends emails with **PDF lead magnets attached** (or linked) through the client's own SMTP. Works with Google Workspace, Microsoft 365, SendGrid, Postmark, SES and Resend. |
| After every call | Recording (dual channel). The AI writes a summary, outcome, sentiment, objections and unanswered questions, plus a **1-10 coaching review**, and drafts a personalised follow-up text and email (sent automatically if enabled). |
| Coaching reports | Reviews many calls together and tells you what's working, the top problems with evidence, knowledge gaps (with answers to add), objection handling, and exact instruction changes to make. |
| Analytics | Connect rate, booking conversion, transfer rate, caller hang-up rate, success rate, outcomes, average score, minutes used per client, and a full event timeline for every call. |
| Voices | Choose from your ElevenLabs voice library, preview any voice and setting, or have the agent call you right now to hear it live. |
| Background sound | Optional office, call centre or coffee shop ambience mixed under the voice, at any volume, or upload your own WAV recording. |

---

## The dashboard

One web app with two sides, served by the same server at `PUBLIC_BASE_URL`:

* **Your admin view** (`/admin`): all clients with their agents, numbers, calls, minutes and bookings for the
  last 30 days. Create a client (with their login), open any client to manage it as them, and add teammates as
  platform admins.
* **The client portal**, white-labelled with your `BRAND_NAME`, `BRAND_LOGO_URL` and `BRAND_PRIMARY_COLOR`:
  * **Overview:** calls, connect rate, booking rate, transfer rate, hang-up rate, AI score, minutes, calls per
    day, an outcome breakdown, recent calls, and the latest coaching tip.
  * **Calls:** filter by agent, status and outcome. Each call shows the recording player, a chat-style
    transcript, the AI review with copyable instruction fixes, objections and unanswered questions,
    follow-ups sent, and the event timeline.
  * **Agents:** start from a template (receptionist, new lead caller, blank), then edit on tabs:
    * Basics: instructions, knowledge, greetings
    * Voice & sound: voice library with play buttons, sliders, live preview, "call me" test, background sound with listen buttons
    * Calendar: bookable hours editor
    * CRM: field mapping
    * Transfers
    * Follow-ups & texting: lead magnets, auto follow-ups
    * Calling rules
  * **Phone numbers:** search by area code, buy, assign to an agent, import, release.
  * **Contacts:** search, call now, do-not-call and do-not-text switches, call history and SMS/email thread.
  * **AI coaching:** generate and read reports.
  * **Integrations:** connect cards for Google, Cal.com, HubSpot, GoHighLevel, SMTP with provider presets,
    and webhooks; a test button; copyable CRM-trigger URLs.
  * **Settings:** team logins (owner or member), password, API key.

Owners can manage their team, API key and integrations; members can do everything else. Sessions are httpOnly
cookies (SameSite=Lax, plus a required header on every change to block cross-site requests). Passwords are
hashed with scrypt, and changing a password signs out other devices.

### See it with sample data (no keys needed)

```bash
npm install
npm run build
npm run demo
```

Open http://localhost:8080 and sign in as `admin@demo.test` / `demo-admin-123` (you), or
`owner@brightsmile.test` / `demo-owner-123` (a client). Data lives in memory and resets on restart.

To work on the dashboard with hot reload, run `npm run dev` (API on :8080) and `npm run web` (dashboard on :5173).

---

## How it works

```
Caller ⇄ Twilio ⇄ (WebSocket audio) ⇄ this server
                                        ├─ Deepgram: speech → text (streaming)
                                        ├─ Claude: conversation + tools (calendar, CRM, SMS, email, transfer)
                                        ├─ ElevenLabs: text → speech (streaming, sentence by sentence)
                                        └─ Mixer: voice + optional background loop, paced in 20 ms frames
After the call: Claude analysis → CRM note/fields → follow-up SMS/email → webhooks → retries
```

* `src/telephony/call-session.ts`: the live call (turn-taking, barge-in, transfers, hang-up, silence, recording)
* `src/agents/`: config schema, prompt, tools, conversation loop, post-call analysis, coaching reports
* `src/integrations/`: Google Calendar, Cal.com, HubSpot, GoHighLevel, outbound webhooks
* `src/dialer/`: queue, calling hours, retries
* `src/api/`: REST API (dashboard login, platform admin, client API, Twilio webhooks, CRM webhooks, OAuth)
* `web/`: the dashboard (React, Vite, Tailwind), built into `web/dist` and served by the API server
* `src/audio/`: μ-law codec, background ambience generator, WAV loader

---

## Accounts you need (once, for the whole platform)

| Service | What for | Notes |
|---|---|---|
| [Anthropic](https://console.anthropic.com) | The agent's brain, call reviews, coaching | `ANTHROPIC_API_KEY` |
| [Twilio](https://www.twilio.com) | Phone numbers, calls, SMS, recordings | For US texting, register **A2P 10DLC** (brand and campaign) for each client before sending texts at volume. |
| [Deepgram](https://deepgram.com) | Speech to text | |
| [ElevenLabs](https://elevenlabs.io) | Realistic voices | Add voices from their Voice Library to your account and they show up in `GET /api/voices`. |
| Postgres | Database | Neon, Supabase, RDS, Railway... Without `DATABASE_URL`, an embedded dev database is used. |
| Google Cloud OAuth app (optional) | "Connect Google Calendar" link for clients | Enable the Calendar API and add the redirect URI `<PUBLIC_BASE_URL>/oauth/google/callback`. |

Each client brings their own Cal.com API key, HubSpot private app token, GoHighLevel private integration token, and SMTP login.

---

## Run it

```bash
cd voice-agent
npm install
cp .env.example .env    # fill in keys
npm test                # 29 tests: logic, audio, logins and permissions, API end-to-end with an in-memory database
npm run build           # builds the dashboard
npm run dev
```

Twilio must be able to reach your server over HTTPS. In development, use a tunnel:

```bash
cloudflared tunnel --url http://localhost:8080
```

Then set `PUBLIC_BASE_URL` to the tunnel URL. In production, deploy the `Dockerfile` anywhere that supports
WebSockets (Fly.io, Render, Railway, ECS, a VM), close to `us-east` for the lowest latency to the speech APIs.

### Try an agent without a phone

```bash
npm run chat -- examples/dental-front-desk.json
```

```bash
npm run chat -- examples/dental-front-desk.json --outbound
```

```bash
npm run chat -- examples/dental-front-desk.json --sms
```

This uses the same prompt and tools as a real call, with a fake calendar. Type `/quit` to see the AI review of
your conversation.

---

## Onboarding a client

The quickest way is the dashboard. Sign in with `PLATFORM_ADMIN_EMAIL`, click **New client** (enter their email
to give them a login), open the client, then create an agent, get a number and connect integrations. Everything
below is the same flow through the API, for automation.

All client endpoints take `Authorization: Bearer <client api key>`. You can also use your
`PLATFORM_ADMIN_KEY` plus an `X-Tenant-Id: <id>` header to manage any client.

**1. Create the client account** (you, with the platform key):

```bash
curl -X POST $BASE/platform/tenants -H "Authorization: Bearer $PLATFORM_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Bright Smile Dental","timezone":"America/New_York"}'
# → { tenant: { id }, apiKey }   (the key is shown once)
```

**2. Create an agent.** See `examples/dental-front-desk.json` and every option in `src/agents/config.ts`.

```bash
curl -X POST $BASE/api/agents -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d @examples/dental-front-desk.json
```

Change one section at a time with `PATCH /api/agents/:id` and body `{"config": {"voice": {...}}}`.

**3. Get a phone number**

```bash
curl "$BASE/api/numbers/available?areaCode=415" -H "Authorization: Bearer $KEY"
```

```bash
curl -X POST $BASE/api/numbers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+14155550123","agentId":"agt_..."}'
```

To use a number already in your Twilio account, or one ported in, call `POST /api/numbers/import`. Buying or
importing sets the number's voice, SMS and status webhooks automatically.

**4. Connect a calendar**

* Google: `POST /api/integrations/google/connect` returns a URL. The client opens it and approves, then you put
  the integration id in the agent's `calendar.integrationId`.
* Cal.com:
  ```json
  POST /api/integrations
  {"kind":"calcom","secrets":{"apiKey":"cal_live_..."},"settings":{"eventTypeId":123}}
  ```
  Availability rules live in Cal.com. The agent asks for an email address because Cal.com requires one.

**5. Connect the CRM**

* HubSpot (private app with `crm.objects.contacts.read`/`write` scopes):
  ```json
  {"kind":"hubspot","secrets":{"accessToken":"pat-...","clientSecret":"<app client secret, for webhooks>"},
   "settings":{"callOnCreate":true,"callOnPropertyChange":["lifecyclestage","hs_lead_status"]}}
  ```
* GoHighLevel (sub-account Settings → Private Integrations, scopes `contacts.readonly`, `contacts.write`):
  ```json
  {"kind":"gohighlevel","secrets":{"token":"pit-..."},"settings":{"locationId":"<sub-account id>"}}
  ```
* Everything else, or extra automations:
  ```json
  {"kind":"webhook","settings":{"url":"https://hooks.zapier.com/...","events":["call.completed","appointment.booked"]}}
  ```
  Every event is signed: `X-Signature: sha256=HMAC(signingSecret, body)`. Events: `call.started`,
  `call.completed` (status, outcome, booked, transferred, ended by, summary, score, transcript, recording link),
  `appointment.booked`, `contact.updated`, `transfer.started`, `sms.received`, `sms.sent`.

Put the CRM integration id in the agent's `crm.integrationId`. Use `crm.updatableFields` to list which CRM
fields the agent may write (HubSpot internal property names / GoHighLevel custom field keys).

**6. Have the CRM trigger calls**

`GET /api/tenant` shows the client's webhook URLs and secret.

* **GoHighLevel workflow, HubSpot workflow, Zapier, Make, and others:** use a "Webhook" action that sends
  `POST {BASE}/hooks/{tenantId}/contact?agentId=agt_...` with header `X-Webhook-Secret: <secret>` (or
  `?secret=`). The body can be the CRM's own contact payload. Phone, name, email, id and timezone are picked up
  from common field names automatically. Add `&action=sync` to only save the contact without calling.
* **HubSpot app webhooks** (contact.creation / contact.propertyChange): set the target URL to
  `{BASE}/hooks/{tenantId}/hubspot?integrationId=int_...&agentId=agt_...`. Signatures (v3) are verified with
  the client secret.
* **Directly:**
  ```json
  POST /api/calls
  {"agentId":"...","phone":"+1...","firstName":"Sam","reason":"web lead"}
  ```

**7. Email follow-ups and lead magnets**

```json
{"kind":"email_smtp","settings":{"host":"smtp.sendgrid.net","port":587,"user":"apikey","fromEmail":"hello@client.com","fromName":"Bright Smile Dental"},
 "secrets":{"password":"SG...."}}
```

Then set `followUp.emailIntegrationId`, list files in `followUp.assets` (title, when to offer it, public URL,
attach yes/no), and optionally turn on `followUp.autoAfterCall.sms` / `.email`. During a call the agent offers the
resource ("Want me to email you our new patient guide?"). After the call, the AI writes a follow-up based on what
was said. Check any integration with `POST /api/integrations/:id/test`.

---

## Voices and background sound

* `GET /api/voices`: voices on your ElevenLabs account
* `POST /api/voices/preview` with `{"voice":{"voiceId":"...","stability":0.4,"style":0.2,"speed":1.05},"text":"..."}` returns an MP3
* `POST /api/agents/:id/test-call` with `{"phone":"+1..."}`: the agent calls you right now (ignores calling hours)
* Agent config `voice`: `voiceId`, `model` (`eleven_flash_v2_5` is fastest; slower ElevenLabs models trade speed for expressiveness), `stability` (lower is more expressive), `similarityBoost`, `style`, `speed`
* Agent config `ambience`: `{"preset":"coffee_shop","volume":0.1}` with presets `office`, `call_center`, `coffee_shop`, `none`. Preview with `GET /api/ambience/coffee_shop.wav`.

The built-in ambience presets are synthesised (room tone, distant murmur, keyboard clicks, cups). They're subtle
and need no files. For the most realistic sound, point `ambience.url` at a real room-tone recording: any WAV file
at any sample rate, stereo or mono. Royalty-free cafe and office ambience recordings are easy to find. Keep the
volume around 0.08 to 0.15 so it never competes with the voice.

---

## Data, analytics, recordings and coaching

* `GET /api/calls?agentId=&status=&outcome=&before=`: call log with outcome, booked, transferred, ended by
  (`agent`, `caller`, `transfer`, `system`), duration, summary and review score
* `GET /api/calls/:id`: full detail, including transcript, AI analysis and review, an **event timeline** (queued,
  dialing, ringing, connected, every tool call, barge-ins, booking, transfer result, voicemail, hang-up,
  recording, analysis) and follow-ups sent
* `GET /api/calls/:id/recording`: the MP3
* `GET /api/analytics?days=30&agentId=`: totals, rates (connect, booking, transfer, caller hang-up, success),
  outcome breakdown, average score
* `GET /api/usage?from=&to=`: minutes, calls, SMS and emails per client (for invoicing)
* `GET /api/events?type=transfer.started`: raw events across calls
* `POST /api/agents/:id/insights` with `{"days":14}`: AI coaching report across the period's calls; `GET /api/insights` lists past reports

Outcomes: `appointment_booked`, `transferred`, `interested_follow_up`, `callback_requested`,
`information_provided`, `not_interested`, `do_not_contact`, `wrong_number`, `voicemail`, `caller_hung_up_early`,
`no_conversation`, `other`.

---

## Compliance (read before going live)

Not legal advice, but these matter when you sell outbound AI calling:

* **AI voices count as "artificial voice" under the TCPA** (FCC ruling, Feb 2024). Outbound calls to cell phones need the person's **prior express consent** (written consent for marketing). Only auto-dial leads who opted in, for example through a web form with consent language.
* **Calling hours**: default 9am to 8pm in the contact's local time, Monday to Saturday (`dialer.callingHours`). Some states are stricter.
* **Do-not-call**: when someone asks not to be contacted, the agent marks them and they're never auto-dialed again. Scrub lists against the National DNC Registry as well.
* **Recording consent**: several US states require all parties to consent. The default greetings say "This call may be recorded." Keep that line, or set `behaviour.recordCalls: false`.
* **AI disclosure**: the default greetings say it's a virtual assistant, and the agent always admits being an AI when asked.
* **SMS**: register A2P 10DLC. STOP/START are honoured (Twilio sends the carrier-required replies).

---

## Status: what's tested and what isn't

**Tested here** (`npm test`, 29 passing, plus a scripted browser run through every dashboard page with demo data): config validation; slot finding and calling-hours maths; phone
normalisation; encryption and signed tokens; HubSpot signature checks; the μ-law codec; WAV decoding; ambience
generation; the audio pacing, mixing and interruption logic; and the API end-to-end on an in-memory Postgres.
The end-to-end tests cover:
* client creation and authentication
* agents
* the CRM webhook, including de-duplication
* the inbound call webhook
* logins, roles, protection against cross-site requests, and session invalidation
* a scripted conversation that checks availability, books, updates a CRM field and fires a signed webhook
* rejection of bad tool input
* analytics
* audio previews

**Not yet run against the live services** (no keys in the build environment): real Twilio calls, Deepgram,
ElevenLabs, Claude responses, Google, Cal.com, HubSpot and GoHighLevel. The request shapes come from each
vendor's current docs (Cal.com v2 slots `2024-09-04` and bookings `2026-02-25`; HubSpot CRM v3 with
note-to-contact association `202`; GoHighLevel v2 with `Version: 2021-07-28`). The GoHighLevel duplicate-search
and notes endpoints are the least certain, so check them first with `POST /api/integrations/:id/test`. Before
selling, do one test call per client setup and listen to the recording.

**Known limits / next steps**

* Branding is one look for the whole platform (yours). Per-client branding, custom domains per client, and email invitations (instead of copying a temporary password) are natural next steps.
* The dialer and live calls run in one process. That's fine for dozens of simultaneous calls; for more, run several instances (call claiming is atomic) and add sticky routing for transfer-resume.
* Outlook/Microsoft 365 calendars, Salesforce/Pipedrive native connectors, Stripe billing per minute, A/B testing of prompts and voices, and knowledge-base file uploads are natural additions.
* Latency is roughly 1 to 1.5 s per reply (speech end detection + model + first audio). `LLM_MODEL=claude-haiku-5-5` is the biggest single speed-up; compare quality on real calls.
