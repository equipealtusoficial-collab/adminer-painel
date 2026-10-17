// AdMiner · painel web (GitHub Pages + Supabase)
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const $ = s => document.querySelector(s);
const show = id => ["#setup", "#login", "#app"].forEach(s => ($(s).hidden = s !== id));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = n => (n == null ? "—" : Number(n).toLocaleString("pt-BR"));
const brl = v => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: v % 1 ? 2 : 0 });
const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2800);
}

// ---------- conexão ----------
const fileCfg = window.ADM_CONFIG || {};
let cfg = {
  url: (fileCfg.SUPABASE_URL || ls.get("adm-sb-url", "") || "").trim().replace(/\/+$/, ""),
  key: (fileCfg.SUPABASE_ANON_KEY || ls.get("adm-sb-key", "") || "").trim()
};
let sb = null;

$("#setupForm").addEventListener("submit", e => {
  e.preventDefault();
  const f = new FormData(e.target);
  ls.set("adm-sb-url", String(f.get("url")).trim());
  ls.set("adm-sb-key", String(f.get("key")).trim());
  location.reload();
});
$("#resetCfg").onclick = e => {
  e.preventDefault();
  if (fileCfg.SUPABASE_URL) return toast("Os dados do Supabase estão no config.js");
  localStorage.removeItem("adm-sb-url"); localStorage.removeItem("adm-sb-key"); location.reload();
};
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#loginErr").hidden = true;
  const { error } = await sb.auth.signInWithPassword({ email: f.get("email"), password: f.get("password") });
  if (error) { $("#loginErr").textContent = traduz(error.message); $("#loginErr").hidden = false; return; }
  start();
});
$("#logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };

const traduz = m => /invalid login/i.test(m) ? "E-mail ou senha incorretos." : /email not confirmed/i.test(m) ? "E-mail ainda não confirmado no Supabase." : m;

// mensagens de erro mais úteis
function explica(e) {
  const m = String((e && (e.message || e.details)) || e);
  if (/failed to fetch|networkerror|load failed/i.test(m)) return "a conexão foi bloqueada. Desative o bloqueador de anúncios para este site (uBlock, AdBlock, Brave Shields) e tente de novo.";
  if (/relation .*(salvos|anunciantes).* does not exist|could not find the table/i.test(m)) return "as tabelas novas não existem. Rode o arquivo migracao-v2.1.sql no SQL Editor do Supabase.";
  return m;
}

// ---------- dados ----------
const TYPES = {
  low: ["💸 Low ticket", "gold"], info: ["🎓 Infoproduto", "purple"],
  phys: ["📦 Físico / loja", "gray"], app: ["📱 App / serviço", "gray"], unk: ["❔ Indefinido", "light"]
};
const typeKey = a => (a.offerType === "info" ? (a.lowTicket === true ? "low" : "info") : a.offerType || "unk");

const ADS = new Map();     // id -> anúncio
const ADV = new Map();     // page_id -> { ativos, counted_at }
const nodes = new Map();   // id -> { sig, el }
const selected = new Set();
let VISIBLE = [], lastClicked = null, LIMIT = 60;

const publicUrl = p => (p ? `${cfg.url}/storage/v1/object/public/midia/${p.split("/").map(encodeURIComponent).join("/")}` : "");

function fromRow(r) {
  const d = r.data || {};
  const media = d.media || [];
  const vid = media.find(m => m.type === "video");
  const img = media.find(m => m.type === "image");
  return {
    ...d, id: r.id,
    savedAt: Date.parse(r.saved_at) || 0,
    video_path: r.video_path, thumb_path: r.thumb_path,
    videoUrl: r.video_path ? publicUrl(r.video_path) : vid ? vid.src : "",
    videoIsCloud: !!r.video_path,
    thumbUrl: r.thumb_path ? publicUrl(r.thumb_path) : (vid && vid.poster) || (img && img.src) || ""
  };
}

async function fetchAll() {
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("salvos").select("id,data,video_path,thumb_path,saved_at")
      .eq("deleted", false).order("saved_at", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(explica(error));
    data.forEach(r => ADS.set(r.id, fromRow(r)));
    if (data.length < 1000) break;
  }
  const { data: adv, error: e2 } = await sb.from("anunciantes").select("page_id,ativos,counted_at");
  if (!e2) adv.forEach(a => ADV.set(a.page_id, a));
}

function subscribe() {
  sb.channel("adminer")
    .on("postgres_changes", { event: "*", schema: "public", table: "salvos" }, p => {
      if (p.eventType === "DELETE") ADS.delete(p.old.id);
      else if (p.new.deleted) ADS.delete(p.new.id);
      else ADS.set(p.new.id, fromRow(p.new));
      scheduleRender();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "anunciantes" }, p => {
      if (p.new && p.new.page_id) ADV.set(p.new.page_id, p.new);
      scheduleRender();
    })
    .subscribe(status => $("#live").classList.toggle("on", status === "SUBSCRIBED"));
}

// ---------- render ----------
function daysOf(a) {
  if (a.startDate && a.active) {
    const d = new Date(a.startDate + "T00:00:00");
    if (!isNaN(d)) return Math.max(0, Math.floor((Date.now() - d) / 86400000));
  }
  return a.days;
}
const advOf = a => (a.pageId ? ADV.get(a.pageId) : null);

function filtered() {
  const q = $("#q").value.trim().toLowerCase();
  const fts = [...document.querySelectorAll("#ftypes input:checked")].map(i => i.value);
  const key = {
    saved: a => a.savedAt, days: a => daysOf(a) || 0, count: a => a.count || 0,
    adv: a => (advOf(a) && advOf(a).ativos) || 0, score: a => a.score || 0
  }[$("#sort").value];
  return [...ADS.values()]
    .filter(a => (!fts.length || fts.includes(typeKey(a))) &&
      (!q || [a.pageName, a.copy, a.domain, a.landing].join(" ").toLowerCase().includes(q)))
    .sort((x, y) => key(y) - key(x));
}

function cardHtml(a) {
  const [tl, tc] = TYPES[typeKey(a)];
  const d = daysOf(a), adv = advOf(a);
  const advTxt = adv ? (adv.ativos == null ? "não deu para contar" : num(adv.ativos)) : (a.pageId ? "contando…" : "—");
  const price = a.price != null ? " " + brl(a.price) : "";
  const media = a.videoUrl
    ? `<video controls preload="none" playsinline ${a.thumbUrl ? `poster="${esc(a.thumbUrl)}"` : ""} src="${esc(a.videoUrl)}"></video>`
    : a.thumbUrl ? `<img loading="lazy" src="${esc(a.thumbUrl)}" alt="">`
    : `<div class="nomedia">Sem mídia salva.<br>Abra o anúncio na Biblioteca.</div>`;
  const off = u => (u ? "" : " off");
  return `
    <div class="c-head">
      <button class="c-sel" data-act="sel" title="Selecionar (Shift+clique seleciona um intervalo)"><span>✓</span></button>
      <div class="avatar">${esc(((a.pageName || "?").trim()[0] || "?").toUpperCase())}</div>
      <div class="c-name">
        <a href="${esc(a.pageUrl || "#")}" target="_blank" rel="noopener" title="Perfil do anunciante">${esc(a.pageName || "(sem nome)")}</a>
        <small>${a.active ? "🟢 Ativo" : "⚪ Inativo"}${a.startDate ? " · desde " + esc(a.startDate.split("-").reverse().join("/")) : ""}</small>
      </div>
      <span class="pill ${tc}" title="${esc(a.offerWhy || "")}">${tl}${esc(price)}</span>
    </div>
    <div class="media">${media}</div>
    <div class="metrics">
      <div class="metric"><b>${num(d)}</b><span>dias rodando</span></div>
      <div class="metric"><b>${num(a.count || 1)}</b><span>anúncios usam este criativo</span></div>
      <div class="metric" style="grid-column: span 2"><b>${advTxt}</b><span>anúncios ativos do anunciante${adv && adv.counted_at ? " · contado em " + new Date(adv.counted_at).toLocaleDateString("pt-BR") : ""}</span></div>
    </div>
    ${a.copy ? `<div class="copy" data-act="expand" title="Clique para expandir">${esc(a.copy)}</div>` : ""}
    ${a.domain ? `<div class="domain">🌐 ${esc(a.domain)}${a.cta ? " · " + esc(a.cta) : ""}</div>` : ""}
    <div class="actions">
      <a class="primary${off(a.landing)}" href="${esc(a.landing || "#")}" target="_blank" rel="noopener">🛒 Página de vendas</a>
      <a class="${off(a.advertiserLibraryUrl)}" href="${esc(a.advertiserLibraryUrl || "#")}" target="_blank" rel="noopener">📚 Anúncios do anunciante</a>
      <a class="${off(a.instagramUrl)}" href="${esc(a.instagramUrl || "#")}" target="_blank" rel="noopener">📷 Instagram</a>
      <a href="${esc(a.libraryUrl || "#")}" target="_blank" rel="noopener">🔗 Ver na Biblioteca</a>
      ${a.videoUrl ? `<a href="${esc(a.videoUrl)}${a.videoIsCloud ? "?download=" + esc(a.id) + ".mp4" : ""}" target="_blank" rel="noopener">⬇ Vídeo</a>` : `<button class="off">⬇ Vídeo</button>`}
      <button data-act="copy"${a.copy ? "" : ' class="off"'}>⧉ Copiar copy</button>
      <button class="danger" data-act="remove" style="grid-column: span 2">🗑 Remover</button>
    </div>`;
}

function renderStats(shown) {
  const c = { low: 0, info: 0, phys: 0, app: 0, unk: 0 };
  ADS.forEach(a => c[typeKey(a)]++);
  $("#stats").innerHTML = `<span><b>${ADS.size}</b> salvos</span>
    <span>· 💸 <b>${c.low}</b></span><span>🎓 <b>${c.info}</b></span><span>📦 <b>${c.phys}</b></span>
    <span>📱 <b>${c.app}</b></span><span>❔ <b>${c.unk}</b></span>`;
  const out = ADS.size - shown, fb = $("#filtinfo");
  fb.hidden = out <= 0;
  if (out > 0) {
    fb.innerHTML = `Mostrando <b>${shown}</b> de <b>${ADS.size}</b> — ${out} escondidos pelo filtro/busca. <button id="clearF" class="ghost">Mostrar todos</button>`;
    $("#clearF").onclick = () => { document.querySelectorAll("#ftypes input").forEach(i => (i.checked = false)); $("#q").value = ""; saveUi(); render(); };
  }
}

function render() {
  const list = filtered();
  renderStats(list.length);
  $("#loading").hidden = true;
  $("#empty").hidden = ADS.size > 0;
  const grid = $("#grid");
  const page = list.slice(0, LIMIT);
  const keep = new Set();
  let prev = null;
  for (const a of page) {
    const sig = JSON.stringify([a.offerType, a.lowTicket, a.price, a.count, advOf(a), a.videoUrl, a.thumbUrl, a.active, a.landing, a.pageName]);
    let n = nodes.get(a.id);
    if (!n || n.sig !== sig) {
      const el = n ? n.el : document.createElement("article");
      el.className = "card" + ((a.count || 1) >= 10 ? " hot" : (a.count || 1) >= 2 ? " warm" : "");
      el.dataset.id = a.id;
      el.innerHTML = cardHtml(a);
      n = { sig, el };
      nodes.set(a.id, n);
    }
    keep.add(a.id);
    n.el.classList.toggle("sel", selected.has(a.id));
    n.el.querySelector(".c-sel").classList.toggle("on", selected.has(a.id));
    const want = prev ? prev.nextSibling : grid.firstChild;
    if (want !== n.el) grid.insertBefore(n.el, want);
    prev = n.el;
  }
  for (const [id, n] of nodes) if (!keep.has(id)) { n.el.remove(); if (!ADS.has(id)) nodes.delete(id); }
  for (const id of [...selected]) if (!ADS.has(id)) selected.delete(id);
  VISIBLE = list.map(a => a.id);
  $("#more").hidden = list.length <= LIMIT;
  $("#more").textContent = `Mostrando ${Math.min(LIMIT, list.length)} de ${list.length} — role para carregar mais`;
  renderSel();
}
let rt;
const scheduleRender = () => { clearTimeout(rt); rt = setTimeout(render, 150); };

// carrega mais cards ao chegar no fim da página
new IntersectionObserver(es => {
  if (es.some(e => e.isIntersecting) && VISIBLE.length > LIMIT) { LIMIT += 60; render(); }
}, { rootMargin: "800px" }).observe($("#more"));

// ---------- seleção / remover ----------
function renderSel() {
  const n = selected.size;
  $("#selInfo").textContent = n ? `${n} selecionado${n > 1 ? "s" : ""}` : "";
  $("#selDel").hidden = $("#selClear").hidden = !n;
  $("#selDel").textContent = `🗑 Apagar ${n} selecionado${n > 1 ? "s" : ""}`;
  const all = VISIBLE.length && VISIBLE.every(id => selected.has(id));
  $("#selAll").checked = !!all;
  $("#selAll").indeterminate = !all && VISIBLE.some(id => selected.has(id));
}
function setSel(id, on) {
  if (on) selected.add(id); else selected.delete(id);
  const n = nodes.get(id);
  if (n) { n.el.classList.toggle("sel", on); n.el.querySelector(".c-sel").classList.toggle("on", on); }
}

async function removeIds(ids) {
  const paths = [];
  ids.forEach(id => { const a = ADS.get(id); if (a) { if (a.video_path) paths.push(a.video_path); if (a.thumb_path) paths.push(a.thumb_path); } });
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const { error } = await sb.from("salvos").update({ deleted: true, video_path: null, thumb_path: null, updated_at: new Date().toISOString() }).in("id", part);
    if (error) { toast("Erro ao apagar: " + explica(error)); return false; }
  }
  for (let i = 0; i < paths.length; i += 100) await sb.storage.from("midia").remove(paths.slice(i, i + 100));
  ids.forEach(id => { ADS.delete(id); selected.delete(id); });
  render();
  return true;
}

