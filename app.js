import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  USER_EMAIL_DOMAIN,
  VAPID_PUBLIC_KEY
} from "./config.js";


if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(err => console.warn("Service worker registration failed", err));
}

const configured =
  SUPABASE_URL &&
  SUPABASE_PUBLISHABLE_KEY &&
  !SUPABASE_URL.includes("YOUR_") &&
  !SUPABASE_PUBLISHABLE_KEY.includes("YOUR_");

const configScreen = document.getElementById("configScreen");
const authScreen = document.getElementById("authScreen");
const appShell = document.getElementById("appShell");

if (!configured) {
  configScreen.classList.remove("hidden");
} else {
  startApp();
}

async function startApp() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  let me = null;
  let profiles = [];
  let trash = [];
  let history = [];
  let notifications = [];
  let activeTrashId = null;
  let voluntaryTrashId = null;
  let subscriptions = [];

  const loginForm = document.getElementById("loginForm");
  const loginError = document.getElementById("loginError");
  const toast = document.getElementById("toast");

  function usernameToEmail(username) {
    const normalized = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    return `${normalized}@${USER_EMAIL_DOMAIN}`;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), 2600);
  }

  function fmtDate(value) {
    if (!value) return "Never";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  }

  function statusLabel(status) {
    return {
      ok: "🟢 OK",
      getting_full: "🟡 Getting full",
      needs_taking: "🔴 Needs taking"
    }[status] || status;
  }

  function personName(id) {
    return profiles.find(p => p.id === id)?.display_name || "Unknown";
  }

  function isEffectivelyAway(profile) {
    if (profile.availability !== "away") return false;
    if (!profile.away_until) return true;
    const end = new Date(profile.away_until + "T23:59:59");
    return end >= new Date();
  }
  function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rawData = window.atob(base64);

  return Uint8Array.from(
    [...rawData].map(character => character.charCodeAt(0))
  );
}

function isIosDevice() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (
      navigator.platform === "MacIntel" &&
      navigator.maxTouchPoints > 1
    )
  );
}

function isRunningStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

async function getCurrentPushSubscription() {
  if (!("serviceWorker" in navigator)) return null;

  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function updateNotificationControls() {
  const status = document.getElementById("notificationStatus");
  const help = document.getElementById("notificationHelp");
  const button = document.getElementById("notificationToggleBtn");

  status.classList.remove(
    "notification-status-enabled",
    "notification-status-disabled"
  );

  help.textContent = "";
  button.disabled = false;

  if (isIosDevice() && !isRunningStandalone()) {
    status.textContent = "Install Flat Trash to enable notifications.";
    status.classList.add("notification-status-disabled");
    help.textContent =
      "On iPhone or iPad, use Share → Add to Home Screen, then open Flat Trash from its Home Screen icon.";
    button.textContent = "Installation required";
    button.disabled = true;
    return;
  }

  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    status.textContent =
      "Push notifications are not supported by this browser.";
    status.classList.add("notification-status-disabled");
    button.textContent = "Unavailable";
    button.disabled = true;
    return;
  }

  if (Notification.permission === "denied") {
    status.textContent = "Notifications are blocked in browser settings.";
    status.classList.add("notification-status-disabled");
    help.textContent =
      "Allow notifications for Flat Trash in your browser or device settings.";
    button.textContent = "Notifications blocked";
    button.disabled = true;
    return;
  }

  try {
    const subscription = await getCurrentPushSubscription();

    if (subscription) {
      status.textContent = "Notifications are enabled on this device.";
      status.classList.add("notification-status-enabled");
      button.textContent = "Disable notifications";
      button.classList.remove("primary");
      button.classList.add("secondary");
    } else {
      status.textContent = "Notifications are disabled on this device.";
      status.classList.add("notification-status-disabled");
      button.textContent = "Enable notifications";
      button.classList.remove("secondary");
      button.classList.add("primary");
    }
  } catch (error) {
    console.error(error);
    status.textContent = "Could not check the notification status.";
    status.classList.add("notification-status-disabled");
    button.textContent = "Try again";
  }
}

