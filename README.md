# Zaria Court booking agent

Watches Zaria Court's **Multi-Purpose Court** schedule on [Ticqet](https://ticqet.rw) around the clock and keeps the team informed on **WhatsApp** (or SMS): new bookings, cancellations, a morning update, and reminders for the attendants who open the court.

It reads only the public court schedule (which hours are booked) - never customer names, phone numbers or payments.

## What it sends

| Message | When | Who (Contacts sheet column) |
|---|---|---|
| New booking / cancelled / changed | About 1-2 minutes after it happens on Ticqet. Between 11 PM and 6 AM it waits and is added to the morning update. | New booking alerts = Yes |
| Daily update | Every morning at 6:30 | Daily & weekly updates = Yes |
| Weekly overview | Monday 6:30, instead of that day's daily update | Daily & weekly updates = Yes |
| Reminders | 60 and 15 minutes before every session, Ticqet or regular client | Attendant reminders = Yes |
| Last-minute booking | A booking that starts within the hour: attendants get one message instead of two reminders | Attendant reminders = Yes |
| Admin alerts | A booking landing in a regular client's slot (possible double-booking); regular hours still open on Ticqet (each morning); renewal 3 days before a client's Until date; Ticqet unreadable for 15 min (and when it's back); anything unusual | Admin alerts = Yes |

Regular clients (booked directly with Zaria) are never announced as new bookings; they appear by name in the updates and reminders.

## Quick start (Ubuntu server)

```bash
# 1. Node.js 22 (skip if `node -v` already shows v20 or newer)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. The code
git clone git@github.com:<your-github-user>/zaria-booking-agent.git
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

`npm run check` should end with **"Reading works."** and list the bookings you can see on ticqet.rw. Regular clients are marked `R:<name>`; regular hours that are *not* blocked on Ticqet are flagged with `!`.

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
- **Safety limits.** If many bookings vanish at once, only the admin is told (more likely a Ticqet glitch than real cancellations). Many new bookings at once become one summary. A daily message cap (300) stops runaway costs. If Ticqet can't be read for 15 minutes, the admin is told.
- **Remembers across restarts** in `data/`: what it has seen and sent, and alerts held overnight.

| Folder | Contents |
|---|---|
| `src/` | The agent: `ticqet.js` (reading Ticqet), `engine.js` (decisions), `formatter.js` (all message wording), `senders/` (WhatsApp, SMS, preview) |
| `tools/` | `npm run config` (workbook to config) and `npm run send-test` |
| `config/` | `*.example.*` files are committed; your real workbook and JSON files stay on the server only |
| `test/` | 69 offline tests: `npm test` |

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

- **One facility for now.** Only the Multi-Purpose Court is watched. When the 5-a-side pitches reopen, their Ticqet IDs go on the Facilities sheet; watching several facilities at once needs a small code change.
- **A booking in a regular client's slot** looks the same on Ticqet whether Zaria blocked it for the client or a customer booked it, so the agent asks the admin to check rather than guessing.
- **Delivery:** the agent knows Meta (or Pindo) accepted each message, not that the phone received it.
- **Messages are in English.**
- The agent reads only Ticqet's public schedule. It's still good practice to let Ticqet know it is running, so they can warn you before changing their system.
