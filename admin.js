"use strict";
const adminSections = { users: "Users", rules: "Rules", games: "Games Schedule", bonus: "Bonus Hands", settings: "Reservation Numbers", pin: "Change My PIN" };
function adminButton(label, fn, className = "button") {
  const button = document.createElement("button");
  button.type = "button"; button.className = className; button.textContent = label;
  button.addEventListener("click", fn); return button;
}
function adminMenu() {
  for (const [section, label] of Object.entries(adminSections)) $("content").append(adminButton(label, () => openAdmin(section), "button admin-menu-button"));
}
function adminForm(title, fields, values, submitLabel, onSubmit) {
  const form = document.createElement("form"); form.className = "card admin-form";
  const heading = document.createElement("h2"); heading.textContent = title; form.append(heading);
  const inputs = {};
  for (const [key, labelText, type = "text", required = true] of fields) {
    const label = document.createElement("label"); label.textContent = labelText;
    const input = document.createElement(type === "textarea" ? "textarea" : type === "boolean" ? "select" : "input");
    input.name = key;
    if (type === "boolean") {
      for (const [value, text] of [["true", "Yes"], ["false", "No"]]) {
        const option = document.createElement("option"); option.value = value; option.textContent = text; input.append(option);
      }
    } else if (type === "textarea") { input.rows = key === "body" ? 16 : 5; input.maxLength = key === "body" ? 100000 : 10000; }
    else {
      input.type = type;
      if (type === "password") { input.inputMode = "numeric"; input.pattern = "[0-9]{4}"; input.minLength = 4; input.maxLength = 4; input.autocomplete = key === "current_pin" ? "current-password" : "new-password"; }
      else if (type === "number") { input.step = "1"; input.min = "-100000"; input.max = "100000"; }
      else if (type === "time") input.step = "1";
      else input.maxLength = key === "username" ? 100 : key.startsWith("reservation_phone") ? 16 : key === "payout_text" ? 1000 : 200;
    }
    input.required = required;
    input.value = String(values[key] ?? (type === "boolean" ? true : type === "number" ? 0 : ""));
    label.append(input); form.append(label); inputs[key] = input;
  }
  const save = adminButton(submitLabel, () => {}); save.type = "submit"; form.append(save);
  const current = revision;
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (save.disabled || current !== revision) return;
    const payload = {};
    for (const [key, , type] of fields) payload[key] = type === "boolean" ? inputs[key].value === "true" : type === "number" ? Number(inputs[key].value) : inputs[key].value;
    if (payload.new_pin !== undefined && payload.new_pin !== payload.confirm_pin) { status("New PINs do not match."); return; }
    save.disabled = true; status("Saving…");
    try { await onSubmit(payload, current); }
    catch (error) { if (current === revision) { if (error.status === 401) clearSession(error.message); else status(error.message); } }
    finally { for (const [key, , type] of fields) if (type === "password") inputs[key].value = ""; save.disabled = false; }
  });
  return form;
}
async function saveAdmin(section, action, payload, current, memberPage) {
  const result = await api(action, payload);
  if (current !== revision) return;
  if (result?.ok !== true) throw new Error("The save could not be confirmed. Refresh before trying again.");
  if (memberPage) { await navigate(memberPage); if (revision === current + 1 && user && !$("status").textContent) status("Saved."); }
  else { await openAdmin(section); if (revision === current + 1 && user && !$("status").textContent) status("Saved."); }
}
async function adminDelete(section, action, id, label) {
  if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
  const current = revision;
  status("Deleting…");
  try { await saveAdmin(section, action, { id }, current); }
  catch (error) { if (current === revision) { if (error.status === 401) clearSession(error.message); else status(error.message); } }
}
async function openAdmin(section) {
  if (!user || (section !== "pin" && user.is_admin !== true)) return;
  const current = ++revision; status(); $("content").replaceChildren();
  $("content-title").textContent = adminSections[section]; show("content");
  $("content").append(adminButton(user.is_admin ? "← Back to Admin" : "← Back to Main Menu", () => navigate(user.is_admin ? "admin" : "menu"), "text-button back"));
  try {
    if (section === "pin") {
      $("content").append(adminForm("Change My PIN", [["current_pin", "Current PIN", "password"], ["new_pin", "New 4-digit PIN", "password"], ["confirm_pin", "Confirm new PIN", "password"]], {}, "Change PIN", (p, r) => saveAdmin(section, "change_pin", p, r)));
      return;
    }
    status("Loading…");
    const data = await api({users:"admin_users",rules:"admin_rules",games:"admin_games",bonus:"admin_bonus",settings:"admin_settings"}[section]);
    if (current !== revision) return;
    const key = {users:"users",rules:"rules",games:"game_schedule",bonus:"bonus_hands",settings:"settings"}[section];
    if (section === "settings" ? !data?.settings || typeof data.settings !== "object" : !Array.isArray(data?.[key])) throw new Error("The service returned incomplete information.");
    status();
    if (section === "users") {
      $("content").append(adminForm("Add user", [["username","Username"],["display_name","Display name"],["pin","4-digit PIN","password"],["is_admin","Administrator?","boolean"]], {is_admin:false}, "Add user", (p,r) => saveAdmin(section,"admin_add_user",p,r)));
      for (const member of data.users) {
        const own = member.id === data.current_user_id;
        const item = card(member.username, `${member.display_name}\nAdministrator: ${member.is_admin ? "Yes" : "No"}\nActive: ${member.is_active ? "Yes" : "No"}\nCreated: ${new Date(member.created_at).toLocaleDateString()}`);
        if (own) item.append(adminButton("Change My PIN", () => openAdmin("pin")));
        else {
          const toggle = adminButton(member.is_active ? "Disable user" : "Reactivate user", async () => {
            if (member.is_active && !window.confirm(`Disable ${member.username}? Their sessions will end.`)) return;
            toggle.disabled = true;
            try { await saveAdmin(section,"admin_user_active",{id:member.id,is_active:!member.is_active},current); }
            catch(error) { if (current === revision) { if(error.status===401) clearSession(error.message); else status(error.message); } }
            finally { toggle.disabled = false; }
          });
          item.append(toggle, adminForm("Reset PIN", [["pin","New 4-digit PIN","password"]], {}, "Reset PIN", (p,r) => saveAdmin(section,"admin_reset_pin",{...p,id:member.id},r)));
        }
        $("content").append(item);
      }
    } else if (section === "rules") {
      $("content").append(adminForm("Uno Club rules", [["body","Rules","textarea",false]], data.rules[0] || {}, "Save rules", (p,r) => saveAdmin(section,"admin_save_rules",p,r,"rules")));
    } else if (section === "settings") {
      $("content").append(card("Reservation contacts", "Use a 10-digit US number or international format. Leave blank to remove a contact."), adminForm("Reservation Numbers", [["reservation_phone_1","Phone number 1","tel",false],["reservation_phone_2","Phone number 2","tel",false]], data.settings, "Save numbers", (p,r) => saveAdmin(section,"admin_save_settings",p,r)));
    } else {
      const games = section === "games";
      const fields = games ? [["day_name","Day"],["day_sort","Day order","number"],["game_name","Game name"],["start_time","Start time","time",false],["sort_order","Display order","number"],["is_active","Active?","boolean"]] : [["hand_name","Hand name"],["payout_text","Payout","text",false],["description","Description","textarea",false],["sort_order","Display order","number"],["is_active","Active?","boolean"]];
      const action = games ? "admin_save_game" : "admin_save_bonus";
      $("content").append(adminForm(games ? "Add game" : "Add bonus hand", fields, {}, "Add", (p,r) => saveAdmin(section,action,p,r)));
      for (const row of data[key]) {
        const name = games ? row.game_name : row.hand_name;
        const form = adminForm(`Edit ${name}`, fields, row, "Save changes", (p,r) => saveAdmin(section,action,{...p,id:row.id},r));
        form.append(adminButton("Delete", () => adminDelete(section,games ? "admin_delete_game" : "admin_delete_bonus",row.id,name),"button danger"));
        $("content").append(form);
      }
    }
  } catch(error) {
    if(current !== revision) return;
    if(error.status === 401) clearSession(error.message);
    else { status(error.message); $("content").append(adminButton("Try again", () => openAdmin(section))); }
  }
}
