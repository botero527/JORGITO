// particles.js
// Fondo animado tipo "red neuronal": puntos flotando que se conectan con lineas
// cuando estan cerca. Nada del otro mundo en canvas puro, sin librerias, para que
// el .exe final no cargue con dependencias de mas.

(function () {
    const canvas = document.getElementById("fondo-particulas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let ancho, alto, puntos;
    const DISTANCIA_CONEXION = 130;
    const CANTIDAD_BASE = 90; // se ajusta segun el tamano de pantalla

    function redimensionar() {
        ancho = canvas.width = window.innerWidth;
        alto = canvas.height = window.innerHeight;
    }

    function crearPuntos() {
        const cantidad = Math.round(CANTIDAD_BASE * (ancho * alto) / (1440 * 900));
        puntos = Array.from({ length: Math.max(40, cantidad) }, () => ({
            x: Math.random() * ancho,
            y: Math.random() * alto,
            vx: (Math.random() - 0.5) * 0.35,
            vy: (Math.random() - 0.5) * 0.35,
            r: Math.random() * 1.6 + 0.6,
        }));
    }

    function paso() {
        ctx.clearRect(0, 0, ancho, alto);

        // mover puntos y rebotar en los bordes
        for (const p of puntos) {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > ancho) p.vx *= -1;
            if (p.y < 0 || p.y > alto) p.vy *= -1;
        }

        // lineas entre puntos cercanos
        for (let i = 0; i < puntos.length; i++) {
            for (let j = i + 1; j < puntos.length; j++) {
                const a = puntos[i], b = puntos[j];
                const dx = a.x - b.x, dy = a.y - b.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < DISTANCIA_CONEXION) {
                    const opacidad = (1 - dist / DISTANCIA_CONEXION) * 0.18;
                    ctx.strokeStyle = `rgba(34, 229, 255, ${opacidad})`;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();
                }
            }
        }

        // los puntos en si, con un poco de glow
        for (const p of puntos) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(139, 92, 246, 0.55)";
            ctx.shadowColor = "rgba(34, 229, 255, 0.6)";
            ctx.shadowBlur = 6;
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
        }

        requestAnimationFrame(paso);
    }

    window.addEventListener("resize", () => {
        redimensionar();
        crearPuntos();
    });

    redimensionar();
    crearPuntos();
    paso();
})();
