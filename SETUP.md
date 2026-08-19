# Flat Trash — Setup Guide

This guide creates a fresh instance of Flat Trash with realtime data, browser push notifications, vacation handling, and recurring 8-hour trash reminders.

## 1. Create a Supabase project

Create a Supabase project. You will need the project URL and a publishable key (or legacy anon key) for the browser app.

**Never put a Supabase secret/service-role key in the frontend.**

## 2. Create the three Auth users

In **Supabase Dashboard → Authentication → Users**, create:

| Person | Internal Auth email | App role |
|---|---|---|
| Theodoros | `theodoros@flat-trash.invalid` | Admin |
| Prionto | `prionto@flat-trash.invalid` | Member |
| Camila | `camila@flat-trash.invalid` | Member |

Choose a temporary password for each account and make sure the users are confirmed/active.

The synthetic email addresses are internal identifiers. The UI asks users only for the usernames `theodoros`, `prionto`, or `camila`.

## 3. Create the base database

Open **SQL Editor** in Supabase and run the complete contents of:

```text
supabase/schema.sql
```

This creates the household profiles, trash categories, activity history, rotation functions, Row Level Security, grants, and realtime publication.

## 4. Enable Supabase Cron

Before installing the recurring-reminder migration, enable the **Cron / pg_cron** Postgres module in your Supabase project (Dashboard → Integrations → Cron).

The reminder migration detects whether the `cron` schema exists. If Cron is already enabled, it creates the checker job automatically.

## 5. Run the migrations in order

Run these files in the Supabase SQL Editor, in filename order:

```text
supabase/migrations/20260818_add_notifications.sql
supabase/migrations/20260819_add_recurring_trash_reminders.sql
```

The first migration adds notifications and Web Push subscriptions.

The second migration adds:

- `needs_taking_since`
- `next_reminder_at`
- the final `set_trash_status` reminder scheduling logic
- reminder cancellation in `take_out_trash`
- `process_due_trash_reminders()`
- the `trash_reminder` notification type
- the recurring Cron checker (when Cron is already enabled)

### If you enabled Cron after running the migration

Run this once in SQL Editor:

```sql
select cron.schedule(
  'process-due-trash-reminders',
  '*/5 * * * *',
  $$select public.process_due_trash_reminders();$$
);
```

The checker runs every five minutes, but it creates a reminder only when a row's `next_reminder_at` timestamp is due. A new reminder then schedules the next one for approximately eight hours later.

## 6. Generate a VAPID key pair

If Node.js is installed, one simple method is:

```bash
npx --yes web-push generate-vapid-keys --json
```

This prints a `publicKey` and `privateKey`.

- The **public key** is used by both the browser app and the push Edge Function.
- The **private key** must remain secret and must never be committed to GitHub.

## 7. Deploy `admin-reset-password`

Source file:

```text
supabase/functions/admin-reset-password/index.ts
```

Deploy it as an Edge Function named exactly:

```text
admin-reset-password
```

The function performs its own caller/admin validation. Configure its JWT verification to match the function's current deployment requirements.

With the Supabase CLI, from the project root:

```bash
supabase functions deploy admin-reset-password
```

## 8. Configure push secrets

In **Supabase Dashboard → Edge Functions → Secrets**, create:

```text
VAPID_PUBLIC_KEY=<your generated public key>
VAPID_PRIVATE_KEY=<your generated private key>
VAPID_SUBJECT=<your deployed site origin, e.g. https://example.com>
NOTIFICATION_WEBHOOK_SECRET=<a long random secret you generate>
```

`send-push-notifications` also uses the server-side Supabase secret credentials provided to hosted Edge Functions. Do not copy those credentials into the browser application.

## 9. Deploy `send-push-notifications`

Source file:

```text
supabase/functions/send-push-notifications/index.ts
```

Deploy it with the exact name:

```text
send-push-notifications
```

The function is intended to receive a Database Webhook and authenticates that webhook with the custom `x-webhook-secret` header, so the platform JWT check must not block the webhook before the function code can validate it.

