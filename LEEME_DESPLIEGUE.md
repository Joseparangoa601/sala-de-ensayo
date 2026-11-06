# Sala de Ensayo · cómo ponerla en marcha (fase 1)

Los pasos marcados **José** los haces tú, porque tocan cuentas o claves. Los marcados **Claude** los hago yo cuando me des el sí.

## 1. Proyecto de Supabase (José)
1. En supabase.com → **New project**. Nombre: `sala-de-ensayo`, región **East US (North Virginia)**, que queda cerca de Azure `eastus`.
   - El plan gratis permite 2 proyectos activos. Si ya tienes 2, avísame antes.
2. **Authentication → Users → Add user → Create new user**: tu correo y una contraseña, con **Auto Confirm User** marcado.
3. **Authentication → Sign In / Providers → Email**: desactiva **Allow new users to sign up**. Así nadie más puede crear una cuenta.
4. **Project Settings → API**: copia la **Project URL**, la **anon / publishable key** y el **Project ref** (el código de la URL). Pásamelos: no son secretos y van en `docs/config.js`.

## 2. Secretos (José, en una terminal **Git Bash** dentro de esta carpeta)
Crea el archivo `supabase/.env.secrets`, que está excluido de git. La clave de Azure va directo del comando `az` al archivo, sin mostrarse en pantalla:

```bash
echo "AZURE_SPEECH_KEY=$(az cognitiveservices account keys list -n lead10x-voz-prueba -g lead10x-pruebas --query key1 -o tsv)" > supabase/.env.secrets
```

Luego abre `supabase/.env.secrets` en el Bloc de notas y agrega estas líneas, con tu clave de Anthropic y tu correo:

```
AZURE_SPEECH_REGION=eastus
ANTHROPIC_API_KEY=pega-aquí-tu-clave
ALLOWED_EMAIL=tu-correo@ejemplo.com
ALLOWED_ORIGINS=https://joseparangoa601.github.io,http://localhost:5173
```

## 3. Subir las funciones (José inicia sesión; el resto lo puedo correr yo)
```bash
npx supabase login
```
```bash
npx supabase link --project-ref TU_PROJECT_REF
```
```bash
npx supabase secrets set --env-file supabase/.env.secrets
```
```bash
npx supabase functions deploy
```

## 4. Publicar la página (Claude, con tu sí)
Se crea el repositorio público `Joseparangoa601/sala-de-ensayo` con GitHub Pages sobre la carpeta `docs/`. El código no lleva claves.

URL final: `https://joseparangoa601.github.io/sala-de-ensayo/`

## 5. En el iPhone (José)
1. Abre la URL en **Safari** → Compartir → **Agregar a pantalla de inicio**.
2. Abre «Ensayo» desde la pantalla de inicio, entra con tu correo y contraseña, y elige una escena.
3. Toca el círculo y da permiso al micrófono.
4. Para ver las latencias, toca 5 veces el título de la escena.

## Qué cuesta
- **Azure F0:** US$0 dentro de 5 h de voz a texto y 500.000 caracteres de texto a voz al mes. Al agotarse, deja de responder y la app pasa a texto con un aviso.
- **Claude:** se cobra en tu cuenta de Anthropic. El panel de depuración muestra los tokens de cada sesión para medir el costo real.
