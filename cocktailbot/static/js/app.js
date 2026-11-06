/* CocktailBot Frontend - eine einzige SPA ohne Framework. */
const CB = (() => {
  let state = {recipes: [], ingredients: [], pumps: [], settings: {}, stats: {}, status: {}, mock: false};
  let cat = "cocktails";
  let detail = null;      // aktuell geöffnetes Rezept
  let detailSize = null, detailStrength = 1.0;
  let pollTimer = null;
  let doneTimer = null;

  const $ = (s, r = document) => r.querySelector(s);
  const el = (h) => {const d = document.createElement("div"); d.innerHTML = h.trim(); return d.firstChild;};
  // Tabellenzeilen müssen in einem <table>-Kontext geparst werden, sonst
  // verwirft der Browser das <tr>.
  const elRow = (h) => {const t = document.createElement("table"); t.innerHTML = "<tbody>" + h.trim() + "</tbody>"; return t.querySelector("tr");};
  const api = async (url, opt) => (await fetch(url, opt)).json();
  const post = (url, body) => api(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body || {})});

  function toast(msg, err) {
    const t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : "");
    t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, 3000);
  }

  // ---- Farben für Platzhalterbilder (deterministisch aus Name) ----
  function hue(s){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))%360;return h;}
  function phBg(name){const h=hue(name);return `linear-gradient(135deg,hsl(${h} 70% 45%),hsl(${(h+40)%360} 75% 35%))`;}
  function imgStyle(r){
    // Bild aus /static/images/cocktails/<image>, Fallback: farbiger Platzhalter.
    return r.image ? `background-image:url('/img/cocktail/${encodeURIComponent(r.image)}')` : "";
  }
  // Mini-Vorschau einer Zutat (Bild aus /static/images/ingredients/, sonst Buchstabe)
  function ingThumb(i){
    const t = document.createElement("div");
    t.className = "ing-thumb";
    if (i.image) {
      const im = document.createElement("img");
      im.src = "/img/ingredient/" + encodeURIComponent(i.image);
      im.onerror = () => { t.innerHTML = ""; t.style.background = phBg(i.name); t.textContent = (i.name||"?")[0]; };
      t.appendChild(im);
    } else { t.style.background = phBg(i.name); t.textContent = (i.name||"?")[0]; }
    return t;
  }

  // Preis für ein Rezept bei einer Größe ermitteln (Hierarchie wie besprochen).
  function priceFor(r, size) {
    const p = state.settings.prices || {};
    if (!p.enabled) return null;
    if ((p.free || []).map(Number).includes(Number(r.id))) return 0;
    const cat = r.category || "cocktails";
    const pick = (v) => (v !== undefined && v !== null && v !== "") ? +v : null;
    const cs = pick((p.category_size || {})[cat + "|" + size]);   // Kategorie+Größe überwiegt
    if (cs !== null) return cs;
    const rs = pick((p.recipe_size || {})[r.id + "|" + size]);
    if (rs !== null) return rs;
    const rp = pick((p.recipe || {})[r.id]);
    if (rp !== null) return rp;
    return pick((p.category_default || {})[cat]);
  }
  function curSym() { return (state.settings.prices || {}).currency || "€"; }
  function fmtPrice(v) { return v === 0 ? "Gratis" : v.toFixed(2).replace(".", ",") + " " + curSym(); }

  async function load() {
    state = await api("/api/state");
    try { state.payConfig = await api("/api/pay/config"); } catch { state.payConfig = {enabled: false}; }
    document.body.classList.toggle("kiosk", !!state.kiosk);
    $("#mockBadge").className = "status-dot" + (state.mock ? " mock" : "");
    $("#mockBadge").title = state.mock ? "Mock-Modus (keine echten Pumpen)" : "Hardware aktiv";
    if ($("#appVer")) $("#appVer").textContent = state.version ? "v" + state.version : "";
    render();
    // Falls gerade etwas läuft -> Fortschritt zeigen
    if (state.status && state.status.state === "running") startPolling();
  }

  function render() {
    document.querySelectorAll("#tabs button").forEach(b =>
      b.classList.toggle("active", b.dataset.cat === cat));
    const m = $("#main");
    if (cat === "settings") { m.innerHTML = ""; m.appendChild(renderSettings()); return; }
    renderCocktails(m);
  }

  function ingName(id){const i=state.ingredients.find(x=>x.id===id);return i?i.name:("#"+id);}

  function sortRecipes(list) {
    const mode = state.settings.recipe_sort_mode || "original";
    const by = {
      original: (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
      name: (a, b) => a.name.localeCompare(b.name, "de"),
      abv: (a, b) => (b.abv || 0) - (a.abv || 0),
      availability: (a, b) => (b.available - a.available) || (a.sort_order ?? 0) - (b.sort_order ?? 0),
    }[mode] || ((a, b) => 0);
    return [...list].sort(by);
  }

  function renderCocktails(m) {
    const hideUnavail = !!state.settings.hide_unavailable;
    const list = sortRecipes(state.recipes.filter(r =>
      (r.category || "cocktails") === cat
      && !r.hidden                              // Pumpe deaktiviert -> immer aus
      && (!hideUnavail || r.available)));       // Button: nur zapfbare zeigen
    const grid = el('<div class="grid"></div>');
    if (!list.length) grid.innerHTML = '<p style="color:var(--muted)">Keine Rezepte in dieser Kategorie.</p>';
    list.forEach(r => {
      const card = el(`<div class="card ${r.available ? "" : "unavailable"}"></div>`);
      const abv = r.abv > 0 ? `<div class="badge abv">${r.abv}%</div>` : "";
      const warn = r.available ? "" : `<div class="badge warn">!</div>`;
      const imgInner = r.image
        ? `<div class="img" style="${imgStyle(r)}">${abv}${warn}</div>`
        : `<div class="img" style="${imgStyle(r)}"><div class="ph" style="background:${phBg(r.name)}">${r.name[0]}</div>${abv}${warn}</div>`;
      // Preis bei Standardgröße (falls Preise aktiv)
      const pr = priceFor(r, state.settings.default_size_ml || (state.settings.sizes_ml || [300])[0]);
      const priceLine = pr !== null ? `<div class="price">${fmtPrice(pr)}</div>` : "";
      // Fallback, falls das Bild nicht lädt:
      card.innerHTML = `${imgInner}<div class="body"><div class="name">${r.name}</div>
        <div class="meta">${r.description || ""}</div>${priceLine}</div>`;
      const imgEl = card.querySelector(".img");
      if (r.image) {
        const probe = new Image();
        probe.onerror = () => { imgEl.style.backgroundImage = "none";
          imgEl.insertAdjacentHTML("afterbegin",
            `<div class="ph" style="background:${phBg(r.name)}">${r.name[0]}</div>`); };
        probe.src = `/img/cocktail/${encodeURIComponent(r.image)}`;
      }
      card.onclick = () => openDetail(r);
      grid.appendChild(card);
    });
    m.innerHTML = ""; m.appendChild(grid);
  }

  // ---- Detail / Zubereitung ----
  function openDetail(r) {
    detail = r;
    const sizes = state.settings.sizes_ml || [200, 300, 400];
    detailSize = state.settings.default_size_ml || sizes[0];
    detailStrength = 1.0;
    const sheet = $("#detailSheet");
    const alcoholic = r.abv > 0;
    const strengthRow = (alcoholic && state.settings.strength_enabled) ? `
      <div class="row" style="flex-direction:column;align-items:stretch">
        <label>Stärke: <span class="strength-val" id="strVal">100%</span></label>
        <input type="range" min="25" max="150" step="1" value="100" id="strRange" list="strTicks">
        <datalist id="strTicks">
          <option value="25"></option><option value="50"></option><option value="100"></option>
          <option value="125"></option><option value="150"></option>
        </datalist>
        <div class="row" id="strPresets" style="margin-top:6px">
          ${[25,50,100,125,150].map(v => `<button class="chip" style="padding:8px 14px" data-str="${v}">${v}%</button>`).join("")}
        </div>
      </div>` : "";
    sheet.innerHTML = `
      <h2>${r.name}</h2>
      <p class="desc">${r.description || ""}</p>
      <div class="row" id="sizeRow">${sizes.map(s =>
        `<button class="chip ${s === detailSize ? "sel" : ""}" data-size="${s}">${s} ml</button>`).join("")}</div>
      ${strengthRow}
      <div id="ingList"></div>
      ${r.available ? "" : `<p style="color:var(--danger)">${(r.issues || []).join("; ")}</p>`}
      <div id="detailPrice" class="detail-price"></div>
      <div class="btn-row">
        <button class="btn ghost" onclick="CB.closeDetail()">Zurück</button>
        <button class="btn primary" style="flex:1" id="goBtn" ${r.available ? "" : "disabled"}>Zubereiten</button>
      </div>`;
    const updatePrice = () => {
      const pe = sheet.querySelector("#detailPrice");
      const pr = priceFor(r, detailSize);
      pe.textContent = pr === null ? "" : (pr === 0 ? "Gratis" : "Preis: " + fmtPrice(pr));
    };
    sheet.querySelectorAll("[data-size]").forEach(b => b.onclick = () => {
      detailSize = +b.dataset.size;
      sheet.querySelectorAll("[data-size]").forEach(x => x.classList.toggle("sel", +x.dataset.size === detailSize));
      renderIngList(); updatePrice();
    });
    updatePrice();
    const sr = sheet.querySelector("#strRange");
    const setStr = (v) => { sr.value = v; detailStrength = v / 100; $("#strVal").textContent = v + "%"; renderIngList(); };
    if (sr) {
      sr.oninput = () => setStr(+sr.value);
      sheet.querySelectorAll("#strPresets [data-str]").forEach(b =>
        b.onclick = () => setStr(+b.dataset.str));
    }
    sheet.querySelector("#goBtn").onclick = prepare;
    renderIngList();
    $("#detailModal").hidden = false;
  }
  function renderIngList() {
    const base = detail.ingredients.reduce((a, i) => a + i.amount_ml, 0) || 1;
    const f = detailSize / base;
    const list = $("#ingList"); list.innerHTML = "";
    detail.ingredients.forEach(i => {
      const manual = i.manual || !(state.ingredients.find(x => x.id === i.ingredient_id) || {automatic: true}).automatic;
      let ml = i.amount_ml * f;
      list.appendChild(el(`<div class="ing-line ${manual ? "manual" : ""}">
        <span>${ingName(i.ingredient_id)}${manual ? " (manuell)" : ""}</span>
        <span>${ml < 1 ? "" : Math.round(ml) + " ml"}</span></div>`));
    });
  }
  function closeDetail(){ $("#detailModal").hidden = true; detail = null; }

  async function prepare() {
    // Bezahlung nötig? (PayPal aktiv und Preis > 0)
    const pr = priceFor(detail, detailSize);
    const payOn = state.payConfig && state.payConfig.enabled;
    if (payOn && pr !== null && pr > 0) {
      return startCheckout(detail, detailSize, detailStrength);
    }
    await startPrepare({recipe_id: detail.id, size_ml: detailSize, strength: detailStrength});
  }

  async function startPrepare(body) {
    const res = await post("/api/prepare", body);
    if (!res.ok) { toast(res.error || "Fehler", true); return; }
    closeDetail();
    $("#progTitle").textContent = res.title || "Zubereitung";
    $("#progDone").hidden = true; $("#stopBtn").hidden = false;
    $("#progFill").style.width = "0%"; $("#progMsg").textContent = "Start...";
    $("#progressModal").hidden = false;
    startPolling();
  }

  // ---- PayPal-Checkout ----
  let checkoutTimer = null;
  async function startCheckout(recipe, size, strength) {
    const r = await post("/api/pay/create", {recipe_id: recipe.id, size_ml: size, strength});
    if (!r.ok) { toast(r.error || "Zahlung fehlgeschlagen", true); return; }
    if (r.free) { closeCheckout(); return startPrepare({recipe_id: recipe.id, size_ml: size, strength}); }
    const sheet = $("#checkoutSheet");
    const amount = (+r.amount).toFixed(2).replace(".", ",") + " " + curSym();
    const qr = state.payConfig.qr
      ? `<img class="qr" src="/api/pay/qr/${r.order_id}" alt="QR">`
      : `<a class="qr-link" href="${r.approval_url}" target="_blank">Zahlungslink öffnen</a>`;
    sheet.innerHTML = `
      <h2>${recipe.name}</h2>
      <div class="pay-amount">${amount}</div>
      <p class="desc" id="payMsg">${r.test ? "Testmodus – Zahlung simulieren" : "QR-Code scannen und mit PayPal bezahlen"}</p>
      <div class="qr-wrap">${qr}</div>
      ${r.test ? `<button class="btn primary big" id="paySim">Zahlung simulieren</button>` : ""}
      <button class="btn ghost big" id="payCancel">Abbrechen</button>`;
    $("#checkoutModal").hidden = false;
    closeDetail();
    const sim = sheet.querySelector("#paySim");
    if (sim) sim.onclick = async () => { await post("/api/pay/simulate/" + r.order_id); };
    sheet.querySelector("#payCancel").onclick = closeCheckout;
    // Status pollen
    clearInterval(checkoutTimer);
    checkoutTimer = setInterval(async () => {
      const s = await api("/api/pay/status/" + r.order_id);
      if (s.status === "paid") {
        clearInterval(checkoutTimer);
        $("#payMsg").textContent = "Bezahlung erfolgreich!";
        const pr2 = await post("/api/pay/prepare", {order_id: r.order_id});
        closeCheckout();
        if (pr2.ok) {
          $("#progTitle").textContent = pr2.title || "Zubereitung";
          $("#progDone").hidden = true; $("#stopBtn").hidden = false;
          $("#progFill").style.width = "0%"; $("#progMsg").textContent = "Start...";
          $("#progressModal").hidden = false; startPolling();
        } else { toast(pr2.error || "Fehler", true); }
      }
    }, 2000);
  }
  function closeCheckout() { $("#checkoutModal").hidden = true; clearInterval(checkoutTimer); }

  function startPolling() {
    $("#progressModal").hidden = false;
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const s = await api("/api/status");
      $("#progFill").style.width = (s.progress || 0) + "%";
      $("#progMsg").textContent = s.message || "";
      // alle Zutaten anzeigen, fertige abgehakt
      const pi = $("#progItems");
      if (pi) {
        pi.innerHTML = "";
        (s.items || []).forEach(it => pi.appendChild(el(
          `<div class="m ${it.done ? "done" : ""}">${it.done ? "✓" : "•"} ${it.name} (${it.amount_ml} ml)${it.delayed ? " – zum Schluss" : ""}</div>`)));
      }
      if (s.state === "done") {
        clearInterval(pollTimer);
        $("#stopBtn").hidden = true;
        if (pi) pi.innerHTML = "";
        const dl = $("#manualList"); dl.innerHTML = "";
        (s.manual || []).forEach(m => {
          // Hinweis hat Vorrang; sonst die (hochgerechnete) Menge zeigen.
          const detail = m.instruction ? " &ndash; " + m.instruction
            : (m.amount_ml ? " (" + Math.round(m.amount_ml) + " ml)" : "");
          dl.appendChild(el(`<div class="m">+ ${m.name}${detail}</div>`));
        });
        (s.instructions || []).forEach(t => dl.appendChild(el(`<div class="m">${t}</div>`)));
        $("#progDone").hidden = false;
        // Fertig-Meldung nach 20 s automatisch schließen
        clearTimeout(doneTimer);
        doneTimer = setTimeout(() => ack(), 20000);
      } else if (s.state === "error") {
        clearInterval(pollTimer); toast(s.message || "Fehler", true); ack();
      } else if (s.state === "idle") {
        clearInterval(pollTimer); $("#progressModal").hidden = true;
      }
    }, 400);
  }
  async function ack(){ clearTimeout(doneTimer); await post("/api/ack"); $("#progressModal").hidden = true; clearInterval(pollTimer); load(); }
  async function stop(){ await post("/api/stop"); toast("Gestoppt"); }

  // =================== EINSTELLUNGEN ===================
  let settingsView = "overview";
  let updateInfo = null;        // Ergebnis der letzten Update-Pruefung
  let updateBusy = false;       // laeuft gerade eine Pruefung/Update?
  function renderSettings() {
    const wrap = el('<div></div>');
    const views = {
      overview: settingsOverview, calibration: settingsPumps, levels: settingsLevels,
      clean: settingsClean, ingredients: settingsIngredients, recipes: settingsRecipes,
      pumps: settingsPumps, api: settingsApi, stats: settingsStats, general: settingsGeneral,
      prices: settingsPrices, wled: settingsWled, party: settingsParty,
      updates: settingsUpdates, backup: settingsBackup,
    };
    wrap.appendChild((views[settingsView] || settingsOverview)());
    return wrap;
  }
  function goSettings(v){ settingsView = v; render(); }

  function settingsOverview() {
    const tiles = [
      ["levels", "Füllstände", "Stand setzen & nachfüllen"],
      ["clean", "Reinigung & Entlüften", "Schläuche spülen/fuellen"],
      ["ingredients", "Zutaten", "Zutaten verwalten"],
      ["recipes", "Rezepte", "Cocktails bearbeiten"],
      ["pumps", "Pumpen", "Zuordnung, Aktiv & Kalibrierung"],
      ["prices", "Preise", "Preise pro Cocktail/Größe, Gratis"],
      ["party", "Partyplaner", "Getränkekarte & Einkaufsliste"],
      ["wled", "LED & WLED", "Statusanzeige Pico & WLED"],
      ["api", "API & Webhook", "Cocktails per URL auslösen"],
      ["stats", "Statistik", "Verbrauch & Zähler"],
      ["general", "Allgemein", "Größen, Netzwerk, Sperre"],
      ["backup", "Backup", "Einstellungen sichern & per Mail"],
      ["updates", "Updates", "Neue Version holen & neu starten"],
    ];
    const g = el('<div class="settings-grid"></div>');
    tiles.forEach(([v, h, p]) => {
      const t = el(`<div class="tile"><h3>${h}</h3><p>${p}</p></div>`);
      t.onclick = () => goSettings(v); g.appendChild(t);
    });
    const wrap = el('<div></div>');
    wrap.appendChild(g);
    // "Beenden" nur auf dem Pi-Bildschirm (Kiosk) anbieten.
    if (state.kiosk) {
      const q = el('<button class="btn danger" style="margin-top:16px;width:100%">CocktailBot beenden</button>');
      q.onclick = async () => {
        if (!confirm("CocktailBot beenden und zum Desktop zurück?")) return;
        try { await post("/api/kiosk/quit", {}); } catch (e) {}
      };
      wrap.appendChild(q);
    }
    return wrap;
  }

  function backTile(){ const b = el('<button class="back">&larr; Einstellungen</button>'); b.onclick = () => goSettings("overview"); return b; }

  // ---- Updates ----
  function settingsUpdates() {
    const wrap = el('<div></div>');
    wrap.appendChild(backTile());
    const cur = (state.settings && state.settings.version) || state.version || "?";
    const p = el(`<div class="panel"><h3>Software-Update</h3>
      <p style="color:var(--muted)">Aktuell installiert: <b>v${cur}</b>. Holt die neueste
      Version aus dem Git-Repository und startet den Bot neu. Deine Daten (Rezepte,
      Füllstände, Preise, Verbrauch) bleiben dabei erhalten.</p></div>`);
    wrap.appendChild(p);

    // Passwortfeld nur anzeigen, wenn eine Sperre gesetzt ist.
    let pwInput = null;
    if (state.settings && state.settings.settings_locked) {
      const pf = el(`<div class="panel"><label class="field">Einstellungs-Passwort
        <input id="updPw" type="password" placeholder="für Update nötig"></label></div>`);
      wrap.appendChild(pf); pwInput = pf.querySelector("#updPw");
    }
    const pw = () => (pwInput ? pwInput.value : "");

    const box = el('<div class="panel"></div>');
    wrap.appendChild(box);

    function renderBox() {
      box.innerHTML = "";
      if (updateBusy) {
        box.appendChild(el('<p>⏳ Bitte warten …</p>'));
        return;
      }
      if (updateInfo === "unavailable") {
        box.appendChild(el('<p style="color:var(--muted)">Das Menü-Update funktioniert nur auf dem Raspberry Pi (Git-Installation). Am PC kannst du wie gewohnt mit <code>git pull</code> aktualisieren.</p>'));
        return;
      }
      const btn = el('<button class="primary">Nach Updates suchen</button>');
      btn.onclick = checkNow; box.appendChild(btn);
      if (updateInfo && typeof updateInfo === "object") {
        if (updateInfo.error) {
          box.appendChild(el(`<p style="color:var(--bad,#e55)">${updateInfo.error}</p>`));
        } else if (updateInfo.behind > 0) {
          box.appendChild(el(`<p style="margin-top:12px">Neue Version verfügbar:
            <b>v${updateInfo.latest || "?"}</b> (${updateInfo.behind} Änderung(en)).</p>`));
          if (updateInfo.log) {
            const pre = el('<pre style="white-space:pre-wrap;background:var(--panel2,#0003);padding:8px;border-radius:8px;max-height:160px;overflow:auto"></pre>');
            pre.textContent = updateInfo.log; box.appendChild(pre);
          }
          const up = el('<button class="primary" style="margin-top:8px">Jetzt updaten & neu starten</button>');
          up.onclick = applyNow; box.appendChild(up);
        } else {
          box.appendChild(el('<p style="margin-top:12px;color:var(--good,#3c6)">✓ Du hast bereits die neueste Version.</p>'));
        }
      }
    }

    async function checkNow() {
      updateBusy = true; renderBox();
      try {
        const r = await fetch("/api/update/check", {method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({password: pw()})});
        updateInfo = await r.json();
      } catch (e) { updateInfo = {error: "Prüfung fehlgeschlagen"}; }
      updateBusy = false; renderBox();
    }

    async function applyNow() {
      updateBusy = true; renderBox();
      try {
        const r = await fetch("/api/update/apply", {method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({password: pw()})});
        const j = await r.json();
        if (!j.ok) { updateInfo = {error: j.error || "Update fehlgeschlagen"}; updateBusy = false; renderBox(); return; }
        box.innerHTML = "<p>⏳ Update läuft, der Bot startet neu … Die Seite lädt automatisch neu, sobald er wieder da ist.</p>";
        waitForRestart();
      } catch (e) { updateInfo = {error: "Update fehlgeschlagen"}; updateBusy = false; renderBox(); }
    }

    function waitForRestart() {
      let tries = 0;
      const iv = setInterval(async () => {
        tries++;
        try {
          const r = await fetch("/api/update/status", {cache:"no-store"});
          if (r.ok) { clearInterval(iv); location.reload(); return; }
        } catch (e) { /* noch offline */ }
        if (tries > 120) { clearInterval(iv); box.innerHTML = "<p>Neustart dauert länger als erwartet. Bitte Seite manuell neu laden.</p>"; }
      }, 2000);
    }

    // Verfügbarkeit einmalig prüfen
    if (updateInfo === null) {
      fetch("/api/update/status").then(r=>r.json()).then(s => {
        if (!s.available) updateInfo = "unavailable";
        renderBox();
      }).catch(()=>renderBox());
    }
    renderBox();
    return wrap;
  }

  // ---- Backup ----
  function settingsBackup() {
    const wrap = el('<div></div>');
    wrap.appendChild(backTile());
    const s = state.settings || {};
    wrap.appendChild(el(`<div class="panel"><h3>Backup der Einstellungen</h3>
      <p style="color:var(--muted)">Sichert Rezepte, Zutaten, Pumpen, Preise und
      Einstellungen in einer Zip-Datei auf dem Pi. Passwörter (Admin/Mail) sind
      aus dem Backup ausgenommen – du kannst es also gefahrlos per Mail verschicken.</p></div>`));

    let pwInput = null;
    if (s.settings_locked) {
      const pf = el(`<div class="panel"><label class="field">Einstellungs-Passwort
        <input id="bkPw" type="password" placeholder="für Backup/Wiederherstellen nötig"></label></div>`);
      wrap.appendChild(pf); pwInput = pf.querySelector("#bkPw");
    }
    const pw = () => (pwInput ? pwInput.value : "");
    const fmtKB = (b) => (b/1024 >= 1024 ? (b/1048576).toFixed(1)+" MB" : Math.max(1,Math.round(b/1024))+" kB");
    const fmtDate = (iso) => { try { const d=new Date(iso); return d.toLocaleString("de-DE"); } catch(e){ return iso; } };

    // --- Aktionen + Liste ---
    const act = el('<div class="panel"></div>');
    const mkBtn = el('<button class="primary">Backup jetzt erstellen</button>');
    mkBtn.onclick = async () => {
      mkBtn.disabled = true;
      try {
        const r = await post("/api/backup/create", {password: pw()});
        if (r.ok) { toast("Backup erstellt"); renderList(r.backups); }
        else toast(r.error || "Fehler", true);
      } finally { mkBtn.disabled = false; }
    };
    act.appendChild(mkBtn);
    const listBox = el('<div style="margin-top:12px"></div>');
    act.appendChild(listBox);
    wrap.appendChild(act);

    function renderList(backups) {
      listBox.innerHTML = "";
      if (!backups || !backups.length) {
        listBox.appendChild(el('<p style="color:var(--muted)">Noch keine Backups vorhanden.</p>'));
        return;
      }
      backups.forEach(b => {
        const row = el(`<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;
          padding:8px 0;border-top:1px solid var(--line,#2224)">
          <span style="flex:1;min-width:180px">${b.name}<br>
            <small style="color:var(--muted)">${fmtDate(b.mtime)} · ${fmtKB(b.size)}</small></span></div>`);
        const dl = el('<button class="btn">Download</button>');
        dl.onclick = () => { window.location = "/api/backup/download/" + encodeURIComponent(b.name) + "?pw=" + encodeURIComponent(pw()); };
        const rs = el('<button class="btn">Wiederherstellen</button>');
        rs.onclick = async () => {
          if (!confirm("Dieses Backup einspielen? Die aktuellen Einstellungen werden ersetzt (vorher wird automatisch ein Sicherungs-Backup erstellt).")) return;
          const r = await post("/api/backup/restore", {name: b.name, password: pw()});
          if (r.ok) { toast("Wiederhergestellt"); load(); } else toast(r.error || "Fehler", true);
        };
        const del = el('<button class="btn">Löschen</button>');
        del.onclick = async () => {
          if (!confirm("Backup löschen?")) return;
          const r = await post("/api/backup/delete/" + encodeURIComponent(b.name), {password: pw()});
          if (r.ok) renderList(r.backups); else toast(r.error || "Fehler", true);
        };
        row.appendChild(dl); row.appendChild(rs); row.appendChild(del);
        listBox.appendChild(row);
      });
    }

    // --- Wiederherstellen aus Datei (USB/Mail) ---
    const up = el(`<div class="panel"><h3>Aus Datei wiederherstellen</h3>
      <p style="color:var(--muted)">Eine zuvor heruntergeladene Backup-Zip einspielen.</p>
      <input type="file" id="bkFile" accept=".zip">
      <button class="btn primary" id="bkUp" style="margin-top:8px">Datei einspielen</button></div>`);
    up.querySelector("#bkUp").onclick = async () => {
      const f = up.querySelector("#bkFile").files[0];
      if (!f) { toast("Bitte eine .zip-Datei wählen", true); return; }
      if (!confirm("Backup aus Datei einspielen? Aktuelle Einstellungen werden ersetzt.")) return;
      const fd = new FormData(); fd.append("file", f); fd.append("password", pw());
      const r = await (await fetch("/api/backup/restore", {method: "POST", body: fd})).json();
      if (r.ok) { toast("Wiederhergestellt"); load(); } else toast(r.error || "Fehler", true);
    };
    wrap.appendChild(up);

    // --- Mailversand ---
    const m = s.mail || {};
    const sec = m.security || "starttls";
    const mp = el(`<div class="panel"><h3>Backup per Mail</h3>
      <div class="grid2">
        <label class="field">SMTP-Server<input id="mHost" value="${m.host||""}" placeholder="z.B. smtp.all-inkl.com"></label>
        <label class="field">Port<input id="mPort" type="number" value="${m.port||587}" placeholder="587"></label>
        <label class="field">Sicherheit<select id="mSec">
          <option value="starttls" ${sec==="starttls"?"selected":""}>STARTTLS (587)</option>
          <option value="ssl" ${sec==="ssl"?"selected":""}>SSL/TLS (465)</option>
          <option value="none" ${sec==="none"?"selected":""}>keine</option></select></label>
        <label class="field">Benutzer<input id="mUser" value="${m.user||""}" placeholder="invoice@n3rdz.de"></label>
        <label class="field">Absender (From)<input id="mFrom" value="${m.from||""}" placeholder="invoice@n3rdz.de"></label>
        <label class="field">Empfänger (To)<input id="mTo" value="${m.to||""}" placeholder="ich@example.de"></label>
        <label class="field">Passwort<input id="mPw" type="password" placeholder="${s.smtp_password_set?"•••••• (gesetzt)":"leer"}"></label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn" id="mSave">Mail-Einstellungen speichern</button>
        <button class="btn primary" id="mSend">Backup jetzt per Mail senden</button>
      </div></div>`);
    mp.querySelector("#mSave").onclick = async () => {
      const payload = {settings: {mail: {
        host: mp.querySelector("#mHost").value.trim(),
        port: +mp.querySelector("#mPort").value || 587,
        security: mp.querySelector("#mSec").value,
        user: mp.querySelector("#mUser").value.trim(),
        from: mp.querySelector("#mFrom").value.trim(),
        to: mp.querySelector("#mTo").value.trim(),
      }}};
      const pwv = mp.querySelector("#mPw").value;
      if (pwv !== "") payload.settings.smtp_password = pwv;  // nur ändern, wenn eingegeben
      await post("/api/settings", payload);
      toast("Mail-Einstellungen gespeichert"); load();
    };
    mp.querySelector("#mSend").onclick = async () => {
      const btn = mp.querySelector("#mSend"); btn.disabled = true;
      try {
        const r = await post("/api/backup/mail", {password: pw()});
        if (r.ok) toast("Backup per Mail gesendet"); else toast(r.error || "Mailversand fehlgeschlagen", true);
      } finally { btn.disabled = false; }
    };
    wrap.appendChild(mp);

    // Liste laden
    api("/api/backup/list").then(d => renderList(d.backups)).catch(() => renderList([]));
    return wrap;
  }


  // ---- Füllstände ----
  function settingsLevels() {
    const w = el('<div></div>'); w.appendChild(backTile());
    const p = el('<div class="panel"></div>');
    const head = el('<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px"><h3 style="margin:0">Füllstände</h3></div>');
    const hideOn = !!state.settings.hide_unavailable;
    const hideBtn = el(`<button class="btn ${hideOn ? "primary" : "ghost"}">${hideOn ? "Nicht zapfbare ausgeblendet" : "Nicht zapfbare ausblenden"}</button>`);
    hideBtn.onclick = async () => {
      await post("/api/settings", {settings: {hide_unavailable: !hideOn}});
      toast(!hideOn ? "Nicht zapfbare Cocktails ausgeblendet" : "Alle Cocktails sichtbar"); load();
    };
    const fillAll = el('<button class="btn primary">Alle auffüllen</button>');
    fillAll.onclick = async () => {
      if (!confirm("Alle Flaschen auf voll setzen?")) return;
      const r = await post("/api/levels/fill_all");
      toast(`${r.filled || 0} Zutaten aufgefüllt`); load();
    };
    const btns = el('<div class="row" style="margin:0"></div>');
    btns.append(hideBtn, fillAll);
    head.appendChild(btns); p.appendChild(head);
    const tbl = el('<table><tr><th></th><th>Zutat</th><th>Stand</th><th></th><th></th></tr></table>');
    state.ingredients.filter(i => i.automatic).forEach(i => {
      const pct = i.capacity_ml ? Math.round(i.level_ml / i.capacity_ml * 100) : 0;
      const low = i.level_ml < 100;
      const tr = elRow(`<tr><td class="thumbcell"></td><td>${i.name}</td>
        <td><div class="levelbar"><div class="f ${low ? "low" : ""}" style="width:${pct}%"></div></div>
            <small>${Math.round(i.level_ml)}/${i.capacity_ml} ml</small></td>
        <td><input class="sm" type="number" value="${Math.round(i.level_ml)}" id="lvl${i.id}"> ml</td>
        <td><button class="btn" style="padding:7px 12px">Setzen</button>
            <button class="btn primary" style="padding:7px 12px">Voll</button></td></tr>`);
      tr.querySelector(".thumbcell").appendChild(ingThumb(i));
      const [setBtn, fullBtn] = tr.querySelectorAll("button");
      setBtn.onclick = async () => { await post("/api/levels", {ingredient_id: i.id, level_ml: +$("#lvl" + i.id).value}); toast("Gesetzt"); load(); };
      fullBtn.onclick = async () => { await post("/api/levels", {ingredient_id: i.id, refill: true}); toast("Aufgefüllt"); load(); };
      tbl.appendChild(tr);
    });
    p.appendChild(tbl); w.appendChild(p); return w;
  }

  // ---- Reinigung & Entlüften ----
  function settingsClean() {
    const w = el('<div></div>'); w.appendChild(backTile());
    const mk = (title, hint, secKey, endpoint, defSec) => {
      const p = el(`<div class="panel"><h3>${title}</h3><p style="color:var(--muted)">${hint}</p></div>`);
      const sel = el('<div class="row" style="flex-wrap:wrap"></div>');
      const chosen = new Set();
      state.pumps.forEach(pu => {
        const c = el(`<button class="chip" style="padding:8px 12px">${pu.number}</button>`);
        c.onclick = () => { c.classList.toggle("sel"); chosen.has(pu.id) ? chosen.delete(pu.id) : chosen.add(pu.id); };
        sel.appendChild(c);
      });
      const all = el('<button class="btn ghost">Alle</button>');
      all.onclick = () => { chosen.clear(); state.pumps.forEach(pu => chosen.add(pu.id)); sel.querySelectorAll(".chip").forEach(c => c.classList.add("sel")); };
      const secInp = el(`<input class="sm" type="number" value="${defSec}"> `);
      const go = el(`<button class="btn primary">Start</button>`);
      go.onclick = async () => {
        const ids = [...chosen];
        const r = await post(endpoint, {pump_ids: ids, seconds: +secInp.value || defSec});
        if (!r.ok) return toast(r.error, true);
        toast(title + " gestartet");
        // Fortschritts-Fenster mit sichtbarem Not-Stop
        $("#progDone").hidden = true; $("#stopBtn").hidden = false;
        startPolling();
      };
      p.appendChild(sel);
      const ctl = el('<div class="row"></div>');
      ctl.append(all, el('<span>Dauer je Pumpe:</span>'), secInp, el('<span>s</span>'), go);
      p.appendChild(ctl); return p;
    };
    w.appendChild(mk("Reinigung", "Pumpen mit Wasser/Reiniger spülen. Behälter mit Wasser anschließen, Glas unterstellen.",
      "clean", "/api/clean", state.settings.clean_seconds || 20));
    w.appendChild(mk("Entlüften", "Schläuche befüllen, bis Flüssigkeit kommt (kurze Stöße).",
      "vent", "/api/vent", state.settings.vent_seconds || 5));
    return w;
  }

  // ---- Zutaten ----
  function settingsIngredients() {
    const w = el('<div></div>'); w.appendChild(backTile());
    const p = el('<div class="panel"></div>');
    const head = el('<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px"><h3 style="margin:0">Zutaten</h3></div>');
    const add = el('<button class="btn primary">+ Neue Zutat</button>');
    add.onclick = () => editIngredient({name: "", abv: 0, automatic: true, level_ml: 0, capacity_ml: 1000});
    head.appendChild(add); p.appendChild(head);
    const tbl = el('<table><tr><th></th><th>Name</th><th>% Vol</th><th>Automatisch</th><th></th></tr></table>');
    state.ingredients.forEach(i => {
      const tr = elRow(`<tr><td class="thumbcell"></td><td>${i.name}</td><td>${i.abv || 0}%</td>
        <td>${i.automatic ? "ja" : "manuell"}</td>
        <td><button class="btn" style="padding:6px 12px">Bearbeiten</button>
            <button class="btn danger" style="padding:6px 12px">x</button></td></tr>`);
      tr.querySelector(".thumbcell").appendChild(ingThumb(i));
      const [ed, del] = tr.querySelectorAll("button");
      ed.onclick = () => editIngredient(i);
      del.onclick = async () => { if (confirm("Löschen?")) { await fetch("/api/ingredients/" + i.id, {method: "DELETE"}); load(); } };
      tbl.appendChild(tr);
    });
    p.appendChild(tbl); w.appendChild(p); return w;
  }

  function openEditor(node) { const s = $("#editSheet"); s.innerHTML = ""; s.appendChild(node); $("#editModal").hidden = false; }
  function closeEditor() { $("#editModal").hidden = true; }

  function editIngredient(i) {
    const alc = (i.abv || 0) > 0;
    const node = el(`<div>
      <h2>${i.id ? "Zutat bearbeiten" : "Neue Zutat"}</h2>
      <label class="field">Name<input id="eiName" value="${i.name || ""}" placeholder="z.B. Vodka"></label>
      <div class="row">
        <button class="chip ${alc ? "sel" : ""}" id="eiAlc">Alkoholisch</button>
        <button class="chip ${alc ? "" : "sel"}" id="eiNon">Alkoholfrei</button>
      </div>
      <label class="field" id="eiAbvWrap" ${alc ? "" : 'style="display:none"'}>
        Alkoholgehalt (% Vol)<input id="eiAbv" type="number" min="0" max="100" value="${i.abv || 40}"></label>
      <label class="field">Behältergröße (ml, für Füllstand)
        <input id="eiCap" type="number" value="${i.capacity_ml || 1000}"></label>
      <label class="field">Preis pro Liter (€, optional - für Kostenstatistik)
        <input id="eiPrice" type="number" step="0.01" value="${i.price_per_liter || 0}"></label>
      <label class="field">Bild-Dateiname (in static/images/ingredients/)
        <input id="eiImg" value="${i.image || ""}" placeholder="z.B. vodka.jpg"></label>
      <div class="ei-preview"><img id="eiImgPrev" alt="Vorschau"><span id="eiImgHint">Keine Vorschau – Dateiname eintragen (Datei in static/images/ingredients/).</span></div>
      <label class="field"><span><input type="checkbox" id="eiAuto" ${i.automatic !== false ? "checked" : ""}>
        Standardmäßig per Pumpe dosierbar (nicht für Eis/Deko)</span></label>
      <div class="btn-row">
        <button class="btn ghost" id="eiCancel">Abbrechen</button>
        <button class="btn primary" style="flex:1" id="eiSave">Speichern</button>
      </div></div>`);
    let isAlc = alc;
    const refreshAlc = () => {
      node.querySelector("#eiAlc").classList.toggle("sel", isAlc);
      node.querySelector("#eiNon").classList.toggle("sel", !isAlc);
      node.querySelector("#eiAbvWrap").style.display = isAlc ? "" : "none";
    };
    node.querySelector("#eiAlc").onclick = () => { isAlc = true; refreshAlc(); };
    node.querySelector("#eiNon").onclick = () => { isAlc = false; refreshAlc(); };
    // Live-Bildvorschau
    const eiInp = node.querySelector("#eiImg");
    const eiPrev = node.querySelector("#eiImgPrev");
    const eiHint = node.querySelector("#eiImgHint");
    const eiUpdate = () => {
      const v = eiInp.value.trim();
      if (v) { eiPrev.src = "/img/ingredient/" + encodeURIComponent(v); eiPrev.style.display = "block"; eiHint.style.display = "none"; }
      else { eiPrev.removeAttribute("src"); eiPrev.style.display = "none"; eiHint.style.display = "block"; }
    };
    eiPrev.onerror = () => { eiPrev.style.display = "none"; eiHint.textContent = "Bild nicht gefunden – liegt die Datei in static/images/ingredients/?"; eiHint.style.display = "block"; };
    eiInp.addEventListener("input", eiUpdate);
    eiUpdate();
    node.querySelector("#eiCancel").onclick = closeEditor;
    node.querySelector("#eiSave").onclick = async () => {
      const name = node.querySelector("#eiName").value.trim();
      if (!name) return toast("Name fehlt", true);
      const abv = isAlc ? (+node.querySelector("#eiAbv").value || 0) : 0;
      const ing = {...i, name, abv, capacity_ml: +node.querySelector("#eiCap").value || 0,
        price_per_liter: +node.querySelector("#eiPrice").value || 0,
        image: node.querySelector("#eiImg").value.trim(),
        automatic: node.querySelector("#eiAuto").checked};
      await post("/api/ingredients", {ingredient: ing});
      closeEditor(); toast("Gespeichert"); load();
    };
    openEditor(node);
  }

  // ---- Rezepte ----
  function settingsRecipes() {
    const w = el('<div></div>'); w.appendChild(backTile());
    const p = el('<div class="panel"><h3>Rezepte</h3><p style="color:var(--muted)">Rezept antippen zum Bearbeiten. Pfeile ändern die eigene Reihenfolge (nur bei Sortierung „Eigene Reihenfolge" sichtbar). Bild: Dateiname in static/images/cocktails/.</p></div>');
    const tbl = el('<table><tr><th>#</th><th>Bild</th><th>Name</th><th>Kategorie</th><th>Zutaten</th><th></th></tr></table>');
    // in gespeicherter Reihenfolge anzeigen
    const ordered = sortRecipes(state.recipes.filter(() => true)).sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
    const ids = ordered.map(r => r.id);
    const move = async (id, dir) => {
      const i = ids.indexOf(id), j = i + dir;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await post("/api/recipes/order", {order: ids}); load();
    };
    ordered.forEach((r, idx) => {
      const tr = elRow(`<tr><td style="white-space:nowrap">
          <button class="btn ghost up" style="padding:2px 8px">▲</button>
          <button class="btn ghost dn" style="padding:2px 8px">▼</button></td>
        <td>${r.image ? `<img class="rthumb" src="/img/cocktail/${encodeURIComponent(r.image)}" onerror="this.style.visibility='hidden'">` : '<span class="rthumb rthumb-empty">—</span>'}</td>
        <td style="cursor:pointer" class="rname">${r.name}</td><td>${r.category}</td>
        <td>${r.ingredients.length}</td>
        <td><button class="btn danger rm" style="padding:6px 12px">x</button></td></tr>`);
      tr.querySelector(".rname").onclick = () => editRecipe(r);
      tr.querySelector(".up").onclick = () => move(r.id, -1);
      tr.querySelector(".dn").onclick = () => move(r.id, +1);
      tr.querySelector(".rm").onclick = async (e) => { e.stopPropagation(); if (confirm("Rezept löschen?")) { await fetch("/api/recipes/" + r.id, {method: "DELETE"}); load(); } };
      tbl.appendChild(tr);
    });
    p.appendChild(tbl);
    const add = el('<button class="btn primary big">+ Neues Rezept</button>');
    add.onclick = () => editRecipe({name: "", category: "cocktails", description: "", image: "", ingredients: [], instructions: []});
    p.appendChild(add); w.appendChild(p); return w;
  }

  function editRecipe(r) {
    const cats = [["cocktails", "Cocktails"], ["alkoholfrei", "Alkoholfrei"], ["shots", "Shots"]];
    const node = el(`<div>
      <h2>${r.id ? "Rezept bearbeiten" : "Neues Rezept"}</h2>
      <label class="field">Name<input id="erName" value="${r.name || ""}" placeholder="z.B. Mojito"></label>
      <label class="field">Kategorie<select id="erCat">
        ${cats.map(([v, t]) => `<option value="${v}" ${r.category === v ? "selected" : ""}>${t}</option>`).join("")}
      </select></label>
      <label class="field">Beschreibung<input id="erDesc" value="${(r.description || "").replace(/"/g, "&quot;")}"></label>
      <label class="field">Bild-Dateiname (optional)<input id="erImg" value="${r.image || ""}" placeholder="mojito.jpg"></label>
      <div class="er-preview"><img id="erImgPrev" alt="Vorschau"><span id="erImgHint">Keine Vorschau – Dateiname eintragen (Datei muss in static/images/cocktails/ liegen).</span></div>
      <h3 style="margin:16px 0 6px">Zutaten</h3>
      <div id="erParts"></div>
      <button class="btn ghost" id="erAdd" style="margin-top:8px">+ Zutat hinzufügen</button>
      <label class="field" style="margin-top:14px">Hinweise am Ende (eine pro Zeile)
        <textarea id="erNotes" rows="2" style="background:var(--card2);border:1px solid #3a4222;color:var(--text);border-radius:8px;padding:8px">${(r.instructions || []).join("\n")}</textarea></label>
      <div class="btn-row">
        <button class="btn ghost" id="erCancel">Abbrechen</button>
        <button class="btn primary" style="flex:1" id="erSave">Speichern</button>
      </div></div>`);

    const partsBox = node.querySelector("#erParts");
    const autoIngs = state.ingredients;
    const addRow = (part) => {
      part = part || {ingredient_id: autoIngs[0] ? autoIngs[0].id : null, amount_ml: 30, manual: false, delayed: false, instruction: ""};
      const opts = autoIngs.map(i => `<option value="${i.id}" ${i.id === part.ingredient_id ? "selected" : ""}>${i.name}${i.abv ? " (" + i.abv + "%)" : ""}</option>`).join("");
      const row = el(`<div class="part-row">
        <select class="p-ing">${opts}</select>
        <input class="p-ml sm" type="number" value="${part.amount_ml}" style="width:70px"> ml
        <label class="mini"><input type="checkbox" class="p-man" ${part.manual ? "checked" : ""}> manuell (Gast)</label>
        <label class="mini"><input type="checkbox" class="p-del" ${part.delayed ? "checked" : ""}> erst am Ende</label>
        <input class="p-note" placeholder="Hinweis (optional)" value="${(part.instruction || "").replace(/"/g, "&quot;")}">
        <button class="btn danger p-rm" style="padding:4px 10px">x</button>
      </div>`);
      // "manuell" und "erst am Ende" schließen sich sinnvoll nicht aus, aber
      // bei manuell ist der Startversatz egal.
      row.querySelector(".p-rm").onclick = () => row.remove();
      partsBox.appendChild(row);
    };
    (r.ingredients || []).forEach(addRow);
    if (!(r.ingredients || []).length) addRow();
    node.querySelector("#erAdd").onclick = () => addRow();
    // Live-Bildvorschau
    const imgInp = node.querySelector("#erImg");
    const imgPrev = node.querySelector("#erImgPrev");
    const imgHint = node.querySelector("#erImgHint");
    const updatePrev = () => {
      const v = imgInp.value.trim();
      if (v) {
        imgPrev.src = "/img/cocktail/" + encodeURIComponent(v);
        imgPrev.style.display = "block"; imgHint.style.display = "none";
      } else { imgPrev.removeAttribute("src"); imgPrev.style.display = "none"; imgHint.style.display = "block"; }
    };
    imgPrev.onerror = () => { imgPrev.style.display = "none"; imgHint.textContent = "Bild nicht gefunden – liegt die Datei in static/images/cocktails/?"; imgHint.style.display = ""; };
    imgInp.addEventListener("input", updatePrev);
    updatePrev();
    node.querySelector("#erCancel").onclick = closeEditor;
    node.querySelector("#erSave").onclick = async () => {
      const name = node.querySelector("#erName").value.trim();
      if (!name) return toast("Name fehlt", true);
      const parts = [...partsBox.querySelectorAll(".part-row")].map(row => ({
        ingredient_id: +row.querySelector(".p-ing").value,
        amount_ml: +row.querySelector(".p-ml").value || 0,
        manual: row.querySelector(".p-man").checked,
        delayed: row.querySelector(".p-del").checked,
        instruction: row.querySelector(".p-note").value.trim(),
      })).filter(p => p.ingredient_id && p.amount_ml >= 0);
      if (!parts.length) return toast("Mindestens eine Zutat", true);
      const notes = node.querySelector("#erNotes").value.split("\n").map(x => x.trim()).filter(Boolean);
      const recipe = {...r, name, category: node.querySelector("#erCat").value,
        description: node.querySelector("#erDesc").value.trim(),
        image: node.querySelector("#erImg").value.trim(),
        ingredients: parts, instructions: notes};
      await post("/api/recipes", {recipe});
      closeEditor(); toast("Gespeichert"); load();
    };
    openEditor(node);
  }

  // ---- Pumpen (Zuordnung + Aktiv + Kalibrierung, als Karten) ----
  function settingsPumps() {
    const w = el('<div></div>'); w.appendChild(backTile());
    w.appendChild(el('<div class="panel"><h3>Pumpen</h3><p style="color:var(--muted)">Pro Pumpe: Zutat zuordnen, aktivieren, testen und kalibrieren. GPIO-Pins sind fest verdrahtet (Active-Low).</p></div>'));
    const opts = (sel) => '<option value="">– keine –</option>' + state.ingredients.filter(i => i.automatic)
      .map(i => `<option value="${i.id}" ${i.id === sel ? "selected" : ""}>${i.name}</option>`).join("");

    const grid = el('<div class="pump-cards"></div>');
    state.pumps.forEach(pu => {
      const c = el(`<div class="pump-card">
        <div class="pump-head"><span class="pump-no">Pumpe ${pu.number}</span>
          <span class="pump-gpio">GPIO${pu.gpio_pin}</span>
          <span class="pump-cal">${pu.calibration_ml_per_s || 0} ml/s</span></div>
        <label class="field">Zutat <select id="pi${pu.id}">${opts(pu.ingredient_id)}</select></label>
        <label class="field inline"><input type="checkbox" id="pe${pu.id}" ${pu.enabled ? "checked" : ""}> Pumpe aktiv</label>
        <div class="pump-cal-row">
          <span>Test:</span>
          <input class="sm" type="number" value="2" id="sec${pu.id}" style="width:56px"> s
          <button class="btn" data-a="run" style="padding:7px 12px">Lauf</button>
        </div>
        <div class="pump-cal-row">
          <span>Messen:</span>
          <input class="sm" type="number" placeholder="ml" id="ml${pu.id}" style="width:72px"> ml
          <button class="btn primary" data-a="cal" style="padding:7px 12px">Speichern</button>
        </div>
      </div>`);
      const runBtn = c.querySelector('[data-a="run"]');
      const calBtn = c.querySelector('[data-a="cal"]');
      runBtn.onclick = async () => {
        const sec = +$("#sec" + pu.id).value || 2;
        runBtn.disabled = true; runBtn.textContent = "...";
        const r = await post("/api/calibrate/test", {pump_id: pu.id, seconds: sec});
        runBtn.disabled = false; runBtn.textContent = "Lauf";
        if (!r.ok) toast(r.error, true);
      };
      calBtn.onclick = async () => {
        const sec = +$("#sec" + pu.id).value || 2, ml = +$("#ml" + pu.id).value;
        if (!ml) return toast("ml eintragen", true);
        const r = await post("/api/calibrate/save", {pump_id: pu.id, seconds: sec, measured_ml: ml});
        if (r.ok) { toast("Gespeichert: " + r.calibration_ml_per_s + " ml/s"); load(); }
      };
      grid.appendChild(c);
    });
    w.appendChild(grid);

    const p2 = el('<div class="panel"></div>');
    const al = el(`<label class="field"><span>
      <input type="checkbox" id="pAL" ${state.settings.active_low !== false ? "checked" : ""}>
      Relais Active-Low (HIGH = aus)</span>
      <small style="color:var(--muted)">Passt zu den üblichen Relais-Modulen. Nur ändern, wenn die Pumpen genau verkehrt herum schalten. Wirkt nach Neustart.</small></label>`);
    p2.appendChild(al);
    const save = el('<button class="btn primary big">Zuordnung & Aktiv speichern</button>');
    save.onclick = async () => {
      const pumps = state.pumps.map(pu => ({...pu,
        ingredient_id: $("#pi" + pu.id).value ? +$("#pi" + pu.id).value : null,
        enabled: $("#pe" + pu.id).checked}));
      await post("/api/pumps", {pumps});
      const alNew = $("#pAL").checked, alOld = state.settings.active_low !== false;
      await post("/api/settings", {settings: {active_low: alNew}});
      toast(alNew !== alOld ? "Gespeichert – Active-Low-Änderung nach Neustart aktiv" : "Gespeichert");
      load();
    };
    p2.appendChild(save); w.appendChild(p2); return w;
  }

  // ---- API & Webhook ----
  function settingsApi() {
    const w = el('<div></div>'); w.appendChild(backTile());
    const base = location.origin;
    const tok = state.settings.api_token ? `?token=${state.settings.api_token}` : "";
    const rows = state.recipes.map(r =>
      `<div class="kv"><span>${r.name}</span><code>${base}/api/trigger/${r.id}${tok}</code></div>`).join("");
    const p = el(`<div class="panel"><h3>API &amp; Webhook</h3>
      <p style="color:var(--muted)">Jeden Cocktail per HTTP auslösen - ideal für Home Assistant, Node-RED, Stream Deck oder NFC-Tags.</p>
      <label class="field">Optionales API-Token (leer = offen im lokalen Netz)
        <input id="apiTok" value="${state.settings.api_token || ""}" placeholder="z.B. geheim123"></label>
      <button class="btn primary" id="saveTok">Token speichern</button>
      <h3 style="margin-top:20px">Trigger-URLs</h3>
      <p style="color:var(--muted)">Optional: <code>&size_ml=300</code> und <code>&strength=1.0</code> anhängen. Auch der Name geht: <code>/api/trigger/mojito</code></p>
      ${rows}
      <h3 style="margin-top:20px">Beispiel (POST JSON)</h3>
      <code>POST ${base}/api/prepare &nbsp; {"recipe_id":1,"size_ml":300}</code>
      </div>`);
    p.querySelector("#saveTok").onclick = async () => {
      await post("/api/settings", {settings: {api_token: $("#apiTok").value.trim()}});
      toast("Gespeichert"); load(); goSettings("api");
    };
    w.appendChild(p); return w;
  }

  // ---- Statistik ----
  function recipeName(id) { const r = state.recipes.find(x => x.id === +id); return r ? r.name : "#" + id; }

  // Gestapeltes Balkendiagramm: wann wieviele Cocktails (nach Sorte gefärbt).
  function buildStatsChart(events, mode) {
    const box = el('<div></div>');
    const now = new Date();
    const buckets = [];
    if (mode === "hour") {
      const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
      for (let h = 0; h < 24; h++) buckets.push({label: String(h).padStart(2, "0"), byRec: {}, total: 0});
      (events || []).forEach(e => {
        const dt = new Date(e.t * 1000);
        if (dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d) {
          const b = buckets[dt.getHours()]; b.byRec[e.id] = (b.byRec[e.id] || 0) + 1; b.total++;
        }
      });
    } else {
      const days = 14, map = {};
      for (let i = days - 1; i >= 0; i--) {
        const dt = new Date(now); dt.setHours(0, 0, 0, 0); dt.setDate(now.getDate() - i);
        const key = dt.getFullYear() + "-" + (dt.getMonth() + 1) + "-" + dt.getDate();
        const b = {label: dt.getDate() + "." + (dt.getMonth() + 1), byRec: {}, total: 0};
        buckets.push(b); map[key] = b;
      }
      (events || []).forEach(e => {
        const dt = new Date(e.t * 1000);
        const key = dt.getFullYear() + "-" + (dt.getMonth() + 1) + "-" + dt.getDate();
        const b = map[key]; if (b) { b.byRec[e.id] = (b.byRec[e.id] || 0) + 1; b.total++; }
      });
    }
    const maxT = Math.max(1, ...buckets.map(b => b.total));
    const present = [...new Set(buckets.flatMap(b => Object.keys(b.byRec)))];
    if (!present.length) { box.appendChild(el('<p style="color:var(--muted)">Keine Zapfungen im Zeitraum.</p>')); return box; }
    const palette = ["#c6ff00","#5fd35f","#36c5f0","#f472b6","#ffb300","#ff5a4d","#a78bfa","#2dd4bf","#fb923c","#84cc16","#e879f9","#facc15"];
    const colorOf = {}; present.forEach((id, i) => colorOf[id] = palette[i % palette.length]);

    const n = buckets.length, W = 700, H = 200, padL = 26, padB = 22, padT = 8;
    const plotH = H - padB - padT, plotW = W - padL - 4, gap = plotW / n, bw = gap * 0.66;
    const ticks = maxT >= 4 ? [0, Math.round(maxT / 2), maxT] : (maxT >= 2 ? [0, 1, maxT] : [0, 1]);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-width:100%">`;
    [...new Set(ticks)].forEach(t => {
      const yy = padT + plotH - (t / maxT) * plotH;
      svg += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - 2}" y2="${yy.toFixed(1)}" stroke="#2a3018"/>`;
      svg += `<text x="2" y="${(yy + 4).toFixed(1)}" fill="#9aa285" font-size="10">${t}</text>`;
    });
    buckets.forEach((b, i) => {
      const x = padL + i * gap + (gap - bw) / 2;
      let yTop = padT + plotH;
      present.forEach(id => {
        const c = b.byRec[id] || 0; if (!c) return;
        const hh = (c / maxT) * plotH; yTop -= hh;
        svg += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${colorOf[id]}" rx="2"><title>${recipeName(id)}: ${c}</title></rect>`;
      });
      if (mode !== "hour" || i % 3 === 0)
        svg += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" fill="#9aa285" font-size="10" text-anchor="middle">${b.label}</text>`;
    });
    svg += `</svg>`;
    box.appendChild(el('<div style="overflow-x:auto">' + svg + "</div>"));
    const leg = el('<div class="chart-legend"></div>');
    present.map(id => ({id, total: buckets.reduce((a, b) => a + (b.byRec[id] || 0), 0)}))
      .sort((a, b) => b.total - a.total)
      .forEach(({id, total}) => leg.appendChild(el(`<span class="lg"><i style="background:${colorOf[id]}"></i>${recipeName(id)} (${total})</span>`)));
    box.appendChild(leg);
    return box;
  }

  function settingsStats() {
    const w = el('<div></div>'); w.appendChild(backTile());
    const s = state.stats || {};
    let totalCost = 0;
    const per = Object.entries(s.per_recipe || {}).map(([id, n]) => {
      const r = state.recipes.find(x => x.id === +id);
      const cost = r ? (r.cost_eur || 0) * n : 0; totalCost += cost;
      return `<div class="kv"><span>${r ? r.name : "#" + id}</span><b>${n}x${cost ? " · " + cost.toFixed(2) + " €" : ""}</b></div>`;
    }).join("") || '<p style="color:var(--muted)">Noch keine Zubereitungen.</p>';
    w.appendChild(el(`<div class="panel"><h3>Statistik</h3>
      <div class="kv"><span>Zubereitungen gesamt</span><b>${s.total || 0}</b></div>
      <div class="kv"><span>Ausgegebene Menge</span><b>${Math.round((s.volume_ml || 0) / 10) / 100} l</b></div>
      <div class="kv"><span>Zutatenkosten gesamt</span><b>${totalCost.toFixed(2)} €</b></div>
      <p style="color:var(--muted);font-size:13px">Kosten nur, wenn bei den Zutaten ein Preis pro Liter hinterlegt ist.</p></div>`));

    // Zeitverlauf
    let mode = "hour";
    const chartPanel = el(`<div class="panel"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <h3 style="margin:0">Zeitverlauf</h3>
      <div class="btn-row" style="margin:0">
        <button class="btn" data-m="hour">Heute</button>
        <button class="btn" data-m="day">14 Tage</button>
      </div></div><div id="statChart" style="margin-top:10px"><p style="color:var(--muted)">Lade…</p></div></div>`);
    const chartBox = chartPanel.querySelector("#statChart");
    const mBtns = chartPanel.querySelectorAll("[data-m]");
    const setMode = (m) => { mode = m; mBtns.forEach(b => b.classList.toggle("primary", b.dataset.m === m)); draw(); };
    let cachedEvents = null;
    async function draw() {
      if (cachedEvents === null) {
        try { cachedEvents = (await api("/api/stats")).events || []; } catch (e) { cachedEvents = []; }
      }
      chartBox.innerHTML = ""; chartBox.appendChild(buildStatsChart(cachedEvents, mode));
    }
    mBtns.forEach(b => b.onclick = () => setMode(b.dataset.m));
    w.appendChild(chartPanel);
    setMode("hour");

    // Pro Cocktail + Reset
    w.appendChild(el(`<div class="panel"><h3>Pro Cocktail</h3>${per}</div>`));
    const rp = el('<div class="panel"></div>');
    const reset = el('<button class="btn danger big">Statistik zurücksetzen</button>');
    reset.onclick = async () => {
      if (!confirm("Alle Statistikdaten und den Zeitverlauf unwiderruflich löschen?")) return;
      const r = await post("/api/stats/reset");
      if (r.ok) { toast("Statistik zurückgesetzt"); load(); goSettings("stats"); }
    };
    rp.appendChild(reset); w.appendChild(rp);
    return w;
  }

  // ---- Allgemein ----
  function settingsGeneral() {
    const w = el('<div></div>'); w.appendChild(backTile());
    const s = state.settings;
    const p = el(`<div class="panel"><h3>Allgemein</h3>
      <label class="field">Größen (ml, kommagetrennt)
        <input id="gSizes" value="${(s.sizes_ml || []).join(", ")}"></label>
      <label class="field">Standardgröße (ml)<input id="gDef" type="number" value="${s.default_size_ml || 300}"></label>
      <label class="field">Sortierung der Cocktailkarten<select id="gSort">
        <option value="original" ${(s.recipe_sort_mode||"original")==="original"?"selected":""}>Eigene Reihenfolge (wie im Original)</option>
        <option value="name" ${s.recipe_sort_mode==="name"?"selected":""}>Name (A–Z)</option>
        <option value="abv" ${s.recipe_sort_mode==="abv"?"selected":""}>Alkoholgehalt (hoch→niedrig)</option>
        <option value="availability" ${s.recipe_sort_mode==="availability"?"selected":""}>Verfügbarkeit</option>
      </select></label>
      <label class="field"><span><input type="checkbox" id="gStr" ${s.strength_enabled ? "checked" : ""}> Stärkeregler anzeigen</span></label>
      <h3 style="margin-top:16px">Einstellungen sperren</h3>
      <p style="color:var(--muted);font-size:13px">Status: <b>${s.settings_locked ? "aktiv 🔒" : "inaktiv"}</b>. Schützt den Einstellungsbereich im Partybetrieb. Das Master-Passwort 174280 funktioniert immer.</p>
      <label class="field">Passwort (PIN)<input id="gPw" type="text" inputmode="numeric" data-numpad placeholder="${s.settings_locked ? "•••••• gesetzt – neue PIN zum Ändern" : "neue PIN"}"></label>
      <div class="btn-row">
        <button class="btn primary" id="gLockOn">${s.settings_locked ? "Passwort ändern" : "Sperre aktivieren"}</button>
        <button class="btn danger" id="gLockOff" ${s.settings_locked ? "" : "hidden"}>Sperre deaktivieren</button>
      </div>
      <button class="btn primary big" id="gSave" style="margin-top:14px">Größen & Anzeige speichern</button></div>`);
    p.querySelector("#gLockOn").onclick = async () => {
      const pw = $("#gPw").value.trim();
      if (!pw) return toast("Bitte ein Passwort eingeben", true);
      await post("/api/settings", {settings: {settings_password: pw}});
      toast(s.settings_locked ? "Passwort geändert" : "Sperre aktiviert"); load(); goSettings("general");
    };
    p.querySelector("#gLockOff").onclick = async () => {
      if (!confirm("Einstellungs-Sperre deaktivieren?")) return;
      await post("/api/settings", {settings: {settings_password: ""}});
      toast("Sperre deaktiviert"); load(); goSettings("general");
    };
    p.querySelector("#gSave").onclick = async () => {
      const sizes = $("#gSizes").value.split(",").map(x => +x.trim()).filter(Boolean);
      await post("/api/settings", {settings: {
        sizes_ml: sizes, default_size_ml: +$("#gDef").value,
        strength_enabled: $("#gStr").checked,
        recipe_sort_mode: $("#gSort").value}});
      toast("Gespeichert"); load();
    };
    w.appendChild(p); return w;
  }

  // ---- Preise ----
  const CATS = [["cocktails","Cocktails"],["alkoholfrei","Alkoholfrei"],["shots","Shots"]];
  function settingsPrices() {
    const w = el('<div></div>'); w.appendChild(backTile());
    const sizes = state.settings.sizes_ml || [200,300,400];
    const P = JSON.parse(JSON.stringify(state.settings.prices || {}));
    P.category_default = P.category_default || {}; P.category_size = P.category_size || {};
    P.recipe_size = P.recipe_size || {}; P.recipe = P.recipe || {}; P.free = (P.free||[]).map(Number);

    const p = el(`<div class="panel"><h3>Preise</h3>
      <label class="field"><span><input type="checkbox" id="prEn" ${P.enabled?"checked":""}> Preise/Bezahlung aktiv</span></label>
      <label class="field">Währungssymbol<input id="prCur" value="${P.currency||"€"}" style="width:80px"></label>
      <h3 style="margin-top:14px">Standardpreis pro Kategorie</h3>
      <div class="row">${CATS.map(([c,t])=>`<label class="field" style="margin:0">${t}
        <input class="prCd sm" data-c="${c}" type="number" step="0.5" value="${P.category_default[c]??""}"></label>`).join("")}</div>
      <h3 style="margin-top:14px">Preis pro Kategorie & Größe <small style="color:var(--muted)">(überschreibt Einzelpreise)</small></h3>
      <div id="prCS"></div>
      <h3 style="margin-top:14px">Pro Cocktail & Größe <small style="color:var(--muted)">(oder Gratis)</small></h3>
      <div id="prRecipes"></div>
      <button class="btn primary big" id="prSave">Speichern</button></div>`);

    // Kategorie+Größe-Gitter
    const cs = el(`<div class="price-grid"><div></div>${sizes.map(s=>`<div style="color:var(--muted);font-size:13px">${s} ml</div>`).join("")}</div>`);
    CATS.forEach(([c,t])=>{
      cs.appendChild(el(`<div>${t}</div>`));
      sizes.forEach(s=>{
        const v=P.category_size[c+"|"+s]??"";
        cs.appendChild(el(`<input class="prCS sm" data-k="${c}|${s}" type="number" step="0.5" placeholder="–" value="${v}">`));
      });
    });
    p.querySelector("#prCS").appendChild(cs);

    // Pro Cocktail
    const rbox = p.querySelector("#prRecipes");
    sortRecipes(state.recipes).forEach(r=>{
      const free = P.free.includes(Number(r.id));
      const row = el(`<div class="part-row" style="gap:10px">
        <span style="flex:1;min-width:120px">${r.name}</span>
        ${sizes.map(s=>`<input class="prRS sm" data-k="${r.id}|${s}" type="number" step="0.5" placeholder="${s}ml" value="${P.recipe_size[r.id+"|"+s]??""}" style="width:72px">`).join("")}
        <label class="mini"><input type="checkbox" class="prFree" data-id="${r.id}" ${free?"checked":""}> Gratis</label>
      </div>`);
      rbox.appendChild(row);
    });

    // --- PayPal-Panel ---
    const pc = state.payConfig || {};
    const PP = state.settings.paypal || {};
    const curMode = pc.mode || PP.mode || "sandbox";
    const cr = pc.credentials || {};
    const credTxt = "Sandbox: " + (cr.sandbox ? "✓" : "–") + " · Live: " + (cr.live ? "✓" : "–");
    const pp = el(`<div class="panel"><h3>PayPal-Bezahlung</h3>
      <p style="color:var(--muted);font-size:13px">Gast bezahlt per QR-Code/PayPal, danach wird zubereitet. Zugangsdaten liegen auf dem Pi in <code>/etc/cocktailbot/paypal.env</code> (je Umgebung Sandbox/Live getrennt möglich), nie hier.</p>
      <label class="field">Umgebung
        <select id="ppMode">
          <option value="sandbox" ${curMode!=="live"?"selected":""}>Sandbox (Test)</option>
          <option value="live" ${curMode==="live"?"selected":""}>Live (echtes Geld)</option>
        </select></label>
      <label class="field"><span><input type="checkbox" id="ppEn" ${PP.enabled?"checked":""}> PayPal-Kassenmodus aktiv</span></label>
      <label class="field"><span><input type="checkbox" id="ppTest" ${PP.test_mode!==false?"checked":""}> Testmodus (Zahlung wird simuliert, ohne echtes PayPal)</span></label>
      <div class="kv"><span>Zugangsdaten hinterlegt</span><b>${credTxt}</b></div>
      <div class="kv"><span>Effektiver Modus</span><b>${pc.test_mode?"Test/Simulation":"Echt ("+(pc.mode||curMode)+")"}</b></div>
      <div class="btn-row">
        <button class="btn" id="ppTestBtn">Verbindung testen</button>
        <button class="btn primary" style="flex:1" id="ppSave">PayPal speichern</button>
      </div></div>`);
    pp.querySelector("#ppTestBtn").onclick = async () => {
      const r = await post("/api/pay/test", {mode: pp.querySelector("#ppMode").value});
      toast(r.ok ? "Verbindung ok ("+r.mode+")" : (r.error||"Test fehlgeschlagen")+" ("+(r.mode||"")+")", !r.ok);
    };
    pp.querySelector("#ppSave").onclick = async () => {
      await post("/api/settings", {settings:{paypal:{enabled:pp.querySelector("#ppEn").checked,
        test_mode:pp.querySelector("#ppTest").checked, mode:pp.querySelector("#ppMode").value,
        brand_name:PP.brand_name||"CocktailBot"}}});
      toast("PayPal gespeichert"); load(); goSettings("prices");
    };
    w.appendChild(pp);

    p.querySelector("#prSave").onclick = async () => {
      const out={enabled:p.querySelector("#prEn").checked, currency:p.querySelector("#prCur").value||"€",
        category_default:{}, category_size:{}, recipe_size:{}, recipe:P.recipe, free:[]};
      p.querySelectorAll(".prCd").forEach(i=>{ if(i.value!=="") out.category_default[i.dataset.c]=+i.value; });
      p.querySelectorAll(".prCS").forEach(i=>{ if(i.value!=="") out.category_size[i.dataset.k]=+i.value; });
      p.querySelectorAll(".prRS").forEach(i=>{ if(i.value!=="") out.recipe_size[i.dataset.k]=+i.value; });
      p.querySelectorAll(".prFree").forEach(i=>{ if(i.checked) out.free.push(+i.dataset.id); });
      await post("/api/settings", {settings:{prices:out}});
      toast("Preise gespeichert"); load();
    };
    w.appendChild(p); return w;
  }

  // ---- LED & WLED ----
  function settingsWled() {
    const w = el('<div></div>'); w.appendChild(backTile());
    const s = state.settings; const W = s.wled || {status:{}};
    const st = W.status || {};
    const statuses = [["ready","Bereit"],["busy","Zubereitung läuft"],["error","Fehler"],["done","Fertig"]];
    const p = el(`<div class="panel"><h3>LED-Statusanzeige</h3>
      <h3 style="margin-top:8px">Pico 2 (USB-LED)</h3>
      <label class="field"><span><input type="checkbox" id="wLed" ${s.led_enabled?"checked":""}> Pico-LED aktiv</span></label>
      <label class="field">Pico-Port<input id="wPort" value="${s.pico_port||"/dev/ttyACM0"}"></label>
      <h3 style="margin-top:14px">WLED (per URL)</h3>
      <p style="color:var(--muted);font-size:13px">Pro Status eine URL, die beim Eintreten aufgerufen wird (GET). Beispiel: <code>http://wled.local/win&PL=1</code></p>
      <label class="field"><span><input type="checkbox" id="wEn" ${W.enabled?"checked":""}> WLED aktiv</span></label>
      ${statuses.map(([k,t])=>`<label class="field">${t}
        <span style="display:flex;gap:8px"><input class="wUrl" data-k="${k}" value="${(st[k]||"").replace(/"/g,"&quot;")}" placeholder="http://..." style="flex:1">
        <button class="btn wTest" data-k="${k}" style="padding:8px 14px">Test</button></span></label>`).join("")}
      <button class="btn primary big" id="wSave">Speichern</button></div>`);
    p.querySelectorAll(".wTest").forEach(b=> b.onclick=async()=>{
      // zuerst speichern, dann testen
      await saveWled(p); await post("/api/wled/test",{status:b.dataset.k}); toast("Test gesendet");
    });
    p.querySelector("#wSave").onclick = async()=>{ await saveWled(p); toast("Gespeichert"); load(); };
    w.appendChild(p); return w;
  }
  async function saveWled(p){
    const status={}; p.querySelectorAll(".wUrl").forEach(i=> status[i.dataset.k]=i.value.trim());
    await post("/api/settings",{settings:{
      led_enabled:p.querySelector("#wLed").checked, pico_port:p.querySelector("#wPort").value,
      wled:{enabled:p.querySelector("#wEn").checked, status}}});
  }

  // ---- Partyplaner ----
  // Druckt einen HTML-Schnipsel sauber (nur dieser Inhalt, Rest ausgeblendet).
  function printHtml(inner) {
    const area = document.createElement("div");
    area.className = "print-area";
    area.innerHTML = inner;
    document.body.appendChild(area);
    document.body.classList.add("printing");
    const done = () => {
      document.body.classList.remove("printing");
      area.remove();
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 60000);  // Fallback
  }

  function settingsParty() {
    const w = el('<div></div>'); w.appendChild(backTile());

    // Getränkekarte
    const menu = el(`<div class="panel"><h3>Partykarte (Getränkekarte)</h3>
      <p style="color:var(--muted);font-size:13px">Teil- und druckbare Karte aller verfügbaren Cocktails. Gäste können sie per QR am Handy öffnen.</p>
      <div class="btn-row">
        <button class="btn primary" id="openMenu">Getränkekarte öffnen</button>
      </div>
      <div id="menuQr" style="text-align:center;margin-top:12px"></div></div>`);
    menu.querySelector("#openMenu").onclick = () => window.open("/menu", "_blank");
    if (state.qr && state.menu_url) {
      menu.querySelector("#menuQr").innerHTML =
        `<img src="/api/qr?data=${encodeURIComponent(state.menu_url)}" style="width:180px;background:#fff;border-radius:12px;padding:10px">
         <div style="color:var(--muted);font-size:12px;margin-top:6px">${state.menu_url}</div>`;
    } else if (state.menu_url) {
      menu.querySelector("#menuQr").innerHTML =
        `<div style="color:var(--muted);font-size:13px">Karte im Netz: <code>${state.menu_url}</code></div>`;
    }
    w.appendChild(menu);

    // Einkaufsliste
    const sizes = state.settings.sizes_ml || [200, 300, 400];
    const avg = state.settings.default_size_ml || sizes[0];
    const p = el(`<div class="panel"><h3>Einkaufsliste berechnen</h3>
      <div class="row">
        <label class="field" style="margin:0">Gäste<input id="pgGuests" type="number" value="20" style="width:90px"></label>
        <label class="field" style="margin:0">Getränke pro Gast<input id="pgPer" type="number" value="4" style="width:90px"></label>
        <label class="field" style="margin:0">Ø Größe (ml)<input id="pgSize" type="number" value="${avg}" style="width:90px"></label>
      </div>
      <p style="color:var(--muted);font-size:13px;margin-top:4px">Angebotene Cocktails auswählen (Standard: alle zapfbaren). Die Getränke werden gleichmäßig verteilt.</p>
      <div id="pgSel" style="max-height:220px;overflow:auto;margin:8px 0"></div>
      <button class="btn primary big" id="pgCalc">Einkaufsliste berechnen</button>
      <div id="pgOut" style="margin-top:14px"></div></div>`);

    const sel = p.querySelector("#pgSel");
    const choose = new Set();
    sortRecipes(state.recipes.filter(r => !r.hidden)).forEach(r => {
      const row = el(`<label class="mini" style="display:flex;gap:8px;padding:4px 0">
        <input type="checkbox" ${r.available ? "checked" : ""} data-id="${r.id}"> ${r.name}${r.available ? "" : " (aus)"}</label>`);
      if (r.available) choose.add(r.id);
      const cb = row.querySelector("input");
      cb.onchange = () => cb.checked ? choose.add(r.id) : choose.delete(r.id);
      sel.appendChild(row);
    });

    p.querySelector("#pgCalc").onclick = () => {
      const guests = +p.querySelector("#pgGuests").value || 0;
      const per = +p.querySelector("#pgPer").value || 0;
      const size = +p.querySelector("#pgSize").value || avg;
      const totalDrinks = guests * per;
      const chosen = state.recipes.filter(r => choose.has(r.id));
      if (!totalDrinks || !chosen.length) { toast("Gäste/Getränke/Auswahl prüfen", true); return; }
      const perCocktail = totalDrinks / chosen.length;
      // Bedarf je Zutat (ml) aufsummieren
      const need = {};  // ingredient_id -> ml
      chosen.forEach(r => {
        const base = (r.base_volume_ml || r.ingredients.reduce((a, i) => a + i.amount_ml, 0)) || 1;
        const f = size / base;
        r.ingredients.forEach(i => {
          need[i.ingredient_id] = (need[i.ingredient_id] || 0) + i.amount_ml * f * perCocktail;
        });
      });
      const rows = Object.entries(need).map(([iid, ml]) => {
        const ing = state.ingredients.find(x => x.id === +iid) || {name: "#" + iid, level_ml: 0, capacity_ml: 1000};
        const stock = ing.level_ml || 0;
        const buy = Math.max(0, ml - stock);
        const cap = ing.capacity_ml || 1000;
        const bottles = buy > 0 ? Math.ceil(buy / cap) : 0;
        return {name: ing.name, need: ml, stock, buy, bottles, cap};
      }).sort((a, b) => b.buy - a.buy);
      const fmtL = (ml) => ml < 1000 ? Math.round(ml) + " ml"
        : (ml / 1000).toFixed(1).replace(".", ",") + " L";
      const tbl = el(`<table><tr><th>Zutat</th><th>Bedarf</th><th>Vorrat</th><th>Kaufen</th></tr></table>`);
      rows.forEach(r => {
        const buyTxt = r.buy >= 10 ? `${fmtL(r.buy)} (≈ ${r.bottles}× ${r.cap >= 1000 ? (r.cap/1000)+"L" : r.cap+"ml"})` : "–";
        tbl.appendChild(elRow(`<tr><td>${r.name}</td><td>${fmtL(r.need)}</td><td>${fmtL(r.stock)}</td>
          <td style="color:${r.buy>0?"var(--accent)":"var(--muted)"};font-weight:700">${buyTxt}</td></tr>`));
      });
      const metaText = `${totalDrinks} Getränke · ${chosen.length} Cocktails · Ø ${size} ml`;
      const out = p.querySelector("#pgOut"); out.innerHTML = "";
      out.appendChild(el(`<p style="color:var(--muted)">${metaText}</p>`));
      out.appendChild(tbl);

      // --- Export: Drucken + Mail ---
      const esc = (s) => String(s).replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
      const buyCell = (r) => r.buy > 0
        ? fmtL(r.buy) + (r.buy >= 10 ? ` (≈ ${r.bottles}× ${r.cap >= 1000 ? (r.cap / 1000) + "L" : r.cap + "ml"})` : "")
        : "–";
      const htmlList = `<h2>CocktailBot – Einkaufsliste</h2><p>${esc(metaText)}</p>`
        + `<table><tr><th>Zutat</th><th>Bedarf</th><th>Vorrat</th><th>Kaufen</th></tr>`
        + rows.map(r => `<tr><td>${esc(r.name)}</td><td>${fmtL(r.need)}</td><td>${fmtL(r.stock)}</td><td>${buyCell(r)}</td></tr>`).join("")
        + `</table>`;
      const textList = `CocktailBot – Einkaufsliste\n${metaText}\n\n`
        + rows.map(r => `${r.name}: kaufen ${r.buy > 0 ? fmtL(r.buy) : "–"} (Bedarf ${fmtL(r.need)}, Vorrat ${fmtL(r.stock)})`).join("\n");

      const bar = el('<div class="btn-row" style="margin-top:12px"></div>');
      const printBtn = el('<button class="btn">Drucken</button>');
      printBtn.onclick = () => printHtml(htmlList);
      const mailBtn = el('<button class="btn primary">Per Mail senden</button>');
      mailBtn.onclick = async () => {
        mailBtn.disabled = true;
        const r = await post("/api/party/shopping/mail", {text: textList, html: htmlList});
        mailBtn.disabled = false;
        toast(r.ok ? "Einkaufsliste per Mail gesendet" : (r.error || "Mailversand fehlgeschlagen"), !r.ok);
      };
      bar.append(printBtn, mailBtn);
      out.appendChild(bar);
    };
    w.appendChild(p);
    return w;
  }

  // ---- Bildschirmtastatur (On-Screen-Keyboard) für den Touchscreen ----
  function initOSK() {
    if (document.getElementById("osk")) return;
    let shift = false, syms = false, numpad = false, active = null;
    const LAYOUT = {
      numpad: [
        ["1","2","3"],
        ["4","5","6"],
        ["7","8","9"],
        [".","0","⌫"],
        ["Fertig"],
      ],
      letters: [
        ["1","2","3","4","5","6","7","8","9","0"],
        ["q","w","e","r","t","z","u","i","o","p","ü"],
        ["a","s","d","f","g","h","j","k","l","ö","ä"],
        ["⇧","y","x","c","v","b","n","m","ß","⌫"],
        ["?123","@","space",".","Fertig"],
      ],
      symbols: [
        ["1","2","3","4","5","6","7","8","9","0"],
        ["!",'"',"#","$","%","&","/","(",")","="],
        ["?","+","-","_",",",":",";","*","€","§"],
        ["{","}","[","]","<",">","\\","|","~","⌫"],
        ["ABC","@","space",".","Fertig"],
      ],
    };
    const osk = el('<div id="osk" class="osk" hidden></div>');
    document.body.appendChild(osk);

    const fireInput = (f) => f.dispatchEvent(new Event("input", {bubbles: true}));
    function insert(ch) {
      if (!active) return;
      const f = active;
      if (f.type === "number") { f.value = (f.value || "") + ch; }
      else {
        let s = f.selectionStart, e = f.selectionEnd;
        if (s == null) { s = e = f.value.length; }
        f.value = f.value.slice(0, s) + ch + f.value.slice(e);
        try { f.selectionStart = f.selectionEnd = s + ch.length; } catch (_) {}
      }
      fireInput(f);
    }
    function backspace() {
      if (!active) return;
      const f = active;
      if (f.type === "number") { f.value = (f.value || "").slice(0, -1); }
      else {
        let s = f.selectionStart, e = f.selectionEnd;
        if (s == null) { s = e = f.value.length; }
        if (s === e && s > 0) { f.value = f.value.slice(0, s - 1) + f.value.slice(e); try { f.selectionStart = f.selectionEnd = s - 1; } catch (_) {} }
        else { f.value = f.value.slice(0, s) + f.value.slice(e); try { f.selectionStart = f.selectionEnd = s; } catch (_) {} }
      }
      fireInput(f);
    }
    function onKey(k) {
      if (k === "space") return insert(" ");
      if (k === "⌫") return backspace();
      if (k === "⇧") { shift = !shift; render(); return; }
      if (k === "?123") { syms = true; render(); return; }
      if (k === "ABC") { syms = false; render(); return; }
      if (k === "Fertig") { hide(); return; }
      let ch = k;
      if (shift && !syms && k.length === 1 && /[a-zöäüß]/.test(k)) { ch = k.toUpperCase(); shift = false; insert(ch); render(); return; }
      insert(ch);
    }
    function render() {
      osk.innerHTML = "";
      osk.className = "osk" + (numpad ? " osk--num" : "");
      (numpad ? LAYOUT.numpad : syms ? LAYOUT.symbols : LAYOUT.letters).forEach(r => {
        const row = el('<div class="osk-row"></div>');
        r.forEach(k => {
          let cls = "osk-key", label = k;
          if (k === "space") { cls += " space"; label = "␣"; }
          if (k === "Fertig") cls += " act wide";
          if (k === "⌫" || k === "?123" || k === "ABC") cls += " mod";
          if (k === "⇧") cls += " mod" + (shift ? " on" : "");
          if (shift && !syms && k.length === 1 && /[a-zöäüß]/.test(k)) label = k.toUpperCase();
          const key = el(`<button class="${cls}">${label}</button>`);
          key.addEventListener("pointerdown", (e) => { e.preventDefault(); onKey(k); });
          row.appendChild(key);
        });
        osk.appendChild(row);
      });
    }
    function show(f) {
      active = f; shift = false; syms = false;
      numpad = (f.type === "password" || f.type === "number" ||
                f.getAttribute("inputmode") === "numeric" || f.hasAttribute("data-numpad"));  // PIN/Zahlen -> Numpad
      render(); osk.hidden = false; document.body.classList.add("osk-open");
    }
    function hide() { osk.hidden = true; document.body.classList.remove("osk-open"); if (active) { try { active.blur(); } catch (_) {} } active = null; }

    const typable = (t) => t && (t.tagName === "TEXTAREA" ||
      (t.tagName === "INPUT" && ["text","password","number","search","tel","email",""].includes((t.getAttribute("type") || "text").toLowerCase())));
    document.addEventListener("focusin", (e) => {
      if (!document.body.classList.contains("kiosk")) return;   // nur am Pi-Touch
      if (e.target.closest("#osk")) return;
      if (typable(e.target)) show(e.target);
    });
    document.addEventListener("focusout", (e) => {
      // Schließen, wenn der Fokus nicht in ein anderes Tippfeld wandert
      setTimeout(() => {
        const a = document.activeElement;
        if (!typable(a) && (!a || !a.closest("#osk"))) hide();
      }, 100);
    });
  }

  // Passwort-Eingabe als eigenes Fenster (damit die Bildschirmtastatur greift).
  function askPassword(title) {
    return new Promise(resolve => {
      const m = el(`<div class="modal" style="z-index:1100"><div class="sheet" style="width:min(420px,94vw)">
        <h2>${title}</h2>
        <label class="field"><input type="password" id="askPwInp" autocomplete="off" style="font-size:18px"></label>
        <div class="btn-row"><button class="btn" id="askPwX">Abbrechen</button>
          <button class="btn primary" id="askPwOk" style="flex:1">OK</button></div></div></div>`);
      document.body.appendChild(m);
      const inp = m.querySelector("#askPwInp");
      const done = (v) => { m.remove(); resolve(v); };
      m.querySelector("#askPwX").onclick = () => done(null);
      m.querySelector("#askPwOk").onclick = () => done(inp.value);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") done(inp.value); });
      m.onclick = (e) => { if (e.target === m) done(null); };
      setTimeout(() => inp.focus(), 60);
    });
  }

  // ---- Init ----
  initOSK();
  let unlocked = false;
  document.querySelectorAll("#tabs button").forEach(b =>
    b.onclick = async () => {
      if (b.dataset.cat === "settings" && state.settings.settings_locked && !unlocked) {
        const pw = await askPassword("Einstellungen gesperrt – Passwort:");
        if (pw === null) return;
        const r = await post("/api/unlock", {password: pw});
        if (!r.ok) { toast("Falsches Passwort", true); return; }
        unlocked = true;
      }
      cat = b.dataset.cat; settingsView = "overview"; render();
    });
  $("#detailModal").onclick = (e) => { if (e.target.id === "detailModal") closeDetail(); };
  $("#editModal").onclick = (e) => { if (e.target.id === "editModal") closeEditor(); };
  load();

  return {ack, stop, closeDetail, closeEditor, closeCheckout};
})();