With the Supabase CLI, this is typically deployed with JWT verification disabled for this webhook receiver:

```bash
supabase functions deploy send-push-notifications --no-verify-jwt
```

## 10. Create the Database Webhook

Create a Supabase Database Webhook with these settings:

```text
Name: send_push_notifications
Table: public.notifications
Event: INSERT
Method: POST
URL: https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/send-push-notifications
```

Add this HTTP header:

```text
x-webhook-secret: <the exact same value stored as NOTIFICATION_WEBHOOK_SECRET>
```

Do not put the secret in HTTP parameters or commit it to the repository.

Each inserted notification can now trigger the Edge Function, which loads the recipient's registered push subscriptions and sends the Web Push message.

## 11. Configure the browser app

Copy:

```text
config.example.js
```

to:

```text
config.js
```

Then fill in:

```js
export const SUPABASE_URL = "YOUR_SUPABASE_URL";
export const SUPABASE_PUBLISHABLE_KEY = "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY";
export const USER_EMAIL_DOMAIN = "flat-trash.invalid";
export const VAPID_PUBLIC_KEY = "YOUR_VAPID_PUBLIC_KEY";
```

The VAPID public key must be the same public key configured in the Edge Function secrets.

`config.js` is intentionally ignored by Git. Never add a service-role/secret key, VAPID private key, or webhook secret to it.

## 12. Test locally

From the project folder:

```bash
python -m http.server 8080
```

Open:

```text
http://localhost:8080
```

Sign in with one of the configured usernames and its password.

For full production PWA/Web Push behaviour, deploy the app over HTTPS.

## 13. Test notifications

A useful end-to-end test is:

1. Sign in on a supported browser/device.
2. Open the **Notifications** tab and enable notifications for that device.
3. Change a trash category to **Needs taking** while it is that user's turn.
4. Confirm the immediate notification appears in the app and as a push notification.
5. In SQL Editor, verify the row has `needs_taking_since` and `next_reminder_at` populated.
6. For a controlled reminder test, temporarily make a `next_reminder_at` value due and run:

```sql
select public.process_due_trash_reminders();
```

7. Confirm a `trash_reminder` notification is created and `next_reminder_at` moves about eight hours forward.
8. Press **Mark as taken** and verify both reminder timestamps become `NULL`.

Do not leave test timestamps modified after testing.

## 14. Test realtime and vacation handling

Open the app in two browsers/devices with different users.

- Status changes should appear without a manual reload.
- A user marked away should be skipped for pending/new turns according to the database rotation logic.
- Reassignments and household notification records are stored in the shared Supabase backend.

## 15. Deploy the PWA

Host the static frontend on an HTTPS host such as Netlify, Cloudflare Pages, or GitHub Pages.

The deployed site needs a correctly configured `config.js`, but that file must contain only browser-safe values:

- Supabase project URL
- Supabase publishable/anon key
- username email domain
- VAPID public key

Never deploy the VAPID private key, webhook secret, or Supabase server secret in frontend files.

## Data model additions for notifications

### `notifications`

Stores user-facing notification records, delivery status, and read state.

### `push_subscriptions`

Stores the browser Push API subscription for each registered user/device.

### `trash_types.needs_taking_since`

Tracks when the current **Needs taking** period began so reminder text can report 8, 16, 24 hours, and so on.

### `trash_types.next_reminder_at`

Tracks when the next recurring reminder becomes due. Marking the trash as taken clears this value and stops further reminders.

## Security checklist

- Do not commit `config.js`.
- Do not commit `.env` files.
- Do not commit Supabase secret/service-role keys.
- Do not commit `VAPID_PRIVATE_KEY`.
- Do not commit `NOTIFICATION_WEBHOOK_SECRET`.
- Keep Row Level Security enabled.
- Keep the webhook secret identical in Supabase Secrets and the webhook's `x-webhook-secret` header.
