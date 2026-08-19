# queries.py
# Aca viven las consultas de negocio. La idea es separarlas de app.py para que
# el archivo de rutas Flask no se vuelva un pantano.
#
# COSA IMPORTANTE que descubrimos probando esto de verdad (no adivinando):
# el esquema real donde vive la data de ventas de Mexico/CO01 en la BD Genesis
# es "Seed_Web_GenesisSap_SGlass" (NO existe ningun "Gen_SalesOrders" a secas,
# eso era un nombre generico/de memoria). Hay otros esquemas hermanos con la
# misma estructura de tablas (Prod, Qua, TESTS) que son ambientes de prueba o
# de otra unidad de negocio - NO tienen data real para SapSalesOrg=MX01.
#
# Otra cosa que nos ahorramos: pensabamos que iba a tocar cruzar Genesis + SAP
# para sacar formula/vehiculo/tipo de pieza/geometria, pero resulta que Genesis
# YA tiene esos atributos sincronizados en las tablas Materials/MaterialSpecs/Parts
# (Specs.FormulaCode, Specs.GeometryType, Specs.BehaviorDifferentials coinciden
# con los ATNAM Z_FORMULA_CODE/Z_GEOMETRY_TYPE/Z_BEHAVIOR_DIFFERENTIALS que vimos
# en el EAV de SAP). Entonces la consulta principal NO necesita tocar la BD SAP
# para nada de esto - un solo servidor, mas rapido y con menos cosas que se
# puedan caer. Dejamos la consulta a SAP como fallback (ver abajo) solo para
# los ZFER que por algun motivo no tengan fila en MaterialSpecs.

from collections import defaultdict
from db import ejecutar, ejecutar_escritura

_ESQUEMA_GENESIS = "Seed_Web_GenesisSap_SGlass"

# mapeo de geometria, mismo que usan en Modulo 5 para las hojas de ruta
_GEOMETRIA_LABELS = {"01": "Plano", "02": "Curvo"}

# StatusName en la BD tiene un registro con los acentos corrompidos de una carga
# vieja (viene asi de origen, no es un bug nuestro ni del driver - lo probamos
# con pymssql Y con pyodbc y sale igual de mal en los dos). Ojo: el caracter roto
# que llega no siempre es el mismo byte a byte, por eso NO comparamos texto,
# arreglamos por StatusID que es estable (StatusID=4 es "Pedidos Producao" segun
# el catalogo Seed_Web_GenesisSap_SGlass.SalesOrderStatus).
_STATUS_NAME_FIX_POR_ID = {
    "4": "Pedidos Producao",
}

# los 5 atributos que usamos del EAV de SAP (ODATA_ZFER_CLASS_001), SOLO como
# fallback cuando un ZFER no tiene fila en MaterialSpecs de Genesis.
_ATRIBUTOS_ZFER_SAP = (
    "Z_FORMULA_CODE",
    "Z_VEHICLE_CODE",
    "Z_PIECE_TYPE",
    "Z_AGP_VERSION",
    "Z_GEOMETRY_TYPE",
)


def _agrupar_producto(nombre):
    """
    Replica el CASE WHEN de la query SQL que agrupa ProductName crudo en
    "familias" comerciales. Necesitamos esto en Python para poder hacer el
    lookup contra el Master de reorden, que usa el nombre ORIGINAL del
    producto (mismo que ProductName en Genesis) pero el historico trae
    ProductoHomologo (el nombre agrupado). Si no normalizamos, el lookup
    nunca coincide y el stock sale mal.
    """
    if not nombre:
        return nombre
    n = nombre.strip()
    if n == "Estándar VPAM 3 15mm":
        return "Estandar 15mm"
    if n == "Estándar 69mm TPS MÉXICO":
        return "Estandar 69mm"
    if n == "B33 GEN2":
        return "B33 24mm"
    if "42" in n:
        return "MultiHit 42mm"
    if "iB33" in n:
        return "iB33 18mm"
    if "18" in n:
        return "Estandar 18mm"
    if "19" in n:
        return "Light Weight 19mm"
    if "16" in n:
        return "Estandar 16mm"
    if "23mm" in n:
        return "B33 24mm"
    if "32mm" in n:
        return "Estandar 32mm"
    if "69mm" in n:
        return "Estandar 69mm"
    return n


