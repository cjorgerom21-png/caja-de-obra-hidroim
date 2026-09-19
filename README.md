# Caja de Obra

App para controlar los gastos e ingresos de una obra: proyectos, categorías,
proveedores, órdenes de pago y cierre de caja del día. Backend en
Node.js/Express + PostgreSQL, listo para desplegar en Railway.

## Cómo funciona

- `server.js` — API REST + sirve la app (carpeta `public/`).
- `public/index.html` — toda la app (una sola página).
- Una sola tabla de PostgreSQL (`records`) guarda todo como documentos JSON,
  agrupados por "colección" (proyectos, movimientos, categorías, etc.) —
  el servidor la crea solo la primera vez que arranca.
- La app consulta al servidor cada ~4 segundos para mantenerse "en vivo"
  entre dispositivos (no es instantáneo como en claude.ai, pero se actualiza
  solo, sin recargar la página).

## Desplegar en Railway (paso a paso)

1. **Sube esta carpeta a un repositorio de GitHub** (Railway despliega desde
   GitHub). Si no tienes uno:
   ```
   git init
   git add .
   git commit -m "Caja de Obra"
   ```
   Luego crea un repo vacío en GitHub y sigue las instrucciones para
   subirlo (`git remote add origin ...` y `git push`).

2. **En Railway**: "New Project" → "Deploy from GitHub repo" → elige el
   repositorio. Railway detecta que es Node.js automáticamente (por el
   `package.json`) y lo despliega.

3. **Agrega la base de datos**: dentro del mismo proyecto en Railway, clic en
   "New" → "Database" → "Add PostgreSQL". Railway conecta la variable
   `DATABASE_URL` a tu servicio automáticamente — no tienes que copiarla ni
   configurarla a mano.

4. **Genera el dominio público**: en el servicio de la app (no el de
   PostgreSQL) → pestaña "Settings" → "Networking" → "Generate Domain".
   Con eso obtienes tu link público (algo como
   `caja-de-obra-production.up.railway.app`) para abrir la app desde el
   celular o la PC.

5. Listo. La primera vez que abras el link, el servidor crea las tablas
   solas y puedes empezar a crear tu primer proyecto.

## Desarrollo local (opcional)

Necesitas una base de datos PostgreSQL corriendo en tu máquina (o usa la de
Railway apuntando `DATABASE_URL` a ella, si Railway te da acceso público).

```
npm install
cp .env.example .env    # y edita DATABASE_URL con tus datos
node -r dotenv/config server.js
```

(el paquete `dotenv` no viene instalado por defecto — si quieres usar `.env`
en local, instálalo con `npm install dotenv`; en Railway no hace falta,
porque las variables de entorno las pone la plataforma).

Abre `http://localhost:3000`.

## Notas

- Los datos ahora viven en tu propia base de datos de Railway — ya no
  dependen de claude.ai. Puedes seguir pidiéndole cambios a Claude sobre
  este mismo código en cualquier momento.
- Si mueves el proyecto a otra cuenta o quieres respaldar tus datos, puedes
  conectarte a la base PostgreSQL de Railway con cualquier cliente
  (ej. TablePlus, pgAdmin) usando las credenciales que aparecen en la
  pestaña "Connect" del servicio PostgreSQL.
