// Copy this file to config.js, then add your own Supabase project values.
// Copy your values from Supabase Project Settings → API.
// The publishable/anon key is designed to be used in a browser when Row Level Security is enabled.
// NEVER put a service_role / secret key in this file.

export const SUPABASE_URL = "YOUR_SUPABASE_URL";
export const SUPABASE_PUBLISHABLE_KEY = "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY";

// Users sign in with a username in the UI.
// Internally, the app maps the username to a non-deliverable synthetic email in Supabase Auth.
export const USER_EMAIL_DOMAIN = "flat-trash.invalid";