def _limpiar_status(status_id, status_name):
    return _STATUS_NAME_FIX_POR_ID.get(str(status_id), status_name)


def q_historico_ventas(fecha_inicio, fecha_fin, vehiculos=None):
    """
    Historico de ventas de Genesis (CO01/MX01), enriquecido con lo que antes
    pensabamos que habia que ir a buscar a SAP:
    - Formula, Geometria, BehaviorDifferentials -> de MaterialSpecs (Specs)
    - Codigo/modelo/tipo de vehiculo -> de Materials (Vehicles)
    - Tipo de pieza (nombre completo, no solo la sigla) -> de Parts
    - ConteoZFER: cuantas veces se repite el mismo ZFER en todo el resultado
      (misma logica de COUNT() OVER PARTITION BY que usan en la query de stock)
    """
    # OJO (lo aprendimos por las malas): Dets.SpecID a veces trae espacios/tabs pegados
    # al final (basura vieja de datos historicos), y eso hace que el join a MaterialSpecs
    # falle silenciosamente para esos ZFER puntuales (quedan sin Formula/Geometria porque
    # "700164791 " != "700164791"). Probamos arreglarlo con RTRIM/LTRIM/REPLACE en la
    # condicion del JOIN pero eso mata el uso de indice (SQL Server no puede hacer seek
    # si hay una funcion envolviendo la columna, toca escanear todo) - la query se fue
    # de ~25s a ~55s con el rango completo por arreglar 0.03% de las filas. NO vale la
    # pena. Nos quedamos con el join simple (rapido) y el trim SOLO en el SELECT final
    # (eso no afecta el plan de ejecucion, es post-proceso de la fila ya encontrada).
    # Las pocas filas con SpecID sucio simplemente quedan sin Formula/Geometria, y como
    # tampoco son ZFER numerico valido, el fallback a SAP las ignora por diseño (ver
    # el .isdigit() mas abajo) - no rompen nada, solo salen incompletas.
    # Nos pidieron acotar Jorgito SOLO a los vehiculos gobernados por el Master
    # de reorden (dbo.MX_App_ControlReordenZFER_Master en Productivity, ~19
    # vehiculos) en vez de todo el historico de Genesis. Filtramos aca mismo
    # en el SQL (no despues en Python) porque asi Genesis nunca transfiere las
    # ~60 mil filas de mas que de todas formas ibamos a tirar - mucho mas rapido.
    params = {"fecha_inicio": fecha_inicio, "fecha_fin": fecha_fin}
    filtro_vehiculos = ""
    if vehiculos:
        placeholders = []
        for i, v in enumerate(vehiculos):
            clave = f"veh{i}"
            params[clave] = v
            placeholders.append(f"%({clave})s")
        filtro_vehiculos = f"AND Vehicles.MaterialName IN ({','.join(placeholders)})"

    sql = f"""
        SELECT
            Base.OrderID,
            Base.SapOrderID AS PedidoSAP,
            Base.IssueDate AS FechaPedido,
            Contacts.ContactName AS Cliente,
            Base.OrderType AS TipoPedido,
            Base.StatusID,
            OrderStatus.StatusName,
            Products.LevelAGP,
            Vehicles.MaterialName AS Vehiculo,
            Vehicles.MaterialCode AS CodigoVehiculo,
            Vehicles.VehModel,
            Vehicles.VehType,
            Vehicles.VehConfiguration,
            -- agrupamos el nombre de producto crudo en "familias" comerciales,
            -- asi lo pidieron - el orden de los WHEN importa (SQL evalua de
            -- arriba a abajo y se queda con el primero que matchee), los
            -- exactos van primero y los LIKE comodin despues. Probado contra
            -- la BD real antes de meterlo aca, coincide con la consulta que
            -- nos pasaron tal cual (con N'' para que los acentos matcheen bien
            -- a pesar del bug de encoding que ya conocemos en esta BD).
            CASE
                WHEN Products.ProductName = N'Estándar VPAM 3 15mm' THEN 'Estandar 15mm'
                WHEN Products.ProductName = N'Estándar 69mm TPS MÉXICO' THEN 'Estandar 69mm'
                WHEN Products.ProductName = 'B33 GEN2' THEN 'B33 24mm'
                WHEN Products.ProductName LIKE '%42%' THEN 'MultiHit 42mm'
                WHEN Products.ProductName LIKE '%iB33%' THEN 'iB33 18mm'
                WHEN Products.ProductName LIKE '%18%' THEN 'Estandar 18mm'
                WHEN Products.ProductName LIKE '%19%' THEN 'Light Weight 19mm'
                WHEN Products.ProductName LIKE '%16%' THEN 'Estandar 16mm'
                WHEN Products.ProductName LIKE '%23mm%' THEN 'B33 24mm'
                WHEN Products.ProductName LIKE '%32mm%' THEN 'Estandar 32mm'
                WHEN Products.ProductName LIKE '%69mm%' THEN 'Estandar 69mm'
                ELSE Products.ProductName
            END AS ProductoHomologo,
            RTRIM(LTRIM(REPLACE(Dets.SpecID, CHAR(9), ''))) AS ZFER,
            Dets.PartShort AS Parte,
            Parts.PartName_ES AS TipoPieza,
            Specs.PartSizeM2 AS Area,
            Dets.Quantity AS Cantidad,
            Dets.UnitPrice,
            Dets.LogoID,
            Specs.SpecVersion AS VersionZFER,
            Specs.FormulaCode AS Formula,
            Specs.GeometryType,
            Specs.BehaviorDifferentials,
            Specs.ColorID,
            Colores.ColorName_ES AS Color,
            Specs.COSpecImageUrl,
            Specs.BRSpecImageUrl,
            Specs.PESpecImageUrl,
            COUNT(*) OVER (PARTITION BY Dets.SpecID) AS ConteoZFER
        FROM {_ESQUEMA_GENESIS}.SalesOrders Base
            INNER JOIN {_ESQUEMA_GENESIS}.SalesOrderDetails Dets ON Base.OrderID = Dets.OrderID
            LEFT JOIN {_ESQUEMA_GENESIS}.SalesOrderStatus OrderStatus ON Base.StatusID = OrderStatus.StatusID
            LEFT JOIN {_ESQUEMA_GENESIS}.Products Products ON Base.ProductID = Products.ProductID
            LEFT JOIN {_ESQUEMA_GENESIS}.Contacts Contacts ON Base.ContactID = Contacts.ContactID
            LEFT JOIN {_ESQUEMA_GENESIS}.Materials Vehicles ON Base.OrderMaterialID = Vehicles.MaterialID
            LEFT JOIN {_ESQUEMA_GENESIS}.MaterialSpecs Specs ON Dets.SpecID = Specs.SpecID
            LEFT JOIN {_ESQUEMA_GENESIS}.Parts Parts ON Dets.PartID = Parts.PartID
            LEFT JOIN {_ESQUEMA_GENESIS}.MatColors Colores ON Specs.ColorID = Colores.ColorID
        WHERE Base.SapPlantID = 'CO01'
            AND Base.SapSalesOrg = 'MX01'
            AND OrderStatus.StatusName NOT IN ('Cancelado', 'Rascunho', 'Engenharia', 'Aguardando Revisao', 'Em Processamento')
            AND Base.OrderType IN ('N', 'S')
            AND Base.IssueDate >= %(fecha_inicio)s
            AND Base.IssueDate < DATEADD(DAY, 1, %(fecha_fin)s)
            {filtro_vehiculos}
        ORDER BY Base.IssueDate DESC
    """
    filas = ejecutar("genesis", sql, params)

    for fila in filas:
        fila["StatusName"] = _limpiar_status(fila.get("StatusID"), fila.get("StatusName"))
        fila["Geometria"] = _GEOMETRIA_LABELS.get(fila.get("GeometryType") or "", fila.get("GeometryType") or "")
        # el plano: usamos la primera url que exista, CO primero porque el
        # centro de produccion es CO01. Esto es mucho mas simple que ir a SAP
        # (ODATA_ZFER_RUTAS_JPG) - esas rutas son de red (\\192.168.2.2\...) y
        # tocaria un backend leyendo el archivo. Esta URL de Genesis ya es
        # https con token de acceso (SAS), se pone directo en un <img src>.
        fila["PlanoUrl"] = fila.get("COSpecImageUrl") or fila.get("BRSpecImageUrl") or fila.get("PESpecImageUrl")

    return filas


