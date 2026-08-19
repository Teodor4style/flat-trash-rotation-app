// Copy this file to config.js, then add your own Supabase project values.
// Copy the Supabase values from Project Settings → API.
//
// The publishable/anon key and VAPID PUBLIC key are intentionally usable
// in a browser. Row Level Security must remain enabled in Supabase.
//
// NEVER put a service_role/secret key, VAPID PRIVATE key, webhook secret,
// database password, or any other private credential in this file.

export const SUPABASE_URL = "YOUR_SUPABASE_URL";
export const SUPABASE_PUBLISHABLE_KEY = "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY";

// Users sign in with a username in the UI.
// Internally, the app maps the username to a synthetic email in Supabase Auth.
export const USER_EMAIL_DOMAIN = "flat-trash.invalid";

// Use the same VAPID public key configured for the send-push-notifications
// Edge Function. The VAPID private key must stay server-side in Supabase.
export const VAPID_PUBLIC_KEY = "YOUR_VAPID_PUBLIC_KEY";
