// main.js
// Logica de la pantalla principal. Cambio grande de enfoque (18-ago-2026):
// antes esto era una tabla plana con 13 columnas y filtros sueltos. Ahora es
// un flujo guiado (Vehiculo -> Tipo de pieza -> Producto homologo, en la
// sidebar) que agrupa el resultado por Cliente, y dentro de cada cliente
// junta los ZFER repetidos en 1 sola tarjeta (con el contador de veces que
// se repite). El plano se ve como miniatura y se puede click para agrandar.
//
// Los filtros de vehiculo/parte/producto/geometria/zfer se aplican en el
// navegador sobre lo que ya trajimos (no pegamos otra vez a las BDs por cada
// filtro), las fechas si disparan un fetch nuevo al backend.

let datosCrudos = []; // lo que llego del server para el rango de fechas actual
let _consultaEnCurso = false; // guard: sin esto, doble-click o F5 con la anterior
                               // todavia en vuelo dejaba el loading pegado (2 fetch
                               // pisandose el toggle del mismo overlay sin sincronizar)
let _clientesAbiertos = new Set(); // que tarjetas de cliente estan expandidas

const $ = (sel) => document.querySelector(sel);

async function consultarHistorico() {
    if (_consultaEnCurso) return; // ya hay una pidiendo datos, no dispares otra encima
    _consultaEnCurso = true;

    const fechaInicio = $("#f-fecha-inicio").value;
    const fechaFin = $("#f-fecha-fin").value;

    mostrarLoading(true);
    $("#btn-consultar").disabled = true;
    setEstado("consultando...", false);

    try {
        const resp = await fetch(`/api/historico?fecha_inicio=${fechaInicio}&fecha_fin=${fechaFin}`);
        if (!resp.ok) throw new Error(`server respondio ${resp.status}`);
        const data = await resp.json();

        datosCrudos = data.filas || [];
        _clientesAbiertos.clear();
        actualizarOpcionesFiltros();
        aplicarFiltrosYRenderizar();
        setEstado(`listo · ${data.total} registros`, true);
    } catch (err) {
        console.error("fallo la consulta:", err);
        setEstado("error trayendo datos, revisa la consola", false);
    } finally {
        mostrarLoading(false);
        $("#btn-consultar").disabled = false;
        _consultaEnCurso = false;
    }
}

// ---------- filtros en cascada (faceted search) ----------
// cada dropdown solo muestra las opciones que EXISTEN dentro del subconjunto
// que ya dejan pasar los demas filtros activos - elegir un Vehiculo recorta
// las opciones de Parte y Producto, elegir una Parte recorta Producto, etc.

function leerFiltrosActivos() {
    return {
        vehiculo: $("#f-vehiculo").value,
        parte: $("#f-parte").value,
        producto: $("#f-producto").value,
        geometria: $("#f-geometria").value,
        zferBuscado: $("#f-zfer").value.trim().toLowerCase(),
    };
}

function filtrarDatos(filas, filtros, ignorar) {
    return filas.filter((f) => {
        if (filtros.vehiculo && ignorar !== "vehiculo" && f.Vehiculo !== filtros.vehiculo) return false;
        if (filtros.parte && ignorar !== "parte" && f.Parte !== filtros.parte) return false;
        if (filtros.producto && ignorar !== "producto" && f.ProductoHomologo !== filtros.producto) return false;
        if (filtros.geometria && ignorar !== "geometria" && f.Geometria !== filtros.geometria) return false;
        if (filtros.zferBuscado && ignorar !== "zfer" && !String(f.ZFER || "").toLowerCase().includes(filtros.zferBuscado)) return false;
        return true;
    });
}

function actualizarOpcionesFiltros() {
    const filtros = leerFiltrosActivos();
    const opcionesDe = (campo, ignorar) =>
        [...new Set(filtrarDatos(datosCrudos, filtros, ignorar).map((f) => f[campo]).filter(Boolean))].sort();

    llenarSelect("#f-vehiculo", opcionesDe("Vehiculo", "vehiculo"));
    llenarSelect("#f-parte", opcionesDe("Parte", "parte"));
    llenarSelect("#f-producto", opcionesDe("ProductoHomologo", "producto"));
    llenarSelect("#f-geometria", opcionesDe("Geometria", "geometria"));
}

function llenarSelect(selector, opciones) {
    const select = $(selector);
    const valorActual = select.value;
    select.innerHTML = '<option value="">Todos</option>';
    for (const op of opciones) {
        const opt = document.createElement("option");
        opt.value = op;
        opt.textContent = op;
        select.appendChild(opt);
    }
    if (opciones.includes(valorActual)) select.value = valorActual;
}

function onCambioFiltro() {
    actualizarOpcionesFiltros();
    aplicarFiltrosYRenderizar();
}

function aplicarFiltrosYRenderizar() {
    const filtradas = filtrarDatos(datosCrudos, leerFiltrosActivos(), null);
    renderizarKpis(filtradas);
    renderizarClientes(filtradas);
}

// ---------- KPIs ----------