def q_atributos_zfer_sap(lista_zfers):
    """
    FALLBACK: solo se llama para los ZFER que quedaron sin Formula despues de la
    query principal (o sea, sin fila en MaterialSpecs). Trae los mismos 5 datos
    pero directo del EAV de SAP (ODATA_ZFER_CLASS_001). Si la lista viene vacia
    no pegamos a SAP para nada, asi que en el caso normal (todo viene de Genesis)
    esto ni se ejecuta.
    """
    if not lista_zfers:
        return {}

    placeholders_zfer = ",".join(["%s"] * len(lista_zfers))
    placeholders_atnam = ",".join(["%s"] * len(_ATRIBUTOS_ZFER_SAP))
    sql = f"""
        SELECT MATERIAL, ATNAM, ATWRT
        FROM dbo.ODATA_ZFER_CLASS_001
        WHERE MATERIAL IN ({placeholders_zfer})
            AND ATNAM IN ({placeholders_atnam})
    """
    filas = ejecutar("sap", sql, tuple(lista_zfers) + _ATRIBUTOS_ZFER_SAP)

    crudo = defaultdict(dict)
    for f in filas:
        crudo[str(f["MATERIAL"])][f["ATNAM"]] = (f["ATWRT"] or "").strip()

    resultado = {}
    for zfer, attrs in crudo.items():
        geo_code = attrs.get("Z_GEOMETRY_TYPE", "")
        resultado[zfer] = {
            "Formula": attrs.get("Z_FORMULA_CODE", ""),
            "CodigoVehiculo": attrs.get("Z_VEHICLE_CODE", ""),
            "TipoPieza": attrs.get("Z_PIECE_TYPE", ""),
            "VersionZFER": attrs.get("Z_AGP_VERSION", ""),
            "Geometria": _GEOMETRIA_LABELS.get(geo_code, geo_code),
        }
    return resultado


