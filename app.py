# app.py
# Server Flask local. Esto NO se expone a internet, corre en 127.0.0.1 y pywebview
# le apunta directo (ver main.py). Es el mismo patron que usa Modulo 5: un Flask
# de toda la vida haciendo de backend, pero la "ventana" la pone pywebview en vez
# de abrir un navegador de verdad.

from datetime import date, timedelta

from flask import Flask, jsonify, render_template, request

from config import PORT
from queries import obtener_historico_enriquecido

app = Flask(__name__)

# cache chiquito en memoria para no pegarle a las 3 BDs cada vez que el usuario
# solo cambia un filtro de vehiculo (los filtros los resolvemos en el frontend
# sobre los datos ya cargados). Se refresca cuando cambia el rango de fechas.
_cache = {"clave": None, "datos": None}

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


if __name__ == "__main__":
    # esto es solo para probar en el navegador mientras desarrollamos.
    # cuando ya este lista la parte visual, main.py levanta esto mismo
    # pero adentro de una ventana pywebview en vez de localhost:5757 a pelo.
    app.run(host="127.0.0.1", port=PORT, debug=True)