function renderizarKpis(filas) {
    const zfersUnicos = new Set(filas.map((f) => f.ZFER));
    const conStock = new Set(filas.filter((f) => f.EsStock === "Si").map((f) => f.ZFER)).size;
    const sinStock = zfersUnicos.size - conStock;
    // piezas fabricadas = suma de Cantidad de TODAS las lineas filtradas (no
    // deduplicado por ZFER como en las tarjetas - cada linea es una pieza real
    // que se fabrico en esa fecha, sumarlas todas da el total del periodo)
    const piezasFabricadas = filas.reduce((acc, f) => acc + (Number(f.Cantidad) || 0), 0);

    animarNumero("#kpi-total", filas.length);
    animarNumero("#kpi-zfers", zfersUnicos.size);
    animarNumero("#kpi-con-stock", conStock);
    animarNumero("#kpi-sin-stock", sinStock);
    animarNumero("#kpi-piezas", piezasFabricadas);
}

function animarNumero(selector, valorFinal) {
    const el = $(selector);
    const valorInicial = parseInt(el.textContent, 10) || 0;
    const pasos = 16;
    let paso = 0;
    clearInterval(el._timer);
    el._timer = setInterval(() => {
        paso++;
        const progreso = valorInicial + ((valorFinal - valorInicial) * paso) / pasos;
        el.textContent = Math.round(progreso).toLocaleString("es-CO");
        if (paso >= pasos) clearInterval(el._timer);
    }, 18);
}

// ---------- agrupado por cliente + dedupe de ZFER ----------
// Primero agrupamos por Cliente. Dentro de cada cliente, juntamos las filas
// que sean el MISMO ZFER en 1 sola tarjeta (esas son las "repetidas" que
// pedian juntar) - el contador de repeticion es cuantas lineas de pedido de
// ESE cliente tuvieron ese ZFER, y la cantidad se suma entre todas.

function agruparPorClienteYZfer(filas) {
    const porCliente = new Map();

    for (const f of filas) {
        const cliente = f.Cliente || "(sin cliente)";
        if (!porCliente.has(cliente)) porCliente.set(cliente, new Map());
        const porZfer = porCliente.get(cliente);

        const zfer = f.ZFER || "(sin zfer)";
        if (!porZfer.has(zfer)) {
            porZfer.set(zfer, { ...f, _repeticiones: 0, _cantidadTotal: 0 });
        }
        const acumulado = porZfer.get(zfer);
        acumulado._repeticiones += 1;
        acumulado._cantidadTotal += Number(f.Cantidad) || 0;
    }

    // convertimos a array ordenado: clientes con mas ZFER unicos primero
    return [...porCliente.entries()]
        .map(([cliente, mapaZfer]) => ({
            cliente,
            zfers: [...mapaZfer.values()].sort((a, b) => b._repeticiones - a._repeticiones),
        }))
        .sort((a, b) => b.zfers.length - a.zfers.length);
}

function renderizarClientes(filas) {
    const cont = $("#clientes-lista");
    cont.innerHTML = "";

    const grupos = agruparPorClienteYZfer(filas);

    if (grupos.length === 0) {
        cont.innerHTML = `<div class="sin-resultados">no hay resultados con estos filtros</div>`;
        return;
    }

    const LIMITE_CLIENTES = 200; // igual que antes, un tope razonable para no ahogar el DOM
    const frag = document.createDocumentFragment();

    grupos.slice(0, LIMITE_CLIENTES).forEach((grupo, i) => {
        frag.appendChild(crearTarjetaCliente(grupo, i));
    });
    cont.appendChild(frag);

    if (grupos.length > LIMITE_CLIENTES) {
        const aviso = document.createElement("div");
        aviso.className = "sin-resultados";
        aviso.textContent = `mostrando ${LIMITE_CLIENTES} de ${grupos.length} clientes · afina los filtros para ver mas puntual`;
        cont.appendChild(aviso);
    }
}

function crearTarjetaCliente(grupo, indice) {
    const conStock = grupo.zfers.filter((z) => z.EsStock === "Si").length;
    const abierto = _clientesAbiertos.has(grupo.cliente);

    const card = document.createElement("div");
    card.className = "cliente-card glass";
    card.style.animationDelay = `${Math.min(indice, 30) * 0.02}s`;

    const header = document.createElement("button");
    header.className = "cliente-header";
    header.type = "button";
    header.innerHTML = `
        <span class="cliente-flecha ${abierto ? "abierta" : ""}">▸</span>
        <span class="cliente-nombre">${grupo.cliente}</span>
        <span class="cliente-resumen">
            <span class="badge badge-rep">${grupo.zfers.length} ZFER</span>
            <span class="badge badge-stock-si">${conStock} con stock</span>
        </span>
    `;

    const cuerpo = document.createElement("div");
    cuerpo.className = "cliente-cuerpo";
    cuerpo.hidden = !abierto;

    header.addEventListener("click", () => {
        const abrir = cuerpo.hidden;
        cuerpo.hidden = !abrir;
        header.querySelector(".cliente-flecha").classList.toggle("abierta", abrir);
        if (abrir) {
            _clientesAbiertos.add(grupo.cliente);
            if (!cuerpo.dataset.pintado) {
                pintarZfersDeCliente(cuerpo, grupo.zfers);
                cuerpo.dataset.pintado = "1";
            }
        } else {
            _clientesAbiertos.delete(grupo.cliente);
        }
    });

    card.appendChild(header);
    card.appendChild(cuerpo);

    // si ya estaba abierto de antes (el usuario lo dejo abierto y solo cambio
    // un filtro), pintamos el contenido de una
    if (abierto) {
        pintarZfersDeCliente(cuerpo, grupo.zfers);
        cuerpo.dataset.pintado = "1";
    }

    return card;
}