def q_reorden_master():
    """
    Tabla curada a mano (310 filas, 19 vehiculos, con auditoria de quien y
    cuando la cambio) donde alguien de comercial/planeacion ya definio cual es
    el ZFER "Estandar" oficial para cada combo Vehiculo+Producto+Pieza, y un
    ZFER "Alterno" opcional. Vive en Productivity (no en SAP ni Genesis).

    Por que nos importa: (Vehiculo, Producto, Pieza) es UNICO en esta tabla
    (lo verificamos, 310 filas = 310 combos unicos), asi que cualquier fila
    del historico se puede resolver contra su fila del Master sin ambiguedad.

    Y esto es la explicacion real de "vehiculos que comparten stock": hay 20
    casos donde el MISMO ZFEREstandar es el oficial de 2 VehicleID distintos
    (confirmado con datos reales). O sea que si ese ZFER tiene stock, los dos
    vehiculos deberian verse como "con stock", no solo uno.
    """
    sql = """
        SELECT Vehiculo, Producto, Pieza, VehicleID, Cliente, ZFEREstandar, ZFERAlterno
        FROM dbo.MX_App_ControlReordenZFER_Master
    """
    return ejecutar("productivity", sql)


def q_stock_activo():
    """
    La query de stock que paso el usuario, tal cual (dedup por Lote via rn=1).
    OJO: si un ZFER no sale aca es porque NO tiene stock, esa es la regla de negocio.
    """
    sql = """
        SELECT
            x.[Material], x.[ConteoMaterial], x.[PlantaProduccion], x.[Estado]
        FROM (
            SELECT
                a.[Material],
                COUNT(*) OVER (PARTITION BY a.[Material]) AS ConteoMaterial,
                a.[PlantaProduccion],
                d.[Estado],
                ROW_NUMBER() OVER (PARTITION BY a.[Material] ORDER BY a.[Lote]) AS rn
            FROM [dbo].[MX_StocksManager_ActiveStocks] a
            INNER JOIN [dbo].[MX_StocksManager_ActiveStocks_Details] d
                ON a.[Lote] = d.[Lote]
            WHERE a.[TipoPedido] = 'S'
                AND d.[Estado] = 'Canaima'
                AND (d.[RemisionMX] IS NULL OR d.[RemisionMX] = '')
                AND (d.[ClienteFactura] IS NULL OR d.[ClienteFactura] = '')
                AND d.[ExisteStock] = 'True'
                AND d.[Reservado] = 0
        ) x
        WHERE x.rn = 1
    """
    return ejecutar("productivity", sql)


