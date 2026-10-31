const $ = (id) => document.getElementById(id);
const relayUrl = new URL("../", document.currentScript.src);
let me,
  clients = [],
  messages = [],
  inboxMessages = [],
  pendingCount = 0,
  pending = new Set(),
  stream,
  channelFilter = "",
  replyTo;
let toastTimer, lastSubmission;
const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};
const initials = (name) =>
  name
    .split(/[\s·-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
async function api(path, options = {}) {
  const response = await fetch(new URL(`api${path}`, relayUrl), {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 401) {
    showLogin();
    throw new Error("Please sign in again.");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 5000);
}
function showLogin() {
  stream?.close();
  stream = undefined;
  $("workspace").hidden = true;
  $("login").hidden = false;
}
function setConnection(connected) {
  $("connection").replaceChildren(
    node("span", "little-dot"),
    document.createTextNode(connected ? "Live connection" : "Reconnecting"),
  );
  $("connection").classList.toggle("offline", !connected);
}
function renderClients() {
  const selected = $("recipient").value;
  $("clients").replaceChildren();
  $("recipient").replaceChildren(new Option("Everyone", "all"));
  for (const client of clients) {
    const row = node("div", "client-row");
    row.append(node("span", `avatar ${client.kind}`, initials(client.name)));
    const info = node("div", "client-info");
    info.append(
      node("strong", "", client.name),
      node("small", "", `${client.id}${client.id === me.id ? " · you" : ""}`),
    );
    row.append(info);
    if (me.admin && client.id !== "owner") {
      const actions = node("div", "client-actions");
      for (const [symbol, title, action] of [
        ["↻", "Rotate token", "rotate"],
        ["×", "Revoke client", "revoke"],
      ]) {
        const button = node("button", "icon-button", symbol);
        button.title = `${title}: ${client.name}`;
        button.onclick = async () => {
          if (
            !confirm(
              `${title} for ${client.name}? Existing connections will close.`,
            )
          )
            return;
          try {
            const result = await api(
              `/clients/${client.id}${action === "rotate" ? "/rotate" : ""}`,
              { method: action === "rotate" ? "POST" : "DELETE" },
            );
            if (action === "rotate") showCredential(result.token, client.id);
          } catch (error) {
            toast(error.message);
          }
        };
        actions.append(button);
      }
      row.append(actions);
    }
    row.append(
      node("span", `status-dot ${client.connections ? "online" : ""}`),
    );
    $("clients").append(row);
    if (client.id !== me.id)
      $("recipient").append(new Option(client.name, client.id));
  }
  if ([...$("recipient").options].some((option) => option.value === selected))
    $("recipient").value = selected;
  $("online-count").replaceChildren(
    document.createTextNode(
      String(clients.filter((client) => client.connections).length),
    ),
    node("small", "", "clients online"),
  );
}
function renderMessages() {
  $("messages").replaceChildren();
  const combined = new Map(
    [...inboxMessages, ...messages].map((message) => [message.id, message]),
  );
  pending = new Set([...pending].filter((id) => combined.has(id)));
  const visible = [...combined.values()]
    .sort((a, b) => a.id - b.id)
    .filter((message) => !channelFilter || message.channel === channelFilter);
  for (const message of visible) {
    const sender = clients.find((client) => client.id === message.sender);
    const article = node("article", "message");
    article.dataset.id = String(message.id);
    article.append(
      node(
        "span",
        `avatar ${sender?.kind ?? "agent"}`,
        initials(sender?.name ?? message.sender),
      ),
    );
    const content = node("div", "message-content"),
      head = node("div", "message-head");
    head.append(
      node("strong", "", sender?.name ?? message.sender),
      node("span", `badge ${message.kind}`, message.kind),
    );
    const recipient = message.recipient
      ? (clients.find((client) => client.id === message.recipient)?.name ??
        message.recipient)
      : "everyone";
    head.append(node("span", "message-route", `→ ${recipient}`));
    const time = node(
      "time",
      "",
      new Date(message.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    time.dateTime = message.created_at;
    time.title = new Date(message.created_at).toLocaleString();
    head.append(time);
    content.append(head, node("p", "message-body", message.body));
    const footer = node("div", "message-footer");
    footer.append(
      node("span", "", `# ${message.channel}`),
      node(
        "span",
        "",
        `AW-${message.id}${message.reply_to ? ` · reply to AW-${message.reply_to}` : ""}`,
      ),
    );
    const reply = node("button", "", "Reply ↗");
    reply.onclick = () => {
      replyTo = message.id;
      $("channel").value = message.channel;
      $("recipient").value =
        message.sender === me.id
          ? (message.recipient ?? "all")
          : message.sender;
      $("kind").value = "answer";
      $("reply-info").textContent = ` · replying to AW-${message.id}`;
      $("body").focus();
    };
    footer.append(reply);
    if (pending.has(message.id)) {
      const ack = node("button", "pending-mark", "Acknowledge ✓");
      ack.onclick = async () => {
        try {
          await api("/ack", {
            method: "POST",
            body: JSON.stringify({ ids: [message.id] }),
          });
        } catch (error) {
          toast(error.message);
        }
      };
      footer.append(ack);
    }
    content.append(footer);
    article.append(content);
    $("messages").append(article);
  }
  $("empty").hidden = visible.length > 0;
  $("messages").hidden = !visible.length;
  $("total-count").textContent =
    messages.length >= 100 ? "100+" : String(messages.length);
  $("channel-filter").replaceChildren(new Option("All channels", ""));
  for (const channel of [
    ...new Set([...combined.values()].map((message) => message.channel)),
  ].sort())
    $("channel-filter").append(new Option(`# ${channel}`, channel));
  $("channel-filter").value = channelFilter;
  $("channel-label").textContent = channelFilter
    ? `/ ${channelFilter}`
    : "/ all channels";
}
function renderPending(count) {
  pendingCount = count;
  $("pending-count").replaceChildren(
    document.createTextNode(String(count)),
    node("small", "", "unacknowledged"),
  );
}
async function load() {
  const state = await api("/state");
  me = state.client;
  clients = state.clients;
  messages = state.messages;
  inboxMessages = state.inbox;
  pending = new Set(state.inbox.map((message) => message.id));
  $("my-name").textContent = me.name;
  $("my-id").textContent = me.id;
  $("my-avatar").textContent = initials(me.name);
  $("add-client").hidden = !me.admin;
  $("login").hidden = true;
  $("workspace").hidden = false;
  renderClients();
  renderMessages();
  renderPending(state.pending);
}
function connect() {
  stream?.close();
  let authChecked = false;
  stream = new EventSource(
    new URL(`api/events?after=${messages.at(-1)?.id ?? 0}`, relayUrl),
  );
  stream.onopen = () => {
    authChecked = false;
    setConnection(true);
  };
  stream.onerror = () => {
    setConnection(false);
    // One credential check on disconnection; EventSource owns reconnecting the live stream.
    if (!authChecked) {
      authChecked = true;
      api("/state").catch(() => {});
    }
  };
  stream.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!messages.some((item) => item.id === message.id)) {
      messages.push(message);
      messages = messages.slice(-100);
      if (message.sender !== me.id) {
        pending.add(message.id);
        renderPending(pendingCount + 1);
      }
      renderMessages();
    }
  });
  stream.addEventListener("clients", (event) => {
    clients = JSON.parse(event.data);
    renderClients();
  });
  stream.addEventListener("inbox", (event) => {
    const data = JSON.parse(event.data);
    inboxMessages = data.inbox;
    pending = new Set(data.inbox.map((message) => message.id));
    renderPending(data.pending);
    renderMessages();
  });
  stream.addEventListener("resync", async () => {
    try {
      await load();
      connect();
    } catch (error) {
      toast(error.message);
    }
  });
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
    await load();
    connect();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
};
$("logout").onclick = async () => {
  try {
    await api("/logout", { method: "POST", body: "{}" });
    showLogin();
  } catch (error) {
    toast(error.message);
  }
};
$("channel-filter").onchange = () => {
  channelFilter = $("channel-filter").value;
  renderMessages();
};
$("all-filter").onclick = () => {
  channelFilter = "";
  renderMessages();
};
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  const button =
    event.submitter ?? $("composer").querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const draft = {
      to: $("recipient").value,
      channel: $("channel").value,
      kind: $("kind").value,
      body: $("body").value,
      ...(replyTo ? { reply_to: replyTo } : {}),
    };
    const serialized = JSON.stringify(draft);
    if (lastSubmission?.serialized !== serialized) {
      lastSubmission = { serialized, key: crypto.randomUUID() };
    }
    await api("/messages", {
      method: "POST",
      body: JSON.stringify({
        ...draft,
        idempotency_key: lastSubmission.key,
      }),
    });
    lastSubmission = undefined;
    $("body").value = "";
    replyTo = undefined;
    $("reply-info").textContent = "";
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};
$("body").onkeydown = (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
};
$("add-client").onclick = () => {
  $("client-form").hidden = false;
  $("credential").hidden = true;
  $("client-error").textContent = "";
  $("client-form").reset();
  $("client-dialog").showModal();
};
function showCredential(token, id) {
  $("client-form").hidden = true;
  $("credential").hidden = false;
  $("new-token").textContent = token;
  $("new-config").textContent =
    `[mcp_servers.agentwire]\ncommand = "node"\nargs = ["/absolute/path/to/Agentwire/dist/adapter.js"]\nchannel = true\nenv_vars = ["AGENTWIRE_TOKEN"]\n\n[mcp_servers.agentwire.env]\nAGENTWIRE_URL = "${relayUrl.href}"\n\n# Build Agentwire locally with npm ci && npm run build.\n# Set AGENTWIRE_TOKEN to this client's token (${id}).`;
  if (!$("client-dialog").open) $("client-dialog").showModal();
}
$("client-form").onsubmit = async (event) => {
  event.preventDefault();
  $("client-error").textContent = "";
  try {
    const data = await api("/clients", {
      method: "POST",
      body: JSON.stringify({
        id: $("client-id").value,
        name: $("client-name").value,
        kind: $("client-kind").value,
      }),
    });
    showCredential(data.token, data.client.id);
  } catch (error) {
    $("client-error").textContent = error.message;
  }
};
$("copy-token").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("new-token").textContent);
    toast("Token copied. Store it securely.");
  } catch {
    toast("Select and copy the token manually.");
  }
};
for (const button of document.querySelectorAll(".close-dialog"))
  button.onclick = () => $("client-dialog").close();
$("client-dialog").addEventListener("close", () => {
  $("new-token").textContent = "";
  $("new-config").textContent = "";
});
load()
  .then(connect)
  .catch(() => showLogin());