function pintarZfersDeCliente(contenedor, zfers) {
    const grid = document.createElement("div");
    grid.className = "zfer-grid";
    zfers.forEach((z) => grid.appendChild(crearTarjetaZfer(z)));
    contenedor.appendChild(grid);
}

function crearTarjetaZfer(z) {
    const card = document.createElement("div");
    card.className = "zfer-card";

    const badgeStock = z.EsStock === "Si"
        ? '<span class="badge badge-stock-si">CON STOCK</span>'
        : '<span class="badge badge-stock-no">SIN STOCK</span>';

    const badgeRep = z._repeticiones > 1
        ? `<span class="badge badge-rep">x${z._repeticiones}</span>`
        : "";

    const compartida = (z.ComparteStockCon && z.ComparteStockCon.length > 0)
        ? `<div class="zfer-comparte" title="Este ZFER estandar tambien es el oficial para estos vehiculos - si hay stock, aplica para todos">
               🔗 comparte stock con: ${z.ComparteStockCon.join(", ")}
           </div>`
        : "";

    const plano = z.PlanoUrl
        ? `<img class="zfer-plano" src="${z.PlanoUrl}" alt="plano ${z.ZFER}" loading="lazy">`
        : `<div class="zfer-plano zfer-plano-vacio">sin plano</div>`;

    card.innerHTML = `
        <div class="zfer-plano-wrap">${plano}</div>
        <div class="zfer-info">
            <div class="zfer-titulo">
                <span class="zfer-numero">${z.ZFER ?? ""}</span>
                ${badgeRep}
                ${badgeStock}
            </div>
            <div class="zfer-detalle">${z.Vehiculo ?? ""} · ${z.ProductoHomologo ?? ""}</div>
            <div class="zfer-detalle-chico">
                Parte ${z.Parte ?? "-"} · Formula ${z.Formula ?? "-"} · ${z.Geometria ?? "-"} · V${z.VersionZFER ?? "-"}
            </div>
            <div class="zfer-detalle-chico">Cantidad total: ${z._cantidadTotal}</div>
            ${compartida}
        </div>
    `;

    const img = card.querySelector("img.zfer-plano");
    if (img) img.addEventListener("click", () => abrirModalPlano(z.PlanoUrl));

    return card;
}

// ---------- modal de plano ----------

function abrirModalPlano(url) {
    if (!url) return;
    $("#modal-plano-img").src = url;
    $("#modal-plano").hidden = false;
}

function cerrarModalPlano() {
    $("#modal-plano").hidden = true;
    $("#modal-plano-img").src = "";
}

// ---------- sidebar colapsable ----------

function toggleSidebar() {
    $("#sidebar").classList.toggle("sidebar-cerrada");
    $(".app-con-sidebar").classList.toggle("sidebar-cerrada");
}

function mostrarLoading(mostrar) {
    $("#resultados-loading").hidden = !mostrar;
}

function setEstado(texto, ok) {
    $("#texto-estado").textContent = texto;
    $("#dot-estado").style.background = ok ? "var(--verde)" : "var(--rojo)";
    $("#dot-estado").style.boxShadow = ok ? "0 0 8px var(--verde)" : "0 0 8px var(--rojo)";
}

// listeners
document.addEventListener("DOMContentLoaded", () => {
    $("#btn-consultar").addEventListener("click", consultarHistorico);
    $("#btn-toggle-sidebar").addEventListener("click", toggleSidebar);
    $("#btn-cerrar-plano").addEventListener("click", cerrarModalPlano);
    $("#modal-plano").addEventListener("click", (ev) => {
        if (ev.target.id === "modal-plano") cerrarModalPlano(); // click afuera de la imagen
    });
    document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") cerrarModalPlano();
    });

    $("#btn-todo-historico").addEventListener("click", () => {
        // "2000-01-01" es solo una fecha bien para atras que garantiza cubrir
        // TODO lo que haya en Genesis, no hace falta ser exactos.
        $("#f-fecha-inicio").value = "2000-01-01";
        $("#f-fecha-fin").value = new Date().toISOString().slice(0, 10);
        consultarHistorico();
    });

    $("#f-vehiculo").addEventListener("change", onCambioFiltro);
    $("#f-parte").addEventListener("change", onCambioFiltro);
    $("#f-producto").addEventListener("change", onCambioFiltro);
    $("#f-geometria").addEventListener("change", onCambioFiltro);
    $("#f-zfer").addEventListener("input", onCambioFiltro);

    consultarHistorico(); // carga inicial con el rango de fechas default
});
