import { locales, strings } from "./review-strings.js";

const $ = id => document.getElementById(id);
const canonical = "https://review.ooii.top";
const pages = location.hostname.endsWith(".github.io");
const readLocal = key => {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
};
const writeLocal = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* Storage can be disabled. Keep the draft in this tab. */ }
};

const url = new URL(location.href);
const requestedLang = url.searchParams.get("lang") || readLocal("c51-tts-lang");
let lang = Object.hasOwn(locales, requestedLang) ? requestedLang : "zh";
let returnClip = url.searchParams.get("clip");
let account;
let reviews = new Map();
let loadState = "loading";
let sessionState = "loading";
let retrying = false;
let playing;
const cards = [];
const legacyGroups = [];
const t = key => strings[lang][key];
const clipId = (group, clip) => group.id + "-" + clip.number;
const reviewKey = card => card.sample + ":" + card.revision;
const localKey = card => "c51-tts-draft:" + account + ":" + reviewKey(card);

function el(tag, text, attrs = {}) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  for (const [name, value] of Object.entries(attrs)) item.setAttribute(name, value);
  return item;
}

function updateLogin() {
  const params = new URLSearchParams({ lang });
  if (returnClip) params.set("clip", returnClip);
  const next = "/tts/?" + params;
  const login = $("login");
  login.href = pages ? canonical + next : "/auth/login?" + new URLSearchParams({ next });
  login.textContent = t(sessionState === "expired" ? "expired" : "login");
  login.hidden = Boolean(account) || sessionState === "loading";
  $("session-status").textContent = account ? t("signedIn") :
    sessionState === "loading" ? t("loading") : "";
}

function translate() {
  document.documentElement.lang = lang;
  document.title = t("title");
  document.querySelectorAll("[data-t]").forEach(node => { node.textContent = t(node.dataset.t); });
  $("languages").setAttribute("aria-label", t("languages"));
  for (const button of $("languages").children) {
    button.setAttribute("aria-pressed", String(button.lang === lang));
  }
  $("load-state").textContent = loadState ? t(loadState) : "";
  updateLogin();
  cards.forEach(updateCard);
}

for (const [code, label] of Object.entries(locales)) {
  const button = el("button", label, { type: "button", lang: code });
  button.onclick = () => {
    lang = code;
    writeLocal("c51-tts-lang", lang);
    const locationUrl = new URL(location.href);
    locationUrl.searchParams.set("lang", lang);
    history.replaceState(null, "", locationUrl);
    translate();
  };
  $("languages").append(button);
}

function addChoice(card, container, name, value, type) {
  const id = card.sample + "-" + name + "-" + value;
  const input = el("input", "", { id, type, name, value });
  input.required = type === "radio";
  const label = el("label", "", { for: id });
  container.append(input, label);
  return { input, label, value };
}

function hydrate(card) {
  if (!account) return;
  const saved = reviews.get(reviewKey(card));
  const stored = readLocal(localKey(card));
  // A timed-out request can already be committed when the page is reopened.
  if (stored?.request && stored.request === saved?.version) writeLocal(localKey(card), null);
  const draft = stored?.request && stored.request === saved?.version ? null : stored;
  card.draft = draft ?? {
    score: saved?.score ?? 0, verdict: saved?.verdict ?? "", wrong: saved?.wrong ?? [],
    notes: saved?.notes ?? "", base: saved?.version ?? null, request: null, queued: false
  };
  card.state = draft ? draft.base !== (saved?.version ?? null) ? "conflict" :
    draft.queued ? "queued" : "dirty" : saved ? "saved" : "ready";
}

