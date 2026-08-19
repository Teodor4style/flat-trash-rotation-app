import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// Deno supports the Node-compatible web-push package.
// @ts-ignore: web-push is a CommonJS package.
import webpush from "npm:web-push@3.6.7";

interface WebhookPayload {
  type: string;
  table: string;
  schema: string;
  record?: {
    id?: number;
  };
}

interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function requiredSecret(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required secret: ${name}`);
  }

  return value;
}

function getSupabaseSecretKey(): string {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (legacyKey) {
    return legacyKey;
  }

  const keys = JSON.parse(
    Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}",
  );

  if (!keys.default) {
    throw new Error("Supabase secret key is unavailable.");
  }

  return keys.default;
}

const supabaseUrl = requiredSecret("SUPABASE_URL");
const supabaseSecretKey = getSupabaseSecretKey();

const webhookSecret = requiredSecret(
  "NOTIFICATION_WEBHOOK_SECRET",
);

const vapidPublicKey = requiredSecret("VAPID_PUBLIC_KEY");
const vapidPrivateKey = requiredSecret("VAPID_PRIVATE_KEY");
const vapidSubject = requiredSecret("VAPID_SUBJECT");

webpush.setVapidDetails(
  vapidSubject,
  vapidPublicKey,
  vapidPrivateKey,
);

const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseSecretKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method not allowed." },
      { status: 405 },
    );
  }

  const suppliedSecret = req.headers.get(
    "x-webhook-secret",
  );

  if (suppliedSecret !== webhookSecret) {
    return Response.json(
      { ok: false, error: "Unauthorized." },
      { status: 401 },
    );
  }

  try {
    const payload = await req.json() as WebhookPayload;
    const notificationId = payload.record?.id;

    if (
      payload.type !== "INSERT" ||
      payload.schema !== "public" ||
      payload.table !== "notifications" ||
      !notificationId
    ) {
      return Response.json(
        { ok: false, error: "Invalid webhook payload." },
        { status: 400 },
      );
    }

    const { data: notification, error: notificationError } =
      await supabaseAdmin
        .from("notifications")
        .select(`
          id,
          recipient_id,
          title,
          body,
          url,
          push_processed_at,
          push_attempts
        `)
        .eq("id", notificationId)
        .single();

    if (notificationError || !notification) {
      throw new Error(
        notificationError?.message ??
          "Notification was not found.",
      );
    }

    // Prevent duplicate delivery if the webhook is retried.
    if (notification.push_processed_at) {
      return Response.json({
        ok: true,
        ignored: true,
        reason: "Notification already processed.",
      });
    }

    const { data: subscriptions, error: subscriptionsError } =
      await supabaseAdmin
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth")
        .eq("user_id", notification.recipient_id);

    if (subscriptionsError) {
      throw new Error(subscriptionsError.message);
    }

    const pushPayload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      url: notification.url || "/",
      icon:
        "https://flat-trash-kufstein.netlify.app/icon-192.svg",
      badge:
        "https://flat-trash-kufstein.netlify.app/icon-192.svg",
    });

    let sent = 0;
    let expired = 0;
    const errors: string[] = [];

    for (
      const subscription of
        (subscriptions ?? []) as PushSubscriptionRow[]
    ) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          pushPayload,
          {
            TTL: 60 * 60,
            urgency: "high",
          },
        );

        sent += 1;
      } catch (unknownError) {
        const pushError = unknownError as {
          statusCode?: number;
          message?: string;
          body?: string;
        };

        // A 404 or 410 means this browser subscription expired.
        if (
          pushError.statusCode === 404 ||
          pushError.statusCode === 410
        ) {
          await supabaseAdmin
            .from("push_subscriptions")
            .delete()
            .eq("id", subscription.id);

          expired += 1;
        } else {
          errors.push(
            pushError.message ||
              pushError.body ||
              "Unknown Web Push error.",
          );
        }
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from("notifications")
      .update({
        push_processed_at: new Date().toISOString(),
        push_attempts:
          (notification.push_attempts ?? 0) + 1,
        last_push_error:
          errors.length > 0
            ? errors.join(" | ").slice(0, 2000)
            : null,
      })
      .eq("id", notification.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return Response.json({
      ok: errors.length === 0,
      sent,
      expired,
      failed: errors.length,
    });
  } catch (unknownError) {
    const error = unknownError as Error;
    console.error(error);

    return Response.json(
      {
        ok: false,
        error: error.message || "Unexpected server error.",
      },
      { status: 500 },
    );
  }
});