import { locales, strings } from "./strings.js";

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

const sessionLink = new URL(location.href);
const requestedLang = sessionLink.searchParams.get("lang") || readLocal("c51-tts-lang");
let lang = Object.hasOwn(locales, requestedLang) ? requestedLang : "zh";
let groups = [];
let active;
let account;
let reviews = new Map();
let drafts = new Map();
let busy = false;
let writeState = "";
let loadState = "loading";
let audioState = "";
let needsRefresh = false;

const t = key => strings[lang][key];
const clipId = (group, clip) => group.id + "-" + clip.number;
const reviewKey = group => group.id + ":" + group.revision;
const localKey = group => "c51-tts-draft:" + account + ":" + reviewKey(group);
const voiceLabel = group => [group.vendor, group.voice, t(group.register), t(group.emotion)].join(" · ");

function el(tag, text, attrs = {}) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  for (const [name, value] of Object.entries(attrs)) item.setAttribute(name, value);
  return item;
}

function linkFor(id) {
  const u = new URL("./", location.href);
  u.searchParams.set("lang", lang);
  if (id) u.searchParams.set("clip", id);
  return u;
}

function loginLink(id) {
  const u = linkFor(id);
  if (pages) return canonical + "/tts/" + u.search;
  return "/auth/login?" + new URLSearchParams({ next: "/tts/" + u.search });
}

function updateLanguage() {
  document.documentElement.lang = lang;
  document.title = t("title");
  document.querySelectorAll("[data-t]").forEach(node => { node.textContent = t(node.dataset.t); });
  $("languages").setAttribute("aria-label", t("languages"));
  $("segments").setAttribute("aria-label", t("segments"));
  $("languages").replaceChildren(...Object.entries(locales).map(([code, label]) => {
    const button = el("button", label, { type: "button", lang: code, "aria-pressed": String(lang === code) });
    button.onclick = () => {
      lang = code;
      writeLocal("c51-tts-lang", lang);
      history.replaceState(null, "", linkFor(active && clipId(active.group, active.clip)));
      render();
      $("languages").querySelector('[aria-pressed="true"]').focus();
    };
    return button;
  }));
}

function renderList() {
  $("load-state").textContent = loadState ? t(loadState) : "";
  $("login-home").hidden = Boolean(account) || !pages;
  $("login-home").href = loginLink();
  $("directory").replaceChildren(...groups.map(group => {
    const section = el("section", "", { class: "group" });
    const saved = reviews.get(reviewKey(group));
    const title = el("h2", t(group.language));
    if (saved) title.append(el("span", t("saved") + " · " + t(saved.verdict), { class: "status " + saved.verdict }));
    const cards = el("div", "", { class: "cards" });
    for (const clip of group.clips) {
      const open = el("a", "", { class: "card", href: linkFor(clipId(group, clip)) });
      open.append(el("span", group.language.toUpperCase() + " " + clip.number, { class: "number" }),
        el("strong", t(clip.topic)), el("span", "▶", { class: "play", "aria-hidden": "true" }));
      open.onclick = event => {
        if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        navigate(clipId(group, clip));
        $("clip-title").focus({ preventScroll: true });
      };
      cards.append(open);
    }
    section.append(title, el("p", voiceLabel(group), { class: "meta" }), cards);
    return section;
  }));
}

function renderPlayer() {
  const { group, clip } = active;
  $("player-title").textContent = t(group.language) + " · " + group.voice;
  $("clip-meta").textContent = voiceLabel(group);
  $("clip-title").textContent = group.language.toUpperCase() + " " + clip.number + " · " + t(clip.topic);
  $("transcript").textContent = clip.text;
  $("transcript").lang = group.language;
  $("download").href = clip.src;
  $("audio").setAttribute("aria-label", $("clip-title").textContent);
  $("audio-state").textContent = audioState ? t(audioState) : "";
  $("segments").replaceChildren(...group.clips.map(item => {
    const button = el("button", item.number, {
      type: "button", "aria-label": item.number + " · " + t(item.topic), "aria-pressed": String(item === clip)
    });
    button.onclick = () => {
      if (item === clip && audioState) {
        audioState = "";
        $("audio-state").textContent = "";
        $("audio").load();
      } else if (item !== clip) {
        navigate(clipId(group, item), false);
        $("segments").querySelector('[aria-pressed="true"]').focus();
      }
    };
    return button;
  }));

  $("login-player").hidden = Boolean(account);
  $("login-player").href = loginLink(clipId(group, clip));
  $("review-state").textContent = writeState ? t(writeState) : account ? "" : t("loginNeeded");
  $("form").hidden = !account;
  if (account) renderForm(group);
}

