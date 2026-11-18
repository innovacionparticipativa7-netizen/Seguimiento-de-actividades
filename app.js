// ================== FIREBASE ==================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, collection, query, where, limit,
  getDocs, addDoc, updateDoc, deleteDoc, serverTimestamp
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

// Las actividades se guardan en: usuarios/{numeroEmpleado}/actividades/{id}

// ================== ESTADO ==================
let usuario = null;        // { id, ...datos }
let actividades = [];      // todas las actividades del usuario

const $ = (id) => document.getElementById(id);

// ================== UTILIDADES ==================
const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const escapar = (txt) =>
  String(txt ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const formatoFecha = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

const redondear = (n) => Math.round(n * 10) / 10;

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("visible"), 2200);
}

function guardarSesion(num) { try { localStorage.setItem("empleado", num); } catch {} }
function leerSesion() { try { return localStorage.getItem("empleado"); } catch { return null; } }
function borrarSesion() { try { localStorage.removeItem("empleado"); } catch {} }

// ================== LOGIN ==================
async function buscarUsuario(numero) {
  // 1) El ID del documento es el número de empleado
  const snap = await getDoc(doc(db, "usuarios", numero));
  if (snap.exists()) return { id: snap.id, ...snap.data() };

  // 2) Respaldo: buscar por el campo numeroEmpleado
  const q = query(collection(db, "usuarios"), where("numeroEmpleado", "==", numero), limit(1));
  const res = await getDocs(q);
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
    $("pantalla-login").classList.remove("activa");
    $("pantalla-app").classList.add("activa");
    await cargarActividades();
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
  borrarSesion();
  $("input-empleado").value = "";
  $("pantalla-app").classList.remove("activa");
  $("pantalla-login").classList.add("activa");
  $("input-empleado").focus();
}

function mostrarDatos() {
  const nombre = usuario.nombre || "Sin nombre";
  $("d-nombre").textContent = nombre;
  $("d-numero").textContent = usuario.numeroEmpleado || usuario.control || usuario.id;
  $("d-area").textContent = usuario.area || "—";
  $("d-rol").textContent = usuario.rol || "—";
  $("d-puntos").textContent = usuario.puntosActuales ?? 0;
  $("d-acumulados").textContent = usuario.puntosAcumulados ?? 0;
  $("top-nombre").textContent = nombre;

  // Iniciales para el avatar (formato "APELLIDOS, NOMBRES")
  const partes = nombre.includes(",") ? nombre.split(",").reverse().join(" ") : nombre;
  const iniciales = partes.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  $("avatar").textContent = iniciales || "?";
}

// ================== ACTIVIDADES (CRUD) ==================
const refActividades = () => collection(db, "usuarios", usuario.id, "actividades");

async function cargarActividades() {
  try {
    const snap = await getDocs(refActividades());
    actividades = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
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
    creadoEn: serverTimestamp()
  };
  try {
    const ref = await addDoc(refActividades(), nueva);
    actividades.push({ id: ref.id, ...nueva });
    $("a-titulo").value = "";
    $("a-porcentaje").value = "";
    $("a-titulo").focus();
    render();
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
  render();
  try {
    await updateDoc(doc(db, "usuarios", usuario.id, "actividades", id), cambios);
  } catch (err) {
    console.error(err);
    Object.assign(act, previo);
    render();
    toast("No se pudo actualizar");
  }
}

async function eliminar(id) {
  if (!confirm("¿Eliminar esta actividad?")) return;
  try {
    await deleteDoc(doc(db, "usuarios", usuario.id, "actividades", id));
    actividades = actividades.filter((a) => a.id !== id);
    render();
    toast("Actividad eliminada");
  } catch (err) {
    console.error(err);
    toast("No se pudo eliminar");
  }
}

// ================== FILTRO ==================
function filtroActual() {
  const periodo = $("f-periodo").value;
  const tipo = $("f-tipo").value;
  let valor, etiqueta;
  if (periodo === "dia") {
    valor = $("f-dia").value || hoyISO();
    etiqueta = `· ${formatoFecha(valor)}`;
  } else if (periodo === "mes") {
    valor = $("f-mes").value || hoyISO().slice(0, 7);
    const [y, m] = valor.split("-");
    etiqueta = `· ${MESES[Number(m) - 1]} ${y}`;
  } else {
    valor = String($("f-anio").value || new Date().getFullYear());
    etiqueta = `· ${valor}`;
  }
  return { periodo, tipo, valor, etiqueta };
}

function filtrar() {
  const { periodo, tipo, valor } = filtroActual();
  return actividades
    .filter((a) => {
      if (tipo !== "todas" && a.tipo !== tipo) return false;
      const f = a.fecha || "";
      if (periodo === "dia") return f === valor;
      if (periodo === "mes") return f.slice(0, 7) === valor;
      return f.slice(0, 4) === valor;
    })
    .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || "") || (a.titulo || "").localeCompare(b.titulo || ""));
}