def obtener_historico_enriquecido(fecha_inicio, fecha_fin):
    """
    Esta es la funcion que llama app.py.
    1. Trae el historico de Genesis, ya enriquecido con formula/vehiculo/pieza/geometria
    2. Si algun ZFER quedo sin Formula (no tenia MaterialSpecs), va a SAP SOLO por esos
    3. Marca EsStock Si/No cruzando contra el stock activo de Productivity
    """
    # Nos pidieron que Jorgito quede acotado SOLO a los vehiculos gobernados
    # por el Master de reorden (~19 vehiculos), no a todo el historico de
    # Genesis. Por eso el Master se trae PRIMERO (es chiquito, 310 filas, no
    # se siente) y su lista de vehiculos se manda directo al WHERE de la query
    # de Genesis - asi nunca bajamos las ~60 mil filas de mas que de todas
    # formas iban a sobrar.
    #
    # OJO - esto se repitio una vez y toco limpiarlo de nuevo: NO metas
    # ThreadPoolExecutor + q_stock_activo() aca. Desde que el stock se decide
    # 100% con el Master (zfers_master mas abajo), esa consulta a
    # MX_StocksManager_ActiveStocks es codigo muerto - su resultado no se usa
    # para nada y es pesada (bajaba la respuesta de ~16s a ~55s con el rango
    # completo). Si en el futuro se necesita el stock fisico real de nuevo,
    # revive q_stock_activo() a proposito, no "por si acaso".
    master_filas = q_reorden_master()
    vehiculos_master = sorted({m.get("Vehiculo") for m in master_filas if m.get("Vehiculo")})
    filas = q_historico_ventas(fecha_inicio, fecha_fin, vehiculos_master)

    # fallback SAP: solo para los que de verdad quedaron cojos
    # OJO: con rangos de fecha viejos aparecen pedidos donde SpecID no es un ZFER
    # numerico de verdad sino un texto tipo "ENG_REQUEST" (una solicitud de
    # ingenieria que todavia no tiene ZFER asignado). La columna MATERIAL en
    # ODATA_ZFER_CLASS_001 es int, si le mandamos eso en el IN() SQL Server truena
    # tratando de convertir el texto a numero. Por eso filtramos con isdigit()
    # antes de mandar nada a SAP.
    zfers_sin_formula = sorted({
        str(f["ZFER"]) for f in filas
        if f.get("ZFER") and not f.get("Formula") and str(f["ZFER"]).isdigit()
    })
    if zfers_sin_formula:
        attrs_fallback = q_atributos_zfer_sap(zfers_sin_formula)
        for fila in filas:
            zfer = str(fila.get("ZFER") or "")
            if zfer in attrs_fallback:
                for campo, valor in attrs_fallback[zfer].items():
                    if not fila.get(campo):
                        fila[campo] = valor

    # armamos el mapa (Vehiculo, Producto, Pieza) -> {estandar, alterno} y de
    # paso quien comparte cada ZFEREstandar (para el aviso "comparte stock con...")
    # OJO: normalizamos el Producto del Master con _agrupar_producto para que
    # coincida con ProductoHomologo del historico. Sin esto el lookup NUNCA
    # encuentra match (el Master tiene "B33 GEN2" pero el historico trae
    # "B33 24mm") y todos los ZFER caen al else con stock incorrecto.
    master_por_combo = {}
    vehiculos_por_estandar = defaultdict(set)
    for m in master_filas:
        clave = (m.get("Vehiculo"), _agrupar_producto(m.get("Producto")), m.get("Pieza"))
        master_por_combo[clave] = {
            "estandar": str(m["ZFEREstandar"]) if m.get("ZFEREstandar") else None,
            "alterno": str(m["ZFERAlterno"]) if m.get("ZFERAlterno") else None,
        }
        if m.get("ZFEREstandar"):
            vehiculos_por_estandar[str(m["ZFEREstandar"])].add(m.get("Vehiculo"))

    # construimos el set de ZFER que el Master considera "con stock": SOLO
    # la columna ZFEREstandar (el Alterno queda afuera de esta cuenta a
    # proposito, asi lo pidieron - el Alterno se sigue mostrando como dato
    # informativo en la tarjeta pero ya no cuenta para decidir EsStock).
    zfers_master = {str(m["ZFEREstandar"]) for m in master_filas if m.get("ZFEREstandar")}

    for fila in filas:
        zfer = str(fila.get("ZFER") or "")

        # REGLA DE NEGOCIO (pedida explicitamente, sin excepciones): un ZFER
        # "tiene stock" si y solo si EL ZFER DE ESTA LINEA aparece como
        # ZFEREstandar (SOLO esa columna, el Alterno no cuenta) de CUALQUIER
        # combo del Master - no importa si es el estandar de ESTE combo
        # puntual o de otro. Punto, no se mira nada mas (nada de intersecciones
        # de sets por combo - eso fue el bug que marcaba TODO el combo como
        # "con stock" sin importar cual ZFER real tuviera cada linea, ya lo
        # arreglamos una vez, que no se repita).
        fila["EsStock"] = "Si" if zfer in zfers_master else "No"

        # esto de aca es SOLO informativo (para el aviso "comparte stock con..."
        # y para mostrar cual es el Estandar/Alterno oficial de este combo) -
        # no afecta el EsStock de arriba.
        clave = (fila.get("Vehiculo"), fila.get("ProductoHomologo"), fila.get("Parte"))
        datos_master = master_por_combo.get(clave)
        if datos_master:
            fila["ZFEREstandarMaster"] = datos_master["estandar"]
            fila["ZFERAlternoMaster"] = datos_master["alterno"]
            otros_vehiculos = vehiculos_por_estandar.get(datos_master["estandar"], set()) - {fila.get("Vehiculo")}
            fila["ComparteStockCon"] = sorted(v for v in otros_vehiculos if v)
        else:
            fila["ZFEREstandarMaster"] = None
            fila["ZFERAlternoMaster"] = None
            fila["ComparteStockCon"] = []

    return filas


