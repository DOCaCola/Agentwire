const $ = (id) => document.getElementById(id);
const relayUrl = new URL("../", document.currentScript.src);
class AuthError extends Error {}

let me,
  membership = null,
  chats = [],
  devices = [],
  selected = null,
  transcript = [],
  stream,
  replyTo,
  lastSubmission,
  joinMode,
  toastTimer;

const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};
const initials = (name) =>
  name
    .split(/[\s·._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const avatar = (name, kind) => node("span", "avatar " + kind, initials(name));
function formatTime(value, withDay) {
  const date = new Date(value);
  const today = date.toDateString() === new Date().toDateString();
  return today || !withDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short" });
}
async function api(path, options = {}) {
  const response = await fetch(new URL("api" + path, relayUrl), {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 401) throw new AuthError("Please sign in again.");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}
function report(error) {
  if (error instanceof AuthError) showLogin();
  else toast(error.message);
}
const chat = (room) => chats.find((item) => item.room === room);
const people = () => chat(selected)?.participants ?? [];
const joinedHere = () => Boolean(selected && membership?.room === selected);

// ---- Sign-in ----
const loginUrl = (silent) => {
  const url = new URL("auth/login", relayUrl);
  if (location.hash === "#devices") url.searchParams.set("devices", "1");
  if (silent) url.searchParams.set("prompt", "none");
  return url.href;
};
function showLogin(status) {
  stream?.close();
  stream = undefined;
  $("app").hidden = true;
  $("login").hidden = false;
  $("login-status").textContent =
    status ?? "Sign in to follow and join your agents’ chats.";
  for (const id of ["oidc-login", "token-login"])
    $(id).classList.toggle("busy", Boolean(status));
}
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/login", {
      method: "POST",
      body: JSON.stringify({ token: $("token").value.trim() }),
    });
    $("token").value = "";
    await start();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
};
$("logout").onclick = async () => {
  try {
    await api("/logout", { method: "POST", body: "{}" });
    membership = null;
    showLogin();
  } catch (error) {
    report(error);
  }
};

// ---- Loading and live updates ----
async function load() {
  const state = await api("/state");
  me = state.client;
  membership = state.membership;
  chats = state.chats;
  devices = state.devices;
  $("login").hidden = true;
  $("app").hidden = false;
  $("my-name").textContent = me.name;
  $("my-avatar").textContent = initials(me.name);
  $("open-tokens").hidden = !me.admin;
  route();
  renderDevices();
}
async function start() {
  await load();
  connect();
}
function connect() {
  stream?.close();
  const after = Math.max(
    0,
    ...chats.map((item) => item.last?.id ?? 0),
    ...transcript.map((item) => item.id),
  );
  stream = new EventSource(new URL("api/events?after=" + after, relayUrl));
  let checked = false;
  stream.onopen = () => {
    checked = false;
    setConnection(true);
    void renewMembership();
  };
  stream.onerror = () => {
    setConnection(false);
    // One credential check per outage; EventSource reconnects on its own.
    if (!checked) {
      checked = true;
      api("/state").catch((error) => {
        if (error instanceof AuthError) showLogin();
      });
    }
  };
  stream.addEventListener("message", (event) =>
    receive(JSON.parse(event.data)),
  );
  stream.addEventListener("clients", (event) => {
    const data = JSON.parse(event.data);
    membership = data.membership;
    chats = data.chats;
    renderChats();
    renderConversation();
  });
  stream.addEventListener("devices", (event) => {
    devices = JSON.parse(event.data);
    renderDevices();
  });
  stream.addEventListener("resync", () => start().catch(report));
}
function setConnection(live) {
  $("connection").classList.toggle("offline", !live);
  $("connection").title = live ? "Live" : "Reconnecting…";
  $("connection").textContent = live ? "" : "Reconnecting…";
}
function receive(message) {
  const existing = chat(message.room);
  if (existing) existing.last = message;
  else chats.push({ room: message.room, participants: [], last: message });
  chats.sort(
    (a, b) =>
      (b.last?.id ?? Infinity) - (a.last?.id ?? Infinity) ||
      a.room.localeCompare(b.room),
  );
  renderChats();
  if (
    message.room === selected &&
    !transcript.some((item) => item.id === message.id)
  ) {
    transcript.push(message);
    renderMessages(true);
  }
}
async function renewMembership() {
  if (!membership) return;
  try {
    await api("/rooms/heartbeat", {
      method: "POST",
      body: JSON.stringify({ room: membership.room }),
    });
  } catch (error) {
    if (error instanceof AuthError) return showLogin();
    membership = null;
    renderConversation();
  }
}
setInterval(() => void renewMembership(), 20_000);

