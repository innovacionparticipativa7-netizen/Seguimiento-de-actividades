// =====================================================================
//  STANDARD WORK
// =====================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, collection, collectionGroup, query, where, limit,
  getDocs, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBctWFKAbuXahU85M5g0rPbedNeTmyUBx4",
  authDomain: "tarjeta-ip.firebaseapp.com",
  projectId: "tarjeta-ip",
  storageBucket: "tarjeta-ip.firebasestorage.app",
  messagingSenderId: "290616524935",
  appId: "1:290616524935:web:27e33ccb3d7823a6ce3822"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/*
  ESTRUCTURA EN FIRESTORE
  - usuarios/{numeroEmpleado}             → nombre, area, rol, cinturon, puntosActuales, puntosAcumulados
  - usuarios/{numeroEmpleado}/actividades → actividades del Standard Work
  - evaluaciones_5s/{num_tipo_fecha}      → numeroEmpleado, fecha (AAAA-MM-DD), tipo (semanal|mensual), porcentaje
  - ideas_ip                              → (ya existente) se cuentan las ideas del empleado
*/
const COL = {
  usuarios: "usuarios",
  actividades: "actividades",
  evals: "evaluaciones_5s",
  ideas: "ideas_ip"
};

const BELTS = [
  { key: "white",  nombre: "White Belt",  color: "#ffffff" },
  { key: "yellow", nombre: "Yellow Belt", color: "#facc15" },
  { key: "green",  nombre: "Green Belt",  color: "#16a34a" },
  { key: "blue",   nombre: "Blue Belt",   color: "#2563eb" },
  { key: "black",  nombre: "Black Belt",  color: "#111827" }
];

// ================== ESTADO ==================
let usuario = null;
let actividades = [];
let evals5S = [];
const estMi  = { periodo: "dia",    fecha: new Date() };
const estAdm = { periodo: "semana", fecha: new Date() };
let cacheUsuarios = null;   // lista de todos los usuarios (admin)
let equipo = null;          // { acts: Map, evals: Map }
let tipoCarga = "usuarios";
let cargaFilas = [];

const $ = (id) => document.getElementById(id);

// ================== UTILIDADES ==================
const aISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hoyISO = () => aISO(new Date());

const escapar = (txt) =>
  String(txt ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const formatoFecha = (iso) => {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-");
  return `${d}/${m}/${y}`;
};

const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const MESES_C = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const DIAS = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];

const redondear = (n) => Math.round(n * 10) / 10;
const colorPct = (p) => (p >= 80 ? "var(--ok)" : p >= 50 ? "var(--mid)" : "var(--pend)");
const textoPct = (p) => (p === null || p === undefined ? "—" : `${redondear(p)}%`);

function aFecha(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === "object" && "seconds" in v) return new Date(v.seconds * 1000);
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d); }
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  return null;
}

function rangoSemana(fecha) {
  const ini = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  ini.setDate(ini.getDate() - ((ini.getDay() + 6) % 7)); // lunes
  const fin = new Date(ini);
  fin.setDate(ini.getDate() + 6);
  return [ini, fin];
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("visible"), 2600);
}

function guardarSesion(num) { try { localStorage.setItem("empleado", num); } catch {} }
function leerSesion() { try { return localStorage.getItem("empleado"); } catch { return null; } }
function borrarSesion() { try { localStorage.removeItem("empleado"); } catch {} }

// ================== ROLES ==================
function rolDe(u) {
  const r = norm(u?.rol);
  if (r === "master") return "master";
  if (["admin", "administrador", "gerente", "supervisor"].includes(r)) return "admin";
  return "usuario";
}
const esAdmin = () => ["admin", "master"].includes(rolDe(usuario));
const esMaster = () => rolDe(usuario) === "master";
const numDe = (u) => String(u.numeroEmpleado || u.control || u.id);

// ================== CINTURONES ==================
function normalizarBelt(valor) {
  const t = norm(valor);
  if (/black|negr/.test(t)) return "black";
  if (/blue|azul/.test(t)) return "blue";
  if (/green|verde/.test(t)) return "green";
  if (/yellow|amarill/.test(t)) return "yellow";
  if (/white|blanc/.test(t)) return "white";
  return null;
}
function beltHTML(valor, pequeno = false) {
  const key = normalizarBelt(valor);
  const b = BELTS.find((x) => x.key === key);
  return `<span class="belt-badge ${key || "sin"} ${pequeno ? "peq" : ""}">${b ? b.nombre : "Sin asignar"}</span>`;
}

// ================== PERIODOS (compartido) ==================
function rangoDe(est) {
  const f = est.fecha;
  if (est.periodo === "dia") {
    const iso = aISO(f);
    return { ini: iso, fin: iso, etiqueta: `${DIAS[f.getDay()]} ${f.getDate()} de ${MESES[f.getMonth()]} ${f.getFullYear()}` };
  }
  if (est.periodo === "semana") {
    const [i, e] = rangoSemana(f);
    return { ini: aISO(i), fin: aISO(e), etiqueta: `Semana ${i.getDate()} ${MESES_C[i.getMonth()]} – ${e.getDate()} ${MESES_C[e.getMonth()]} ${e.getFullYear()}` };
  }
  if (est.periodo === "mes") {
    const i = new Date(f.getFullYear(), f.getMonth(), 1);
    const e = new Date(f.getFullYear(), f.getMonth() + 1, 0);
    return { ini: aISO(i), fin: aISO(e), etiqueta: `${MESES[i.getMonth()]} ${i.getFullYear()}` };
  }
  return { ini: null, fin: null, etiqueta: "Todas las actividades" };
}
const enRango = (fechaISO, r) => !r.ini || (fechaISO >= r.ini && fechaISO <= r.fin);

function mover(est, dir) {
  const d = new Date(est.fecha);
  if (est.periodo === "dia") d.setDate(d.getDate() + dir);
  else if (est.periodo === "semana") d.setDate(d.getDate() + 7 * dir);
  else if (est.periodo === "mes") { d.setDate(1); d.setMonth(d.getMonth() + dir); }
  est.fecha = d;
}

