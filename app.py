# app.py
# Server Flask local. Esto NO se expone a internet, corre en 127.0.0.1 y pywebview
# le apunta directo (ver main.py). Es el mismo patron que usa Modulo 5: un Flask
# de toda la vida haciendo de backend, pero la "ventana" la pone pywebview en vez
# de abrir un navegador de verdad.

import json
from datetime import date, timedelta

from flask import Flask, jsonify, render_template, request

from config import PORT
from queries import (
    asegurar_tabla_comentarios,
    obtener_historico_enriquecido,
    q_guardar_comentario_comparacion,
    q_listar_comentarios_comparacion,
)

app = Flask(__name__)

# cache chiquito en memoria para no pegarle a las 3 BDs cada vez que el usuario
# solo cambia un filtro de vehiculo (los filtros los resolvemos en el frontend
# sobre los datos ya cargados). Se refresca cuando cambia el rango de fechas.
_cache = {"clave": None, "datos": None}

# se corre UNA vez al arrancar - crea el esquema JORGITO + tabla de comentarios
# en la BD de Ingenieria si todavia no existen (ver queries.py). Envuelto en
# try/except: si por lo que sea Ingenieria no responde en este momento, NO
# queremos que se caiga toda la app - el historico de ventas sigue funcionando
# igual, solo la comparacion de planos con comentarios quedaria coja hasta que
# se pueda conectar (la funcion se puede volver a llamar despues sin problema,
# es idempotente).
try:
    asegurar_tabla_comentarios()
except Exception as e:
    print(f"[jorgito] OJO: no se pudo preparar la tabla de comentarios en Ingenieria: {e}")

# el default NO puede ser "desde 2024" - probamos eso y son ~28 mil filas, el
# navegador se pone a parsear ese JSON gigante y la app se siente trabada aunque
# el backend ya respondio bien (200 en el server.log, el problema era puro peso
# de datos). 90 dias es un rango razonable para abrir la app rapido; si alguien
# necesita el historico completo, amplia las fechas a mano y ya sabe que va a
# tardar mas.
_DIAS_RANGO_DEFAULT = 90


@app.route("/")
def index():
    hoy = date.today()
    inicio_default = hoy - timedelta(days=_DIAS_RANGO_DEFAULT)
    return render_template(
        "index.html",
        fecha_default_inicio=inicio_default.isoformat(),
        fecha_default_fin=hoy.isoformat(),
    )


@app.route("/api/historico")
def api_historico():
    hoy = date.today()
    fecha_inicio = request.args.get(
        "fecha_inicio", (hoy - timedelta(days=_DIAS_RANGO_DEFAULT)).isoformat()
    )
    fecha_fin = request.args.get("fecha_fin", hoy.isoformat())

    clave_cache = (fecha_inicio, fecha_fin)
    if _cache["clave"] == clave_cache:
        datos = _cache["datos"]
    else:
        datos = obtener_historico_enriquecido(fecha_inicio, fecha_fin)
        _cache["clave"] = clave_cache
        _cache["datos"] = datos

    return jsonify({
        "total": len(datos),
        "filas": datos,
    })


@app.route("/api/comparacion/comentarios")
def api_listar_comentarios():
    zfer_con_stock = request.args.get("zfer_con_stock", "")
    zfer_sin_stock = request.args.get("zfer_sin_stock", "")
    if not zfer_con_stock or not zfer_sin_stock:
        return jsonify({"comentarios": []})
    filas = q_listar_comentarios_comparacion(zfer_con_stock, zfer_sin_stock)
    return jsonify({"comentarios": filas})


@app.route("/api/comparacion/comentarios", methods=["POST"])
def api_guardar_comentario():
    body = request.get_json(silent=True) or {}
    comentario = (body.get("comentario") or "").strip()
    zfer_con_stock = (body.get("zfer_con_stock") or "").strip()
    zfer_sin_stock = (body.get("zfer_sin_stock") or "").strip()

    if not comentario:
        return jsonify({"error": "el comentario no puede quedar vacio"}), 400
    if not zfer_con_stock or not zfer_sin_stock:
        return jsonify({"error": "faltan los dos ZFER que se estan comparando"}), 400

    # guardamos TODOS los filtros que estaban activos en ese momento (vehiculo,
    # parte, producto, geometria, zfer buscado, fechas, mostrar todos clientes)
    # tal como lo pidieron: "bien detallado de que plano cliente o filtros
    # activos tenia". Lo mandamos ya armado desde el frontend, aca solo lo
    # serializamos a texto para guardarlo en una sola columna.
    filtros_json = json.dumps(body.get("filtros") or {}, ensure_ascii=False)

    datos = {
        "usuario": (body.get("usuario") or "").strip() or None,
        "cliente": (body.get("cliente") or "").strip(),
        # cliente_con_stock/cliente_sin_stock: desde que se puede comparar
        # entre clientes distintos, guardamos el cliente de CADA lado por
        # separado (ver q_guardar_comentario_comparacion en queries.py).
        "cliente_con_stock": body.get("cliente_con_stock") or None,
        "cliente_sin_stock": body.get("cliente_sin_stock") or None,
        "zfer_con_stock": zfer_con_stock,
        "vehiculo_con_stock": body.get("vehiculo_con_stock") or None,
        "producto_con_stock": body.get("producto_con_stock") or None,
        "zfer_sin_stock": zfer_sin_stock,
        "vehiculo_sin_stock": body.get("vehiculo_sin_stock") or None,
        "producto_sin_stock": body.get("producto_sin_stock") or None,
        "filtros_json": filtros_json,
        "comentario": comentario,
    }

    fila = q_guardar_comentario_comparacion(datos)
    return jsonify({"ok": True, "nuevo": fila})


if __name__ == "__main__":
    # esto es solo para probar en el navegador mientras desarrollamos.
    # cuando ya este lista la parte visual, main.py levanta esto mismo
    # pero adentro de una ventana pywebview en vez de localhost:5757 a pelo.
    app.run(host="127.0.0.1", port=PORT, debug=True)
