"use strict";

// Set to https://<project-ref>.supabase.co/functions/v1/uno-site-api.
const EDGE_FUNCTION_URL = "https://xnfudstmpejjmmwpqqgz.supabase.co/functions/v1/uno-site-api";
const SESSION_KEY = "uno-club-site-session";
const titles = { rules: "Uno Club Rules", schedule: "Games Schedule", bonus: "Bonus Hands Info", admin: "Admin" };
const permanentSchedule = [
  { day: "Monday", games: ["Hold Em", "Omaha"] },
  { day: "Wednesday", games: ["Omaha", "Tournament"] },
  { day: "Thursday", games: ["Hold Em", "Omaha"] },
];
const $ = (id) => document.getElementById(id);
let token = "";
let user = null;
let revision = 0; // Ignore responses for a page/session that has been left.

function status(message = "") { $("status").textContent = message; }
function saveToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(SESSION_KEY, value);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* Storage unavailable: keep this session only in memory. */ }
}
function show(view) {
  for (const name of ["login", "menu", "content"]) $(name + "-view").hidden = name !== view;
  $("logout").hidden = !user;
  $("admin-button").hidden = user?.is_admin !== true;
  $("change-pin-button").hidden = !user;
  $("menu-hint").hidden = !!user;
  $(view + "-title").focus();
}
function clearSession(message = "") {
  revision++;
  saveToken("");
  user = null;
  $("content").replaceChildren();
  $("content-title").textContent = "";
  $("login-form").reset();
  show("login");
  status(message);
}
async function api(action, fields = {}, session = token) {
  if (!EDGE_FUNCTION_URL) throw new Error("Member login is not available yet. Please check back soon.");
  const url = new URL(EDGE_FUNCTION_URL);
  if (url.protocol !== "https:") throw new Error("The site connection is not configured correctly.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session}` } : {}) },
      body: JSON.stringify({ action, ...fields }),
      cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) {
      let detail;
      if ([400, 404, 409].includes(response.status)) {
        try { const body = await response.json(); if (typeof body.error === "string" && body.error.length <= 300) detail = body.error; } catch {}
      }
      const error = new Error(detail || (response.status === 401
        ? (action === "login" ? "Username or PIN was not recognized." : "Your session has expired. Please log in again.")
        : response.status === 403 ? "You do not have access to this information."
        : response.status === 429 ? "Too many attempts. Please wait before trying again."
        : "The service is unavailable. Please try again later."));
      error.status = response.status;
      throw error;
    }
    try { return await response.json(); }
    catch { throw new Error("The service returned an unexpected response. Please try again later."); }
  } catch (error) {
    if (error instanceof TypeError || error.name === "AbortError") throw new Error("Unable to connect. Check your connection and try again.");
    throw error;
  } finally { clearTimeout(timeout); }
}
function validUser(value) {
  return value && typeof value.username === "string" && typeof value.is_admin === "boolean";
}
function card(title, body) {
  const element = document.createElement("article");
  element.className = "card";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const text = document.createElement("p");
  text.className = "body-text";
  text.textContent = body;
  element.append(heading, text);
  return element;
}
function reservationPhone(value) {
  if (typeof value !== "string") return "";
  const digits = value.replace(/[^0-9]/g, "");
  if (/^1[2-9][0-9]{9}$/.test(digits)) return `+${digits}`;
  if (/^[2-9][0-9]{9}$/.test(digits)) return `+1${digits}`;
  if (/^[1-9][0-9]{6,14}$/.test(digits)) return `+${digits}`;
  return "";
}
function renderPermanentSchedule(settings) {
  const phones = [...new Set([
    reservationPhone(settings?.reservation_phone_1),
    reservationPhone(settings?.reservation_phone_2),
  ].filter(Boolean))];
  const recipients = phones.join(",");
  const fragment = document.createDocumentFragment();
  for (const { day, games } of permanentSchedule) {
    const section = document.createElement("section");
    section.className = "schedule-day";
    const heading = document.createElement("h2");
    heading.textContent = day;
    section.append(heading);
    for (const game of games) {
      const row = document.createElement("div");
      row.className = "schedule-game";
      const name = document.createElement("span");
      name.textContent = game;
      row.append(name);
      if (recipients) {
        const link = document.createElement("a");
        link.className = "button reserve-button";
        const body = `I would like to reserve a seat for ${game} on ${day}.`;
        const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        link.href = `sms:${recipients}${ios ? "&" : "?"}body=${encodeURIComponent(body)}`;
        link.textContent = "Reserve Seat";
        row.append(link);
      } else {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = "Reservation unavailable";
        row.append(hint);
      }
      section.append(row);
    }
    fragment.append(section);
  }
  // Append sections directly so each day remains a distinct, accessible block.
  $("content").replaceChildren();
  for (const section of fragment.children) $("content").append(section);
}
function renderContent(page, data) {
  let items;
  if (page === "rules" && Array.isArray(data?.rules)) {
    items = data.rules.slice(0, 1).map((rule) => ({ title: titles.rules, body: rule?.body }));
  } else if (page === "bonus" && Array.isArray(data?.bonus_hands)) {
    items = data.bonus_hands.filter((hand) => hand && hand.is_active === true)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((hand) => ({
        title: hand.hand_name,
        body: [hand.payout_text, hand.description].filter((value) => typeof value === "string" && value).join("\n"),
      }));
  }
  if (!Array.isArray(items)) throw new Error("The service returned an unexpected response. Please try again later.");
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    if (!item || (page === "schedule"
      ? typeof item.name !== "string" || typeof item.day !== "string"
      : typeof item.title !== "string" || typeof item.body !== "string")) throw new Error("The service returned incomplete information. Please try again later.");
    const element = page === "schedule"
      ? card(item.name, [item.day, item.time, item.details].filter((v) => typeof v === "string" && v).join("\n"))
      : card(item.title, item.body);
    if (page === "schedule") {
      // Prefer a game-specific number; otherwise offer the configured contacts.
      const phones = [...new Set([
        item.reservation_phone || data.settings?.reservation_phone_1,
        item.reservation_phone ? null : data.settings?.reservation_phone_2,
      ].filter((phone) => typeof phone === "string" && /^\+[1-9][0-9]{6,14}$/.test(phone)))];
      for (const [index, phone] of phones.entries()) {
        const link = document.createElement("a");
        link.className = "button";
        const body = `I would like to reserve a seat for the ${item.name} game on ${item.day}.`;
        const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        link.href = `sms:${phone}${ios ? "&" : "?"}body=${encodeURIComponent(body)}`;
        link.textContent = phones.length > 1 ? `Request a seat by SMS (${index + 1})` : "Request a seat by SMS";
        element.append(link);
      }
      if (!phones.length) {
        const hint = document.createElement("p");
        hint.className = "hint";
        hint.textContent = "SMS seat requests are not available for this game yet.";
        element.append(hint);
      }
    }
    fragment.append(element);
  }
  if (!items.length) fragment.append(card("Nothing posted yet", "Please check back for updates."));
  $("content").replaceChildren(fragment);
}
async function navigate(page) {
  const current = ++revision;
  status();
  $("content").replaceChildren();
  if (page === "menu") { show("menu"); return; }
  if (!user) { show("login"); return; }
  if (!titles[page] || (page === "admin" && user.is_admin !== true)) { show("menu"); return; }
  $("content-title").textContent = titles[page];
  show("content");
  if (page === "admin") {
    adminMenu();
    return;
  }
  if (page === "schedule") {
    status("Loading…");
    try {
      const data = await api("member_settings");
      if (current !== revision) return;
      renderPermanentSchedule(data?.settings);
      status();
    } catch (error) {
      if (current !== revision) return;
      if (error.status === 401) { clearSession(error.message); return; }
      status(error.message);
      const retry = document.createElement("button");
      retry.className = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => navigate(page));
      $("content").append(retry);
    }
    return;
  }
  status("Loading…");
  try {
    const data = await api("bootstrap");
    if (current !== revision) return;
    if (!validUser(data?.user)) throw new Error("The service returned an incomplete user profile.");
    user = data.user;
    show("content");
    renderContent(page, data);
    status();
  } catch (error) {
    if (current !== revision) return;
    if (error.status === 401) { clearSession(error.message); return; }
    status(error.message);
    const retry = document.createElement("button");
    retry.className = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => navigate(page));
    $("content").append(retry);
  }
}
document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => navigate(button.dataset.page));
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = $("username").value.trim();
  const pin = $("pin").value;
  if (!username || !/^[0-9]{4}$/.test(pin)) { status("Enter your username and a four-digit PIN."); return; }
  const current = ++revision;
  $("login-submit").disabled = true;
  status("Logging in…");
  try {
    const data = await api("login", { username, pin }, "");
    if (current !== revision) return;
    if (typeof data?.session_token !== "string" || !data.session_token || !validUser(data)) throw new Error("The login response was incomplete. Please try again later.");
    saveToken(data.session_token);
    user = { username: data.username, display_name: data.display_name, is_admin: data.is_admin };
    $("login-form").reset();
    navigate("menu");
  } catch (error) { if (current === revision) status(error.message); }
  finally { $("pin").value = ""; $("login-submit").disabled = false; }
});
$("logout").addEventListener("click", async () => {
  const previousToken = token;
  clearSession("Logged out.");
  const current = revision;
  try { await api("logout", {}, previousToken); }
  catch { if (current === revision) status("Logged out on this device. Server sign-out could not be confirmed."); }
});
window.addEventListener("storage", (event) => {
  if (event.key === SESSION_KEY || event.key === null) clearSession("Your session changed in another tab. Please log in again.");
});
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
async function initialize() {
  try { token = localStorage.getItem(SESSION_KEY) || ""; } catch { token = ""; }
  if (!token) return;
  const current = ++revision;
  $("login-submit").disabled = true;
  status("Checking your session…");
  try {
    const data = await api("bootstrap");
    if (current !== revision) return;
    if (!validUser(data?.user)) throw new Error("Please log in again.");
    user = data.user;
    navigate("menu");
  } catch (error) { if (current === revision) clearSession(error.message); }
  finally { $("login-submit").disabled = false; }
}
$("change-pin-button").addEventListener("click", () => openAdmin("pin"));
initialize();