function pintarPeriodo(cont, est) {
  cont.querySelectorAll(".seg").forEach((b) => b.classList.toggle("activo", b.dataset.periodo === est.periodo));
  cont.querySelector(".nav-periodo").hidden = est.periodo === "todos";
  cont.querySelector(".lbl-periodo").textContent = rangoDe(est).etiqueta;
}

function enlazarPeriodo(cont, est, alCambiar) {
  const listo = () => { pintarPeriodo(cont, est); alCambiar(); };
  cont.querySelectorAll(".seg").forEach((b) => b.addEventListener("click", () => { est.periodo = b.dataset.periodo; listo(); }));
  cont.querySelectorAll("[data-mover]").forEach((b) => b.addEventListener("click", () => { mover(est, Number(b.dataset.mover)); listo(); }));
  cont.querySelector("[data-hoy]").addEventListener("click", () => { est.fecha = new Date(); listo(); });
  pintarPeriodo(cont, est);
}

// ================== CÁLCULO DE CUMPLIMIENTO ==================
/*
  - Ninguna actividad con % → todas valen lo mismo.
  - Algunas con % → valen su %, y lo que falte para 100 se reparte entre las demás.
  - Si los % suman 100 o más → se normalizan a 100.
*/
function calcularPesos(lista) {
  const pesos = new Map();
  const tienePct = (a) => typeof a.porcentaje === "number" && !isNaN(a.porcentaje) && a.porcentaje > 0;
  const con = lista.filter(tienePct);
  const sin = lista.filter((a) => !tienePct(a));
  const suma = con.reduce((s, a) => s + a.porcentaje, 0);
  let modo = "Equitativo";
  let aviso = "";

  if (lista.length === 0) return { pesos, modo: "—", aviso };

  if (con.length === 0) {
    lista.forEach((a) => pesos.set(a.id, 100 / lista.length));
  } else if (suma >= 100 || sin.length === 0) {
    modo = "Ponderado";
    con.forEach((a) => pesos.set(a.id, (a.porcentaje * 100) / suma));
    sin.forEach((a) => pesos.set(a.id, 0));
    if (suma !== 100) aviso = `Los porcentajes asignados suman ${redondear(suma)}%; se ajustaron proporcionalmente a 100%.`;
    if (sin.length && suma >= 100) aviso += ` ${sin.length} actividad(es) sin % quedan con peso 0.`;
  } else {
    modo = "Mixto";
    con.forEach((a) => pesos.set(a.id, a.porcentaje));
    const resto = (100 - suma) / sin.length;
    sin.forEach((a) => pesos.set(a.id, resto));
  }
  return { pesos, modo, aviso: aviso.trim() };
}

function cumplimiento(lista) {
  const { pesos, modo, aviso } = calcularPesos(lista);
  const hechas = lista.filter((a) => a.completada).length;
  const pct = lista.length
    ? redondear(lista.reduce((s, a) => s + (a.completada ? (pesos.get(a.id) ?? 0) : 0), 0))
    : null;
  return { pct, pesos, modo, aviso, hechas, total: lista.length };
}

// ================== 5S ==================
function normalizarEval(d) {
  let p = Number(d.porcentaje);
  if (!isNaN(p) && p > 0 && p <= 1) p *= 100;
  return { pct: isNaN(p) ? null : p, fecha: aFecha(d.fecha), tipo: norm(d.tipo) };
}

function resumen5S(lista, base) {
  const [ini, fin] = rangoSemana(base);
  fin.setHours(23, 59, 59, 999);
  const validas = lista.filter((e) => e.pct !== null && e.fecha);
  const sem = validas.filter((e) => (!e.tipo || e.tipo.startsWith("sem")) && e.fecha >= ini && e.fecha <= fin);
  const mes = validas.filter((e) => (!e.tipo || e.tipo.startsWith("men")) &&
    e.fecha.getMonth() === base.getMonth() && e.fecha.getFullYear() === base.getFullYear());
  const prom = (a) => (a.length ? a.reduce((s, e) => s + e.pct, 0) / a.length : null);
  const ultima = [...validas].sort((a, b) => b.fecha - a.fecha)[0] || null;
  return { semanal: prom(sem), mensual: prom(mes), ultima, iniSem: ini, finSem: fin, total: validas.length };
}

// =====================================================================
//  LOGIN
// =====================================================================
async function buscarUsuario(numero) {
  const snap = await getDoc(doc(db, COL.usuarios, numero));
  if (snap.exists()) return { id: snap.id, ...snap.data() };
  const res = await getDocs(query(collection(db, COL.usuarios), where("numeroEmpleado", "==", numero), limit(1)));
  if (!res.empty) return { id: res.docs[0].id, ...res.docs[0].data() };
  return null;
}

async function entrar(numero) {
  const btn = $("btn-entrar");
  $("login-error").textContent = "";
  btn.disabled = true;
  btn.textContent = "Buscando...";
  try {
    const u = await buscarUsuario(numero);
    if (!u) {
      $("login-error").textContent = "No se encontró ese número de empleado.";
      borrarSesion();
      return;
    }
    usuario = u;
    guardarSesion(numero);
    mostrarDatos();
    configurarPermisos();
    cambiarVista("mi");
    $("pantalla-login").classList.remove("activa");
    $("pantalla-app").classList.add("activa");
    await Promise.all([cargarActividades(), cargarDesempeno()]);
  } catch (err) {
    console.error(err);
    $("login-error").textContent = "Error al conectar con la base de datos. Revisa las reglas de Firestore.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
}

function salir() {
  usuario = null;
  actividades = [];
  evals5S = [];
  cacheUsuarios = null;
  equipo = null;
  borrarSesion();
  cerrarPanel();
  cerrarModal();
  $("input-empleado").value = "";
  $("pantalla-app").classList.remove("activa");
  $("pantalla-login").classList.add("activa");
  $("input-empleado").focus();
}

function configurarPermisos() {
  const rol = rolDe(usuario);
  $("top-rol").textContent = rol === "usuario" ? "" : rol;
  $("top-rol").className = `rol-chip ${rol}`;
  $("tabs").hidden = !esAdmin();
  $("subtab-roles").hidden = !esMaster();
}

function cambiarVista(v) {
  if (v === "admin" && !esAdmin()) v = "mi";
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("activo", t.dataset.vista === v));
  $("vista-mi").classList.toggle("activa", v === "mi");
  $("vista-admin").classList.toggle("activa", v === "admin");
  if (v === "admin") cambiarSub(document.querySelector(".subtab.activo")?.dataset.sub || "equipo");
}