function getDraft(group) {
  const key = reviewKey(group);
  if (!drafts.has(key)) {
    const stored = readLocal(localKey(group));
    const saved = reviews.get(key);
    drafts.set(key, stored ?? { score: saved?.score ?? 0, verdict: saved?.verdict ?? "",
      wrong: saved?.wrong ?? [], notes: saved?.notes ?? "", base: saved?.version ?? null, request: null });
  }
  return drafts.get(key);
}

function choices(id, name, values, type, required = false) {
  $(id).replaceChildren(...values.flatMap(([value, label, description]) => {
    const inputId = name + "-" + value;
    const input = el("input", "", { id: inputId, type, name, value });
    input.required = required;
    if (description) input.setAttribute("aria-label", description);
    return [input, el("label", label, { for: inputId })];
  }));
}

function setScoreLabel(score) {
  for (const label of $("stars").querySelectorAll("label")) {
    const filled = Number(label.control.value) <= score;
    label.textContent = filled ? "★" : "☆";
    label.classList.toggle("filled", filled);
  }
  $("score-label").textContent = score ? score + "/5 · " + t("score" + score) : "";
}

function renderForm(group) {
  const draft = getDraft(group);
  choices("stars", "score", [1, 2, 3, 4, 5].map(n => [n, "☆", n + "/5 · " + t("score" + n)]), "radio", true);
  choices("verdicts", "verdict", ["yes", "fix", "no"].map(key => [key, t(key)]), "radio", true);
  choices("wrong-segments", "wrong", group.clips.map(clip => [clip.number, clip.number + " · " + t(clip.topic)]), "checkbox");
  for (const score of $("stars").querySelectorAll("input")) score.checked = Number(score.value) === draft.score;
  for (const verdict of $("verdicts").querySelectorAll("input")) verdict.checked = verdict.value === draft.verdict;
  for (const wrong of $("wrong-segments").querySelectorAll("input")) wrong.checked = draft.wrong.includes(Number(wrong.value));
  $("notes").value = draft.notes;
  setScoreLabel(draft.score);
  const saved = reviews.has(reviewKey(group));
  $("remove").hidden = !saved;
  $("reload").hidden = !needsRefresh;
  $("form").querySelector(".primary").textContent = t(saved ? "update" : "submit");
  $("form").inert = busy;
}

function render() {
  updateLanguage();
  $("home").hidden = Boolean(active);
  $("player").hidden = !active;
  if (active) renderPlayer();
  else renderList();
}

function openLocation() {
  const id = new URL(location.href).searchParams.get("clip");
  const group = groups.find(candidate => candidate.clips.some(clip => clipId(candidate, clip) === id));
  const clip = group?.clips.find(item => clipId(group, item) === id);
  if (active?.clip !== clip) {
    $("audio").pause();
    audioState = "";
    if (clip) $("audio").src = clip.src;
    else $("audio").removeAttribute("src");
  }
  if (group !== active?.group) {
    const draft = group && account ? getDraft(group) : null;
    const saved = group && reviews.get(reviewKey(group));
    needsRefresh = Boolean(draft && draft.base !== (saved?.version ?? null));
    writeState = needsRefresh ? "conflict" : draft?.queued ? "queued" :
      group && account && readLocal(localKey(group)) ? "dirty" : saved ? "saved" : "";
  }
  active = group && { group, clip };
  render();
}

function navigate(id, addHistory = true) {
  history[addHistory ? "pushState" : "replaceState"](null, "", linkFor(id));
  openLocation();
  if (addHistory) window.scrollTo(0, 0);
}

async function api(path, method = "GET", body) {
  const response = await fetch("api/" + path, {
    method, credentials: "same-origin", cache: "no-store",
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });
  if (!response.ok) throw Object.assign(new Error("review request failed"), { status: response.status });
  return response.json();
}

async function refresh() {
  const state = await api("reviews");
  if (account && account !== state.account) {
    account = null;
    drafts.clear();
    reviews.clear();
    throw Object.assign(new Error("account changed"), { status: 401 });
  }
  account = state.account;
  reviews = new Map(state.reviews.map(row => [row.sample + ":" + row.revision, row]));
}

