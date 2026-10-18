const $ = (id) => document.getElementById(id);
const state = {
  token: sessionStorage.getItem("codex-remote-token") ?? "",
  selectedThread: null,
  threads: [],
  workspaces: [],
  approvals: [],
  activity: [],
  codexReady: false,
  activeTurn: null,
  liveText: "",
  streamAbort: null,
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 4500);
}

async function api(path, options = {}) {
  const headers = { Authorization: `Bearer ${state.token}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch("/api" + path, {
    method: options.method ?? "GET",
    headers,
    cache: "no-store",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) disconnect();
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

function disconnect() {
  state.streamAbort?.abort();
  state.streamAbort = null;
  state.token = "";
  sessionStorage.removeItem("codex-remote-token");
  $("dashboard").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("access-token").value = "";
}

function connection(ready) {
  state.codexReady = Boolean(ready);
  $("connection-light").classList.toggle("ready", state.codexReady);
  $("connection-label").textContent = state.codexReady ? "Codex 연결됨" : "Codex 연결 안 됨";
  $("connection-detail").textContent = state.codexReady ? "app-server online" : "앱 서버 상태 확인 필요";
  $("new-thread").disabled = !state.codexReady;
  $("welcome-new").disabled = !state.codexReady;
}

function shortDate(value) {
  if (!value) return "";
  const millis = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

function threadName(thread) {
  return String(thread?.name || thread?.preview || thread?.title || "새 Codex 작업").slice(0, 120);
}

function renderThreads() {
  const container = $("thread-list");
  container.replaceChildren();
  if (!state.threads.length) {
    container.append(node("p", "empty-small", "아직 이 작업 폴더에 기록된 대화가 없어요."));
    return;
  }
  for (const thread of state.threads) {
    const item = node("button", "thread-item" + (state.selectedThread === thread.id ? " active" : ""));
    item.type = "button";
    item.append(node("span", "thread-item-title", threadName(thread)));
    item.append(node("span", "thread-item-date", shortDate(thread.updatedAt ?? thread.createdAt) || "Saved session"));
    item.addEventListener("click", () => selectThread(thread.id));
    container.append(item);
  }
}

async function loadThreads() {
  const result = await api("/threads");
  state.threads = result.threads ?? [];
  renderThreads();
}

function renderWorkspaces() {
  const select = $("workspace-select");
  select.replaceChildren();
  for (const workspace of state.workspaces) {
    const option = node("option", "", workspace.name);
    option.value = workspace.id;
    select.append(option);
  }
}

function appendMessage(container, role, text) {
  if (!text || !String(text).trim()) return;
  const block = node("article", "message " + role);
  block.append(node("div", "message-label", role === "user" ? "YOU" : role === "command" ? "CODEX · ACTION" : "CODEX"));
  block.append(node("div", "message-body", text));
  container.append(block);
}

function textFromUserItem(item) {
  return (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function renderConversation(thread) {
  $("empty-view").classList.add("hidden");
  $("conversation").classList.remove("hidden");
  $("thread-title").textContent = threadName(thread);
  $("current-title").textContent = threadName(thread);
  $("thread-meta").textContent = [thread.cwd?.split(/[\\/]/).pop(), shortDate(thread.createdAt)].filter(Boolean).join("  ·  ");
  const container = $("messages");
  container.replaceChildren();
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") appendMessage(container, "user", textFromUserItem(item));
      else if (item.type === "agentMessage") appendMessage(container, "agent", item.text);
      else if (item.type === "commandExecution") appendMessage(container, "command", `$ ${item.command ?? ""}\n${item.aggregatedOutput ?? ""}`.slice(0, 4500));
      else if (item.type === "fileChange") {
        const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
        appendMessage(container, "command", `파일 변경: ${paths.join(", ") || "변경 사항"} · ${item.status ?? ""}`);
      }
    }
  }
  if (!container.childElementCount) container.append(node("p", "empty-small", "새 작업입니다. 아래에서 Codex에 지시해보세요."));
  container.scrollTop = container.scrollHeight;
}

function renderActive() {
  $("stop-turn").disabled = !state.activeTurn;
  const live = $("live-panel");
  live.classList.toggle("hidden", !state.activeTurn);
  $("live-text").textContent = state.liveText || "응답을 기다리는 중...";
}

async function selectThread(id) {
  state.selectedThread = id;
  state.liveText = "";
  state.activeTurn = null;
  renderThreads();
  try {
    const result = await api("/threads/" + encodeURIComponent(id));
    if (state.selectedThread !== id) return;
    state.activeTurn = result.activeTurnId;
    renderConversation(result.thread);
    renderActive();
  } catch (error) {
    toast(error.message);
  }
}

async function createThread() {
  if (!state.codexReady) return toast("Codex app-server가 연결되지 않았습니다.");
  try {
    const result = await api("/threads", { method: "POST", body: { workspaceId: $("workspace-select").value } });
    const id = result.thread?.id;
    if (!id) throw new Error("새 대화 ID를 받지 못했습니다.");
    state.threads.unshift(result.thread);
    await selectThread(id);
    $("prompt").focus();
    addActivity("새 작업 시작", threadName(result.thread));
  } catch (error) {
    toast(error.message);
  }
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.selectedThread) return toast("먼저 작업을 선택하세요.");
  const input = $("prompt");
  const text = input.value.trim();
  if (!text) return;
  $("send").disabled = true;
  try {
    const result = await api("/threads/" + encodeURIComponent(state.selectedThread) + "/messages", { method: "POST", body: { text } });
    input.value = "";
    state.activeTurn = result.turn?.id ?? "pending";
    state.liveText = "";
    renderActive();
    await selectThread(state.selectedThread);
    addActivity("지시 전송", text.slice(0, 95));
  } catch (error) {
    toast(error.message);
  } finally {
    $("send").disabled = false;
  }
}

async function stopTurn() {
  if (!state.selectedThread) return;
  try {
    await api("/threads/" + encodeURIComponent(state.selectedThread) + "/interrupt", { method: "POST", body: {} });
    toast("중지 요청을 보냈습니다.");
  } catch (error) {
    toast(error.message);
  }
}

function addActivity(title, detail = "") {
  state.activity.unshift({ title, detail, time: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) });
  state.activity.length = Math.min(state.activity.length, 40);
  const list = $("activity-list");
  list.replaceChildren();
  for (const item of state.activity) {
    const row = node("div", "activity-item");
    row.append(node("span", "activity-mark"));
    const content = node("div");
    content.append(node("strong", "", item.title));
    if (item.detail) content.append(node("p", "", item.detail));
    content.append(node("time", "", item.time));
    row.append(content);
    list.append(row);
  }
}

function renderApprovals() {
  const container = $("approvals");
  container.replaceChildren();
  for (const approval of state.approvals) {
    const card = node("div", "approval-card");
    card.append(node("strong", "", "⚠ 실행 승인 요청"));
    const details = [approval.command, approval.cwd, approval.reason].filter(Boolean).join("\n");
    card.append(node("p", "", details || "Codex가 파일 변경 승인을 요청했습니다."));
    const actions = node("div", "approval-actions");
    const reject = node("button", "", "거절");
    const accept = node("button", "approve", "이번만 승인");
    reject.addEventListener("click", () => resolveApproval(approval.id, "decline"));
    accept.addEventListener("click", () => {
      if (window.confirm("이 작업이 내 PC에서 실행되거나 파일을 변경할 수 있습니다. 요청 내용을 확인했나요?")) {
        resolveApproval(approval.id, "accept");
      }
    });
    actions.append(reject, accept);
    card.append(actions);
    container.append(card);
  }
}

async function resolveApproval(id, decision) {
  try {
    await api("/approvals/" + encodeURIComponent(id), { method: "POST", body: { decision } });
    state.approvals = state.approvals.filter((item) => item.id !== id);
    renderApprovals();
    addActivity("승인 요청 처리", decision === "accept" ? "1회 승인" : "거절");
  } catch (error) {
    toast(error.message);
  }
}

function onEvent(kind, data) {
  if (kind === "status") {
    connection(data.ready);
    addActivity("Codex 연결 상태", data.ready ? "연결됨" : "연결 끊김");
    return;
  }
  if (kind === "approval") {
    state.approvals.push(data);
    renderApprovals();
    addActivity("승인 요청 도착", data.command?.slice(0, 100) ?? "파일 변경");
    return;
  }
  if (kind === "approvalResolved") {
    state.approvals = state.approvals.filter((item) => item.id !== data.id);
    renderApprovals();
    return;
  }
  if (kind !== "notification") return;
  const { method, params } = data;
  if (method === "thread/started") {
    void loadThreads().catch(() => {});
    return;
  }
  if (method === "turn/started") {
    if (params.threadId === state.selectedThread) {
      state.activeTurn = params.turn?.id ?? "pending";
      renderActive();
    }
    addActivity("작업 시작", "Codex가 요청을 처리하고 있습니다.");
  } else if (method === "item/agentMessage/delta") {
    if (params.threadId === state.selectedThread) {
      state.liveText = (state.liveText + (params.delta ?? "")).slice(-6000);
      renderActive();
    }
  } else if (method === "item/started" && params.item?.type === "commandExecution") {
    addActivity("명령 실행", String(params.item.command ?? "").slice(0, 130));
  } else if (method === "item/started" && params.item?.type === "fileChange") {
    addActivity("파일 변경", "Codex가 변경 사항을 준비했습니다.");
  } else if (method === "turn/completed") {
    if (params.threadId === state.selectedThread) {
      state.activeTurn = null;
      state.liveText = "";
      renderActive();
      void selectThread(state.selectedThread);
    }
    addActivity("작업 종료", params.turn?.status ?? "완료");
    void loadThreads().catch(() => {});
  }
}

async function listenEvents() {
  state.streamAbort?.abort();
  const controller = new AbortController();
  state.streamAbort = controller;
  let wait = 1000;
  while (!controller.signal.aborted) {
    try {
      const response = await fetch("/api/events", {
        headers: { Authorization: `Bearer ${state.token}` },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok || !response.body) throw new Error("Event stream unavailable");
      wait = 1000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const raw = /^data: (.+)$/m.exec(block)?.[1];
          if (event && raw) {
            try { onEvent(event, JSON.parse(raw)); } catch {}
          }
        }
        if (buffer.length > 1024 * 1024) buffer = "";
      }
    } catch {
      if (controller.signal.aborted) return;
      addActivity("실시간 연결 재시도", "네트워크 연결을 확인하고 있습니다.");
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, 12000);
  }
}

async function connect() {
  const session = await api("/session");
  $("login").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
  connection(session.codexReady);
  const [workspaces, approvals] = await Promise.all([api("/workspaces"), api("/approvals")]);
  state.workspaces = workspaces.workspaces;
  state.approvals = approvals.approvals;
  renderWorkspaces();
  renderApprovals();
  await loadThreads();
  addActivity("대시보드 연결", "인증된 개인 세션");
  void listenEvents();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = $("access-token").value.trim();
  $("login-error").textContent = "";
  try {
    await connect();
    sessionStorage.setItem("codex-remote-token", state.token);
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});
$("logout").addEventListener("click", disconnect);
$("new-thread").addEventListener("click", createThread);
$("welcome-new").addEventListener("click", createThread);
$("refresh-threads").addEventListener("click", () => loadThreads().catch((error) => toast(error.message)));
$("composer").addEventListener("submit", sendMessage);
$("stop-turn").addEventListener("click", stopTurn);
$("prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
if (state.token) connect().catch(() => disconnect());
