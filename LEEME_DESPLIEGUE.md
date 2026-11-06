# Sala de Ensayo · cómo ponerla en marcha (fase 1)

Los pasos marcados **José** los haces tú, porque tocan cuentas o claves. Los marcados **Claude** los hago yo cuando me des el sí.

## 1. Proyecto de Supabase
**Hecho (Claude, 6-nov):**
- proyecto `sala-de-ensayo` en la cuenta **joseparangoa@gmail.com**, ref `srdpcfpqdapdaydhdbjs`, región us-east-1 (East US);
- `docs/config.js` ya tiene la URL y la clave publishable.

**Te toca (José), porque llevan contraseña:**
1. Abre https://supabase.com/dashboard/project/srdpcfpqdapdaydhdbjs/auth/users → **Add user → Create new user**: tu correo y una contraseña, con **Auto Confirm User** marcado.
2. Ve a **Authentication → Sign In / Providers → Email** y desactiva **Allow new users to sign up**.
3. La contraseña de la base de datos la generó Supabase y no la necesitas para esta app. Si algún día la necesitas, se cambia en **Project Settings → Database**.

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
npx supabase link --project-ref srdpcfpqdapdaydhdbjs
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