$("#selAll").addEventListener("change", e => { VISIBLE.forEach(id => setSel(id, e.target.checked)); renderSel(); });
$("#selClear").onclick = () => { [...selected].forEach(id => setSel(id, false)); renderSel(); };
$("#selDel").onclick = async () => {
  const ids = [...selected];
  if (!confirm(`Apagar ${ids.length} anúncio(s)?\nOs vídeos salvos também serão apagados.`)) return;
  if (await removeIds(ids)) toast(`${ids.length} anúncio(s) apagado(s)`);
};

$("#grid").addEventListener("click", async e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const card = b.closest(".card"), id = card.dataset.id, a = ADS.get(id);
  if (!a) return;
  switch (b.dataset.act) {
    case "sel": {
      if (e.shiftKey && lastClicked && VISIBLE.includes(lastClicked)) {
        const [i, j] = [VISIBLE.indexOf(lastClicked), VISIBLE.indexOf(id)].sort((x, y) => x - y);
        VISIBLE.slice(i, j + 1).forEach(x => setSel(x, true));
      } else setSel(id, !selected.has(id));
      lastClicked = id;
      return renderSel();
    }
    case "expand": return b.classList.toggle("open");
    case "copy":
      try { await navigator.clipboard.writeText(a.copy); } catch {
        const ta = document.createElement("textarea"); ta.value = a.copy; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      }
      return toast("Copy copiada");
    case "remove":
      if (!confirm(`Remover o anúncio de "${a.pageName || id}"?\nO vídeo salvo também será apagado.`)) return;
      if (await removeIds([id])) toast("Removido");
  }
});