function updateCard(card) {
  const { group, clip, node, form, draft } = card;
  const title = clip ? group.language.toUpperCase() + " " + clip.number + " · " + t(clip.topic) : t("legacy");
  node.querySelector("h3").textContent = title;
  if (clip) node.querySelector("audio").setAttribute("aria-label", title);
  const saved = reviews.has(reviewKey(card));
  const blocked = !account || card.busy;
  form.inert = blocked;
  for (const { input, label, value } of card.stars) {
    const filled = value <= draft?.score;
    input.checked = value === draft?.score;
    input.setAttribute("aria-label", value + "/5 · " + t("score" + value));
    label.textContent = filled ? "★" : "☆";
    label.classList.toggle("filled", filled);
  }
  for (const { input, label, value } of card.verdicts) {
    input.checked = value === draft?.verdict;
    label.textContent = t(value);
  }
  for (const { input, text, value } of card.wrong) {
    input.checked = Boolean(draft?.wrong.includes(value));
    text.textContent = clip ? t("wrongThis") : value + " · " + t(group.clips.find(item => item.number === value).topic);
  }
  const textarea = form.querySelector("textarea");
  if (textarea.value !== (draft?.notes ?? "")) textarea.value = draft?.notes ?? "";
  const submit = form.querySelector(".primary");
  submit.textContent = t(saved ? "update" : "submit");
  submit.disabled = blocked || card.conflicted || card.state === "conflict";
  const remove = form.querySelector("[data-remove]");
  remove.hidden = !saved || !account;
  remove.disabled = blocked || card.conflicted || card.state === "conflict";
  const reload = form.querySelector("[data-reload]");
  reload.hidden = !account || (!card.conflicted && card.state !== "conflict");
  reload.disabled = blocked;
  const status = node.querySelector(".status");
  const state = !account ? "loginNeeded" : card.busy ? "saving" : card.state;
  status.dataset.state = state;
  if (status.textContent !== t(state)) status.textContent = t(state);
}

function addCard(group, clip, section) {
  const node = $("clip-template").content.firstElementChild.cloneNode(true);
  const card = { group, clip, node, form: node.querySelector("form"),
    sample: clip ? clipId(group, clip) : group.id, revision: group.revision, state: "ready" };
  const { form } = card;
  if (clip) {
    node.id = card.sample;
    const transcript = node.querySelector(".transcript");
    transcript.textContent = clip.text;
    transcript.lang = group.language;
    const audio = node.querySelector("audio");
    const error = node.querySelector(".audio-error");
    audio.src = clip.src;
    audio.addEventListener("play", () => {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      returnClip = card.sample;
      updateLogin();
    });
    audio.addEventListener("error", () => { error.hidden = false; });
    node.querySelector("[data-audio-retry]").onclick = () => {
      error.hidden = true;
      audio.load();
      audio.play().catch(() => { error.hidden = false; });
    };
  } else {
    node.querySelector(".transcript").hidden = true;
    node.querySelector("audio").hidden = true;
  }
  const stars = form.querySelector(".stars");
  card.stars = [1, 2, 3, 4, 5].map(score => addChoice(card, stars, "score", score, "radio"));
  const verdicts = form.querySelector(".verdicts");
  card.verdicts = ["yes", "fix", "no"].map(value => addChoice(card, verdicts, "verdict", value, "radio"));
  const wrong = form.querySelector(".wrong");
  card.wrong = (clip ? [clip] : group.clips).map(item => {
    const choice = addChoice(card, wrong, "wrong", item.number, "checkbox");
    const text = el("span");
    choice.label.append(el("span", "", { class: "checkmark", "aria-hidden": "true" }), text);
    return { ...choice, text };
  });
  form.addEventListener("input", () => {
    const fields = new FormData(form);
    Object.assign(card.draft, { score: Number(fields.get("score") || 0), verdict: fields.get("verdict") || "",
      wrong: fields.getAll("wrong").map(Number), notes: form.querySelector("textarea").value,
      request: null, queued: false });
    writeLocal(localKey(card), card.draft);
    if (card.state === "conflict") card.conflicted = true;
    card.state = card.conflicted ? "conflict" : "dirty";
    updateCard(card);
  });
  form.onsubmit = event => { event.preventDefault(); void writeReview(card); };
  form.querySelector("[data-remove]").onclick = () => {
    if (confirm(t("confirmRemove"))) void writeReview(card, true);
  };
  form.querySelector("[data-reload]").onclick = () => {
    if (confirm(t("confirmReload"))) void reloadReview(card);
  };
  hydrate(card);
  cards.push(card);
  section.append(node);
}

function renderGroups(groups) {
  for (const group of groups) {
    const section = el("section", "", { class: "group" });
    const voice = el("p", "", { class: "voice" });
    voice.append(group.vendor + " · " + group.voice + " · ", el("span", "", { "data-t": group.register }),
      " · ", el("span", "", { "data-t": group.emotion }));
    section.append(el("h2", "", { "data-t": group.language }), voice);
    for (const clip of group.clips) addCard(group, clip, section);
    legacyGroups.push({ group, section });
    $("reviews").append(section);
  }
  ensureLegacyCards();
}

