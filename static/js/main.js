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

// por ahora la app arranca mostrando SOLO estos clientes (nombres exactos
// verificados contra Contacts.ContactName en Genesis - ojo que hay "primos"
// parecidos que NO son estos, ej. "AUTO SAFE BRASIL LTDA" != "AUTO SAFE",
// "BALLISTIC VEHICLES" != "BALLISTIC TECHNOLOGY", por eso comparamos exacto).
// El checkbox "Todos" en la sidebar saca esta restriccion.
const CLIENTES_DEFAULT = new Set([
    "BLINDAJES ALEMANES",
    "TRANSPORTADORA DE PROTECCION Y SEGU",
    "AUTO SAFE",
    "PROTELIFE",
    "BALLISTIC TECHNOLOGY",
    "CENTUR PRIVATE SECURITY SERVICES",
]);

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
        $("#kpis").hidden = false;
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

// ---------- cascade visual: los pasos aparecen uno a uno ----------

function mostrarPaso(paso) {
    // muestra el contenedor del paso indicado si estaba oculto.
    // una vez que aparece, se queda visible (no retrocede).
    const contenedor = $(`.sidebar-paso-contenedor[data-paso="${paso}"]`);
    if (contenedor && contenedor.hidden) contenedor.hidden = false;

    // despues del paso 3 aparece todo lo demas (geometria, zfer, fechas, botones)
    if (paso >= 3) {
        const resto = $(".sidebar-resto");
        if (resto && resto.hidden) resto.hidden = false;
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

// datos "visibles" = datosCrudos, restringido a CLIENTES_DEFAULT a menos que
// el checkbox "Todos" este marcado. Todo lo demas (opciones de filtro, tabla,
// KPIs) parte de aca en vez de datosCrudos directo, asi la restriccion aplica
// en un solo lugar.
function datosVisibles() {
    if ($("#f-todos-clientes").checked) return datosCrudos;
    return datosCrudos.filter((f) => CLIENTES_DEFAULT.has(f.Cliente));
}

function actualizarOpcionesFiltros() {
    const filtros = leerFiltrosActivos();
    const opcionesDe = (campo, ignorar) =>
        [...new Set(filtrarDatos(datosVisibles(), filtros, ignorar).map((f) => f[campo]).filter(Boolean))].sort();

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
    const filtradas = filtrarDatos(datosVisibles(), leerFiltrosActivos(), null);
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

    // OJO: header es un <div>, no un <button> - adentro va el boton real de
    // "Comparar planos", y no se puede meter un <button> dentro de otro
    // <button> (HTML invalido, el navegador lo reordena solo y se rompe la
    // logica). El "toggle" del acordeon vive en su propio <button> chiquito
    // que envuelve flecha+nombre+badges, hermano del boton de comparar.
    const header = document.createElement("div");
    header.className = "cliente-header";
    header.innerHTML = `
        <button type="button" class="cliente-toggle">
            <span class="cliente-flecha ${abierto ? "abierta" : ""}">▸</span>
            <span class="cliente-nombre">${grupo.cliente}</span>
            <span class="cliente-resumen">
                <span class="badge badge-rep">${grupo.zfers.length} ZFER</span>
                <span class="badge badge-stock-si">${conStock} con stock</span>
            </span>
        </button>
        <button type="button" class="btn-comparar-planos" title="Comparar un plano con stock contra uno sin stock de este cliente">
            🔍 Comparar planos
        </button>
    `;

    header.querySelector(".btn-comparar-planos").addEventListener("click", (ev) => {
        ev.stopPropagation();
        abrirModalComparar({
            conStock: grupo.zfers.filter((z) => z.EsStock === "Si"),
            sinStock: grupo.zfers.filter((z) => z.EsStock !== "Si"),
        });
    });

    const cuerpo = document.createElement("div");
    cuerpo.className = "cliente-cuerpo";
    cuerpo.hidden = !abierto;

    header.querySelector(".cliente-toggle").addEventListener("click", () => {
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

const TOP_SIN_STOCK = 5; // por defecto solo se ven los 5 sin-stock con mas repeticion

function pintarZfersDeCliente(contenedor, zfers) {
    // ya vienen ordenados por _repeticiones desc (agruparPorClienteYZfer),
    // asi que separar en con/sin stock mantiene ese orden en cada grupo.
    const conStock = zfers.filter((z) => z.EsStock === "Si");
    const sinStock = zfers.filter((z) => z.EsStock !== "Si");

    if (conStock.length) {
        const gridConStock = document.createElement("div");
        gridConStock.className = "zfer-grid";
        conStock.forEach((z) => gridConStock.appendChild(crearTarjetaZfer(z)));
        contenedor.appendChild(gridConStock);
    }

    if (!sinStock.length) return;

    const tituloSinStock = document.createElement("div");
    tituloSinStock.className = "zfer-subtitulo";
    tituloSinStock.textContent = `Sin stock (${sinStock.length})`;
    contenedor.appendChild(tituloSinStock);

    const gridSinStock = document.createElement("div");
    gridSinStock.className = "zfer-grid";
    contenedor.appendChild(gridSinStock);

    // top 5 por repeticion (si todos empatan en repeticiones da igual cuales
    // 5 salgan primero, ya vienen ordenados asi de agruparPorClienteYZfer)
    const primeros = sinStock.slice(0, TOP_SIN_STOCK);
    const resto = sinStock.slice(TOP_SIN_STOCK);
    primeros.forEach((z) => gridSinStock.appendChild(crearTarjetaZfer(z)));

    if (!resto.length) return;

    const btnVerTodos = document.createElement("button");
    btnVerTodos.type = "button";
    btnVerTodos.className = "btn-secundario btn-ver-todos-sin-stock";
    btnVerTodos.textContent = `Mostrar los ${resto.length} restantes sin stock`;
    btnVerTodos.addEventListener("click", () => {
        resto.forEach((z) => gridSinStock.appendChild(crearTarjetaZfer(z)));
        btnVerTodos.remove();
    });
    contenedor.appendChild(btnVerTodos);
}

// antes esto era una sola linea de texto gris apagado (dificil de leer, se
// perdia entre el fondo oscuro) - ahora cada dato sale como un chip con su
// propio color, se reusa tanto en las tarjetas de zfer como en el panel de
// comparar planos.
function metaChips(z) {
    // el color viene como "BLANCO"/"AZUL"/etc desde MatColors (catalogo real
    // de la BD, ColorID '00'..'23') - si por lo que sea no matcheo el join,
    // mostramos al menos el codigo crudo en vez de dejar el chip vacio.
    const colorTexto = z.Color || z.ColorID || "-";
    return `
        <div class="zfer-meta">
            <span class="zfer-meta-item zfer-meta-parte">Parte ${z.Parte ?? "-"}</span>
            <span class="zfer-meta-item zfer-meta-formula">Formula ${z.Formula ?? "-"}</span>
            <span class="zfer-meta-item zfer-meta-geometria">${z.Geometria ?? "-"}</span>
            <span class="zfer-meta-item zfer-meta-color">🎨 ${colorTexto}</span>
            <span class="zfer-meta-item zfer-meta-version">V${z.VersionZFER ?? "-"}</span>
        </div>
    `;
}

function crearTarjetaZfer(z) {
    const card = document.createElement("div");
    card.className = "zfer-card";

    const badgeStock = z.EsStock === "Si"
        ? '<span class="badge badge-stock-si">ZFER DE STOCK</span>'
        : '<span class="badge badge-stock-no">ZFER NO STOCK</span>';

    // antes solo se mostraba si era mas de 1 (x1 se ocultaba) - lo pidieron
    // visible siempre, asi de una vistazo se ve cuantas veces salio cada ZFER
    // sin tener que adivinar cuando el badge no aparece.
    const badgeRep = `<span class="badge badge-rep">x${z._repeticiones}</span>`;

    const compartida = (z.ComparteStockCon && z.ComparteStockCon.length > 0)
        ? `<div class="zfer-comparte" title="Este ZFER estandar tambien es el oficial para estos vehiculos - si hay stock, aplica para todos">
               🔗 comparte stock con: ${z.ComparteStockCon.join(", ")}
           </div>`
        : "";

    const plano = z.PlanoUrl
        ? `<img class="zfer-plano" src="${z.PlanoUrl}" alt="plano ${z.ZFER}" loading="lazy">`
        : `<div class="zfer-plano zfer-plano-vacio">sin plano</div>`;

    // solo en tarjetas SIN stock: boton para elegir cualquier ZFER con stock
    // de CUALQUIER cliente (no solo el de esta tarjeta) y arrancar la
    // comparacion directo con este ZFER ya puesto del lado sin-stock.
    const btnAgregar = z.EsStock !== "Si"
        ? `<button type="button" class="btn-agregar-zfer-stock">+ Agregar ZFER de stock</button>`
        : "";

    card.innerHTML = `
        <div class="zfer-plano-wrap">${plano}</div>
        <div class="zfer-info">
            <div class="zfer-titulo">
                <span class="zfer-numero">${z.ZFER ?? ""}</span>
                ${badgeRep}
                ${badgeStock}
            </div>
            <div class="zfer-detalle">${z.Vehiculo ?? ""} · ${z.ProductoHomologo ?? ""}</div>
            ${metaChips(z)}
            <div class="zfer-detalle-chico">Cantidad total: ${z._cantidadTotal}</div>
            ${compartida}
            ${btnAgregar}
        </div>
    `;

    const img = card.querySelector("img.zfer-plano");
    if (img) img.addEventListener("click", () => abrirModalPlano(z.PlanoUrl));

    const btn = card.querySelector(".btn-agregar-zfer-stock");
    if (btn) {
        btn.addEventListener("click", () => {
            abrirModalComparar({
                conStock: todosLosZferConStockGlobal(),
                sinStock: [z],
            });
        });
    }

    return card;
}

// junta TODOS los ZFER con stock de TODOS los clientes que estan visibles
// ahora mismo (respeta los filtros de la sidebar y la restriccion de
// CLIENTES_DEFAULT), deduplicado por ZFER - el mismo numero NO puede salir
// 2 veces en la lista aunque pertenezca a mas de un cliente, tal como lo
// pidieron ("sin repetir... saldria solo 1 vez").
function todosLosZferConStockGlobal() {
    const filas = filtrarDatos(datosVisibles(), leerFiltrosActivos(), null);
    const porZfer = new Map();

    for (const f of filas) {
        if (f.EsStock !== "Si") continue;
        if (!porZfer.has(f.ZFER)) {
            porZfer.set(f.ZFER, { ...f, _repeticiones: 0, _cantidadTotal: 0 });
        }
        const acumulado = porZfer.get(f.ZFER);
        acumulado._repeticiones += 1;
        acumulado._cantidadTotal += Number(f.Cantidad) || 0;
    }

    return [...porZfer.values()].sort((a, b) => b._repeticiones - a._repeticiones);
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

// ---------- comparar planos (con stock vs sin stock) ----------
// Guarda las listas completas de ZFER con/sin stock que alimentan los 2
// selects de este modal (para poblar los dropdowns y poder buscar el objeto
// completo cuando cambian de opcion). OJO: desde que se agrego el boton
// "+ Agregar ZFER de stock" en cada tarjeta, los dos lados YA NO tienen que
// ser del mismo cliente - por eso ya no se guarda un "cliente" unico aca, el
// cliente de cada lado se lee directo del ZFER elegido en ese momento (z.Cliente).
let _comparacionActual = null;

function abrirModalComparar({ conStock, sinStock }) {
    if (!conStock.length || !sinStock.length) {
        alert("no hay ZFER de los dos lados (con stock y sin stock) para comparar todavia con estos filtros.");
        return;
    }

    _comparacionActual = { conStock, sinStock };

    llenarSelectComparar("#comparar-select-con", conStock);
    llenarSelectComparar("#comparar-select-sin", sinStock);
    actualizarLadoComparar("con");
    actualizarLadoComparar("sin");

    $("#modal-comparar").hidden = false;
}

function llenarSelectComparar(selector, lista) {
    const select = $(selector);
    select.innerHTML = "";
    lista.forEach((z) => {
        const opt = document.createElement("option");
        opt.value = z.ZFER;
        opt.textContent = `${z.ZFER} · ${z.Cliente} · ${z.Vehiculo} · ${z.ProductoHomologo} (x${z._repeticiones})`;
        select.appendChild(opt);
    });
}

function actualizarLadoComparar(lado) {
    if (!_comparacionActual) return;
    const lista = lado === "con" ? _comparacionActual.conStock : _comparacionActual.sinStock;
    const zferElegido = $(`#comparar-select-${lado}`).value;
    const z = lista.find((x) => x.ZFER === zferElegido) || lista[0];
    if (!z) return;

    $(`#comparar-img-${lado}`).src = z.PlanoUrl || "";
    $(`#comparar-info-${lado}`).innerHTML = `
        <div class="zfer-detalle">🏢 ${z.Cliente ?? "-"} · ${z.Vehiculo ?? ""} · ${z.ProductoHomologo ?? ""}</div>
        ${metaChips(z)}
    `;

    actualizarTituloComparar();
    cargarComentariosComparacion();
}

// el titulo de arriba muestra los 2 clientes cuando son distintos, o uno
// solo cuando la comparacion es dentro del mismo cliente (el caso de siempre,
// via el boton "Comparar planos" del header de cada tarjeta de cliente).
function actualizarTituloComparar() {
    if (!_comparacionActual) return;
    const con = _comparacionActual.conStock.find((z) => z.ZFER === $("#comparar-select-con").value);
    const sin = _comparacionActual.sinStock.find((z) => z.ZFER === $("#comparar-select-sin").value);
    const clienteCon = con?.Cliente || "-";
    const clienteSin = sin?.Cliente || "-";

    $("#comparar-cliente-nombre").textContent = clienteCon === clienteSin
        ? clienteSin
        : `${clienteSin} (sin stock) vs ${clienteCon} (con stock)`;
}

function cerrarModalComparar() {
    $("#modal-comparar").hidden = true;
    _comparacionActual = null;
}

async function cargarComentariosComparacion() {
    if (!_comparacionActual) return;
    const zferCon = $("#comparar-select-con").value;
    const zferSin = $("#comparar-select-sin").value;
    const lista = $("#comparar-comentarios-lista");

    try {
        const resp = await fetch(`/api/comparacion/comentarios?zfer_con_stock=${zferCon}&zfer_sin_stock=${zferSin}`);
        const data = await resp.json();
        const comentarios = data.comentarios || [];

        if (!comentarios.length) {
            lista.innerHTML = `<div class="sin-resultados">sin comentarios todavia para este par - se el primero</div>`;
            return;
        }
        lista.innerHTML = "";
        comentarios.forEach((c) => lista.appendChild(crearItemComentario(c)));
    } catch (err) {
        console.error("no se pudieron cargar los comentarios:", err);
        lista.innerHTML = `<div class="sin-resultados">no se pudo conectar a Ingenieria para traer comentarios</div>`;
    }
}

function crearItemComentario(c) {
    const item = document.createElement("div");
    item.className = "comentario-item";
    const fecha = c.FechaCreacion ? new Date(c.FechaCreacion).toLocaleString("es-CO") : "";

    // si el comentario se hizo comparando 2 clientes distintos, se avisa -
    // si no, no hace falta repetir el cliente (ya se ve arriba en el titulo)
    const clientesDistintos = c.ClienteConStock && c.ClienteSinStock && c.ClienteConStock !== c.ClienteSinStock;
    const notaClientes = clientesDistintos
        ? `<div class="comentario-clientes">🏢 ${c.ClienteSinStock} (sin stock) vs ${c.ClienteConStock} (con stock)</div>`
        : "";

    item.innerHTML = `
        <div class="comentario-cabeza">
            <span class="comentario-autor">${c.Usuario || "anonimo"}</span>
            <span class="comentario-fecha">${fecha}</span>
        </div>
        ${notaClientes}
        <div class="comentario-texto">${c.Comentario}</div>
    `;
    return item;
}

async function guardarComentarioComparacion() {
    if (!_comparacionActual) return;
    const texto = $("#comparar-comentario-texto").value.trim();
    if (!texto) return;

    const zferCon = $("#comparar-select-con").value;
    const zferSin = $("#comparar-select-sin").value;
    const con = _comparacionActual.conStock.find((z) => z.ZFER === zferCon);
    const sin = _comparacionActual.sinStock.find((z) => z.ZFER === zferSin);

    // guardamos TODO el contexto: cliente, los dos ZFER que se estaban viendo,
    // y ademas los filtros que estaban activos en la sidebar en este momento
    // (vehiculo/parte/producto/geometria/zfer buscado/fechas/todos-clientes) -
    // asi si alguien vuelve a este comentario meses despues sabe exactamente
    // bajo que condiciones se hizo la comparacion, tal como lo pidieron.
    const filtrosActivos = {
        ...leerFiltrosActivos(),
        fecha_inicio: $("#f-fecha-inicio").value,
        fecha_fin: $("#f-fecha-fin").value,
        mostrando_todos_los_clientes: $("#f-todos-clientes").checked,
    };

    const btn = $("#btn-guardar-comentario");
    btn.disabled = true;
    try {
        const resp = await fetch("/api/comparacion/comentarios", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                usuario: $("#comparar-usuario").value.trim(),
                // "cliente" (la columna vieja) queda apuntando al lado sin
                // stock - es "de quien es el problema" que se esta mirando.
                cliente: sin?.Cliente,
                cliente_con_stock: con?.Cliente,
                cliente_sin_stock: sin?.Cliente,
                zfer_con_stock: zferCon,
                vehiculo_con_stock: con?.Vehiculo,
                producto_con_stock: con?.ProductoHomologo,
                zfer_sin_stock: zferSin,
                vehiculo_sin_stock: sin?.Vehiculo,
                producto_sin_stock: sin?.ProductoHomologo,
                comentario: texto,
                filtros: filtrosActivos,
            }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `server respondio ${resp.status}`);
        }
        $("#comparar-comentario-texto").value = "";
        await cargarComentariosComparacion();
    } catch (err) {
        console.error("no se pudo guardar el comentario:", err);
        alert("no se pudo guardar el comentario, revisa la consola");
    } finally {
        btn.disabled = false;
    }
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
        if (ev.key === "Escape") {
            cerrarModalPlano();
            cerrarModalComparar();
        }
    });

    $("#btn-cerrar-comparar").addEventListener("click", cerrarModalComparar);
    $("#comparar-select-con").addEventListener("change", () => actualizarLadoComparar("con"));
    $("#comparar-select-sin").addEventListener("change", () => actualizarLadoComparar("sin"));
    $("#comparar-img-con").addEventListener("click", () => abrirModalPlano($("#comparar-img-con").src));
    $("#comparar-img-sin").addEventListener("click", () => abrirModalPlano($("#comparar-img-sin").src));
    $("#btn-guardar-comentario").addEventListener("click", guardarComentarioComparacion);

    $("#btn-todo-historico").addEventListener("click", () => {
        // "2000-01-01" es solo una fecha bien para atras que garantiza cubrir
        // TODO lo que haya en Genesis, no hace falta ser exactos.
        $("#f-fecha-inicio").value = "2000-01-01";
        $("#f-fecha-fin").value = new Date().toISOString().slice(0, 10);
        consultarHistorico();
    });

    // cascade visual: al cambiar cada select, se muestra el siguiente paso
    $("#f-vehiculo").addEventListener("change", () => { mostrarPaso(2); onCambioFiltro(); });
    $("#f-parte").addEventListener("change", () => { mostrarPaso(3); onCambioFiltro(); });
    $("#f-producto").addEventListener("change", () => { mostrarPaso(4); onCambioFiltro(); });
    $("#f-geometria").addEventListener("change", onCambioFiltro);
    $("#f-zfer").addEventListener("input", onCambioFiltro);
    $("#f-todos-clientes").addEventListener("change", onCambioFiltro);

    consultarHistorico(); // carga inicial con el rango de fechas default
});