$("form").addEventListener("input", () => {
  const group = active.group;
  const draft = getDraft(group);
  const fields = new FormData($("form"));
  Object.assign(draft, { score: Number(fields.get("score") || 0), verdict: fields.get("verdict") || "",
    wrong: fields.getAll("wrong").map(Number), notes: $("notes").value, request: null, queued: false });
  writeLocal(localKey(group), draft);
  setScoreLabel(draft.score);
  writeState = needsRefresh ? "conflict" : "dirty";
  $("review-state").textContent = t(writeState);
});

async function writeReview(remove, group = active?.group) {
  if (busy || !account || !group || (remove && needsRefresh)) return;
  const editing = () => active?.group === group;
  const key = reviewKey(group);
  const draft = getDraft(group);
  if (remove && !confirm(t("confirmRemove"))) return;
  const { score, verdict, wrong, notes } = draft;
  const base = remove ? reviews.get(key)?.version : draft.base;
  if (base !== (reviews.get(key)?.version ?? null) && draft.request !== reviews.get(key)?.version) return;
  if (!remove) {
    if (!draft.request) {
      draft.request = crypto.randomUUID();
      draft.language = lang;
    }
    draft.queued = true;
    writeLocal(localKey(group), draft);
  }
  busy = true;
  if (editing()) writeState = "loading";
  if (active) renderPlayer();
  try {
    const result = await api("reviews", remove ? "DELETE" : "POST", {
      account, sample: group.id, revision: group.revision, base,
      ...(!remove && { version: draft.request, score, verdict, wrong, notes: notes.trim(), lang: draft.language })
    });
    if (remove) reviews.delete(key);
    else reviews.set(key, result.review);
    drafts.delete(key);
    writeLocal(localKey(group), null);
    if (editing()) {
      needsRefresh = false;
      writeState = remove ? "removed" : "saved";
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      account = null;
      drafts.clear();
      reviews.clear();
      writeState = "expired";
    } else {
      if (!remove) {
        draft.queued = !error.status || error.status >= 500;
        writeLocal(localKey(group), draft);
      }
      if (editing()) {
        needsRefresh = error.status === 409;
        writeState = needsRefresh ? "conflict" : !remove && draft.queued ? "queued" : "writeFailed";
      }
    }
  } finally {
    busy = false;
    render();
  }
}

$("form").onsubmit = event => { event.preventDefault(); writeReview(false); };
$("remove").onclick = () => writeReview(true);
$("reload").onclick = async () => {
  if (!active || !account || !confirm(t("confirmReload"))) return;
  const group = active.group;
  try {
    await refresh();
    drafts.delete(reviewKey(group));
    writeLocal(localKey(group), null);
    if (active?.group === group) {
      needsRefresh = false;
      writeState = reviews.has(reviewKey(group)) ? "saved" : "";
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      account = null;
      drafts.clear();
      reviews.clear();
      writeState = "expired";
    } else writeState = "loadingFailed";
  }
  render();
};

$("audio").addEventListener("error", () => {
  if (!active) return;
  audioState = "playbackFailed";
  $("audio-state").textContent = t(audioState);
});
$("back").onclick = () => {
  const id = clipId(active.group, active.clip);
  navigate(null, false);
  [...$("directory").querySelectorAll("a")].find(link => new URL(link.href).searchParams.get("clip") === id)?.focus();
};
window.addEventListener("popstate", openLocation);

async function retryQueued() {
  for (const group of groups) {
    if (!account || busy || !navigator.onLine) return;
    if (getDraft(group).queued) await writeReview(false, group);
  }
}
window.addEventListener("online", retryQueued);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && active && !busy) $("back").click();
});

async function start() {
  render();
  const [manifest, session] = await Promise.allSettled([
    fetch("samples.json", { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error("catalogue unavailable");
      return response.json();
    }),
    pages ? Promise.resolve() : refresh()
  ]);
  if (manifest.status === "fulfilled") {
    groups = manifest.value.groups;
    loadState = "";
  } else loadState = "loadingFailed";
  if (session.status === "rejected" && session.reason.status !== 401) loadState = "loadingFailed";
  openLocation();
  await retryQueued();
}
start();