function ensureLegacyCards() {
  if (!account) return;
  for (const { group, section } of legacyGroups) {
    const key = { sample: group.id, revision: group.revision };
    if (!cards.some(card => card.sample === group.id) &&
        (reviews.has(reviewKey(key)) || readLocal(localKey(key)))) addCard(group, null, section);
  }
}

async function api(method = "GET", body) {
  const response = await fetch("api/reviews", {
    method, credentials: "same-origin", cache: "no-store",
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });
  if (!response.ok) throw Object.assign(new Error("review request failed"), { status: response.status });
  return response.json();
}

async function refresh() {
  const state = await api();
  if (account && account !== state.account) throw Object.assign(new Error("account changed"), { status: 401 });
  account = state.account;
  sessionState = "signedIn";
  reviews = new Map(state.reviews.map(row => [row.sample + ":" + row.revision, row]));
}

function expireSession() {
  account = null;
  reviews.clear();
  sessionState = "expired";
  for (const card of cards) {
    card.draft = null;
    card.node.hidden = !card.clip;
    updateCard(card);
  }
  updateLogin();
}

const authError = error => error.status === 401 || error.status === 403;

async function writeReview(card, remove = false) {
  if (!account || card.busy || card.conflicted || card.state === "conflict") return;
  const key = reviewKey(card);
  const draft = card.draft;
  const signedIn = account;
  const storedKey = localKey(card);
  const base = remove ? reviews.get(key)?.version : draft.base;
  if (remove && !base) return;
  if (!remove) {
    if (!draft.request) {
      draft.request = crypto.randomUUID();
      draft.language = lang;
    }
    draft.queued = true;
    writeLocal(storedKey, draft);
  }
  card.busy = true;
  updateCard(card);
  try {
    const result = await api(remove ? "DELETE" : "POST", {
      account: signedIn, sample: card.sample, revision: card.revision, base,
      ...(!remove && { version: draft.request, score: draft.score, verdict: draft.verdict,
        wrong: draft.wrong, notes: draft.notes.trim(), lang: draft.language })
    });
    writeLocal(storedKey, null);
    if (account !== signedIn) return;
    if (remove) reviews.delete(key);
    else reviews.set(key, result.review);
    hydrate(card);
    if (remove) {
      card.state = "removed";
      card.node.hidden = !card.clip;
    }
  } catch (error) {
    if (account !== signedIn) return;
    if (authError(error)) {
      if (card.clip) returnClip = card.sample;
      expireSession();
    } else {
      if (!remove) {
        draft.queued = !error.status || error.status >= 500;
        writeLocal(storedKey, draft);
      }
      card.conflicted = error.status === 409;
      card.state = card.conflicted ? "conflict" : !remove && draft.queued ? "queued" : "writeFailed";
    }
  } finally {
    card.busy = false;
    updateCard(card);
  }
}

async function reloadReview(card) {
  if (!account || card.busy) return;
  card.busy = true;
  updateCard(card);
  try {
    await refresh();
    writeLocal(localKey(card), null);
    card.conflicted = false;
    hydrate(card);
    if (!card.clip && !reviews.has(reviewKey(card))) card.node.hidden = true;
  } catch (error) {
    if (authError(error)) expireSession();
    else card.state = "loadingFailed";
  } finally {
    card.busy = false;
    updateCard(card);
  }
}

async function retryQueued() {
  if (retrying || !account || !navigator.onLine) return;
  retrying = true;
  try {
    for (const card of cards) {
      if (!account || !navigator.onLine) break;
      if (card.draft?.queued) await writeReview(card);
    }
  } finally {
    retrying = false;
  }
}
window.addEventListener("online", retryQueued);

async function start() {
  translate();
  const [manifest, session] = await Promise.allSettled([
    fetch("samples.json", { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error("catalogue unavailable");
      return response.json();
    }),
    pages ? Promise.resolve() : refresh()
  ]);
  if (!account) sessionState = "signedOut";
  const failed = manifest.status === "rejected" ||
    (session.status === "rejected" && !authError(session.reason));
  loadState = failed ? "loadingFailed" : "";
  if (manifest.status === "fulfilled") renderGroups(manifest.value.groups);
  translate();
  if (returnClip) $(returnClip)?.scrollIntoView();
  await retryQueued();
}
start();