async function enablePushNotifications() {
  let subscription = null;

  try {
    if (
      !VAPID_PUBLIC_KEY ||
      VAPID_PUBLIC_KEY.includes("YOUR_")
    ) {
      throw new Error("The VAPID public key is not configured.");
    }

    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      showToast("Notification permission was not granted.");
      await updateNotificationControls();
      return;
    }

    const registration = await navigator.serviceWorker.ready;

    subscription =
      await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey:
          urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }

    const subscriptionData = subscription.toJSON();
    const p256dh = subscriptionData.keys?.p256dh;
    const auth = subscriptionData.keys?.auth;

    if (!p256dh || !auth) {
      throw new Error(
        "The browser did not return the push encryption keys."
      );
    }

    const { error } = await supabase.rpc(
      "register_push_subscription",
      {
        p_endpoint: subscription.endpoint,
        p_p256dh: p256dh,
        p_auth: auth,
        p_user_agent: navigator.userAgent
      }
    );

    if (error) {
      await subscription.unsubscribe();
      throw error;
    }

    showToast("Notifications enabled on this device.");
    await updateNotificationControls();
  } catch (error) {
    console.error(error);
    showToast("Could not enable notifications.");
    await updateNotificationControls();
  }
}

async function disablePushNotifications() {
  try {
    const subscription = await getCurrentPushSubscription();

    if (!subscription) {
      await updateNotificationControls();
      return;
    }

    const endpoint = subscription.endpoint;

    const { error } = await supabase.rpc(
      "unregister_push_subscription",
      {
        p_endpoint: endpoint
      }
    );

    if (error) throw error;

    const unsubscribed = await subscription.unsubscribe();

    if (!unsubscribed) {
      throw new Error(
        "The browser could not remove the push subscription."
      );
    }

    showToast("Notifications disabled on this device.");
    await updateNotificationControls();
  } catch (error) {
    console.error(error);
    showToast("Could not disable notifications.");
    await updateNotificationControls();
  }
}

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (error) throw error;
    return data;
  }

  async function loadAllData() {
  const [p, t, h, n] = await Promise.all([
    supabase.from("profiles").select("*").order("rotation_position"),
    supabase.from("trash_types").select("*").order("sort_order"),
    supabase
      .from("activity_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100)
  ]);

  if (p.error) throw p.error;
  if (t.error) throw t.error;
  if (h.error) throw h.error;
  if (n.error) throw n.error;

  profiles = p.data || [];
  trash = t.data || [];
  history = h.data || [];
  notifications = n.data || [];
}

  async function refresh() {
    try {
      me = await loadProfile();
      if (!me) return showAuth();
      await loadAllData();
      render();
    } catch (err) {
      console.error(err);
      showToast("Could not refresh data.");
    }
  }

  function showAuth() {
    me = null;
    appShell.classList.add("hidden");
    authScreen.classList.remove("hidden");
  }

  function showApp() {
    authScreen.classList.add("hidden");
    appShell.classList.remove("hidden");
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.textContent = "";

    const username = document.getElementById("loginUsername").value;
    const password = document.getElementById("loginPassword").value;

    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password
    });

    if (error) {
      loginError.textContent = "Incorrect username or password.";
      return;
    }

    await refresh();
    subscribeRealtime();
    showApp();
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    subscriptions.forEach(ch => supabase.removeChannel(ch));
    subscriptions = [];
    await supabase.auth.signOut();
    showAuth();
  });

  function subscribeRealtime() {
  subscriptions.forEach(ch => supabase.removeChannel(ch));
  subscriptions = [];

  const channel = supabase
    .channel("flat-trash-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "trash_types" },
      refresh
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "profiles" },
      refresh
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "activity_log" },
      refresh
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "notifications" },
      refresh
    )
    .subscribe();

  subscriptions.push(channel);
}

  function render() {
    showApp();

    document.getElementById("welcomeText").textContent =
      `${me.display_name} · ${me.role === "admin" ? "Administrator" : "Member"}`;

    document.querySelectorAll(".admin-only").forEach(el =>
      el.classList.toggle("hidden", me.role !== "admin")
    );

    renderTrash();
    renderHistory();
    renderNotifications();
    updateNotificationControls();
    renderPeople();
    renderAdmin();
    renderAccount();
  }
  function renderNotifications() {
  const list = document.getElementById("notificationList");
  const badge = document.getElementById("notificationBadge");
  const markAllButton = document.getElementById(
    "markAllNotificationsReadBtn"
  );

  const unreadCount = notifications.filter(
    notification => !notification.read_at
  ).length;

  badge.textContent = String(unreadCount);
  badge.classList.toggle("hidden", unreadCount === 0);
  markAllButton.disabled = unreadCount === 0;

  if (!notifications.length) {
    list.innerHTML = `
      <div class="empty">
        You do not have any notifications yet.
      </div>
    `;
    return;
  }

  list.innerHTML = notifications.map(notification => `
    <article
      class="notification-item ${notification.read_at ? "" : "unread"}"
      data-id="${notification.id}"
    >
      <div class="notification-item-content">
        <div class="notification-item-title">
          ${escapeHtml(notification.title)}
        </div>
        <div class="notification-item-body">
          ${escapeHtml(notification.body)}
        </div>
      </div>

      <time class="notification-item-time">
        ${fmtDate(notification.created_at)}
      </time>
    </article>
  `).join("");
  document.querySelectorAll(".notification-item").forEach(item => {
  item.addEventListener("click", async () => {
    const notification = notifications.find(
      entry => String(entry.id) === item.dataset.id
    );

    if (!notification || notification.read_at) return;

    const { error } = await supabase.rpc(
      "mark_notification_read",
      { p_notification_id: notification.id }
    );

    if (error) {
      console.error(error);
      showToast("Could not mark the notification as read.");
      return;
    }

    await refresh();
  });
});
}
document
  .getElementById("markAllNotificationsReadBtn")
  .addEventListener("click", async () => {
    const { error } = await supabase.rpc(
      "mark_all_notifications_read"
    );

    if (error) {
      console.error(error);
      showToast("Could not mark the notifications as read.");
      return;
    }

    showToast("All notifications marked as read.");
    await refresh();
  });

  document
  .getElementById("notificationToggleBtn")
  .addEventListener("click", async () => {
    try {
      const subscription =
        await getCurrentPushSubscription();

      if (subscription) {
        await disablePushNotifications();
      } else {
        await enablePushNotifications();
      }
    } catch (error) {
      console.error(error);
      showToast("Could not change notification settings.");
      await updateNotificationControls();
    }
  });


  function renderTrash() {
    const grid = document.getElementById("trashGrid");
    grid.innerHTML = trash.map(item => {
      const mine = item.next_person === me.id;
      const last = item.last_taken_at
        ? `${fmtDate(item.last_taken_at)} by ${personName(item.last_taken_by)}`
        : "No record yet";

      return `
        <article class="card trash-card">
          <div class="trash-top">
            <div>
              <h3>${item.emoji} ${item.name}</h3>
              <div class="muted">Last taken: ${last}</div>
            </div>
            <span class="pill ${item.status}">${statusLabel(item.status)}</span>
          </div>

          <div class="next">
            <div class="muted">Next turn</div>
            <strong>${personName(item.next_person)}</strong>
          </div>

          <div class="actions">
            <button class="secondary status-btn" data-id="${item.id}">Update status</button>
            ${mine
              ? `<button class="primary take-btn" data-id="${item.id}">✅ Mark as taken</button>`
              : `<button class="voluntary-btn voluntary-action" data-id="${item.id}">🤝 I’ll take it instead</button>`
            }
          </div>
        </article>
      `;
    }).join("");

    document.querySelectorAll(".status-btn").forEach(btn =>
      btn.addEventListener("click", () => {
        activeTrashId = btn.dataset.id;
        const item = trash.find(t => t.id === activeTrashId);
        document.getElementById("statusTitle").textContent = `${item.emoji} ${item.name}`;
        document.getElementById("statusDialog").showModal();
      })
    );

    document.querySelectorAll(".take-btn").forEach(btn =>
      btn.addEventListener("click", async () => {
        await takeOut(btn.dataset.id);
      })
    );

    document.querySelectorAll(".voluntary-action").forEach(btn =>
      btn.addEventListener("click", () => {
        voluntaryTrashId = btn.dataset.id;
        const item = trash.find(t => t.id === voluntaryTrashId);
        document.getElementById("voluntaryText").innerHTML =
          `It is currently <strong>${personName(item.next_person)}'s</strong> turn for <strong>${item.name}</strong>.`;
        document.getElementById("voluntaryDialog").showModal();
      })
    );
  }

  async function takeOut(trashId) {
    const { error } = await supabase.rpc("take_out_trash", { p_trash_id: trashId });
    if (error) {
      console.error(error);
      showToast("Could not record the trash action.");
      return;
    }
    showToast("Recorded as taken out.");
    await refresh();
  }

  document.querySelectorAll(".status-choice").forEach(btn =>
    btn.addEventListener("click", async () => {
      const newStatus = btn.dataset.status;
      const { error } = await supabase.rpc("set_trash_status", {
        p_trash_id: activeTrashId,
        p_status: newStatus
      });

      document.getElementById("statusDialog").close();

      if (error) {
        console.error(error);
        showToast("Could not update status.");
        return;
      }
      showToast(`Status changed to ${statusLabel(newStatus)}.`);
      await refresh();
    })
  );

  document.getElementById("confirmVoluntaryBtn").addEventListener("click", async () => {
    document.getElementById("voluntaryDialog").close();
    await takeOut(voluntaryTrashId);
  });

  function renderHistory() {
    const filter = document.getElementById("historyFilter").value;
    const rows = filter === "all" ? history : history.filter(h => h.type === filter);

    const list = document.getElementById("historyList");
    if (!rows.length) {
      list.innerHTML = `<div class="empty">No activity yet.</div>`;
      return;
    }

    list.innerHTML = rows.map(h => {
      const icon = {
        taken: h.voluntary ? "🤝" : "✅",
        status: "🔄",
        vacation: "🏖️",
        password_reset: "🔑"
      }[h.type] || "•";

      return `
        <div class="history-item">
          <strong>${icon} ${escapeHtml(h.summary)}</strong>
          <div class="meta">${fmtDate(h.created_at)}</div>
        </div>
      `;
    }).join("");
  }

  document.getElementById("historyFilter").addEventListener("change", renderHistory);

  function renderPeople() {
    const box = document.getElementById("peopleList");
    box.innerHTML = profiles.map(p => {
      const away = isEffectivelyAway(p);
      const canEdit = p.id === me.id || me.role === "admin";
      return `
        <div class="person-row">
          <div>
            <strong>${p.display_name}</strong>
            ${p.role === "admin" ? `<span class="role-badge">ADMIN</span>` : ""}
            <div class="muted">
              ${away ? `🏖️ Away${p.away_until ? ` until ${p.away_until}` : ""}` : "🟢 Home"}
            </div>
          </div>
          ${canEdit ? `<button class="secondary availability-btn" data-id="${p.id}">Change availability</button>` : ""}
        </div>
      `;
    }).join("");

    document.querySelectorAll(".availability-btn").forEach(btn =>
      btn.addEventListener("click", () => openVacation(btn.dataset.id))
    );
  }

  function openVacation(personId) {
    const p = profiles.find(x => x.id === personId);
    document.getElementById("vacationPersonId").value = p.id;
    document.getElementById("vacationTitle").textContent = `${p.display_name} availability`;
    document.getElementById("availabilitySelect").value = isEffectivelyAway(p) ? "away" : "home";
    document.getElementById("awayUntil").value = p.away_until || "";
    document.getElementById("vacationDialog").showModal();
  }

  document.getElementById("saveVacationBtn").addEventListener("click", async (e) => {
    e.preventDefault();
    const personId = document.getElementById("vacationPersonId").value;
    const availability = document.getElementById("availabilitySelect").value;
    const awayUntil = document.getElementById("awayUntil").value || null;

    const { error } = await supabase.rpc("set_availability", {
      p_target_person: personId,
      p_availability: availability,
      p_away_until: awayUntil
    });

    if (error) {
      console.error(error);
      showToast("Could not update availability.");
      return;
    }

    document.getElementById("vacationDialog").close();
    showToast("Availability updated.");
    await refresh();
  });

  function renderAdmin() {
    if (me.role !== "admin") return;
    const box = document.getElementById("adminPeopleList");

    box.innerHTML = profiles.map(p => `
      <div class="person-row">
        <div>
          <strong>${p.display_name}</strong>
          ${p.role === "admin" ? `<span class="role-badge">ADMIN</span>` : ""}
          <div class="muted">Username: <strong>${p.username}</strong></div>
        </div>
        <div class="person-actions">
          <button class="secondary admin-availability-btn" data-id="${p.id}">Availability</button>
          ${p.id !== me.id ? `<button class="danger-outline reset-password-btn" data-id="${p.id}">Reset password</button>` : ""}
        </div>
      </div>
    `).join("");

    document.querySelectorAll(".admin-availability-btn").forEach(btn =>
      btn.addEventListener("click", () => openVacation(btn.dataset.id))
    );

    document.querySelectorAll(".reset-password-btn").forEach(btn =>
      btn.addEventListener("click", () => {
        const p = profiles.find(x => x.id === btn.dataset.id);
        document.getElementById("resetPasswordUserId").value = p.id;
        document.getElementById("resetPasswordTarget").innerHTML =
          `Create a new temporary password for <strong>${p.display_name}</strong> (<code>${p.username}</code>).`;
        document.getElementById("temporaryPassword").value = "";
        document.getElementById("resetPasswordMessage").textContent = "";
        document.getElementById("resetPasswordDialog").showModal();
      })
    );
  }

  document.getElementById("confirmResetPasswordBtn").addEventListener("click", async () => {
    const targetUserId = document.getElementById("resetPasswordUserId").value;
    const newPassword = document.getElementById("temporaryPassword").value;
    const message = document.getElementById("resetPasswordMessage");

    message.className = "form-message";
    message.textContent = "";

    if (newPassword.length < 8) {
      message.classList.add("failure");
      message.textContent = "Use at least 8 characters.";
      return;
    }

    const { data, error } = await supabase.functions.invoke("admin-reset-password", {
      body: { targetUserId, newPassword }
    });

    if (error || !data?.ok) {
      console.error(error || data);
      message.classList.add("failure");
      message.textContent = data?.error || "Password reset failed.";
      return;
    }

    message.classList.add("success");
    message.textContent = "Temporary password created.";
    showToast("Member password reset.");
    await refresh();
  });

  function renderAccount() {
    document.getElementById("accountName").textContent = me.display_name;
    document.getElementById("accountUsername").textContent = me.username;
    document.getElementById("accountRole").textContent = me.role === "admin" ? "Administrator" : "Member";
  }

  document.getElementById("changePasswordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("newOwnPassword").value;
    const confirm = document.getElementById("confirmOwnPassword").value;
    const message = document.getElementById("ownPasswordMessage");

    message.className = "form-message";
    if (password !== confirm) {
      message.classList.add("failure");
      message.textContent = "The two passwords do not match.";
      return;
    }

    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      console.error(error);
      message.classList.add("failure");
      message.textContent = "Could not change password.";
      return;
    }

    message.classList.add("success");
    message.textContent = "Password changed successfully.";
    e.currentTarget.reset();
  });

  document.querySelectorAll(".tab").forEach(btn =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    })
  );

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    showAuth();
  } else {
    await refresh();
    subscribeRealtime();
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_OUT" || !session) showAuth();
  });
}