function cambiarPeriodo() {
  const p = $("f-periodo").value;
  $("f-dia").hidden = p !== "dia";
  $("f-mes").hidden = p !== "mes";
  $("f-anio").hidden = p !== "anio";
  render();
}

// ================== CÁLCULO DE CUMPLIMIENTO ==================
/*
  Reglas:
  - Si ninguna actividad tiene % asignado → todas valen lo mismo (100 / n).
  - Si algunas tienen % → esas valen su %, y lo que falte para 100 se reparte
    por igual entre las que no tienen %.
  - Si los % asignados suman 100 o más → se normalizan para que sumen 100
    (las que no tienen % valen 0 y se muestra un aviso).
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

// ================== RENDER ==================
function render() {
  const lista = filtrar();
  const { etiqueta } = filtroActual();
  const { pesos, modo, aviso } = calcularPesos(lista);
  $("lbl-periodo").textContent = etiqueta;

  // Lista
  const ul = $("lista");
  ul.innerHTML = lista.map((a) => {
    const peso = pesos.get(a.id) ?? 0;
    const pctAsignado = typeof a.porcentaje === "number" ? a.porcentaje : "";
    return `
      <li class="item ${a.completada ? "hecha" : ""}" data-id="${a.id}">
        <input type="checkbox" class="chk" ${a.completada ? "checked" : ""} title="Marcar como cumplida">
        <div>
          <div class="titulo">${escapar(a.titulo)}</div>
          <div class="meta">
            <span class="badge ${a.tipo}">${a.tipo}</span>
            <span>${formatoFecha(a.fecha)}</span>
          </div>
        </div>
        <label class="peso" title="Porcentaje asignado (vacío = automático)">
          <input type="number" class="pct" min="0" max="100" step="1" value="${pctAsignado}" placeholder="auto">%
        </label>
        <span class="peso-efectivo" title="Peso real en el cálculo">${redondear(peso)}%</span>
        <button class="btn-borrar" title="Eliminar">✕</button>
      </li>`;
  }).join("");
  $("vacio").hidden = lista.length > 0;

  // Resumen
  const total = lista.length;
  const hechas = lista.filter((a) => a.completada).length;
  const cumplimiento = lista.reduce((s, a) => s + (a.completada ? (pesos.get(a.id) ?? 0) : 0), 0);
  const pct = total ? redondear(cumplimiento) : 0;

  $("r-total").textContent = total;
  $("r-hechas").textContent = hechas;
  $("r-pend").textContent = total - hechas;
  $("r-porcentaje").textContent = `${pct}%`;
  $("r-modo").textContent = total ? modo : "Sin actividades";
  $("anillo").style.setProperty("--p", pct);
  $("anillo").style.background =
    `conic-gradient(${pct >= 80 ? "var(--ok)" : pct >= 50 ? "#eab308" : "var(--pend)"} ${pct}%, #e5e7eb 0)`;
  $("r-aviso").hidden = !aviso;
  $("r-aviso").textContent = aviso;

  // Por tipo (cumplimiento simple dentro de cada tipo)
  const tipos = [["diaria", "Diarias"], ["semanal", "Semanales"], ["mensual", "Mensuales"]];
  $("r-tipos").innerHTML = tipos.map(([key, nombre]) => {
    const grupo = lista.filter((a) => a.tipo === key);
    const { pesos: pg } = calcularPesos(grupo);
    const p = grupo.length ? redondear(grupo.reduce((s, a) => s + (a.completada ? pg.get(a.id) : 0), 0)) : 0;
    const h = grupo.filter((a) => a.completada).length;
    return `
      <div class="tipo-fila">
        <div class="linea"><span>${nombre} (${h}/${grupo.length})</span><strong>${p}%</strong></div>
        <div class="barra"><div style="width:${p}%"></div></div>
      </div>`;
  }).join("");
}

// ================== EVENTOS ==================
$("form-login").addEventListener("submit", (e) => {
  e.preventDefault();
  const num = $("input-empleado").value.trim();
  if (num) entrar(num);
});
$("btn-salir").addEventListener("click", salir);
$("form-actividad").addEventListener("submit", agregarActividad);

$("f-periodo").addEventListener("change", cambiarPeriodo);
["f-dia", "f-mes", "f-anio", "f-tipo"].forEach((id) => $(id).addEventListener("change", render));

// Delegación de eventos en la lista
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

// ================== INICIO ==================
(function init() {
  const hoy = hoyISO();
  $("f-dia").value = hoy;
  $("f-mes").value = hoy.slice(0, 7);
  $("f-anio").value = new Date().getFullYear();
  $("a-fecha").value = hoy;

  const guardado = leerSesion();
  if (guardado) {
    $("input-empleado").value = guardado;
    entrar(guardado);
  }
})();
