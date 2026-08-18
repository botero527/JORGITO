# db.py
# Pool de conexiones a las 3 BDs (genesis, sap, productivity).
#
# TIP para que estudies: usamos pymssql y NO pyodbc para esto.
# pyodbc necesita que la maquina tenga instalado el "ODBC Driver 17/18 for SQL Server"
# (un instalable de Microsoft). Si compilamos Jorgito a .exe y lo corremos en el PC
# de otro compañero que nunca instalo ese driver, pyodbc explota con un error rarisimo
# de conexion. pymssql en cambio trae su propio driver (FreeTDS) empacado adentro del
# paquete de python, entonces el .exe funciona en cualquier PC sin instalar nada extra.
# Por eso en el cerebro ves que casi todos los proyectos que se distribuyen como .exe
# (CONSULTA_SANTIAGO, macro_jefferson, etc) usan pymssql para las conexiones normales,
# pyodbc solo se usa donde ya estaba puesto de antes.
#
# Otra cosa importante: no abrimos una conexion nueva por cada query. Abrir conexion
# contra Azure SQL tiene un delay de red (handshake TLS) que se siente. Por eso armamos
# un pool chiquito por BD y reciclamos conexiones.

import queue
import threading
import pymssql

from config import BDS

_POOL_MAX = 6          # conexiones maximas por BD, no necesitamos mas para un dashboard
_pools = {}
_locks = {}


def _crear_conexion(nombre_bd):
    cfg = BDS[nombre_bd]
    return pymssql.connect(
        server=cfg["server"],
        user=cfg["user"],
        password=cfg["password"],
        database=cfg["database"],
        as_dict=True,       # asi el cursor ya nos devuelve filas como dict, no toca zipear columnas
        login_timeout=10,
        timeout=60,
    )


def _get_pool(nombre_bd):
    if nombre_bd not in _pools:
        _pools[nombre_bd] = queue.Queue(maxsize=_POOL_MAX)
        _locks[nombre_bd] = threading.Lock()
    return _pools[nombre_bd]


def _obtener_conexion(nombre_bd):
    pool = _get_pool(nombre_bd)
    try:
        conn = pool.get_nowait()
        # chequeo rapido de que la conexion siga viva antes de reusarla
        try:
            conn.cursor().execute("SELECT 1")
            return conn
        except Exception:
            # se cayo la conexion vieja, la tiramos y abrimos una nueva
            try:
                conn.close()
            except Exception:
                pass
            return _crear_conexion(nombre_bd)
    except queue.Empty:
        return _crear_conexion(nombre_bd)


def _devolver_conexion(nombre_bd, conn):
    pool = _get_pool(nombre_bd)
    try:
        pool.put_nowait(conn)
    except queue.Full:
        # el pool ya esta lleno, esta de mas, la cerramos y ya
        conn.close()


def ejecutar(nombre_bd, sql, params=None):
    """
    Corre un SELECT y devuelve la lista de filas como dicts.
    nombre_bd tiene que ser una de las llaves de config.BDS ("genesis", "sap", "productivity").
    """
    conn = _obtener_conexion(nombre_bd)
    try:
        cur = conn.cursor()
        cur.execute(sql, params or ())
        filas = cur.fetchall()
        cur.close()
        return filas
    finally:
        _devolver_conexion(nombre_bd, conn)