// ---- Navigation ----
function route() {
  const match = /^#chat=(.+)$/.exec(location.hash);
  const room = match ? decodeURIComponent(match[1]) : null;
  if (room !== selected) {
    selected = room;
    transcript = [];
    replyTo = undefined;
    if (room) void openTranscript(room);
  }
  $("app").classList.toggle("in-chat", Boolean(selected));
  renderChats();
  renderConversation();
  if (location.hash === "#devices" && !$("devices-dialog").open)
    $("devices-dialog").showModal();
}
async function openTranscript(room) {
  try {
    const messages = await api(
      "/rooms/" + encodeURIComponent(room) + "/messages",
    );
    if (selected !== room) return;
    const live = transcript.filter(
      (item) => item.id > (messages.at(-1)?.id ?? 0),
    );
    transcript = [...messages, ...live];
    renderMessages(true);
  } catch (error) {
    report(error);
  }
}
const select = (room) => {
  location.hash = room ? "chat=" + encodeURIComponent(room) : "";
};
window.addEventListener("hashchange", () => me && route());
$("back").onclick = () => select(null);

// ---- Chat list ----
function renderChats() {
  const list = $("chat-list");
  list.replaceChildren();
  for (const item of chats) {
    const button = node("button", "chat-item");
    if (item.room === selected) button.setAttribute("aria-current", "true");
    button.onclick = () => select(item.room);
    const top = node("span", "chat-top");
    top.append(node("strong", "", item.room));
    if (item.last) {
      const time = node("time", "", formatTime(item.last.created_at, true));
      time.dateTime = item.last.created_at;
      top.append(time);
    }
    const bottom = node("span", "chat-bottom");
    bottom.append(
      node(
        "span",
        "preview",
        item.last
          ? item.last.sender_name + ": " + item.last.body
          : "No messages yet",
      ),
    );
    if (item.participants.length)
      bottom.append(node("span", "present", String(item.participants.length)));
    button.append(top, bottom);
    list.append(button);
  }
  $("no-chats").hidden = chats.length > 0;
}

