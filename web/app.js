/* Keepstack single-page client. Vanilla JS, no build step. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { token: localStorage.getItem("keepstack_token"), user: null,
  q: "", media: null, includeTags: [], excludeTags: [], sort: "newest",
  collection: null, limit: 20, offset: 0, total: 0 };

// ---------- API helper ----------
async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  if (opts.json) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(path, { method: opts.json ? "POST" : "GET", ...opts, headers });
  if (!res.ok) {
    if (res.status === 401) logout();
    const error = new Error(res.status === 401 ? "Please sign in again." : "Request failed (" + res.status + ").");
    error.status = res.status; throw error;
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res;
}

function toast(msg, kind = "ok") {
  const t = $("#toast"); t.textContent = msg; t.className = "toast " + kind;
  setTimeout(() => t.classList.add("hidden"), 2600);
}
const fmtBytes = (b) => { if (!b) return "0 B"; const u = ["B","KB","MB","GB","TB"]; const i = Math.floor(Math.log(b)/Math.log(1024)); return (b/Math.pow(1024,i)).toFixed(i?1:0)+" "+u[i]; };
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// ---------- auth ----------
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/auth/login", { json: { username: $("#login-user").value, password: $("#login-pass").value } });
    state.token = r.token; localStorage.setItem("keepstack_token", r.token);
    state.user = r.user; enterApp();
  } catch (error) {
    $("#login-error").textContent = error.status === 401 ? "Invalid credentials" : "Unable to sign in. " + error.message;
    $("#login-error").classList.remove("hidden");
  }
});
$("#btn-logout").addEventListener("click", logout);
function logout() { localStorage.removeItem("keepstack_token"); state.token = null; state.user = null;
  libraryVersion++; clearTimeout(searchTimer); libraryController?.abort(); appliedQuery = null;
  $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); }

function enterApp() {
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#user-label").textContent = `${state.user.username} (${state.user.role})`;
  const isAdmin = state.user.role === "admin";
  $$(".admin-only").forEach(el => el.classList.toggle("hidden", !isAdmin));
  loadLibrary();
}

// ---------- navigation ----------
$$(".nav-item").forEach(btn => btn.addEventListener("click", () => {
  $$(".nav-item").forEach(b => b.classList.remove("active")); btn.classList.add("active");
  const view = btn.dataset.view;
  $$(".view").forEach(v => v.classList.add("hidden"));
  $("#view-" + (view === "library" ? "library" : view)).classList.remove("hidden");
  if (view === "library") loadLibrary();
  if (view === "collections") loadCollections();
  if (view === "dashboard") loadDashboard();
  if (view === "users") loadUsers();
  if (view === "audit") loadAudit();
}));

// ---------- library / search ----------
let searchTimer, libraryController;
let libraryVersion = 0, appliedQuery = null, libraryBusy = false, exporting = false;
let filterOptions = { collections: [], tags: [] };

function querySnapshot() {
  return { q: state.q, media: state.media, collection: state.collection, sort: state.sort,
    includeTags: [...state.includeTags], excludeTags: [...state.excludeTags],
    limit: state.limit, offset: state.offset };
}

function queryParams(query, paged = true) {
  const params = new URLSearchParams({ q: query.q, sort: query.sort });
  if (query.media) params.set("media_type", query.media);
  if (query.collection) params.set("collection_id", query.collection);
  query.includeTags.forEach(tag => params.append("include_tags", tag));
  query.excludeTags.forEach(tag => params.append("exclude_tags", tag));
  if (paged) { params.set("limit", query.limit); params.set("offset", query.offset); }
  return params;
}

function changeFilters(changes, delay = 0) {
  Object.assign(state, changes, { offset: 0 });
  return loadLibrary(delay);
}

$("#search").addEventListener("input", e => changeFilters({ q: e.target.value }, 250));
$("#sort").addEventListener("change", e => changeFilters({ sort: e.target.value }));
$("#collection-filter").addEventListener("change", e => changeFilters({ collection: e.target.value || null }));
$("#media-filter").addEventListener("change", e => changeFilters({ media: e.target.value || null }));
for (const [id, key] of [["include-tags", "includeTags"], ["exclude-tags", "excludeTags"]]) {
  $("#" + id).addEventListener("change", e => {
    if (e.target.type !== "checkbox") return;
    const tags = new Set(state[key]);
    if (e.target.checked) tags.add(e.target.value); else tags.delete(e.target.value);
    changeFilters({ [key]: [...tags] });
  });
}
$("#clear-filters").addEventListener("click", () => {
  $("#search").value = "";
  changeFilters({ q: "", collection: null, media: null, includeTags: [], excludeTags: [] });
});
$("#prev-page").addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.limit); loadLibrary(); });
$("#next-page").addEventListener("click", () => { state.offset += state.limit; loadLibrary(); });
$("#retry-library").addEventListener("click", () => loadLibrary());
$("#export-csv").addEventListener("click", exportCSV);

function updateLibraryButtons() {
  $("#prev-page").disabled = libraryBusy || !appliedQuery || state.offset === 0;
  $("#next-page").disabled = libraryBusy || !appliedQuery || state.offset + state.limit >= state.total;
  $("#export-csv").disabled = libraryBusy || !appliedQuery || exporting;
  $("#export-csv").querySelector(".export-label").textContent = exporting ? "Exporting..." : "Export CSV";
}

function renderActiveFilters(query) {
  const entries = [];
  if (query.q.trim()) entries.push(["q", query.q, "Keyword: " + query.q]);
  if (query.collection) {
    const collection = filterOptions.collections.find(item => String(item.id) === String(query.collection));
    entries.push(["collection", query.collection, "Collection: " + (collection?.name || query.collection)]);
  }
  if (query.media) entries.push(["media", query.media, "Type: " + query.media]);
  query.includeTags.forEach(tag => entries.push(["includeTags", tag, "Include: " + tag]));
  query.excludeTags.forEach(tag => entries.push(["excludeTags", tag, "Exclude: " + tag]));
  const container = $("#active-filters");
  container.replaceChildren();
  entries.forEach(([key, value, label]) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "chip"; button.textContent = label;
    button.title = "Remove " + label; button.setAttribute("aria-label", "Remove " + label);
    button.addEventListener("click", () => {
      const change = key === "includeTags" || key === "excludeTags"
        ? { [key]: state[key].filter(tag => tag !== value) } : { [key]: key === "q" ? "" : null };
      if (key === "q") $("#search").value = "";
      changeFilters(change);
    });
    container.append(button);
  });
  $("#clear-filters").disabled = entries.length === 0;
  $("#include-count").textContent = query.includeTags.length || "";
  $("#exclude-count").textContent = query.excludeTags.length || "";
  $("#collection-filter").value = query.collection || "";
  $("#media-filter").value = query.media || "";
}

function renderFilterOptions(query, facets) {
  $("#collection-filter").innerHTML = '<option value="">All collections</option>' +
    filterOptions.collections.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join("");
  const media = [...new Set([...(facets.media_types || []).map(m => m.value), ...(query.media ? [query.media] : [])])];
  $("#media-filter").innerHTML = '<option value="">All types</option>' +
    media.map(type => '<option value="' + esc(type) + '">' + esc(type) + '</option>').join("");
  const tags = [...new Set([...filterOptions.tags.map(tag => tag.name), ...query.includeTags, ...query.excludeTags])].sort();
  for (const [id, key, action] of [["include-tags", "includeTags", "Include"], ["exclude-tags", "excludeTags", "Exclude"]]) {
    $("#" + id).innerHTML = tags.map(tag => '<label><input type="checkbox" value="' + esc(tag) +
      '" aria-label="' + action + ' tag ' + esc(tag) + '"' + (query[key].includes(tag) ? " checked" : "") +
      '><span>' + esc(tag) + '</span></label>').join("") || '<span class="muted">No tags</span>';
  }
  renderActiveFilters(query);
}

function loadLibrary(delay = 0) {
  clearTimeout(searchTimer);
  const version = ++libraryVersion;
  libraryController?.abort();
  const controller = new AbortController();
  libraryController = controller;
  const query = querySnapshot();
  appliedQuery = null; libraryBusy = true;
  $("#library-error").classList.add("hidden");
  $("#empty").classList.add("hidden");
  $("#grid").classList.add("hidden");
  $("#library-status").classList.remove("hidden");
  $("#result-title").textContent = "Searching...";
  $("#page-info").textContent = "Loading...";
  $("#grid").setAttribute("aria-busy", "true");
  renderActiveFilters(query);
  updateLibraryButtons();
  if (delay) { searchTimer = setTimeout(() => fetchLibrary(query, version, controller.signal), delay); return; }
  return fetchLibrary(query, version, controller.signal);
}

async function fetchLibrary(query, version, signal) {
  try {
    const [data, collections, tags] = await Promise.all([
      api("/api/assets?" + queryParams(query), { signal }),
      api("/api/collections", { signal }), api("/api/tags", { signal }),
    ]);
    if (version !== libraryVersion) return;
    if (query.offset > 0 && data.items.length === 0 && data.total > 0) {
      state.offset = Math.floor((data.total - 1) / state.limit) * state.limit;
      return loadLibrary();
    }
    if (data.total === 0) { query.offset = 0; state.offset = 0; }
    state.total = data.total;
    filterOptions = { collections: collections.collections, tags: tags.tags };
    appliedQuery = query;
    renderFilterOptions(query, data.facets);
    renderFacets(data.facets);
    renderGrid(data.items, data.total);
    $("#grid").classList.remove("hidden");
    $("#page-info").textContent = data.total
      ? (query.offset + 1) + "-" + (query.offset + data.items.length) + " of " + data.total
      : "0 results";
  } catch (error) {
    if (version !== libraryVersion || error.name === "AbortError") return;
    $("#result-title").textContent = "Assets unavailable";
    $("#library-error-message").textContent = "Could not load assets. " + error.message;
    $("#library-error").classList.remove("hidden");
    $("#page-info").textContent = "Unavailable";
  } finally {
    if (version === libraryVersion) {
      libraryBusy = false;
      $("#library-status").classList.add("hidden");
      $("#grid").setAttribute("aria-busy", "false");
      updateLibraryButtons();
    }
  }
}

async function exportCSV() {
  if (!appliedQuery || libraryBusy || exporting) return;
  const query = appliedQuery;
  exporting = true; updateLibraryButtons();
  try {
    const response = await api("/api/assets/export.csv?" + queryParams(query, false));
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "keepstack-assets.csv";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("CSV downloaded");
  } catch (error) {
    toast("CSV download failed. " + error.message, "err");
  } finally { exporting = false; updateLibraryButtons(); }
}

function renderGrid(items, total) {
  $("#result-title").textContent = (state.q.trim() ? "Results" : "Library") + " (" + total + ")";
  $("#empty").classList.toggle("hidden", items.length > 0);
  $("#grid").innerHTML = items.map(a => '<div class="card" role="button" tabindex="0" data-uuid="' + esc(a.uuid) + '">' +
    '<img class="thumb" loading="lazy" src="/api/assets/' + esc(a.uuid) + '/thumb" alt="' + esc(a.alt_text || a.title) + '">' +
    '<div class="meta"><span class="title" title="' + esc(a.title) + '">' + esc(a.title) +
    '</span><span class="sub"><span class="badge">' + esc(a.media_type) + '</span><span>' + fmtBytes(a.size) +
    '</span></span><time class="muted card-created" datetime="' + esc(a.created_at) + '">' +
    esc((a.created_at || "").slice(0, 10)) + '</time></div></div>').join("");
  $$("#grid .card").forEach(card => {
    card.addEventListener("click", () => openAsset(card.dataset.uuid));
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openAsset(card.dataset.uuid); }
    });
  });
}

function renderFacets(facets) {
  $("#facet-media").innerHTML = (facets.media_types || []).map(m => '<li><button class="' +
    (state.media === m.value ? "active" : "") + '" data-media="' + esc(m.value) + '"><span>' + esc(m.value) +
    '</span><span class="count">' + m.count + '</span></button></li>').join("");
  $("#facet-tags").innerHTML = (facets.tags || []).slice(0, 18).map(t => '<li><button class="' +
    (state.includeTags.includes(t.value) ? "active" : "") + '" data-tag="' + esc(t.value) + '"><span>' + esc(t.value) +
    '</span><span class="count">' + t.count + '</span></button></li>').join("");
  $$("#facet-media button").forEach(button => button.addEventListener("click", () =>
    changeFilters({ media: state.media === button.dataset.media ? null : button.dataset.media })));
  $$("#facet-tags button").forEach(button => button.addEventListener("click", () => {
    const tag = button.dataset.tag;
    changeFilters({ includeTags: state.includeTags.includes(tag)
      ? state.includeTags.filter(value => value !== tag) : [...state.includeTags, tag] });
  }));
}

// ---------- asset detail drawer ----------
const drawer = $("#drawer");
$("#drawer-close").addEventListener("click", closeDrawer);
$(".drawer-backdrop").addEventListener("click", closeDrawer);
function closeDrawer() { drawer.classList.add("hidden"); document.body.classList.remove("modal-open"); }

async function openAsset(uuid) {
  drawer.classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("#drawer-body").innerHTML = '<p class="muted">Loading...</p>';
  const [d, meta, sim] = await Promise.all([
    api("/api/assets/" + uuid),
    api("/api/assets/" + uuid + "/metadata"),
    api("/api/assets/" + uuid + "/similar"),
  ]);
  const a = d.asset;
  const canEdit = ["admin","editor","contributor"].includes(state.user.role);
  const preview = a.media_type === "image"
    ? `<img class="detail-preview" src="/api/assets/${uuid}/preview" alt="${esc(a.alt_text||a.title)}">`
    : `<img class="detail-preview" src="/api/assets/${uuid}/thumb" alt="${esc(a.title)}">`;
  const dc = a.dublin_core || {};
  $("#drawer-body").innerHTML = `
    ${preview}
    <h2 class="detail-title">${esc(a.title)}</h2>
    <p class="muted">${a.media_type} &middot; ${a.ext?.toUpperCase()} &middot; ${fmtBytes(a.size)} ${a.width?`&middot; ${a.width}&times;${a.height}`:""}</p>
    <div class="btn-row">
      <a class="btn" href="/api/assets/${uuid}/file" download>Download</a>
      ${canEdit?`<button class="btn" id="d-share">Create share link</button>`:""}
      ${["admin","editor"].includes(state.user.role)?`<button class="btn btn-danger" id="d-delete">Delete</button>`:""}
    </div>

    ${canEdit ? `<div class="detail-section"><h4>Edit metadata</h4>
      <div class="edit-grid">
        <label>Title<input id="e-title" value="${esc(a.title)}"></label>
        <label>Description<textarea id="e-description" rows="2">${esc(a.description)}</textarea></label>
        <label>Alt text (accessibility)<input id="e-alt_text" value="${esc(a.alt_text)}"></label>
        <label>Creator<input id="e-dc_creator" value="${esc(a.dc_creator)}"></label>
        <label>Rights / license<input id="e-rights_statement" value="${esc(a.rights_statement)}"></label>
        <label>Retention until<input id="e-retention_until" type="date" value="${esc((a.retention_until||'').slice(0,10))}"></label>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="d-save">Save changes</button></div></div>` : ""}

    <div class="detail-section"><h4>Tags</h4>
      <div class="tag-row" id="tag-row">
        ${d.tags.map(t => `<span class="tag ${t.source==='ai'?'ai':''}">${esc(t.name)}${canEdit?`<span class="rm" data-tag="${esc(t.name)}">&times;</span>`:""}</span>`).join("")}
        ${canEdit?`<input class="tag-add" id="tag-add" placeholder="+ add tag">`:""}
      </div></div>

    ${sim.items.length?`<div class="detail-section"><h4>Similar assets</h4>
      <div class="similar-strip">${sim.items.slice(0,8).map(s=>`<img src="/api/assets/${s.uuid}/thumb" data-uuid="${s.uuid}" title="${esc(s.title)}">`).join("")}</div></div>`:""}

    <div class="detail-section"><h4>Dublin Core</h4>
      ${Object.entries(dc).filter(([,v])=>v).map(([k,v])=>`<div class="field-row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join("")}
      <div class="btn-row"><a class="btn btn-ghost" href="/oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=oai::${a.uuid}" target="_blank">View OAI-PMH XML</a></div>
    </div>

    ${Object.keys(meta.exif||{}).length||Object.keys(meta.iptc||{}).length?`<div class="detail-section"><h4>Embedded metadata (EXIF / IPTC)</h4>
      <div class="kv-scroll">${[...Object.entries(meta.iptc||{}),...Object.entries(meta.exif||{})].slice(0,40).map(([k,v])=>`<div class="field-row"><span class="k">${esc(k)}</span><span class="v">${esc(typeof v==='object'?JSON.stringify(v):v)}</span></div>`).join("")}</div></div>`:""}

    ${d.versions.length?`<div class="detail-section"><h4>Versions</h4>${d.versions.map(v=>`<div class="field-row"><span class="k">v${v.version_no}</span><span class="v">${esc(v.note||'')} &middot; ${fmtBytes(v.size)} &middot; ${(v.created_at||'').slice(0,10)}</span></div>`).join("")}</div>`:""}
  `;

  // wire detail actions
  $$("#drawer-body .similar-strip img").forEach(img => img.addEventListener("click", () => openAsset(img.dataset.uuid)));
  if (canEdit) {
    $("#d-save")?.addEventListener("click", async () => {
      const body = {};
      ["title","description","alt_text","dc_creator","rights_statement","retention_until"].forEach(f => { const el = $("#e-"+f); if (el) body[f] = el.value; });
      await api("/api/assets/"+uuid, { method: "PATCH", json: body });
      toast("Saved"); openAsset(uuid); loadLibrary();
    });
    $("#tag-add")?.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && e.target.value.trim()) {
        await api("/api/assets/"+uuid+"/tags", { json: { name: e.target.value.trim() } });
        openAsset(uuid); loadLibrary();
      }
    });
    $$("#tag-row .rm").forEach(rm => rm.addEventListener("click", async () => {
      await api("/api/assets/"+uuid+"/tags/"+encodeURIComponent(rm.dataset.tag), { method: "DELETE" });
      openAsset(uuid); loadLibrary();
    }));
    $("#d-share")?.addEventListener("click", async () => {
      const r = await api("/api/shares", { json: { target_type: "asset", target_id: a.id, permission: "download" } });
      await navigator.clipboard?.writeText(r.url).catch(()=>{});
      toast("Share link copied: " + r.url);
    });
  }
  $("#d-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this asset?")) return;
    await api("/api/assets/"+uuid, { method: "DELETE" });
    toast("Deleted"); closeDrawer(); loadLibrary();
  });
}

// ---------- upload ----------
const uploadModal = $("#upload-modal");
$("#btn-upload").addEventListener("click", () => { uploadModal.classList.remove("hidden"); document.body.classList.add("modal-open"); });
$("#upload-cancel").addEventListener("click", () => { uploadModal.classList.add("hidden"); document.body.classList.remove("modal-open"); loadLibrary(); });
$(".modal-backdrop").addEventListener("click", () => { uploadModal.classList.add("hidden"); document.body.classList.remove("modal-open"); });
const dz = $("#dropzone"), fileInput = $("#file-input");
dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag"); uploadFiles(e.dataTransfer.files); });
fileInput.addEventListener("change", () => uploadFiles(fileInput.files));

async function uploadFiles(files) {
  const list = $("#upload-list");
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "upload-item"; row.innerHTML = `<span>${esc(file.name)}</span><span>uploading...</span>`;
    list.prepend(row);
    const fd = new FormData(); fd.append("files", file); fd.append("run_ai", $("#ai-toggle").checked);
    try {
      const r = await api("/api/assets", { method: "POST", body: fd });
      const created = r.created[0];
      row.classList.add(created.duplicate ? "dup" : "ok");
      row.lastChild.textContent = created.duplicate ? "duplicate (deduped)" : "done";
    } catch (err) { row.classList.add("err"); row.lastChild.textContent = "failed"; }
  }
}

// ---------- collections ----------
async function loadCollections() {
  const data = await api("/api/collections");
  $("#collection-list").innerHTML = data.collections.map(c =>
    `<div class="collection-card" data-id="${c.id}"><span class="n">${esc(c.name)}</span><span class="muted">${c.asset_count} assets</span><span class="muted">${esc(c.description||"")}</span></div>`).join("")
    || '<p class="muted">No collections yet.</p>';
  $$("#collection-list .collection-card").forEach(card => card.addEventListener("click", () => {
    state.collection = card.dataset.id; state.offset = 0;
    $$(".nav-item").forEach(b => b.classList.remove("active"));
    $('.nav-item[data-view="library"]').classList.add("active");
    $$(".view").forEach(v => v.classList.add("hidden")); $("#view-library").classList.remove("hidden");
    loadLibrary();
  }));
}
$("#btn-new-collection").addEventListener("click", async () => {
  const name = prompt("Collection name"); if (!name) return;
  await api("/api/collections", { json: { name } }); loadCollections();
});

// ---------- dashboard ----------
async function loadDashboard() {
  const s = await api("/api/stats");
  const cards = [
    ["Total assets", s.total_assets], ["Storage used", fmtBytes(s.total_bytes)],
    ["Saved by dedup", fmtBytes(s.dedup_saved_bytes)], ["Tags", s.tags], ["Collections", s.collections],
    ...Object.entries(s.by_type).map(([k,v]) => [k.charAt(0).toUpperCase()+k.slice(1), v]),
  ];
  $("#stat-cards").innerHTML = cards.map(([l,n]) => `<div class="stat-card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");
}
$("#btn-fixity").addEventListener("click", async () => {
  $("#fixity-result").textContent = "Checking...";
  const r = await api("/api/admin/fixity", { method: "POST" });
  $("#fixity-result").textContent = r.ok ? `All ${r.checked} blobs verified. Integrity intact.` : `${r.failures.length} of ${r.checked} failed fixity.`;
});

// ---------- users ----------
async function loadUsers() {
  const data = await api("/api/users");
  $("#user-rows").innerHTML = data.users.map(u =>
    `<tr><td>${esc(u.username)}</td><td>${esc(u.email||"")}</td><td>${u.role}</td><td>${u.is_active?"Yes":"No"}</td><td>${(u.last_login||"").slice(0,16).replace("T"," ")}</td></tr>`).join("");
}
$("#btn-new-user").addEventListener("click", async () => {
  const username = prompt("Username"); if (!username) return;
  const password = prompt("Temporary password"); if (!password) return;
  const role = prompt("Role (admin/editor/contributor/viewer)", "contributor") || "viewer";
  await api("/api/users", { json: { username, password, role } }); loadUsers();
});

// ---------- audit ----------
async function loadAudit() {
  const data = await api("/api/audit");
  $("#audit-rows").innerHTML = data.entries.map(e =>
    `<tr><td>${(e.ts||"").slice(0,19).replace("T"," ")}</td><td>${esc(e.username||"-")}</td><td>${esc(e.action)}</td>
     <td>${esc(e.target_type||"")} ${esc((e.target_id||"").slice(0,8))}</td><td>${esc(e.detail||"")}</td><td>${esc(e.ip||"")}</td></tr>`).join("");
}

// ---------- boot ----------
(async function boot() {
  if (state.token) {
    try { state.user = await api("/api/auth/me"); enterApp(); return; } catch {}
  }
  $("#login").classList.remove("hidden");
})();
