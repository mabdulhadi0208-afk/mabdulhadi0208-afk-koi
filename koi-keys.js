// Koi's key hook, in its own process: reports modifier keys going down and up (key codes only, never text and
// never mouse events). Other keys are only reported while a modifier is held, so a chord like Command + Option
// is cancelled when you are really typing Command + Option + K. Nothing at all is sent while you just type.
const port = process.parentPort; const send = m => { try { port.postMessage(m) } catch {} }
const MODS = new Set([56, 3640, 29, 3613, 42, 54, 3675, 3676])
try {
  const { uIOhook } = require('uiohook-napi')
  let held = 0
  // replace the EventEmitter fan-out: anything that is not a key event is dropped before any work is done
  uIOhook.handler = function (e) {
    const t = e.type; if (t !== 4 && t !== 5) return
    const m = MODS.has(e.keycode)
    if (!m && !held) return
    if (m) held = Math.max(0, held + (t === 4 ? 1 : -1))
    send({ ev: t === 4 ? 'down' : 'up', k: e.keycode })
  }
  uIOhook.start()
  port.on('message', m => { if (m && m.data && m.data.stop) { try { uIOhook.stop() } catch {} process.exit(0) } })
  send({ started: true })
} catch (e) { send({ error: String((e && e.message) || e) }); setTimeout(() => process.exit(1), 200) }