// ---- Conversation ----
function renderConversation() {
  const current = chat(selected);
  const count = people().length;
  $("chat-title").textContent = selected ?? "Chats";
  $("chat-subtitle").textContent = selected
    ? [
        count
          ? count + (count === 1 ? " person here" : " people here")
          : "Nobody here now",
        joinedHere() ? "you’re in this chat" : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  $("toggle-people").hidden = !selected;
  $("compose-area").hidden = !selected;
  $("join-bar").hidden = joinedHere();
  $("composer").hidden = !joinedHere();
  $("join-text").textContent =
    membership && membership.room !== selected
      ? "You’re in " + membership.room + ". Joining moves you here."
      : "Join to write in this chat.";
  renderPeople();
  renderRecipients();
  if (!selected) {
    placeholder(
      chats.length ? "Pick a chat" : "No chats yet",
      chats.length
        ? "Choose a chat on the left to read along."
        : "Ask an agent to “join room MyTask”. Its chat shows up here as soon as it joins.",
    );
  } else if (!current && !transcript.length) {
    placeholder(
      "Nobody here yet",
      "Agents that join “" + selected + "” appear here.",
    );
  } else renderMessages(false);
}
function placeholder(title, text) {
  $("messages").hidden = true;
  $("placeholder").hidden = false;
  $("placeholder-title").textContent = title;
  $("placeholder-text").textContent = text;
}
function renderMessages(scroll) {
  if (!selected) return;
  const box = $("messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!transcript.length) {
    placeholder(
      "No messages yet",
      "Messages that you or your agents send or receive here appear in this chat.",
    );
    return;
  }
  $("placeholder").hidden = true;
  box.hidden = false;
  box.replaceChildren();
  let previous;
  let day;
  for (const message of transcript) {
    const date = new Date(message.created_at).toDateString();
    if (date !== day) {
      day = date;
      box.append(
        node(
          "div",
          "day",
          new Date(message.created_at).toLocaleDateString([], {
            weekday: "long",
            day: "numeric",
            month: "long",
          }),
        ),
      );
      previous = undefined;
    }
    const continued =
      previous &&
      previous.sender === message.sender &&
      previous.recipient === message.recipient &&
      !message.reply_to &&
      new Date(message.created_at) - new Date(previous.created_at) < 5 * 60_000;
    box.append(renderMessage(message, continued));
    previous = message;
  }
  if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
}
function renderMessage(message, continued) {
  const sender = people().find((item) => item.id === message.sender);
  const article = node("article", "message" + (continued ? " continued" : ""));
  if (message.sender === me.id) article.classList.add("mine");
  article.append(
    continued
      ? node("span", "gutter")
      : avatar(
          message.sender_name,
          sender?.kind ?? (message.sender === me.id ? "human" : "agent"),
        ),
  );
  const content = node("div", "message-content");
  if (!continued) {
    const head = node("div", "message-head");
    head.append(node("strong", "", message.sender_name));
    if (message.recipient)
      head.append(node("span", "direct", "to " + message.recipient_name));
    if (
      message.kind !== "note" &&
      !(message.kind === "answer" && message.reply_to)
    )
      head.append(node("span", "badge " + message.kind, message.kind));
    const time = node("time", "", formatTime(message.created_at));
    time.dateTime = message.created_at;
    time.title = new Date(message.created_at).toLocaleString();
    head.append(time);
    content.append(head);
  }
  if (message.reply_to) {
    const parent = transcript.find((item) => item.id === message.reply_to);
    if (parent)
      content.append(
        node("p", "quote", parent.sender_name + ": " + parent.body),
      );
  }
  content.append(node("p", "body", message.body));
  article.append(content);
  if (joinedHere() && message.sender !== me.id) {
    const reply = node("button", "reply", "Reply");
    reply.onclick = () => {
      replyTo = message;
      const present = people().some((item) => item.id === message.sender);
      $("recipient").value = present ? message.sender : "all";
      renderReply();
      $("body").focus();
    };
    article.append(reply);
  }
  return article;
}
function renderRecipients() {
  const chosen = $("recipient").value;
  const others = people().filter((item) => item.id !== me?.id);
  $("recipient").replaceChildren(new Option("Everyone", "all"));
  for (const item of others) {
    const twin = others.some(
      (other) => other !== item && other.name === item.name,
    );
    $("recipient").append(
      new Option(
        twin ? item.name + " (" + item.client_name + ")" : item.name,
        item.id,
      ),
    );
  }
  $("recipient").value = others.some((item) => item.id === chosen)
    ? chosen
    : "all";
}
function renderReply() {
  $("reply-chip").hidden = !replyTo;
  $("reply-text").textContent = replyTo
    ? "Replying to " + replyTo.sender_name + ": " + replyTo.body
    : "";
}
$("cancel-reply").onclick = () => {
  replyTo = undefined;
  renderReply();
};
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("composer").querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const draft = {
      to: $("recipient").value,
      body: $("body").value,
      ...(replyTo ? { kind: "answer", reply_to: replyTo.id } : {}),
    };
    const serialized = JSON.stringify(draft);
    if (lastSubmission?.serialized !== serialized)
      lastSubmission = { serialized, key: crypto.randomUUID() };
    await api("/messages", {
      method: "POST",
      body: JSON.stringify({ ...draft, idempotency_key: lastSubmission.key }),
    });
    lastSubmission = undefined;
    replyTo = undefined;
    $("body").value = "";
    resizeBody();
    renderReply();
  } catch (error) {
    report(error);
  } finally {
    button.disabled = false;
  }
};
function resizeBody() {
  $("body").style.height = "auto";
  $("body").style.height = $("body").scrollHeight + "px";
}
$("body").oninput = resizeBody;
$("body").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
};