// =====================================================================
//  MI STANDARD WORK
// =====================================================================
function mostrarDatos() {
  const nombre = usuario.nombre || "Sin nombre";
  $("d-nombre").textContent = nombre;
  $("d-numero").textContent = numDe(usuario);
  $("d-area").textContent = usuario.area || "—";
  $("d-rol").textContent = rolDe(usuario);
  $("top-nombre").textContent = nombre;
  $("ip-actuales").textContent = usuario.puntosActuales ?? 0;
  $("ip-acumulados").textContent = usuario.puntosAcumulados ?? 0;

  const partes = nombre.includes(",") ? nombre.split(",").reverse().join(" ") : nombre;
  const iniciales = partes.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  $("avatar").textContent = iniciales || "?";
  mostrarCinturon(usuario.cinturon);
}

function mostrarCinturon(valor) {
  const key = normalizarBelt(valor);
  const idx = BELTS.findIndex((b) => b.key === key);
  const badge = $("belt-badge");
  badge.className = "belt-badge " + (key || "sin");
  badge.textContent = idx >= 0 ? BELTS[idx].nombre : "Sin asignar";
  $("belt-escalera").innerHTML = BELTS.map((b, i) =>
    `<span class="${i <= idx ? "alcanzado" : ""}" style="background:${b.color}" title="${b.nombre}"></span>`
  ).join("");
}

async function cargarDesempeno() {
  const num = numDe(usuario);
  // Evaluaciones 5S
  try {
    const s = await getDocs(query(collection(db, COL.evals), where("numeroEmpleado", "==", num)));
    evals5S = s.docs.map((d) => normalizarEval(d.data()));
  } catch (e) { console.warn(e); evals5S = []; }
  pintar5S();

  // Ideas IP (se prueban varios nombres de campo comunes)
  const vistos = new Set();
  const valores = [num, ...(/^\d+$/.test(num) ? [Number(num)] : [])];
  await Promise.all(["numeroEmpleado", "control", "empleado", "noEmpleado"].flatMap((campo) =>
    valores.map((v) => getDocs(query(collection(db, COL.ideas), where(campo, "==", v)))
      .then((s) => s.forEach((d) => vistos.add(d.id))).catch(() => {}))
  ));
  $("ip-ideas").textContent = vistos.size;
}

function pintar5S() {
  const r = resumen5S(evals5S, new Date());
  const pintar = (id, valor, etiqueta) => {
    $(`${id}-lbl`).textContent = etiqueta;
    $(id).textContent = textoPct(valor);
    const bar = $(`${id}-bar`);
    bar.style.width = `${Math.min(100, valor ?? 0)}%`;
    bar.style.background = colorPct(valor ?? 0);
  };
  pintar("s5-sem", r.semanal, `(${r.iniSem.getDate()} ${MESES_C[r.iniSem.getMonth()]} – ${r.finSem.getDate()} ${MESES_C[r.finSem.getMonth()]})`);
  pintar("s5-mes", r.mensual, `(${MESES[new Date().getMonth()]})`);
  $("s5-ultima").textContent = r.total === 0
    ? "Sin evaluaciones registradas."
    : `Última evaluación: ${formatoFecha(aISO(r.ultima.fecha))} · ${redondear(r.ultima.pct)}%`;
}

// ---------- Actividades ----------
const refActividades = () => collection(db, COL.usuarios, usuario.id, COL.actividades);

async function cargarActividades() {
  try {
    const snap = await getDocs(refActividades());
    actividades = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMi();
  } catch (err) {
    console.error(err);
    toast("No se pudieron cargar las actividades");
  }
}

async function agregarActividad(e) {
  e.preventDefault();
  const titulo = $("a-titulo").value.trim();
  if (!titulo) return;
  const pctTxt = $("a-porcentaje").value.trim();
  const nueva = {
    titulo,
    tipo: $("a-tipo").value,
    fecha: $("a-fecha").value || hoyISO(),
    porcentaje: pctTxt === "" ? null : Math.min(100, Math.max(0, Number(pctTxt))),
    completada: false,
    completadaEn: null,
    numeroEmpleado: numDe(usuario),
    creadoEn: serverTimestamp()
  };
  try {
    const ref = await addDoc(refActividades(), nueva);
    actividades.push({ id: ref.id, ...nueva });
    $("a-titulo").value = "";
    $("a-porcentaje").value = "";
    cerrarPanel();
    renderMi();
    equipo = null;
    toast("Actividad agregada");
  } catch (err) {
    console.error(err);
    toast("Error al guardar la actividad");
  }
}

async function actualizar(id, cambios) {
  const act = actividades.find((a) => a.id === id);
  if (!act) return;
  const previo = { ...act };
  Object.assign(act, cambios);
  renderMi();
  try {
    await updateDoc(doc(db, COL.usuarios, usuario.id, COL.actividades, id), cambios);
    equipo = null;
  } catch (err) {
    console.error(err);
    Object.assign(act, previo);
    renderMi();
    toast("No se pudo actualizar");
  }
}

async function eliminar(id) {
  if (!confirm("¿Eliminar esta actividad?")) return;
  try {
    await deleteDoc(doc(db, COL.usuarios, usuario.id, COL.actividades, id));
    actividades = actividades.filter((a) => a.id !== id);
    renderMi();
    equipo = null;
    toast("Actividad eliminada");
  } catch (err) {
    console.error(err);
    toast("No se pudo eliminar");
  }
}