# ============================================================================
# Comparacion de planos + comentarios (19-ago-2026)
# Esta parte pega a la BD de INGENIERIA (agpcolombia.database.windows.net /
# AGP_Ingenieria), la unica de lectura Y escritura de todo el proyecto. Ya
# tenia esquemas propios de otros proyectos (AUTOMATA, GMB, HTA, INV, mallas,
# itg) asi que seguimos el mismo patron: esquema propio JORGITO, no tocamos
# nada de los demas.
# ============================================================================

_ESQUEMA_JORGITO = "JORGITO"
_TABLA_COMENTARIOS = "ComentariosComparacionPlanos"


def asegurar_tabla_comentarios():
    """
    Crea el esquema JORGITO y la tabla de comentarios si todavia no existen.
    Se llama UNA vez al arrancar app.py. Es idempotente (IF NOT EXISTS), no
    pasa nada si se llama de nuevo en cada arranque.

    OJO con "SELECT 1" a secas contra esta conexion: como TODAS las conexiones
    del proyecto se abren con as_dict=True (ver db.py), pymssql no puede armar
    un dict de una columna sin nombre y tira ColumnsWithoutNamesError. Por eso
    aca SIEMPRE hay que ponerle alias ("SELECT 1 AS existe"), ya nos comimos
    ese error probando esto a mano antes de meterlo al codigo.
    """
    ejecutar_escritura("ingenieria", f"""
        IF NOT EXISTS (SELECT 1 AS existe FROM sys.schemas WHERE name = '{_ESQUEMA_JORGITO}')
            EXEC('CREATE SCHEMA {_ESQUEMA_JORGITO}')
    """)
    ejecutar_escritura("ingenieria", f"""
        IF NOT EXISTS (
            SELECT 1 AS existe FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id
            WHERE s.name = '{_ESQUEMA_JORGITO}' AND t.name = '{_TABLA_COMENTARIOS}'
        )
        CREATE TABLE {_ESQUEMA_JORGITO}.{_TABLA_COMENTARIOS} (
            ID INT IDENTITY(1,1) PRIMARY KEY,
            FechaCreacion DATETIME NOT NULL DEFAULT GETDATE(),
            Usuario VARCHAR(200) NULL,
            Cliente VARCHAR(300) NOT NULL,
            ZferConStock VARCHAR(50) NOT NULL,
            VehiculoConStock VARCHAR(300) NULL,
            ProductoConStock VARCHAR(300) NULL,
            ZferSinStock VARCHAR(50) NOT NULL,
            VehiculoSinStock VARCHAR(300) NULL,
            ProductoSinStock VARCHAR(300) NULL,
            FiltrosActivosJson NVARCHAR(MAX) NULL,
            Comentario NVARCHAR(MAX) NOT NULL
        )
    """)

    # AMPLIACION (19-ago-2026): ahora se puede comparar un ZFER sin stock de
    # UN cliente contra un ZFER con stock de OTRO cliente distinto (antes los
    # dos lados eran siempre del mismo cliente). La columna vieja `Cliente`
    # se queda tal cual (nadie la borra, por compatibilidad con lo que ya
    # hubiera - aunque hoy la tabla esta vacia de comentarios reales) y se
    # agregan estas 2 nuevas para saber el cliente de CADA lado por separado.
    # ALTER TABLE idempotente (checa sys.columns antes) - no rompe nada si la
    # columna ya existe de una corrida anterior.
    for columna in ("ClienteConStock", "ClienteSinStock"):
        ejecutar_escritura("ingenieria", f"""
            IF NOT EXISTS (
                SELECT 1 AS existe FROM sys.columns
                WHERE object_id = OBJECT_ID('{_ESQUEMA_JORGITO}.{_TABLA_COMENTARIOS}')
                    AND name = '{columna}'
            )
            ALTER TABLE {_ESQUEMA_JORGITO}.{_TABLA_COMENTARIOS} ADD {columna} VARCHAR(300) NULL
        """)