// ---- People ----
function renderPeople() {
  const list = $("people");
  list.replaceChildren();
  for (const item of people()) {
    const row = node("li");
    const button = node("button", "person");
    const face = avatar(item.name, item.kind);
    face.append(node("span", "presence" + (item.connections ? " online" : "")));
    button.append(face, node("span", "person-name", item.name));
    if (item.id === me.id) button.append(node("span", "tag", "you"));
    else if (item.kind === "human")
      button.append(node("span", "tag", "person"));
    button.onclick = () => openPerson(item);
    row.append(button);
    list.append(row);
  }
  $("no-people").hidden = !selected || people().length > 0;
  $("me-in-chat").hidden = !joinedHere();
  $("my-room-name").textContent = membership?.name ?? "";
}
let person;
function openPerson(item) {
  person = item;
  $("person-name").textContent = item.name;
  $("person-kind").textContent = item.kind === "human" ? "Person" : "Agent";
  $("person-client").textContent = item.client_name;
  $("person-status").textContent = item.connections ? "Connected" : "Away";
  $("person-error").textContent = "";
  $("person-message").hidden = !joinedHere() || item.id === me.id;
  $("person-rotate").hidden = !item.can_rotate;
  $("person-revoke").hidden = !item.can_manage;
  $("person-dialog").showModal();
}
$("person-message").onclick = () => {
  $("recipient").value = person.id;
  $("person-dialog").close();
  $("body").focus();
};
$("person-rotate").onclick = async () => {
  if (
    !confirm(
      "Issue a new token for " + person.name + "? The old one stops working.",
    )
  )
    return;
  try {
    const result = await api("/clients/" + person.id + "/rotate", {
      method: "POST",
    });
    $("person-dialog").close();
    showCredential(result.token);
  } catch (error) {
    $("person-error").textContent = error.message;
  }
};
$("person-revoke").onclick = async () => {
  if (!confirm("Revoke " + person.name + "? It is disconnected immediately."))
    return;
  try {
    await api("/clients/" + person.id, { method: "DELETE" });
    $("person-dialog").close();
  } catch (error) {
    $("person-error").textContent = error.message;
  }
};
$("toggle-people").onclick = () => $("app").classList.toggle("people-hidden");
$("close-people").onclick = () => $("app").classList.add("people-hidden");
if (matchMedia("(max-width: 1099px)").matches)
  $("app").classList.add("people-hidden");

// ---- Joining, renaming, leaving ----
function openJoin(mode) {
  joinMode = mode;
  const titles = {
    new: "New chat",
    join: "Join " + selected,
    rename: "Rename yourself",
  };
  $("join-title").textContent = titles[mode];
  $("room-field").hidden = mode !== "new";
  $("join-room").required = mode === "new";
  $("join-room").value = "";
  $("join-name").value =
    mode === "rename" || membership?.room === selected
      ? (membership?.name ?? me.name)
      : me.name;
  $("join-submit").textContent = mode === "rename" ? "Save" : "Join";
  $("join-error").textContent = "";
  updateJoinHint();
  $("join-dialog").showModal();
  (mode === "new" ? $("join-room") : $("join-name")).focus();
}
function updateJoinHint() {
  const room = joinMode === "new" ? $("join-room").value.trim() : selected;
  $("join-hint").textContent =
    joinMode === "new" && room
      ? "Agents join with: “Join room " + room + "”"
      : "";
}
$("join-room").oninput = updateJoinHint;
$("new-chat").onclick = () => openJoin("new");
$("join-chat").onclick = () => openJoin("join");
$("rename").onclick = () => openJoin("rename");
$("join-form").onsubmit = async (event) => {
  event.preventDefault();
  const room = joinMode === "new" ? $("join-room").value.trim() : selected;
  try {
    const joined = await api("/rooms/join", {
      method: "POST",
      body: JSON.stringify({ room, name: $("join-name").value.trim() }),
    });
    membership = { room: joined.room, name: joined.name, active: true };
    $("join-dialog").close();
    if (selected === joined.room) renderConversation();
    else select(joined.room);
  } catch (error) {
    $("join-error").textContent = error.message;
  }
};
$("leave").onclick = async () => {
  try {
    await api("/rooms/leave", { method: "POST", body: "{}" });
    membership = null;
    renderConversation();
  } catch (error) {
    report(error);
  }
};

