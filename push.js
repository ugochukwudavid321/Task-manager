const webpush = require("web-push");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
  throw new Error("Missing VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, or VAPID_SUBJECT in environment.");
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function sendPushNotification(subscription, payload) {
  try {
    const fullPayload = {
      icon: "/icon.png",
      badge: "/icon.png",
      actions: [
        { action: "open", title: "Open Ledger" },
        { action: "dismiss", title: "Dismiss" },
      ],
      ...payload,
    };

    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      },
      JSON.stringify(fullPayload)
    );
    return { ok: true };
  } catch (err) {
    // 410/404 means the browser unsubscribed or the subscription expired
    if (err.statusCode === 410 || err.statusCode === 404) {
      return { ok: false, expired: true };
    }
    console.error("Push send failed:", err.message);
    return { ok: false, expired: false, error: err.message };
  }
}

module.exports = { sendPushNotification };