# Flat Trash — Setup Guide

This guide creates an independent, shared instance of Flat Trash.

## What this version includes

- Shared Supabase database
- Realtime syncing between phones
- Username + password login
- Theodoros = Administrator
- Prionto / Camila = Members
- Three trash states: OK / Getting full / Needs taking
- Voluntary trash action stored separately in History
- Home / Away vacation handling
- Admin can see usernames and reset another member's password
- Existing passwords are never readable
- Each user can change their own password
- Row Level Security + controlled database functions

---

## 1. Create a Supabase project

Create a free Supabase project.

You will later need:

- Project URL
- Publishable key (or legacy anon key)

Do **not** put the `service_role` / secret key in the browser app.

---

## 2. Create the three Auth users

In Supabase Dashboard → Authentication → Users, create these users:

| Person | Internal Auth email | Role in app |
|---|---|---|
| Theodoros | `theodoros@flat-trash.invalid` | Admin |
| Prionto | `prionto@flat-trash.invalid` | Member |
| Camila | `camila@flat-trash.invalid` | Member |

Choose a temporary password for each one.

These addresses are only internal identifiers so the app can offer a username-only login screen.
The users will type only:

- `theodoros`
- `prionto`
- `camila`

Make sure the users are confirmed/active in Supabase Auth.

---

## 3. Create the database

Open:

Supabase Dashboard → SQL Editor

Copy the entire contents of:

`supabase/schema.sql`

and run it.

The script creates:

- `profiles`
- `trash_types`
- `activity_log`
- Row Level Security
- rotation logic
- status-change logic
- vacation logic
- realtime publication
- the six trash categories

Initial rotation:

Theodoros → Prionto → Camila

---

## 4. Deploy the secure admin password-reset function

The function is here:

`supabase/functions/admin-reset-password/index.ts`

### Option A — Supabase Dashboard

1. Open **Edge Functions** in the Supabase Dashboard.
2. Select **Deploy a new function → Via Editor**.
3. Replace the example code with `supabase/functions/admin-reset-password/index.ts`.
4. Name the function exactly `admin-reset-password` and deploy it.
5. In the function settings, turn **Verify JWT with legacy secret** off. The function validates the caller's current session and administrator role itself.

### Option B — Supabase CLI

Install/login to the Supabase CLI, link this project, then from the Phase 2 folder run:

```bash
supabase functions deploy admin-reset-password
```

Supabase hosted Edge Functions provide the project secrets needed by the function.
The secret/service-role credential stays server-side and is never sent to the browser.

---

## 5. Configure the web app

Copy `config.example.js` to a new local file named `config.js`.

Open `config.js`.

Replace:

```js
export const SUPABASE_URL = "YOUR_SUPABASE_URL";
export const SUPABASE_PUBLISHABLE_KEY = "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY";
```

with the values from:

Supabase Dashboard → Project Settings → API

A publishable/anon key is intentionally usable from a browser when Row Level Security is correctly configured.

Never paste a Supabase secret/service-role key into `config.js`.

---

## 6. Test locally

Open a terminal inside the Phase 2 folder and run:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Sign in as one of:

```text
theodoros
prionto
camila
```

using the password assigned to that account.

---

## 7. Test realtime syncing

Open the app in two browsers/devices.

Example:

1. Sign in as Theodoros in one browser.
2. Sign in as Camila in another.
3. Camila marks Plastic as "Needs taking".
4. Theodoros should see that change without manually copying files.
5. If it is Prionto's turn and Theodoros presses "I'll take it instead", History stores:
   - expected person = Prionto
   - actual person = Theodoros
   - voluntary = true

---

## 8. Admin behavior

When Theodoros signs in, an **Admin** tab appears.

Theodoros can:

- see everyone's username
- change anyone's availability
- reset Prionto's or Camila's password to a new temporary password

Theodoros cannot see an existing password. This is intentional security behavior.

Prionto and Camila do not see the Admin tab.

---

## 9. Put it online for Android and iPhone

The frontend is a static Progressive Web App. You can host it on a static host such as GitHub Pages, Netlify, or Cloudflare Pages. Ensure the deployed site includes a configured `config.js`, but never include a secret or `service_role` key.

After it is hosted over HTTPS:

- Android users can add/install the web app from Chrome.
- iPhone users can add it to the Home Screen from Safari.

All three phones connect to the same Supabase backend.

---

## Data model

### `profiles`

Stores:

- username
- display name
- admin/member role
- Home/Away
- away-until date
- rotation position

### `trash_types`

Stores:

- trash name
- status
- next person
- last person
- last date/time

### `activity_log`

Stores:

- status changes
- normal trash completion
- voluntary substitution
- vacation changes
- admin password resets

No plaintext passwords are stored in these tables.