function abrirPanel() {
  $("panel-nueva").classList.add("abierto");
  $("btn-nueva").textContent = "− Cerrar";
  $("a-fecha").value = estMi.periodo === "todos" ? hoyISO() : aISO(estMi.fecha);
  setTimeout(() => $("a-titulo").focus(), 200);
}
function cerrarPanel() {
  $("panel-nueva").classList.remove("abierto");
  $("btn-nueva").textContent = "+ Nueva actividad";
}

const ordenar = (lista) =>
  [...lista].sort((a, b) => (a.fecha || "").localeCompare(b.fecha || "") || (a.titulo || "").localeCompare(b.titulo || ""));

function renderMi() {
  const r = rangoDe(estMi);
  const lista = ordenar(actividades.filter((a) => enRango(a.fecha, r)));
  const c = cumplimiento(lista);

  $("lista").innerHTML = lista.map((a) => {
    const pctAsignado = typeof a.porcentaje === "number" ? a.porcentaje : "";
    return `
      <li class="item ${a.completada ? "hecha" : ""}" data-id="${a.id}">
        <input type="checkbox" class="chk" ${a.completada ? "checked" : ""} title="Marcar como cumplida">
        <div>
          <div class="titulo">${escapar(a.titulo)}</div>
          <div class="meta"><span class="badge ${escapar(a.tipo)}">${escapar(a.tipo)}</span><span>${formatoFecha(a.fecha)}</span></div>
        </div>
        <label class="peso" title="Porcentaje asignado (vacío = automático)">
          <input type="number" class="pct" min="0" max="100" step="1" value="${pctAsignado}" placeholder="auto">%
        </label>
        <span class="peso-efectivo" title="Peso real en el cálculo">${redondear(c.pesos.get(a.id) ?? 0)}%</span>
        <button class="btn-borrar" title="Eliminar">✕</button>
      </li>`;
  }).join("");
  $("vacio").hidden = lista.length > 0;

  const pct = c.pct ?? 0;
  $("r-total").textContent = c.total;
  $("r-hechas").textContent = c.hechas;
  $("r-pend").textContent = c.total - c.hechas;
  $("r-porcentaje").textContent = `${pct}%`;
  $("r-modo").textContent = c.total ? c.modo : "Sin actividades";
  $("anillo").style.background = `conic-gradient(${colorPct(pct)} ${pct}%, #e5e7eb 0)`;
  $("r-aviso").hidden = !c.aviso;
  $("r-aviso").textContent = c.aviso;
  $("r-tipos").innerHTML = htmlPorTipo(lista);
}

function htmlPorTipo(lista) {
  return [["diaria", "Diarias"], ["semanal", "Semanales"], ["mensual", "Mensuales"]].map(([key, nombre]) => {
    const c = cumplimiento(lista.filter((a) => a.tipo === key));
    const p = c.pct ?? 0;
    return `
      <div class="tipo-fila">
        <div class="linea"><span>${nombre} (${c.hechas}/${c.total})</span><strong>${p}%</strong></div>
        <div class="barra"><div style="width:${p}%;background:${colorPct(p)}"></div></div>
      </div>`;
  }).join("");
}

// =====================================================================
//  ADMINISTRACIÓN
// =====================================================================
function cambiarSub(s) {
  if (s === "roles" && !esMaster()) s = "equipo";
  document.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("activo", b.dataset.sub === s));
  document.querySelectorAll(".sub").forEach((x) => x.classList.toggle("activa", x.id === `sub-${s}`));
  if (s === "equipo") cargarEquipo();
  if (s === "roles") cargarRoles();
  if (s === "cargar") pintarTiposCarga();
}

async function obtenerUsuarios(forzar = false) {
  if (cacheUsuarios && !forzar) return cacheUsuarios;
  const s = await getDocs(collection(db, COL.usuarios));
  cacheUsuarios = s.docs.map((d) => ({ id: d.id, ...d.data() }));
  return cacheUsuarios;
}

