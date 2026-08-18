# desktop.py
# Esto es lo que se va a compilar a Jorgito.exe con PyInstaller.
# Levanta el Flask de app.py en un hilo de fondo (sin el debug/reloader,
# eso solo es para cuando estamos programando) y abre una ventana nativa
# con pywebview apuntando a ese localhost. Mismo esqueleto que ya usaron
# en PipeMirror/AGP_LAUNCHER para las apps de escritorio con HTML/CSS/JS.
#
# Para probar la app mientras la seguimos armando, mejor corre "python app.py"
# y abrila en el navegador en http://127.0.0.1:5757 - así el navegador te deja
# ver la consola y los errores de JS mucho mas facil que en la ventana pywebview.
# Este archivo lo usamos ya cuando vayamos a empacar la version final.

import threading

import webview

from app import app
from config import PORT


def _levantar_flask():
    # threaded=True porque el front va a poder disparar varios fetch
    # al mismo tiempo (kpis + tabla + filtros)
    app.run(host="127.0.0.1", port=PORT, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    hilo_flask = threading.Thread(target=_levantar_flask, daemon=True)
    hilo_flask.start()

    webview.create_window(
        "Jorgito - AGP",
        f"http://127.0.0.1:{PORT}",
        width=1440,
        height=880,
        min_size=(1100, 700),
        background_color="#060810",
    )
    webview.start()