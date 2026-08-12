// supabase/functions/admin-reset-password/index.ts
// Secure server-side function: only the household admin may reset another member's password.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ ok: false, error: "Missing authorization." }, 401);
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}").default;

    const serviceRole =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default;

    if (!url || !anonKey || !serviceRole) {
      return json({ ok: false, error: "Function secrets are not configured." }, 500);
    }

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false }
    });

    const adminClient = createClient(url, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) {
      return json({ ok: false, error: "Invalid session." }, 401);
    }

    const callerId = userData.user.id;

    const { data: callerProfile, error: profileError } = await adminClient
      .from("profiles")
      .select("role,display_name")
      .eq("id", callerId)
      .single();

    if (profileError || callerProfile?.role !== "admin") {
      return json({ ok: false, error: "Administrator access required." }, 403);
    }

    const { targetUserId, newPassword } = await req.json();

    if (!targetUserId || typeof newPassword !== "string" || newPassword.length < 8) {
      return json({ ok: false, error: "Use a password of at least 8 characters." }, 400);
    }

    if (targetUserId === callerId) {
      return json({ ok: false, error: "Use My Account to change your own password." }, 400);
    }

    const { data: targetProfile, error: targetError } = await adminClient
      .from("profiles")
      .select("display_name")
      .eq("id", targetUserId)
      .single();

    if (targetError || !targetProfile) {
      return json({ ok: false, error: "Member not found." }, 404);
    }

    const { error: resetError } = await adminClient.auth.admin.updateUserById(
      targetUserId,
      { password: newPassword }
    );

    if (resetError) {
      return json({ ok: false, error: resetError.message }, 400);
    }

    await adminClient.from("activity_log").insert({
      type: "password_reset",
      actor_id: callerId,
      target_person_id: targetUserId,
      summary: `${callerProfile.display_name} reset ${targetProfile.display_name}'s password`
    });

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: "Unexpected server error." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