// ---------- Desempeño del equipo ----------
async function cargarEquipo(forzar = false) {
  if (equipo && cacheUsuarios && !forzar) { renderEquipo(); return; }
  $("equipo-estado").textContent = "Cargando información del equipo...";
  $("tabla-equipo").querySelector("tbody").innerHTML = "";
  try {
    const [usuarios, actsSnap, evalsSnap] = await Promise.all([
      obtenerUsuarios(forzar),
      getDocs(collectionGroup(db, COL.actividades)),
      getDocs(collection(db, COL.evals)).catch(() => ({ docs: [] }))
    ]);
    const acts = new Map();
    actsSnap.docs.forEach((d) => {
      const uid = d.ref.parent.parent?.id;
      if (!uid) return;
      if (!acts.has(uid)) acts.set(uid, []);
      acts.get(uid).push({ id: d.id, ...d.data() });
    });
    const evals = new Map();
    evalsSnap.docs.forEach((d) => {
      const data = d.data();
      const k = String(data.numeroEmpleado ?? "");
      if (!evals.has(k)) evals.set(k, []);
      evals.get(k).push(normalizarEval(data));
    });
    equipo = { acts, evals };

    // Áreas para el filtro
    const sel = $("adm-area");
    const actual = sel.value;
    const areas = [...new Set(usuarios.map((u) => u.area).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    sel.innerHTML = `<option value="">Todas las áreas</option>` +
      areas.map((a) => `<option value="${escapar(a)}">${escapar(a)}</option>`).join("");
    sel.value = areas.includes(actual) ? actual : "";

    renderEquipo();
  } catch (err) {
    console.error(err);
    $("equipo-estado").textContent = "No se pudo cargar la información. Revisa las reglas de Firestore (lectura de actividades con collectionGroup).";
  }
}

function filasEquipo() {
  const r = rangoDe(estAdm);
  const texto = norm($("adm-buscar").value);
  const area = $("adm-area").value;
  const solo = $("adm-solo").checked;
  const filas = cacheUsuarios.map((u) => {
    const acts = (equipo.acts.get(u.id) || []).filter((a) => enRango(a.fecha, r));
    return { u, acts, c: cumplimiento(acts), s5: resumen5S(equipo.evals.get(numDe(u)) || [], estAdm.fecha) };
  }).filter((f) =>
    (!texto || norm(f.u.nombre).includes(texto) || numDe(f.u).includes(texto)) &&
    (!area || f.u.area === area) &&
    (!solo || f.acts.length > 0)
  );

  const orden = $("adm-orden").value;
  const nombreCmp = (a, b) => String(a.u.nombre || "").localeCompare(String(b.u.nombre || ""));
  const pctVal = (f, vacio) => (f.c.pct === null ? vacio : f.c.pct);
  filas.sort((a, b) => {
    if (orden === "cumpl-desc") return pctVal(b, -1) - pctVal(a, -1) || nombreCmp(a, b);
    if (orden === "cumpl-asc") return pctVal(a, 999) - pctVal(b, 999) || nombreCmp(a, b);
    if (orden === "area") return String(a.u.area || "").localeCompare(String(b.u.area || "")) || nombreCmp(a, b);
    return nombreCmp(a, b);
  });
  return filas;
}

function renderEquipo() {
  if (!equipo || !cacheUsuarios) return;
  const filas = filasEquipo();

  // KPIs
  const conActs = filas.filter((f) => f.c.total > 0);
  const prom = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
  $("k-personas").textContent = filas.length;
  $("k-activos").textContent = conActs.length;
  $("k-cumpl").textContent = textoPct(prom(conActs.map((f) => f.c.pct)));
  $("k-5s").textContent = textoPct(prom(filas.map((f) => f.s5.mensual).filter((x) => x !== null)));

  const LIMITE = 300;
  $("tabla-equipo").querySelector("tbody").innerHTML = filas.slice(0, LIMITE).map((f) => {
    const p = f.c.pct;
    return `
      <tr>
        <td><div class="nom">${escapar(f.u.nombre || "Sin nombre")}</div><div class="num">#${escapar(numDe(f.u))}</div></td>
        <td>${escapar(f.u.area || "—")}</td>
        <td>${beltHTML(f.u.cinturon, true)}</td>
        <td class="c">${f.c.total ? `${f.c.hechas}/${f.c.total}` : "—"}</td>
        <td>
          ${p === null ? `<span class="muted">Sin actividades</span>` : `
          <div class="celda-cumpl">
            <div class="barra"><div style="width:${p}%;background:${colorPct(p)}"></div></div>
            <strong>${p}%</strong>
          </div>`}
        </td>
        <td class="c"><span class="pct-chip" style="color:${f.s5.semanal === null ? "inherit" : colorPct(f.s5.semanal)}">${textoPct(f.s5.semanal)}</span></td>
        <td class="c"><span class="pct-chip" style="color:${f.s5.mensual === null ? "inherit" : colorPct(f.s5.mensual)}">${textoPct(f.s5.mensual)}</span></td>
        <td class="c">${f.u.puntosActuales ?? 0}<span class="muted"> / ${f.u.puntosAcumulados ?? 0}</span></td>
        <td><button class="btn-sec btn-ver" data-id="${escapar(f.u.id)}">Ver</button></td>
      </tr>`;
  }).join("");

  $("equipo-estado").textContent = filas.length === 0
    ? "No hay personas que coincidan con el filtro."
    : filas.length > LIMITE ? `Mostrando ${LIMITE} de ${filas.length}. Usa el buscador o el filtro de área para acotar.` : "";
}

// ---------- Detalle de una persona ----------
function abrirModal(uid) {
  const u = cacheUsuarios.find((x) => x.id === uid);
  if (!u) return;
  const r = rangoDe(estAdm);
  const lista = ordenar((equipo.acts.get(uid) || []).filter((a) => enRango(a.fecha, r)));
  const c = cumplimiento(lista);
  const s5 = resumen5S(equipo.evals.get(numDe(u)) || [], estAdm.fecha);
  const pct = c.pct ?? 0;

  $("m-nombre").textContent = u.nombre || "Sin nombre";
  $("m-sub").textContent = `#${numDe(u)} · ${u.area || "Sin área"} · ${r.etiqueta}`;
  $("m-cuerpo").innerHTML = `
    <div class="m-resumen">
      <div class="anillo peq" style="background:conic-gradient(${colorPct(pct)} ${pct}%, #e5e7eb 0)">
        <div class="anillo-centro"><span>${c.pct === null ? "—" : pct + "%"}</span><small>${c.hechas}/${c.total}</small></div>
      </div>
      <div class="m-datos">
        <div><small>Cinturón</small>${beltHTML(u.cinturon, true)}</div>
        <div><small>5S semanal</small><strong>${textoPct(s5.semanal)}</strong></div>
        <div><small>5S mensual</small><strong>${textoPct(s5.mensual)}</strong></div>
        <div><small>Puntos actuales</small><strong>${u.puntosActuales ?? 0}</strong></div>
        <div><small>Puntos acumulados</small><strong>${u.puntosAcumulados ?? 0}</strong></div>
        <div><small>Rol</small><strong>${rolDe(u)}</strong></div>
      </div>
    </div>
    ${c.aviso ? `<p class="aviso">${escapar(c.aviso)}</p>` : ""}
    <h4>Por tipo</h4>
    ${htmlPorTipo(lista)}
    <h4>Actividades</h4>
    <ul class="lista">
      ${lista.map((a) => `
        <li class="item solo-lectura ${a.completada ? "hecha" : ""}">
          <span class="icono-estado">${a.completada ? "✓" : ""}</span>
          <div>
            <div class="titulo">${escapar(a.titulo)}</div>
            <div class="meta"><span class="badge ${escapar(a.tipo)}">${escapar(a.tipo)}</span><span>${formatoFecha(a.fecha)}</span></div>
          </div>
          <span class="peso-efectivo">${redondear(c.pesos.get(a.id) ?? 0)}%</span>
        </li>`).join("")}
    </ul>
    ${lista.length ? "" : `<p class="muted vacio">Sin actividades en este periodo.</p>`}
  `;
  $("modal").hidden = false;
}
function cerrarModal() { $("modal").hidden = true; }

// ---------- Cargar datos (Excel / CSV) ----------
const ALIAS = {
  numeroEmpleado: ["numeroempleado", "numerodeempleado", "numero", "noempleado", "noemp", "empleado", "control", "nomina", "id"],
  nombre: ["nombre", "nombrecompleto", "empleadonombre"],
  area: ["area", "departamento", "depto"],
  cinturon: ["cinturon", "belt", "cinta", "nivel"],
  fecha: ["fecha", "fechaevaluacion", "fechadeevaluacion"],
  tipo: ["tipo", "periodo", "frecuencia"],
  porcentaje: ["porcentaje", "calificacion", "resultado", "puntaje", "%", "porcentaje%"],
  puntosActuales: ["puntosactuales", "puntos", "puntosip"],
  puntosAcumulados: ["puntosacumulados", "acumulados"]
};

const CARGAS = {
  usuarios: {
    titulo: "Usuarios",
    sub: "Alta o actualización de personas",
    columnas: ["numeroEmpleado", "nombre", "area"],
    ejemplo: [["10020", "JARAMILLO GARCIA, MARIA DEL CARMEN", "A220 Monumentos Lavs Dual"]],
    desc: "Crea o actualiza personas en <code>usuarios</code>. Columnas: <code>numeroEmpleado</code>, <code>nombre</code>, <code>area</code>. No cambia el rol ni los puntos de quien ya existe."
  },
  cinturones: {
    titulo: "Cinturones",
    sub: "White, Yellow, Green, Blue, Black",
    columnas: ["numeroEmpleado", "cinturon"],
    ejemplo: [["10020", "Green Belt"], ["10040", "Yellow Belt"]],
    desc: "Asigna el cinturón. Columnas: <code>numeroEmpleado</code>, <code>cinturon</code>. Acepta: White, Yellow, Green, Blue o Black Belt (también en español: blanco, amarillo, verde, azul, negro)."
  },
  evaluaciones5s: {
    titulo: "Evaluaciones 5S",
    sub: "Semanales y mensuales",
    columnas: ["numeroEmpleado", "fecha", "tipo", "porcentaje"],
    ejemplo: [["10020", "2026-11-16", "semanal", 85], ["10020", "2026-11-01", "mensual", 90]],
    desc: "Registra evaluaciones 5S. Columnas: <code>numeroEmpleado</code>, <code>fecha</code> (AAAA-MM-DD o DD/MM/AAAA), <code>tipo</code> (semanal o mensual), <code>porcentaje</code> (0–100). Si subes la misma persona, fecha y tipo otra vez, se reemplaza."
  },
  puntos: {
    titulo: "Puntos IP",
    sub: "Actuales y acumulados",
    columnas: ["numeroEmpleado", "puntosActuales", "puntosAcumulados"],
    ejemplo: [["10020", 120, 450]],
    desc: "Actualiza puntos IP. Columnas: <code>numeroEmpleado</code>, <code>puntosActuales</code>, <code>puntosAcumulados</code>. Puedes dejar vacía una de las dos para no cambiarla."
  }
};

function pintarTiposCarga() {
  $("carga-tipos").innerHTML = Object.entries(CARGAS).map(([k, c]) =>
    `<button class="carga-tipo ${k === tipoCarga ? "activo" : ""}" data-tipo="${k}">${c.titulo}<small>${c.sub}</small></button>`
  ).join("");
  $("carga-desc").innerHTML = CARGAS[tipoCarga].desc;
}

function limpiarCarga() {
  cargaFilas = [];
  $("carga-preview").innerHTML = "";
  $("carga-resumen").textContent = "";
  $("carga-nombre").textContent = "";
  $("btn-subir").disabled = true;
  $("carga-archivo").value = "";
}

function hayXLSX() {
  if (typeof XLSX === "undefined") { toast("No se cargó la librería de Excel. Revisa tu conexión."); return false; }
  return true;
}

function descargarPlantilla() {
  if (!hayXLSX()) return;
  const c = CARGAS[tipoCarga];
  const ws = XLSX.utils.aoa_to_sheet([c.columnas, ...c.ejemplo]);
  ws["!cols"] = c.columnas.map((col) => ({ wch: Math.max(16, col.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, c.titulo.slice(0, 30));
  XLSX.writeFile(wb, `plantilla_${tipoCarga}.xlsx`);
}

const normHeader = (h) => norm(h).replace(/[^a-z0-9%]/g, "");

function mapearFila(raw) {
  const porHeader = {};
  Object.keys(raw).forEach((k) => { porHeader[normHeader(k)] = raw[k]; });
  const out = {};
  for (const [campo, alias] of Object.entries(ALIAS)) {
    for (const a of [normHeader(campo), ...alias]) {
      if (porHeader[a] !== undefined && porHeader[a] !== "") { out[campo] = porHeader[a]; break; }
    }
  }
  return out;
}

function limpiarNumEmpleado(v) {
  if (v === undefined || v === null) return "";
  let s = String(v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.split(".")[0];
  return s;
}

function aNumero(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace("%", "").replace(",", ".").trim());
  return isNaN(n) ? NaN : n;
}

function parseFechaCelda(v) {
  if (v === undefined || v === null || v === "") return null;
  const fmt = (y, m, d) => {
    y = Number(y); m = Number(m); d = Number(d);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  if (v instanceof Date && !isNaN(v)) {
    const d = new Date(v.getTime() + 12 * 3600 * 1000); // evita desfases por zona horaria
    return aISO(d);
  }
  if (typeof v === "number") {
    if (v > 20000 && v < 80000) { // número de serie de Excel
      const d = new Date(Math.round((v - 25569) * 86400000));
      return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return fmt(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) return fmt(m[3].length === 2 ? "20" + m[3] : m[3], m[2], m[1]); // DD/MM/AAAA
  return null;
}

function procesarFila(tipo, f, idsExistentes) {
  const num = limpiarNumEmpleado(f.numeroEmpleado);
  if (!num) return { error: "Falta numeroEmpleado" };
  if (num.includes("/")) return { error: "numeroEmpleado no válido" };
  const existe = idsExistentes.has(num);

  if (tipo === "usuarios") {
    const nombre = String(f.nombre ?? "").trim();
    if (!nombre) return { error: "Falta nombre" };
    const datos = { numeroEmpleado: num, control: num, nombre, actualizadoEn: serverTimestamp() };
    if (f.area !== undefined) datos.area = String(f.area).trim();
    if (!existe) { datos.rol = "usuario"; datos.puntosActuales = 0; datos.puntosAcumulados = 0; }
    return { ruta: [COL.usuarios, num], datos, vista: [num, nombre, datos.area ?? ""], nota: existe ? "Actualiza" : "Nuevo" };
  }

  if (!existe) return { error: "Empleado no registrado (súbelo primero en Usuarios)" };

  if (tipo === "cinturones") {
    const key = normalizarBelt(f.cinturon);
    if (!key) return { error: `Cinturón no reconocido: "${f.cinturon ?? ""}"` };
    const nombre = BELTS.find((b) => b.key === key).nombre;
    return { ruta: [COL.usuarios, num], datos: { cinturon: nombre, actualizadoEn: serverTimestamp() }, vista: [num, nombre] };
  }

  if (tipo === "evaluaciones5s") {
    const fecha = parseFechaCelda(f.fecha);
    if (!fecha) return { error: "Fecha no válida" };
    const t = norm(f.tipo);
    const tipoEval = t.startsWith("sem") ? "semanal" : t.startsWith("men") ? "mensual" : null;
    if (!tipoEval) return { error: "Tipo debe ser semanal o mensual" };
    let p = aNumero(f.porcentaje);
    if (p === null || isNaN(p)) return { error: "Porcentaje no válido" };
    if (p > 0 && p <= 1 && String(f.porcentaje).indexOf("%") === -1) p *= 100;
    if (p < 0 || p > 100) return { error: "Porcentaje fuera de 0–100" };
    p = redondear(p);
    return {
      ruta: [COL.evals, `${num}_${tipoEval}_${fecha}`],
      datos: { numeroEmpleado: num, fecha, tipo: tipoEval, porcentaje: p, cargadoEn: serverTimestamp(), cargadoPor: numDe(usuario) },
      vista: [num, formatoFecha(fecha), tipoEval, `${p}%`]
    };
  }

  if (tipo === "puntos") {
    const act = aNumero(f.puntosActuales);
    const acu = aNumero(f.puntosAcumulados);
    if ((act !== null && isNaN(act)) || (acu !== null && isNaN(acu))) return { error: "Puntos no válidos" };
    if (act === null && acu === null) return { error: "Sin puntos" };
    const datos = { actualizadoEn: serverTimestamp() };
    if (act !== null) datos.puntosActuales = act;
    if (acu !== null) datos.puntosAcumulados = acu;
    return { ruta: [COL.usuarios, num], datos, vista: [num, act ?? "(sin cambio)", acu ?? "(sin cambio)"] };
  }
  return { error: "Tipo de carga desconocido" };
}

async function leerArchivo(file) {
  if (!hayXLSX()) return;
  $("carga-nombre").textContent = `${file.name} · leyendo...`;
  try {
    const esCSV = /\.csv$/i.test(file.name);
    const wb = esCSV
      ? XLSX.read(await file.text(), { type: "string", raw: true })
      : XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
    if (!filas.length) { toast("El archivo no tiene filas"); $("carga-nombre").textContent = file.name; return; }

    const usuarios = await obtenerUsuarios(true);
    const ids = new Set(usuarios.map((u) => u.id));
    cargaFilas = filas.map((raw, i) => ({ fila: i + 2, ...procesarFila(tipoCarga, mapearFila(raw), ids) }));
    $("carga-nombre").textContent = file.name;
    pintarPreview();
  } catch (err) {
    console.error(err);
    toast("No se pudo leer el archivo");
    $("carga-nombre").textContent = file.name;
  }
}

function pintarPreview() {
  const c = CARGAS[tipoCarga];
  const ok = cargaFilas.filter((f) => !f.error).length;
  const err = cargaFilas.length - ok;
  const MAX = 200;
  $("carga-preview").innerHTML = `
    <table class="tabla">
      <thead><tr><th>Fila</th>${c.columnas.map((x) => `<th>${x}</th>`).join("")}<th>Estado</th></tr></thead>
      <tbody>
        ${cargaFilas.slice(0, MAX).map((f) => `
          <tr class="${f.error ? "fila-error" : ""}">
            <td class="num">${f.fila}</td>
            ${f.error
              ? `<td colspan="${c.columnas.length}" class="muted">—</td>`
              : f.vista.map((v) => `<td>${escapar(v)}</td>`).join("")}
            <td>${f.error ? `<span class="estado-err">${escapar(f.error)}</span>` : `<span class="estado-ok">✓ ${f.nota || "Listo"}</span>`}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
  $("carga-resumen").textContent =
    `${ok} fila(s) válidas · ${err} con error` + (cargaFilas.length > MAX ? ` · vista previa de ${MAX} de ${cargaFilas.length}` : "");
  $("btn-subir").disabled = ok === 0;
  $("btn-subir").textContent = ok ? `Subir ${ok} registro(s)` : "Subir datos";
}

async function subirCarga() {
  const validas = cargaFilas.filter((f) => !f.error);
  if (!validas.length) return;
  if (!confirm(`Se guardarán ${validas.length} registro(s) de "${CARGAS[tipoCarga].titulo}". ¿Continuar?`)) return;
  const btn = $("btn-subir");
  btn.disabled = true;
  try {
    const LOTE = 400;
    for (let i = 0; i < validas.length; i += LOTE) {
      const batch = writeBatch(db);
      validas.slice(i, i + LOTE).forEach((f) => batch.set(doc(db, ...f.ruta), f.datos, { merge: true }));
      await batch.commit();
      btn.textContent = `Subiendo... ${Math.min(i + LOTE, validas.length)}/${validas.length}`;
    }
    toast(`✓ ${validas.length} registro(s) guardados`);
    cacheUsuarios = null;
    equipo = null;
    limpiarCarga();
    // Si se actualizó al usuario actual, refrescar sus datos
    const yo = await buscarUsuario(usuario.id);
    if (yo) { usuario = yo; mostrarDatos(); configurarPermisos(); }
    cargarDesempeno();
  } catch (err) {
    console.error(err);
    toast("Error al subir. Revisa las reglas de Firestore.");
    btn.disabled = false;
    btn.textContent = "Reintentar";
  }
}

// ---------- Roles (solo master) ----------
async function cargarRoles() {
  if (!esMaster()) return;
  $("roles-estado").textContent = "Cargando...";
  try {
    await obtenerUsuarios();
    renderRoles();
  } catch (err) {
    console.error(err);
    $("roles-estado").textContent = "No se pudieron cargar los usuarios.";
  }
}

function renderRoles() {
  if (!cacheUsuarios) return;
  const texto = norm($("rol-buscar").value);
  const pesoRol = { master: 0, admin: 1, usuario: 2 };
  const filas = cacheUsuarios
    .filter((u) => !texto || norm(u.nombre).includes(texto) || numDe(u).includes(texto))
    .sort((a, b) => pesoRol[rolDe(a)] - pesoRol[rolDe(b)] || String(a.nombre || "").localeCompare(String(b.nombre || "")));
  const MAX = 200;
  $("tabla-roles").querySelector("tbody").innerHTML = filas.slice(0, MAX).map((u) => {
    const rol = rolDe(u);
    const yo = u.id === usuario.id;
    return `
      <tr>
        <td><div class="nom">${escapar(u.nombre || "Sin nombre")}${yo ? ' <span class="muted">(tú)</span>' : ""}</div><div class="num">#${escapar(numDe(u))}</div></td>
        <td>${escapar(u.area || "—")}</td>
        <td>
          <select class="sel-rol" data-id="${escapar(u.id)}" ${yo ? "disabled title='No puedes cambiar tu propio rol'" : ""}>
            <option value="usuario" ${rol === "usuario" ? "selected" : ""}>Usuario</option>
            <option value="admin" ${rol === "admin" ? "selected" : ""}>Admin</option>
            <option value="master" ${rol === "master" ? "selected" : ""}>Master</option>
          </select>
        </td>
      </tr>`;
  }).join("");
  $("roles-estado").textContent = filas.length === 0 ? "Sin resultados."
    : filas.length > MAX ? `Mostrando ${MAX} de ${filas.length}. Usa el buscador.` : "";
}

async function cambiarRol(sel) {
  const u = cacheUsuarios.find((x) => x.id === sel.dataset.id);
  if (!u) return;
  const nuevo = sel.value;
  const anterior = rolDe(u);
  if (!confirm(`¿Cambiar el rol de ${u.nombre || u.id} de "${anterior}" a "${nuevo}"?`)) { sel.value = anterior; return; }
  sel.disabled = true;
  try {
    await updateDoc(doc(db, COL.usuarios, u.id), { rol: nuevo, actualizadoEn: serverTimestamp() });
    u.rol = nuevo;
    toast("Rol actualizado");
    renderRoles();
  } catch (err) {
    console.error(err);
    sel.value = anterior;
    toast("No se pudo cambiar el rol");
  } finally {
    sel.disabled = false;
  }
}

// =====================================================================
//  EVENTOS
// =====================================================================
$("form-login").addEventListener("submit", (e) => {
  e.preventDefault();
  const num = $("input-empleado").value.trim();
  if (num) entrar(num);
});
$("btn-salir").addEventListener("click", salir);
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => cambiarVista(t.dataset.vista)));

// Mi Standard Work
enlazarPeriodo($("ctrl-mi"), estMi, renderMi);
$("btn-nueva").addEventListener("click", () => ($("panel-nueva").classList.contains("abierto") ? cerrarPanel() : abrirPanel()));
$("btn-cancelar").addEventListener("click", cerrarPanel);
$("form-actividad").addEventListener("submit", agregarActividad);
$("lista").addEventListener("change", (e) => {
  const li = e.target.closest(".item");
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.classList.contains("chk")) {
    actualizar(id, { completada: e.target.checked, completadaEn: e.target.checked ? new Date().toISOString() : null });
  } else if (e.target.classList.contains("pct")) {
    const v = e.target.value.trim();
    actualizar(id, { porcentaje: v === "" ? null : Math.min(100, Math.max(0, Number(v))) });
  }
});
$("lista").addEventListener("click", (e) => {
  if (e.target.classList.contains("btn-borrar")) eliminar(e.target.closest(".item").dataset.id);
});

// Admin: navegación
document.querySelectorAll(".subtab").forEach((b) => b.addEventListener("click", () => cambiarSub(b.dataset.sub)));

// Admin: equipo
enlazarPeriodo($("ctrl-adm"), estAdm, renderEquipo);
["adm-buscar"].forEach((id) => $(id).addEventListener("input", renderEquipo));
["adm-area", "adm-orden", "adm-solo"].forEach((id) => $(id).addEventListener("change", renderEquipo));
$("adm-recargar").addEventListener("click", () => cargarEquipo(true));
$("tabla-equipo").addEventListener("click", (e) => {
  const b = e.target.closest(".btn-ver");
  if (b) abrirModal(b.dataset.id);
});
$("m-cerrar").addEventListener("click", cerrarModal);
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") cerrarModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarModal(); });

// Admin: carga
$("carga-tipos").addEventListener("click", (e) => {
  const b = e.target.closest(".carga-tipo");
  if (!b) return;
  tipoCarga = b.dataset.tipo;
  limpiarCarga();
  pintarTiposCarga();
});
$("btn-plantilla").addEventListener("click", descargarPlantilla);
$("carga-archivo").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) leerArchivo(f); });
$("btn-subir").addEventListener("click", subirCarga);

// Admin: roles
$("rol-buscar").addEventListener("input", renderRoles);
$("tabla-roles").addEventListener("change", (e) => { if (e.target.classList.contains("sel-rol")) cambiarRol(e.target); });

// =====================================================================
//  INICIO
// =====================================================================
(function init() {
  mostrarCinturon(null);
  const guardado = leerSesion();
  if (guardado) {
    $("input-empleado").value = guardado;
    entrar(guardado);
  }
})();