// ---- Devices ----
function renderDevices() {
  const waiting = devices.filter(
    (device) => device.status === "pending",
  ).length;
  $("device-notice").hidden = !waiting;
  $("device-notice").textContent =
    waiting === 1
      ? "1 device is waiting for approval"
      : waiting + " devices are waiting for approval";
  $("open-devices").textContent = waiting
    ? "Devices (" + waiting + ")"
    : "Devices";
  const list = $("devices-list");
  list.replaceChildren();
  if (!devices.length)
    list.append(
      node(
        "p",
        "muted",
        "No devices. Set up the Agentwire plugin on a device to connect it.",
      ),
    );
  for (const device of devices) {
    const form = node("form", "device");
    const info = node("div", "device-info");
    info.append(
      node("strong", "", device.name),
      node(
        "small",
        "",
        (device.status === "pending" ? "Waiting for approval" : "Approved") +
          " · fingerprint " +
          device.fingerprint,
      ),
    );
    form.append(info);
    const actions = node("div", "device-actions");
    if (device.status === "pending") {
      const code = node("input");
      code.name = "code";
      code.placeholder = "Code";
      code.autocomplete = "off";
      code.maxLength = 9;
      code.required = true;
      code.setAttribute("aria-label", "Approval code for " + device.name);
      actions.append(code);
    }
    const buttons =
      device.status === "pending"
        ? [
            ["approve", "Approve", "primary"],
            ["deny", "Deny", ""],
          ]
        : [["revoke", "Revoke", "danger"]];
    for (const [action, label, style] of buttons) {
      const button = node("button", "button small " + style, label);
      button.value = action;
      if (action === "deny") button.formNoValidate = true;
      actions.append(button);
    }
    form.append(actions);
    form.onsubmit = async (event) => {
      event.preventDefault();
      const action = event.submitter.value;
      if (
        action === "revoke" &&
        !confirm("Revoke " + device.name + " and all its agents?")
      )
        return;
      $("device-error").textContent = "";
      try {
        await api("/devices/" + device.id, {
          method: "POST",
          body: JSON.stringify({
            action,
            ...(action === "approve"
              ? {
                  code: form.elements.code.value
                    .replace(/-/g, "")
                    .trim()
                    .toUpperCase(),
                }
              : {}),
          }),
        });
        devices = await api("/devices");
        renderDevices();
      } catch (error) {
        $("device-error").textContent = error.message;
      }
    };
    list.append(form);
  }
}
const openDevices = () => {
  $("device-error").textContent = "";
  $("devices-dialog").showModal();
};
$("open-devices").onclick = openDevices;
$("device-notice").onclick = openDevices;
$("devices-dialog").addEventListener("close", () => {
  if (location.hash === "#devices")
    history.replaceState(null, "", location.pathname);
});

// ---- Access tokens ----
$("open-tokens").onclick = () => {
  $("client-form").hidden = false;
  $("credential").hidden = true;
  $("client-error").textContent = "";
  $("client-form").reset();
  $("tokens-dialog").showModal();
};
function showCredential(token) {
  $("client-form").hidden = true;
  $("credential").hidden = false;
  $("new-token").textContent = token;
  if (!$("tokens-dialog").open) $("tokens-dialog").showModal();
}
$("client-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const data = await api("/clients", {
      method: "POST",
      body: JSON.stringify({
        id: $("client-id").value,
        name: $("client-name").value,
        kind: $("client-kind").value,
      }),
    });
    showCredential(data.token);
  } catch (error) {
    $("client-error").textContent = error.message;
  }
};
$("copy-token").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("new-token").textContent);
    toast("Token copied.");
  } catch {
    toast("Select the token and copy it manually.");
  }
};
$("tokens-dialog").addEventListener("close", () => {
  $("new-token").textContent = "";
});
for (const button of document.querySelectorAll("[data-close]"))
  button.onclick = () => button.closest("dialog").close();

// ---- Start ----
(async () => {
  const query = new URLSearchParams(location.search);
  const manual = query.has("signin");
  if (manual) history.replaceState(null, "", location.pathname + location.hash);
  const auth = await api("/auth");
  $("oidc-login").hidden = !auth.oidc;
  $("oidc-login").textContent = "Sign in with " + auth.label;
  $("oidc-login").href = loginUrl(false);
  $("token-login").open = !auth.oidc;
  try {
    await start();
  } catch (error) {
    if (!(error instanceof AuthError)) {
      showLogin();
      $("login-error").textContent = error.message;
    } else if (auth.automatic && !manual) {
      showLogin("Signing in…");
      location.replace(loginUrl(true));
    } else showLogin();
  }
})();
