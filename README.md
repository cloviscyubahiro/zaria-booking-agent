# Zaria Court booking agent

Watches Zaria Court's schedules on [Ticqet](https://ticqet.rw) around the clock - the **Multi-Purpose Court** and the **5-a-side Pitches A and B** - and keeps the team informed: new bookings, cancellations, a morning update, reminders for the attendants who open the facilities, a notice the day before an event, and one-off schedule changes from the admin (car-free day, Umuganda).

Two ways to run it:

- **Email, free (recommended):** a Google Sheet with a script that runs on Google's servers every 5 minutes. No server, no card, no cost. See [Email alerts, free](#email-alerts-free-google-apps-script).
- **WhatsApp or SMS:** the Node agent below, on an always-on Ubuntu server. These channels cost money and need a registered business for Meta or Pindo.

It reads only the public court schedule (which hours are booked) - never customer names, phone numbers or payments.

## Email alerts, free (Google Apps Script)

Everything lives in one Google Sheet owned by a Google account (best: a Gmail account made for Zaria Court, so alerts come from it and do not depend on one person's account). Emails are sent from that account. A free account can email up to 100 people a day; at Zaria's volume that is about 30-60.

**Build the script** (on the laptop with this repository):

```powershell
npm ci
npm run build:apps-script          # writes apps-script/dist/Code.gs
Get-Content apps-script\dist\Code.gs -Raw | Set-Clipboard    # copies it
```

The build pre-fills the new tabs with the regular clients, the contacts' names and roles (never phone numbers) and any schedule changes from `config/`, so `dist/` stays out of git.

**Install it** (signed in to the Zaria Court Google account):

1. Open [sheets.new](https://sheets.new) and name the sheet *Zaria Court Booking Alerts*.
2. *Extensions > Apps Script*. Delete what is in `Code.gs`, paste (Ctrl+V), save (Ctrl+S).
3. In the toolbar, pick **setup** and press **Run**. Google asks for permission: *Review permissions*, pick the account, then *Advanced > Go to ... (unsafe)* > *Allow*. (Every personal script shows this warning; the script only uses this sheet, Ticqet and email.)
4. Back in the sheet (reload the page): the tabs are there, and a **Zaria Agent** menu.
5. **Contacts** tab: type each person's email in the yellow cells. Tick what each person gets.
6. *Zaria Agent > Send me a test email*. Check the inbox (and Spam).
7. Leave **Settings > Channel** on *Preview* for a while: the **Preview** tab shows every email the agent would send. When it looks right, set Channel to **Email**. Within 5 minutes everyone gets a welcome email.

Ask the team to turn on notifications for that email address, and to mark the first email *Not spam* if it lands there.

| Tab | What it is |
|---|---|
| Status | Last check, whether Ticqet can be read, emails sent and left today, event days ahead, mistakes in the sheet |
| Schedule Changes | One-off changes the admin tells the agent about (see below) |
| Bookings Log | Every booking the agent sees, per facility, with when it was created on Ticqet. Settles "did they book online?" questions |
| Contacts, Regular Clients, Settings, Facilities | What the team edits. Changes apply at the next check |
| Preview | What would have been sent while Channel is *Preview* |

**Facilities:** every facility with *Watch = Yes* and a Ticqet ID is watched (the ID is the code at the end of the facility's link on ticqet.rw). Once a day the agent checks that each ID belongs to the facility named next to it. When a facility is added, its bookings already on Ticqet are noted quietly and everyone gets one email saying it is now covered.

If the sheet has a mistake (say, a mistyped email), the agent keeps using the last good settings, shows the mistake on the Status tab, and emails the admin once.

**Updating the script:** rebuild, open *Extensions > Apps Script*, replace all of `Code.gs` with the new file, save. Nothing else: the tabs, the timer and the agent's memory stay. At its next check the agent adds what an older sheet lacks (new tabs, columns and settings rows, the pitches' Ticqet IDs, the regular clients of a facility that has none yet) without touching what the team typed.

### Schedule changes: car-free day, Umuganda, a team not coming

One row per change on the **Schedule Changes** tab:

| Date | Facility | Client | New time | Reason / message | Email everyone |
|---|---|---|---|---|---|
| 10/10/2026 | | Local Champions | 12:00-14:00 | Car-free day | tick when ready |
| 31/10/2026 | 5-a-side Pitch A | Local Champions | Cancelled | Umuganda | |
| 17/10/2026 | | Local Champions | | Bring your own bibs | |
| 17/10/2026 | 5-a-side Pitch B | | | Closed 2-4 PM for repairs | |

- **New time** like `12:00-14:00` (or `12-2pm`): the client plays then instead of their usual hours. **Cancelled**: they do not play that day. Empty: just a note (with a client) or a notice for everyone (without).
- An empty **Facility** means every facility where the client usually plays that day.
- The agent uses each row straight away: reminders go out for the new hours (none for the usual ones, even if they are still blocked on Ticqet), the daily update explains the change, and the open-slot check does not flag the usual hours.
- Tick **Email everyone** when the row is ready: it is emailed to everyone within 5 minutes (after quiet hours if ticked at night). Edit it later and it is emailed again as an update.
- The **Agent status** column says how the agent understood each row (for example *OK: Local Champions play 12:00-2:00 PM instead of 8:00-10:00 AM, at 5-a-side Pitch A and 5-a-side Pitch B. Emailed to 6 people ...*), or what is wrong with it. A mistake affects only its own row.

**Umuganda** (the last Saturday of each month, 8-11 AM by default, *Settings*): it is shown in the daily update, and three days before, the admin gets a list of the sessions booked during it - so there is time to agree a new time and add a row here.

**Event days:** one Ticqet booking of 6 hours or more (*Settings*) is an event or event setup. The day before, after the morning update, the team and the admin get the facility, the hours and the **teams to call**: everyone else booked at that facility that day, and regular clients whose usual hours the event took.

**How it differs from the server version:** it checks every 5 minutes instead of live, so an alert arrives within about 5 minutes of a booking, and reminders may be up to 10 minutes late. Its memory lives in the script's properties, and the booking log in the sheet.

## What it sends

| Message | When | Who (Contacts sheet column) |
|---|---|---|
| New booking / cancelled / changed | About 1-2 minutes after it happens on Ticqet (within 5 minutes for the email version), naming the facility. Between 11 PM and 6 AM it waits and is added to the morning update. | New booking alerts = Yes |
| Daily update | Every morning at 6:30: each facility's sessions, schedule changes, Umuganda | Daily & weekly updates = Yes |
| Weekly overview | Monday 6:30, instead of that day's daily update | Daily & weekly updates = Yes |
| Reminders | 60 and 15 minutes before every session, Ticqet or regular client. Sessions starting at the same time (say both pitches at 6 PM) share one email | Reminder 1 (60 min) / Reminder 2 (15 min) = Yes; an older "Attendant reminders" column means both |
| Last-minute booking | A booking that starts within the hour: one message instead of the reminders | Either reminder = Yes |
| Event day | The day before an event or setup (one booking of 6+ hours), with the teams to call; also when such a booking is made | New booking alerts = Yes, and Admin alerts = Yes |
| Schedule change | When the admin ticks *Email everyone* on the Schedule Changes tab | Everyone |
| Admin alerts | A booking for part of a regular client's slot, or overlapping it (possible double-booking); regular hours still open on Ticqet (each morning); renewals 3 days before Until dates (one email); sessions booked during Umuganda (3 days before); Ticqet unreadable for 15 min (and when it's back); a mistake in the sheet or a wrong Ticqet ID | Admin alerts = Yes |

Regular clients (booked directly with Zaria) are never announced as new bookings; they appear by name in the updates and reminders. A Ticqet booking that is exactly a regular client's usual hours is Zaria blocking the slot for them, so it is logged without a message.

## Quick start (Ubuntu server)

```bash
# 1. Node.js 24 (skip if `node -v` already shows v22 or newer)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. The code (private repo: Git asks for your GitHub username, then a token as the password)
git clone https://github.com/cloviscyubahiro/zaria-booking-agent.git
cd zaria-booking-agent
npm ci

# 3. Configuration: copy your filled-in setup workbook to config/zaria-setup.xlsx
#    (from your laptop:  scp Zaria_Booking_Agent_Setup.xlsx <user>@<server>:~/zaria-booking-agent/config/zaria-setup.xlsx)
npm run config

# 4. Secrets file (only needed once you switch to WhatsApp or SMS)
cp .env.example .env && chmod 600 .env

# 5. Can it read Ticqet? Prints the next 14 days. Sends nothing.
npm run check

# 6. Try it in preview: nothing is sent, messages go to data/outbox-preview.log
npm start          # Ctrl+C to stop
```

`npm run check` should end with **"Reading works."** and list, for each facility, the bookings you can see on ticqet.rw. Regular clients are marked `R:<name>`, events `E`; regular hours that are *not* blocked on Ticqet are flagged with `!`.

## Run it 24/7

```bash
sed -e "s#__USER__#$USER#" -e "s#__DIR__#$PWD#" -e "s#__NODE__#$(command -v node)#" \
  deploy/zaria-agent.service | sudo tee /etc/systemd/system/zaria-agent.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now zaria-agent
systemctl status zaria-agent --no-pager
```

It restarts on its own after a crash or a reboot. The server's timezone doesn't matter: the agent always works in Kigali time.

## Changing staff, clients or settings

Edit the yellow cells in the setup workbook, copy it to `config/zaria-setup.xlsx` on the server, then:

```bash
npm run config
```

The running agent picks up the change within a minute - no restart. If the workbook has a mistake, nothing is changed and the error names the sheet and row.

To **pause all messages** at any time: set *Channel* to `preview` in the Settings sheet and run `npm run config`.

## Going live

1. **Preview for a day.** Leave the channel on `preview` and compare `data/outbox-preview.log` with Ticqet.
2. **Set up WhatsApp** (next section) and fill in `.env`.
3. **Test one phone:** `npm run send-test -- 07XXXXXXXX` (your own number). It should say `OK` and the message should arrive.
4. **Switch on:** Settings sheet *Channel* = `WhatsApp`, then `npm run config`. Within a minute everyone on the Contacts sheet gets a one-time welcome, and alerts start.

## WhatsApp setup (Meta WhatsApp Cloud API)

**Cost:** WhatsApp is not free for automatic business messages. Since 1 October 2026, Meta charges **$0.004 per message to Rwandan numbers** (utility category). At current booking levels that is roughly 600-850 messages a month: **about $2.50-3.50 a month**. Your WiFi or data bundle doesn't cover this - the messages are sent from the server through Meta.

**You need:** a Facebook account, a payment card for the Meta account, and a phone number for the bot that is **not** already on WhatsApp (a new MTN line is ideal; once registered it can no longer be used in the normal WhatsApp app).

Meta's screens change often, so names may differ slightly.

1. **App:** at [developers.facebook.com](https://developers.facebook.com), *My Apps > Create app*, choose the WhatsApp use case, and connect or create a business portfolio named *Zaria Court*.
2. **Phone number:** in the app, *WhatsApp > API Setup > Add phone number*. Display name *Zaria Court*. Verify with the code sent to the bot SIM.
3. **Payment:** in Meta Business settings, add a payment method to the WhatsApp Business Account.
4. **Template:** in WhatsApp Manager, *Message templates > Create template*:
   - Category: **Utility** · Name: **zaria_court_update** · Language: **English**
   - Body, exactly:
     ```
     Zaria Court update: *{{1}}*
     Details: {{2}}
     This is an automatic message from the Zaria Court booking system.
     ```
   - Sample values: {{1}} `New booking` · {{2}} `Multi-Purpose Court | Thu 1 Oct, 5:00-7:00 PM (2 hrs)`
   - Submit. Approval usually takes minutes, sometimes up to a day.
5. **Phone number ID:** on *WhatsApp > API Setup*, copy the *Phone number ID* of the new number into `.env` as `WHATSAPP_PHONE_NUMBER_ID`.
6. **Template name:** keep `WHATSAPP_TEMPLATE_NAME=zaria_court_update` and `WHATSAPP_TEMPLATE_LANG=en` in `.env` (change them only if you named the template differently).
7. **Permanent token:** the token on the API Setup page expires after 24 hours. Instead: *Business settings > Users > System users > Add* (Admin), assign the app and the WhatsApp account, then *Generate token* with `whatsapp_business_messaging` and `whatsapp_business_management`. Put it in `.env` as `WHATSAPP_TOKEN`.

On a phone, an alert looks like this:

> Zaria Court update: **New booking**
> Details: Multi-Purpose Court | Thu 1 Oct, 5:00-7:00 PM (2 hrs)
> This is an automatic message from the Zaria Court booking system.

*Optional free trial:* the API Setup page also offers a Meta **test number** that can message up to 5 numbers you verify, free. It needs the same template created in its test account.

## SMS setup (Pindo) - alternative

About $0.011 per SMS in Rwanda (about $7-10 a month at current levels). Create an account at [pindo.io](https://pindo.io), top up, and copy your API token (*Profile > Security*) into `.env` as `PINDO_TOKEN`. Ask Pindo to approve the sender name `ZariaCourt`; until it's approved, put `PindoTest` in the Settings sheet's *SMS sender name*. Then set *Channel* = `SMS`.

## Day to day

```bash
journalctl -u zaria-agent -n 50 --no-pager     # recent activity
tail -f data/agent.log                          # same, from the agent's own log
sudo systemctl restart zaria-agent              # restart
git pull && npm ci && sudo systemctl restart zaria-agent   # update to the latest code
```

Every hour the log shows a status line, e.g. `watching 60 days (60 loaded), Ticqet last answered 4s ago, 23 messages sent today, 0 held`.

**Settling "did they book?" questions:** every booking the agent sees is recorded, with the time it appeared, in `data/bookings-log.jsonl`:

```bash
grep "Monday 05 October 2026" data/bookings-log.jsonl
```

## How it works

- **Live connection to Ticqet.** Ticqet runs on Google Firebase. The agent listens to the court's schedule for the next 60 days the same way the Ticqet website does, so changes arrive within seconds and Ticqet's servers are barely loaded. Every 5 minutes it double-checks the connection against the server.
- **No false alarms.** It waits 60 seconds after a change before alerting (Ticqet sometimes rewrites a booking record), records existing bookings silently when it first sees a date, and ignores data shown while offline - so a network drop can never look like "all bookings cancelled".
- **Safety limits.** If many bookings vanish at once, only the admin is told (more likely a Ticqet glitch than real cancellations). Many new bookings at once become one summary. A daily message cap (300 on the server, 90 for the email version) stops runaway costs; booking alerts pause first, a third of the way before it, so reminders and updates still go out. If Ticqet can't be read for 15 minutes, the admin is told.
- **Remembers across restarts** in `data/`: what it has seen and sent, and alerts held overnight.

| Folder | Contents |
|---|---|
| `src/` | The agent: `ticqet.js` (reading Ticqet), `engine.js` (decisions), `regulars.js` (regular clients and sessions), `changes.js` (the Schedule Changes tab), `facilities.js`, `formatter.js` (all message wording), `email.js` (email layout), `workbook.js` (reading the setup sheet), `senders/` (WhatsApp, SMS, preview) |
| `apps-script/` | The free Google version: `src/` (reading Ticqet over HTTPS, the sheet and its upgrades, Gmail) and `build.mjs`, which bundles it with `src/` into one `Code.gs` |
| `tools/` | `npm run config` (workbook to config) and `npm run send-test` |
| `config/` | `*.example.*` files are committed; your real workbook and JSON files (including `schedule-changes.json`) stay on the server only |
| `test/` | 122 offline tests, including the Google version run against fake Google services and the upgrade of an existing sheet: `npm test` |

## Troubleshooting

| You see | Do this |
|---|---|
| `npm run check` shows `COULD NOT READ` | Check the server's internet. If it persists, Ticqet may have changed its system: the admin alert will say so too. |
| `Meta error 190` | The WhatsApp token expired. Use a permanent System User token (step 7). |
| `Meta error 131030` | That number isn't on the test number's allowed list - add it, or use the real business number. |
| `Meta error 132001` | Template not found or not approved: check its name, language and status in WhatsApp Manager. |
| `Meta error 131042` | Payment problem: add or fix the payment method (step 3). |
| `Settings problem: ...` / `Regular Clients row 8: ...` | Fix that cell in the workbook and run `npm run config` again. |
| No admin alerts arrive | The admin number is empty on the Contacts sheet. |

## Notes and limits

- **Facilities:** the Multi-Purpose Court and 5-a-side Pitches A and B are on the Facilities sheet. The server version watches the facilities it started with; restart it after changing them.
- **A booking in part of a regular client's slot** looks the same on Ticqet whether Zaria blocked it for the client or a customer booked it, so the agent asks the admin to check rather than guessing. A booking of exactly the client's hours is taken as Zaria's block.
- **Event days** are recognised by length (one booking of 6+ hours), because Ticqet does not say what a booking is for.
- **Delivery:** the agent knows Meta (or Pindo) accepted each message, not that the phone received it.
- **Messages are in English.**
- The agent reads only Ticqet's public schedule. It's still good practice to let Ticqet know it is running, so they can warn you before changing their system.