// ---------- filtros / ordenação / CSV ----------
function saveUi() { ls.set("adm-ui", { ftypes: [...document.querySelectorAll("#ftypes input:checked")].map(i => i.value), sort: $("#sort").value }); }
const ui = ls.get("adm-ui", {});
if (Array.isArray(ui.ftypes)) document.querySelectorAll("#ftypes input").forEach(i => (i.checked = ui.ftypes.includes(i.value)));
if (ui.sort) $("#sort").value = ui.sort;
const onFilter = () => { LIMIT = 60; saveUi(); render(); };
$("#q").addEventListener("input", onFilter);
$("#sort").addEventListener("input", onFilter);
$("#ftypes").addEventListener("change", onFilter);

$("#csv").onclick = () => {
  const cols = [["Anunciante", a => a.pageName], ["Tipo", a => TYPES[typeKey(a)][0]], ["Preço", a => a.price],
    ["Dias rodando", daysOf], ["Anúncios do criativo", a => a.count], ["Anúncios ativos do anunciante", a => advOf(a) && advOf(a).ativos],
    ["Ativo", a => (a.active ? "sim" : "não")], ["Página de vendas", a => a.landing], ["Domínio", a => a.domain],
    ["Anúncios do anunciante", a => a.advertiserLibraryUrl], ["Instagram", a => a.instagramUrl], ["Anúncio na Biblioteca", a => a.libraryUrl],
    ["Vídeo", a => a.videoUrl], ["Copy", a => a.copy]];
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "﻿" + [cols.map(c => cell(c[0])).join(";")].concat(filtered().map(a => cols.map(c => cell(c[1](a))).join(";"))).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const l = document.createElement("a"); l.href = url; l.download = `adminer-${new Date().toISOString().slice(0, 10)}.csv`; l.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

// ---------- início ----------
async function start() {
  show("#app");
  try {
    await fetchAll();
  } catch (e) {
    $("#loading").textContent = "Erro ao carregar: " + (e.message || e) + " — confira se você rodou o supabase.sql.";
    return;
  }
  render();
  subscribe();
}

(async () => {
  if (!cfg.url || !cfg.key) return show("#setup");
  sb = createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data } = await sb.auth.getSession();
  if (data && data.session) start(); else show("#login");
})();