def q_guardar_comentario_comparacion(datos):
    """
    Guarda un comentario de la comparacion de planos. `datos` es un dict con
    las llaves: usuario, cliente, cliente_con_stock, cliente_sin_stock,
    zfer_con_stock, vehiculo_con_stock, producto_con_stock, zfer_sin_stock,
    vehiculo_sin_stock, producto_sin_stock, filtros_json (el estado de TODOS
    los filtros activos en ese momento, serializado a texto JSON - asi queda
    guardado bien detallado de que contexto tenia la app cuando alguien
    comento, tal como lo pidieron), comentario.

    OJO: desde que se puede comparar un ZFER sin stock de un cliente contra
    uno con stock de OTRO cliente, `cliente` (la columna vieja) queda
    apuntando al cliente del lado SIN STOCK (es "de quien es el problema" que
    se esta tratando de resolver) - `cliente_con_stock`/`cliente_sin_stock`
    son los datos precisos de cada lado por separado.

    Devuelve el ID nuevo (via SCOPE_IDENTITY, en el mismo batch del INSERT).
    """
    sql = f"""
        INSERT INTO {_ESQUEMA_JORGITO}.{_TABLA_COMENTARIOS}
            (Usuario, Cliente, ClienteConStock, ClienteSinStock, ZferConStock, VehiculoConStock,
             ProductoConStock, ZferSinStock, VehiculoSinStock, ProductoSinStock, FiltrosActivosJson, Comentario)
        VALUES (%(usuario)s, %(cliente)s, %(cliente_con_stock)s, %(cliente_sin_stock)s, %(zfer_con_stock)s,
                %(vehiculo_con_stock)s, %(producto_con_stock)s, %(zfer_sin_stock)s, %(vehiculo_sin_stock)s,
                %(producto_sin_stock)s, %(filtros_json)s, %(comentario)s);
        SELECT SCOPE_IDENTITY() AS ID, GETDATE() AS FechaCreacion;
    """
    return ejecutar_escritura("ingenieria", sql, datos)


def q_listar_comentarios_comparacion(zfer_con_stock, zfer_sin_stock):
    """
    Historial de comentarios para ESTE par exacto de ZFER (con stock / sin
    stock) que se esta comparando ahora. Mas nuevo primero. La llave sigue
    siendo el PAR de ZFER (no el cliente), asi que esto ya soporta solo sin
    cambios los pares entre clientes distintos.
    """
    sql = f"""
        SELECT ID, FechaCreacion, Usuario, Cliente, ClienteConStock, ClienteSinStock,
               ZferConStock, VehiculoConStock, ProductoConStock, ZferSinStock,
               VehiculoSinStock, ProductoSinStock, FiltrosActivosJson, Comentario
        FROM {_ESQUEMA_JORGITO}.{_TABLA_COMENTARIOS}
        WHERE ZferConStock = %(zfer_con_stock)s AND ZferSinStock = %(zfer_sin_stock)s
        ORDER BY FechaCreacion DESC
    """
    return ejecutar("ingenieria", sql, {"zfer_con_stock": zfer_con_stock, "zfer_sin_stock": zfer_sin_stock})
