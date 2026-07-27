self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: "Acorn", body: event.data ? event.data.text() : "You have a reminder." };
  }

  const title = data.title || "Acorn";
  const options = {
    body: data.body || "You have a task reminder.",
    icon: data.icon || "/icon.png",
    badge: data.badge || "/icon.png",
    actions: data.actions || [],
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") {
    return;
  }

  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.openWindow(url));
});